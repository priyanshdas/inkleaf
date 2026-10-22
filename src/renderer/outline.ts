// SPDX-License-Identifier: GPL-3.0-or-later
// Bookmarks (the PDF's outline): read from the file, shown as a tree in the
// sidebar, and editable. Edits are kept in the document's undo history and
// written back on save; until something is edited, the file's own outline is
// left exactly as it was.

import type { EditorDoc } from './document';
import { newId } from './geometry';
import type { OutlineItem } from './types';
import { h, icon, promptDialog } from './ui';
import type { Viewer } from './viewer';

interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

/** Reads the file's own bookmarks and works out which page each opens. */
async function readOutline(doc: EditorDoc): Promise<OutlineItem[]> {
  const source = doc.sources.get(doc.mainSource);
  if (!source) return [];
  const pdf = source.pdf;
  const nodes = ((await pdf.getOutline()) ?? []) as unknown as PdfOutlineNode[];

  const pageFor = async (dest: PdfOutlineNode['dest']): Promise<string | null> => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      const target = explicit[0];
      const index = typeof target === 'number' ? target : await pdf.getPageIndex(target as Parameters<typeof pdf.getPageIndex>[0]);
      return doc.pages.find((p) => p.src === doc.mainSource && p.index === index)?.id ?? null;
    } catch {
      return null;
    }
  };

  const convert = async (list: PdfOutlineNode[]): Promise<OutlineItem[]> =>
    Promise.all(list.map(async (n) => ({
      id: newId('bm'),
      title: n.title || 'Untitled',
      pageId: await pageFor(n.dest),
      children: await convert(n.items ?? []),
    })));
  return convert(nodes);
}

/** Deep copy with one item changed or removed. */
function mapTree(list: readonly OutlineItem[], fn: (it: OutlineItem) => OutlineItem | null): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const it of list) {
    const next = fn(it);
    if (!next) continue;
    out.push({ ...next, children: mapTree(next.children, fn) });
  }
  return out;
}

export class OutlinePanel {
  private fromFile: OutlineItem[] = [];
  private loadedFor: EditorDoc | null = null;
  private collapsed = new Set<string>();

  constructor(private root: HTMLElement, private viewer: Viewer, private getDoc: () => EditorDoc | null) {}

  /** The bookmarks in effect: edited ones, or the file's own. */
  private items(doc: EditorDoc): readonly OutlineItem[] {
    return doc.outline ?? this.fromFile;
  }

  async render() {
    const doc = this.getDoc();
    if (!doc) {
      this.root.replaceChildren();
      return;
    }
    if (this.loadedFor !== doc) {
      this.loadedFor = doc;
      this.fromFile = [];
      this.root.replaceChildren(h('div', { class: 'side-empty' }, h('p', {}, 'Reading bookmarks…')));
      try {
        this.fromFile = await readOutline(doc);
      } catch {
        this.fromFile = [];
      }
      if (this.getDoc() !== doc) return;
    }

    const items = this.items(doc);
    const add = h('button', { class: 'btn small' }, icon('plus'), 'Add bookmark');
    add.addEventListener('click', () => this.add());

    const pageNumber = (id: string | null) => {
      const i = id ? doc.pageIndex(id) : -1;
      return i >= 0 ? String(i + 1) : '–';
    };

    const tree = (list: readonly OutlineItem[], depth: number): HTMLElement[] => list.flatMap((it) => {
      const open = !this.collapsed.has(it.id);
      const toggle = it.children.length
        ? h('button', { class: `bm-toggle${open ? ' open' : ''}`, title: open ? 'Collapse' : 'Expand' }, icon('chevron-right'))
        : h('span', { class: 'bm-toggle' });
      toggle.addEventListener('click', () => {
        if (open) this.collapsed.add(it.id);
        else this.collapsed.delete(it.id);
        this.render();
      });
      const go = h('button', { class: 'bm-title', title: it.title, disabled: !it.pageId || doc.pageIndex(it.pageId) < 0 }, it.title);
      go.addEventListener('click', () => it.pageId && this.viewer.scrollToPage(it.pageId));
      const rename = h('button', { class: 'bm-act', title: 'Rename' }, icon('pencil'));
      rename.addEventListener('click', () => this.rename(it));
      const remove = h('button', { class: 'bm-act', title: 'Delete bookmark' }, icon('x'));
      remove.addEventListener('click', () => this.edit(mapTree(this.items(doc), (x) => (x.id === it.id ? null : x))));
      const row = h('div', { class: 'bm-row', style: `--depth:${depth}` },
        toggle, go, h('span', { class: 'bm-page' }, pageNumber(it.pageId)), rename, remove);
      return [row, ...(open ? tree(it.children, depth + 1) : [])];
    });

    this.root.replaceChildren(
      h('div', { class: 'side-actions-row' }, add),
      items.length
        ? h('div', { class: 'bm-list' }, ...tree(items, 0))
        : h('div', { class: 'side-empty' }, icon('bookmark'), h('p', {}, 'This PDF has no bookmarks yet. Add one for the page you’re on, and it’s saved with the file.')),
    );
  }

  private edit(next: OutlineItem[]) {
    this.getDoc()?.setOutline(next);
  }

  private async add() {
    const doc = this.getDoc();
    const pageId = this.viewer.currentPageId ?? doc?.pages[0]?.id;
    if (!doc || !pageId) return;
    const title = await promptDialog('Add bookmark', 'Bookmark name', { value: `Page ${doc.pageIndex(pageId) + 1}` });
    if (!title?.trim()) return;
    // keep bookmarks in page order at the top level
    const list = [...this.items(doc)];
    const at = doc.pageIndex(pageId);
    let i = 0;
    while (i < list.length && (list[i].pageId ? doc.pageIndex(list[i].pageId!) : -1) <= at) i++;
    list.splice(i, 0, { id: newId('bm'), title: title.trim(), pageId, children: [] });
    this.edit(list);
  }

  private async rename(item: OutlineItem) {
    const doc = this.getDoc();
    if (!doc) return;
    const title = await promptDialog('Rename bookmark', 'Bookmark name', { value: item.title });
    if (!title?.trim() || title.trim() === item.title) return;
    this.edit(mapTree(this.items(doc), (x) => (x.id === item.id ? { ...x, title: title.trim() } : x)));
  }
}
