// SPDX-License-Identifier: GPL-3.0-or-later
// Find in document (Ctrl+F). Searches every page's text, highlights all the
// matches on the pages you can see and steps through them one at a time.

import { t } from '../shared/i18n';
import type { EditorDoc } from './document';
import { matchQuads, pageText, PageText, placeQuad, Quad } from './text-finder';
import { h, icon } from './ui';
import type { PageView, Viewer } from './viewer';

interface Match {
  pageId: string;
  quads: Quad[];
}

export class FindBar {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private count: HTMLSpanElement;
  private caseButton: HTMLButtonElement;
  private matches: Match[] = [];
  private current = -1;
  private matchCase = false;
  private searchId = 0;
  private timer = 0;
  /** Page text, per source document and page index. */
  private texts = new WeakMap<object, Map<number, Promise<PageText>>>();

  constructor(private viewer: Viewer, private getDoc: () => EditorDoc | null) {
    this.input = h('input', { class: 'find-input', type: 'search', placeholder: t('Find in document'), 'aria-label': t('Find in document'), spellcheck: 'false' });
    this.count = h('span', { class: 'find-count', 'aria-live': 'polite' });
    this.caseButton = h('button', { class: 'find-btn', title: t('Match case'), 'aria-pressed': 'false' }, icon('case-sensitive'));
    const prev = h('button', { class: 'find-btn', title: t('Previous (Shift+Enter)') }, icon('arrow-up'));
    const next = h('button', { class: 'find-btn', title: t('Next (Enter)') }, icon('arrow-down'));
    const close = h('button', { class: 'find-btn', title: t('Close (Esc)') }, icon('x'));
    this.el = h('div', { class: 'find-bar', role: 'search', hidden: true },
      icon('search'), this.input, this.count, this.caseButton, h('span', { class: 'find-sep' }), prev, next, close);
    viewer.container.parentElement!.append(this.el);

    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.search(), 160);
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.caseButton.addEventListener('click', () => {
      this.matchCase = !this.matchCase;
      this.caseButton.setAttribute('aria-pressed', String(this.matchCase));
      this.search();
    });
    prev.addEventListener('click', () => this.step(-1));
    next.addEventListener('click', () => this.step(1));
    close.addEventListener('click', () => this.close());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(initial?: string) {
    this.el.hidden = false;
    if (initial) this.input.value = initial;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.search();
  }

  close() {
    this.el.hidden = true;
    this.searchId++;
    this.matches = [];
    this.current = -1;
    this.clearMarks();
    this.viewer.container.focus();
  }

  /** The document changed under us (tab switch, OCR): start over. */
  reset() {
    this.texts = new WeakMap();
    if (this.isOpen && this.input.value) this.search();
    else {
      this.matches = [];
      this.clearMarks();
    }
  }

  private text(doc: EditorDoc, pageId: string): Promise<PageText> | null {
    const ref = doc.page(pageId);
    const source = ref && doc.sources.get(ref.src);
    if (!ref || !source) return null;
    let perDoc = this.texts.get(source.pdf);
    if (!perDoc) {
      perDoc = new Map();
      this.texts.set(source.pdf, perDoc);
    }
    let pending = perDoc.get(ref.index);
    if (!pending) {
      pending = source.pdf.getPage(ref.index + 1).then(pageText);
      perDoc.set(ref.index, pending);
    }
    return pending;
  }

  private async search() {
    const doc = this.getDoc();
    const query = this.input.value;
    const id = ++this.searchId;
    this.matches = [];
    this.current = -1;
    this.clearMarks();
    if (!doc || !query.trim()) {
      this.count.textContent = '';
      return;
    }
    const needle = this.matchCase ? query : query.toLowerCase();
    this.count.textContent = t('Searching…');

    // start from the page you're on, so the first hit is the nearest one
    const startAt = Math.max(0, this.viewer.currentPageId ? doc.pageIndex(this.viewer.currentPageId) : 0);
    let firstAfter = -1;
    for (let k = 0; k < doc.pages.length; k++) {
      const ref = doc.pages[k];
      const pending = this.text(doc, ref.id);
      if (!pending) continue;
      const pt = await pending;
      if (id !== this.searchId) return; // a newer search took over
      const hay = this.matchCase ? pt.text : pt.text.toLowerCase();
      for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + Math.max(1, needle.length))) {
        if (firstAfter < 0 && k >= startAt) firstAfter = this.matches.length;
        this.matches.push({ pageId: ref.id, quads: matchQuads(pt, at, at + needle.length) });
      }
      // show progress on long documents without redrawing on every page
      if (k % 20 === 19) this.count.textContent = t('{count} so far…', { count: this.matches.length });
    }
    if (!this.matches.length) {
      this.count.textContent = t('No matches');
      return;
    }
    this.current = firstAfter >= 0 ? firstAfter : 0;
    this.show();
  }

  private step(delta: number) {
    if (!this.matches.length) {
      if (this.input.value) this.search();
      return;
    }
    this.current = (this.current + delta + this.matches.length) % this.matches.length;
    this.show();
  }

  private show() {
    const m = this.matches[this.current];
    this.count.textContent = t('{n} of {total}', { n: this.current + 1, total: this.matches.length });
    const view = this.viewer.views.get(m.pageId);
    if (!view) return;
    if (this.viewer.mode === 'single') this.viewer.scrollToPage(m.pageId, false);
    // bring the match into the middle of the window once the page is laid out
    requestAnimationFrame(() => {
      this.paintAll();
      if (!view.viewport) {
        this.viewer.scrollToPage(m.pageId, false);
        requestAnimationFrame(() => this.reveal(view, m));
        return;
      }
      this.reveal(view, m);
    });
  }

  private reveal(view: PageView, m: Match) {
    const c = this.viewer.container;
    const quad = m.quads[0];
    if (!quad) return;
    let top = view.el.offsetTop, left = view.el.offsetLeft;
    if (view.viewport) {
      const [x, y] = this.viewer.toLocal(view, quad[0][0], quad[0][1]);
      top += y;
      left += x;
    }
    const pad = 120;
    if (top < c.scrollTop + pad || top > c.scrollTop + c.clientHeight - pad) c.scrollTop = top - c.clientHeight / 3;
    if (left < c.scrollLeft || left > c.scrollLeft + c.clientWidth - 60) c.scrollLeft = left - c.clientWidth / 3;
    this.paintAll();
  }

  private clearMarks() {
    this.viewer.container.querySelectorAll('.find-mark').forEach((el) => el.remove());
  }

  private paintAll() {
    for (const view of this.viewer.views.values()) this.layout(view);
  }

  /** Re-places the highlights on one page; called after each page render. */
  layout(view: PageView) {
    view.overlay.querySelectorAll('.find-mark').forEach((el) => el.remove());
    if (!this.isOpen || !view.viewport || !this.matches.length) return;
    const active = this.matches[this.current];
    for (const m of this.matches) {
      if (m.pageId !== view.ref.id) continue;
      for (const q of m.quads) {
        const el = h('div', { class: `find-mark${m === active ? ' current' : ''}` });
        placeQuad(el, q, (x, y) => this.viewer.toLocal(view, x, y));
        view.overlay.append(el);
      }
    }
  }
}
