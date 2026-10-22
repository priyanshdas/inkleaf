// SPDX-License-Identifier: GPL-3.0-or-later
// Frame-time benchmark: feeds one input event per animation frame from
// inside the page (so no test-driver overhead) and records how long each
// frame takes. 16.7 ms per frame is a smooth 60 fps.
//
//   xvfb-run -a node tests/bench/frames.mjs [label]

import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const big = path.join(root, 'tests', 'bench', 'big.pdf');
const label = process.argv[2] ?? 'run';

const dpr = process.env.DPR ?? '1';
const app = await electron.launch({ args: ['--no-sandbox', `--force-device-scale-factor=${dpr}`, root], cwd: root,
  env: { ...process.env, INKLEAF_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-frames-')) } });
const win = await app.firstWindow();
if (dpr === '1') await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForFunction(() => !!window.__inkleaf);
await app.evaluate(({ BrowserWindow }, file) => {
  const fsm = process.mainModule.require('node:fs');
  BrowserWindow.getAllWindows()[0].webContents.send('open-file', { path: file, name: 'big.pdf', data: new Uint8Array(fsm.readFileSync(file)) });
}, big);
await win.waitForFunction(() => window.__inkleaf.tabCount() === 1, null, { timeout: 60000 });
await win.waitForTimeout(2500);

// 600 existing strokes, like a well-marked-up document
await win.evaluate(() => {
  const doc = window.__inkleaf.getDoc();
  doc.pages.slice(0, 150).forEach((p, i) => {
    for (let k = 0; k < 4; k++) {
      const pts = Array.from({ length: 120 }, (_, j) => [80 + j * 3, 300 + 40 * Math.sin(j / 9 + k) + k * 50]);
      doc.addAnnot(p.id, { id: `s${i}_${k}`, type: 'ink', points: pts, color: '#1d3f91', width: 2, opacity: 1 });
    }
    doc.addAnnot(p.id, { id: `h${i}`, type: 'highlight', x: 60, y: 740, w: 300, h: 14, color: '#ffe169' });
  });
  doc.commit();
  window.__inkleaf.viewer.setScale(1.5);
  window.__inkleaf.viewer.scrollToPage(doc.pages[10].id, false);
});
await win.waitForTimeout(2000);

/** Runs `step(i)` once per frame for n frames; returns frame-time stats. */
const frames = (name, setup, step, n) => win.evaluate(async ([name, setupSrc, stepSrc, n]) => {
  const AsyncFunction = (async () => {}).constructor;
  const setup = new AsyncFunction('ctx', setupSrc);
  const step = new Function('ctx', 'i', stepSrc);
  const ctx = { ink: window.__inkleaf, viewport: document.querySelector('#viewport') };
  await setup(ctx);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const times = [];
  let last = performance.now();
  for (let i = 0; i < n; i++) {
    step(ctx, i);
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    times.push(now - last);
    last = now;
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / n;
  return { name, avg, p95: times[Math.floor(n * 0.95)], max: times[n - 1] };
}, [name, setup, step, n]);

const pointer = `
  const page = ctx.ink.viewer.views.get(ctx.ink.getDoc().pages[10].id).el.getBoundingClientRect();
  ctx.fire = (type, x, y) => {
    const target = document.elementFromPoint(x, y) ?? ctx.viewport;
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true }));
  };
  ctx.page = page;
`;

const results = [];
const run = async (...args) => {
  const r = await frames(...args);
  results.push(r);
  console.log(`  ${r.name.padEnd(28)} avg ${r.avg.toFixed(1).padStart(6)} ms   p95 ${r.p95.toFixed(1).padStart(6)} ms   worst ${r.max.toFixed(1).padStart(6)} ms`);
};

await run('idle (reference)', '', '', 120);

await run('pen stroke',
  `${pointer} ctx.ink.editor.setTool('pen'); ctx.fire('pointerdown', page.left + 100, page.top + 300);`,
  `ctx.fire('pointermove', ctx.page.left + 100 + i * 2, ctx.page.top + 300 + 60 * Math.sin(i / 12));`, 240);
await win.evaluate(() => {
  const v = document.querySelector('#viewport');
  v.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
});
await win.waitForTimeout(300);

await run('drag a mark',
  `${pointer} ctx.ink.editor.setTool('select');
   const view = ctx.ink.viewer.views.get(ctx.ink.getDoc().pages[10].id);
   const [x, y] = ctx.ink.viewer.toLocal(view, 80 + 30 * 3, 300 + 40 * Math.sin(30 / 9));
   ctx.x = page.left + x; ctx.y = page.top + y;
   ctx.fire('pointerdown', ctx.x, ctx.y);`,
  `ctx.fire('pointermove', ctx.x + i, ctx.y + i / 2);`, 180);
await win.evaluate(() => document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })));
await win.waitForTimeout(300);

await run('scroll',
  '',
  `ctx.viewport.scrollTop += 45;`, 240);

await win.evaluate(() => window.__inkleaf.viewer.scrollToPage(window.__inkleaf.getDoc().pages[10].id, false));
await win.waitForTimeout(1500);
await run('typing',
  `${pointer} ctx.ink.editor.setTool('text');
   ctx.fire('pointerdown', page.left + 300, page.top + 150);
   await new Promise((r) => setTimeout(r, 50));
   ctx.area = document.querySelector('.text-editor');`,
  `ctx.area.value += 'a'; ctx.area.dispatchEvent(new Event('input', { bubbles: true }));`, 180);

await app.evaluate(({ app }) => app.exit(0));
fs.writeFileSync(path.join(root, 'tests', 'bench', `frames-${label}-dpr${dpr}.json`), JSON.stringify(results, null, 2));
