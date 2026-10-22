// SPDX-License-Identifier: GPL-3.0-or-later
// Printing. The document is saved to memory first (so every mark, form
// value, crop and watermark is exactly as it will be in the file), each page
// is drawn as a sharp picture, and the system print dialog takes it from
// there.

import type { EditorDoc } from './document';
import { loadPdf } from './pdf';

/** Print resolution. 200 dpi is crisp on paper without huge memory use. */
const DPI = 200;
const MAX_SIDE = 4200;

export async function printDocument(doc: EditorDoc, progress: (done: number, total: number) => void): Promise<void> {
  const { exportPdf } = await import('./exporter');
  const { bytes } = await exportPdf(doc);
  const pdf = await loadPdf(bytes);
  const root = document.createElement('div');
  root.id = 'print-root';
  const urls: string[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      progress(i - 1, pdf.numPages);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t prepare a page for printing'))), 'image/jpeg', 0.92));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      root.append(img);
    }
    progress(pdf.numPages, pdf.numPages);
    document.body.append(root);
    await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    document.documentElement.classList.add('printing');
    const result = await window.inkleaf.print();
    if (!result.ok && result.reason && !/cancel/i.test(result.reason)) throw new Error(`Printing didn’t work: ${result.reason}`);
  } finally {
    document.documentElement.classList.remove('printing');
    root.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    pdf.loadingTask.destroy();
  }
}
