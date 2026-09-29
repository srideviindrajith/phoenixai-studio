// Integration tests: the REAL Express app, real HTTP requests, mock Upstash + mock Blob.
// Covers what the public site is allowed to show (disabled categories, ordering),
// admin sessions (password change / recovery), and item thumbnails.
// Run with:  npm test      (Node 18.14+; no extra dependencies)
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createMockUpstash } = require('./mock-upstash');
const { createMockBlob } = require('./mock-blob');

const PASSWORD = 'test-password-123';
const SECRET = 'test-secret-value';
const ENV_KEYS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'BLOB_READ_WRITE_TOKEN', 'VERCEL_BLOB_API_URL', 'VERCEL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'NODE_ENV',
  'DATA_FILE', 'ADMIN_RECOVERY_CODE', 'RESEND_API_KEY', 'NOTIFY_EMAIL', 'RESEND_FROM', 'RESEND_API_URL'];

async function startApp(env = {}) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: SECRET, ...env });
  const modulePath = require.resolve('../server.js');
  delete require.cache[modulePath];
  const app = require(modulePath);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const restore = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  return { base, close: () => new Promise((r) => server.close(() => { restore(); r(); })) };
}

// Turns the Set-Cookie headers of a response into a { cookie, csrf } session.
function sessionFrom(res) {
  const list = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrfPair = list.find((c) => c.startsWith('phx_csrf='));
  return { cookie: list.join('; '), csrf: csrfPair ? csrfPair.split('=')[1] : null };
}

async function login(base, password = PASSWORD) {
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  return { status: res.status, session: res.status === 200 ? sessionFrom(res) : null };
}

async function loggedIn(base) {
  const { status, session } = await login(base);
  assert.equal(status, 200, 'login should succeed');
  return session;
}

const call = (base, session, method, url, body) => fetch(base + url, {
  method,
  headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined
});

// A cookie exactly like the ones issued before session versions existed (no `v` field).
function legacyCookie() {
  const csrf = 'legacy-csrf-token';
  const payload = Buffer.from(JSON.stringify({ isAdmin: true, exp: Date.now() + 3600000, csrf })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return { cookie: `phx_admin=${payload}.${sig}; phx_csrf=${csrf}`, csrf };
}

const getJson = async (base, url) => (await fetch(base + url)).json();
const pageTitle = async (base, cookie) => {
  const text = await (await fetch(base + '/admin', { headers: cookie ? { cookie } : {} })).text();
  return (text.match(/<title>([^<]*)<\/title>/) || [])[1];
};

describe('Public site: disabled categories and ordering', () => {
  let redis, redisUrl;
  before(async () => { redis = createMockUpstash(); redisUrl = await redis.start(); });
  after(async () => { await redis.stop(); });
  const env = () => ({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token' });
  const reset = () => { redis.store.clear(); redis.state.calls.length = 0; };

  test('a disabled package category disappears from EVERY public endpoint and returns when re-enabled', async () => {
    reset();
    const app = await startApp(env());
    try {
      const s = await loggedIn(app.base);
      const inCategory = (arr) => arr.filter((p) => p.category === 'career-builder');

      let boot = await getJson(app.base, '/api/public/bootstrap');
      assert.ok(inCategory(boot.packages).length > 0, 'precondition: sample packages exist in career-builder');
      assert.ok(boot.packageCategories.some((c) => c.id === 'career-builder'), 'precondition: category listed');

      assert.equal((await call(app.base, s, 'PUT', '/api/admin/package-categories/career-builder', { enabled: false })).status, 200);

      boot = await getJson(app.base, '/api/public/bootstrap');
      assert.equal(inCategory(boot.packages).length, 0, 'bootstrap must not return packages of a disabled category');
      assert.ok(!boot.packageCategories.some((c) => c.id === 'career-builder'), 'bootstrap must not list a disabled category');
      assert.equal(inCategory(await getJson(app.base, '/api/packages')).length, 0);
      assert.ok(!(await getJson(app.base, '/api/package-categories')).some((c) => c.id === 'career-builder'));
      const featured = await getJson(app.base, '/api/packages/featured');
      assert.ok(!featured || featured.category !== 'career-builder', 'featured package must not come from a disabled category');

      assert.equal((await call(app.base, s, 'PUT', '/api/admin/package-categories/career-builder', { enabled: true })).status, 200);
      boot = await getJson(app.base, '/api/public/bootstrap');
      assert.ok(inCategory(boot.packages).length > 0, 're-enabled category shows its packages again');
      assert.ok(boot.packageCategories.some((c) => c.id === 'career-builder'));
    } finally { await app.close(); }
  });

  test('a disabled service category hides its services everywhere', async () => {
    reset();
    const app = await startApp(env());
    try {
      const s = await loggedIn(app.base);
      const make = async (name, category, featured) => {
        const r = await call(app.base, s, 'POST', '/api/admin/services', { name, slug: name, shortDescription: 's', description: 'd', category, featured, active: true, displayOrder: 1 });
        assert.equal(r.status, 200);
        return (await r.json()).service;
      };
      const web = await make('web-svc', 'website-services', true);
      await new Promise((r) => setTimeout(r, 5)); // ids are timestamp based
      const ai = await make('ai-svc', 'ai-agent-services', false);

      let boot = await getJson(app.base, '/api/public/bootstrap');
      assert.deepEqual(boot.services.map((x) => x.id).sort(), [web.id, ai.id].sort());

      assert.equal((await call(app.base, s, 'PUT', '/api/admin/service-categories/website-services', { enabled: false })).status, 200);

      boot = await getJson(app.base, '/api/public/bootstrap');
      assert.deepEqual(boot.services.map((x) => x.id), [ai.id]);
      assert.deepEqual((await getJson(app.base, '/api/services')).map((x) => x.id), [ai.id]);
      assert.deepEqual(await getJson(app.base, '/api/services/featured'), [], 'featured service of a disabled category is hidden');
      assert.deepEqual(await getJson(app.base, '/api/services/category/website-services'), []);
    } finally { await app.close(); }
  });

  test('admin ordering (category order, package sortOrder, service displayOrder) reaches the public site', async () => {
    reset();
    const app = await startApp(env());
    try {
      const s = await loggedIn(app.base);

      // categories: reverse them
      const cats = (await getJson(app.base, '/api/public/bootstrap')).packageCategories.map((c) => c.id);
      const reversed = cats.slice().reverse();
      assert.equal((await call(app.base, s, 'PUT', '/api/admin/package-categories/reorder', { categoryIds: reversed })).status, 200);
      assert.deepEqual((await getJson(app.base, '/api/public/bootstrap')).packageCategories.map((c) => c.id), reversed);

      // packages: push the first one to the end
      const pkgs = (await getJson(app.base, '/api/public/bootstrap')).packages;
      assert.ok(pkgs.length >= 2);
      const first = pkgs[0];
      assert.equal((await call(app.base, s, 'PUT', `/api/admin/packages/${first.id}`, { sortOrder: 9999 })).status, 200);
      const after = (await getJson(app.base, '/api/public/bootstrap')).packages;
      assert.equal(after[after.length - 1].id, first.id, 'package with the highest sortOrder is shown last');

      // services: displayOrder 5 created first, displayOrder 1 second -> 1 must come first
      const make = async (name, displayOrder) => {
        const r = await call(app.base, s, 'POST', '/api/admin/services', { name, slug: name, shortDescription: 's', description: 'd', category: 'other', displayOrder, active: true });
        return (await r.json()).service.id;
      };
      const five = await make('five', 5);
      await new Promise((r) => setTimeout(r, 5));
      const one = await make('one', 1);
      assert.deepEqual((await getJson(app.base, '/api/public/bootstrap')).services.map((x) => x.id), [one, five]);
    } finally { await app.close(); }
  });
});

describe('Admin sessions', () => {
  let redis, redisUrl;
  before(async () => { redis = createMockUpstash(); redisUrl = await redis.start(); });
  after(async () => { await redis.stop(); });
  const env = (extra = {}) => ({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token', ...extra });
  const reset = () => { redis.store.clear(); redis.state.calls.length = 0; };

  test('changing the password signs out other sessions, keeps this browser signed in, and old cookies still work until then', async () => {
    reset();
    const app = await startApp(env());
    try {
      const legacy = legacyCookie();
      assert.equal((await call(app.base, legacy, 'GET', '/api/admin/modules')).status, 200, 'cookies issued before this change keep working');

      const a = await loggedIn(app.base);
      assert.equal((await call(app.base, a, 'GET', '/api/admin/modules')).status, 200);
      assert.equal(await pageTitle(app.base, a.cookie), 'Admin Dashboard - PhoenixAI Studio');

      const change = await call(app.base, a, 'POST', '/api/admin/change-password', { currentPassword: PASSWORD, newPassword: 'Brand-new-pass-1' });
      assert.equal(change.status, 200);
      const b = sessionFrom(change);
      assert.ok(b.cookie.includes('phx_admin='), 'the browser that changed the password gets a fresh cookie');

      assert.equal((await call(app.base, a, 'GET', '/api/admin/modules')).status, 401, 'old session is signed out');
      assert.equal((await call(app.base, legacy, 'GET', '/api/admin/modules')).status, 401, 'pre-change cookie is signed out');
      assert.equal((await call(app.base, b, 'GET', '/api/admin/modules')).status, 200, 'this browser stays signed in');
      assert.equal((await call(app.base, b, 'PUT', '/api/admin/modules/templates', { enabled: true })).status, 200, 'and can still make changes (fresh CSRF token works)');

      assert.equal(await pageTitle(app.base, a.cookie), 'Admin Login - PhoenixAI Studio', '/admin shows the login page for a signed-out cookie (no redirect loop)');
      assert.equal(await pageTitle(app.base, b.cookie), 'Admin Dashboard - PhoenixAI Studio');

      assert.equal((await login(app.base, PASSWORD)).status, 401, 'old password no longer works');
      assert.equal((await login(app.base, 'Brand-new-pass-1')).status, 200);
    } finally { await app.close(); }
  });

  test('password recovery: wrong code, weak password, success signs out every session, rate limit, unset code', async () => {
    reset();
    const app = await startApp(env({ ADMIN_RECOVERY_CODE: 'rc-123-secret' }));
    try {
      const post = (body) => fetch(app.base + '/api/admin/recover-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const existing = await loggedIn(app.base);

      assert.equal((await post({ recoveryCode: 'nope', newPassword: 'Recovered-pass-1' })).status, 401);
      assert.equal((await login(app.base)).status, 200, 'a wrong code changes nothing');
      assert.equal((await post({ recoveryCode: 'rc-123-secret', newPassword: 'short' })).status, 400);
      assert.equal((await post({ recoveryCode: '', newPassword: 'Recovered-pass-1' })).status, 400);

      assert.equal((await post({ recoveryCode: 'rc-123-secret', newPassword: 'Recovered-pass-1' })).status, 200);
      assert.equal((await call(app.base, existing, 'GET', '/api/admin/modules')).status, 401, 'recovery signs out existing sessions');
      assert.equal((await login(app.base, PASSWORD)).status, 401);
      assert.equal((await login(app.base, 'Recovered-pass-1')).status, 200);

      let last = 0;
      for (let i = 0; i < 15; i++) last = (await post({ recoveryCode: 'wrong-' + i, newPassword: 'Another-pass-1' })).status;
      assert.equal(last, 429, 'repeated guesses are rate limited');
    } finally { await app.close(); }

    const noCode = await startApp(env());
    try {
      const r = await fetch(noCode.base + '/api/admin/recover-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recoveryCode: 'anything', newPassword: 'Whatever-pass-1' }) });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /ADMIN_RECOVERY_CODE/);
      const health = await (await fetch(noCode.base + '/api/health')).json();
      assert.equal(health.passwordRecoveryConfigured, false);
    } finally { await noCode.close(); }
  });

  test('/admin falls back to the login page (not an error) when the session version cannot be read', async () => {
    reset();
    const app = await startApp(env());
    try {
      const s = await loggedIn(app.base);
      redis.state.failAlways = true;
      const res = await fetch(app.base + '/admin', { headers: { cookie: s.cookie } });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Admin Login/);
    } finally { redis.state.failAlways = false; await app.close(); }
  });
});

describe('Demo websites and AI agents: thumbnails never swap', () => {
  let redis, blob, redisUrl, blobUrl;
  before(async () => { redis = createMockUpstash(); redisUrl = await redis.start(); blob = createMockBlob(); blobUrl = await blob.start(); });
  after(async () => { await redis.stop(); await blob.stop(); });

  test('create A and B, edit A (text only, then with a new file): only A changes; demoUrl edits persist', async () => {
    redis.store.clear();
    const app = await startApp({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token', BLOB_READ_WRITE_TOKEN: 'b', VERCEL_BLOB_API_URL: blobUrl });
    try {
      const s = await loggedIn(app.base);
      const headers = { cookie: s.cookie, 'x-csrf-token': s.csrf };
      const image = (fill) => new Blob([Buffer.alloc(600, fill)], { type: 'image/png' });

      for (const [kind, path, key] of [['demo website', '/api/admin/demo-websites', 'demo'], ['AI agent', '/api/admin/ai-agents', 'agent']]) {
        const create = async (name, fill) => {
          const fd = new FormData();
          for (const [k, v] of Object.entries({ name, slug: name.replace(/\s/g, '-'), category: 'x', description: 'd', published: 'true', featured: 'false', status: 'Active', sortOrder: '1', demoUrl: 'https://old.test' })) fd.append(k, v);
          fd.append('thumbnail', image(fill), name + '.png');
          const r = await fetch(app.base + path, { method: 'POST', headers, body: fd });
          assert.equal(r.status, 200, `${kind} create: ` + await r.clone().text());
          return (await r.json())[key];
        };
        const list = async () => (await fetch(app.base + path, { headers })).json();
        const put = (id, fields, file) => {
          const fd = new FormData();
          for (const [k, v] of Object.entries(fields)) fd.append(k, v);
          if (file) fd.append('thumbnail', file, 'new.png');
          return fetch(`${app.base}${path}/${id}`, { method: 'PUT', headers, body: fd });
        };

        const A = await create(`${kind} A`, 1);
        await new Promise((r) => setTimeout(r, 5));
        const B = await create(`${kind} B`, 2);
        assert.notEqual(A.thumbnail, B.thumbnail, `${kind}: different uploads get different thumbnails`);

        assert.equal((await put(A.id, { name: `${kind} A edited` })).status, 200);
        let items = await list();
        assert.equal(items.find((x) => x.id === A.id).thumbnail, A.thumbnail, `${kind}: a text-only edit keeps the thumbnail`);
        assert.equal(items.find((x) => x.id === B.id).thumbnail, B.thumbnail);

        assert.equal((await put(A.id, { name: `${kind} A v3` }, image(9))).status, 200);
        items = await list();
        assert.notEqual(items.find((x) => x.id === A.id).thumbnail, A.thumbnail, `${kind}: a new file replaces the thumbnail`);
        assert.equal(items.find((x) => x.id === B.id).thumbnail, B.thumbnail, `${kind}: the other item is untouched`);

        assert.equal((await put(A.id, { demoUrl: 'https://changed.test' })).status, 200);
        assert.equal((await list()).find((x) => x.id === A.id).demoUrl, 'https://changed.test', `${kind}: demoUrl edit persists`);
      }
    } finally { await app.close(); }
  });
});

describe('Email alert on a new inquiry (Resend)', () => {
  function createMockResend() {
    const state = { calls: [], fail: false };
    const http = require('http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.calls.push({ authorization: req.headers.authorization, body: JSON.parse(body || '{}') });
        if (state.fail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'simulated failure' })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'email-123' }));
      });
    });
    return {
      state,
      start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
      stop: () => new Promise((r) => server.close(r))
    };
  }

  test('a submitted inquiry triggers exactly one email with the right content, to the configured address', async () => {
    const redis = createMockUpstash(); const redisUrl = await redis.start();
    const resend = createMockResend(); const resendUrl = await resend.start();
    const app = await startApp({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token', RESEND_API_KEY: 're_test_123', NOTIFY_EMAIL: 'owner@example.com', RESEND_API_URL: resendUrl });
    try {
      const r = await fetch(app.base + '/api/admin/inquiries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Jane Visitor', email: 'jane@example.com', phone: '123', subject: 'Pricing question', message: 'How much for a website?' })
      });
      assert.equal(r.status, 200);
      // the email is sent after the response, so give the event loop a turn
      await new Promise((res) => setTimeout(res, 50));

      assert.equal(resend.state.calls.length, 1, 'exactly one email should be sent');
      const call = resend.state.calls[0];
      assert.equal(call.authorization, 'Bearer re_test_123');
      assert.deepEqual(call.body.to, ['owner@example.com']);
      assert.equal(call.body.reply_to, 'jane@example.com');
      assert.match(call.body.subject, /Pricing question/);
      assert.match(call.body.html, /Jane Visitor/);
      assert.match(call.body.html, /How much for a website\?/);

      const health = await (await fetch(app.base + '/api/health')).json();
      assert.equal(health.emailAlertsConfigured, true);
    } finally { await app.close(); await redis.stop(); await resend.stop(); }
  });

  test('an inquiry still succeeds, with no email call, when RESEND_API_KEY/NOTIFY_EMAIL are not set', async () => {
    const redis = createMockUpstash(); const redisUrl = await redis.start();
    const resend = createMockResend(); const resendUrl = await resend.start();
    const app = await startApp({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token', RESEND_API_URL: resendUrl });
    try {
      const r = await fetch(app.base + '/api/admin/inquiries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Email Config', email: 'x@example.com', message: 'test' })
      });
      assert.equal(r.status, 200);
      await new Promise((res) => setTimeout(res, 50));
      assert.equal(resend.state.calls.length, 0, 'no email attempted when not configured');

      const health = await (await fetch(app.base + '/api/health')).json();
      assert.equal(health.emailAlertsConfigured, false);
      assert.equal(health.ok, true, 'missing optional email config must not mark the site unhealthy');
    } finally { await app.close(); await redis.stop(); await resend.stop(); }
  });

  test('the inquiry still succeeds even if the email provider fails or is unreachable', async () => {
    const redis = createMockUpstash(); const redisUrl = await redis.start();
    const resend = createMockResend(); resend.state.fail = true; const resendUrl = await resend.start();
    const app = await startApp({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token', RESEND_API_KEY: 're_test_123', NOTIFY_EMAIL: 'owner@example.com', RESEND_API_URL: resendUrl });
    try {
      let r = await fetch(app.base + '/api/admin/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A', email: 'a@example.com', message: 'test' }) });
      assert.equal(r.status, 200, 'a failing email provider must not fail the visitor request');
      await new Promise((res) => setTimeout(res, 50));
      assert.equal(resend.state.calls.length, 1, 'the attempt was made');

      await resend.stop(); // now unreachable entirely
      r = await fetch(app.base + '/api/admin/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'B', email: 'b@example.com', message: 'test' }) });
      assert.equal(r.status, 200, 'an unreachable email provider must not fail the visitor request either');
      await new Promise((res) => setTimeout(res, 50));

      const s = await loggedIn(app.base);
      const inquiries = await (await call(app.base, s, 'GET', '/api/admin/inquiries')).json();
      assert.ok(inquiries.some((x) => x.name === 'A') && inquiries.some((x) => x.name === 'B'), 'both inquiries were saved regardless of email outcome');
    } finally { await app.close(); await redis.stop(); }
  });
});
