// SPDX-License-Identifier: GPL-3.0-or-later
// Text recognition (OCR) for scanned pages, fully offline.
//
// Each chosen page is drawn as a 300 dpi picture and read by Tesseract,
// which hands back a PDF holding only invisible text in the right places.
// That layer is laid over the original page, so the scan looks exactly the
// same but its words can now be found, selected, copied and edited.

import { isMobile, packUrl } from '../shared/platform';
import { t } from '../shared/i18n';
import { createWorker, OEM } from 'tesseract.js';
import type { EditorDoc } from './document';
import { pageRuns } from './text-finder';
import { PDF_LIB_STEP, pageViewport } from './pdf';
import type { PageRef } from './types';
import { h, icon, modal } from './ui';
import { BUILT_IN_OCR, LANGUAGES as ALL_LANGUAGES, languageLabel, languageName } from '../shared/languages';

/** Every language text recognition can read, by its Tesseract code. */
const LANGUAGES = ALL_LANGUAGES.filter((l) => l.ocr).map((l) => ({ code: l.ocr!, name: languageName(l.name), native: l.native, label: languageLabel(l) }));
const packName = (code: string) => `ocr/${code}.traineddata.gz`;

const DPI = 300;
/** Largest picture side we hand Tesseract; bigger only slows it down. */
const MAX_SIDE = 5000;

const base = new URL('./vendor/tesseract/', location.href).href;
// models that ship with the app and downloaded ones are served from one place
const langPath = new URL(packUrl('ocr'), location.href).href;

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
  const status = await window.inkleaf.packStatus().catch(() => ({} as Record<string, { size: number; installed: boolean }>));
  const ready = (code: string) => BUILT_IN_OCR.has(code) || !!status[packName(code)]?.installed;
  const sizeOf = (code: string) => `${Math.max(1, Math.round((status[packName(code)]?.size ?? 2e6) / 1048576))} MB`;

  // chosen languages show as chips; any other can be added from the list
  const chosen = new Set(remembered.filter((c) => LANGUAGES.some((l) => l.code === c)));
  if (!chosen.size) chosen.add('eng');
  const chips = h('div', { class: 'lang-chips' });
  const add = h('select', { class: 'field-input' }) as HTMLSelectElement;
  const note = h('p', { class: 'field-hint' });
  const refresh = () => {
    chips.replaceChildren(...[...chosen].map((code) => {
      const l = LANGUAGES.find((x) => x.code === code)!;
      const remove = h('button', { class: 'chip-x', title: t('Remove {name}', { name: l.name }) }, icon('x'));
      remove.addEventListener('click', () => {
        chosen.delete(code);
        refresh();
      });
      return h('span', { class: 'lang-chip' }, l.name, ready(code) ? '' : h('span', { class: 'chip-dl', title: t('Downloads once, then works offline') }, `↓ ${sizeOf(code)}`), remove);
    }));
    add.replaceChildren(new Option(t('Add a language…'), ''), ...LANGUAGES.filter((l) => !chosen.has(l.code)).map((l) =>
      new Option(ready(l.code) ? l.label : t('{language} (download {size})', { language: l.label, size: sizeOf(l.code) }), l.code)));
    const downloads = [...chosen].filter((c) => !ready(c));
    note.textContent = downloads.length
      ? (isMobile() ? t('Languages marked ↓ are downloaded once from jsDelivr, then work offline. Your pages never leave this phone.') : t('Languages marked ↓ are downloaded once from jsDelivr, then work offline. Your pages never leave this computer.'))
      : isMobile() ? t('Everything happens on this phone.') : t('Everything happens on this computer.');
  };
  add.addEventListener('change', () => {
    if (add.value) chosen.add(add.value);
    refresh();
  });
  refresh();
  const which = h('select', { class: 'field-input' },
    new Option(t('Pages without text (scans)'), 'scans'),
    new Option(t('Every page'), 'all'),
    new Option(t('Only the current page'), 'current'));
  const error = h('p', { class: 'field-error' });
  const go = await modal({
    title: t('Recognise text (OCR)'),
    body: h('div', {},
      h('p', { class: 'modal-text' }, t('Reads the words in scanned pages so you can search, copy and edit them. The pages look exactly the same afterwards.')),
      h('span', { class: 'field-label spaced' }, t('Languages in the document')),
      chips,
      add,
      note,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Pages')), which),
      error),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Recognise text'), value: 'ok', primary: true }],
    validate: () => {
      const any = chosen.size > 0;
      error.textContent = any ? '' : t('Choose at least one language.');
      return any;
    },
  });
  if (go !== 'ok') return null;
  const langs = [...chosen];
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
    await modal({ title: t('Nothing to read'), body: t('Every page already has text. To read them again anyway, choose “Every page”.') });
    return null;
  }

  return withBusy(t('Starting text recognition…'), async () => {
    const missing = choice.langs.filter((c) => !BUILT_IN_OCR.has(c)).map(packName);
    if (missing.length) {
      progress(t('Downloading languages…'));
      await window.inkleaf.ensurePacks(missing);
    }
    const total = choice.pages.length;
    // Several pages are read at once, one per reader: a reader per processor
    // core (leaving one for the window), at least two and at most four. Each
    // takes the next page as soon as it's done with one.
    const cores = navigator.hardwareConcurrency || 2;
    const count = Math.min(total, 4, Math.max(2, cores - 1));
    let done = 0;
    const reading = () => progress(t('Reading page {n} of {total}…', { n: Math.min(done + 1, total), total }));
    const start = () => createWorker(choice.langs, OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core`,
      langPath,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (m: { status: string; progress: number }) => {
        // a percentage only makes sense with one page at a time
        if (m.status === 'recognizing text' && count === 1) {
          progress(t('Reading page {n} of {total}… {percent}%', { n: done + 1, total, percent: Math.round(m.progress * 100) }));
        } else if (/loading/.test(m.status) && !done) {
          progress(t('Loading languages…'));
        }
      },
    });
    const started = await Promise.allSettled(Array.from({ length: count }, start));
    const workers = started.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = started.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    try {
      if (failed) throw failed.reason;
      await Promise.all(workers.map((w) => w.setParameters({ user_defined_dpi: String(DPI) })));
      const found: (Uint8Array | null)[] = new Array(total).fill(null);
      let words = 0;
      let next = 0;
      reading();
      await Promise.all(workers.map(async (worker) => {
        while (next < total) {
          const i = next++;
          const canvas = await picture(doc, choice.pages[i]);
          const { data } = await worker.recognize(canvas, { pdfTextOnly: true, pdfTitle: doc.name }, { pdf: true, text: true });
          canvas.width = canvas.height = 0;
          done++;
          reading();
          const text = data.text ?? '';
          words += text.split(/\s+/).filter(Boolean).length;
          if (text.trim() && data.pdf) found[i] = new Uint8Array(data.pdf as ArrayLike<number>);
        }
      }));

      // results per source file, in page order, so each file is rebuilt once
      const layers = new Map<string, { ref: PageRef; pdf: Uint8Array }[]>();
      choice.pages.forEach((ref, i) => {
        const pdf = found[i];
        if (!pdf) return;
        const list = layers.get(ref.src) ?? [];
        list.push({ ref, pdf });
        layers.set(ref.src, list);
      });

      progress(t('Adding the text to the document…'));
      const { PDFDocument, degrees } = await import('pdf-lib');
      let pages = 0;
      for (const [srcId, list] of layers) {
        const source = doc.sources.get(srcId)!;
        const out = await PDFDocument.load(source.bytes, { updateMetadata: false, parseSpeed: PDF_LIB_STEP });
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
        await doc.replaceSource(srcId, await out.save({ useObjectStreams: true, objectsPerTick: PDF_LIB_STEP }));
      }
      return { pages, words };
    } finally {
      await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
    }
  });
}
