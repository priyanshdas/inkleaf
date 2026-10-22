// SPDX-License-Identifier: GPL-3.0-or-later
// Times the things people feel: start-up, opening, scrolling, zooming,
// drawing, typing, saving and page tools, on a 300-page PDF.
//
//   python3 tests/bench/make_big.py
//   xvfb-run -a node tests/bench/bench.mjs [label]
//
// Every number is wall-clock time until the result is actually on screen
// (or on disk), not just until a function returns.

import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const big = path.join(root, 'tests', 'bench', 'big.pdf');
const label = process.argv[2] ?? 'run';
const results = {};
const record = (name, ms) => {
  results[name] = Math.round(ms);
  console.log(`  ${name.padEnd(34)} ${String(Math.round(ms)).padStart(6)} ms`);
};

const t0 = Date.now();
const app = await electron.launch({
  args: ['--no-sandbox', root],
  cwd: root,
  env: { ...process.env, INKLEAF_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-bench-')) },
});
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForFunction(() => !!window.__inkleaf, null, { timeout: 30000 });
record('start → app ready', Date.now() - t0);

// long tasks block input; count them during interactive phases
await win.evaluate(() => {
  window.__long = [];
  new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration)))
    .observe({ type: 'longtask', buffered: false });
});
const longTasks = async (fn) => {
  await win.evaluate(() => (window.__long = []));
  await fn();
  return win.evaluate(() => ({ count: window.__long.length, worst: Math.max(0, ...window.__long) }));
};

const visibleRendered = () => win.evaluate(() => {
  const { viewer } = window.__inkleaf;
  const box = viewer.container.getBoundingClientRect();
  const views = [...viewer.views.values()].filter((v) => {
    const r = v.el.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  });
  const key = viewer.scale.toFixed(4);
  return views.length > 0 && views.every((v) => v.renderedKey.startsWith(key));
});
const waitRendered = async () => {
  for (;;) {
    if (await visibleRendered()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
};

// --- open ---------------------------------------------------------------------
let t = Date.now();
await app.evaluate(({ BrowserWindow }, file) => {
  const fsm = process.mainModule.require('node:fs');
  BrowserWindow.getAllWindows()[0].webContents.send('open-file', { path: file, name: 'big.pdf', data: new Uint8Array(fsm.readFileSync(file)) });
}, big);
await win.waitForFunction(() => window.__inkleaf.tabCount() === 1, null, { timeout: 60000, polling: 5 });
record('open → tab appears', Date.now() - t);
await waitRendered();
record('open → first page sharp', Date.now() - t);
await win.waitForTimeout(800);

// --- scroll ---------------------------------------------------------------------
const jumps = [150, 37, 260, 5, 199];
t = Date.now();
for (const n of jumps) {
  await win.evaluate((n) => {
    const { viewer, getDoc } = window.__inkleaf;
    viewer.scrollToPage(getDoc().pages[n].id, false);
  }, n);
  await waitRendered();
}
record('jump to page (avg of 5)', (Date.now() - t) / jumps.length);

const scroll = await longTasks(async () => {
  t = Date.now();
  for (let i = 0; i < 60; i++) {
    await win.mouse.move(800, 500);
    await win.mouse.wheel(0, 400);
    await win.waitForTimeout(16);
  }
  await waitRendered();
  record('smooth scroll 60 steps → sharp', Date.now() - t);
});
record('  long tasks while scrolling', scroll.count);
record('  worst long task (scroll)', scroll.worst);

// --- zoom -------------------------------------------------------------------------
t = Date.now();
for (const z of [2, 0.75, 1.5, 3, 1]) {
  await win.evaluate((z) => window.__inkleaf.viewer.setScale(z), z);
  await waitRendered();
}
record('zoom change → sharp (avg of 5)', (Date.now() - t) / 5);

// --- drawing ------------------------------------------------------------------------
await win.evaluate(() => window.__inkleaf.viewer.scrollToPage(window.__inkleaf.getDoc().pages[10].id, false));
await waitRendered();
// put a realistic number of existing marks on the document first
await win.evaluate(() => {
  const { getDoc } = window.__inkleaf;
  const doc = getDoc();
  doc.pages.slice(0, 150).forEach((p, i) => {
    for (let k = 0; k < 4; k++) {
      const pts = Array.from({ length: 120 }, (_, j) => [80 + j * 3, 300 + 40 * Math.sin(j / 9 + k) + k * 50]);
      doc.addAnnot(p.id, { id: `seed${i}_${k}`, type: 'ink', points: pts, color: '#1d3f91', width: 2, opacity: 1 });
    }
  });
  doc.commit();
});
await win.waitForTimeout(500);

await win.keyboard.press('p');
const pageBox = await win.locator('.page[data-page-id]').nth(10).boundingBox();
const pen = await longTasks(async () => {
  t = Date.now();
  await win.mouse.move(pageBox.x + 100, pageBox.y + 300);
  await win.mouse.down();
  for (let i = 0; i < 300; i++) await win.mouse.move(pageBox.x + 100 + i * 1.5, pageBox.y + 300 + 60 * Math.sin(i / 12));
  await win.mouse.up();
  record('pen stroke, 300 moves', Date.now() - t);
});
record('  long tasks while drawing', pen.count);

await win.keyboard.press('v');
const drag = await longTasks(async () => {
  t = Date.now();
  // grab one of the seeded strokes
  await win.mouse.move(pageBox.x + 0.0 + (80 + 30) * pageBox.width / 595, pageBox.y + pageBox.height - (300 + 40 * Math.sin(10 / 9)) * pageBox.height / 842);
  await win.mouse.down();
  for (let i = 0; i < 120; i++) await win.mouse.move(pageBox.x + 120 + i, pageBox.y + 400 + i / 2);
  await win.mouse.up();
  record('drag a mark, 120 moves', Date.now() - t);
});
record('  long tasks while dragging', drag.count);

t = Date.now();
for (let i = 0; i < 20; i++) await win.evaluate(() => window.__inkleaf.getDoc().undo());
record('undo ×20', Date.now() - t);
for (let i = 0; i < 20; i++) await win.evaluate(() => window.__inkleaf.getDoc().redo());

await win.keyboard.press('t');
await win.mouse.click(pageBox.x + 300, pageBox.y + 150);
await win.waitForSelector('.text-editor');
const typing = await longTasks(async () => {
  t = Date.now();
  await win.keyboard.type('The quick brown fox jumps over the lazy dog. '.repeat(4), { delay: 0 });
  record('typing 180 characters', Date.now() - t);
});
record('  long tasks while typing', typing.count);
await win.keyboard.press('Escape');

// --- saving & page tools ----------------------------------------------------------
const timeIn = (name, fn, arg) => win.evaluate(async ([fnSrc, arg]) => {
  const fn = new Function('return ' + fnSrc)();
  const s = performance.now();
  await fn(window.__inkleaf, arg);
  return performance.now() - s;
}, [fn.toString(), arg]).then((ms) => record(name, ms));

await timeIn('save (600 marks, 300 pages)', async ({ getDoc, exportPdf }) => { await exportPdf(getDoc()); });
await win.evaluate(() => {
  const doc = window.__inkleaf.getDoc();
  doc.addAnnot(doc.pages[3].id, { id: 'r1', type: 'redact', x: 60, y: 700, w: 300, h: 60, color: '#000000' });
  doc.commit();
});
await timeIn('save with a redaction', async ({ getDoc, exportPdf }) => { await exportPdf(getDoc()); });
await win.evaluate(() => {
  const doc = window.__inkleaf.getDoc();
  doc.movePages([doc.pages[0].id], 200);
});
await timeIn('save after reordering', async ({ getDoc, exportPdf }) => { await exportPdf(getDoc()); });
await timeIn('extract 10 pages', async ({ getDoc, exportPdf }) => {
  const doc = getDoc();
  await exportPdf(doc, doc.pages.slice(20, 30).map((p) => p.id));
});
await timeIn('split into 30 files of 10', async ({ getDoc, exportPdf, exportBatch }) => {
  const doc = getDoc();
  const groups = [];
  for (let i = 0; i < 300; i += 10) groups.push(doc.pages.slice(i, i + 10).map((p) => p.id));
  if (exportBatch) await exportBatch(doc, groups);
  else for (const g of groups) await exportPdf(doc, g);
});

await app.evaluate(({ app }) => app.exit(0));

const outFile = path.join(root, 'tests', 'bench', `results-${label}.json`);
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nsaved ${path.relative(root, outFile)}`);
