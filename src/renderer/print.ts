// SPDX-License-Identifier: GPL-3.0-or-later
// Printing. The document is saved to memory first (so every mark, form
// value, crop and watermark is exactly as it will be in the file), each page
// is drawn as a sharp picture, and Inkleaf shows those pictures as a preview,
// with a choice of which pages to print. Then the system print dialog takes
// it from there (on Windows that dialog has no preview of its own).

import { t } from '../shared/i18n';
import type { EditorDoc } from './document';
import { parseRanges } from './page-tools';
import { loadPdf } from './pdf';
import { h, modal } from './ui';

/** Print resolution. 200 dpi is crisp on paper without huge memory use. */
const DPI = 200;
const MAX_SIDE = 4200;

/**
 * Prints `doc`. `current` is the page on screen (zero-based), offered as
 * "Current page" in the preview.
 */
export async function printDocument(doc: EditorDoc, progress: (done: number, total: number) => void, current = 0, beforePreview?: () => void): Promise<void> {
  const { exportPdf } = await import('./exporter');
  const { bytes } = await exportPdf(doc);
  // phones print the PDF itself, which is sharper and lighter than pictures of the pages
  if (window.inkleaf.printPdf) {
    progress(1, 1);
    return window.inkleaf.printPdf(doc.name, bytes);
  }
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
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('Couldn’t prepare a page for printing')))), 'image/jpeg', 0.92));
      canvas.width = canvas.height = 0;
      urls.push(URL.createObjectURL(blob));
    }
    progress(pdf.numPages, pdf.numPages);
    beforePreview?.();
    const chosen = await choosePages(urls, Math.min(current, urls.length - 1));
    if (!chosen) return;
    for (const i of chosen) {
      const img = document.createElement('img');
      img.src = urls[i];
      img.alt = '';
      root.append(img);
    }
    document.body.append(root);
    await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    document.documentElement.classList.add('printing');
    const result = await window.inkleaf.print();
    if (!result.ok && result.reason && !/cancel/i.test(result.reason)) throw new Error(t('Printing didn’t work: {reason}', { reason: result.reason }));
  } finally {
    document.documentElement.classList.remove('printing');
    root.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    pdf.loadingTask.destroy();
  }
}

/**
 * The preview: every page as it will print, and which of them to print.
 * Returns the chosen pages (zero-based, in order), or null if cancelled.
 */
async function choosePages(urls: string[], current: number): Promise<number[] | null> {
  const total = urls.length;
  let chosen = urls.map((_, i) => i);

  const sheets = urls.map((url, i) => h('figure', { class: 'print-sheet' },
    h('img', { src: url, alt: t('Page {n}', { n: i + 1 }), loading: 'lazy' }),
    h('figcaption', {}, String(i + 1))));
  const pages = h('div', { class: 'print-preview', role: 'list' }, ...sheets);

  const choice = (value: string, label: string, checked = false) =>
    h('label', { class: 'print-choice' }, h('input', { type: 'radio', name: 'print-pages', value, checked }), h('span', {}, label));
  const all = choice('all', t('All pages ({n})', { n: total }), true);
  const one = choice('current', t('Current page ({n})', { n: current + 1 }));
  const some = choice('some', t('Pages:'));
  const range = h('input', { class: 'field-input print-range', type: 'text', placeholder: t('e.g. 1-3, 5'), spellcheck: 'false', 'aria-label': t('Pages to print') }) as HTMLInputElement;
  some.append(range);
  const summary = h('p', { class: 'field-hint print-summary' });
  const error = h('p', { class: 'field-error' });

  const update = () => {
    const mode = (pagesForm.querySelector<HTMLInputElement>('input[name="print-pages"]:checked'))?.value;
    error.textContent = '';
    if (mode === 'current') chosen = [current];
    else if (mode === 'some') {
      const parsed = range.value.trim() ? parseRanges(range.value, total) : t('Enter at least one page.');
      if (typeof parsed === 'string') {
        chosen = [];
        if (range.value.trim()) error.textContent = parsed;
      } else chosen = parsed.flat();
    } else chosen = urls.map((_, i) => i);
    const on = new Set(chosen);
    sheets.forEach((sheet, i) => sheet.classList.toggle('skipped', !on.has(i)));
    summary.textContent = t('{count, plural, one {# page will print.} other {# pages will print.}}', { count: chosen.length });
  };
  const pagesForm = h('div', { class: 'print-options' }, all, one, total > 1 ? some : '', summary, error);
  if (total < 2) one.remove();
  pagesForm.addEventListener('change', update);
  range.addEventListener('input', () => {
    some.querySelector('input')!.checked = true;
    update();
  });
  range.addEventListener('focus', () => {
    some.querySelector('input')!.checked = true;
    update();
  });
  // clicking a page in the preview prints just that one
  sheets.forEach((sheet, i) => sheet.addEventListener('click', () => {
    if (total < 2) return;
    some.querySelector('input')!.checked = true;
    range.value = String(i + 1);
    update();
  }));
  update();

  const answer = await modal({
    title: t('Print preview'),
    wide: true,
    body: h('div', { class: 'print-dialog' }, pages, pagesForm),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Print…'), value: 'print', primary: true }],
    validate: (value) => {
      if (value !== 'print') return true;
      update();
      if (chosen.length) return true;
      error.textContent ||= t('Enter at least one page.');
      range.focus();
      return false;
    },
    onOpen: () => sheets[current]?.scrollIntoView({ block: 'nearest' }),
  });
  return answer === 'print' ? chosen : null;
}
