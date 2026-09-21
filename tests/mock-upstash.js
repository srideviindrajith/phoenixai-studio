// Minimal Upstash-REST-compatible mock used by the integration tests.
// Speaks the same protocol as the real service: POST with a JSON command array,
// responds with { result } or { error }. EVAL implements the same compare-and-set
// as the Lua script in server.js (a real Redis/Lua runtime is not available offline).
const http = require('http');

function createMockUpstash({ token = 'test-token' } = {}) {
  const store = new Map();
  const state = { calls: [], failNext: 0, failAlways: false, failCommands: new Set(), hasEval: true, evalConflictsToForce: 0, gate: null };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
      let cmd;
      try { cmd = JSON.parse(body); } catch (e) { return send(400, { error: 'ERR invalid JSON' }); }
      const name = String(cmd[0]).toUpperCase();
      state.calls.push(name);
      if (state.gate) await state.gate(name);
      if (state.failAlways || state.failCommands.has(name) || state.failNext > 0) {
        if (state.failNext > 0) state.failNext--;
        return send(500, { error: 'ERR simulated failure' });
      }
      if (name === 'PING') return send(200, { result: 'PONG' });
      if (name === 'GET') return send(200, { result: store.has(cmd[1]) ? store.get(cmd[1]) : null });
      if (name === 'SET') { store.set(cmd[1], cmd[2]); return send(200, { result: 'OK' }); }
      if (name === 'EVAL') {
        if (!state.hasEval) return send(400, { error: 'ERR unknown command `EVAL`' });
        const [, , numkeys, ...rest] = cmd;
        const keys = rest.slice(0, numkeys); const argv = rest.slice(numkeys);
        if (state.evalConflictsToForce > 0) { state.evalConflictsToForce--; return send(200, { result: 0 }); }
        let rev = 0;
        if (store.has(keys[0])) { try { const p = JSON.parse(store.get(keys[0])); if (typeof p._rev === 'number') rev = p._rev; } catch (e) { /* treated as 0 */ } }
        if (rev === Number(argv[0])) { store.set(keys[0], argv[1]); return send(200, { result: 1 }); }
        return send(200, { result: 0 });
      }
      return send(400, { error: `ERR unknown command '${name}'` });
    });
  });

  return {
    store, state,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    stop: () => new Promise((resolve) => server.close(resolve)),
    get: (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
    put: (key, obj) => store.set(key, typeof obj === 'string' ? obj : JSON.stringify(obj))
  };
}
module.exports = { createMockUpstash };
