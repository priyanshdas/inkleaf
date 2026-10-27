// SPDX-License-Identifier: GPL-3.0-or-later
// The relay for files sent with an Inkleaf pickup code.
//
// Inkleaf encrypts a file before it ever gets here, with a key that exists
// only in the pickup code. This only hands out permission to upload one
// file, says where to download it from, and deletes it when asked. It can't
// read anything it stores, and keeps nothing else: no accounts, no logs of
// names or contents.
//
//   POST /api/drop?action=start   { id, check, size }  → a one-time upload token
//   GET  /api/drop?id=…&check=…                         → { url } to download from
//   POST /api/drop?action=delete  { id, token }         → removes it (needs the
//                                                          delete token, which only
//                                                          someone with the code has)

import { del, head } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { CHECK, ID, KEEP_DAYS, MAX_BYTES, checkFor, cors, pathnameFor, storeHost } from './_shared.js';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(typeof req.body === 'string' ? req.body : '{}');
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  cors(req, res);
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const id = String(req.query.id ?? ''), check = String(req.query.check ?? '');
      if (!ID.test(id) || !CHECK.test(check)) return res.status(400).json({ error: 'bad-code' });
      return res.status(200).json({ url: `${storeHost()}/${pathnameFor(id, check)}`, keepDays: KEEP_DAYS });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const body = await readBody(req);

    if (req.query.action === 'start') {
      const { id, check, size } = body;
      if (!ID.test(String(id)) || !CHECK.test(String(check))) return res.status(400).json({ error: 'bad-code' });
      if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'bad-size' });
      if (size > MAX_BYTES) return res.status(413).json({ error: 'too-big', maxBytes: MAX_BYTES });
      const pathname = pathnameFor(id, check);
      const clientToken = await generateClientTokenFromReadWriteToken({
        pathname,
        maximumSizeInBytes: Math.min(size + 1024, MAX_BYTES),
        allowedContentTypes: ['application/octet-stream'],
        validUntil: Date.now() + 15 * 60 * 1000,
        addRandomSuffix: false,
        allowOverwrite: false,
        // short, so a picked-up file stops being served soon after it's deleted
        cacheControlMaxAge: 60,
      });
      return res.status(200).json({ clientToken, pathname, keepDays: KEEP_DAYS });
    }

    if (req.query.action === 'delete') {
      const { id, token } = body;
      if (!ID.test(String(id)) || !/^[0-9a-f]{32}$/.test(String(token))) return res.status(400).json({ error: 'bad-code' });
      const url = `${storeHost()}/${pathnameFor(id, checkFor(token))}`;
      try {
        await head(url);
      } catch {
        return res.status(200).json({ deleted: false });
      }
      await del(url);
      return res.status(200).json({ deleted: true });
    }

    return res.status(400).json({ error: 'action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server' });
  }
}
