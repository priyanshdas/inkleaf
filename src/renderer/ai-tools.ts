// SPDX-License-Identifier: GPL-3.0-or-later
// AI Summarizer and Translate PDF.
//
// These are the only tools that can send anything off the computer, so
// they're off until the person picks an AI service (their own key for a
// cloud one, or a model running on their own computer), and each tool says
// plainly, before it runs, where the document's text will go.

import { msg, t } from '../shared/i18n';
import { isMobile } from '../shared/platform';
import type { EditorDoc } from './document';
import { BASELINE, lineWidth, prepareFonts } from './fonts';
import { setHanScript } from './script-fonts';
import { LANGUAGES as ALL_LANGUAGES, languageLabel, languageName } from '../shared/languages';
import { newId, rotateVec } from './geometry';
import type { PDFDocumentProxy } from './pdf';
import type { PageStructure } from './pdf-structure';
import { pageRuns, runBox, TextRun } from './text-finder';
import type { ReplaceAnnot } from './types';
import { h, icon, modal, toast } from './ui';
import { AI_PROVIDERS, LOCAL_SERVERS, providerById } from '../shared/ai-providers';

const api = () => window.inkleaf;

export interface AiHost {
  withBusy<T>(message: string, work: () => Promise<T>): Promise<T>;
  progress(message: string): void;
  openDoc(doc: EditorDoc): void;
  currentPageId(): string | null;
}


/** Where the text goes, said plainly before a tool runs. */
async function privacyNote(): Promise<string> {
  const status = await api().aiStatus();
  const provider = providerById(status.provider);
  if (isMobile()) {
    if (provider.onDevice) return t('This sends the document’s text to the AI running on your computer, over your Wi-Fi. Nothing goes through the internet.');
    return t('This sends the document’s text to {company} using your API key. Nothing else leaves your phone.', { company: t(provider.company) });
  }
  if (provider.onDevice) return t('This sends the document’s text to the AI running on this computer. Nothing leaves your computer.');
  return t('This sends the document’s text to {company} using your API key. Nothing else leaves your computer.', { company: t(provider.company) });
}

// --- settings -----------------------------------------------------------------------

const cleanError = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Picks the AI service, its key and model. Resolves true if AI is ready afterwards. */
export async function aiSettings(): Promise<boolean> {
  const status = await api().aiStatus();
  let chosen = providerById(status.provider);
  const hasKey = { ...status.hasKey };

  const key = h('input', { class: 'field-input', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const keyHint = h('span', { class: 'field-hint' });
  const keyField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('API key')), key, keyHint);
  const forget = h('button', { class: 'link-button', type: 'button' }, t('Remove the saved key'));
  forget.addEventListener('click', async () => {
    await api().aiRemoveKey(chosen.id);
    delete hasKey[chosen.id];
    toast(isMobile() ? t('The API key was removed from this phone.') : t('The API key was removed from this computer.'));
    show();
  });

  const url = h('input', { class: 'field-input', type: 'url', spellcheck: 'false', placeholder: isMobile() ? 'http://192.168.1.20:11434/v1' : 'http://localhost:11434/v1' });
  const presets = h('div', { class: 'chip-row' }, ...LOCAL_SERVERS.map((server) => {
    const chip = h('button', { class: 'chip', type: 'button' }, server.name);
    chip.addEventListener('click', () => {
      url.value = server.url;
      void loadModels();
    });
    return chip;
  }));
  const urlField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Server address')), url, presets);

  const model = h('input', { class: 'field-input', list: 'ai-model-list', spellcheck: 'false', autocomplete: 'off' });
  const modelList = h('datalist', { id: 'ai-model-list' });
  const load = h('button', { class: 'btn small', type: 'button' }, icon('refresh-cw'), h('span', {}, t('Load models')));
  const modelNote = h('span', { class: 'field-hint' });
  load.addEventListener('click', () => void loadModels());
  const modelField = h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('Model')),
    h('div', { class: 'field-row' }, model, load), modelList, modelNote);

  const localHelp = h('p', { class: 'field-hint' }, isMobile()
    ? t('Run Ollama or LM Studio on your computer and let it accept connections from your network (in Ollama, set OLLAMA_HOST to 0.0.0.0; in LM Studio, turn on “Serve on local network”). Then type your computer’s address here, with the phone on the same Wi-Fi, and press Load models.')
    : t('Install Ollama (ollama.com) or LM Studio (lmstudio.ai), download a model in it, then press Load models. Larger models give better translations but need a fast computer.'));
  const error = h('p', { class: 'field-error' });

  const fillList = (names: string[]) => modelList.replaceChildren(...names.map((n) => new Option(n, n)));

  let loading = 0;
  async function loadModels() {
    const ticket = ++loading;
    modelNote.textContent = t('Loading models…');
    error.textContent = '';
    try {
      const names = await api().aiModels({ provider: chosen.id, key: key.value, url: url.value });
      if (ticket !== loading) return;
      fillList(names.length ? names : chosen.models);
      if (!model.value || (!names.includes(model.value) && names.length && chosen.onDevice)) model.value = names[0] ?? model.value;
      modelNote.textContent = names.length ? t('{count, plural, one {# model available.} other {# models available.}}', { count: names.length }) : t('No models found. Download one in your AI app first.');
    } catch (err) {
      if (ticket !== loading) return;
      modelNote.textContent = '';
      error.textContent = cleanError(err);
    }
  }

  // one card per provider
  const cards = AI_PROVIDERS.map((provider) => {
    const input = h('input', { type: 'radio', name: 'ai-provider', value: provider.id, checked: provider.id === chosen.id });
    input.addEventListener('change', () => {
      chosen = provider;
      show();
    });
    const badge = provider.onDevice ? h('em', { class: 'badge good' }, t('Private')) : '';
    return h('label', { class: 'lang-option ai-option' }, input,
      h('span', {}, h('strong', {}, t(provider.name), badge), h('span', {}, t(provider.blurb))));
  });

  function show() {
    const saved = !!hasKey[chosen.id];
    keyField.hidden = chosen.onDevice === true;
    key.value = '';
    key.placeholder = saved ? t('A key is saved. Paste a new one to replace it.') : chosen.keyPrefix ? `${chosen.keyPrefix}…` : chosen.needsKey ? '' : t('Optional');
    keyHint.replaceChildren(
      isMobile()
        ? (chosen.keyUrl ? t('Get one at {site}. It’s stored encrypted on this phone and only ever sent to {company}.', { site: chosen.keyUrl, company: t(chosen.company) })
          : t('It’s stored encrypted on this phone and only ever sent to {company}.', { company: t(chosen.company) }))
        : chosen.keyUrl ? t('Get one at {site}. It’s stored encrypted on this computer and only ever sent to {company}.', { site: chosen.keyUrl, company: t(chosen.company) })
          : t('It’s stored encrypted on this computer and only ever sent to {company}.', { company: t(chosen.company) }),
      saved ? ' ' : '', saved ? forget : '');
    urlField.hidden = chosen.id !== 'local' && chosen.id !== 'custom';
    // on a phone, "local" means the AI app on your computer, reached over Wi-Fi
    presets.hidden = chosen.id !== 'local' || isMobile();
    url.value = status.urls[chosen.id] ?? chosen.baseUrl;
    localHelp.hidden = !chosen.onDevice;
    model.value = status.models[chosen.id] ?? chosen.models[0] ?? '';
    model.placeholder = chosen.onDevice ? t('Press Load models') : '';
    fillList(chosen.models);
    modelNote.textContent = '';
    error.textContent = '';
    // a local server needs no key, so its list can load straight away
    if (chosen.onDevice) void loadModels();
  }
  show();

  const choice = await modal({
    title: t('AI tools'),
    wide: true,
    body: h('div', {},
      h('p', { class: 'modal-text' }, t('Summarize and translate PDFs with the AI service you prefer. Cloud services use your own API key, and you pay them directly for what you use. AI on this computer is free and completely private.')),
      h('div', { class: 'lang-grid ai-grid', role: 'radiogroup' }, ...cards),
      urlField, keyField, modelField, localHelp, error),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Save'), value: 'ok', primary: true }],
    validate: async (value) => {
      if (value !== 'ok') return true;
      try {
        await api().aiSave({ provider: chosen.id, key: key.value, model: model.value, url: url.value });
        return true;
      } catch (err) {
        error.textContent = cleanError(err);
        return false;
      }
    },
  });
  return choice === 'ok' || (await api().aiStatus()).ready;
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

const NO_TEXT = msg('This document has no text to work with. If it’s a scan, run Tools › Recognise text (OCR) first.');

// --- summarizer --------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function summarize(doc: EditorDoc, host: AiHost) {
  if (!(await ensureReady())) return;
  const length = h('select', { class: 'field-input' },
    new Option(t('Short: a few sentences'), 'short'),
    new Option(t('Detailed: key points, numbers and dates'), 'detailed'));
  const language = h('select', { class: 'field-input' }, new Option(t('Same as the document'), ''), ...ALL_LANGUAGES.map((l) => new Option(languageLabel(l), l.name)));
  const go = await modal({
    title: t('AI Summarizer'),
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Length')), length),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Write it in')), language),
      h('p', { class: 'field-hint warn' }, icon('info'), await privacyNote())),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Summarize'), value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;

  const summary = await host.withBusy(t('Reading the document…'), async () => {
    const pdf = await exported(doc);
    let texts: string[];
    try {
      texts = await pageTexts(pdf);
    } finally {
      pdf.loadingTask.destroy();
    }
    const full = texts.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
    if (!texts.join('').trim()) throw new Error(t(NO_TEXT));
    const style = length.value === 'short'
      ? 'Write a short summary: three to five sentences of plain prose.'
      : 'Write a detailed summary: a one-sentence overview, then the key points as a bulleted list, including important names, numbers, amounts and dates, citing page numbers in brackets like (p. 3).';
    const lang = language.value ? `Write the summary in ${language.value}.` : 'Write the summary in the same language as the document.';
    const system = 'You summarize documents accurately and plainly. Never invent facts that are not in the document. Use simple Markdown (bullets, bold) only.';

    // very long documents are summarised in parts, then the parts together
    const LIMIT = 120_000;
    if (full.length <= LIMIT) {
      host.progress(t('Summarizing…'));
      return api().aiAsk({ system, prompt: `${style} ${lang}\n\n<document>\n${full}\n</document>`, maxTokens: 2000 });
    }
    const parts: string[] = [];
    for (let i = 0; i < full.length; i += LIMIT) parts.push(full.slice(i, i + LIMIT));
    const notes: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      host.progress(t('Summarizing part {n} of {total}…', { n: i + 1, total: parts.length }));
      notes.push(await api().aiAsk({ system, prompt: `This is part ${i + 1} of ${parts.length} of a long document. List its key points, keeping page numbers.\n\n<document>\n${parts[i]}\n</document>`, maxTokens: 2000 }));
    }
    host.progress(t('Putting it together…'));
    return api().aiAsk({ system, prompt: `${style} ${lang}\n\nThese are notes on each part of one long document:\n\n${notes.join('\n\n---\n\n')}`, maxTokens: 2500 });
  });

  const { marked } = await import('marked');
  const html = await marked.parse(escapeHtml(summary), { gfm: true });
  const body = h('div', { class: 'ai-summary' });
  body.innerHTML = html; // escaped above: only Markdown's own tags are left
  const choice = await modal({
    title: t('Summary'),
    wide: true,
    body,
    buttons: [
      { label: t('Add as a comment'), value: 'note' },
      { label: t('Copy'), value: 'copy' },
      { label: t('Close'), value: 'close', primary: true },
    ],
  });
  if (choice === 'copy') {
    await navigator.clipboard.writeText(summary).catch(() => {});
    toast(t('Summary copied.'), 'success');
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
    toast(t('Added the summary as a comment on page 1.'), 'success');
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
    host.progress(t('{label} ({n} of {total})…', { label, n: Math.min(batch, batches), total: batches }));
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
  const language = h('select', { class: 'field-input' }, ...ALL_LANGUAGES.map((l) => new Option(languageLabel(l), l.name)));
  language.value = 'English';
  const how = h('select', { class: 'field-input' },
    new Option(t('Over the original pages (keeps the layout)'), 'pages'),
    new Option(t('As a Word document'), 'word'));
  const which = h('select', { class: 'field-input' }, new Option(t('Every page'), 'all'), new Option(t('Only the current page'), 'current'));
  const note = h('p', { class: 'field-hint' });
  const sync = () => {
    const laidOver = how.value === 'pages';
    const cjk = /Chinese|Japanese|Korean/.test(language.value);
    note.textContent = laidOver
      ? `${t('Opens a translated copy in a new tab. Each line is replaced where it was; your original isn’t changed.')}${cjk ? ` ${t('The first time, Inkleaf downloads a font for this language (about 15 MB).')}` : ''}`
      : t('Saves the translated text as a Word file, with its headings and paragraphs.');
  };
  language.addEventListener('change', sync);
  how.addEventListener('change', sync);
  sync();
  const go = await modal({
    title: t('Translate PDF'),
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Translate into')), language),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Result')), how),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Pages')), which),
      note,
      h('p', { class: 'field-hint warn' }, icon('info'), await privacyNote())),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Translate'), value: 'ok', primary: true }],
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
    const bytes = await host.withBusy(t('Reading the document…'), async () => {
      const pdf = await loadPdf((await exportPdf(doc, pageIds)).bytes);
      try {
        const { documentStructure } = await import('./pdf-structure');
        const pages: PageStructure[] = await documentStructure(pdf, (n, total) => host.progress(t('Reading page {n} of {total}…', { n, total })));
        const blocks = pages.flatMap((p) => p.blocks).filter((b) => b.kind !== 'picture') as Extract<PageStructure['blocks'][number], { spans: unknown }>[];
        const texts = blocks.map((b) => b.spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim());
        if (!texts.join('').trim()) throw new Error(t(NO_TEXT));
        const translated = await translateLines(texts, target, host, t('Translating into {language}', { language: languageName(target) }));
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
    if (path) toast(t('Saved the {language} translation.', { language: languageName(target) }), 'success');
    return;
  }

  const translatedDoc = await host.withBusy(t('Reading the document…'), async () => {
    const bytes = (await exportPdf(doc, pageIds)).bytes;
    const { EditorDoc } = await import('./document');
    const copy = await EditorDoc.open(bytes, `${doc.name.replace(/\.pdf$/i, '')} (${target}).pdf`, null);
    const source = copy.sources.get(copy.mainSource)!;
    const perPage: TextRun[][] = [];
    for (let i = 0; i < copy.pages.length; i++) perPage.push(await pageRuns(await source.pdf.getPage(i + 1)));
    const all = perPage.flat();
    if (!all.some((r) => r.str.trim())) throw new Error(t(NO_TEXT));
    const translated = await translateLines(all.map((r) => r.str), target, host, t('Translating into {language}', { language: languageName(target) }));
    // fonts for the new language (downloaded for Chinese, Japanese and Korean)
    // must be ready before the lines can be fitted
    host.progress(t('Preparing fonts…'));
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
  toast(t('Translated into {language}. Check it over, then save it where you like.', { language: languageName(target) }), 'success', 6000);
}
