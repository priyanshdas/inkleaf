// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the drawing half of File Explorer's PDF thumbnails
// (native/thumbnails/first-page.h) on this computer: builds a small test
// program around it and has it draw the first page of the test PDFs.
// Needs a C++ compiler and a PDFium library: PDFIUM_LIB, or the one in the
// pypdfium2 Python package (pip install pypdfium2).
//   node tests/thumbnails.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-thumbs-'));
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failed++;
};

function pdfiumLibrary() {
  if (process.env.PDFIUM_LIB) return process.env.PDFIUM_LIB;
  try {
    const dir = execFileSync('python3', ['-c', 'import os, pypdfium2_raw; print(os.path.dirname(pypdfium2_raw.__file__))']).toString().trim();
    const lib = fs.readdirSync(dir).find((f) => /^(lib)?pdfium\.(so|dylib|dll)$/.test(f));
    return lib ? path.join(dir, lib) : null;
  } catch {
    return null;
  }
}

console.log('thumbnails: the first page of each PDF, as File Explorer shows it');
const lib = pdfiumLibrary();
if (!lib) {
  console.log('  (skipped: no PDFium library; set PDFIUM_LIB or pip install pypdfium2)');
  process.exit(0);
}
const exe = path.join(work, 'test-first-page');
execFileSync('g++', ['-O1', '-std=c++17', '-Wall', '-Werror', '-o', exe, path.join(root, 'native', 'thumbnails', 'test-first-page.cpp'), '-ldl']);

/** Draws `pdf` at `size`; the picture's size and pixels, or null if there's no picture. */
function draw(pdf, size) {
  const out = path.join(work, `${path.basename(pdf)}.ppm`);
  const said = execFileSync(exe, [lib, pdf, String(size), out]).toString().trim();
  const m = /^OK (\d+)x(\d+)$/.exec(said);
  if (!m) return null;
  const data = fs.readFileSync(out);
  // P6 header: three lines, then RGB bytes
  let at = 0;
  for (let lines = 0; lines < 3; at++) if (data[at] === 0x0a) lines++;
  return { width: Number(m[1]), height: Number(m[2]), rgb: data.subarray(at) };
}

const sample = draw(path.join(fixtures, 'sample.pdf'), 256);
check('an A4 page is 256 pixels tall, in proportion', sample?.height === 256 && Math.abs(sample.width - 181) <= 1, JSON.stringify(sample && [sample.width, sample.height]));
const dark = sample ? [...sample.rgb].filter((v) => v < 128).length : 0;
const white = sample ? [...sample.rgb].filter((v) => v > 245).length : 0;
check('on white paper, with its text drawn', white > sample?.rgb.length * 0.8 && dark > 50, `white ${white}, dark ${dark}`);

const photo = draw(path.join(fixtures, 'photo.pdf'), 256);
const coloured = photo ? [...Array(photo.rgb.length / 3).keys()].filter((i) => Math.abs(photo.rgb[i * 3] - photo.rgb[i * 3 + 2]) > 60).length : 0;
check('in colour', coloured > 1000, String(coloured));

const big = draw(path.join(fixtures, 'table.pdf'), 1024);
check('at whatever size Explorer asks for', big?.height === 1024);

check('a password-protected PDF gets no picture (Explorer shows the icon)', draw(path.join(fixtures, 'password.pdf'), 256) === null);
const fake = path.join(work, 'fake.pdf');
fs.writeFileSync(fake, 'not a PDF at all');
check('nor does a file that isn’t a PDF', draw(fake, 256) === null);

fs.rmSync(work, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll good.');
