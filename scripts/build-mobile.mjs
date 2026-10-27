// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the web part of the Android and iPhone apps into mobile/www.
//
//   node scripts/build-mobile.mjs        then: npx cap sync
//
// It's the same editor as the desktop app (built by build.mjs), plus
// src/mobile/bridge.ts, which gives the editor the phone's file picker,
// share sheet, secure key storage and so on in place of Electron.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'mobile', 'www');

execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' });

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, 'app', 'renderer'), www, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'mobile', 'bridge.ts')],
  outfile: path.join(www, 'bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
});

// pdf.js's worker runs on its own, so it gets the same stand-ins for newer
// JavaScript features that older phone web views lack
const polyfills = await build({
  entryPoints: [path.join(root, 'src', 'mobile', 'polyfills.ts')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, write: false,
});
const worker = path.join(www, 'vendor', 'pdfjs', 'pdf.worker.mjs');
fs.writeFileSync(worker, polyfills.outputFiles[0].text + fs.readFileSync(worker, 'utf8'));

// the bridge loads the editor once the phone side is ready
const indexFile = path.join(www, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
html = html
  .replace('<script type="module" src="./app.js"></script>', '<script src="./bridge.js"></script>')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">');
if (!html.includes('bridge.js')) throw new Error('index.html changed: update build-mobile.mjs');
fs.writeFileSync(indexFile, html);
console.log(`phone app files are in ${path.relative(root, www)}`);
