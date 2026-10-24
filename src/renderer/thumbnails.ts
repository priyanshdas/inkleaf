// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../shared/i18n';
import type { EditorDoc } from './document';
import { decorTexts } from './decor';
import { AnnotationMode, pageViewport } from './pdf';
import { drawAnnots, Transform } from './render';
import { h, icon, toast } from './ui';
import type { Viewer } from './viewer';

const THUMB_WIDTH = 132;

interface Thumb {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  label: HTMLElement;
  /** What the canvas currently shows: page rotation and the marks array. */
  rotation: number;
  annots: readonly unknown[] | null;
  decor: unknown;
  /** The PDF page alone, cached so a new mark doesn't re-render the page. */
  page: HTMLCanvasElement | null;
  /** Rotation, crop and source the cached page was drawn for. */
  pageKey: string;
  rendering: boolean;
}

/**
 * The page strip on the left. Click to jump, Ctrl/Cmd or Shift-click to pick
 * several, drag to reorder.
 */
export class Thumbnails extends EventTarget {
  readonly selected = new Set<string>();
  private anchor: string | null = null;
  private thumbs = new Map<string, Thumb>();
  private observer: IntersectionObserver;
  private visible = new Set<string>();
  private dragging: string[] = [];
  private indicator = h('div', { class: 'thumb-drop-indicator' });
  private dropIndex = -1;
  private timer = 0;

  constructor(private list: HTMLElement, private viewer: Viewer, private getDoc: () => EditorDoc | null) {
    super();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.pageId!;
        if (e.isIntersecting) this.visible.add(id);
        else this.visible.delete(id);
      }
      this.schedule();
    }, { root: list.parentElement, rootMargin: '400px 0px' });

    list.addEventListener('dragover', (e) => this.onDragOver(e));
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget as Node)) this.hideIndicator();
    });
    list.addEventListener('drop', (e) => this.onDrop(e));
    viewer.addEventListener('pagechange', () => this.markCurrent());
  }

  private get doc() {
    return this.getDoc();
  }

  /** Rebuilds the strip to match the document's page list. */
  sync() {
    const doc = this.doc;
    if (!doc) {
      for (const t of this.thumbs.values()) this.observer.unobserve(t.el);
      this.thumbs.clear();
      this.list.replaceChildren();
      this.selected.clear();
      return;
    }
    const ids = new Set(doc.pages.map((p) => p.id));
    for (const [id, t] of this.thumbs) {
      if (!ids.has(id)) {
        this.observer.unobserve(t.el);
        t.el.remove();
        this.thumbs.delete(id);
        this.selected.delete(id);
      }
    }
    doc.pages.forEach((ref, i) => {
      let t = this.thumbs.get(ref.id);
      if (!t) {
        t = this.create(ref.id);
        this.thumbs.set(ref.id, t);
        this.observer.observe(t.el);
      }
      t.label.textContent = String(i + 1);
      const { width, height } = doc.displaySize(ref);
      t.canvas.style.aspectRatio = `${width} / ${height}`;
      if (this.list.children[i] !== t.el) this.list.insertBefore(t.el, this.list.children[i] ?? null);
    });
    this.markSelection();
    this.markCurrent();
    this.schedule();
  }

  private create(id: string): Thumb {
    const canvas = h('canvas', { class: 'thumb-canvas' });
    const label = h('span', { class: 'thumb-label' });
    const action = (name: string, title: string, fn: () => void) => {
      const b = h('button', { class: 'thumb-action', title, 'aria-label': title }, icon(name));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const actions = h('div', { class: 'thumb-actions' },
      action('rotate-ccw', t('Rotate left'), () => this.doc?.rotatePages(this.targets(id), -90)),
      action('rotate-cw', t('Rotate right'), () => this.doc?.rotatePages(this.targets(id), 90)),
      action('trash-2', t('Delete page'), () => this.dispatchEvent(new CustomEvent('delete', { detail: this.targets(id) }))),
    );
    const el = h('div', { class: 'thumb', draggable: 'true', 'data-page-id': id, tabindex: '0', role: 'option' },
      h('div', { class: 'thumb-frame' }, canvas, actions),
      label,
    );

    el.addEventListener('click', (e) => this.onClick(id, e));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.dispatchEvent(new CustomEvent('delete', { detail: this.targets(id) }));
      }
    });
    el.addEventListener('dragstart', (e) => {
      this.dragging = this.targets(id);
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/x-inkleaf-pages', this.dragging.join(','));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      this.dragging = [];
      this.hideIndicator();
    });
    return { el, canvas, label, rotation: -1, annots: null, decor: null, page: null, pageKey: '', rendering: false };
  }

  /** The pages an action on `id` applies to: the selection if `id` is in it. */
  private targets(id: string): string[] {
    const doc = this.doc!;
    if (this.selected.has(id) && this.selected.size > 1) {
      return doc.pages.filter((p) => this.selected.has(p.id)).map((p) => p.id);
    }
    return [id];
  }

  private onClick(id: string, e: MouseEvent) {
    const doc = this.doc!;
    if (e.shiftKey && this.anchor) {
      const a = doc.pageIndex(this.anchor), b = doc.pageIndex(id);
      const [from, to] = a < b ? [a, b] : [b, a];
      if (!(e.metaKey || e.ctrlKey)) this.selected.clear();
      for (let i = from; i <= to; i++) this.selected.add(doc.pages[i].id);
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.anchor = id;
    } else {
      this.selected.clear();
      this.selected.add(id);
      this.anchor = id;
    }
    this.markSelection();
    this.viewer.scrollToPage(id);
  }

  selectAll() {
    this.doc?.pages.forEach((p) => this.selected.add(p.id));
    this.markSelection();
  }

  /** Selected pages in document order, or the current page if none are. */
  chosenPages(): string[] {
    const doc = this.doc;
    if (!doc) return [];
    const picked = doc.pages.filter((p) => this.selected.has(p.id)).map((p) => p.id);
    if (picked.length) return picked;
    return this.viewer.currentPageId ? [this.viewer.currentPageId] : [];
  }

  private markSelection() {
    for (const [id, t] of this.thumbs) t.el.classList.toggle('selected', this.selected.has(id));
    this.dispatchEvent(new CustomEvent('selectionchange'));
  }

  private markCurrent() {
    for (const [id, t] of this.thumbs) {
      const current = id === this.viewer.currentPageId;
      t.el.classList.toggle('current', current);
      if (current && !this.list.matches(':hover')) t.el.scrollIntoView({ block: 'nearest' });
    }
  }

  // --- drag & drop ----------------------------------------------------------

  private indexAt(clientY: number): number {
    const items = [...this.list.querySelectorAll<HTMLElement>('.thumb')];
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return items.length;
  }

  private onDragOver(e: DragEvent) {
    const types = e.dataTransfer?.types ?? [];
    const pages = types.includes('application/x-inkleaf-pages');
    const files = types.includes('Files');
    if (!pages && !files) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = pages ? 'move' : 'copy';
    this.dropIndex = this.indexAt(e.clientY);
    const items = this.list.querySelectorAll<HTMLElement>('.thumb');
    const ref = items[this.dropIndex];
    if (ref) this.list.insertBefore(this.indicator, ref);
    else this.list.append(this.indicator);
  }

  private hideIndicator() {
    this.indicator.remove();
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.hideIndicator();
    const doc = this.doc;
    if (!doc) return;
    const index = this.dropIndex >= 0 ? this.dropIndex : doc.pages.length;

    if (this.dragging.length) {
      this.dispatchEvent(new CustomEvent('move', { detail: { ids: this.dragging, index } }));
      return;
    }
    const pdfs = [...(e.dataTransfer?.files ?? [])].filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length) this.dispatchEvent(new CustomEvent('insert-files', { detail: { files: pdfs, index } }));
    else if (e.dataTransfer?.files.length) toast(t('Only PDF files can be inserted as pages.'), 'error');
  }

  // --- rendering --------------------------------------------------------------

  /** Re-renders thumbnails whose page or annotations changed. Cheap to call often. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.renderVisible(), 180);
  }

  private async renderVisible() {
    const doc = this.doc;
    if (!doc) return;
    for (const id of this.visible) {
      const t = this.thumbs.get(id);
      const ref = doc.page(id);
      if (!t || !ref || t.rendering) continue;
      const rotation = doc.displayRotation(ref);
      const annots = doc.annots(id);
      const decor = doc.decor;
      if (t.rotation === rotation && t.annots === annots && t.decor === decor && t.pageKey === this.pageKey(id)) continue;
      t.rendering = true;
      try {
        await this.render(t, id);
        t.rotation = rotation;
        t.annots = annots;
        t.decor = decor;
      } catch (err) {
        console.warn('thumbnail failed', err);
      } finally {
        t.rendering = false;
      }
    }
  }

  /** Identifies what the bare page picture depends on. */
  private sourceIds = new WeakMap<object, number>();
  private sourceCounter = 0;
  private pageKey(id: string): string {
    const doc = this.doc!;
    const ref = doc.page(id)!;
    const pdf = doc.sources.get(ref.src)!.pdf;
    if (!this.sourceIds.has(pdf)) this.sourceIds.set(pdf, ++this.sourceCounter);
    return `${doc.displayRotation(ref)}|${JSON.stringify(ref.crop ?? null)}|${this.sourceIds.get(pdf)}`;
  }

  private async render(t: Thumb, id: string) {
    const doc = this.doc!;
    const ref = doc.page(id)!;
    const page = await doc.sources.get(ref.src)!.pdf.getPage(ref.index + 1);
    const { width } = doc.displaySize(ref);
    const ratio = window.devicePixelRatio || 1;
    const rotation = doc.displayRotation(ref);
    const viewport = pageViewport(page, (THUMB_WIDTH / width) * ratio, rotation, ref.crop);
    const key = this.pageKey(id);

    if (!t.page || t.pageKey !== key) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
      t.page = canvas;
      t.pageKey = key;
    }

    if (t.canvas.width !== t.page.width || t.canvas.height !== t.page.height) {
      t.canvas.width = t.page.width;
      t.canvas.height = t.page.height;
    }
    const ctx = t.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(t.page, 0, 0);
    drawAnnots(ctx, viewport.transform as Transform, [...decorTexts(doc, ref), ...doc.annots(id)], doc.images);
  }
}
