// SPDX-License-Identifier: GPL-3.0-or-later
// Language packs: text-recognition models and the large Chinese, Japanese
// and Korean fonts, downloaded the first time they're needed.
//
// Every file is listed in pack-manifest.json with its address, size and
// SHA-256. A download is only kept if it matches exactly, so a tampered or
// broken file never gets used. Once downloaded, packs work offline.

import { app, net, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import manifest from '../shared/pack-manifest.json';

type Entry = { url: string; size: number; sha256: string };
const FILES = (manifest as { files: Record<string, Entry> }).files;

export const packsDir = () => path.join(app.getPath('userData'), 'LanguagePacks');

/** Where a pack file is stored, or null if the name isn't one we know. */
export function packPath(name: string): string | null {
  if (!Object.hasOwn(FILES, name)) return null;
  return path.join(packsDir(), ...name.split('/'));
}

function installed(name: string): boolean {
  const file = packPath(name);
  if (!file || !existsSync(file)) return false;
  try {
    return statSync(file).size === FILES[name].size;
  } catch {
    return false;
  }
}

export function packStatus(): Record<string, { size: number; installed: boolean }> {
  const out: Record<string, { size: number; installed: boolean }> = {};
  for (const [name, entry] of Object.entries(FILES)) out[name] = { size: entry.size, installed: installed(name) };
  return out;
}

const inFlight = new Map<string, Promise<void>>();

async function download(name: string, onProgress: (received: number) => void) {
  const entry = FILES[name];
  const target = packPath(name)!;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  let response: Response;
  try {
    // net.fetch uses the system's proxy settings, like a browser would
    response = await net.fetch(entry.url, { cache: 'no-store' });
  } catch {
    throw new Error('Couldn’t download the language pack. Check your internet connection and try again.');
  }
  if (!response.ok || !response.body) throw new Error(`Couldn’t download the language pack (the server said ${response.status}).`);

  const hash = createHash('sha256');
  const out = createWriteStream(partial);
  let received = 0;
  let lastReport = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > entry.size) throw new Error('The language pack was bigger than expected, so it wasn’t kept.');
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      if (received - lastReport > 256 * 1024) {
        lastReport = received;
        onProgress(received);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (received !== entry.size || hash.digest('hex') !== entry.sha256) {
      throw new Error('The downloaded language pack didn’t match what Inkleaf expected, so it wasn’t kept. Please try again.');
    }
    await fs.rename(partial, target);
    onProgress(received);
  } catch (err) {
    out.destroy();
    await fs.rm(partial, { force: true }).catch(() => {});
    throw err;
  }
}

/** Makes sure these pack files are on disk, downloading any that aren't. */
export async function ensurePacks(names: string[], sender: WebContents) {
  const missing = names.filter((n) => Object.hasOwn(FILES, n) && !installed(n));
  const total = missing.reduce((n, name) => n + FILES[name].size, 0);
  const done = new Map<string, number>();
  const report = () => {
    if (sender.isDestroyed()) return;
    const received = [...done.values()].reduce((a, b) => a + b, 0);
    sender.send('packs:progress', { received, total });
  };
  // one at a time: the files are big, and a single progress bar is clearer
  for (const name of missing) {
    let job = inFlight.get(name);
    if (!job) {
      job = download(name, (received) => {
        done.set(name, received);
        report();
      }).finally(() => inFlight.delete(name));
      inFlight.set(name, job);
    }
    await job;
    done.set(name, FILES[name].size);
    report();
  }
}

/** Deletes downloaded pack files whose names start with `prefix` (all of them for ''). */
export async function removePacks(prefix: string) {
  for (const name of Object.keys(FILES)) {
    if (!name.startsWith(prefix)) continue;
    const file = packPath(name);
    if (file) await fs.rm(file, { force: true });
  }
}
