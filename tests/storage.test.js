// Integration tests: the REAL Express app, real HTTP requests, mock Upstash + mock Blob servers.
// Run with:  npm test      (Node 18+, no extra dependencies)
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockUpstash } = require('./mock-upstash');
const { createMockBlob } = require('./mock-blob');

const PASSWORD = 'test-password-123';
const ENV_KEYS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'BLOB_READ_WRITE_TOKEN', 'VERCEL_BLOB_API_URL', 'VERCEL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'NODE_ENV', 'DATA_FILE'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Loads a fresh copy of server.js with the given environment and starts it on a random port.
async function startApp(env = {}) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'test-secret-value', ...env });
  const modulePath = require.resolve('../server.js');
  delete require.cache[modulePath];
  const app = require(modulePath);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const restore = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  return { base, close: () => new Promise((r) => server.close(() => { restore(); r(); })) };
}

async function login(base) {
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(res.status, 200, 'login should succeed');
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('phx_csrf=')).split('=')[1];
  const cookie = cookies.join('; ');
  const api = (method, url, body) => fetch(base + url, {
    method,
    headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { cookie, csrf, api };
}

const oldFormatData = () => ({
  templates: [], inquiries: [], demoWebsites: [], leads: [], notifications: [],
  packages: [
    { id: 'pkg-a', name: 'A', category: 'career-builder', price: 1, published: true, featured: false, sortOrder: 1 },
    { id: 'pkg-b', name: 'B', category: 'career-builder', price: 2, published: true, featured: false, sortOrder: 2 }
  ],
  aiAgents: [{ id: 'agent-x', name: 'X', slug: 'x', published: true, sortOrder: 1 }],
  serviceCategories: [{ id: 'other', name: 'Other', enabled: true, displayOrder: 1 }], // stray top-level key from old data.json
  settings: { logo: '', adminPassword: PASSWORD, // legacy plain-text password (upgraded to a hash on first login)
    modules: [{ id: 'overview', name: 'Overview', enabled: true, displayOrder: 1 }] }
});

describe('Redis mode', () => {
  let redis, redisUrl, blob, blobUrl;
  before(async () => { redis = createMockUpstash(); redisUrl = await redis.start(); blob = createMockBlob(); blobUrl = await blob.start(); });
  after(async () => { await redis.stop(); await blob.stop(); });
  const reset = () => { redis.store.clear(); redis.state.calls.length = 0; redis.state.failNext = 0; redis.state.failAlways = false; redis.state.failCommands.clear(); redis.state.hasEval = true; redis.state.evalConflictsToForce = 0; redis.state.gate = null; blob.state.puts.length = 0; blob.state.deletes.length = 0; blob.state.failPut = false; };
  const env = (extra = {}) => ({ KV_REST_API_URL: redisUrl, KV_REST_API_TOKEN: 'test-token', ...extra });

  test('empty Redis: defaults + migrations are created once (modules, services module, 6 service categories)', async () => {
    reset();
    const app = await startApp(env());
    try {
      const modules = await (await fetch(app.base + '/api/modules')).json();
      const ids = modules.map((m) => m.id);
      for (const id of ['overview', 'templates', 'packages', 'services', 'leads', 'inquiries', 'settings']) assert.ok(ids.includes(id), `module ${id} missing`);
      const stored = redis.get('phoenixai:data');
      assert.equal(stored._rev, 1);
      assert.equal(stored.settings.serviceCategories.length, 6);
      assert.ok(stored.settings.adminPassword.startsWith('scrypt$'));
      const before = redis.state.calls.filter((c) => c === 'EVAL' || c === 'SET').length;
      await fetch(app.base + '/api/modules');
      assert.equal(redis.state.calls.filter((c) => c === 'EVAL' || c === 'SET').length, before, 'second request must not write again');
    } finally { await app.close(); }
  });

  test('old-format data is migrated on the first admin request and persisted', async () => {
    reset();
    redis.put('phoenixai:data', oldFormatData());
    const app = await startApp(env());
    try {
      const { api } = await login(app.base); // also upgrades the legacy plain-text password
      const modules = await (await api('GET', '/api/admin/modules')).json();
      assert.ok(modules.some((m) => m.id === 'services'), 'services module must exist');
      const settings = await (await api('GET', '/api/admin/settings')).json();
      assert.equal(settings.serviceCategories.length, 1, 'stray top-level serviceCategories moved into settings');
      const stored = redis.get('phoenixai:data');
      assert.equal(stored.serviceCategories, undefined);
      assert.ok(stored.settings.adminPassword.startsWith('scrypt$'), 'legacy password upgraded to a hash');
      assert.equal(stored.packages.length, 2, 'existing packages untouched');
      assert.ok(stored.modules === undefined);
    } finally { await app.close(); }
  });

  test('module and category toggles persist and reach the public API', async () => {
    reset();
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      let r = await api('PUT', '/api/admin/modules/templates', { enabled: false });
      assert.equal(r.status, 200);
      assert.equal(redis.get('phoenixai:data').settings.modules.find((m) => m.id === 'templates').enabled, false);
      const pub = await (await fetch(app.base + '/api/modules')).json();
      assert.ok(!pub.some((m) => m.id === 'templates'));

      r = await api('PUT', '/api/admin/package-categories/career-builder', { enabled: false });
      assert.equal(r.status, 200);
      r = await api('PUT', '/api/admin/service-categories/other', { enabled: false });
      assert.equal(r.status, 200);
      const stored = redis.get('phoenixai:data');
      assert.equal(stored.settings.packageCategories.find((c) => c.id === 'career-builder').enabled, false);
      assert.equal(stored.settings.serviceCategories.find((c) => c.id === 'other').enabled, false);

      const ids = stored.settings.modules.map((m) => m.id).reverse();
      r = await api('PUT', '/api/admin/modules/reorder', { moduleIds: ids });
      assert.equal(r.status, 200, 'reorder must not be swallowed by /:id');
    } finally { await app.close(); }
  });

  test('deleting the last package does not bring the sample packages back', async () => {
    reset();
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      const pkgs = await (await api('GET', '/api/admin/packages')).json();
      assert.ok(pkgs.length > 0, 'samples are seeded once');
      for (const p of pkgs) assert.equal((await api('DELETE', `/api/admin/packages/${p.id}`)).status, 200);
      assert.equal((await (await api('GET', '/api/admin/packages')).json()).length, 0);
      assert.equal((await (await fetch(app.base + '/api/packages')).json()).length, 0);
    } finally { await app.close(); }
  });

  test('Redis unreachable on load: 503 JSON, nothing is overwritten with defaults', async () => {
    reset();
    redis.put('phoenixai:data', { ...oldFormatData(), _rev: 5 });
    const app = await startApp(env());
    try {
      redis.state.failAlways = true;
      const r = await fetch(app.base + '/api/modules');
      assert.equal(r.status, 503);
      assert.ok((await r.json()).error);
      assert.ok(!redis.state.calls.some((c) => c === 'SET' || c === 'EVAL'), 'must not write anything');
      redis.state.failAlways = false;
      assert.equal(redis.get('phoenixai:data')._rev, 5, 'stored data intact');
    } finally { await app.close(); }
  });

  test('save failure: 500 JSON error and stored data unchanged', async () => {
    reset();
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      const before = JSON.stringify(redis.get('phoenixai:data'));
      redis.state.failCommands.add('EVAL');
      const r = await api('PUT', '/api/admin/modules/templates', { enabled: false });
      assert.equal(r.status, 500);
      assert.match((await r.json()).error, /could not save/i);
      redis.state.failCommands.clear();
      assert.equal(JSON.stringify(redis.get('phoenixai:data')), before);
      // and the next attempt works, with no duplicates
      assert.equal((await api('PUT', '/api/admin/modules/templates', { enabled: false })).status, 200);
    } finally { await app.close(); }
  });

  test('retries exhausted: 409 JSON and stored data unchanged', async () => {
    reset();
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      const before = JSON.stringify(redis.get('phoenixai:data'));
      redis.state.evalConflictsToForce = 100;
      const r = await api('PUT', '/api/admin/modules/templates', { enabled: false });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /same time/i);
      assert.equal(JSON.stringify(redis.get('phoenixai:data')), before);
    } finally { await app.close(); }
  });

  test('EVAL unavailable: falls back to plain SET and still saves', async () => {
    reset();
    redis.state.hasEval = false;
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      assert.equal((await api('PUT', '/api/admin/modules/templates', { enabled: false })).status, 200);
      assert.equal(redis.get('phoenixai:data').settings.modules.find((m) => m.id === 'templates').enabled, false);
    } finally { await app.close(); }
  });

  test('50 rounds of 4 concurrent operations: every change survives, nothing is duplicated', async () => {
    reset();
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      const pkgs = await (await api('GET', '/api/admin/packages')).json();
      const pkgId = pkgs[0].id;
      // seed one inquiry to edit
      await fetch(app.base + '/api/admin/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Seed', email: 'seed@example.com', message: 'hello' }) });
      const inquiryId = (await (await api('GET', '/api/admin/inquiries')).json())[0].id;
      redis.state.gate = async (name) => { if (name === 'GET' || name === 'EVAL') await sleep(Math.random() * 8); };

      const ROUNDS = 50;
      for (let i = 0; i < ROUNDS; i++) {
        const results = await Promise.all([
          fetch(app.base + '/api/admin/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.1.0.${i + 1}` }, body: JSON.stringify({ name: 'V' + i, email: `v${i}@example.com`, message: 'msg ' + i }) }),
          api('PUT', `/api/admin/inquiries/${inquiryId}`, { status: 'S' + i }),
          api('PUT', `/api/admin/packages/${pkgId}`, { name: 'Pkg ' + i }),
          api('PUT', '/api/admin/modules/templates', { enabled: i % 2 === 0 })
        ]);
        results.forEach((r, k) => assert.equal(r.status, 200, `round ${i} op ${k} -> ${r.status}`));
      }
      const stored = redis.get('phoenixai:data');
      assert.equal(stored.inquiries.length, ROUNDS + 1, 'every visitor inquiry present');
      assert.equal(new Set(stored.inquiries.map((x) => x.id)).size, stored.inquiries.length, 'no duplicate inquiries');
      assert.equal(stored.notifications.length, ROUNDS + 1, 'every notification present');
      assert.equal(stored.inquiries.find((x) => x.id === inquiryId).status, 'S' + (ROUNDS - 1));
      assert.equal(stored.packages.find((x) => x.id === pkgId).name, 'Pkg ' + (ROUNDS - 1));
      assert.equal(stored.settings.modules.find((m) => m.id === 'templates').enabled, (ROUNDS - 1) % 2 === 0);
    } finally { await app.close(); }
  });

  test('two requests that loaded the same data and edit different items both persist', async () => {
    reset();
    const app = await startApp(env());
    try {
      const { api } = await login(app.base);
      const pkgs = await (await api('GET', '/api/admin/packages')).json();
      // Hold every EVAL until both requests have loaded the same revision.
      let waiting = 0; let release; const bothLoaded = new Promise((r) => (release = r));
      redis.state.gate = async (name) => { if (name === 'EVAL') { waiting++; if (waiting >= 2) release(); await bothLoaded; } };
      const [a, b] = await Promise.all([
        api('PUT', `/api/admin/packages/${pkgs[0].id}`, { name: 'Edited One' }),
        api('PUT', `/api/admin/packages/${pkgs[1].id}`, { name: 'Edited Two' })
      ]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      const stored = redis.get('phoenixai:data');
      assert.equal(stored.packages.find((p) => p.id === pkgs[0].id).name, 'Edited One');
      assert.equal(stored.packages.find((p) => p.id === pkgs[1].id).name, 'Edited Two');
    } finally { await app.close(); }
  });

  test('admin API without a login returns 401 (not 500)', async () => {
    reset();
    const app = await startApp(env());
    try {
      assert.equal((await fetch(app.base + '/api/admin/modules')).status, 401);
      assert.equal((await fetch(app.base + '/api/admin/modules/templates', { method: 'PUT' })).status, 401);
    } finally { await app.close(); }
  });

  test('logo upload goes to Blob, is saved in the data, and the old logo is deleted afterwards', async () => {
    reset();
    const app = await startApp(env({ BLOB_READ_WRITE_TOKEN: 'blob-token', VERCEL_BLOB_API_URL: blobUrl }));
    try {
      const { cookie, csrf } = await login(app.base);
      const upload = async (name) => {
        const fd = new FormData();
        fd.append('logo', new Blob([Buffer.alloc(2048, 7)], { type: 'image/png' }), name);
        return fetch(app.base + '/api/admin/settings/logo', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: fd });
      };
      let r = await upload('one.png');
      assert.equal(r.status, 200, await r.clone().text());
      const first = (await r.json()).logo;
      assert.match(first, /^https:\/\/mockstore\.public\.blob\.vercel-storage\.com\/logos\//);
      assert.equal(redis.get('phoenixai:data').settings.logo, first);
      assert.equal((await (await fetch(app.base + '/api/settings/logo')).json()).logo, first);
      assert.equal((await (await fetch(app.base + '/api/public/bootstrap')).json()).logo, first);

      r = await upload('two.png');
      const second = (await r.json()).logo;
      assert.notEqual(second, first);
      await sleep(100);
      assert.deepEqual(blob.state.deletes, [first], 'old logo removed after the save');
      assert.equal(redis.get('phoenixai:data').settings.logo, second);
    } finally { await app.close(); }
  });

  test('template upload with thumbnail + PDF + previews stores Blob URLs (no /uploads/undefined)', async () => {
    reset();
    const app = await startApp(env({ BLOB_READ_WRITE_TOKEN: 'blob-token', VERCEL_BLOB_API_URL: blobUrl }));
    try {
      const { cookie, csrf } = await login(app.base);
      const fd = new FormData();
      fd.append('name', 'Blob Template'); fd.append('category', 'resume'); fd.append('description', 'd'); fd.append('style', 's');
      fd.append('featured', 'true'); fd.append('published', 'true');
      fd.append('thumbnail', new Blob([Buffer.alloc(500, 1)], { type: 'image/png' }), 't.png');
      fd.append('pdf', new Blob([Buffer.alloc(500, 2)], { type: 'application/pdf' }), 'f.pdf');
      fd.append('previewImages', new Blob([Buffer.alloc(500, 3)], { type: 'image/jpeg' }), 'p1.jpg');
      fd.append('previewImages', new Blob([Buffer.alloc(500, 4)], { type: 'image/jpeg' }), 'p2.jpg');
      const r = await fetch(app.base + '/api/admin/templates', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: fd });
      assert.equal(r.status, 200, await r.clone().text());
      const t = redis.get('phoenixai:data').templates.find((x) => x.name === 'Blob Template');
      assert.match(t.thumbnail, /^https:\/\/mockstore\.public\.blob\.vercel-storage\.com\/thumbnails\//);
      assert.match(t.pdf, /\/pdfs\//);
      assert.equal(t.previewImages.length, 2);
      assert.ok(t.previewImages.every((u) => u.includes('/previews/')));
      assert.ok(!JSON.stringify(t).includes('undefined'));
    } finally { await app.close(); }
  });

  test('/admin serves the login page without touching Redis', async () => {
    reset();
    const app = await startApp(env());
    try {
      const r = await fetch(app.base + '/admin');
      assert.equal(r.status, 200);
      assert.match(await r.text(), /<html/i);
      assert.equal(redis.state.calls.length, 0);
    } finally { await app.close(); }
  });

  test('Blob failure: 502 with a message and the old logo is kept', async () => {
    reset();
    const app = await startApp(env({ BLOB_READ_WRITE_TOKEN: 'blob-token', VERCEL_BLOB_API_URL: blobUrl }));
    try {
      const { cookie, csrf } = await login(app.base);
      blob.state.failPut = true;
      const fd = new FormData();
      fd.append('logo', new Blob([Buffer.alloc(100, 1)], { type: 'image/png' }), 'x.png');
      const r = await fetch(app.base + '/api/admin/settings/logo', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: fd });
      assert.equal(r.status, 502);
      assert.ok((await r.json()).error);
      assert.equal(redis.get('phoenixai:data').settings.logo, '');
    } finally { await app.close(); }
  });

  test('Vercel with Redis but without Blob: uploads give a clear 503', async () => {
    reset();
    const app = await startApp(env({ VERCEL: '1' }));
    try {
      const { cookie, csrf } = await login(app.base);
      const fd = new FormData();
      fd.append('logo', new Blob([Buffer.alloc(100, 1)], { type: 'image/png' }), 'x.png');
      const r = await fetch(app.base + '/api/admin/settings/logo', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: fd });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /BLOB_READ_WRITE_TOKEN/);
    } finally { await app.close(); }
  });

  test('/api/health reports storage status and never leaks secrets; export hides the password hash', async () => {
    reset();
    const app = await startApp(env({ BLOB_READ_WRITE_TOKEN: 'blob-token-secret' }));
    try {
      const r = await fetch(app.base + '/api/health');
      const text = await r.text();
      const body = JSON.parse(text);
      assert.equal(body.storage.data, 'redis');
      assert.equal(body.storage.redisReachable, true);
      assert.equal(body.env.KV_REST_API_URL, true);
      for (const secret of ['test-token', 'blob-token-secret', PASSWORD, 'test-secret-value']) assert.ok(!text.includes(secret), 'secret leaked');

      assert.equal((await fetch(app.base + '/api/admin/export')).status, 401);
      const { api } = await login(app.base);
      const exp = await (await api('GET', '/api/admin/export')).json();
      assert.equal(exp.settings.adminPassword, undefined);
      assert.ok(Array.isArray(exp.packages));
    } finally { await app.close(); }
  });

  test('custom env-var prefix (STORAGE_REST_API_URL / STORAGE_REST_API_TOKEN) is detected', async () => {
    reset();
    const app = await startApp({ STORAGE_REST_API_URL: redisUrl, STORAGE_REST_API_TOKEN: 'test-token' });
    try {
      assert.equal((await fetch(app.base + '/api/modules')).status, 200);
      assert.ok(redis.get('phoenixai:data'));
    } finally { delete process.env.STORAGE_REST_API_URL; delete process.env.STORAGE_REST_API_TOKEN; await app.close(); }
  });
});

describe('Vercel without Redis', () => {
  test('public site still works; admin changes fail with a clear, actionable 503; health explains why', async () => {
    // On Vercel there is no data.json (it is gitignored), so point at a file that does not exist.
    const app = await startApp({ VERCEL: '1', NODE_ENV: 'production', DATA_FILE: path.join(os.tmpdir(), 'phx-missing-' + Date.now() + '.json') });
    try {
      assert.equal((await fetch(app.base + '/api/modules')).status, 200);
      assert.equal((await fetch(app.base + '/api/public/bootstrap')).status, 200);
      const { api } = await login(app.base);
      const r = await api('PUT', '/api/admin/modules/templates', { enabled: false });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /KV_REST_API_URL/);
      const h = await fetch(app.base + '/api/health');
      assert.equal(h.status, 503);
      const body = await h.json();
      assert.equal(body.storage.data, 'not-configured');
      assert.ok(body.problems.some((p) => /Redis is not configured/.test(p)));
    } finally { await app.close(); }
  });
});

describe('Local mode (no environment variables)', () => {
  test('uses data.json: reads, migrates, saves; reorder works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phx-'));
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, JSON.stringify(oldFormatData()));
    const app = await startApp({ DATA_FILE: file });
    try {
      const { api } = await login(app.base);
      const modules = await (await api('GET', '/api/admin/modules')).json();
      assert.ok(modules.some((m) => m.id === 'services'));
      assert.equal((await api('PUT', '/api/admin/modules/services', { enabled: false })).status, 200);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.settings.modules.find((m) => m.id === 'services').enabled, false);
      assert.equal(saved.packages.length, 2);
      const ids = saved.settings.modules.map((m) => m.id).reverse();
      assert.equal((await api('PUT', '/api/admin/modules/reorder', { moduleIds: ids })).status, 200);
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a fresh install without data.json still serves the public API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phx-'));
    const app = await startApp({ DATA_FILE: path.join(dir, 'data.json') });
    try {
      assert.equal((await fetch(app.base + '/api/public/bootstrap')).status, 200);
      const r = await login(app.base);
      assert.equal((await r.api('GET', '/api/admin/bootstrap')).status, 200);
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
