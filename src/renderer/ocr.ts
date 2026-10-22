// SPDX-License-Identifier: GPL-3.0-or-later
// Text recognition (OCR) for scanned pages, fully offline.
//
// Each chosen page is drawn as a 300 dpi picture and read by Tesseract,
// which hands back a PDF holding only invisible text in the right places.
// That layer is laid over the original page, so the scan looks exactly the
// same but its words can now be found, selected, copied and edited.

import { createWorker, OEM } from 'tesseract.js';
import type { EditorDoc } from './document';
import { pageRuns } from './text-finder';
import { pageViewport } from './pdf';
import type { PageRef } from './types';
import { h, modal } from './ui';

const LANGUAGES = [
  { code: 'eng', name: 'English' },
  { code: 'hin', name: 'Hindi' },
  { code: 'ben', name: 'Bengali' },
  { code: 'ita', name: 'Italian' },
];

const DPI = 300;
/** Largest picture side we hand Tesseract; bigger only slows it down. */
const MAX_SIDE = 5000;

const base = new URL('./vendor/tesseract/', location.href).href;

interface Choice {
  langs: string[];
  pages: PageRef[];
}

async function hasText(doc: EditorDoc, ref: PageRef): Promise<boolean> {
  const page = await doc.sources.get(ref.src)!.pdf.getPage(ref.index + 1);
  const runs = await pageRuns(page);
  return runs.reduce((n, r) => n + r.str.trim().length, 0) > 15;
}

async function ask(doc: EditorDoc, currentPageId: string | null): Promise<Choice | null> {
  let remembered: string[] = ['eng'];
  try {
    remembered = JSON.parse(localStorage.getItem('inkleaf.ocr-langs') ?? '["eng"]');
  } catch {
    // keep English
  }
  const boxes = LANGUAGES.map((l) => ({ code: l.code, input: h('input', { type: 'checkbox', checked: remembered.includes(l.code) }), name: l.name }));
  const which = h('select', { class: 'field-input' },
    new Option('Pages without text (scans)', 'scans'),
    new Option('Every page', 'all'),
    new Option('Only the current page', 'current'));
  const error = h('p', { class: 'field-error' });
  const go = await modal({
    title: 'Recognise text (OCR)',
    body: h('div', {},
      h('p', { class: 'modal-text' }, 'Reads the words in scanned pages so you can search, copy and edit them. The pages look exactly the same afterwards. Everything happens on this computer.'),
      h('span', { class: 'field-label spaced' }, 'Languages in the document'),
      h('div', { class: 'check-grid' }, ...boxes.map((b) => h('label', { class: 'check' }, b.input, ` ${b.name}`))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Pages'), which),
      error),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Recognise text', value: 'ok', primary: true }],
    validate: () => {
      const any = boxes.some((b) => b.input.checked);
      error.textContent = any ? '' : 'Choose at least one language.';
      return any;
    },
  });
  if (go !== 'ok') return null;
  const langs = boxes.filter((b) => b.input.checked).map((b) => b.code);
  try {
    localStorage.setItem('inkleaf.ocr-langs', JSON.stringify(langs));
  } catch {
    // fine
  }

  let pages: PageRef[];
  if (which.value === 'current') {
    const ref = currentPageId ? doc.page(currentPageId) : doc.pages[0];
    pages = ref ? [ref] : [];
  } else if (which.value === 'all') {
    pages = [...doc.pages];
  } else {
    const flags = await Promise.all(doc.pages.map((p) => hasText(doc, p)));
    pages = doc.pages.filter((_, i) => !flags[i]);
  }
  return { langs, pages };
}

/** Draws a page upright, as you see it, for reading. */
async function picture(doc: EditorDoc, ref: PageRef): Promise<HTMLCanvasElement> {
  const page = await doc.sources.get(ref.src)!.pdf.getPage(ref.index + 1);
  const rotation = doc.displayRotation(ref);
  const probe = pageViewport(page, 1, rotation);
  const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(probe.width, probe.height));
  const viewport = pageViewport(page, scale, rotation);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * Runs OCR and lays the text over the pages. Resolves to the number of pages
 * that got text, or null if cancelled.
 */
export async function recognise(doc: EditorDoc, currentPageId: string | null, progress: (message: string) => void, withBusy: <T>(m: string, w: () => Promise<T>) => Promise<T>): Promise<{ pages: number; words: number } | null> {
  const choice = await ask(doc, currentPageId);
  if (!choice) return null;
  if (!choice.pages.length) {
    await modal({ title: 'Nothing to read', body: 'Every page already has text. To read them again anyway, choose “Every page”.' });
    return null;
  }

  return withBusy('Starting text recognition…', async () => {
    let pageNo = 0;
    const worker = await createWorker(choice.langs, OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core`,
      langPath: `${base}lang`,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') {
          progress(`Reading page ${pageNo} of ${choice.pages.length}… ${Math.round(m.progress * 100)}%`);
        } else if (/loading/.test(m.status)) {
          progress('Loading languages…');
        }
      },
    });
    try {
      await worker.setParameters({ user_defined_dpi: String(DPI) });
      // results per source file, so each file is rebuilt once
      const layers = new Map<string, { ref: PageRef; pdf: Uint8Array }[]>();
      let words = 0;
      for (const ref of choice.pages) {
        pageNo++;
        progress(`Reading page ${pageNo} of ${choice.pages.length}…`);
        const canvas = await picture(doc, ref);
        const { data } = await worker.recognize(canvas, { pdfTextOnly: true, pdfTitle: doc.name }, { pdf: true, text: true });
        canvas.width = canvas.height = 0;
        const text = data.text ?? '';
        words += text.split(/\s+/).filter(Boolean).length;
        if (!text.trim() || !data.pdf) continue;
        const list = layers.get(ref.src) ?? [];
        list.push({ ref, pdf: new Uint8Array(data.pdf as ArrayLike<number>) });
        layers.set(ref.src, list);
      }

      progress('Adding the text to the document…');
      const { PDFDocument, degrees } = await import('pdf-lib');
      let pages = 0;
      for (const [srcId, list] of layers) {
        const source = doc.sources.get(srcId)!;
        const out = await PDFDocument.load(source.bytes, { updateMetadata: false });
        for (const { ref, pdf } of list) {
          const [layer] = await out.embedPdf(pdf, [0]);
          const page = out.getPage(ref.index);
          const [x0, y0, x1, y1] = source.pages[ref.index].view;
          const rotation = doc.displayRotation(ref);
          const sideways = rotation % 180 !== 0;
          const width = sideways ? y1 - y0 : x1 - x0;
          const height = sideways ? x1 - x0 : y1 - y0;
          // the text was read from the page as displayed; turn it back into
          // the page's own coordinates
          const origin: Record<number, [number, number]> = { 0: [x0, y0], 90: [x1, y0], 180: [x1, y1], 270: [x0, y1] };
          const [x, y] = origin[rotation] ?? [x0, y0];
          page.drawPage(layer, { x, y, width, height, rotate: degrees(rotation) });
          pages++;
        }
        await doc.replaceSource(srcId, await out.save({ useObjectStreams: true }));
      }
      return { pages, words };
    } finally {
      await worker.terminate();
    }
  });
}
