// SPDX-License-Identifier: GPL-3.0-or-later
// Repairing damaged PDFs, trying the gentlest fix first:
//
// 1. Rebuild. The Rust core reads every object it can find (rebuilding a
//    broken cross-reference table by scanning the file) and writes a clean
//    copy. Text, fonts, forms and links all survive.
// 2. Re-read. pdf-lib reads the file from top to bottom, ignoring the parts
//    that point to where things should be, and saves what it found.
// 3. Redraw. If the structure is beyond saving but the pages can still be
//    drawn, each page is drawn as a picture into a new PDF. It looks right,
//    but the text needs OCR to become searchable again.

import { t } from '../shared/i18n';
import { core } from './core';
import { loadPdf } from './pdf';

export interface Repaired {
  bytes: Uint8Array;
  pages: number;
  method: 'rebuilt' | 'reread' | 'redrawn';
}

/** Opens the result the way Inkleaf will, to be sure the repair worked. */
async function usable(bytes: Uint8Array): Promise<number> {
  const pdf = await loadPdf(bytes);
  try {
    if (!pdf.numPages) return 0;
    await (await pdf.getPage(1)).getOperatorList();
    return pdf.numPages;
  } finally {
    pdf.loadingTask.destroy();
  }
}

/**
 * A file that was cut off near the end (an interrupted download, a full
 * disk) usually has every page but no index or trailer, and without a
 * trailer nothing knows where the document starts. This finds the objects
 * by scanning for them, drops a half-written last one, and writes a fresh
 * index and trailer pointing at the catalog.
 */
export function withNewTrailer(bytes: Uint8Array): Uint8Array | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const offsets = new Map<number, number>();
  let end = 0;
  let root = 0;
  const objects = /(?:^|[\r\n\s])(\d{1,7})\s+(\d{1,5})\s+obj\b/g;
  for (let m; (m = objects.exec(text)); ) {
    const start = m.index + (m[0].length - m[0].trimStart().length);
    const close = text.indexOf('endobj', start);
    if (close < 0) break; // the half-written one at the end
    const next = text.slice(start, close);
    // a later "obj" before this one's "endobj" means this one was broken off
    if (/\d\s+\d+\s+obj\b/.test(next.slice(m[0].trim().length))) continue;
    const num = Number(m[1]);
    offsets.set(num, start);
    if (/\/Type\s*\/Catalog\b/.test(next)) root = num;
    end = close + 'endobj'.length;
  }
  if (!root || !offsets.size) return null;
  const size = Math.max(...offsets.keys()) + 1;
  const rows = ['0000000000 65535 f \n'];
  for (let i = 1; i < size; i++) {
    const at = offsets.get(i);
    rows.push(at === undefined ? '0000000000 65535 f \n' : `${String(at).padStart(10, '0')} 00000 n \n`);
  }
  const xrefAt = end + 1;
  const tail = `\nxref\n0 ${size}\n${rows.join('')}trailer\n<< /Size ${size} /Root ${root} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const out = new Uint8Array(end + tail.length);
  out.set(bytes.subarray(0, end));
  for (let i = 0; i < tail.length; i++) out[end + i] = tail.charCodeAt(i);
  return out;
}

export async function repairPdf(bytes: Uint8Array, progress: (message: string) => void): Promise<Repaired> {
  progress(t('Rebuilding the file…'));
  try {
    const { pdf } = await core.repair(bytes);
    const pages = await usable(pdf);
    if (pages) return { bytes: pdf, pages, method: 'rebuilt' };
  } catch {
    // on to the next approach
  }

  // a missing trailer: write a new one, then tidy up the result as above
  const retrailed = withNewTrailer(bytes);
  if (retrailed) {
    try {
      const { pdf } = await core.repair(retrailed).catch(() => ({ pdf: retrailed }));
      const pages = await usable(pdf);
      if (pages) return { bytes: pdf, pages, method: 'rebuilt' };
    } catch {
      // on to the next approach
    }
    bytes = retrailed;
  }

  progress(t('Reading what’s left of the file…'));
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
    if (doc.getPageCount()) {
      const out = await doc.save({ useObjectStreams: true });
      const pages = await usable(out);
      if (pages) return { bytes: out, pages, method: 'reread' };
    }
  } catch {
    // on to the last resort
  }

  progress(t('Redrawing the pages…'));
  let source;
  try {
    source = await loadPdf(bytes);
  } catch {
    throw new Error(t('This file is too badly damaged: no pages could be recovered from it.'));
  }
  try {
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    let drawn = 0;
    for (let n = 1; n <= source.numPages; n++) {
      progress(t('Redrawing page {n} of {numPages}…', { n, numPages: source.numPages }));
      try {
        const page = await source.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 200 / 72 });
        const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext('2d', { alpha: false })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
        const jpg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
        const image = await out.embedJpg(jpg);
        out.addPage([base.width, base.height]).drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
        drawn++;
      } catch {
        // a page that can't be drawn at all is skipped
      }
    }
    if (!drawn) throw new Error(t('This file is too badly damaged: no pages could be recovered from it.'));
    return { bytes: await out.save(), pages: drawn, method: 'redrawn' };
  } finally {
    source.loadingTask.destroy();
  }
}
