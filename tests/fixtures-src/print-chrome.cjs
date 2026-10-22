// SPDX-License-Identifier: GPL-3.0-or-later
// Makes tests/fixtures/chrome.pdf the way most real PDFs are made: a browser's
// "Save as PDF", which embeds subset TrueType fonts.
//   xvfb-run -a npx electron tests/fixtures-src/print-chrome.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 60px; color: #1a1a1a; }
  .serif { font: 22px "DejaVu Serif"; }
  .sans { font: 15px "DejaVu Sans"; margin-top: 18px; }
  .mono { font: 13px "DejaVu Sans Mono"; color: #8a1c1c; margin-top: 18px; }
</style>
<p class="serif">Grand Hotel Aurora — Guest Folio</p>
<p class="sans">Reservation 7741 for Ms. Meera Iyer, arriving Friday</p>
<p class="mono">Balance due: 12,900 INR</p>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'chrome.pdf'), pdf);
  app.quit();
});
