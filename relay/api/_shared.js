// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by the relay's two endpoints.

import { createHash } from 'node:crypto';

/** 7 characters of Crockford base32: which file. */
export const ID = /^[0-9A-HJKMNP-TV-Z]{7}$/;
/** A 16-byte hex hash of the delete token: part of where the file is stored. */
export const CHECK = /^[0-9a-f]{32}$/;
export const MAX_BYTES = 100 * 1024 * 1024;
export const KEEP_DAYS = 7;

export const pathnameFor = (id, check) => `drops/${id}/${check}.bin`;

/** The store's public address, from the store id inside its token. */
export function storeHost() {
  const id = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(process.env.BLOB_READ_WRITE_TOKEN ?? '')?.[1];
  if (!id) throw new Error('BLOB_READ_WRITE_TOKEN is missing');
  return `https://${id.toLowerCase()}.public.blob.vercel-storage.com`;
}

export const checkFor = (tokenHex) => createHash('sha256').update(Buffer.from(tokenHex, 'hex')).digest('hex').slice(0, 32);

/** The download page on the website may ask for a file and delete it. */
export function cors(req, res) {
  const origin = req.headers.origin;
  if (origin === 'https://priyanshdas.github.io') {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
}
