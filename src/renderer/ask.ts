// SPDX-License-Identifier: GPL-3.0-or-later
// Ask this PDF: a panel beside the pages where you ask questions about the
// open document and get answers that point to the pages they came from.
//
// Small models (the built-in AI) can only read so much at once, so a long
// document isn't sent whole. It's cut into pieces, and the pieces that share
// the most words with the question are sent (BM25 ranking, the classic
// search-engine formula), in page order. Short documents go in full.

import { t } from '../shared/i18n';
import { isMobile } from '../shared/platform';
import { providerById } from '../shared/ai-providers';
import { localModelById } from '../shared/local-models';
import type { EditorDoc } from './document';
import { pageRuns } from './text-finder';
import { h, icon, toast } from './ui';

const api = () => window.inkleaf;

export interface AskHost {
  /** The document in the active tab. */
  doc(): EditorDoc | null;
  goToPage(doc: EditorDoc, index: number): void;
  aiSettings(): Promise<boolean>;
}

interface Turn {
  question: string;
  answer: string;
  error?: boolean;
}

// --- the document's text, cached until it's edited --------------------------------------------

interface DocText {
  key: unknown;
  pages: string[];
}
const texts = new WeakMap<EditorDoc, DocText>();

async function documentText(doc: EditorDoc): Promise<string[]> {
  const version = doc.version();
  const cached = texts.get(doc);
  if (cached && cached.key === version.snapshot) return cached.pages;
  const [{ exportPdf }, { loadPdf }] = await Promise.all([import('./exporter'), import('./pdf')]);
  const pdf = await loadPdf((await exportPdf(doc)).bytes);
  const pages: string[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const runs = await pageRuns(await pdf.getPage(n));
      pages.push(runs.map((r) => r.str).join('\n'));
    }
  } finally {
    pdf.loadingTask.destroy();
  }
  texts.set(doc, { key: version.snapshot, pages });
  return pages;
}

// --- finding the right parts -------------------------------------------------------------------

interface Piece { page: number; text: string; terms: Map<string, number>; length: number }

/** Scripts written without spaces between words are compared two characters at a time. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const STOP = new Set('a an and are as at be by do does for from has have how i in is it its me my of on or our so that the their them this to was we what when where which who why will with you your'.split(' '));

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
    if (UNSPACED.test(word) && word.length > 2) {
      for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
    } else if (!STOP.has(word) && (word.length > 1 || /\p{N}/u.test(word))) {
      out.push(word);
    }
  }
  return out;
}

function piecesOf(pages: string[], size = 900): Piece[] {
  const pieces: Piece[] = [];
  pages.forEach((page, index) => {
    let current = '';
    const flush = () => {
      if (!current.trim()) return;
      const words = terms(current);
      const counts = new Map<string, number>();
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
      pieces.push({ page: index + 1, text: current.trim(), terms: counts, length: words.length || 1 });
      current = '';
    };
    for (const line of page.split('\n')) {
      if (current.length + line.length > size) flush();
      current += `${line}\n`;
    }
    flush();
  });
  return pieces;
}

/**
 * The parts of the document to send with a question: all of it if it fits,
 * otherwise the best-matching pieces up to the budget, back in page order.
 */
export function excerpts(pages: string[], question: string, budget: number): { text: string; whole: boolean } {
  const tagged = pages.map((p, i) => `[Page ${i + 1}]\n${p.trim()}`);
  const whole = tagged.join('\n\n');
  if (whole.length <= budget) return { text: whole, whole: true };

  const pieces = piecesOf(pages);
  const asked = [...new Set(terms(question))];
  const average = pieces.reduce((s, p) => s + p.length, 0) / Math.max(1, pieces.length);
  const df = new Map<string, number>();
  for (const word of asked) df.set(word, pieces.filter((p) => p.terms.has(word)).length);
  const score = (p: Piece) => asked.reduce((sum, word) => {
    const tf = p.terms.get(word) ?? 0;
    if (!tf) return sum;
    const n = df.get(word)!;
    const idf = Math.log(1 + (pieces.length - n + 0.5) / (n + 0.5));
    return sum + idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (p.length / average))));
  }, 0);

  const ranked = pieces.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i);
  // a question with nothing to match ("summarise this") gets the start of every page instead
  const order = ranked[0]?.s ? ranked : pieces.map((p, i) => ({ p, i, s: 0 })).sort((a, b) => {
    const firstA = pieces.findIndex((x) => x.page === a.p.page) === a.i ? 0 : 1;
    const firstB = pieces.findIndex((x) => x.page === b.p.page) === b.i ? 0 : 1;
    return firstA - firstB || a.i - b.i;
  });
  const chosen: typeof order = [];
  let used = 0;
  for (const item of order) {
    if (used + item.p.text.length + 12 > budget) continue;
    chosen.push(item);
    used += item.p.text.length + 12;
  }
  chosen.sort((a, b) => a.i - b.i);
  const text = chosen.map(({ p }) => `[Page ${p.page}]\n${p.text}`).join('\n\n');
  return { text, whole: false };
}

// --- asking ------------------------------------------------------------------------------------

const SYSTEM = 'You answer questions about one document, using only the document text provided. '
  + 'After each fact, say which page it is on in exactly this form: (p. 3). Always write it that way, with the Latin letter p, whatever language you answer in, including in summaries and lists. '
  + 'For example: "The total due is 18,450 rupees (p. 2)." '
  + 'If the text doesn’t contain the answer, say plainly that you couldn’t find it in the document; never guess or use outside knowledge. '
  + 'Answer in the same language as the question. Be concise: a few sentences or a short list. Use simple Markdown only.';

function promptFor(name: string, pages: string[], question: string, history: Turn[], budget: number): string {
  const { text, whole } = excerpts(pages, `${question} ${history.at(-1)?.question ?? ''}`, budget);
  const earlier = history.filter((turn) => !turn.error).slice(-3)
    .map((turn) => `Q: ${turn.question}\nA: ${turn.answer.slice(0, 600)}`).join('\n\n');
  return [
    `<document name="${name.replace(/"/g, '')}" pages="${pages.length}">`,
    whole ? '' : 'These are the parts of the document that best match the question, not all of it.',
    text,
    '</document>',
    earlier ? `\nEarlier in this conversation:\n${earlier}` : '',
    `\nQuestion: ${question}`,
  ].filter(Boolean).join('\n');
}

// --- the panel ---------------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let panel: AskPanel | null = null;

export function openAsk(host: AskHost) {
  panel ??= new AskPanel(host);
  panel.open();
}

/** Called when the active tab changes. */
export function refreshAsk() {
  panel?.refresh();
}

class AskPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private input: HTMLTextAreaElement;
  private send: HTMLButtonElement;
  private using: HTMLElement;
  private note: HTMLElement;
  private conversations = new WeakMap<EditorDoc, Turn[]>();
  private busy = false;

  constructor(private host: AskHost) {
    const close = h('button', { class: 'ask-close', type: 'button', 'aria-label': t('Close'), title: t('Close (Esc)') }, icon('x'));
    close.addEventListener('click', () => this.close());
    this.using = h('span', { class: 'ask-using' });
    const head = h('header', { class: 'ask-head' },
      h('div', { class: 'ask-title' }, icon('sparkles'), h('h2', {}, t('Ask this PDF'))), close);
    this.list = h('div', { class: 'ask-list', role: 'log', 'aria-live': 'polite' });
    this.input = h('textarea', { class: 'ask-input', rows: 2, placeholder: t('Ask a question about this document') });
    this.send = h('button', { class: 'btn btn-primary ask-send', type: 'button' });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.ask();
      }
      if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('input', () => this.fit());
    this.send.addEventListener('click', () => (this.busy ? void api().aiStop?.() : void this.ask()));
    this.note = h('p', { class: 'ask-note' });
    this.el = h('aside', { class: 'ask-panel', 'aria-label': t('Ask this PDF'), hidden: true },
      head, this.using, this.list,
      h('div', { class: 'ask-compose' }, this.input, this.send), this.note);
    // on a computer it sits beside the pages; on a phone it's a full-screen
    // sheet in the dialog layer, which the app shows over its own screens,
    // and the back button closes it like any other dialog
    this.sheet = isMobile() ? h('div', { class: 'modal-backdrop show ask-sheet' }, this.el) : null;
    if (!this.sheet) document.getElementById('workspace')!.append(this.el);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.el.hidden || !this.sheet) return;
      // only when nothing else (AI settings, say) is open on top of it
      if (document.getElementById('modal-root')!.lastElementChild !== this.sheet) return;
      this.close();
    });
    this.drawSend();
  }

  private sheet: HTMLElement | null = null;

  open() {
    this.el.hidden = false;
    if (this.sheet) document.getElementById('modal-root')!.append(this.sheet);
    document.getElementById('app')?.classList.add('asking');
    void this.refresh();
    // on a phone, the keyboard would cover the suggestions straight away
    if (!this.sheet) this.input.focus();
  }

  close() {
    this.el.hidden = true;
    this.sheet?.remove();
    document.getElementById('app')?.classList.remove('asking');
  }

  private drawSend() {
    this.send.replaceChildren(icon(this.busy ? 'square' : 'arrow-up'));
    this.send.setAttribute('aria-label', this.busy ? t('Stop') : t('Ask'));
    this.send.title = this.busy ? t('Stop') : t('Ask');
  }

  private fit() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`;
  }

  async refresh() {
    if (this.el.hidden) return;
    const status = await api().aiStatus();
    const provider = providerById(status.provider);
    const name = provider.id === 'builtin' ? `${t(provider.name)} · ${t(localModelById(status.model).name)}` : `${t(provider.name)} · ${status.model}`;
    const change = h('button', { class: 'link-button', type: 'button' }, status.ready ? t('Change') : t('Set up AI'));
    change.addEventListener('click', async () => {
      await this.host.aiSettings();
      void this.refresh();
    });
    this.using.replaceChildren(status.ready ? t('Using {name}', { name }) : t('Pick an AI to start.'), ' ', change);
    this.note.textContent = provider.onDevice && isMobile()
      ? (provider.id === 'builtin'
        ? t('Answers come from the document and stay on this phone. Check anything important.')
        : t('The parts of the document needed for each question go to the AI on your computer, over your Wi-Fi. Check anything important.'))
      : provider.onDevice
      ? t('Answers come from the document and stay on this computer. Check anything important.')
      : t('The parts of the document needed for each question are sent to {company}. Check anything important.', { company: t(provider.company) });
    this.draw();
  }

  private turns(): Turn[] {
    const doc = this.host.doc();
    if (!doc) return [];
    let list = this.conversations.get(doc);
    if (!list) this.conversations.set(doc, (list = []));
    return list;
  }

  private draw() {
    const turns = this.turns();
    if (!turns.length) {
      const suggestions = [t('Summarize this in three points'), t('What are the key dates and amounts?'), t('What does this document ask me to do?')];
      this.list.replaceChildren(h('div', { class: 'ask-empty' },
        h('p', {}, t('Ask anything about this document. Answers point to the pages they came from.')),
        h('div', { class: 'ask-suggestions' }, ...suggestions.map((s) => {
          const chip = h('button', { class: 'chip', type: 'button' }, s);
          chip.addEventListener('click', () => {
            this.input.value = s;
            void this.ask();
          });
          return chip;
        }))));
      return;
    }
    this.list.replaceChildren(...turns.map((turn) => this.bubble(turn)));
    this.list.scrollTop = this.list.scrollHeight;
  }

  private bubble(turn: Turn): HTMLElement {
    const answer = h('div', { class: `ask-answer${turn.error ? ' error' : ''}` });
    void this.render(answer, turn);
    return h('div', { class: 'ask-turn' }, h('p', { class: 'ask-question' }, turn.question), answer);
  }

  /** Markdown, with page references turned into links to the page. */
  private async render(target: HTMLElement, turn: Turn) {
    if (turn.error) {
      target.textContent = turn.answer;
      return;
    }
    if (!turn.answer) {
      target.replaceChildren(h('span', { class: 'ask-thinking' }, t('Reading the document…')));
      return;
    }
    const { marked } = await import('marked');
    target.innerHTML = await marked.parse(escapeHtml(turn.answer), { gfm: true }); // escaped: only Markdown's own tags remain
    const doc = this.host.doc();
    if (!doc) return;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    while (walker.nextNode()) if (/\(pp?\.\s*\d/.test(walker.currentNode.textContent ?? '')) found.push(walker.currentNode as Text);
    for (const node of found) {
      const parts = (node.textContent ?? '').split(/(\(pp?\.\s*\d+(?:\s*[-–,]\s*\d+)*\))/);
      node.replaceWith(...parts.map((part) => {
        const numbers = /^\(pp?\./.test(part) ? part.match(/\d+/g)!.map(Number) : null;
        if (!numbers) return document.createTextNode(part);
        const valid = numbers.filter((n) => n >= 1 && n <= doc.pages.length);
        if (!valid.length) return document.createTextNode(part);
        return h('span', { class: 'ask-refs' }, ...valid.map((n) => {
          const link = h('button', { class: 'ask-ref', type: 'button', title: t('Go to page {n}', { n }) }, t('p. {n}', { n }));
          link.addEventListener('click', () => {
            // on a phone the page is behind the sheet, so step out of the way
            if (this.sheet) this.close();
            this.host.goToPage(doc, n - 1);
          });
          return link;
        }));
      }));
    }
  }

  async ask() {
    const question = this.input.value.trim();
    const doc = this.host.doc();
    if (!question || !doc || this.busy) return;
    const status = await api().aiStatus();
    if (!status.ready) {
      if (!(await this.host.aiSettings())) return;
      await this.refresh();
    }
    const budget = (await api().aiStatus()).budget;
    const turns = this.turns();
    const history = turns.slice();
    const turn: Turn = { question, answer: '' };
    turns.push(turn);
    this.input.value = '';
    this.fit();
    this.draw();
    const view = this.list.lastElementChild!.querySelector<HTMLElement>('.ask-answer')!;
    this.busy = true;
    this.drawSend();

    let frame = 0;
    const repaint = () => {
      frame = 0;
      void this.render(view, turn);
      this.list.scrollTop = this.list.scrollHeight;
    };
    try {
      const pages = await documentText(doc);
      if (!pages.join('').trim()) throw new Error(t('This document has no text to work with. If it’s a scan, run Tools › Recognise text (OCR) first.'));
      const answer = await api().aiAsk(
        { system: SYSTEM, prompt: promptFor(doc.name, pages, question, history, budget), maxTokens: 900 },
        (piece) => {
          turn.answer += piece;
          frame ||= requestAnimationFrame(repaint);
        },
      );
      turn.answer = answer.trim() || turn.answer.trim() || t('Stopped.');
    } catch (err) {
      turn.error = true;
      turn.answer = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      cancelAnimationFrame(frame);
      this.busy = false;
      this.drawSend();
      if (this.host.doc() === doc) this.draw();
      else toast(t('Your question about “{name}” has been answered. Switch back to its tab to read it.', { name: doc.name }));
      this.input.focus();
    }
  }
}
