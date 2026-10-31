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
import { LOCAL_MODELS, LocalAiStatus } from '../shared/local-models';

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
  if (provider.id === 'builtin') return isMobile()
    ? t('The built-in AI reads the document here on this phone. Nothing leaves your phone.')
    : t('The built-in AI reads the document here on this computer. Nothing leaves your computer.');
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

  // --- the built-in AI: pick a size, download it once ---
  let local: LocalAiStatus = status.local ?? { supported: false, installed: [], sizes: {}, downloading: null, device: null };
  let localChoice = status.models.builtin ?? LOCAL_MODELS[0].id;
  const gb = (bytes: number) => (bytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const size = (bytes: number) => bytes >= 1e9 ? t('{n} GB', { n: gb(bytes) }) : t('{n} MB', { n: Math.max(1, Math.round(bytes / 1e6)).toLocaleString() });
  const localRows = h('div', { class: 'local-models', role: 'radiogroup' });
  const localNote = h('p', { class: 'field-hint' });
  const localField = h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('Model')), localRows, localNote);

  function drawLocal() {
    localRows.replaceChildren(...LOCAL_MODELS.map((m) => {
      const installed = local.installed.includes(m.id);
      const busy = local.downloading?.id === m.id ? local.downloading : null;
      const input = h('input', { type: 'radio', name: 'local-model', value: m.id, checked: m.id === localChoice });
      input.addEventListener('change', () => {
        localChoice = m.id;
        error.textContent = '';
      });
      let action: HTMLElement;
      if (busy) {
        const percent = busy.total ? Math.floor((busy.received / busy.total) * 100) : 0;
        const stop = h('button', { class: 'link-button', type: 'button' }, t('Cancel'));
        stop.addEventListener('click', (e) => {
          e.preventDefault();
          void api().localAiCancelDownload?.();
        });
        action = h('span', { class: 'local-progress' },
          h('span', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent) },
            h('span', { style: `width:${percent}%` })),
          h('span', {}, t('{done} of {total}', { done: size(busy.received), total: size(busy.total) })), stop);
      } else if (installed) {
        const remove = h('button', { class: 'link-button', type: 'button' }, t('Remove'));
        remove.addEventListener('click', async (e) => {
          e.preventDefault();
          await api().localAiRemove?.(m.id);
          local = (await api().aiStatus()).local ?? local;
          drawLocal();
        });
        action = h('span', { class: 'local-state' }, h('em', { class: 'badge good' }, t('Downloaded')), remove);
      } else {
        const get = h('button', { class: 'btn small', type: 'button', disabled: !!local.downloading }, icon('download'), h('span', {}, t('Download ({size})', { size: size(local.sizes[m.id] ?? m.size) })));
        get.addEventListener('click', async (e) => {
          e.preventDefault();
          localChoice = m.id;
          error.textContent = '';
          local = { ...local, downloading: { id: m.id, received: 0, total: m.size } };
          drawLocal();
          await api().localAiDownload?.(m.id);
        });
        action = get;
      }
      // a phone short of memory can still try, but should know it may not cope
      const tight = isMobile() && !!local.memory && local.memory < m.phone.memory;
      return h('label', { class: 'lang-option local-model' }, input,
        h('span', {}, h('strong', {}, t(m.name)), h('span', {}, t(isMobile() ? m.phone.blurb : m.blurb)),
          tight ? h('span', { class: 'local-warning' }, t('This phone may not have enough memory for it.')) : ''), action);
    }));
    localNote.textContent = isMobile()
      ? t('Downloaded once, then it works offline. It runs on this phone’s processor, so long answers take a little while.')
      : local.device
      ? `${t('Downloaded once, then it works offline.')} ${t('Last ran on: {device}.', { device: local.device === 'CPU' ? t('the processor') : local.device })}`
      : t('Downloaded once, then it works offline. It uses your graphics card if it can, otherwise the processor.');
  }
  const offLocal = api().onLocalAiEvent?.((event) => {
    if (event.type === 'progress') local = { ...local, downloading: { id: event.id, received: event.received, total: event.total } };
    else {
      local = { ...local, downloading: null, installed: event.type === 'done' ? [...new Set([...local.installed, event.id])] : local.installed };
      if (event.type === 'failed' && event.message) error.textContent = event.message;
    }
    drawLocal();
  });
  drawLocal();

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
  // the built-in AI needs a computer or phone that llama.cpp runs on
  const offered = AI_PROVIDERS.filter((p) => p.id !== 'builtin' || local.supported);
  if (!offered.includes(chosen)) chosen = offered.find((p) => p.id !== 'builtin') ?? offered[0];
  const cards = offered.map((provider) => {
    const input = h('input', { type: 'radio', name: 'ai-provider', value: provider.id, checked: provider.id === chosen.id });
    input.addEventListener('change', () => {
      chosen = provider;
      show();
    });
    const badge = provider.id === 'builtin' ? h('em', { class: 'badge good' }, t('Free')) : provider.onDevice ? h('em', { class: 'badge good' }, t('Private')) : '';
    return h('label', { class: 'lang-option ai-option' }, input,
      h('span', {}, h('strong', {}, t(provider.name), badge), h('span', {}, t(provider.blurb))));
  });

  function show() {
    const saved = !!hasKey[chosen.id];
    const builtin = chosen.id === 'builtin';
    localField.hidden = !builtin;
    modelField.hidden = builtin;
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
    localHelp.hidden = !chosen.onDevice || builtin;
    model.value = status.models[chosen.id] ?? chosen.models[0] ?? '';
    model.placeholder = chosen.onDevice ? t('Press Load models') : '';
    fillList(chosen.models);
    modelNote.textContent = '';
    error.textContent = '';
    // a local server needs no key, so its list can load straight away
    if (chosen.onDevice && !builtin) void loadModels();
  }
  show();

  const choice = await modal({
    title: t('AI tools'),
    wide: true,
    body: h('div', {},
      h('p', { class: 'modal-text' }, isMobile()
        ? (local.supported
          ? t('Summarize, translate and ask questions about PDFs with the AI you prefer. The built-in AI is free and private and runs on this phone, with no key needed. Cloud services use your own API key, and you pay them directly for what you use.')
          : t('Summarize, translate and ask questions about PDFs with the AI service you prefer. Cloud services use your own API key, and you pay them directly for what you use.'))
        : t('Summarize, translate and ask questions about PDFs with the AI you prefer. The built-in AI is free and private, with no key needed. Cloud services use your own API key, and you pay them directly for what you use.')),
      h('div', { class: 'lang-grid ai-grid', role: 'radiogroup' }, ...cards),
      urlField, keyField, modelField, localField, localHelp, error),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Save'), value: 'ok', primary: true }],
    validate: async (value) => {
      if (value !== 'ok') return true;
      try {
        if (chosen.id === 'builtin' && !local.installed.includes(localChoice)) {
          error.textContent = local.downloading?.id === localChoice
            ? t('Wait for the download to finish, then press Save.')
            : t('Download the model first.');
          return false;
        }
        await api().aiSave({ provider: chosen.id, key: key.value, model: chosen.id === 'builtin' ? localChoice : model.value, url: url.value });
        return true;
      } catch (err) {
        error.textContent = cleanError(err);
        return false;
      }
    },
  });
  offLocal?.();
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

    // long documents are summarised in parts, then the parts together; how
    // long "long" is depends on how much the chosen AI can read at once
    const LIMIT = (await api().aiStatus()).budget;
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

/** "7| some text" → [7, "some text"], for the numbered lines the AI replies with. */
const NUMBERED = /^\s*(\d+)\s*[|｜)\]:.-]\s?(.*)$/;

/**
 * Asks for one batch of lines. Each goes out numbered and comes back with
 * its number, so a model that drops, merges or garbles a line only loses
 * that one, not the whole batch. Returns what came back, by position.
 */
async function translateBatch(chunk: string[], system: string, maxTokens: number): Promise<(string | undefined)[]> {
  const prompt = `<lines>\n${chunk.map((line, i) => `${i + 1}| ${line.replace(/\s*\n\s*/g, ' ')}`).join('\n')}\n</lines>`;
  const reply = await api().aiAsk({ system, prompt, maxTokens });
  const got: (string | undefined)[] = new Array(chunk.length);
  for (const line of reply.replace(/<\/?lines>/g, '').split('\n')) {
    const m = NUMBERED.exec(line);
    if (!m) continue;
    const n = Number(m[1]) - 1;
    const text = m[2].trim();
    if (n >= 0 && n < chunk.length && got[n] === undefined && text) got[n] = text;
  }
  // a model that answered with a JSON list instead
  if (!got.some((g) => g !== undefined)) {
    try {
      const json = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1));
      if (Array.isArray(json) && json.length === chunk.length) json.forEach((v, i) => (got[i] = String(v)));
    } catch {
      // nothing usable
    }
  }
  return got;
}

/**
 * Translates lines in batches, keeping them one-for-one. Lines the AI
 * missed are asked for again in smaller groups; any still missing stay in
 * the original language, and `missed` says how many.
 */
async function translateLines(lines: string[], language: string, host: AiHost, label: string): Promise<{ lines: string[]; missed: number }> {
  const out: (string | undefined)[] = new Array(lines.length);
  const status = await api().aiStatus();
  // each batch, translated, has to fit in what the AI can handle at once;
  // a small model on this computer or phone keeps its place better with fewer lines
  const small = status.provider === 'builtin' || providerById(status.provider).onDevice;
  const BATCH = small ? Math.min(1500, Math.floor(status.budget / 6)) : Math.min(6000, Math.floor(status.budget / 4));
  const MAX_LINES = small ? 30 : 100;
  const system = `You are a professional translator. Translate each numbered line into ${language}. The lines come one after another from the same document, so read them together for meaning, but keep every line separate. Reply with only the translated lines, one per line, each starting with its number and a vertical bar, like "7| translated text". Keep numbers, names, codes, email addresses and URLs as they are. A line that is only numbers, symbols or dots stays as it is.`;

  const todo = lines.map((_, i) => i).filter((i) => {
    // nothing to translate: keep it as it is
    if (!/\p{L}/u.test(lines[i])) {
      out[i] = lines[i];
      return false;
    }
    return true;
  });
  const groups = (indices: number[], maxChars: number, maxLines: number) => {
    const result: number[][] = [];
    let group: number[] = [], size = 0;
    for (const i of indices) {
      if (group.length && (size + lines[i].length > maxChars || group.length >= maxLines)) {
        result.push(group);
        group = [];
        size = 0;
      }
      group.push(i);
      size += lines[i].length + 6;
    }
    if (group.length) result.push(group);
    return result;
  };

  const first = groups(todo, BATCH, MAX_LINES);
  let done = 0;
  for (const group of first) {
    done++;
    host.progress(t('{label} ({n} of {total})…', { label, n: done, total: first.length }));
    const size = group.reduce((n, i) => n + lines[i].length, 0);
    const got = await translateBatch(group.map((i) => lines[i]), system, Math.min(16000, size * 3 + 300)).catch((err) => {
      // the AI itself failing (no key, offline...) is worth stopping for
      if (!group.some((i) => out[i] !== undefined) && done === 1) throw err;
      return [] as (string | undefined)[];
    });
    group.forEach((i, k) => (out[i] = got[k]));
  }

  // a second go at whatever didn't come back, a few lines at a time
  const missing = todo.filter((i) => out[i] === undefined);
  if (missing.length) {
    const retries = groups(missing, Math.max(400, BATCH / 3), 8);
    let n = 0;
    for (const group of retries) {
      n++;
      host.progress(t('{label} ({n} of {total})…', { label: t('Filling in missed lines'), n, total: retries.length }));
      const size = group.reduce((c, i) => c + lines[i].length, 0);
      const got = await translateBatch(group.map((i) => lines[i]), system, Math.min(4000, size * 3 + 200)).catch(() => [] as (string | undefined)[]);
      group.forEach((i, k) => (out[i] = got[k]));
    }
  }

  const missed = todo.filter((i) => out[i] === undefined).length;
  if (todo.length && missed === todo.length) {
    throw new Error(t('The AI didn’t send back a translation. Try again, or pick a bigger model or another AI in Tools › AI settings.'));
  }
  return { lines: lines.map((line, i) => out[i] ?? line), missed };
}

/**
 * Joins the pieces of each printed line. Many PDFs (anything justified in
 * Word, for one) place every word separately; translated one word at a
 * time they'd make no sense, so pieces sitting on the same baseline, close
 * enough together, become one line.
 */
export function joinLines(runs: TextRun[]): TextRun[] {
  const lines: TextRun[] = [];
  for (const run of runs) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.angle - run.angle) < 1 && Math.abs(line.size - run.size) <= line.size * 0.15) {
      // where this piece starts, measured along and across the line so far
      const [along, across] = rotateVec(run.x - line.x, run.y - line.y, -line.angle);
      const gap = along - line.width;
      if (Math.abs(across) < line.size * 0.35 && gap > -line.size * 0.3 && gap < line.size * 2.5) {
        const space = gap > line.size * 0.12 && !/\s$/.test(line.str) && !/^\s/.test(run.str) ? ' ' : '';
        line.str += space + run.str;
        line.width = Math.max(line.width, along + run.width);
        line.bold &&= run.bold;
        line.italic &&= run.italic;
        continue;
      }
    }
    lines.push({ ...run });
  }
  return lines;
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
        const { lines: translated } = await translateLines(texts, target, host, t('Translating into {language}', { language: languageName(target) }));
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

  let missed = 0;
  const translatedDoc = await host.withBusy(t('Reading the document…'), async () => {
    const bytes = (await exportPdf(doc, pageIds)).bytes;
    const { EditorDoc } = await import('./document');
    const copy = await EditorDoc.open(bytes, `${doc.name.replace(/\.pdf$/i, '')} (${target}).pdf`, null);
    const source = copy.sources.get(copy.mainSource)!;
    const perPage: TextRun[][] = [];
    for (let i = 0; i < copy.pages.length; i++) perPage.push(joinLines(await pageRuns(await source.pdf.getPage(i + 1))));
    const all = perPage.flat();
    if (!all.some((r) => r.str.trim())) throw new Error(t(NO_TEXT));
    const result = await translateLines(all.map((r) => r.str), target, host, t('Translating into {language}', { language: languageName(target) }));
    const translated = result.lines;
    missed = result.missed;
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
  if (missed) toast(t('{count, plural, one {Translated into {language}, but # line couldn’t be translated and was left as it was.} other {Translated into {language}, but # lines couldn’t be translated and were left as they were.}}', { count: missed, language: languageName(target) }), 'info', 9000);
  else toast(t('Translated into {language}. Check it over, then save it where you like.', { language: languageName(target) }), 'success', 6000);
}
