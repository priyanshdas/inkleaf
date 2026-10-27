// SPDX-License-Identifier: GPL-3.0-or-later
// Runs once a day (vercel.json): deletes anything older than KEEP_DAYS that
// was never picked up.

import { del, list } from '@vercel/blob';
import { KEEP_DAYS } from './_shared.js';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let cursor, removed = 0;
  do {
    const page = await list({ prefix: 'drops/', cursor, limit: 1000 });
    const old = page.blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff).map((b) => b.url);
    if (old.length) {
      await del(old);
      removed += old.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  res.status(200).json({ removed });
}
