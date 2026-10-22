// SPDX-License-Identifier: GPL-3.0-or-later
// CPU-profiles one interaction and prints the hottest functions.
//   INKLEAF_PROFILE=1 node scripts/build.mjs && xvfb-run -a node tests/bench/profile.mjs pen|scroll|drag|type|open
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const big = path.join(root, 'tests', 'bench', 'big.pdf');
const what = process.argv[2] ?? 'pen';

const app = await electron.launch({ args: ['--no-sandbox', `--force-device-scale-factor=${process.env.DPR ?? 1}`, root], cwd: root,
  env: { ...process.env, INKLEAF_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-prof-')) } });
const win = await app.firstWindow();
if (!process.env.DPR) await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForFunction(() => !!window.__inkleaf);
const cdp = await win.context().newCDPSession(win);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

const open = () => app.evaluate(({ BrowserWindow }, file) => {
  const fsm = process.mainModule.require('node:fs');
  BrowserWindow.getAllWindows()[0].webContents.send('open-file', { path: file, name: 'big.pdf', data: new Uint8Array(fsm.readFileSync(file)) });
}, big);

if (what === 'open') await cdp.send('Profiler.start');
await open();
await win.waitForFunction(() => window.__inkleaf.tabCount() === 1, null, { timeout: 60000 });
await win.waitForTimeout(2500);
if (what !== 'open') {
  await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    doc.pages.slice(0, 150).forEach((p, i) => {
      for (let k = 0; k < 4; k++) {
        const pts = Array.from({ length: 120 }, (_, j) => [80 + j * 3, 300 + 40 * Math.sin(j / 9 + k) + k * 50]);
        doc.addAnnot(p.id, { id: `s${i}_${k}`, type: 'ink', points: pts, color: '#1d3f91', width: 2, opacity: 1 });
      }
    });
    doc.commit();
    window.__inkleaf.viewer.scrollToPage(doc.pages[10].id, false);
  });
  await win.waitForTimeout(1500);
  await cdp.send('Profiler.start');
}
const box = await win.locator('.page[data-page-id]').nth(10).boundingBox();
if (what === 'pen') {
  await win.keyboard.press('p');
  await win.mouse.move(box.x + 100, box.y + 300); await win.mouse.down();
  for (let i = 0; i < 300; i++) await win.mouse.move(box.x + 100 + i * 1.5, box.y + 300 + 60 * Math.sin(i / 12));
  await win.mouse.up();
} else if (what === 'control') {
  await win.keyboard.press('h');
  for (let i = 0; i < 300; i++) await win.mouse.move(box.x + 100 + i * 1.5, box.y + 300 + 60 * Math.sin(i / 12));
} else if (what === 'scroll') {
  await win.evaluate(async () => {
    const v = document.querySelector('#viewport');
    for (let i = 0; i < 240; i++) { v.scrollTop += 45; await new Promise((r) => requestAnimationFrame(r)); }
  });
} else if (what === 'drag') {
  await win.keyboard.press('v');
  await win.mouse.move(box.x + 110 * box.width / 595, box.y + box.height - (300 + 40 * Math.sin(10 / 9)) * box.height / 842);
  await win.mouse.down();
  for (let i = 0; i < 120; i++) await win.mouse.move(box.x + 120 + i, box.y + 400 + i / 2);
  await win.mouse.up();
} else if (what === 'type') {
  await win.keyboard.press('t');
  await win.mouse.click(box.x + 300, box.y + 150);
  await win.keyboard.type('The quick brown fox jumps over the lazy dog. '.repeat(4));
}
const t = Date.now();
const { profile } = await cdp.send('Profiler.stop');
await app.evaluate(({ app }) => app.exit(0));

// self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || '(anon)'}  ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`${what}: ${Math.round(total)} ms sampled`);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  console.log(`  ${v.toFixed(1).padStart(8)} ms  ${k}`);
}
