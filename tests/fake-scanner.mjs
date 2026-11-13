// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for SANE's scanimage, so the tests can scan without a scanner.
// makeFakeScanner() puts a `scanimage` in a folder of its own; put that
// folder first on PATH and Inkleaf finds one HP all-in-one, which "scans" a
// plain page with a heading and some lines of text-like bars.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export function makeFakeScanner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-fake-scanner-'));
  const log = path.join(dir, 'scans.log');
  const tool = path.join(dir, 'scanimage');
  fs.writeFileSync(tool, `#!${process.execPath}\nimport(${JSON.stringify(fileURLToPath(import.meta.url))}).then((m) => m.runFakeScanimage());\n`);
  fs.chmodSync(tool, 0o755);
  return { dir, log, scans: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function runFakeScanimage() {
  const args = process.argv.slice(2);
  if (args.includes('-L')) {
    process.stdout.write("device `hpaio:/usb/HP_LaserJet_M1005?serial=TEST1' is a Hewlett-Packard HP_LaserJet_M1005 all-in-one\n");
    return;
  }
  if (args.includes('-A')) {
    // the options listing, as hplip's driver gives it for an all-in-one with a feeder
    process.stdout.write('Options specific to device `hpaio:/usb/HP_LaserJet_M1005?serial=TEST1\':\n  Scan mode:\n    --mode Lineart|Gray|Color [Lineart]\n    --resolution 75|100|150|200|300|600dpi [75]\n    --source Flatbed|ADF|ADF Duplex [Flatbed]\n');
    return;
  }
  fs.appendFileSync(path.join(path.dirname(process.argv[1]), 'scans.log'), `${args.join(' ')}\n`);
  const dpi = Number(args.find((a) => a.startsWith('--resolution='))?.split('=')[1] ?? 100);
  const batch = args.find((a) => a.startsWith('--batch='))?.slice(8);
  if (batch) {
    // a stack of three sheets, then the feeder runs out, as a real one says
    for (let n = 1; n <= 3; n++) fs.writeFileSync(batch.replace('%d', String(n)), page(dpi, n));
    process.stderr.write('scanimage: sane_start: Document feeder out of documents\n');
    process.exitCode = 7;
    return;
  }
  process.stdout.write(page(dpi, 0));
}

/** A plain page the size of the glass (A4 width plus a little, like most flatbeds). */
function page(dpi, n) {
  const w = Math.round(8.5 * dpi), h = Math.round(11.69 * dpi);
  const ink = [60, 60, 60], paper = [246, 245, 240];
  return png(w, h, (x, y) => {
    const fx = x / w, fy = y / h;
    if (fy > 0.08 && fy < 0.11 && fx > 0.1 && fx < 0.7 - n * 0.1) return ink;
    for (let i = 0; i < 14; i++) {
      const top = 0.16 + i * 0.035;
      if (fy > top && fy < top + 0.008 && fx > 0.1 && fx < 0.85 - (i % 3) * 0.08) return ink;
    }
    return paper;
  });
}
