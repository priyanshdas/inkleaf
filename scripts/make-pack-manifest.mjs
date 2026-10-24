// SPDX-License-Identifier: GPL-3.0-or-later
// Writes src/shared/pack-manifest.json: where each downloadable language pack
// file lives on jsDelivr, with its size and SHA-256, so the app can check
// every download is exactly the file it expects.
//
//   node scripts/make-pack-manifest.mjs
//
// Run it again after changing a package version below. It downloads each
// package once with `npm pack` to hash the files.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-packs-'));

const OCR_DATA_VERSION = '1.0.0';
const CJK_FONTS = {
  sc: ['noto-sans-sc', '0.4.4', 'NotoSansSC'],
  tc: ['noto-sans-tc', '0.4.4', 'NotoSansTC'],
  jp: ['noto-sans-jp', '0.4.4', 'NotoSansJP'],
  kr: ['noto-sans-kr', '0.4.4', 'NotoSansKR'],
};

// the language list is TypeScript; pull the OCR codes out of it directly
const source = fs.readFileSync(path.join(root, 'src/shared/languages.ts'), 'utf8');
const ocrCodes = [...source.matchAll(/ocr: '([a-z_]+)'/g)].map((m) => m[1]);
const builtIn = JSON.parse(source.match(/BUILT_IN_OCR = new Set\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'));

function fetchFile(pkg, version, inner) {
  const dir = path.join(tmp, `${pkg.replace(/[@/]/g, '_')}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
    const name = execFileSync('npm', ['pack', `${pkg}@${version}`, '--silent', '--pack-destination', dir], { encoding: 'utf8' }).trim().split('\n').pop();
    execFileSync('tar', ['xzf', path.join(dir, name), '-C', dir]);
  }
  // a few OCR packages only have the standard build, not best_int
  const options = Array.isArray(inner) ? inner : [inner];
  inner = options.find((p) => fs.existsSync(path.join(dir, 'package', p)));
  if (!inner) throw new Error(`${pkg}: none of ${options.join(', ')}`);
  const bytes = fs.readFileSync(path.join(dir, 'package', inner));
  return {
    url: `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${inner}`,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

const files = {};
for (const code of ocrCodes) {
  if (builtIn.includes(code)) continue;
  process.stdout.write(`ocr ${code} `);
  files[`ocr/${code}.traineddata.gz`] = fetchFile(`@tesseract.js-data/${code}`, OCR_DATA_VERSION, [`4.0.0_best_int/${code}.traineddata.gz`, `4.0.0/${code}.traineddata.gz`]);
}
for (const [script, [pkg, version, base]] of Object.entries(CJK_FONTS)) {
  for (const [weight, style] of [['400Regular', 'Regular'], ['700Bold', 'Bold']]) {
    process.stdout.write(`font ${script} ${style} `);
    files[`fonts/${base}-${style}.ttf`] = fetchFile(`@expo-google-fonts/${pkg}`, version, `${weight}/${base}_${weight}.ttf`);
  }
}
fs.writeFileSync(path.join(root, 'src/shared/pack-manifest.json'), JSON.stringify({ files }, null, 1) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${Object.keys(files).length} files`);
