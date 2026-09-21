require('dotenv').config({ quiet: true });

const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 3000;
// Trust the first proxy hop (Railway/Render/Vercel/etc. all sit behind one)
// so req.ip reflects the real client IP for rate limiting, not the proxy's.
app.set('trust proxy', 1);
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Storage configuration
//
// Vercel's filesystem is read-only, so on Vercel the site data (what used to be
// data.json) lives in Upstash Redis and uploaded files live in Vercel Blob.
// Both switch on automatically when their environment variables exist. With no
// variables set (local development) everything still uses data.json + uploads/.
// ---------------------------------------------------------------------------
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// The Vercel/Upstash integration lets you pick a custom env-var prefix, so besides the
// well-known names also accept any "<PREFIX>_REST_API_URL" / "<PREFIX>_REST_API_TOKEN".
function findEnv(exactNames, suffixRegex, excludeRegex) {
  for (const name of exactNames) {
    if (process.env[name]) return process.env[name].trim();
  }
  for (const key of Object.keys(process.env)) {
    if (suffixRegex.test(key) && !(excludeRegex && excludeRegex.test(key)) && process.env[key]) {
      return process.env[key].trim();
    }
  }
  return '';
}

const KV_REST_API_URL = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'], /_REST_API_URL$|_REDIS_REST_URL$/).replace(/\/+$/, '');
const KV_REST_API_TOKEN = findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'], /_REST_API_TOKEN$|_REDIS_REST_TOKEN$/, /READ_ONLY/);
const BLOB_READ_WRITE_TOKEN = findEnv(['BLOB_READ_WRITE_TOKEN'], /_READ_WRITE_TOKEN$/);

const USE_REMOTE_STORAGE = Boolean(KV_REST_API_URL && KV_REST_API_TOKEN);
const USE_BLOB_STORAGE = Boolean(BLOB_READ_WRITE_TOKEN);
const DATA_KEY = 'phoenixai:data';

console.log('[STORAGE] Data:', USE_REMOTE_STORAGE ? 'Upstash Redis' : (IS_SERVERLESS ? 'NOT CONFIGURED (serverless without Redis: changes cannot be saved)' : 'local data.json'));
console.log('[STORAGE] Files:', USE_BLOB_STORAGE ? 'Vercel Blob' : (IS_SERVERLESS ? 'NOT CONFIGURED (serverless without Blob: uploads are disabled)' : 'local uploads/'));

// An error the user can do something about (missing/unreachable storage). The
// central error handler turns it into a clear JSON message instead of a bare 500.
function storageError(message, status = 503, publicMessage) {
  const err = new Error(message);
  err.isStorageError = true;
  err.status = status;
  if (publicMessage) err.publicMessage = publicMessage;
  return err;
}

const STORAGE_NOT_CONFIGURED_MESSAGE =
  'Storage is not configured for this deployment, so changes cannot be saved. ' +
  'In Vercel open Storage, connect Upstash Redis (this adds KV_REST_API_URL and KV_REST_API_TOKEN) and redeploy. ' +
  'Open /api/health to check the status.';
const BLOB_NOT_CONFIGURED_MESSAGE =
  'File storage is not configured for this deployment, so uploads are disabled. ' +
  'In Vercel open Storage, connect a Blob store (this adds BLOB_READ_WRITE_TOKEN) and redeploy.';

// --- Redis (Upstash REST API, no SDK) --------------------------------------
async function redisCommand(command, timeoutMs = 8000) {
  if (!USE_REMOTE_STORAGE) throw storageError('Redis is not configured', 503, STORAGE_NOT_CONFIGURED_MESSAGE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(KV_REST_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: controller.signal
    });
  } catch (err) {
    throw storageError(`Redis request failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await response.json(); } catch (e) { /* non-JSON error body */ }
  if (!response.ok || (body && body.error)) {
    throw storageError(`Redis error ${response.status}: ${(body && body.error) || response.statusText}`);
  }
  return body ? body.result : null;
}

// Atomic "save only if nobody else saved in between": compares the _rev stored in
// Redis with the one this request loaded. A missing key or missing _rev counts as 0.
const CAS_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'local rev = 0',
  'if current then',
  '  local ok, parsed = pcall(cjson.decode, current)',
  "  if ok and type(parsed) == 'table' and type(parsed['_rev']) == 'number' then rev = parsed['_rev'] end",
  'end',
  'if rev == tonumber(ARGV[1]) then',
  "  redis.call('SET', KEYS[1], ARGV[2])",
  '  return 1',
  'end',
  'return 0'
].join('\n');

let casSupported = true;
async function redisCompareAndSet(expectedRev, json) {
  if (casSupported) {
    try {
      const result = await redisCommand(['EVAL', CAS_SCRIPT, 1, DATA_KEY, String(expectedRev), json]);
      return Number(result) === 1;
    } catch (err) {
      // Only fall back when scripting itself is unavailable, never on a plain
      // network error (that must fail the save instead of silently overwriting).
      if (!/eval|script|unknown command|not allowed|not supported/i.test(err.message)) throw err;
      console.warn('[STORAGE] Redis EVAL unavailable, falling back to plain SET:', err.message);
      casSupported = false;
    }
  }
  await redisCommand(['SET', DATA_KEY, json]);
  return true;
}

// --- Vercel Blob -------------------------------------------------------------
async function uploadToBlob(file, folder = 'uploads') {
  if (!USE_BLOB_STORAGE) throw storageError('Blob is not configured', 503, BLOB_NOT_CONFIGURED_MESSAGE);
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  try {
    const { put } = await import('@vercel/blob');
    const blob = await put(filename, file.buffer, {
      access: 'public',
      addRandomSuffix: false,
      contentType: file.mimetype,
      token: BLOB_READ_WRITE_TOKEN
    });
    return { filename, blobUrl: blob.url, size: file.size };
  } catch (error) {
    console.error('[BLOB] Upload error:', error);
    throw storageError(`Blob upload failed: ${error.message}`, 502, 'The file could not be uploaded to storage. Please try again.');
  }
}

async function deleteBlob(url) {
  if (!USE_BLOB_STORAGE || typeof url !== 'string' || !/^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(url)) return;
  try {
    const { del } = await import('@vercel/blob');
    await del(url, { token: BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    console.warn('[BLOB] Could not delete old file (ignored):', error.message);
  }
}

// Public URL of an uploaded file: the Blob URL, or the local /uploads/ path.
function fileUrl(file) {
  if (!file) return '';
  return file.blobUrl || `/uploads/${file.filename}`;
}

// ---------------------------------------------------------------------------
// Per-request data context (remote storage only)
//
// readData()/writeData() are synchronous all over this file, so every /api
// request loads the stored JSON up front into its own private copy. Because each
// request has its own copy, overlapping requests on one serverless instance can
// never overwrite each other's unsaved changes. Changes are written back before
// the response is sent: with an atomic compare-and-set on `_rev`, and when someone
// else saved in between, only THIS request's changes are re-applied (item by item,
// matched by id) on top of the newest data, then saved again.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const dataStore = new AsyncLocalStorage();

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value) === undefined ? 'null' : JSON.stringify(value);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIdArray = (a) => Array.isArray(a) && a.every(x => isPlainObject(x) && x.id !== undefined && x.id !== null);

// Applies "what this request changed" (base -> ours) on top of `theirs` (newest stored data).
function mergeValue(base, ours, theirs) {
  if (stableStringify(base) === stableStringify(ours)) return theirs; // untouched by this request
  if (isPlainObject(ours) && isPlainObject(theirs) && (base === undefined || isPlainObject(base))) {
    const b = base || {};
    const out = { ...theirs };
    for (const key of new Set([...Object.keys(b), ...Object.keys(ours)])) {
      if (key === '_rev') continue;
      if (!(key in ours)) { delete out[key]; continue; } // removed by this request
      out[key] = mergeValue(b[key], ours[key], theirs[key]);
    }
    return out;
  }
  if (isIdArray(ours) && isIdArray(theirs) && (base === undefined || isIdArray(base))) {
    return mergeIdArrays(base || [], ours, theirs);
  }
  return ours; // primitives and arrays without ids: this request's value wins
}

function mergeIdArrays(base, ours, theirs) {
  const out = theirs.slice();
  const idOf = (x) => String(x.id);
  const baseById = new Map(base.map(x => [idOf(x), x]));
  const oursIds = new Set(ours.map(idOf));

  for (const [id] of baseById) {                       // removed by this request
    if (!oursIds.has(id)) {
      const i = out.findIndex(x => idOf(x) === id);
      if (i !== -1) out.splice(i, 1);
    }
  }
  ours.forEach((item, pos) => {
    const id = idOf(item);
    const b = baseById.get(id);
    const i = out.findIndex(x => idOf(x) === id);
    if (!b) {                                          // added by this request
      if (i !== -1) { out[i] = item; return; }
      for (let p = pos - 1; p >= 0; p--) {             // keep it next to the item before it
        const j = out.findIndex(x => idOf(x) === idOf(ours[p]));
        if (j !== -1) { out.splice(j + 1, 0, item); return; }
      }
      if (pos === 0) out.unshift(item); else out.push(item);
    } else if (stableStringify(b) !== stableStringify(item)) { // edited by this request
      if (i === -1) out.push(item); else out[i] = mergeValue(b, item, out[i]);
    }
  });
  return out;
}

function buildDefaultData() {
  // Deliberately no `modules` / category lists here: applyMigrations() fills them in.
  return {
    templates: [],
    packages: [],
    inquiries: [],
    demoWebsites: [],
    aiAgents: [],
    services: [],
    leads: [],
    notifications: [],
    settings: {
      logo: '',
      adminPassword: defaultAdminPasswordHash()
    }
  };
}

async function loadDataContext() {
  const raw = await redisCommand(['GET', DATA_KEY]); // throws on any failure: never fall back to defaults
  let stored = null;
  if (raw !== null && raw !== undefined) {
    try { stored = JSON.parse(raw); } catch (e) { throw storageError('Stored data is not valid JSON'); }
    if (!isPlainObject(stored)) throw storageError('Stored data has an unexpected shape');
  }
  const base = stored || {};
  const data = stored ? JSON.parse(JSON.stringify(stored)) : buildDefaultData();
  const { changed } = applyMigrations(data);
  return { base, data, rev: Number(base._rev) || 0, dirty: changed || !stored };
}

async function flushDataContext(ctx) {
  const MAX_ATTEMPTS = 4;
  let expectedRev = ctx.rev;
  let candidate = ctx.data;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const next = JSON.parse(JSON.stringify(candidate));
    next._rev = expectedRev + 1;
    if (await redisCompareAndSet(expectedRev, JSON.stringify(next))) {
      ctx.data = next;
      ctx.rev = next._rev;
      ctx.dirty = false;
      return;
    }
    // Somebody saved in between: re-apply only this request's changes on top of the newest data.
    const raw = await redisCommand(['GET', DATA_KEY]);
    const theirs = raw ? JSON.parse(raw) : {};
    expectedRev = Number(theirs._rev) || 0;
    candidate = mergeValue(ctx.base, ctx.data, theirs);
    console.warn(`[STORAGE] Save conflict, merged onto newer data (attempt ${attempt}/${MAX_ATTEMPTS})`);
  }
  throw storageError('Could not save: too many concurrent changes', 409);
}

// Wraps every route handler so that (a) it runs inside its request's data context and
// (b) a rejected promise from an async handler reaches the error handler instead of
// hanging the request (Express 4 ignores rejected promises).
function wrapHandler(fn) {
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  return function wrappedHandler(req, res, next) {
    const run = () => {
      try {
        const result = fn.call(this, req, res, next);
        if (result && typeof result.catch === 'function') result.catch(next);
      } catch (err) {
        next(err);
      }
    };
    if (req._dataCtx) return dataStore.run(req._dataCtx, run);
    return run();
  };
}
['get', 'post', 'put', 'delete', 'patch'].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = function (routePath, ...handlers) {
    if (handlers.length === 0) return original(routePath); // app.get('setting') form
    return original(routePath, ...handlers.map(wrapHandler));
  };
});

// Key used to sign the admin cookie. Order of preference:
//   1. SESSION_SECRET (recommended)
//   2. a key derived from ADMIN_PASSWORD — stable across restarts and across
//      serverless instances, and not a publicly known constant
//   3. a fixed dev-only key (local development only)
// The old code fell straight back to the hard-coded dev key in production,
// which would let anyone who read the source forge an admin cookie.
const SESSION_SECRET = process.env.SESSION_SECRET
  || (process.env.ADMIN_PASSWORD
    ? crypto.createHash('sha256').update('phx-session-v1:' + process.env.ADMIN_PASSWORD).digest('hex')
    : 'dev-only-fallback-secret-change-me');

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET is not set. Set it in your host\'s environment variables (a long random string).');
}
if (IS_PROD && !process.env.ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD is not set — the default admin password will be used until you change it. Set ADMIN_PASSWORD in your host\'s environment variables.');
}

// Function to check if port is in use
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(true);
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

// ---------------------------------------------------------------------------
// Stateless, signed-cookie admin auth (replaces express-session)
//
// express-session's default MemoryStore only lives inside one Node process.
// On serverless hosts (Vercel etc.) every request can be handled by a
// different instance, so admin logins would randomly appear "logged out".
// A signed cookie carries the auth state itself, so it works the same way
// whether this runs as a long-lived server or as serverless functions.
// ---------------------------------------------------------------------------
const AUTH_COOKIE = 'phx_admin';
const CSRF_COOKIE = 'phx_csrf'; // readable by JS on purpose — paired with the signed httpOnly auth cookie (double-submit CSRF pattern)
const AUTH_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

// Signatures of cookies that have been explicitly logged out. Stateless
// cookies can't be revoked by nature, so we keep a small server-side
// blocklist just for the "I clicked logout" case. Same per-instance caveat
// as the rate limiter: fine for a single-admin app on a normal host, not a
// hard guarantee across many serverless instances.
const revokedSignatures = new Set();

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createAuthCookieValue() {
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const payload = JSON.stringify({ isAdmin: true, exp: Date.now() + AUTH_MAX_AGE_MS, csrf: csrfToken });
  const encoded = Buffer.from(payload).toString('base64url');
  return { cookieValue: `${encoded}.${sign(encoded)}`, csrfToken };
}

// decodeURIComponent throws on a stray '%' (e.g. "x=100%"). Cookies are shared
// by every app on the same host (all localhost ports!), so a cookie from a
// completely different project used to crash every request that read cookies —
// including GET /admin, which made the login page "not come" with a 500.
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (e) { return value; }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (!key || key in cookies) return; // first cookie of a name wins
    cookies[key] = safeDecode(pair.slice(idx + 1).trim());
  });
  return cookies;
}

// Only mark cookies Secure when the request really arrived over HTTPS. A
// Secure cookie set over plain http (e.g. NODE_ENV=production on a LAN IP, or
// Safari on localhost) is silently dropped by the browser: login "succeeds"
// but you land straight back on the login page.
function useSecureCookies(req) {
  return IS_PROD && req.secure;
}

// Returns the decoded { isAdmin, exp, csrf } payload if the cookie is
// present, correctly signed, unexpired and not revoked — otherwise null.
function verifyAuthCookie(req) {
  const cookies = parseCookies(req);
  const raw = cookies[AUTH_COOKIE];
  if (!raw) return null;
  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  if (revokedSignatures.has(signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.isAdmin || !(payload.exp > Date.now())) return null;
    payload._signature = signature;
    return payload;
  } catch (e) {
    return null;
  }
}

// `remember` = the "Keep me signed in" checkbox. Without it the cookies have no
// Max-Age, i.e. they are session cookies: the browser drops them when it is
// closed, so the next visit to /admin asks for the password again. (Before,
// every login was remembered for 12 hours, so /admin skipped the login page.)
function setAuthCookie(req, res, remember) {
  const { cookieValue, csrfToken } = createAuthCookieValue();
  const maxAge = remember ? [`Max-Age=${Math.floor(AUTH_MAX_AGE_MS / 1000)}`] : [];
  const authParts = [
    `${AUTH_COOKIE}=${encodeURIComponent(cookieValue)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...maxAge
  ];
  // Deliberately NOT HttpOnly: admin-script.js reads this one to attach the
  // x-csrf-token header on state-changing requests (double-submit pattern).
  const csrfParts = [
    `${CSRF_COOKIE}=${csrfToken}`,
    'Path=/',
    'SameSite=Lax',
    ...maxAge
  ];
  if (useSecureCookies(req)) { authParts.push('Secure'); csrfParts.push('Secure'); }
  res.setHeader('Set-Cookie', [authParts.join('; '), csrfParts.join('; ')]);
}

function clearAuthCookie(req, res) {
  const auth = verifyAuthCookie(req);
  if (auth && auth._signature) {
    revokedSignatures.add(auth._signature);
    if (revokedSignatures.size > 10000) revokedSignatures.clear(); // cheap cap, avoids unbounded growth
  }
  const authParts = [`${AUTH_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const csrfParts = [`${CSRF_COOKIE}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (useSecureCookies(req)) { authParts.push('Secure'); csrfParts.push('Secure'); }
  res.setHeader('Set-Cookie', [authParts.join('; '), csrfParts.join('; ')]);
}

// ---------------------------------------------------------------------------
// Password hashing (Node's built-in crypto.scrypt — no extra dependency).
// Existing plaintext passwords (from older data.json / .env-only setups)
// are still accepted once, then transparently upgraded to a hash.
// ---------------------------------------------------------------------------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// Async variants for request handlers: scryptSync blocks the whole event loop
// (~50-100 ms per login attempt), so a burst of bad logins could stall every
// other request on the server.
async function hashPasswordAsync(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(plain, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

async function verifyPasswordAsync(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const check = await scryptAsync(plain, salt, 64);
    const hashBuf = Buffer.from(hash, 'hex');
    return hashBuf.length === check.length && crypto.timingSafeEqual(hashBuf, check);
  }
  // Legacy plaintext password (pre-upgrade). Compared via fixed-length digests
  // so the comparison is constant-time; caller re-hashes on success.
  const a = crypto.createHash('sha256').update(plain).digest();
  const b = crypto.createHash('sha256').update(stored).digest();
  return crypto.timingSafeEqual(a, b);
}

// The fallback admin hash used when data.json doesn't exist yet. readData()
// runs on every public API request, and it used to re-run scrypt each time
// in that state — memoise it.
let cachedDefaultAdminHash = null;
function defaultAdminPasswordHash() {
  if (!cachedDefaultAdminHash) {
    cachedDefaultAdminHash = hashPassword(process.env.ADMIN_PASSWORD || 'admin123'); // Set ADMIN_PASSWORD in .env — do not rely on this fallback in production
  }
  return cachedDefaultAdminHash;
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter for the admin login endpoint.
// Note: on serverless hosts each instance keeps its own counters, so this is
// a best-effort brake, not a hard guarantee — pair it with a strong password.
// ---------------------------------------------------------------------------
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // ip -> { count, firstAttempt }

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginRateLimiter(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();

  // Drop expired entries so the map can't grow without bound.
  if (loginAttempts.size > 500) {
    for (const [key, value] of loginAttempts) {
      if (now - value.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
    }
  }
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return next();
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((entry.firstAttempt + LOGIN_WINDOW_MS - now) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }

  entry.count += 1;
  next();
}

function resetLoginAttempts(req) {
  loginAttempts.delete(clientIp(req));
}

// Middleware
app.disable('x-powered-by'); // don't advertise the stack to scanners

// ---------------------------------------------------------------------------
// Security headers. Equivalent to the subset of Helmet this app actually
// needs, without adding a dependency.
//
// The CSP allows 'unsafe-inline' for scripts because the markup still uses
// inline onclick handlers; everything else is locked to same-origin plus the
// Google Fonts hosts the pages load from.
// ---------------------------------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Never let a browser or CDN cache admin API responses or admin pages — a
  // cached /api/admin/* payload is a data leak on a shared machine.
  // Public API endpoints can be cached for performance.
  if (req.path.startsWith('/api/admin/') || req.path.startsWith('/admin')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  } else if (req.path.startsWith('/api/')) {
    // Public API endpoints: cache for 60s with stale-while-revalidate
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  }
  // Keep the admin panel out of search results even if robots.txt is ignored.
  if (req.path.startsWith('/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

app.use(bodyParser.json({ limit: '100kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));

// Static assets: fingerprint-free, so a short max-age with revalidation keeps
// repeat visits fast without serving a stale deploy.
const STATIC_OPTS = {
  maxAge: IS_PROD ? '1h' : 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // File names are not fingerprinted, so never mark them "immutable": a redeploy
    // would leave visitors with old scripts talking to the new server.
    if (/\.(png|jpg|jpeg|webp|gif|ico|svg|woff2?)$/i.test(filePath) && IS_PROD) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day for images/fonts
    }
    if (/\.(css|js)$/i.test(filePath) && IS_PROD) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'); // revalidate via ETag
    }
  }
};
// The raw admin pages must only be reachable through /admin (which decides
// between the login page and the dashboard). Served statically they bypass
// that gate, and a trailing slash (/admin/) breaks every relative asset URL.
app.use((req, res, next) => {
  if (req.path === '/admin/' || req.path === '/admin.html' || req.path === '/admin-login.html') {
    return res.redirect(302, '/admin');
  }
  next();
});

app.use(express.static(PUBLIC_DIR, STATIC_OPTS));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), STATIC_OPTS));

// Remote storage: give every /api request its own copy of the stored data and save
// any change before the response is sent (see "Per-request data context" above).
if (USE_REMOTE_STORAGE) {
  app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();

    let ctx;
    try {
      ctx = await loadDataContext();
    } catch (err) {
      return next(err);
    }
    ctx.bestEffort = req.method === 'GET' || req.method === 'HEAD'; // e.g. one-time migrations on a GET
    req._dataCtx = ctx;

    const originalEnd = res.end;
    let flushing = false;
    res.end = function patchedEnd(...args) {
      if (!ctx.dirty || flushing) return originalEnd.apply(res, args);
      flushing = true;
      flushDataContext(ctx)
        .then(() => originalEnd.apply(res, args))
        .catch((err) => {
          console.error('[STORAGE] Save failed:', err);
          if (ctx.bestEffort || res.headersSent) return originalEnd.apply(res, args);
          res.removeHeader('Content-Length');
          res.removeHeader('ETag');
          res.statusCode = err.status === 409 ? 409 : 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          originalEnd.call(res, JSON.stringify({
            error: err.status === 409
              ? 'Someone else changed this at the same time. Please refresh and try again.'
              : 'Could not save your changes. Please try again.'
          }));
        });
      return res;
    };
    next();
  });
}

// File upload configuration
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const ALLOWED_PDF_TYPES = ['application/pdf'];

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase());
  }
});

// With Vercel Blob the file is kept in memory and uploaded by the route (uploadToBlob).
const memoryStorage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  // On Vercel there is no writable disk: without Blob an upload can never be stored.
  if (IS_SERVERLESS && !USE_BLOB_STORAGE) {
    return cb(storageError('Blob is not configured', 503, BLOB_NOT_CONFIGURED_MESSAGE));
  }
  const isImageField = file.fieldname !== 'pdf';
  const allowed = isImageField ? ALLOWED_IMAGE_TYPES : ALLOWED_PDF_TYPES;
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error(isImageField
      ? 'Only JPEG, PNG, WEBP, GIF or SVG images are allowed.'
      : 'Only PDF files are allowed for the pdf field.'));
  }
  cb(null, true);
}

const upload = multer({
  storage: USE_BLOB_STORAGE ? memoryStorage : diskStorage,
  fileFilter: fileFilter,
  // Vercel rejects request bodies over ~4.5MB, so stay below that there.
  limits: { fileSize: (USE_BLOB_STORAGE || IS_SERVERLESS ? 4 : 10) * 1024 * 1024 }
});

// Logo uploads always arrive in memory; the route decides where to store them.
const logoUpload = multer({
  storage: memoryStorage,
  fileFilter: fileFilter,
  limits: { fileSize: 4 * 1024 * 1024 }
});

// Vercel Blob list function to get latest logo
async function getLatestLogoFromBlob() {
  if (!USE_BLOB_STORAGE) return null;
  for (const prefix of ['logos/', 'phoenixai-studio/logos/']) {
    try {
      const response = await fetch(`https://blob.vercel-storage.com/?prefix=${encodeURIComponent(prefix)}&limit=100`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${BLOB_READ_WRITE_TOKEN}`, 'x-api-version': '7' }
      });
      if (!response.ok) {
        console.error('[Logo Fetch] Vercel Blob list error:', response.status);
        continue;
      }
      const data = await response.json();
      if (data.blobs && data.blobs.length > 0) {
        return data.blobs.sort((x, y) => new Date(y.uploadedAt) - new Date(x.uploadedAt))[0].url;
      }
    } catch (error) {
      console.error('[Logo Fetch] Error fetching logo from Vercel Blob:', error);
    }
  }
  return null;
}

// Data storage (JSON file-based for MVP)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// Pure migration function - applies all migrations to data
// Returns { data, changed } where changed is true if any migration was applied
function applyMigrations(data) {
  let changed = false;

  // Basic shape: every route assumes these exist.
  if (!data.settings || typeof data.settings !== 'object') {
    data.settings = {};
    changed = true;
  }
  if (!data.settings.adminPassword) {
    data.settings.adminPassword = defaultAdminPasswordHash();
    changed = true;
  }
  ['templates', 'packages', 'inquiries', 'leads', 'notifications'].forEach((key) => {
    if (!Array.isArray(data[key])) {
      data[key] = [];
      changed = true;
    }
  });
  
  // Ensure _rev exists for optimistic concurrency
  if (data._rev === undefined) {
    data._rev = 0;
    changed = true;
  }
  
  // Ensure demoWebsites array exists
  if (!data.demoWebsites) {
    data.demoWebsites = [];
    changed = true;
  }
  
  // Ensure aiAgents array exists
  if (!data.aiAgents) {
    data.aiAgents = [];
    changed = true;
  }
  
  // Ensure services array exists
  if (!data.services) {
    data.services = [];
    changed = true;
  }
  
  // Ensure settings.modules exists
  if (!Array.isArray(data.settings.modules) || data.settings.modules.length === 0) {
    data.settings.modules = [
      {
        id: 'overview',
        name: 'Overview',
        description: 'Dashboard and statistics',
        navigationLabel: 'Overview',
        enabled: true,
        displayOrder: 1,
        showInSidebar: true,
        category: 'main'
      },
      {
        id: 'templates',
        name: 'Career Builder',
        description: 'Resume, Portfolio & Cover Letter templates',
        navigationLabel: 'Career Builder',
        enabled: true,
        displayOrder: 2,
        showInSidebar: true,
        category: 'content',
        parent: null
      },
      {
        id: 'demo-websites',
        name: 'Demo Websites',
        description: 'Website demo showcase',
        navigationLabel: 'Demo Websites',
        enabled: true,
        displayOrder: 3,
        showInSidebar: true,
        category: 'content',
        parent: null
      },
      {
        id: 'ai-agents',
        name: 'AI Agents',
        description: 'AI agent services and demos',
        navigationLabel: 'AI Agents',
        enabled: true,
        displayOrder: 4,
        showInSidebar: true,
        category: 'content',
        parent: null
      },
      {
        id: 'packages',
        name: 'Packages',
        description: 'Pricing packages',
        navigationLabel: 'Packages',
        enabled: true,
        displayOrder: 5,
        showInSidebar: true,
        category: 'business',
        parent: null
      },
      {
        id: 'inquiries',
        name: 'Inquiries',
        description: 'Contact requests and leads',
        navigationLabel: 'Inquiries',
        enabled: true,
        displayOrder: 6,
        showInSidebar: true,
        category: 'business',
        parent: null
      },
      {
        id: 'leads',
        name: 'Leads',
        description: 'Lead management',
        navigationLabel: 'Leads',
        enabled: true,
        displayOrder: 7,
        showInSidebar: true,
        category: 'business',
        parent: null
      },
      {
        id: 'notifications',
        name: 'Notifications',
        description: 'System notifications',
        navigationLabel: 'Notifications',
        enabled: true,
        displayOrder: 8,
        showInSidebar: true,
        category: 'system',
        parent: null
      },
      {
        id: 'pet',
        name: 'Phoenix Pet',
        description: 'Site mascot — enable/disable and edit its tips',
        navigationLabel: 'Phoenix Pet',
        enabled: true,
        displayOrder: 8.5,
        showInSidebar: true,
        category: 'system',
        parent: null
      },
      {
        id: 'settings',
        name: 'Settings',
        description: 'Application settings and configuration',
        navigationLabel: 'Settings',
        enabled: true,
        displayOrder: 9,
        showInSidebar: true,
        category: 'system',
        parent: null
      }
    ];
    changed = true;
  }
  
  // Ensure settings.packageCategories exists
  if (!Array.isArray(data.settings.packageCategories) || data.settings.packageCategories.length === 0) {
    data.settings.packageCategories = [
      {
        id: 'career-builder',
        name: 'Career Builder',
        description: 'Resume, Portfolio & Cover Letter Builder packages',
        enabled: true,
        displayOrder: 1
      },
      {
        id: 'website-module',
        name: 'Website Module',
        description: 'Website design, development and website service packages',
        enabled: true,
        displayOrder: 2
      },
      {
        id: 'ai-agent-module',
        name: 'AI Agent Module',
        description: 'AI agent development, automation and AI agent service packages',
        enabled: true,
        displayOrder: 3
      }
    ];
    changed = true;
  }
  
  // Ensure settings.serviceCategories exists
  if (!Array.isArray(data.settings.serviceCategories) || data.settings.serviceCategories.length === 0) {
    // If top-level serviceCategories exists, migrate it to settings.serviceCategories
    if (data.serviceCategories && Array.isArray(data.serviceCategories)) {
      data.settings.serviceCategories = data.serviceCategories;
      delete data.serviceCategories;
    } else {
      // Seed default service categories
      data.settings.serviceCategories = [
        {
          id: 'career-builder',
          name: 'Career Builder',
          description: 'Resume, Portfolio & Cover Letter services',
          enabled: true,
          displayOrder: 1
        },
        {
          id: 'website-services',
          name: 'Website Services',
          description: 'Website design, development and maintenance services',
          enabled: true,
          displayOrder: 2
        },
        {
          id: 'ai-agent-services',
          name: 'AI Agent Services',
          description: 'AI agent development and automation services',
          enabled: true,
          displayOrder: 3
        },
        {
          id: 'business-solutions',
          name: 'Business Solutions',
          description: 'Business consulting and strategy services',
          enabled: true,
          displayOrder: 4
        },
        {
          id: 'digital-services',
          name: 'Digital Services',
          description: 'Digital marketing and online presence services',
          enabled: true,
          displayOrder: 5
        },
        {
          id: 'other',
          name: 'Other',
          description: 'Other professional services',
          enabled: true,
          displayOrder: 6
        }
      ];
    }
    changed = true;
  }
  
  // Ensure the Services module exists in sidebar nav
  if (data.settings.modules && !data.settings.modules.some(m => m.id === 'services')) {
    // Find the packages module to insert services after it
    const packagesIndex = data.settings.modules.findIndex(m => m.id === 'packages');
    const servicesModule = {
      id: 'services',
      name: 'Services',
      description: 'Manage business services',
      navigationLabel: 'Services',
      enabled: true,
      displayOrder: 6,
      showInSidebar: true,
      category: 'content',
      parent: null
    };
    if (packagesIndex !== -1) {
      data.settings.modules.splice(packagesIndex + 1, 0, servicesModule);
    } else {
      data.settings.modules.push(servicesModule);
    }
    changed = true;
  }
  
  // Ensure settings.pet exists (phoenix mascot config)
  if (!data.settings.pet) {
    data.settings.pet = {
      enabled: true,
      tips: [
        'Need a site? Tap "Start Your Project".',
        'Browse the packages — there\'s one for every budget.',
        'Our AI agents can answer customers 24/7.',
        'Every site we build is mobile-first.',
        'Rising since day one. 🔥',
        'Questions? Scroll down to the contact form.'
      ]
    };
    changed = true;
  }
  
  // Ensure the Phoenix Pet module exists in sidebar nav (for data.json created before this feature)
  if (data.settings.modules && !data.settings.modules.some(m => m.id === 'pet')) {
    data.settings.modules.push({
      id: 'pet',
      name: 'Phoenix Pet',
      description: 'Site mascot — enable/disable and edit its tips',
      navigationLabel: 'Phoenix Pet',
      enabled: true,
      displayOrder: 8.5,
      showInSidebar: true,
      category: 'system',
      parent: null
    });
    changed = true;
  }
  
  // Ensure packages have category field
  if (data.packages) {
    data.packages.forEach(pkg => {
      if (!pkg.category) {
        pkg.category = 'website-module'; // Default for existing packages
        changed = true;
      }
    });
  }
  
  // Sample packages / AI agents are added only ONCE (first run). Without the flag,
  // deleting the last package or agent in the admin panel made the samples reappear.
  const seedSamples = !data._seeded;
  if (seedSamples) {
    data._seeded = true;
    changed = true;
  }

  // Add sample packages if array is empty
  if (seedSamples && data.packages && data.packages.length === 0) {
    data.packages = [
      {
        id: 'pkg-001',
        name: 'Starter Package',
        description: 'Perfect for individuals starting their career journey.',
        shortDescription: 'Essential documents for career starters',
        price: 99,
        category: 'career-builder',
        thumbnail: '/thumbnails/starter-package.png',
        featured: true,
        published: true,
        status: '',
        sortOrder: 1,
        createdAt: new Date().toISOString()
      },
      {
        id: 'pkg-002',
        name: 'Professional Package',
        description: 'Comprehensive package for serious job seekers.',
        shortDescription: 'Complete solution for professional careers',
        price: 199,
        category: 'career-builder',
        thumbnail: '/thumbnails/professional-package.png',
        featured: true,
        published: true,
        status: '',
        sortOrder: 2,
        createdAt: new Date().toISOString()
      },
      {
        id: 'pkg-003',
        name: 'E-Commerce Package',
        description: 'Complete e-commerce solution with product showcase, shopping cart, and payment integration.',
        shortDescription: 'Full e-commerce website with payment integration',
        price: 299,
        category: 'website-module',
        thumbnail: '/thumbnails/ecommerce-store.png',
        featured: false,
        published: true,
        status: '',
        sortOrder: 3,
        createdAt: new Date().toISOString()
      }
    ];
    changed = true;
  }
  
  // Add leads array if it doesn't exist
  if (!data.leads) {
    data.leads = [];
    changed = true;
  }
  
  // Add notifications array if it doesn't exist
  if (!data.notifications) {
    data.notifications = [];
    changed = true;
  }
  
  // Add sample AI agents if array is empty
  if (seedSamples && data.aiAgents && data.aiAgents.length === 0) {
    data.aiAgents = [
      {
        id: 'agent-001',
        name: 'Customer Support Agent',
        slug: 'customer-support-agent',
        category: 'customer-support',
        shortDescription: 'Automates customer questions, support requests and FAQs.',
        description: 'An intelligent AI customer support agent that handles common inquiries, provides instant responses, and escalates complex issues to human agents. Reduces response time and improves customer satisfaction.',
        thumbnail: '/thumbnails/customer-support.png',
        demoUrl: 'https://example.com/customer-support-demo',
        features: ['24/7 Availability', 'Instant Responses', 'Multi-language Support', 'FAQ Automation'],
        useCases: ['Customer Service', 'Help Desk', 'FAQ Management'],
        status: 'New',
        featured: true,
        published: true,
        sortOrder: 1,
        createdAt: new Date().toISOString()
      },
      {
        id: 'agent-002',
        name: 'Sales Agent',
        slug: 'sales-agent',
        category: 'sales',
        shortDescription: 'Intelligent sales assistant that qualifies leads and schedules demos.',
        description: 'An AI-powered sales agent that engages with potential customers, qualifies leads based on predefined criteria, and automatically schedules product demos with sales representatives.',
        thumbnail: '/thumbnails/sales-agent.png',
        demoUrl: 'https://example.com/sales-agent-demo',
        features: ['Lead Qualification', 'Demo Scheduling', 'Follow-up Automation', 'CRM Integration'],
        useCases: ['Lead Generation', 'Sales Process', 'Customer Engagement'],
        status: '',
        featured: true,
        published: true,
        sortOrder: 2,
        createdAt: new Date().toISOString()
      },
      {
        id: 'agent-003',
        name: 'Appointment Booking Agent',
        slug: 'appointment-booking-agent',
        category: 'appointment-booking',
        shortDescription: 'Automates appointment scheduling and calendar management.',
        description: 'An AI agent that handles appointment booking requests, checks calendar availability, schedules meetings, and sends automated reminders to reduce no-shows.',
        thumbnail: '/thumbnails/appointment-agent.png',
        demoUrl: 'https://example.com/appointment-agent-demo',
        features: ['Calendar Integration', 'Automated Reminders', 'Time Zone Handling', 'Conflict Detection'],
        useCases: ['Healthcare', 'Consulting', 'Service Businesses'],
        status: '',
        featured: false,
        published: true,
        sortOrder: 3,
        createdAt: new Date().toISOString()
      }
    ];
    changed = true;
  }
  
  return { data, changed };
}

// Initialize data file if it doesn't exist
function initializeData() {
  // Do nothing when using remote storage - data will be loaded from Redis
  if (USE_REMOTE_STORAGE) {
    console.log('[STORAGE] Skipping initializeData - using remote storage');
    return;
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initialData = {
      templates: [
        {
          id: '1',
          name: 'Executive Pro',
          category: 'resume',
          description: 'Premium executive resume template with elegant layout and professional typography.',
          style: 'Executive',
          thumbnail: '/thumbnails/executive-resume.png',
          pdf: '',
          previewImages: [],
          portfolioUrl: '',
          featured: true,
          published: true,
          sortOrder: 1,
          createdAt: new Date().toISOString()
        },
        {
          id: '2',
          name: 'Creative Portfolio',
          category: 'portfolio',
          description: 'Modern portfolio design perfect for creative professionals and designers.',
          style: 'Creative',
          thumbnail: '/thumbnails/creative-portfolio.png',
          pdf: '',
          previewImages: [],
          portfolioUrl: 'https://example.com/portfolio',
          featured: true,
          published: true,
          sortOrder: 2,
          createdAt: new Date().toISOString()
        },
        {
          id: '3',
          name: 'Professional Cover Letter',
          category: 'cover-letter',
          description: 'Clean and professional cover letter template that complements any resume.',
          style: 'Professional',
          thumbnail: '/thumbnails/cover-letter.png',
          pdf: '',
          previewImages: [],
          portfolioUrl: '',
          featured: true,
          published: true,
          sortOrder: 3,
          createdAt: new Date().toISOString()
        },
        {
          id: '4',
          name: 'Tech Resume',
          category: 'resume',
          description: 'Modern resume template optimized for technology and engineering professionals.',
          style: 'Modern',
          thumbnail: '/thumbnails/tech-resume.png',
          pdf: '',
          previewImages: [],
          portfolioUrl: '',
          featured: true,
          published: true,
          sortOrder: 4,
          createdAt: new Date().toISOString()
        },
        {
          id: '5',
          name: 'Minimalist Portfolio',
          category: 'portfolio',
          description: 'Clean minimalist portfolio design that lets your work speak for itself.',
          style: 'Minimalist',
          thumbnail: '/thumbnails/minimalist-portfolio.png',
          pdf: '',
          previewImages: [],
          portfolioUrl: 'https://example.com/minimalist',
          featured: false,
          published: true,
          sortOrder: 5,
          createdAt: new Date().toISOString()
        },
        {
          id: '6',
          name: 'Executive Cover Letter',
          category: 'cover-letter',
          description: 'Sophisticated cover letter template for senior-level positions.',
          style: 'Executive',
          thumbnail: '/thumbnails/executive-cover-letter.png',
          pdf: '',
          previewImages: [],
          portfolioUrl: '',
          featured: false,
          published: true,
          sortOrder: 6,
          createdAt: new Date().toISOString()
        }
      ],
      packages: [
        {
          id: 'package-001',
          name: 'Starter',
          slug: 'starter',
          category: 'website-module',
          price: '4999',
          currency: 'INR',
          billingType: 'one-time',
          description: 'A professional starting package for businesses and individuals.',
          features: [
            'Professional Website',
            'Mobile Responsive',
            'WhatsApp Integration',
            'Basic SEO'
          ],
          ctaText: 'Get Started',
          ctaLink: '#project-start',
          featured: false,
          published: true,
          sortOrder: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 'package-002',
          name: 'Professional',
          slug: 'professional',
          category: 'website-module',
          price: '9999',
          currency: 'INR',
          billingType: 'one-time',
          description: 'Comprehensive professional package for growing businesses.',
          features: [
            'Professional Website',
            'Mobile Responsive',
            'WhatsApp Integration',
            'Advanced SEO',
            'Social Media Integration',
            'Analytics Dashboard'
          ],
          ctaText: 'Get Started',
          ctaLink: '#project-start',
          featured: true,
          published: true,
          sortOrder: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 'package-003',
          name: 'Premium',
          slug: 'premium',
          category: 'website-module',
          price: '19999',
          currency: 'INR',
          billingType: 'one-time',
          description: 'Premium package for established businesses and enterprises.',
          features: [
            'Professional Website',
            'Mobile Responsive',
            'WhatsApp Integration',
            'Advanced SEO',
            'Social Media Integration',
            'Analytics Dashboard',
            'Email Marketing Setup',
            'Priority Support'
          ],
          ctaText: 'Get Started',
          ctaLink: '#project-start',
          featured: false,
          published: true,
          sortOrder: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      inquiries: [],
      services: [],
      demoWebsites: [],
      aiAgents: [
        {
          id: 'agent-001',
          name: 'Customer Support Agent',
          slug: 'customer-support-agent',
          category: 'customer-support',
          shortDescription: 'Automates customer questions, support requests and FAQs.',
          description: 'An intelligent AI customer support agent that handles common inquiries, provides instant responses, and escalates complex issues to human agents. Reduces response time and improves customer satisfaction.',
          thumbnail: '/thumbnails/customer-support.png',
          demoUrl: 'https://example.com/customer-support-demo',
          features: ['24/7 Availability', 'Instant Responses', 'Multi-language Support', 'FAQ Automation'],
          useCases: ['Customer Service', 'Help Desk', 'FAQ Management'],
          status: 'New',
          featured: true,
          published: true,
          sortOrder: 1,
          createdAt: new Date().toISOString()
        },
        {
          id: 'agent-002',
          name: 'Sales Agent',
          slug: 'sales-agent',
          category: 'sales',
          shortDescription: 'Intelligent sales assistant that qualifies leads and schedules demos.',
          description: 'An AI-powered sales agent that engages with potential customers, qualifies leads based on predefined criteria, and automatically schedules product demos with sales representatives.',
          thumbnail: '/thumbnails/sales-agent.png',
          demoUrl: 'https://example.com/sales-agent-demo',
          features: ['Lead Qualification', 'Demo Scheduling', 'Follow-up Automation', 'CRM Integration'],
          useCases: ['Lead Generation', 'Sales Process', 'Customer Engagement'],
          status: '',
          featured: true,
          published: true,
          sortOrder: 2,
          createdAt: new Date().toISOString()
        },
        {
          id: 'agent-003',
          name: 'Appointment Booking Agent',
          slug: 'appointment-booking-agent',
          category: 'appointment-booking',
          shortDescription: 'Automates appointment scheduling and calendar management.',
          description: 'An AI agent that handles appointment booking requests, checks calendar availability, schedules meetings, and sends automated reminders to reduce no-shows.',
          thumbnail: '/thumbnails/appointment-agent.png',
          demoUrl: 'https://example.com/appointment-agent-demo',
          features: ['Calendar Integration', 'Automated Reminders', 'Time Zone Handling', 'Conflict Detection'],
          useCases: ['Healthcare', 'Consulting', 'Service Businesses'],
          status: '',
          featured: false,
          published: true,
          sortOrder: 3,
          createdAt: new Date().toISOString()
        }
      ],
      settings: {
        logo: '',
        adminPassword: defaultAdminPasswordHash(),
        modules: [
          {
            id: 'overview',
            name: 'Overview',
            description: 'Dashboard and statistics',
            navigationLabel: 'Overview',
            enabled: true,
            displayOrder: 1,
            showInSidebar: true,
            category: 'main'
          },
          {
            id: 'templates',
            name: 'Career Builder',
            description: 'Resume, Portfolio & Cover Letter templates',
            navigationLabel: 'Career Builder',
            enabled: true,
            displayOrder: 2,
            showInSidebar: true,
            category: 'content',
            parent: null
          },
          {
            id: 'demo-websites',
            name: 'Demo Websites',
            description: 'Website demo showcase',
            navigationLabel: 'Demo Websites',
            enabled: true,
            displayOrder: 3,
            showInSidebar: true,
            category: 'content',
            parent: null
          },
          {
            id: 'ai-agents',
            name: 'AI Agents',
            description: 'AI agent services and demos',
            navigationLabel: 'AI Agents',
            enabled: true,
            displayOrder: 4,
            showInSidebar: true,
            category: 'content',
            parent: null
          },
          {
            id: 'packages',
            name: 'Packages',
            description: 'Pricing packages',
            navigationLabel: 'Packages',
            enabled: true,
            displayOrder: 5,
            showInSidebar: true,
            category: 'business',
            parent: null
          },
          {
            id: 'services',
            name: 'Services',
            description: 'Manage business services',
            navigationLabel: 'Services',
            enabled: true,
            displayOrder: 6,
            showInSidebar: true,
            category: 'content',
            parent: null
          },
          {
            id: 'inquiries',
            name: 'Inquiries',
            description: 'Contact requests and leads',
            navigationLabel: 'Inquiries',
            enabled: true,
            displayOrder: 7,
            showInSidebar: true,
            category: 'business',
            parent: null
          },
          {
            id: 'leads',
            name: 'Leads',
            description: 'Lead management',
            navigationLabel: 'Leads',
            enabled: true,
            displayOrder: 8,
            showInSidebar: true,
            category: 'business',
            parent: null
          },
          {
            id: 'notifications',
            name: 'Notifications',
            description: 'System notifications',
            navigationLabel: 'Notifications',
            enabled: true,
            displayOrder: 9,
            showInSidebar: true,
            category: 'system',
            parent: null
          },
          {
            id: 'pet',
            name: 'Phoenix Pet',
            description: 'Site mascot — enable/disable and edit its tips',
            navigationLabel: 'Phoenix Pet',
            enabled: true,
            displayOrder: 9.5,
            showInSidebar: true,
            category: 'system',
            parent: null
          },
          {
            id: 'settings',
            name: 'Settings',
            description: 'Application settings and configuration',
            navigationLabel: 'Settings',
            enabled: true,
            displayOrder: 10,
            showInSidebar: true,
            category: 'system',
            parent: null
          }
        ],
        packageCategories: [
          {
            id: 'career-builder',
            name: 'Career Builder',
            description: 'Resume, Portfolio & Cover Letter Builder packages',
            enabled: true,
            displayOrder: 1
          },
          {
            id: 'website-module',
            name: 'Website Module',
            description: 'Website design, development and website service packages',
            enabled: true,
            displayOrder: 2
          },
          {
            id: 'ai-agent-module',
            name: 'AI Agent Module',
            description: 'AI agent development, automation and AI agent service packages',
            enabled: true,
            displayOrder: 3
          }
        ],
        serviceCategories: [
          {
            id: 'career-builder',
            name: 'Career Builder',
            description: 'Resume, Portfolio & Cover Letter services',
            enabled: true,
            displayOrder: 1
          },
          {
            id: 'website-services',
            name: 'Website Services',
            description: 'Website design, development and maintenance services',
            enabled: true,
            displayOrder: 2
          },
          {
            id: 'ai-agent-services',
            name: 'AI Agent Services',
            description: 'AI agent development and automation services',
            enabled: true,
            displayOrder: 3
          },
          {
            id: 'business-solutions',
            name: 'Business Solutions',
            description: 'Business consulting and strategy services',
            enabled: true,
            displayOrder: 4
          },
          {
            id: 'digital-services',
            name: 'Digital Services',
            description: 'Digital marketing and online presence services',
            enabled: true,
            displayOrder: 5
          },
          {
            id: 'other',
            name: 'Other',
            description: 'Other professional services',
            enabled: true,
            displayOrder: 6
          }
        ]
      }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
  }
}

function readData() {
  // Remote storage: the copy loaded for THIS request (see loadDataContext).
  if (USE_REMOTE_STORAGE) {
    const ctx = dataStore.getStore();
    if (!ctx) throw storageError('Data is not loaded for this request');
    return ctx.data;
  }

  // Local file (development / hosts with a persistent disk).
  if (!fs.existsSync(DATA_FILE)) {
    // Nothing saved yet: start from defaults. Not persisted until something is saved.
    return applyMigrations(buildDefaultData()).data;
  }
  const { data, changed } = applyMigrations(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  if (changed) {
    try {
      writeData(data);
    } catch (err) {
      // Reading must keep working even where the migrated data cannot be saved.
      if (!err.isReadOnlyStorage) throw err;
    }
  }
  return data;
}

function writeData(data) {
  // Remote storage: keep the change on this request's copy; it is saved before the response is sent.
  if (USE_REMOTE_STORAGE) {
    const ctx = dataStore.getStore();
    if (!ctx) throw storageError('Cannot save outside of a request');
    ctx.data = data;
    ctx.dirty = true;
    return;
  }

  // Serverless host without Redis: the disk is read-only, so fail with a clear message.
  if (IS_SERVERLESS) {
    const storageErr = new Error('Storage is not configured for this deployment.');
    storageErr.isReadOnlyStorage = true;
    throw storageErr;
  }

  try {
    // Write to a temp file and rename it into place. A plain writeFileSync that
    // is interrupted (crash, disk full) leaves a truncated data.json, and then
    // every readData() (including the login) fails with a JSON parse error.
    const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (writeErr) {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* nothing to clean up */ }
      throw writeErr;
    }
  } catch (err) {
    if (err.code === 'EROFS' || err.code === 'EACCES') {
      const storageErr = new Error('Storage is read-only in this deployment environment.');
      storageErr.isReadOnlyStorage = true;
      throw storageErr;
    }
    throw err;
  }
}

// Initialize data file if it doesn't exist (safe for both environments)
try {
  initializeData();
} catch (error) {
  // In serverless environments with read-only filesystem, this may fail
  // The data file should already exist from deployment
  if (error.code !== 'EACCES' && error.code !== 'EROFS') {
    console.error('Error initializing data file:', error);
  }
}

// Admin authentication middleware — also enforces the CSRF token (from the
// paired readable cookie) on any request that changes state.
const MUTATING_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];
function requireAdmin(req, res, next) {
  const auth = verifyAuthCookie(req);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (MUTATING_METHODS.includes(req.method)) {
    const token = req.headers['x-csrf-token'];
    if (!token || token !== auth.csrf) {
      return res.status(403).json({ error: 'Missing or invalid CSRF token.' });
    }
  }
  next();
}

// Sends a file from public/ using `root`, which is safer than an absolute path
// (no dot-directory / traversal surprises), and turns a missing file into a
// readable message instead of a blank error. A missing file here usually means
// the host didn't bundle public/ with the server (see vercel.json includeFiles).
function sendPublicFile(res, next, fileName, status) {
  if (status) res.status(status);
  res.sendFile(fileName, { root: PUBLIC_DIR }, (err) => {
    if (!err || res.headersSent) return;
    console.error(`[static] Could not send public/${fileName}:`, err.message);
    if (err.code === 'ENOENT' || err.status === 404) {
      return res.status(500).type('text/plain').send(`Server is missing public/${fileName}. Make sure the public/ folder is deployed together with server.js.`);
    }
    next(err);
  });
}

// Public routes
app.get('/', (req, res, next) => {
  sendPublicFile(res, next, 'index.html');
});

app.get('/api/templates', (req, res) => {
  const data = readData();
  const publishedTemplates = data.templates.filter(t => t.published);
  res.json(publishedTemplates);
});

app.get('/api/templates/featured', (req, res) => {
  const data = readData();
  const featuredTemplates = data.templates
    .filter(t => t.published && t.featured)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, 4);
  res.json(featuredTemplates);
});

app.get('/api/templates/category/:category', (req, res) => {
  const data = readData();
  const categoryTemplates = data.templates
    .filter(t => t.published && t.category.toLowerCase() === req.params.category.toLowerCase())
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(categoryTemplates);
});

app.get('/api/settings/logo', async (req, res) => {
  const data = readData();

  // Use the persisted logo URL from data.settings.logo
  // Fall back to fetching from Blob only if no URL is stored (migration for old data)
  let logoUrl = data.settings.logo;
  if (!logoUrl && USE_BLOB_STORAGE) {
    const blobLogo = await getLatestLogoFromBlob();
    if (blobLogo) {
      logoUrl = blobLogo;
      // Persist it for future requests
      data.settings.logo = blobLogo;
      writeData(data);
    }
  }

  res.json({ logo: logoUrl });
});

// Health check: shows which storage is active and what is missing (names only, never secrets).
app.get('/api/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const problems = [];
  const status = {
    time: new Date().toISOString(),
    runtime: IS_SERVERLESS ? 'serverless' : 'server',
    storage: {
      data: USE_REMOTE_STORAGE ? 'redis' : (IS_SERVERLESS ? 'not-configured' : 'local-file'),
      files: USE_BLOB_STORAGE ? 'blob' : (IS_SERVERLESS ? 'not-configured' : 'local-disk'),
      redisReachable: null
    },
    env: {
      KV_REST_API_URL: Boolean(KV_REST_API_URL),
      KV_REST_API_TOKEN: Boolean(KV_REST_API_TOKEN),
      BLOB_READ_WRITE_TOKEN: Boolean(BLOB_READ_WRITE_TOKEN),
      ADMIN_PASSWORD: Boolean(process.env.ADMIN_PASSWORD),
      SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
      NODE_ENV: process.env.NODE_ENV || null
    }
  };

  if (IS_SERVERLESS && !USE_REMOTE_STORAGE) {
    problems.push('Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN missing): admin changes cannot be saved.');
  }
  if (IS_SERVERLESS && !USE_BLOB_STORAGE) {
    problems.push('Blob is not configured (BLOB_READ_WRITE_TOKEN missing): uploads are disabled.');
  }
  if (USE_REMOTE_STORAGE) {
    try {
      await redisCommand(['PING'], 5000);
      status.storage.redisReachable = true;
    } catch (err) {
      status.storage.redisReachable = false;
      problems.push(`Redis is configured but not reachable: ${err.message}`);
    }
  }
  if (IS_PROD && !process.env.ADMIN_PASSWORD) problems.push('ADMIN_PASSWORD is not set (the default password applies until it is changed in Settings).');
  if (IS_PROD && !process.env.SESSION_SECRET) problems.push('SESSION_SECRET is not set.');

  status.problems = problems;
  status.ok = problems.length === 0;
  res.status(status.ok ? 200 : 503).json(status);
});

// Backup: everything except the password hash.
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const data = JSON.parse(JSON.stringify(readData()));
  if (data.settings) delete data.settings.adminPassword;
  res.setHeader('Content-Disposition', `attachment; filename="phoenixai-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

app.get('/api/modules', (req, res) => {
  const data = readData();
  const modules = data.settings.modules || [];
  const enabledModules = modules.filter(m => m.enabled).sort((a, b) => a.displayOrder - b.displayOrder);
  res.json(enabledModules);
});

// Admin routes
// /admin        -> dashboard if signed in, otherwise the login page
// /admin?login  -> always the login page (used by the logo triple-click on the
//                  public site). Read-only: it doesn't touch the session, and
//                  signing in again simply replaces the cookie.
app.get('/admin', (req, res, next) => {
  const forceLogin = req.query.login !== undefined;
  sendPublicFile(res, next, (!forceLogin && verifyAuthCookie(req)) ? 'admin.html' : 'admin-login.html');
});

// Public bootstrap endpoint - returns all data needed for the home page in one request
app.get('/api/public/bootstrap', (req, res) => {
  const data = readData();

  // Filter for published items only
  const publishedTemplates = (data.templates || []).filter(t => t.published);
  const publishedPackages = (data.packages || []).filter(p => p.published);
  const publishedDemoWebsites = (data.demoWebsites || []).filter(d => d.published);
  const publishedAIAgents = (data.aiAgents || []).filter(a => a.published);
  const activeServices = (data.services || []).filter(s => s.active);

  // Get enabled modules
  const enabledModules = (data.settings.modules || []).filter(m => m.enabled);

  res.json({
    logo: data.settings.logo || '',
    modules: enabledModules,
    templates: publishedTemplates,
    packages: publishedPackages,
    packageCategories: data.settings.packageCategories || [],
    services: activeServices,
    demoWebsites: publishedDemoWebsites,
    aiAgents: publishedAIAgents,
    pet: data.settings.pet || { enabled: true, tips: DEFAULT_PET_TIPS }
  });
});

const MAX_PASSWORD_LENGTH = 256;

app.post('/api/admin/login', loginRateLimiter, async (req, res, next) => {
  try {
    const password = req.body && req.body.password;

    // A non-string (e.g. {"password": {}}) used to reach scrypt and throw a 500.
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Please enter your password.' });
    }

    const data = readData();
    const stored = data.settings && data.settings.adminPassword;

    if (!(await verifyPasswordAsync(password, stored))) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Transparently upgrade legacy plaintext passwords to a hash on first
    // successful login. This is best-effort: on a read-only host the write
    // fails, and that must not turn a correct password into a failed login.
    if (!stored.startsWith('scrypt$')) {
      try {
        data.settings.adminPassword = await hashPasswordAsync(password);
        writeData(data);
      } catch (upgradeErr) {
        console.warn('[auth] Could not upgrade legacy password to a hash:', upgradeErr.message);
      }
    }

    resetLoginAttempts(req);
    setAuthCookie(req, res, req.body.remember === true);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/logout', (req, res) => {
  clearAuthCookie(req, res);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const data = readData();

    if (typeof currentPassword !== 'string' || !(await verifyPasswordAsync(currentPassword, data.settings.adminPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `New password must be at most ${MAX_PASSWORD_LENGTH} characters` });
    }

    data.settings.adminPassword = await hashPasswordAsync(newPassword);
    writeData(data);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/templates', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.templates);
});

app.post('/api/admin/templates', requireAdmin, upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'pdf', maxCount: 1 },
  { name: 'previewImages', maxCount: 10 }
]), async (req, res) => {
  const data = readData();

  // Upload files to Blob if configured
  const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
  const pdfFile = req.files['pdf'] ? req.files['pdf'][0] : null;
  const previewImageFiles = req.files['previewImages'] || [];

  let thumbnailBlob = null;
  let pdfBlob = null;
  let previewBlobs = [];

  if (USE_BLOB_STORAGE) {
    if (thumbnailFile) {
      thumbnailBlob = await uploadToBlob(thumbnailFile, 'thumbnails');
    }
    if (pdfFile) {
      pdfBlob = await uploadToBlob(pdfFile, 'pdfs');
    }
    for (const file of previewImageFiles) {
      const blob = await uploadToBlob(file, 'previews');
      previewBlobs.push(blob);
    }
  }

  const newTemplate = {
    id: Date.now().toString(),
    name: req.body.name,
    category: req.body.category,
    description: req.body.description,
    style: req.body.style,
    thumbnail: thumbnailFile ? fileUrl(thumbnailBlob || thumbnailFile) : '',
    pdf: pdfFile ? fileUrl(pdfBlob || pdfFile) : '',
    previewImages: previewImageFiles.map((f, i) => fileUrl(previewBlobs[i] || f)),
    portfolioUrl: req.body.portfolioUrl || '',
    featured: req.body.featured === 'true',
    published: req.body.published === 'true',
    sortOrder: parseInt(req.body.sortOrder) || 0,
    createdAt: new Date().toISOString()
  };

  data.templates.push(newTemplate);
  writeData(data);

  res.json({ success: true, template: newTemplate });
});

app.put('/api/admin/templates/:id', requireAdmin, upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'pdf', maxCount: 1 },
  { name: 'previewImages', maxCount: 10 }
]), async (req, res) => {
  const data = readData();
  const templateIndex = data.templates.findIndex(t => t.id === req.params.id);

  if (templateIndex === -1) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const template = data.templates[templateIndex];

  // Update fields
  template.name = req.body.name || template.name;
  template.category = req.body.category || template.category;
  template.description = req.body.description || template.description;
  template.style = req.body.style || template.style;
  template.portfolioUrl = req.body.portfolioUrl || template.portfolioUrl;
  template.featured = toBool(req.body.featured, template.featured);
  template.published = toBool(req.body.published, template.published);
  template.sortOrder = req.body.sortOrder ? parseInt(req.body.sortOrder) : template.sortOrder;

  // Upload files to Blob if configured
  const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
  const pdfFile = req.files['pdf'] ? req.files['pdf'][0] : null;
  const previewImageFiles = req.files['previewImages'] || [];

  let thumbnailBlob = null;
  let pdfBlob = null;
  let previewBlobs = [];

  if (USE_BLOB_STORAGE) {
    if (thumbnailFile) {
      thumbnailBlob = await uploadToBlob(thumbnailFile, 'thumbnails');
    }
    if (pdfFile) {
      pdfBlob = await uploadToBlob(pdfFile, 'pdfs');
    }
    for (const file of previewImageFiles) {
      const blob = await uploadToBlob(file, 'previews');
      previewBlobs.push(blob);
    }
  }

  // Update files if provided
  if (thumbnailFile) {
    template.thumbnail = fileUrl(thumbnailBlob || thumbnailFile);
  }
  if (pdfFile) {
    template.pdf = fileUrl(pdfBlob || pdfFile);
  }
  if (previewImageFiles.length > 0) {
    template.previewImages = previewImageFiles.map((f, i) => fileUrl(previewBlobs[i] || f));
  }

  data.templates[templateIndex] = template;
  writeData(data);

  res.json({ success: true, template });
});

app.delete('/api/admin/templates/:id', requireAdmin, (req, res) => {
  const data = readData();
  const templateIndex = data.templates.findIndex(t => t.id === req.params.id);
  
  if (templateIndex === -1) {
    return res.status(404).json({ error: 'Template not found' });
  }
  
  data.templates.splice(templateIndex, 1);
  writeData(data);
  
  res.json({ success: true });
});

app.post('/api/admin/settings/logo', requireAdmin, logoUpload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const data = readData();
  const oldLogoUrl = data.settings.logo;
  let newLogoUrl;

  if (USE_BLOB_STORAGE) {
    // Vercel Blob keeps the file; the URL is saved in the site data.
    newLogoUrl = (await uploadToBlob(req.file, 'logos')).blobUrl;
  } else {
    // Local disk (development / hosts with a persistent disk).
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const filename = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(req.file.originalname).toLowerCase();
    fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
    newLogoUrl = '/uploads/' + filename;
  }

  data.settings.logo = newLogoUrl;
  writeData(data);

  // Remove the previous logo only once the response (and therefore the save) went through.
  res.once('finish', () => {
    if (res.statusCode < 400 && oldLogoUrl && oldLogoUrl !== newLogoUrl) deleteBlob(oldLogoUrl);
  });
  res.json({ success: true, logo: newLogoUrl });
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const data = readData();

  // Use the persisted logo URL from data.settings.logo
  // Fall back to fetching from Blob only if no URL is stored (migration for old data)
  let logoUrl = data.settings.logo;
  if (!logoUrl && USE_BLOB_STORAGE) {
    const blobLogo = await getLatestLogoFromBlob();
    if (blobLogo) {
      logoUrl = blobLogo;
      // Persist it for future requests
      data.settings.logo = blobLogo;
      writeData(data);
    }
  }

  // Don't return sensitive data like adminPassword
  const { adminPassword, ...safeSettings } = data.settings;

  res.json({
    logo: logoUrl,
    templateCount: data.templates.length,
    packageCount: data.packages.length,
    inquiryCount: data.inquiries.length,
    modules: safeSettings.modules || [],
    packageCategories: safeSettings.packageCategories || [],
    serviceCategories: safeSettings.serviceCategories || [],
    pet: safeSettings.pet || { enabled: true, tips: DEFAULT_PET_TIPS }
  });
});

// Bootstrap endpoint - returns all admin data in one request
app.get('/api/admin/bootstrap', requireAdmin, async (req, res) => {
  const data = readData();

  // Use the persisted logo URL from data.settings.logo
  // Fall back to fetching from Blob only if no URL is stored (migration for old data)
  let logoUrl = data.settings.logo;
  if (!logoUrl && USE_BLOB_STORAGE) {
    const blobLogo = await getLatestLogoFromBlob();
    if (blobLogo) {
      logoUrl = blobLogo;
      // Persist it for future requests
      data.settings.logo = blobLogo;
      writeData(data);
    }
  }

  res.json({
    logo: logoUrl,
    templateCount: data.templates.length,
    packageCount: data.packages.length,
    inquiryCount: data.inquiries.length,
    modules: data.settings.modules || [],
    packageCategories: data.settings.packageCategories || [],
    serviceCategories: data.settings.serviceCategories || [],
    pet: data.settings.pet || { enabled: true, tips: DEFAULT_PET_TIPS },
    templates: data.templates || [],
    packages: data.packages || [],
    inquiries: data.inquiries || [],
    demoWebsites: data.demoWebsites || [],
    aiAgents: data.aiAgents || [],
    services: data.services || [],
    leads: data.leads || [],
    notifications: data.notifications || []
  });
});

// Module Management APIs
app.get('/api/admin/modules', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.settings.modules || []);
});

app.put('/api/admin/modules/reorder', requireAdmin, (req, res) => {
  const data = readData();
  const { moduleIds } = req.body;

  if (!Array.isArray(moduleIds)) {
    return res.status(400).json({ error: 'Invalid module IDs' });
  }

  if (!data.settings.modules) {
    return res.status(404).json({ error: 'Modules not found' });
  }

  // Reorder modules based on provided order
  const reorderedModules = [];
  moduleIds.forEach((id, index) => {
    const module = data.settings.modules.find(m => m.id === id);
    if (module) {
      module.displayOrder = index + 1;
      reorderedModules.push(module);
    }
  });

  // Add any modules not in the reorder list
  data.settings.modules.forEach(module => {
    if (!moduleIds.includes(module.id)) {
      reorderedModules.push(module);
    }
  });

  data.settings.modules = reorderedModules;
  writeData(data);

  res.json({ success: true, modules: reorderedModules });
});

app.put('/api/admin/modules/:id', requireAdmin, (req, res) => {
  const data = readData();

  if (!data.settings.modules) {
    return res.status(404).json({ error: 'Modules not found' });
  }

  const moduleIndex = data.settings.modules.findIndex(m => m.id === req.params.id);

  if (moduleIndex === -1) {
    return res.status(404).json({ error: 'Module not found' });
  }

  const module = data.settings.modules[moduleIndex];

  // Update allowed fields
  module.name = req.body.name || module.name;
  module.description = req.body.description || module.description;
  module.navigationLabel = req.body.navigationLabel || module.navigationLabel;
  module.enabled = req.body.enabled !== undefined ? req.body.enabled : module.enabled;
  module.displayOrder = req.body.displayOrder !== undefined ? req.body.displayOrder : module.displayOrder;
  module.showInSidebar = req.body.showInSidebar !== undefined ? req.body.showInSidebar : module.showInSidebar;

  data.settings.modules[moduleIndex] = module;
  writeData(data);

  res.json({ success: true, module });
});

// Basic spam/abuse guard for the public contact form — mirrors the admin
// login rate limiter in spirit (per-IP, in-memory, best-effort on serverless).
const INQUIRY_MAX_SUBMISSIONS = 10;
const INQUIRY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const inquirySubmissions = new Map(); // ip -> { count, firstAttempt }

function inquiryRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = inquirySubmissions.get(ip);

  if (!entry || now - entry.firstAttempt > INQUIRY_WINDOW_MS) {
    inquirySubmissions.set(ip, { count: 1, firstAttempt: now });
    return next();
  }

  if (entry.count >= INQUIRY_MAX_SUBMISSIONS) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  entry.count += 1;
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/admin/inquiries', inquiryRateLimiter, (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const email = (req.body.email || '').toString().trim();
  const message = (req.body.message || '').toString().trim();
  const phone = (req.body.phone || '').toString().trim();
  const subject = (req.body.subject || '').toString().trim();
  const service = (req.body.service || '').toString().trim();

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (name.length > 200 || email.length > 200 || phone.length > 50 || subject.length > 200 || service.length > 100) {
    return res.status(400).json({ error: 'One or more fields exceed the maximum allowed length.' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: 'Message is too long (5000 characters max).' });
  }

  const data = readData();

  const newInquiry = {
    id: 'inquiry-' + Date.now().toString() + '-' + crypto.randomBytes(3).toString('hex'),
    name,
    email,
    phone,
    subject,
    service,
    message,
    status: 'New',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.inquiries.push(newInquiry);

  // Create notification
  if (!data.notifications) {
    data.notifications = [];
  }
  
  data.notifications.unshift({
    id: 'notif-' + Date.now().toString() + '-' + crypto.randomBytes(3).toString('hex'),
    title: 'New Contact Request',
    message: `${newInquiry.name} sent a contact request: ${newInquiry.subject || 'No subject'}`,
    type: 'contact',
    inquiryId: newInquiry.id,
    read: false,
    createdAt: new Date().toISOString()
  });
  
  writeData(data);

  res.json({ success: true });
});

app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.inquiries);
});

// Enhanced Contact Request APIs
app.put('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  const data = readData();
  const inquiryIndex = data.inquiries.findIndex(i => i.id === req.params.id);
  
  if (inquiryIndex === -1) {
    return res.status(404).json({ error: 'Inquiry not found' });
  }
  
  const inquiry = data.inquiries[inquiryIndex];
  
  // Update allowed fields
  inquiry.status = req.body.status || inquiry.status;
  inquiry.service = req.body.service || inquiry.service;
  inquiry.notes = req.body.notes || inquiry.notes;
  inquiry.updatedAt = new Date().toISOString();
  
  data.inquiries[inquiryIndex] = inquiry;
  writeData(data);
  
  res.json({ success: true, inquiry });
});

app.delete('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  const data = readData();
  const inquiryIndex = data.inquiries.findIndex(i => i.id === req.params.id);
  
  if (inquiryIndex === -1) {
    return res.status(404).json({ error: 'Inquiry not found' });
  }
  
  data.inquiries.splice(inquiryIndex, 1);
  writeData(data);
  
  res.json({ success: true });
});

// Leads API endpoints
app.get('/api/admin/leads', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.leads || []);
});

app.post('/api/admin/leads', requireAdmin, (req, res) => {
  const data = readData();

  const newLead = {
    id: 'lead-' + Date.now().toString(),
    name: req.body.name,
    email: req.body.email,
    phone: req.body.phone || '',
    company: req.body.company || '',
    interestedService: req.body.interestedService || '',
    source: req.body.source || 'Website',
    status: req.body.status || 'New',
    priority: req.body.priority || 'Medium',
    notes: req.body.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (!data.leads) {
    data.leads = [];
  }

  data.leads.push(newLead);
  writeData(data);

  // Create notification
  if (!data.notifications) {
    data.notifications = [];
  }
  
  data.notifications.unshift({
    id: 'notif-' + Date.now().toString(),
    title: 'New Lead Received',
    message: `${newLead.name} from ${newLead.company || 'N/A'} is interested in ${newLead.interestedService}`,
    type: 'lead',
    leadId: newLead.id,
    read: false,
    createdAt: new Date().toISOString()
  });
  
  writeData(data);

  res.json({ success: true, lead: newLead });
});

app.put('/api/admin/leads/:id', requireAdmin, (req, res) => {
  const data = readData();
  const leadIndex = data.leads.findIndex(l => l.id === req.params.id);

  if (leadIndex === -1) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const lead = data.leads[leadIndex];

  lead.name = req.body.name || lead.name;
  lead.email = req.body.email || lead.email;
  lead.phone = req.body.phone || lead.phone;
  lead.company = req.body.company || lead.company;
  lead.interestedService = req.body.interestedService || lead.interestedService;
  lead.source = req.body.source || lead.source;
  lead.status = req.body.status || lead.status;
  lead.priority = req.body.priority || lead.priority;
  lead.notes = req.body.notes || lead.notes;
  lead.updatedAt = new Date().toISOString();

  data.leads[leadIndex] = lead;
  writeData(data);

  res.json({ success: true, lead });
});

app.delete('/api/admin/leads/:id', requireAdmin, (req, res) => {
  const data = readData();
  const leadIndex = data.leads.findIndex(l => l.id === req.params.id);

  if (leadIndex === -1) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  data.leads.splice(leadIndex, 1);
  writeData(data);

  res.json({ success: true });
});

// Notifications API endpoints
app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.notifications || []);
});

app.put('/api/admin/notifications/:id', requireAdmin, (req, res) => {
  const data = readData();
  const notifIndex = data.notifications.findIndex(n => n.id === req.params.id);

  if (notifIndex === -1) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  const notification = data.notifications[notifIndex];

  notification.read = req.body.read !== undefined ? req.body.read : notification.read;

  data.notifications[notifIndex] = notification;
  writeData(data);

  res.json({ success: true, notification });
});

app.put('/api/admin/notifications/mark-all-read', requireAdmin, (req, res) => {
  const data = readData();

  if (data.notifications) {
    data.notifications.forEach(n => n.read = true);
    writeData(data);
  }

  res.json({ success: true });
});

app.delete('/api/admin/notifications/:id', requireAdmin, (req, res) => {
  const data = readData();
  const notifIndex = data.notifications.findIndex(n => n.id === req.params.id);

  if (notifIndex === -1) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  data.notifications.splice(notifIndex, 1);
  writeData(data);

  res.json({ success: true });
});

// Package API endpoints
app.get('/api/packages', (req, res) => {
  const data = readData();
  const categories = data.settings.packageCategories || [];
  const disabledIds = new Set(categories.filter(c => c.enabled === false).map(c => c.id));
  const publishedPackages = data.packages
    .filter(p => p.published && !disabledIds.has(p.category))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(publishedPackages);
});

app.get('/api/package-categories', (req, res) => {
  const data = readData();
  const categories = (data.settings.packageCategories || [])
    .filter(c => c.enabled !== false)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  res.json(categories);
});

/* ---------- Phoenix pet mascot ---------- */

const DEFAULT_PET_TIPS = [
  'Need a site? Tap “Start Your Project”.',
  'Browse the packages — there’s one for every budget.',
  'Our AI agents can answer customers 24/7.',
  'Every site we build is mobile-first.',
  'Rising since day one. 🔥',
  'Questions? Scroll down to the contact form.'
];

app.get('/api/pet-settings', (req, res) => {
  const data = readData();
  const pet = data.settings.pet || { enabled: true, tips: DEFAULT_PET_TIPS };
  const petFeature = data.settings.petFeature || { enabled: false };
  res.json({ enabled: pet.enabled !== false, tips: pet.tips && pet.tips.length ? pet.tips : DEFAULT_PET_TIPS, petFeatureEnabled: petFeature.enabled === true });
});

app.get('/api/admin/pet-settings', requireAdmin, (req, res) => {
  const data = readData();
  const pet = data.settings.pet || { enabled: true, tips: DEFAULT_PET_TIPS };
  res.json({ enabled: pet.enabled !== false, tips: pet.tips && pet.tips.length ? pet.tips : DEFAULT_PET_TIPS });
});

app.put('/api/admin/pet-settings', requireAdmin, (req, res) => {
  const { enabled, tips } = req.body;
  const data = readData();

  if (!data.settings.pet) data.settings.pet = {};
  if (typeof enabled === 'boolean') data.settings.pet.enabled = enabled;
  if (Array.isArray(tips)) {
    const cleaned = tips.map(t => String(t).trim()).filter(Boolean).slice(0, 20);
    if (cleaned.length) data.settings.pet.tips = cleaned;
  }

  writeData(data);
  res.json({ success: true, pet: data.settings.pet });
});

// PET Feature Settings
app.get('/api/admin/pet-feature-settings', requireAdmin, (req, res) => {
  const data = readData();
  const petFeature = data.settings.petFeature || { enabled: false };
  res.json({ enabled: petFeature.enabled === true });
});

app.post('/api/admin/pet-feature-settings', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  const data = readData();

  if (!data.settings.petFeature) data.settings.petFeature = {};
  if (typeof enabled === 'boolean') data.settings.petFeature.enabled = enabled;

  writeData(data);
  res.json({ success: true, enabled: data.settings.petFeature.enabled });
});

app.get('/api/packages/featured', (req, res) => {
  const data = readData();
  const featuredPackage = data.packages.find(p => p.published && p.featured);
  res.json(featuredPackage || null);
});

app.get('/api/admin/packages', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.packages);
});

// The admin package form posts JSON (real booleans), while the other forms
// post multipart (strings). Accept both, and fall back only when the field is
// absent — so un-ticking "Published" actually unpublishes.
function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

app.post('/api/admin/packages', requireAdmin, (req, res) => {
  const data = readData();
  
  const newPackage = {
    id: 'package-' + Date.now().toString(),
    name: req.body.name,
    slug: req.body.slug,
    category: req.body.category || 'website-module',
    price: req.body.price,
    currency: req.body.currency || 'INR',
    billingType: req.body.billingType || 'one-time',
    description: req.body.description,
    features: req.body.features || [],
    ctaText: req.body.ctaText || 'Get Started',
    ctaLink: req.body.ctaLink || '#project-start',
    featured: toBool(req.body.featured, false),
    published: toBool(req.body.published, false),
    sortOrder: parseInt(req.body.sortOrder) || 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  data.packages.push(newPackage);
  writeData(data);
  
  res.json({ success: true, package: newPackage });
});

app.put('/api/admin/packages/:id', requireAdmin, (req, res) => {
  const data = readData();
  const packageIndex = data.packages.findIndex(p => p.id === req.params.id);
  
  if (packageIndex === -1) {
    return res.status(404).json({ error: 'Package not found' });
  }
  
  const pkg = data.packages[packageIndex];
  
  // Update fields
  pkg.name = req.body.name || pkg.name;
  pkg.slug = req.body.slug || pkg.slug;
  pkg.category = req.body.category || pkg.category;
  pkg.price = req.body.price || pkg.price;
  pkg.currency = req.body.currency || pkg.currency;
  pkg.billingType = req.body.billingType || pkg.billingType;
  pkg.description = req.body.description || pkg.description;
  pkg.features = req.body.features || pkg.features;
  pkg.ctaText = req.body.ctaText || pkg.ctaText;
  pkg.ctaLink = req.body.ctaLink || pkg.ctaLink;
  pkg.featured = toBool(req.body.featured, pkg.featured);
  pkg.published = toBool(req.body.published, pkg.published);
  pkg.sortOrder = req.body.sortOrder ? parseInt(req.body.sortOrder) : pkg.sortOrder;
  pkg.updatedAt = new Date().toISOString();
  
  data.packages[packageIndex] = pkg;
  writeData(data);
  
  res.json({ success: true, package: pkg });
});

app.delete('/api/admin/packages/:id', requireAdmin, (req, res) => {
  const data = readData();
  const packageIndex = data.packages.findIndex(p => p.id === req.params.id);
  
  if (packageIndex === -1) {
    return res.status(404).json({ error: 'Package not found' });
  }
  
  data.packages.splice(packageIndex, 1);
  writeData(data);
  
  res.json({ success: true });
});

// Package Category Management APIs
app.get('/api/admin/package-categories', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.settings.packageCategories || []);
});

app.put('/api/admin/package-categories/reorder', requireAdmin, (req, res) => {
  const data = readData();
  const { categoryIds } = req.body;

  if (!Array.isArray(categoryIds)) {
    return res.status(400).json({ error: 'Invalid category IDs' });
  }

  if (!data.settings.packageCategories) {
    return res.status(404).json({ error: 'Package categories not found' });
  }

  // Reorder categories based on provided order
  const reorderedCategories = [];
  categoryIds.forEach((id, index) => {
    const category = data.settings.packageCategories.find(c => c.id === id);
    if (category) {
      category.displayOrder = index + 1;
      reorderedCategories.push(category);
    }
  });

  // Add any categories not in the reorder list
  data.settings.packageCategories.forEach(category => {
    if (!categoryIds.includes(category.id)) {
      reorderedCategories.push(category);
    }
  });

  data.settings.packageCategories = reorderedCategories;
  writeData(data);

  res.json({ success: true, categories: reorderedCategories });
});

app.put('/api/admin/package-categories/:id', requireAdmin, (req, res) => {
  const data = readData();

  if (!data.settings.packageCategories) {
    return res.status(404).json({ error: 'Package categories not found' });
  }

  const categoryIndex = data.settings.packageCategories.findIndex(c => c.id === req.params.id);

  if (categoryIndex === -1) {
    return res.status(404).json({ error: 'Package category not found' });
  }

  const category = data.settings.packageCategories[categoryIndex];

  // Update allowed fields
  category.name = req.body.name || category.name;
  category.description = req.body.description || category.description;
  category.enabled = req.body.enabled !== undefined ? req.body.enabled : category.enabled;
  category.displayOrder = req.body.displayOrder !== undefined ? req.body.displayOrder : category.displayOrder;

  data.settings.packageCategories[categoryIndex] = category;
  writeData(data);

  res.json({ success: true, category });
});

// Service API endpoints
app.get('/api/services', (req, res) => {
  const data = readData();
  const activeServices = (data.services || []).filter(s => s.active).sort((a, b) => a.displayOrder - b.displayOrder);
  res.json(activeServices);
});

app.get('/api/services/featured', (req, res) => {
  const data = readData();
  const featuredServices = (data.services || [])
    .filter(s => s.active && s.featured)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  res.json(featuredServices);
});

app.get('/api/services/category/:category', (req, res) => {
  const data = readData();
  const categoryServices = (data.services || [])
    .filter(s => s.active && s.category.toLowerCase() === req.params.category.toLowerCase())
    .sort((a, b) => a.displayOrder - b.displayOrder);
  res.json(categoryServices);
});

app.get('/api/admin/services', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.services || []);
});

app.post('/api/admin/services', requireAdmin, (req, res) => {
  const data = readData();

  const newService = {
    id: 'service-' + Date.now().toString(),
    name: req.body.name,
    slug: req.body.slug,
    shortDescription: req.body.shortDescription,
    description: req.body.description,
    category: req.body.category,
    thumbnail: req.body.thumbnail || '',
    ctaText: req.body.ctaText || 'Learn More',
    ctaLink: req.body.ctaLink || '#project-start',
    displayOrder: parseInt(req.body.displayOrder) || 1,
    active: req.body.active !== false,
    featured: req.body.featured === true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (!data.services) {
    data.services = [];
  }

  data.services.push(newService);
  writeData(data);

  res.json({ success: true, service: newService });
});

app.put('/api/admin/services/:id', requireAdmin, (req, res) => {
  const data = readData();
  const serviceIndex = data.services.findIndex(s => s.id === req.params.id);

  if (serviceIndex === -1) {
    return res.status(404).json({ error: 'Service not found' });
  }

  const service = data.services[serviceIndex];

  service.name = req.body.name || service.name;
  service.slug = req.body.slug || service.slug;
  service.shortDescription = req.body.shortDescription || service.shortDescription;
  service.description = req.body.description || service.description;
  service.category = req.body.category || service.category;
  service.thumbnail = req.body.thumbnail || service.thumbnail;
  service.ctaText = req.body.ctaText || service.ctaText;
  service.ctaLink = req.body.ctaLink || service.ctaLink;
  service.displayOrder = req.body.displayOrder ? parseInt(req.body.displayOrder) : service.displayOrder;
  service.active = req.body.active !== undefined ? req.body.active : service.active;
  service.featured = req.body.featured !== undefined ? req.body.featured : service.featured;
  service.updatedAt = new Date().toISOString();

  data.services[serviceIndex] = service;
  writeData(data);

  res.json({ success: true, service });
});

app.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
  const data = readData();
  const serviceIndex = data.services.findIndex(s => s.id === req.params.id);

  if (serviceIndex === -1) {
    return res.status(404).json({ error: 'Service not found' });
  }

  data.services.splice(serviceIndex, 1);
  writeData(data);

  res.json({ success: true });
});

// Service Category Management APIs
app.get('/api/admin/service-categories', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.settings.serviceCategories || []);
});

app.put('/api/admin/service-categories/reorder', requireAdmin, (req, res) => {
  const data = readData();
  const { categoryIds } = req.body;

  if (!Array.isArray(categoryIds)) {
    return res.status(400).json({ error: 'Invalid category IDs' });
  }

  if (!data.settings.serviceCategories) {
    return res.status(404).json({ error: 'Service categories not found' });
  }

  const reorderedCategories = [];
  categoryIds.forEach((id, index) => {
    const category = data.settings.serviceCategories.find(c => c.id === id);
    if (category) {
      category.displayOrder = index + 1;
      reorderedCategories.push(category);
    }
  });

  data.settings.serviceCategories.forEach(category => {
    if (!categoryIds.includes(category.id)) {
      reorderedCategories.push(category);
    }
  });

  data.settings.serviceCategories = reorderedCategories;
  writeData(data);

  res.json({ success: true, categories: reorderedCategories });
});

app.put('/api/admin/service-categories/:id', requireAdmin, (req, res) => {
  const data = readData();

  if (!data.settings.serviceCategories) {
    return res.status(404).json({ error: 'Service categories not found' });
  }

  const categoryIndex = data.settings.serviceCategories.findIndex(c => c.id === req.params.id);

  if (categoryIndex === -1) {
    return res.status(404).json({ error: 'Service category not found' });
  }

  const category = data.settings.serviceCategories[categoryIndex];

  category.name = req.body.name || category.name;
  category.description = req.body.description || category.description;
  category.enabled = req.body.enabled !== undefined ? req.body.enabled : category.enabled;
  category.displayOrder = req.body.displayOrder !== undefined ? req.body.displayOrder : category.displayOrder;

  data.settings.serviceCategories[categoryIndex] = category;
  writeData(data);

  res.json({ success: true, category });
});

// Demo Websites API endpoints
app.get('/api/demo-websites', (req, res) => {
  const data = readData();
  const demoWebsites = data.demoWebsites || [];
  const publishedDemos = demoWebsites.filter(d => d.published).sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(publishedDemos);
});

app.get('/api/demo-websites/featured', (req, res) => {
  const data = readData();
  const demoWebsites = data.demoWebsites || [];
  const featuredDemos = demoWebsites
    .filter(d => d.published && d.featured)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(featuredDemos);
});

app.get('/api/demo-websites/category/:category', (req, res) => {
  const data = readData();
  const demoWebsites = data.demoWebsites || [];
  const categoryDemos = demoWebsites
    .filter(d => d.published && d.category.toLowerCase() === req.params.category.toLowerCase())
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(categoryDemos);
});

app.get('/api/demo-websites/:slug', (req, res) => {
  const data = readData();
  const demoWebsites = data.demoWebsites || [];
  const demo = demoWebsites.find(d => d.slug === req.params.slug && d.published);
  
  if (!demo) {
    return res.status(404).json({ error: 'Demo website not found' });
  }
  
  res.json(demo);
});

// Admin Demo Websites endpoints
app.get('/api/admin/demo-websites', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.demoWebsites || []);
});

app.post('/api/admin/demo-websites', requireAdmin, upload.fields([
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  const data = readData();

  if (!data.demoWebsites) {
    data.demoWebsites = [];
  }

  // Upload thumbnail to Blob if configured
  const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
  let thumbnailBlob = null;

  if (USE_BLOB_STORAGE && thumbnailFile) {
    thumbnailBlob = await uploadToBlob(thumbnailFile, 'thumbnails');
  }

  const newDemo = {
    id: 'demo-' + Date.now().toString(),
    name: req.body.name,
    slug: req.body.slug,
    category: req.body.category,
    description: req.body.description,
    thumbnail: thumbnailFile ? fileUrl(thumbnailBlob || thumbnailFile) : '',
    demoUrl: req.body.demoUrl || '',
    featured: req.body.featured === 'true',
    published: req.body.published === 'true',
    status: req.body.status || '',
    sortOrder: parseInt(req.body.sortOrder) || 0,
    createdAt: new Date().toISOString()
  };

  data.demoWebsites.push(newDemo);
  writeData(data);

  res.json({ success: true, demo: newDemo });
});

app.put('/api/admin/demo-websites/:id', requireAdmin, upload.fields([
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  const data = readData();

  if (!data.demoWebsites) {
    return res.status(404).json({ error: 'Demo website not found' });
  }

  const demoIndex = data.demoWebsites.findIndex(d => d.id === req.params.id);

  if (demoIndex === -1) {
    return res.status(404).json({ error: 'Demo website not found' });
  }

  const demo = data.demoWebsites[demoIndex];

  // Update fields
  demo.name = req.body.name || demo.name;
  demo.slug = req.body.slug || demo.slug;
  demo.category = req.body.category || demo.category;
  demo.description = req.body.description || demo.description;
  demo.demoUrl = req.body.demoUrl || demo.demoUrl;
  demo.featured = toBool(req.body.featured, demo.featured);
  demo.published = toBool(req.body.published, demo.published);
  demo.status = req.body.status || demo.status;
  demo.sortOrder = req.body.sortOrder ? parseInt(req.body.sortOrder) : demo.sortOrder;

  // Upload thumbnail to Blob if configured
  const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
  let thumbnailBlob = null;

  if (USE_BLOB_STORAGE && thumbnailFile) {
    thumbnailBlob = await uploadToBlob(thumbnailFile, 'thumbnails');
  }

  data.demoWebsites[demoIndex] = demo;
  writeData(data);

  res.json({ success: true, demo });
});

app.delete('/api/admin/demo-websites/:id', requireAdmin, (req, res) => {
  const data = readData();
  
  if (!data.demoWebsites) {
    return res.status(404).json({ error: 'Demo website not found' });
  }
  
  const demoIndex = data.demoWebsites.findIndex(d => d.id === req.params.id);
  
  if (demoIndex === -1) {
    return res.status(404).json({ error: 'Demo website not found' });
  }
  
  data.demoWebsites.splice(demoIndex, 1);
  writeData(data);
  
  res.json({ success: true });
});

// AI Agents API endpoints
app.get('/api/ai-agents', (req, res) => {
  const data = readData();
  const aiAgents = data.aiAgents || [];
  const publishedAgents = aiAgents.filter(a => a.published).sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(publishedAgents);
});

app.get('/api/ai-agents/featured', (req, res) => {
  const data = readData();
  const aiAgents = data.aiAgents || [];
  const featuredAgents = aiAgents
    .filter(a => a.published && a.featured)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(featuredAgents);
});

app.get('/api/ai-agents/category/:category', (req, res) => {
  const data = readData();
  const aiAgents = data.aiAgents || [];
  const categoryAgents = aiAgents
    .filter(a => a.published && a.category.toLowerCase() === req.params.category.toLowerCase())
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json(categoryAgents);
});

app.get('/api/ai-agents/:slug', (req, res) => {
  const data = readData();
  const aiAgents = data.aiAgents || [];
  const agent = aiAgents.find(a => a.slug === req.params.slug && a.published);
  
  if (!agent) {
    return res.status(404).json({ error: 'AI agent not found' });
  }
  
  res.json(agent);
});

// Admin AI Agents endpoints
app.get('/api/admin/ai-agents', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data.aiAgents || []);
});

app.post('/api/admin/ai-agents', requireAdmin, upload.fields([
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  const data = readData();

  if (!data.aiAgents) {
    data.aiAgents = [];
  }

  // Upload thumbnail to Blob if configured
  const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
  let thumbnailBlob = null;

  if (USE_BLOB_STORAGE && thumbnailFile) {
    thumbnailBlob = await uploadToBlob(thumbnailFile, 'thumbnails');
  }

  const newAgent = {
    id: 'agent-' + Date.now().toString(),
    name: req.body.name,
    slug: req.body.slug,
    category: req.body.category,
    shortDescription: req.body.shortDescription,
    description: req.body.description,
    thumbnail: thumbnailFile ? fileUrl(thumbnailBlob || thumbnailFile) : '',
    demoUrl: req.body.demoUrl || '',
    features: req.body.features ? JSON.parse(req.body.features) : [],
    useCases: req.body.useCases ? JSON.parse(req.body.useCases) : [],
    status: req.body.status || '',
    featured: req.body.featured === 'true',
    published: req.body.published === 'true',
    sortOrder: parseInt(req.body.sortOrder) || 0,
    createdAt: new Date().toISOString()
  };

  data.aiAgents.push(newAgent);
  writeData(data);

  res.json({ success: true, agent: newAgent });
});

app.put('/api/admin/ai-agents/:id', requireAdmin, upload.fields([
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  const data = readData();

  if (!data.aiAgents) {
    return res.status(404).json({ error: 'AI agent not found' });
  }

  const agentIndex = data.aiAgents.findIndex(a => a.id === req.params.id);

  if (agentIndex === -1) {
    return res.status(404).json({ error: 'AI agent not found' });
  }

  const agent = data.aiAgents[agentIndex];

  // Update fields
  agent.name = req.body.name || agent.name;
  agent.slug = req.body.slug || agent.slug;
  agent.category = req.body.category || agent.category;
  agent.shortDescription = req.body.shortDescription || agent.shortDescription;
  agent.description = req.body.description || agent.description;
  agent.demoUrl = req.body.demoUrl || agent.demoUrl;
  agent.status = req.body.status || agent.status;
  agent.featured = toBool(req.body.featured, agent.featured);
  agent.published = toBool(req.body.published, agent.published);
  agent.sortOrder = req.body.sortOrder ? parseInt(req.body.sortOrder) : agent.sortOrder;

  // Update features and use cases if provided
  if (req.body.features) {
    agent.features = JSON.parse(req.body.features);
  }
  if (req.body.useCases) {
    agent.useCases = JSON.parse(req.body.useCases);
  }

  // Update thumbnail if provided
  const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;
  let thumbnailBlob = null;

  if (USE_BLOB_STORAGE && thumbnailFile) {
    thumbnailBlob = await uploadToBlob(thumbnailFile, 'thumbnails');
  }

  if (thumbnailFile) {
    agent.thumbnail = fileUrl(thumbnailBlob || thumbnailFile);
  }

  data.aiAgents[agentIndex] = agent;
  writeData(data);

  res.json({ success: true, agent });
});

app.delete('/api/admin/ai-agents/:id', requireAdmin, (req, res) => {
  const data = readData();
  
  if (!data.aiAgents) {
    return res.status(404).json({ error: 'AI agent not found' });
  }
  
  const agentIndex = data.aiAgents.findIndex(a => a.id === req.params.id);
  
  if (agentIndex === -1) {
    return res.status(404).json({ error: 'AI agent not found' });
  }
  
  data.aiAgents.splice(agentIndex, 1);
  writeData(data);
  
  res.json({ success: true });
});

// 404 handling. Without this, an unknown /api/* path returns Express's default
// HTML "Cannot GET ..." page, which breaks any client doing response.json().
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Any other unknown path falls back to the single-page site so deep links and
// mistyped URLs land on the homepage instead of a bare error page.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  sendPublicFile(res, next, 'index.html', 404);
});

// Centralized error handler — keeps API responses JSON instead of Express's
// default HTML stack-trace page, and gives a clear message for the
// read-only-filesystem case that happens on serverless hosts.
app.use((err, req, res, next) => {
  if (!err) return next();

  // Malformed / oversized JSON bodies are the client's fault, not a 500 — and
  // not worth a stack trace in the logs.
  if (err.type !== 'entity.parse.failed' && err.type !== 'entity.too.large') console.error(err);

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  if (err.isReadOnlyStorage) {
    return res.status(503).json({
      error: IS_SERVERLESS
        ? STORAGE_NOT_CONFIGURED_MESSAGE
        : 'This deployment cannot save changes (read-only storage). Deploy to a host with a persistent disk (e.g. Railway, Render, a VPS) or connect a database, then try again.'
    });
  }
  if (err.isStorageError) {
    return res.status(err.status || 503).json({
      error: err.publicMessage || (err.status === 409
        ? 'Someone else changed this at the same time. Please refresh and try again.'
        : 'Storage is temporarily unavailable. Please try again in a moment.')
    });
  }
  if (err.code === 'EROFS' || err.code === 'EACCES') {
    return res.status(503).json({ error: IS_SERVERLESS ? BLOB_NOT_CONFIGURED_MESSAGE : 'The server cannot write to its disk.' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message && (err.message.includes('Only JPEG') || err.message.includes('Only PDF'))) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Export Express app for Vercel
module.exports = app;

// Start server with error handling (only for local development)
if (require.main === module) {
  async function startServer() {
    const portInUse = await isPortInUse(PORT);
    
    if (portInUse) {
      console.error(`Port ${PORT} is already in use. Please stop the existing server or use a different port.`);
      console.error('You can:');
      console.error('1. Stop the existing server: Ctrl+C in the terminal where it\'s running');
      console.error('2. Use a different port: PORT=3001 npm start');
      process.exit(1);
    }
    
    const server = app.listen(PORT, () => {
      console.log(`PhoenixAI Studio server running on port ${PORT}`);
      console.log(`Public site: http://localhost:${PORT}`);
      console.log(`Admin portal: http://localhost:${PORT}/admin`);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Please stop the existing server or use a different port.`);
        console.error('You can:');
        console.error('1. Stop the existing server: Ctrl+C in the terminal where it\'s running');
        console.error('2. Use a different port: PORT=3001 npm start');
        process.exit(1);
      } else {
        console.error('Server error:', err);
        process.exit(1);
      }
    });
  }

  startServer();
}