// Tiny stand-in for the Vercel Blob API (the SDK talks to VERCEL_BLOB_API_URL when it is set).
const http = require('http');

function createMockBlob() {
  const state = { puts: [], deletes: [], failPut: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (req.method === 'PUT') {
        if (state.failPut) return send(403, { error: { code: 'forbidden', message: 'simulated access denied' } });
        state.puts.push({ pathname, size: Buffer.concat(chunks).length, contentType: req.headers['x-content-type'] });
        const url = `https://mockstore.public.blob.vercel-storage.com${pathname}`;
        return send(200, { url, downloadUrl: url + '?download=1', pathname: pathname.slice(1), contentType: req.headers['x-content-type'] || 'application/octet-stream', contentDisposition: 'inline' });
      }
      if (req.method === 'POST' && pathname === '/delete') {
        state.deletes.push(...JSON.parse(Buffer.concat(chunks).toString()).urls);
        return send(200, {});
      }
      return send(404, { error: { code: 'not_found', message: 'nope' } });
    });
  });
  return {
    state,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}
module.exports = { createMockBlob };
