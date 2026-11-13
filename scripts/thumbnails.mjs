// SPDX-License-Identifier: GPL-3.0-or-later
// Gathers what Windows builds need for File Explorer's PDF thumbnails into
// build/thumbnails/, which electron-builder copies into the app's resources
// (see "extraResources" in package.json, and build/before-pack.cjs, which
// runs this before every Windows build):
//
// - inkleaf-thumbs.dll, Inkleaf's thumbnail maker, from native/thumbnails/
//   (rebuild it with native/thumbnails/build.sh after changing its source)
// - pdfium.dll, the PDF engine it draws with, downloaded once from the
//   pdfium-binaries project at a fixed version and checked against its hash
// - the licences of PDFium and the libraries inside it

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'thumbnails');

/** PDFium 155.0.8057.0. Change all three together. */
const PDFIUM = {
  version: 'chromium/8057',
  url: 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F8057/pdfium-win-x64.tgz',
  sha256: 'e307d519e42f2e69b1b531f0c2a32dffcdf3891ec0eba60328ba51a57cec01ed',
};

export async function prepareThumbnails() {
  fs.mkdirSync(out, { recursive: true });

  const ours = path.join(root, 'native', 'thumbnails', 'inkleaf-thumbs.dll');
  if (!fs.existsSync(ours)) throw new Error('native/thumbnails/inkleaf-thumbs.dll is missing: build it with native/thumbnails/build.sh');
  fs.copyFileSync(ours, path.join(out, 'inkleaf-thumbs.dll'));

  const stamp = path.join(out, 'pdfium-version.txt');
  if (fs.existsSync(path.join(out, 'pdfium.dll')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === PDFIUM.version) return;

  console.log(`Downloading PDFium (${PDFIUM.version}) for File Explorer thumbnails…`);
  const res = await fetch(PDFIUM.url);
  if (!res.ok) throw new Error(`Couldn't download PDFium: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== PDFIUM.sha256) throw new Error(`PDFium's download didn't match its expected hash (got ${hash})`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-pdfium-'));
  try {
    const archive = path.join(temp, 'pdfium.tgz');
    fs.writeFileSync(archive, bytes);
    // tar comes with Windows 10 and later, macOS and Linux
    execFileSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' });
    fs.copyFileSync(path.join(temp, 'bin', 'pdfium.dll'), path.join(out, 'pdfium.dll'));
    fs.rmSync(path.join(out, 'licenses'), { recursive: true, force: true });
    fs.cpSync(path.join(temp, 'licenses'), path.join(out, 'licenses'), { recursive: true });
    fs.copyFileSync(path.join(temp, 'LICENSE'), path.join(out, 'licenses', 'pdfium-binaries.txt'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  fs.writeFileSync(stamp, `${PDFIUM.version}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareThumbnails().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
