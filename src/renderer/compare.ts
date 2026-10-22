// SPDX-License-Identifier: GPL-3.0-or-later
// Compare two PDFs word by word. Both are shown side by side with removed
// words marked on the left and added words on the right, and a list of every
// change to step through.
//
// The comparison works on the text, not the pixels: it finds the smallest set
// of words to remove and add to turn one version into the other (the Myers
// diff), first line by line and then word by word inside changed lines, which
// keeps it quick even for long documents.

import { loadPdf, PDFDocumentProxy } from './pdf';
import { pageRuns, placeQuad, Quad, runSpan, spanQuad } from './text-finder';
import { h, icon } from './ui';

interface Word {
  text: string;
  page: number;
  quad: Quad;
}

interface Line {
  text: string;
  words: Word[];
}

interface Change {
  removed: Word[];
  added: Word[];
}

type Op = { kind: 'same' | 'del' | 'add'; a: number; b: number };

/**
 * Myers' shortest edit script between two lists. Returns null when they
 * differ by more than `limit` edits (too different to be worth showing).
 */
export function diff(a: string[], b: string[], limit = 4000): Op[] | null {
  const n = a.length, m = b.length, max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, limit); d++) {
    trace.push(v.slice());
    const next = v;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && next[offset + k - 1] < next[offset + k + 1]) ? next[offset + k + 1] : next[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) {
      trace.push(v.slice());
      break;
    }
  }
  if (found < 0) return null;

  // walk back through the saved frontiers to recover the edits
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = prev[offset + pk], py = px - pk;
    while (x > px && y > py) ops.push({ kind: 'same', a: --x, b: --y });
    if (down) ops.push({ kind: 'add', a: x, b: --y });
    else ops.push({ kind: 'del', a: --x, b: y });
  }
  while (x > 0 && y > 0) ops.push({ kind: 'same', a: --x, b: --y });
  return ops.reverse();
}

async function linesOf(pdf: PDFDocumentProxy, progress: (n: number) => void): Promise<Line[]> {
  const lines: Line[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    progress(p);
    const runs = await pageRuns(await pdf.getPage(p));
    for (const run of runs) {
      const words: Word[] = [];
      for (const m of run.str.matchAll(/\S+/g)) {
        const [x0, x1] = runSpan(run, m.index!, m.index! + m[0].length);
        words.push({ text: m[0], page: p - 1, quad: spanQuad(run, x0, x1) });
      }
      if (words.length) lines.push({ text: words.map((w) => w.text).join(' '), words });
    }
  }
  return lines;
}

/** Words removed and added, grouped into changes in reading order. */
function changes(a: Line[], b: Line[]): Change[] | null {
  const byLine = diff(a.map((l) => l.text), b.map((l) => l.text), 3000);
  if (!byLine) return null;
  const out: Change[] = [];
  let removedLines: Line[] = [], addedLines: Line[] = [];
  const flush = () => {
    if (!removedLines.length && !addedLines.length) return;
    // within the changed block, find exactly which words differ
    const aw = removedLines.flatMap((l) => l.words), bw = addedLines.flatMap((l) => l.words);
    const ops = diff(aw.map((w) => w.text), bw.map((w) => w.text), 2000);
    if (!ops) {
      out.push({ removed: aw, added: bw });
    } else {
      let cur: Change | null = null;
      for (const op of ops) {
        if (op.kind === 'same') {
          if (cur) out.push(cur);
          cur = null;
          continue;
        }
        cur ??= { removed: [], added: [] };
        if (op.kind === 'del') cur.removed.push(aw[op.a]);
        else cur.added.push(bw[op.b]);
      }
      if (cur) out.push(cur);
    }
    removedLines = [];
    addedLines = [];
  };
  for (const op of byLine) {
    if (op.kind === 'same') flush();
    else if (op.kind === 'del') removedLines.push(a[op.a]);
    else addedLines.push(b[op.b]);
  }
  flush();
  return out;
}

const excerpt = (words: Word[]) => {
  const text = words.map((w) => w.text).join(' ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/** One side of the comparison: a scrolling column of rendered pages. */
class Column {
  readonly el: HTMLDivElement;
  private pages: HTMLDivElement[] = [];
  private scales: number[] = [];
  private observer: IntersectionObserver;

  constructor(private pdf: PDFDocumentProxy, private title: string, private side: 'old' | 'new') {
    this.el = h('div', { class: 'cmp-col' });
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.render(Number((e.target as HTMLElement).dataset.index));
    }, { root: this.el, rootMargin: '600px 0px' });
  }

  async build(width: number, marks: Map<number, Quad[]>) {
    this.el.replaceChildren(h('div', { class: 'cmp-title' }, h('span', { class: `cmp-badge ${this.side}` }, this.side === 'old' ? 'Before' : 'After'), this.title));
    for (let i = 0; i < this.pdf.numPages; i++) {
      const page = await this.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const scale = width / vp.width;
      const view = page.getViewport({ scale });
      const el = h('div', { class: 'cmp-page', 'data-index': String(i), style: `width:${Math.floor(view.width)}px;height:${Math.floor(view.height)}px` });
      for (const q of marks.get(i) ?? []) {
        const mark = h('div', { class: `cmp-mark ${this.side}` });
        placeQuad(mark, q, (x, y) => view.convertToViewportPoint(x, y) as [number, number], 1);
        el.append(mark);
      }
      this.pages.push(el);
      this.scales.push(scale);
      this.el.append(el);
      this.observer.observe(el);
    }
  }

  private async render(i: number) {
    const el = this.pages[i];
    if (!el || el.dataset.drawn) return;
    el.dataset.drawn = '1';
    const page = await this.pdf.getPage(i + 1);
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: this.scales[i] * ratio });
    const canvas = h('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    el.prepend(canvas);
  }

  /** Scrolls so a word on a page is a third of the way down. */
  reveal(page: number, quad: Quad | undefined) {
    const el = this.pages[page];
    if (!el) return;
    let top = el.offsetTop;
    if (quad) top += el.offsetHeight - quad[0][1] * this.scales[page] - 4;
    this.el.scrollTo({ top: top - this.el.clientHeight / 3, behavior: 'smooth' });
  }

  destroy() {
    this.observer.disconnect();
    this.pdf.loadingTask.destroy();
  }
}

/**
 * Shows the comparison over the whole window. `before` is the other file,
 * `after` the open document (as it is now, edits included).
 */
export async function showComparison(
  before: { name: string; bytes: Uint8Array },
  after: { name: string; bytes: Uint8Array },
  progress: (message: string) => void,
): Promise<void> {
  const oldPdf = await loadPdf(before.bytes);
  const newPdf = await loadPdf(after.bytes);
  const a = await linesOf(oldPdf, (n) => progress(`Reading “${before.name}”, page ${n} of ${oldPdf.numPages}…`));
  const b = await linesOf(newPdf, (n) => progress(`Reading “${after.name}”, page ${n} of ${newPdf.numPages}…`));
  progress('Comparing…');
  const found = changes(a, b);

  const marksOld = new Map<number, Quad[]>(), marksNew = new Map<number, Quad[]>();
  for (const c of found ?? []) {
    for (const w of c.removed) marksOld.set(w.page, [...(marksOld.get(w.page) ?? []), w.quad]);
    for (const w of c.added) marksNew.set(w.page, [...(marksNew.get(w.page) ?? []), w.quad]);
  }

  const left = new Column(oldPdf, before.name, 'old');
  const right = new Column(newPdf, after.name, 'new');
  const list = h('div', { class: 'cmp-list' });
  const count = h('span', { class: 'cmp-count' });
  const close = h('button', { class: 'btn' }, icon('x'), 'Close');
  const prev = h('button', { class: 'btn btn-ghost', title: 'Previous change' }, icon('arrow-up'));
  const next = h('button', { class: 'btn btn-ghost', title: 'Next change' }, icon('arrow-down'));
  const overlay = h('div', { class: 'compare-view', role: 'dialog', 'aria-label': 'Compare documents' },
    h('header', { class: 'cmp-head' }, icon('git-compare'), h('strong', {}, 'Compare'), count, h('span', { class: 'spacer' }), prev, next, close),
    h('div', { class: 'cmp-body' }, left.el, right.el, list));
  document.body.append(overlay);

  const colWidth = Math.max(280, Math.floor((overlay.clientWidth - 300 - 64) / 2));
  await Promise.all([left.build(colWidth, marksOld), right.build(colWidth, marksNew)]);

  let current = -1;
  const items: HTMLElement[] = [];
  const go = (i: number) => {
    if (!found?.length) return;
    current = (i + found.length) % found.length;
    const c = found[current];
    const first = (ws: Word[]) => ws[0];
    const ra = first(c.removed), rb = first(c.added);
    // a pure addition has no words on the left: show the nearest spot there
    if (ra) left.reveal(ra.page, ra.quad);
    if (rb) right.reveal(rb.page, rb.quad);
    if (!ra && rb) left.reveal(Math.min(rb.page, oldPdf.numPages - 1), undefined);
    if (!rb && ra) right.reveal(Math.min(ra.page, newPdf.numPages - 1), undefined);
    items.forEach((el, k) => el.classList.toggle('current', k === current));
    items[current]?.scrollIntoView({ block: 'nearest' });
  };

  if (!found) {
    count.textContent = 'These documents are too different to compare word by word.';
  } else if (!found.length) {
    count.textContent = 'No differences in the text.';
    list.append(h('div', { class: 'side-empty' }, icon('check'), h('p', {}, 'The words are identical. (Pictures and layout aren’t compared.)')));
  } else {
    count.textContent = `${found.length} change${found.length === 1 ? '' : 's'}`;
    found.forEach((c, i) => {
      const page = (c.added[0] ?? c.removed[0]).page + 1;
      const el = h('button', { class: 'cmp-item' },
        h('span', { class: 'cmp-item-page' }, `Page ${page}`),
        c.removed.length ? h('span', { class: 'cmp-del' }, excerpt(c.removed)) : null,
        c.added.length ? h('span', { class: 'cmp-add' }, excerpt(c.added)) : null);
      el.addEventListener('click', () => go(i));
      items.push(el);
    });
    list.append(...items);
  }

  await new Promise<void>((resolve) => {
    const done = () => {
      document.removeEventListener('keydown', onKey, true);
      left.destroy();
      right.destroy();
      overlay.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done();
      } else if (e.key === 'ArrowDown' || e.key === 'n') {
        e.preventDefault();
        go(current + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'p') {
        e.preventDefault();
        go(current - 1);
      }
    };
    document.addEventListener('keydown', onKey, true);
    close.addEventListener('click', done);
    prev.addEventListener('click', () => go(current - 1));
    next.addEventListener('click', () => go(current + 1));
  });
}
