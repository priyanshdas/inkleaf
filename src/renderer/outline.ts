// SPDX-License-Identifier: GPL-3.0-or-later
// Bookmarks (the PDF's outline): read from the file, shown as a tree in the
// sidebar, and editable. Bookmarks can sit inside other bookmarks, the way
// a book's chapters hold its sections: add one inside another, drag one
// onto another, or move it with Alt+Shift and the arrow keys. Edits are
// kept in the document's undo history and written back on save; until
// something is edited, the file's own outline is left exactly as it was.

import { t } from '../shared/i18n';
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

/** A deep copy that can be rearranged freely. */
const copyTree = (list: readonly OutlineItem[]): OutlineItem[] => list.map((it) => ({ ...it, children: copyTree(it.children) }));

interface Spot {
  /** The list the item is in: the top level, or its parent's children. */
  list: OutlineItem[];
  index: number;
  parent: OutlineItem | null;
}

/** Where the bookmark `id` sits in `list` (a copy made with copyTree). */
function locate(list: OutlineItem[], id: string, parent: OutlineItem | null = null): Spot | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { list, index: i, parent };
    const inside = locate(list[i].children, id, list[i]);
    if (inside) return inside;
  }
  return null;
}

/** True if `id` is `item` itself or anywhere inside it. */
const contains = (item: OutlineItem, id: string): boolean => item.id === id || item.children.some((c) => contains(c, id));

/** Where a dragged bookmark lands, relative to the one it's dropped on. */
type Drop = 'before' | 'after' | 'inside';

/**
 * The bookmarks with `id` moved before, after or inside `target`, or null
 * if that isn't a move (a bookmark can't go inside itself).
 */
export function moveBookmark(items: readonly OutlineItem[], id: string, target: string, where: Drop): OutlineItem[] | null {
  if (id === target) return null;
  const tree = copyTree(items);
  const from = locate(tree, id);
  if (!from || contains(from.list[from.index], target)) return null;
  const [item] = from.list.splice(from.index, 1);
  const to = locate(tree, target);
  if (!to) return null;
  if (where === 'inside') to.list[to.index].children.push(item);
  else to.list.splice(to.index + (where === 'after' ? 1 : 0), 0, item);
  return tree;
}

/** The keyboard moves: up or down among its neighbours, into the one above it, or out of its parent. */
export function nudgeBookmark(items: readonly OutlineItem[], id: string, key: 'up' | 'down' | 'in' | 'out'): OutlineItem[] | null {
  const tree = copyTree(items);
  const at = locate(tree, id);
  if (!at) return null;
  const { list, index } = at;
  if (key === 'up' || key === 'down') {
    const other = index + (key === 'up' ? -1 : 1);
    if (other < 0 || other >= list.length) return null;
    [list[index], list[other]] = [list[other], list[index]];
    return tree;
  }
  if (key === 'in') {
    // becomes the last bookmark inside the one just above it
    if (index === 0) return null;
    const [item] = list.splice(index, 1);
    list[index - 1].children.push(item);
    return tree;
  }
  // out: goes just after the bookmark that held it
  if (!at.parent) return null;
  const [item] = list.splice(index, 1);
  const outer = locate(tree, at.parent.id)!;
  outer.list.splice(outer.index + 1, 0, item);
  return tree;
}

export class OutlinePanel {
  private fromFile: OutlineItem[] = [];
  private loadedFor: EditorDoc | null = null;
  private collapsed = new Set<string>();
  /** The bookmark being dragged. */
  private dragging: string | null = null;
  /** The bookmark to give the keyboard to once the list is drawn again. */
  private focusAfter: string | null = null;

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
      this.collapsed.clear();
      this.root.replaceChildren(h('div', { class: 'side-empty' }, h('p', {}, t('Reading bookmarks…'))));
      try {
        this.fromFile = await readOutline(doc);
      } catch {
        this.fromFile = [];
      }
      if (this.getDoc() !== doc) return;
    }

    const items = this.items(doc);
    const add = h('button', { class: 'btn small' }, icon('plus'), t('Add bookmark'));
    add.addEventListener('click', () => this.add(null));

    // expand or collapse every bookmark that holds others
    const parents: string[] = [];
    const walk = (list: readonly OutlineItem[]) => list.forEach((it) => {
      if (it.children.length) parents.push(it.id);
      walk(it.children);
    });
    walk(items);
    const allOpen = parents.every((id) => !this.collapsed.has(id));
    const fold = h('button', { class: 'btn small icon-only', title: allOpen ? t('Collapse all') : t('Expand all'), 'aria-label': allOpen ? t('Collapse all') : t('Expand all') },
      icon(allOpen ? 'chevrons-down-up' : 'chevrons-up-down'));
    fold.addEventListener('click', () => {
      if (allOpen) parents.forEach((id) => this.collapsed.add(id));
      else this.collapsed.clear();
      this.render();
    });

    const pageNumber = (id: string | null) => {
      const i = id ? doc.pageIndex(id) : -1;
      return i >= 0 ? String(i + 1) : '–';
    };

    const tree = (list: readonly OutlineItem[], depth: number): HTMLElement[] => list.flatMap((it) => {
      const open = !this.collapsed.has(it.id);
      const toggle = it.children.length
        ? h('button', { class: `bm-toggle${open ? ' open' : ''}`, title: open ? t('Collapse') : t('Expand'), tabindex: '-1' }, icon('chevron-right'))
        : h('span', { class: 'bm-toggle' });
      toggle.addEventListener('click', () => this.setOpen(it.id, !open));
      const go = h('button', {
        class: 'bm-title', title: it.title, 'data-id': it.id,
        'aria-expanded': it.children.length ? String(open) : undefined,
        'aria-disabled': !it.pageId || doc.pageIndex(it.pageId) < 0 ? 'true' : undefined,
      }, it.title);
      go.addEventListener('click', () => it.pageId && doc.pageIndex(it.pageId) >= 0 && this.viewer.scrollToPage(it.pageId));
      go.addEventListener('keydown', (e) => this.onKey(e, it));
      const inside = h('button', { class: 'bm-act', title: t('Add bookmark inside'), tabindex: '-1' }, icon('corner-down-right'));
      inside.addEventListener('click', () => this.add(it));
      const rename = h('button', { class: 'bm-act', title: t('Rename'), tabindex: '-1' }, icon('pencil'));
      rename.addEventListener('click', () => this.rename(it));
      const remove = h('button', { class: 'bm-act', title: t('Delete bookmark'), tabindex: '-1' }, icon('x'));
      remove.addEventListener('click', () => this.remove(it));
      const row = h('div', { class: 'bm-row', style: `--depth:${depth}`, draggable: 'true', 'data-id': it.id },
        toggle, go, h('span', { class: 'bm-page' }, pageNumber(it.pageId)), inside, rename, remove);
      this.dragHandlers(row, it);
      return [row, ...(open ? tree(it.children, depth + 1) : [])];
    });

    this.root.replaceChildren(
      h('div', { class: 'side-actions-row' }, add, parents.length ? fold : null),
      items.length
        ? h('div', { class: 'bm-list', role: 'tree' }, ...tree(items, 0))
        : h('div', { class: 'side-empty' }, icon('bookmark'), h('p', {}, t('This PDF has no bookmarks yet. Add one for the page you’re on, and it’s saved with the file.'))),
    );
    if (this.focusAfter) {
      this.root.querySelector<HTMLElement>(`.bm-title[data-id="${CSS.escape(this.focusAfter)}"]`)?.focus();
      this.focusAfter = null;
    }
  }

  private setOpen(id: string, open: boolean) {
    if (open) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.render();
  }

  private edit(next: OutlineItem[], focus?: string) {
    if (focus) this.focusAfter = focus;
    this.getDoc()?.setOutline(next);
  }

  /**
   * Keys on a bookmark: Up and Down step through the list; Right and Left
   * open and close it; Alt+Shift with an arrow moves it; F2 renames it and
   * Delete removes it.
   */
  private onKey(e: KeyboardEvent, it: OutlineItem) {
    const doc = this.getDoc();
    if (!doc) return;
    const moves: Record<string, 'up' | 'down' | 'in' | 'out'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'in', ArrowLeft: 'out' };
    if (e.altKey && e.shiftKey && moves[e.key]) {
      e.preventDefault();
      const next = nudgeBookmark(this.items(doc), it.id, moves[e.key]);
      if (!next) return;
      // a bookmark moved inside another needs that one open to be seen
      const parent = locate(next, it.id)?.parent;
      if (parent) this.collapsed.delete(parent.id);
      this.edit(next, it.id);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const titles = [...this.root.querySelectorAll<HTMLElement>('.bm-title')];
    const here = titles.indexOf(e.currentTarget as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      titles[here + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (e.key === 'ArrowRight' && it.children.length) {
      e.preventDefault();
      if (this.collapsed.has(it.id)) {
        this.focusAfter = it.id;
        this.setOpen(it.id, true);
      } else titles[here + 1]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (it.children.length && !this.collapsed.has(it.id)) {
        this.focusAfter = it.id;
        this.setOpen(it.id, false);
      } else {
        const parent = locate(copyTree(this.items(doc)), it.id)?.parent;
        if (parent) this.root.querySelector<HTMLElement>(`.bm-title[data-id="${CSS.escape(parent.id)}"]`)?.focus();
      }
    } else if (e.key === 'F2') {
      e.preventDefault();
      this.rename(it);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      this.remove(it);
    }
  }

  /** Dragging a bookmark onto another: its top edge puts it before, its bottom edge after, its middle inside. */
  private dragHandlers(row: HTMLElement, it: OutlineItem) {
    const zone = (e: DragEvent): Drop => {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
    };
    const clear = () => row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    row.addEventListener('dragstart', (e) => {
      this.dragging = it.id;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/x-inkleaf-bookmark', it.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragging = null;
      row.classList.remove('dragging');
      this.root.querySelectorAll('.bm-row').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    });
    row.addEventListener('dragover', (e) => {
      const doc = this.getDoc();
      if (!this.dragging || !doc) return;
      const dragged = locate(copyTree(this.items(doc)), this.dragging);
      if (!dragged || contains(dragged.list[dragged.index], it.id)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      clear();
      row.classList.add(`drop-${zone(e)}`);
    });
    row.addEventListener('dragleave', clear);
    row.addEventListener('drop', (e) => {
      const doc = this.getDoc();
      const id = this.dragging;
      clear();
      if (!doc || !id) return;
      e.preventDefault();
      const where = zone(e);
      const next = moveBookmark(this.items(doc), id, it.id, where);
      if (!next) return;
      if (where === 'inside') this.collapsed.delete(it.id);
      this.edit(next, id);
    });
  }

  /** Adds a bookmark for the page on screen: at the top level in page order, or inside `parent`. */
  private async add(parent: OutlineItem | null) {
    const doc = this.getDoc();
    const pageId = this.viewer.currentPageId ?? doc?.pages[0]?.id;
    if (!doc || !pageId) return;
    const title = await promptDialog(parent ? t('Add bookmark inside') : t('Add bookmark'), t('Bookmark name'), { value: t('Page {n}', { n: doc.pageIndex(pageId) + 1 }) });
    if (!title?.trim()) return;
    const made: OutlineItem = { id: newId('bm'), title: title.trim(), pageId, children: [] };
    const tree = copyTree(this.items(doc));
    const list = parent ? locate(tree, parent.id)?.list[locate(tree, parent.id)!.index].children : tree;
    if (!list) return;
    // keep bookmarks in page order among their neighbours
    const at = doc.pageIndex(pageId);
    let i = 0;
    while (i < list.length && (list[i].pageId ? doc.pageIndex(list[i].pageId!) : -1) <= at) i++;
    list.splice(i, 0, made);
    if (parent) this.collapsed.delete(parent.id);
    this.edit(tree, made.id);
  }

  private async rename(item: OutlineItem) {
    const doc = this.getDoc();
    if (!doc) return;
    const title = await promptDialog(t('Rename bookmark'), t('Bookmark name'), { value: item.title });
    if (!title?.trim() || title.trim() === item.title) return;
    this.edit(mapTree(this.items(doc), (x) => (x.id === item.id ? { ...x, title: title.trim() } : x)), item.id);
  }

  /** Removes a bookmark, and the ones inside it. */
  private remove(item: OutlineItem) {
    const doc = this.getDoc();
    if (!doc) return;
    this.edit(mapTree(this.items(doc), (x) => (x.id === item.id ? null : x)));
  }
}
