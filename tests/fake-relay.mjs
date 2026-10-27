// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for the relay (relay/) for the tests: same API, files kept in
// memory, and it takes uploads itself instead of handing out Vercel tokens.

import http from 'node:http';
import { createHash } from 'node:crypto';

export function startFakeRelay() {
  const files = new Map();
  const seen = { uploads: 0, deletes: 0 };
  const checkFor = (token) => createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex').slice(0, 32);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/drop' && req.method === 'POST' && url.searchParams.get('action') === 'start') {
      const { id, check, size } = JSON.parse(body.toString());
      if (size > 100 * 1024 * 1024) return json(413, { error: 'too-big' });
      const pathname = `drops/${id}/${check}.bin`;
      return json(200, { pathname, uploadUrl: `http://127.0.0.1:${server.address().port}/blob/${pathname}` });
    }
    if (url.pathname.startsWith('/blob/') && req.method === 'PUT') {
      files.set(url.pathname.slice(6), body);
      seen.uploads++;
      res.writeHead(200).end();
      return;
    }
    if (url.pathname.startsWith('/blob/') && req.method === 'GET') {
      // (the query, a cache-buster, doesn't matter here)
      const data = files.get(url.pathname.slice(6));
      if (!data) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(data);
      return;
    }
    if (url.pathname === '/api/drop' && req.method === 'GET') {
      return json(200, { url: `http://127.0.0.1:${server.address().port}/blob/drops/${url.searchParams.get('id')}/${url.searchParams.get('check')}.bin` });
    }
    if (url.pathname === '/api/drop' && req.method === 'POST' && url.searchParams.get('action') === 'delete') {
      const { id, token } = JSON.parse(body.toString());
      const deleted = files.delete(`drops/${id}/${checkFor(token)}.bin`);
      if (deleted) seen.deletes++;
      return json(200, { deleted });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    files,
    seen,
    close: () => server.close(),
  })));
}
