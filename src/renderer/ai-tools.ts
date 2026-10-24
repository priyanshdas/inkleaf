// SPDX-License-Identifier: GPL-3.0-or-later
// AI Summarizer and Translate PDF.
//
// These are the only tools that send anything off the computer, so they're
// off until the person adds their own Anthropic API key, and each one says
// plainly, before it runs, that the document's text will be sent.

import type { EditorDoc } from './document';
import { BASELINE, lineWidth, prepareFonts } from './fonts';
import { setHanScript } from './script-fonts';
import { LANGUAGES as ALL_LANGUAGES } from '../shared/languages';
import { newId, rotateVec } from './geometry';
import type { PDFDocumentProxy } from './pdf';
import type { PageStructure } from './pdf-structure';
import { pageRuns, runBox, TextRun } from './text-finder';
import type { ReplaceAnnot } from './types';
import { h, icon, modal, toast } from './ui';

const api = () => window.inkleaf;

export interface AiHost {
  withBusy<T>(message: string, work: () => Promise<T>): Promise<T>;
  progress(message: string): void;
  openDoc(doc: EditorDoc): void;
  currentPageId(): string | null;
}


const PRIVACY = 'This sends the document’s text to Anthropic (the company behind Claude) using your API key. Nothing else leaves your computer.';

// --- settings -----------------------------------------------------------------------

/** Asks for (or changes) the API key. Resolves true if AI is ready afterwards. */
export async function aiSettings(): Promise<boolean> {
  const status = await api().aiStatus();
  const key = h('input', { class: 'field-input', type: 'password', placeholder: status.ready ? 'A key is saved. Paste a new one to replace it.' : 'sk-ant-…', autocomplete: 'off', spellcheck: 'false' });
  const model = h('select', { class: 'field-input' }, new Option('Fast and cheap (Claude Haiku)', 'fast'), new Option('Best quality (Claude Sonnet)', 'best'));
  model.value = status.model;
  const error = h('p', { class: 'field-error' });
  const buttons = [
    ...(status.ready ? [{ label: 'Remove key', value: 'remove', danger: true }] : []),
    { label: 'Cancel', value: 'cancel' },
    { label: 'Save', value: 'ok', primary: true },
  ];
  const choice = await modal({
    title: 'AI tools',
    body: h('div', {},
      h('p', { class: 'modal-text' }, 'The AI Summarizer and Translate PDF use Claude, from Anthropic, with your own API key. You pay Anthropic directly for what you use, usually a fraction of a rupee per page.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Anthropic API key'), key,
        h('span', { class: 'field-hint' }, 'Get one at console.anthropic.com. It’s stored encrypted on this computer and only ever sent to Anthropic.')),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Model'), model),
      error),
    buttons,
    validate: async (value) => {
      if (value !== 'ok') return true;
      try {
        if (key.value.trim()) await api().aiSetKey(key.value, model.value as 'fast' | 'best');
        else if (status.ready) await api().aiSetModel(model.value as 'fast' | 'best');
        else throw new Error('Paste your API key first.');
        return true;
      } catch (err) {
        error.textContent = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        return false;
      }
    },
  });
  if (choice === 'remove') {
    await api().aiRemoveKey();
    toast('The API key was removed from this computer.');
    return false;
  }
  return choice === 'ok' || status.ready;
}

async function ensureReady(): Promise<boolean> {
  if ((await api().aiStatus()).ready) return true;
  return aiSettings();
}

// --- reading the document --------------------------------------------------------------

async function exported(doc: EditorDoc): Promise<PDFDocumentProxy> {
  const [{ exportPdf }, { loadPdf }] = await Promise.all([import('./exporter'), import('./pdf')]);
  return loadPdf((await exportPdf(doc)).bytes);
}

async function pageTexts(pdf: PDFDocumentProxy): Promise<string[]> {
  const out: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const runs = await pageRuns(await pdf.getPage(n));
    out.push(runs.map((r) => r.str).join('\n'));
  }
  return out;
}

const NO_TEXT = 'This document has no text to work with. If it’s a scan, run Tools › Recognise text (OCR) first.';

// --- summarizer --------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function summarize(doc: EditorDoc, host: AiHost) {
  if (!(await ensureReady())) return;
  const length = h('select', { class: 'field-input' },
    new Option('Short: a few sentences', 'short'),
    new Option('Detailed: key points, numbers and dates', 'detailed'));
  const language = h('select', { class: 'field-input' }, new Option('Same as the document', ''), ...ALL_LANGUAGES.map((l) => new Option(l.native === l.name ? l.name : `${l.name} · ${l.native}`, l.name)));
  const go = await modal({
    title: 'AI Summarizer',
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Length'), length),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Write it in'), language),
      h('p', { class: 'field-hint warn' }, icon('info'), PRIVACY)),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Summarize', value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;

  const summary = await host.withBusy('Reading the document…', async () => {
    const pdf = await exported(doc);
    let texts: string[];
    try {
      texts = await pageTexts(pdf);
    } finally {
      pdf.loadingTask.destroy();
    }
    const full = texts.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
    if (!texts.join('').trim()) throw new Error(NO_TEXT);
    const style = length.value === 'short'
      ? 'Write a short summary: three to five sentences of plain prose.'
      : 'Write a detailed summary: a one-sentence overview, then the key points as a bulleted list, including important names, numbers, amounts and dates, citing page numbers in brackets like (p. 3).';
    const lang = language.value ? `Write the summary in ${language.value}.` : 'Write the summary in the same language as the document.';
    const system = 'You summarize documents accurately and plainly. Never invent facts that are not in the document. Use simple Markdown (bullets, bold) only.';

    // very long documents are summarised in parts, then the parts together
    const LIMIT = 120_000;
    if (full.length <= LIMIT) {
      host.progress('Summarizing…');
      return api().aiAsk({ system, prompt: `${style} ${lang}\n\n<document>\n${full}\n</document>`, maxTokens: 2000 });
    }
    const parts: string[] = [];
    for (let i = 0; i < full.length; i += LIMIT) parts.push(full.slice(i, i + LIMIT));
    const notes: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      host.progress(`Summarizing part ${i + 1} of ${parts.length}…`);
      notes.push(await api().aiAsk({ system, prompt: `This is part ${i + 1} of ${parts.length} of a long document. List its key points, keeping page numbers.\n\n<document>\n${parts[i]}\n</document>`, maxTokens: 2000 }));
    }
    host.progress('Putting it together…');
    return api().aiAsk({ system, prompt: `${style} ${lang}\n\nThese are notes on each part of one long document:\n\n${notes.join('\n\n---\n\n')}`, maxTokens: 2500 });
  });

  const { marked } = await import('marked');
  const html = await marked.parse(escapeHtml(summary), { gfm: true });
  const body = h('div', { class: 'ai-summary' });
  body.innerHTML = html; // escaped above: only Markdown's own tags are left
  const choice = await modal({
    title: 'Summary',
    wide: true,
    body,
    buttons: [
      { label: 'Add as a comment', value: 'note' },
      { label: 'Copy', value: 'copy' },
      { label: 'Close', value: 'close', primary: true },
    ],
  });
  if (choice === 'copy') {
    await navigator.clipboard.writeText(summary).catch(() => {});
    toast('Summary copied.', 'success');
  }
  if (choice === 'note') {
    const first = doc.pages[0];
    const author = (() => {
      try {
        return localStorage.getItem('inkleaf.author') ?? '';
      } catch {
        return '';
      }
    })();
    const box = doc.viewBox(first);
    doc.addAnnot(first.id, { id: newId('note'), type: 'note', x: box.x + box.w - 44, y: box.y + box.h - 44, w: 20, h: 20, text: `AI summary\n\n${summary}`, color: '#c9b6ff', author: author || 'AI summary', created: Date.now() });
    doc.commit();
    toast('Added the summary as a comment on page 1.', 'success');
  }
}

// --- translation ----------------------------------------------------------------------------

/** Translates lines in batches, keeping them one-for-one. */
async function translateLines(lines: string[], language: string, host: AiHost, label: string): Promise<string[]> {
  const out: string[] = new Array(lines.length);
  const system = `You are a professional translator. Translate each line of the JSON array into ${language}. Keep numbers, names, codes, email addresses and URLs as they are. Reply with only a JSON array of strings, exactly as long as the input, in the same order. Lines that are only numbers or symbols stay unchanged.`;
  let start = 0;
  let batch = 0;
  const batches = Math.max(1, Math.ceil(lines.join('').length / 6000));
  while (start < lines.length) {
    let end = start, size = 0;
    while (end < lines.length && end - start < 120 && size < 6000) size += lines[end++].length + 4;
    const chunk = lines.slice(start, end);
    batch++;
    host.progress(`${label} (${Math.min(batch, batches)} of ${batches})…`);
    let result: string[] | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const reply = await api().aiAsk({ system, prompt: `<lines>${JSON.stringify(chunk)}</lines>`, maxTokens: Math.min(16000, size * 3 + 500) });
      try {
        const json = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1));
        if (Array.isArray(json) && json.length === chunk.length) result = json.map((v) => String(v));
      } catch {
        // asked again below
      }
    }
    // lines that came back garbled stay in the original language
    chunk.forEach((line, i) => (out[start + i] = result ? result[i] : line));
    start = end;
  }
  return out;
}

/** A replacement that puts translated words where the original line was. */
function overlay(run: TextRun, text: string): ReplaceAnnot {
  const style = { font: run.font, bold: run.bold, italic: run.italic };
  let size = Math.round(run.size * 10) / 10;
  const natural = lineWidth(style, text, size);
  // squeeze longer translations into the original width, within reason
  if (natural > run.width * 1.08) size = Math.max(size * 0.6, (size * run.width * 1.05) / natural);
  const [dx, dy] = rotateVec(0, size * BASELINE, run.angle);
  return {
    id: newId('r'), type: 'replace', x: run.x + dx, y: run.y + dy, angle: run.angle,
    text, original: run.str, size, ...style, color: '#1a1a1a',
    cover: { ...runBox(run), color: '#ffffff' },
  };
}

export async function translate(doc: EditorDoc, host: AiHost) {
  if (!(await ensureReady())) return;
  const language = h('select', { class: 'field-input' }, ...ALL_LANGUAGES.map((l) => new Option(l.native === l.name ? l.name : `${l.name} · ${l.native}`, l.name)));
  language.value = 'English';
  const how = h('select', { class: 'field-input' },
    new Option('Over the original pages (keeps the layout)', 'pages'),
    new Option('As a Word document', 'word'));
  const which = h('select', { class: 'field-input' }, new Option('Every page', 'all'), new Option('Only the current page', 'current'));
  const note = h('p', { class: 'field-hint' });
  const sync = () => {
    const laidOver = how.value === 'pages';
    const cjk = /Chinese|Japanese|Korean/.test(language.value);
    note.textContent = laidOver
      ? `Opens a translated copy in a new tab. Each line is replaced where it was; your original isn’t changed.${cjk ? ' The first time, Inkleaf downloads a font for this language (about 15 MB).' : ''}`
      : 'Saves the translated text as a Word file, with its headings and paragraphs.';
  };
  language.addEventListener('change', sync);
  how.addEventListener('change', sync);
  sync();
  const go = await modal({
    title: 'Translate PDF',
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Translate into'), language),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Result'), how),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Pages'), which),
      note,
      h('p', { class: 'field-hint warn' }, icon('info'), PRIVACY)),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Translate', value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;

  const target = language.value;
  const asWord = how.value === 'word';
  // Chinese characters take the shapes of the language they're written in
  if (target === 'Chinese (Traditional)') setHanScript('tc');
  else if (target === 'Chinese (Simplified)') setHanScript('sc');
  const current = host.currentPageId();
  const pageIds = which.value === 'current' && current ? [current] : undefined;
  const [{ exportPdf }, { loadPdf }] = await Promise.all([import('./exporter'), import('./pdf')]);

  if (asWord) {
    const bytes = await host.withBusy('Reading the document…', async () => {
      const pdf = await loadPdf((await exportPdf(doc, pageIds)).bytes);
      try {
        const { documentStructure } = await import('./pdf-structure');
        const pages: PageStructure[] = await documentStructure(pdf, (n, total) => host.progress(`Reading page ${n} of ${total}…`));
        const blocks = pages.flatMap((p) => p.blocks).filter((b) => b.kind !== 'picture') as Extract<PageStructure['blocks'][number], { spans: unknown }>[];
        const texts = blocks.map((b) => b.spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim());
        if (!texts.join('').trim()) throw new Error(NO_TEXT);
        const translated = await translateLines(texts, target, host, `Translating into ${target}`);
        // each block keeps its look, with the translated words in one run
        blocks.forEach((b, i) => {
          const first = b.spans[0];
          b.spans = [{ ...first, text: translated[i], bold: b.kind === 'heading' || first.bold }];
        });
        const { structureToWord } = await import('./word');
        return structureToWord(pages);
      } finally {
        pdf.loadingTask.destroy();
      }
    });
    const path = await api().saveCopy(bytes, `${doc.name.replace(/\.pdf$/i, '')} (${target}).docx`, 'docx');
    if (path) toast(`Saved the ${target} translation.`, 'success');
    return;
  }

  const translatedDoc = await host.withBusy('Reading the document…', async () => {
    const bytes = (await exportPdf(doc, pageIds)).bytes;
    const { EditorDoc } = await import('./document');
    const copy = await EditorDoc.open(bytes, `${doc.name.replace(/\.pdf$/i, '')} (${target}).pdf`, null);
    const source = copy.sources.get(copy.mainSource)!;
    const perPage: TextRun[][] = [];
    for (let i = 0; i < copy.pages.length; i++) perPage.push(await pageRuns(await source.pdf.getPage(i + 1)));
    const all = perPage.flat();
    if (!all.some((r) => r.str.trim())) throw new Error(NO_TEXT);
    const translated = await translateLines(all.map((r) => r.str), target, host, `Translating into ${target}`);
    // fonts for the new language (downloaded for Chinese, Japanese and Korean)
    // must be ready before the lines can be fitted
    host.progress('Preparing fonts…');
    await prepareFonts({ font: 'sans', bold: false, italic: false }, translated.join('\n'));
    await prepareFonts({ font: 'sans', bold: true, italic: false }, translated.join('\n'));
    let k = 0;
    perPage.forEach((runs, i) => {
      for (const run of runs) {
        const text = translated[k++];
        if (text && text.trim() !== run.str.trim()) copy.addAnnot(copy.pages[i].id, overlay(run, text));
      }
    });
    copy.commit();
    copy.markUnsaved();
    return copy;
  });
  host.openDoc(translatedDoc);
  toast(`Translated into ${target}. Check it over, then save it where you like.`, 'success', 6000);
}
