// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditorDoc } from './document';
import { decorTexts } from './decor';
import { AnnotationMode, PageViewport, pageViewport, PDFPageProxy } from './pdf';
import { drawAnnot, drawAnnots, drawSelection, Transform } from './render';
import { annotBounds } from './geometry';
import type { Annot, PageRef } from './types';

const PAGE_GAP = 20;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
// Above this many device pixels per canvas we render at lower resolution
// rather than risk the GPU giving up on us.
const MAX_CANVAS_PIXELS = 16_000_000;
// Previews are drawn at this many device pixels per CSS pixel: blurry, but
// about 16× cheaper than a sharp render on a high-DPI screen.
const PREVIEW_RATIO = 0.5;
// Wait this long after the last scroll before doing sharp renders, so a
// fast scroll only pays for cheap previews.
const SETTLE_MS = 90;

function blankCanvas(cls: string) {
  const c = document.createElement('canvas');
  c.className = cls;
  c.width = c.height = 0;
  return c;
}

/** Frees a canvas's pixel memory straight away. */
function release(c: HTMLCanvasElement) {
  if (c.width || c.height) c.width = c.height = 0;
}

export class PageView {
  readonly el: HTMLDivElement;
  /** Low-resolution render, kept even when the page is far away. */
  readonly preview: HTMLCanvasElement;
  /** Sharp render; swapped for a new element each time it's redrawn. */
  base: HTMLCanvasElement;
  readonly marks: HTMLCanvasElement;
  /** Only exists while you're drawing or dragging on this page. */
  live: HTMLCanvasElement | null = null;
  /** HTML form fields go here (see forms.ts). */
  readonly forms: HTMLDivElement;
  /** Inline text editor, hover outlines, placement previews. */
  readonly overlay: HTMLDivElement;

  pdfPage: PDFPageProxy | null = null;
  /** The document pdfPage came from, to notice when it's replaced. */
  pdfDoc: unknown = null;
  /** Viewport in CSS pixels at the current zoom. */
  viewport: PageViewport | null = null;
  /** Device pixels per CSS pixel for the sharp render and the mark layers. */
  pixelRatio = 1;
  /** Identifies the zoom/rotation the sharp render was made for ('' = none). */
  renderedKey = '';
  previewKey = '';
  private renderTask: ReturnType<PDFPageProxy['render']> | null = null;
  /** Device-pixel box last painted on the live layer, so we clear only that. */
  liveDirty: [number, number, number, number] | null = null;
  /** Highlights painted into the sharp render (see Viewer.bake). */
  bakedHighlights: readonly Annot[] = [];
  /** Keep the live layer up until the next sharp render lands. */
  liveUntilRender = false;

  constructor(public ref: PageRef) {
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.dataset.pageId = ref.id;

    this.preview = blankCanvas('page-preview');
    this.base = blankCanvas('page-base');
    this.marks = blankCanvas('page-marks');
    this.forms = document.createElement('div');
    this.forms.className = 'page-forms';
    this.overlay = document.createElement('div');
    this.overlay.className = 'page-overlay';
    this.el.append(this.preview, this.base, this.marks, this.forms, this.overlay);
  }

  /** User space → mark-layer device pixels. */
  get deviceTransform(): Transform {
    const t = this.viewport!.transform;
    const r = this.pixelRatio;
    return [t[0] * r, t[1] * r, t[2] * r, t[3] * r, t[4] * r, t[5] * r];
  }

  /** Width and height the sharp layers have (or will have) in device pixels. */
  get deviceSize(): [number, number] {
    return [Math.floor(this.viewport!.width * this.pixelRatio), Math.floor(this.viewport!.height * this.pixelRatio)];
  }

  cancelRender() {
    this.renderTask?.cancel();
    this.renderTask = null;
  }

  get rendering() {
    return this.renderTask !== null;
  }

  /**
   * Renders the page into a brand-new canvas and swaps it in when done, so
   * the previous image stays up meanwhile and nothing is copied. Resolves
   * false if it was cancelled.
   */
  private async renderInto(target: HTMLCanvasElement, viewport: PageViewport, withForms: boolean, bake?: Bake): Promise<boolean> {
    this.cancelRender();
    target.width = Math.max(1, Math.floor(viewport.width));
    target.height = Math.max(1, Math.floor(viewport.height));
    const task = this.pdfPage!.render({
      canvas: target,
      canvasContext: target.getContext('2d', { alpha: false })!,
      viewport,
      annotationMode: withForms ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE,
    });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if ((err as Error)?.name === 'RenderingCancelledException') return false;
      throw err;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }
    bake?.(target.getContext('2d', { alpha: false })!, viewport.transform as Transform);
    return true;
  }

  async renderPreview(key: string, cssViewport: PageViewport, withForms: boolean, bake: Bake) {
    const vp = pageViewport(this.pdfPage!, cssViewport.scale * PREVIEW_RATIO, cssViewport.rotation, this.ref.crop);
    const canvas = blankCanvas('page-preview');
    if (!(await this.renderInto(canvas, vp, withForms, bake))) return;
    this.el.replaceChild(canvas, this.preview);
    (this as { preview: HTMLCanvasElement }).preview = canvas;
    this.previewKey = key;
  }

  async renderSharp(key: string, cssViewport: PageViewport, ratio: number, withForms: boolean, bake: Bake): Promise<boolean> {
    const vp = pageViewport(this.pdfPage!, cssViewport.scale * ratio, cssViewport.rotation, this.ref.crop);
    const canvas = blankCanvas('page-base');
    if (!(await this.renderInto(canvas, vp, withForms, bake))) {
      release(canvas);
      return false;
    }
    release(this.base);
    this.el.replaceChild(canvas, this.base);
    this.base = canvas;
    this.renderedKey = key;
    return true;
  }

  /** Drops the sharp layers of a page that's scrolled far away. */
  releaseSharp() {
    this.cancelRender();
    release(this.base);
    release(this.marks);
    this.renderedKey = '';
    this.bakedHighlights = [];
  }

  /** Reads a pixel of the rendered page, in CSS pixel coordinates. */
  sample(cssX: number, cssY: number): [number, number, number] {
    const source = this.base.width ? this.base : this.preview;
    const ratio = source.width / (this.viewport?.width || source.width || 1);
    const ctx = source.getContext('2d', { alpha: false })!;
    const x = Math.round(cssX * ratio), y = Math.round(cssY * ratio);
    const d = ctx.getImageData(Math.max(0, Math.min(source.width - 1, x)), Math.max(0, Math.min(source.height - 1, y)), 1, 1).data;
    return [d[0], d[1], d[2]];
  }
}

/** Paints extra things into a fresh page render before it's shown. */
type Bake = (ctx: CanvasRenderingContext2D, transform: Transform) => void;

export interface ViewerHooks {
  /** Ids of annotations not to paint (being edited). */
  hidden(): Set<string>;
  coverOnly(): Set<string>;
  selected(): string | null;
  /** Lets forms.ts lay out its fields after a page renders. */
  afterRender(view: PageView): void;
}

export type ReadingMode = 'continuous' | 'spread' | 'single';

export class Viewer extends EventTarget {
  doc: EditorDoc | null = null;
  scale = 1;
  /** Continuous scroll, two pages side by side, or one page at a time. */
  mode: ReadingMode = 'continuous';
  readonly views = new Map<string, PageView>();
  currentPageId: string | null = null;
  private observer: IntersectionObserver;
  /** Pages in or near the viewport. Only these keep sharp canvases. */
  private near = new Set<string>();
  private renderTimer = 0;
  private renderLoop: Promise<void> | null = null;
  private lastScroll = 0;
  /** Page tops in document order, for finding the current page quickly. */
  private offsets: number[] = [];
  private offsetsValid = false;
  /** The annotation being drawn or dragged right now, painted on its own layer. */
  private liveTarget: { pageId: string; annotId: string } | null = null;

  constructor(readonly container: HTMLElement, readonly pagesEl: HTMLElement, private hooks: ViewerHooks) {
    super();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.pageId!;
        if (e.isIntersecting) {
          this.near.add(id);
        } else {
          this.near.delete(id);
          this.views.get(id)?.releaseSharp();
        }
      }
      this.scheduleRender(0);
    }, { root: container, rootMargin: '400px 0px' });

    container.addEventListener('scroll', () => {
      this.lastScroll = performance.now();
      this.updateCurrentPage();
      this.scheduleRender(SETTLE_MS);
    }, { passive: true });
    new ResizeObserver(() => {
      this.offsetsValid = false;
      this.scheduleRender(0);
    }).observe(container);
  }

  setDoc(doc: EditorDoc | null) {
    for (const v of this.views.values()) {
      v.releaseSharp();
      this.observer.unobserve(v.el);
    }
    this.views.clear();
    this.near.clear();
    this.pagesEl.replaceChildren();
    this.liveTarget = null;
    this.doc = doc;
    this.currentPageId = null;
    this.offsetsValid = false;
    if (doc) this.syncPages();
  }

  /** Brings the DOM in line with doc.pages: order, additions, removals, rotation. */
  syncPages() {
    const doc = this.doc;
    if (!doc) return;
    const keep = new Set(doc.pages.map((p) => p.id));
    for (const [id, view] of this.views) {
      if (keep.has(id)) continue;
      view.releaseSharp();
      this.observer.unobserve(view.el);
      view.el.remove();
      this.views.delete(id);
      this.near.delete(id);
    }

    let previous: HTMLElement | null = null;
    for (const ref of doc.pages) {
      let view = this.views.get(ref.id);
      if (!view) {
        view = new PageView(ref);
        this.views.set(ref.id, view);
        this.observer.observe(view.el);
      } else if (view.ref.rotation !== ref.rotation || view.ref.crop !== ref.crop) {
        view.renderedKey = '';
        view.previewKey = '';
        view.viewport = null;
      }
      view.ref = ref;
      const expectedPosition: ChildNode | null = previous ? previous.nextSibling : this.pagesEl.firstChild;
      if (expectedPosition !== view.el) this.pagesEl.insertBefore(view.el, expectedPosition);
      previous = view.el;
    }
    this.layout();
    this.updateCurrentPage();
    if (this.mode === 'single') this.showOnly(this.currentPageId ?? doc.pages[0]?.id ?? null);
  }

  // --- reading modes -------------------------------------------------------------

  setMode(mode: ReadingMode) {
    if (mode === this.mode) return;
    const keep = this.currentPageId;
    this.mode = mode;
    this.pagesEl.classList.toggle('spread', mode === 'spread');
    this.pagesEl.classList.toggle('single', mode === 'single');
    if (mode !== 'single') for (const v of this.views.values()) v.el.hidden = false;
    this.offsetsValid = false;
    if (mode === 'single') this.showOnly(keep ?? this.doc?.pages[0]?.id ?? null);
    if (keep) this.scrollToPage(keep, false);
    this.updateCurrentPage();
    this.scheduleRender(0);
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  /** In single-page mode: hides every page but this one. */
  private showOnly(id: string | null) {
    if (!id || !this.doc) return;
    for (const [pageId, v] of this.views) v.el.hidden = pageId !== id;
    if (this.currentPageId !== id) {
      this.currentPageId = id;
      this.dispatchEvent(new CustomEvent('pagechange'));
    }
    this.offsetsValid = false;
    this.scheduleRender(0);
  }

  /** Sizes every page placeholder for the current zoom. */
  layout() {
    const doc = this.doc;
    if (!doc) return;
    for (const ref of doc.pages) {
      const view = this.views.get(ref.id)!;
      const { width, height } = doc.displaySize(ref);
      view.el.style.width = `${Math.floor(width * this.scale)}px`;
      view.el.style.height = `${Math.floor(height * this.scale)}px`;
    }
    this.pagesEl.style.setProperty('--page-gap', `${PAGE_GAP}px`);
    this.offsetsValid = false;
    this.scheduleRender(0);
  }

  // --- zoom ------------------------------------------------------------------

  setScale(next: number, anchor?: { clientX: number; clientY: number }) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (Math.abs(scale - this.scale) < 0.001 || !this.doc) return;

    const c = this.container;
    const rect = c.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - rect.left : c.clientWidth / 2;
    const ay = anchor ? anchor.clientY - rect.top : 0;
    // keep the point under the anchor fixed while everything grows around it
    const contentX = c.scrollLeft + ax, contentY = c.scrollTop + ay;
    const ratio = scale / this.scale;
    const topPad = this.pagesEl.offsetTop;

    this.scale = scale;
    this.layout();
    c.scrollLeft = contentX * ratio - ax;
    c.scrollTop = (contentY - topPad) * ratio + topPad - ay;
    this.updateCurrentPage();
    this.dispatchEvent(new CustomEvent('zoom'));
  }

  private widestPage() {
    const doc = this.doc!;
    return doc.pages.reduce(
      (acc, p) => {
        const s = doc.displaySize(p);
        return { width: Math.max(acc.width, s.width), height: Math.max(acc.height, s.height) };
      },
      { width: 1, height: 1 },
    );
  }

  fitWidth() {
    if (!this.doc) return;
    const available = this.container.clientWidth - 64;
    const across = this.mode === 'spread' ? 2 : 1;
    this.setScale((available - (across - 1) * PAGE_GAP) / (this.widestPage().width * across));
  }

  fitPage() {
    if (!this.doc) return;
    const page = this.currentPageId ? this.doc.page(this.currentPageId) : this.doc.pages[0];
    const size = page ? this.doc.displaySize(page) : this.widestPage();
    const sx = (this.container.clientWidth - 64) / size.width;
    const sy = (this.container.clientHeight - PAGE_GAP * 2) / size.height;
    this.setScale(Math.min(sx, sy));
    if (page) this.scrollToPage(page.id, false);
  }

  // --- navigation ------------------------------------------------------------

  scrollToPage(id: string, smooth = true) {
    const view = this.views.get(id);
    if (!view) return;
    if (this.mode === 'single') {
      this.showOnly(id);
      this.container.scrollTo({ top: 0 });
      return;
    }
    this.container.scrollTo({ top: view.el.offsetTop - PAGE_GAP / 2, behavior: smooth ? 'smooth' : 'auto' });
  }

  updateCurrentPage() {
    const doc = this.doc;
    if (!doc || !doc.pages.length) return;
    if (this.mode === 'single') return; // the page shown is the current one
    if (!this.offsetsValid || this.offsets.length !== doc.pages.length) {
      this.offsets = doc.pages.map((ref) => this.views.get(ref.id)!.el.offsetTop);
      this.offsetsValid = true;
    }
    // binary search for the last page starting above the probe line
    const probe = this.container.scrollTop + this.container.clientHeight * 0.35;
    let lo = 0, hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= probe) lo = mid;
      else hi = mid - 1;
    }
    const current = doc.pages[lo].id;
    if (current !== this.currentPageId) {
      this.currentPageId = current;
      this.dispatchEvent(new CustomEvent('pagechange'));
    }
  }

  // --- rendering ---------------------------------------------------------------

  invalidate() {
    for (const v of this.views.values()) {
      v.renderedKey = '';
      v.previewKey = '';
    }
    this.scheduleRender(0);
  }

  private scheduleRender(delay: number) {
    clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.kick(), delay);
  }

  private kick() {
    if (this.renderLoop) return; // the running loop re-checks on every page
    this.renderLoop = this.renderNear().finally(() => {
      this.renderLoop = null;
    });
  }

  private ensurePage(view: PageView): PageViewport | Promise<PageViewport> {
    const doc = this.doc!;
    const rotation = doc.displayRotation(view.ref);
    const pdf = doc.sources.get(view.ref.src)!.pdf;
    // a source swapped out (OCR) means the page object is stale
    if (view.pdfPage && view.pdfDoc === pdf) {
      view.viewport = pageViewport(view.pdfPage, this.scale, rotation, view.ref.crop);
      return view.viewport;
    }
    return pdf.getPage(view.ref.index + 1).then((page) => {
      view.pdfPage = page;
      view.pdfDoc = pdf;
      view.viewport = pageViewport(page, this.scale, rotation, view.ref.crop);
      return view.viewport;
    });
  }

  /** Pages actually on screen right now, nearest the middle first. */
  private onScreen(): PageView[] {
    const top = this.container.scrollTop, bottom = top + this.container.clientHeight;
    const middle = (top + bottom) / 2;
    return [...this.near]
      .map((id) => this.views.get(id))
      .filter((v): v is PageView => !!v)
      .map((v) => ({ v, top: v.el.offsetTop, bottom: v.el.offsetTop + v.el.offsetHeight }))
      .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - middle) - Math.abs((b.top + b.bottom) / 2 - middle))
      .map((x) => x.v);
  }

  private sharpRatio(viewport: PageViewport) {
    let ratio = window.devicePixelRatio || 1;
    const pixels = viewport.width * viewport.height * ratio * ratio;
    if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    return ratio;
  }

  /**
   * Renders in two passes: a quick blurry preview of every nearby page first,
   * then sharp renders, nearest first, once scrolling has paused.
   */
  private async renderNear() {
    const doc = this.doc;
    if (!doc) return;
    try {
      for (;;) {
        if (this.doc !== doc) return;
        const pages = this.onScreen();

        // pass 1: previews, so nothing on screen is ever blank for long
        const needPreview = pages.find((v) => !v.renderedKey && v.previewKey !== this.previewKey(v));
        if (needPreview) {
          const vp = await this.ensurePage(needPreview);
          needPreview.pixelRatio = this.sharpRatio(vp);
          await needPreview.renderPreview(this.previewKey(needPreview), vp, needPreview.ref.src === doc.mainSource, this.bake(needPreview).fn);
          if (this.doc !== doc) return;
          if (this.near.has(needPreview.ref.id) && needPreview.previewKey) {
            this.drawMarks(needPreview);
            this.hooks.afterRender(needPreview);
          }
          continue;
        }

        // pass 2: sharp renders, but not mid-scroll
        const sinceScroll = performance.now() - this.lastScroll;
        if (sinceScroll < SETTLE_MS) {
          this.scheduleRender(SETTLE_MS - sinceScroll + 5);
          return;
        }
        let rendered = false;
        for (const view of pages) {
          const vp = await this.ensurePage(view);
          const ratio = this.sharpRatio(vp);
          const key = `${this.scale.toFixed(4)}:${vp.rotation}:${ratio.toFixed(3)}`;
          if (view.renderedKey === key) continue;
          const ratioChanged = view.pixelRatio !== ratio;
          view.pixelRatio = ratio;
          if (ratioChanged) this.drawMarks(view);
          const bake = this.bake(view);
          const done = await view.renderSharp(key, vp, ratio, view.ref.src === doc.mainSource, bake.fn);
          if (!done || this.doc !== doc) return;
          view.bakedHighlights = bake.list;
          if (view.liveUntilRender) {
            view.liveUntilRender = false;
            this.dropLive(view);
          }
          if (this.near.has(view.ref.id)) {
            this.drawMarks(view);
            this.hooks.afterRender(view);
          } else {
            view.releaseSharp();
          }
          rendered = true;
          break; // re-check order: the user may have scrolled meanwhile
        }
        if (!rendered) return;
      }
    } catch (err) {
      console.error('page render failed', err);
    }
  }

  private previewKey(view: PageView) {
    return `${this.scale.toFixed(4)}:${this.doc!.displayRotation(view.ref)}`;
  }

  // --- annotation layers ----------------------------------------------------------

  /** Sizes a mark layer to match the sharp render, or frees it if unused. */
  private fit(c: HTMLCanvasElement, view: PageView, used: boolean): CanvasRenderingContext2D | null {
    if (!used) {
      release(c);
      return null;
    }
    const [w, h] = view.deviceSize;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  /**
   * Highlights are painted straight into the page render with a multiply
   * blend, the way a highlighter marks paper. A separate blended layer looks
   * the same but makes the browser re-blend the page on every frame, which is
   * what made scrolling and typing slow.
   */
  private bake(view: PageView): { list: readonly Annot[]; fn: Bake } {
    const doc = this.doc!;
    const live = this.liveTarget?.pageId === view.ref.id ? this.liveTarget.annotId : null;
    const list = doc.annots(view.ref.id).filter((a) => a.type === 'highlight' && a.id !== live && !this.hooks.hidden().has(a.id));
    return {
      list,
      fn: list.length ? (ctx, transform) => drawAnnots(ctx, transform, [...list], doc.images) : () => {},
    };
  }

  private highlightsStale(view: PageView): boolean {
    const want = this.bake(view).list;
    const have = view.bakedHighlights;
    return want.length !== have.length || want.some((a, i) => a !== have[i]);
  }

  /** Repaints the static annotations for one page. */
  drawMarks(view: PageView) {
    const doc = this.doc;
    if (!doc || !view.viewport || !(view.renderedKey || view.previewKey)) return;

    // highlights changed: the page needs re-rendering with the new ones in it
    if (view.renderedKey && this.highlightsStale(view)) {
      view.renderedKey = '';
      this.scheduleRender(0);
    }

    const live = this.liveTarget?.pageId === view.ref.id ? this.liveTarget.annotId : null;
    // watermark, page numbers, header and footer sit under everything else
    const annots = [...decorTexts(doc, view.ref), ...doc.annots(view.ref.id).filter((a) => a.type !== 'highlight' && a.id !== live)];
    const selected = live ? null : this.hooks.selected();
    const selectedAnnot = selected ? doc.annots(view.ref.id).find((a) => a.id === selected) : null;

    const marks = this.fit(view.marks, view, annots.length > 0 || !!selectedAnnot);
    if (!marks) return;
    const transform = view.deviceTransform;
    drawAnnots(marks, transform, annots, doc.images, {
      skip: this.hooks.hidden(),
      coverOnly: this.hooks.coverOnly(),
    });
    if (selectedAnnot) drawSelection(marks, transform, selectedAnnot, view.pixelRatio);
  }

  /**
   * Starts painting one annotation on its own layer while it's being drawn
   * or dragged. Each frame then repaints just that annotation, instead of
   * every mark on the page.
   */
  beginLive(pageId: string, annotId: string) {
    this.endLive();
    this.liveTarget = { pageId, annotId };
    const view = this.views.get(pageId);
    if (!view?.viewport) return;
    this.drawMarks(view); // static layer without the live one
    this.drawLive(view);
  }

  endLive() {
    const target = this.liveTarget;
    if (!target) return;
    this.liveTarget = null;
    const view = this.views.get(target.pageId);
    if (!view) return;
    this.drawMarks(view);
    // a highlight only appears on the page after a re-render, so leave the
    // live copy up until then to avoid a flicker
    if (view.renderedKey === '' && view.live && this.doc?.annots(view.ref.id).some((a) => a.id === target.annotId && a.type === 'highlight')) {
      view.liveUntilRender = true;
      return;
    }
    this.dropLive(view);
  }

  private dropLive(view: PageView) {
    view.live?.remove();
    if (view.live) release(view.live);
    view.live = null;
    view.liveDirty = null;
  }

  private drawLive(view: PageView) {
    const doc = this.doc;
    const target = this.liveTarget;
    if (!doc || !target || !view.viewport) return;
    const annot = doc.annots(view.ref.id).find((a) => a.id === target.annotId);

    if (!view.live) {
      view.live = blankCanvas('page-live');
      view.el.insertBefore(view.live, view.forms);
      const [w, h] = view.deviceSize;
      view.live.width = w;
      view.live.height = h;
    }
    view.live.classList.toggle('blend', annot?.type === 'highlight');
    const ctx = view.live.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (view.liveDirty) ctx.clearRect(...view.liveDirty);
    if (!annot) {
      view.liveDirty = null;
      return;
    }

    const transform = view.deviceTransform;
    ctx.save();
    ctx.setTransform(...transform);
    drawAnnot(ctx, annot, doc.images);
    ctx.restore();
    if (this.hooks.selected() === annot.id) drawSelection(ctx, transform, annot, view.pixelRatio);
    view.liveDirty = this.deviceBox(view, annot);
  }

  /** The device-pixel rectangle an annotation (and its handles) covers. */
  private deviceBox(view: PageView, annot: Annot): [number, number, number, number] {
    const b = annotBounds(annot);
    const t = view.deviceTransform;
    const xs: number[] = [], ys: number[] = [];
    for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
      xs.push(t[0] * x + t[2] * y + t[4]);
      ys.push(t[1] * x + t[3] * y + t[5]);
    }
    const pad = 16 * view.pixelRatio;
    const x0 = Math.floor(Math.min(...xs) - pad), y0 = Math.floor(Math.min(...ys) - pad);
    return [x0, y0, Math.ceil(Math.max(...xs) + pad) - x0, Math.ceil(Math.max(...ys) + pad) - y0];
  }

  redraw(pageIds?: string[]) {
    const ids = pageIds ?? [...this.views.keys()];
    for (const id of ids) {
      const view = this.views.get(id);
      if (!view?.viewport || !(view.renderedKey || view.previewKey)) continue;
      if (this.liveTarget?.pageId === id) this.drawLive(view);
      else this.drawMarks(view);
    }
  }

  // --- coordinates -------------------------------------------------------------

  viewAt(target: EventTarget | null): PageView | null {
    const el = (target as HTMLElement | null)?.closest?.('.page') as HTMLElement | null;
    return el ? this.views.get(el.dataset.pageId!) ?? null : null;
  }

  /** Client (mouse) coordinates → CSS pixels inside the page. */
  local(view: PageView, clientX: number, clientY: number): [number, number] {
    const r = view.el.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  }

  /** Client coordinates → PDF user space on that page. */
  toUser(view: PageView, clientX: number, clientY: number): [number, number] {
    const [x, y] = this.local(view, clientX, clientY);
    const [ux, uy] = view.viewport!.convertToPdfPoint(x, y);
    return [ux, uy];
  }

  /** PDF user space → CSS pixels inside the page. */
  toLocal(view: PageView, ux: number, uy: number): [number, number] {
    const [x, y] = view.viewport!.convertToViewportPoint(ux, uy);
    return [x, y];
  }
}
