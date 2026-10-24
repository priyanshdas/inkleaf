// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../shared/i18n';
import { newId } from './geometry';
import { loadPdf, PageInfo, PDFDocumentProxy, readPageInfo } from './pdf';
import type { Annot, Box, Decor, FormValue, NoteAnnot, OutlineItem, PageRef, Snapshot } from './types';

export interface Source {
  id: string;
  name: string;
  /** Unencrypted bytes. Everything we save is built from these. */
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  pages: PageInfo[];
}

export interface Asset {
  id: string;
  dataUrl: string;
  image: HTMLImageElement;
  width: number;
  height: number;
}

export type ChangeKind = 'pages' | 'annots' | 'forms' | 'decor' | 'outline' | 'all';

export interface ChangeDetail {
  kind: ChangeKind;
  /** Pages whose annotations changed, when kind is 'annots'. */
  pageIds?: string[];
}

const MAX_HISTORY = 200;

export const NO_DECOR: Decor = { watermark: null, numbers: null, header: null, footer: null };

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/**
 * One open document. The PDF files themselves never change while you edit;
 * everything you do is recorded here and only baked into a new PDF on save.
 */
export class EditorDoc extends EventTarget {
  readonly sources = new Map<string, Source>();
  readonly assets = new Map<string, Asset>();
  readonly images = new Map<string, HTMLImageElement>();

  name = 'Untitled.pdf';
  path: string | null = null;
  mainSource = '';
  /** Set when the original file was password-protected or locked. */
  wasProtected = false;

  private state: Snapshot = { pages: [], annots: {}, forms: {}, decor: NO_DECOR, outline: null };
  /** Changes outside the undo history (OCR adds a text layer to a source). */
  private sourceEdits = 0;
  private sourceEditsSaved = 0;
  private history: Snapshot[] = [];
  private cursor = -1;
  private savedAt!: Snapshot;

  static async open(bytes: Uint8Array, name: string, path: string | null): Promise<EditorDoc> {
    const doc = new EditorDoc();
    doc.name = name;
    doc.path = path;
    const source = await doc.addSource(bytes, name);
    doc.mainSource = source.id;
    doc.state.pages = source.pages.map((_, index) => ({ id: newId('p'), src: source.id, index, rotation: 0 }));
    doc.resetHistory();
    return doc;
  }

  /**
   * Picks up the sticky notes already in the file, so they can be read,
   * edited and deleted like any made here. Called once after opening; it
   * isn't an edit, so it doesn't make the document unsaved or undoable.
   */
  async adoptExistingNotes() {
    const notes = await this.notesIn(this.mainSource);
    if (!notes.size || this.history.length !== 1) return;
    const annots = { ...this.state.annots };
    for (const page of this.state.pages) {
      const found = page.src === this.mainSource ? notes.get(page.index) : undefined;
      if (found?.length) annots[page.id] = [...(annots[page.id] ?? []), ...found];
    }
    this.state = { ...this.state, annots };
    this.resetHistory();
    this.emit({ kind: 'annots', pageIds: this.state.pages.map((p) => p.id) });
  }

  /** Sticky-note comments in one source file, by zero-based page index. */
  async notesIn(srcId: string): Promise<Map<number, NoteAnnot[]>> {
    const source = this.sources.get(srcId);
    const found = new Map<number, NoteAnnot[]>();
    if (!source) return found;
    await Promise.all(source.pages.map(async (_, index) => {
      try {
        const page = await source.pdf.getPage(index + 1);
        const annots = (await page.getAnnotations({ intent: 'display' })) as {
          subtype?: string; rect?: number[]; contentsObj?: { str?: string }; titleObj?: { str?: string };
          color?: Uint8ClampedArray | null; modificationDate?: string | null; creationDate?: string | null;
        }[];
        const notes = annots.filter((a) => a.subtype === 'Text' && a.rect).map((a): NoteAnnot => {
          const [x0, y0, x1, y1] = a.rect!;
          const c = a.color && a.color.length >= 3 ? a.color : [255, 209, 102];
          return {
            id: newId('note'),
            type: 'note',
            // our icon is a fixed 20 pt square, anchored at the note's top-left
            x: Math.min(x0, x1), y: Math.max(y0, y1) - 20, w: 20, h: 20,
            text: a.contentsObj?.str ?? '',
            author: a.titleObj?.str ?? '',
            color: `#${[c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
            created: parsePdfDate(a.creationDate ?? a.modificationDate) ?? Date.now(),
          };
        });
        if (notes.length) found.set(index, notes);
      } catch {
        // a page whose annotations can't be read just has no notes for us
      }
    }));
    return found;
  }

  /**
   * Swaps in new bytes for a source (OCR adds an invisible text layer). Page
   * ids stay the same, so marks and history are untouched.
   */
  async replaceSource(srcId: string, bytes: Uint8Array) {
    const old = this.sources.get(srcId);
    if (!old) return;
    const pdf = await loadPdf(bytes);
    const pages = await readPageInfo(pdf);
    this.sources.set(srcId, { ...old, bytes, pdf, pages });
    old.pdf.loadingTask.destroy();
    this.sourceEdits++;
    this.emit({ kind: 'all', pageIds: this.state.pages.map((p) => p.id) });
    this.dispatchEvent(new CustomEvent('history'));
  }

  async addSource(bytes: Uint8Array, name: string): Promise<Source> {
    const pdf = await loadPdf(bytes);
    const source: Source = { id: newId('s'), name, bytes, pdf, pages: await readPageInfo(pdf) };
    this.sources.set(source.id, source);
    return source;
  }

  destroy() {
    for (const s of this.sources.values()) s.pdf.loadingTask.destroy();
    this.sources.clear();
  }

  // --- reading -------------------------------------------------------------

  get pages(): readonly PageRef[] {
    return this.state.pages;
  }

  get forms(): Readonly<Record<string, FormValue>> {
    return this.state.forms;
  }

  get decor(): Decor {
    return this.state.decor;
  }

  get outline(): readonly OutlineItem[] | null {
    return this.state.outline;
  }

  page(id: string): PageRef | undefined {
    return this.state.pages.find((p) => p.id === id);
  }

  pageIndex(id: string): number {
    return this.state.pages.findIndex((p) => p.id === id);
  }

  annots(pageId: string): readonly Annot[] {
    return this.state.annots[pageId] ?? [];
  }

  info(page: PageRef): PageInfo {
    return this.sources.get(page.src)!.pages[page.index];
  }

  /** Total clockwise rotation the page is displayed with. */
  displayRotation(page: PageRef): number {
    return (((this.info(page).rotate + page.rotation) % 360) + 360) % 360;
  }

  /** The visible part of the page in user space: its crop, or the whole page. */
  viewBox(page: PageRef): Box {
    if (page.crop) return page.crop;
    const [x0, y0, x1, y1] = this.info(page).view;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Page size as displayed (after rotation and crop), in points. */
  displaySize(page: PageRef): { width: number; height: number } {
    const box = this.viewBox(page);
    const sideways = this.displayRotation(page) % 180 !== 0;
    return sideways ? { width: box.h, height: box.w } : { width: box.w, height: box.h };
  }

  findAnnot(id: string): { pageId: string; annot: Annot } | null {
    for (const [pageId, list] of Object.entries(this.state.annots)) {
      const annot = list.find((a) => a.id === id);
      if (annot) return { pageId, annot };
    }
    return null;
  }

  // --- annotation edits ------------------------------------------------------
  // These change the live state and redraw, but don't create an undo step on
  // their own. Call commit() when the gesture is finished.

  addAnnot(pageId: string, annot: Annot) {
    this.state.annots[pageId] = [...this.annots(pageId), annot];
    this.emit({ kind: 'annots', pageIds: [pageId] });
  }

  /** `quiet` skips the change event, for edits nothing on screen depends on. */
  updateAnnot(pageId: string, annot: Annot, options: { quiet?: boolean } = {}) {
    const list = this.annots(pageId);
    const current = list.find((a) => a.id === annot.id);
    // an update that changes nothing shouldn't count as an edit
    if (current && shallowEqual(current, annot)) return;
    this.state.annots[pageId] = list.map((a) => (a.id === annot.id ? annot : a));
    if (!options.quiet) this.emit({ kind: 'annots', pageIds: [pageId] });
  }

  removeAnnot(pageId: string, id: string) {
    this.state.annots[pageId] = this.annots(pageId).filter((a) => a.id !== id);
    this.emit({ kind: 'annots', pageIds: [pageId] });
  }

  /** Moves an annotation to the top of the stack on its page. */
  bringToFront(pageId: string, id: string) {
    const list = this.annots(pageId);
    const target = list.find((a) => a.id === id);
    if (!target) return;
    this.state.annots[pageId] = [...list.filter((a) => a.id !== id), target];
    this.emit({ kind: 'annots', pageIds: [pageId] });
  }

  setForm(name: string, value: FormValue) {
    this.state.forms = { ...this.state.forms, [name]: value };
    this.emit({ kind: 'forms' });
  }

  // --- whole-document settings (each is its own undo step) ----------------------

  setDecor(decor: Decor) {
    this.state.decor = decor;
    this.emit({ kind: 'decor' });
    this.commit();
  }

  setOutline(outline: OutlineItem[] | null) {
    this.state.outline = outline;
    this.emit({ kind: 'outline' });
    this.commit();
  }

  /** Crops pages to `box` (clipped to each page), or uncrops them with null. */
  setCrop(ids: string[], box: Box | null) {
    const targets = new Set(ids);
    this.state.pages = this.state.pages.map((p) => {
      if (!targets.has(p.id)) return p;
      if (!box) {
        const { crop: _, ...rest } = p;
        return rest;
      }
      const [x0, y0, x1, y1] = this.info(p).view;
      const cx0 = Math.max(x0, box.x), cy0 = Math.max(y0, box.y);
      const cx1 = Math.min(x1, box.x + box.w), cy1 = Math.min(y1, box.y + box.h);
      if (cx1 - cx0 < 10 || cy1 - cy0 < 10) return p; // the box misses this page
      return { ...p, crop: { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 } };
    });
    this.emit({ kind: 'pages' });
    this.commit();
  }

  // --- page edits (each is its own undo step) ---------------------------------

  /** Adds pages; `notes` are comments already in those pages, by source index. */
  insertPages(at: number, pages: Omit<PageRef, 'id'>[], notes?: Map<number, NoteAnnot[]>): PageRef[] {
    const created = pages.map((p) => ({ ...p, id: newId('p') }));
    const list = [...this.state.pages];
    list.splice(at, 0, ...created);
    this.state.pages = list;
    if (notes?.size) {
      const annots = { ...this.state.annots };
      for (const page of created) {
        const found = notes.get(page.index);
        if (found?.length) annots[page.id] = found.map((n) => ({ ...n, id: newId('note') }));
      }
      this.state.annots = annots;
    }
    this.emit({ kind: 'pages' });
    this.emit({ kind: 'annots', pageIds: created.map((p) => p.id) });
    this.commit();
    return created;
  }

  deletePages(ids: string[]) {
    const remove = new Set(ids);
    if (remove.size >= this.state.pages.length) throw new Error(t('A PDF needs at least one page.'));
    this.state.pages = this.state.pages.filter((p) => !remove.has(p.id));
    for (const id of remove) delete this.state.annots[id];
    this.emit({ kind: 'pages' });
    this.commit();
  }

  /** Moves pages (keeping their relative order) so they start at `to`. */
  movePages(ids: string[], to: number) {
    const moving = new Set(ids);
    const picked = this.state.pages.filter((p) => moving.has(p.id));
    const rest = this.state.pages.filter((p) => !moving.has(p.id));
    // `to` is an index into the list *with* the pages still in it
    const before = this.state.pages.slice(0, to).filter((p) => !moving.has(p.id)).length;
    rest.splice(before, 0, ...picked);
    if (rest.every((p, i) => p.id === this.state.pages[i].id)) return;
    this.state.pages = rest;
    this.emit({ kind: 'pages' });
    this.commit();
  }

  rotatePages(ids: string[], delta: number) {
    const targets = new Set(ids);
    this.state.pages = this.state.pages.map((p) =>
      targets.has(p.id) ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 } : p,
    );
    this.emit({ kind: 'pages' });
    this.commit();
  }

  // --- assets -----------------------------------------------------------------

  async addAsset(dataUrl: string): Promise<Asset> {
    const existing = [...this.assets.values()].find((a) => a.dataUrl === dataUrl);
    if (existing) return existing;
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const asset: Asset = { id: newId('img'), dataUrl, image, width: image.naturalWidth, height: image.naturalHeight };
    this.assets.set(asset.id, asset);
    this.images.set(asset.id, image);
    return asset;
  }

  // --- history ------------------------------------------------------------------
  // Edits never change objects in place: every change makes a new page list,
  // a new annotation array for the page touched, a new form record. So a
  // snapshot only needs to remember *which* objects were current, and
  // unchanged pages share their data with every other snapshot. That keeps
  // undo instant and cheap however big the document gets.

  private snapshot(): Snapshot {
    return { ...this.state, annots: { ...this.state.annots } };
  }

  private static same(a: Snapshot, b: Snapshot): boolean {
    if (a.pages !== b.pages || a.forms !== b.forms || a.decor !== b.decor || a.outline !== b.outline) return false;
    const ka = Object.keys(a.annots), kb = Object.keys(b.annots);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a.annots[k] === b.annots[k]);
  }

  private resetHistory() {
    const now = this.snapshot();
    this.history = [now];
    this.cursor = 0;
    this.savedAt = now;
  }

  /** Records the current state as an undo step if anything changed. */
  commit(): boolean {
    if (EditorDoc.same(this.state, this.history[this.cursor])) return false;
    this.history = this.history.slice(0, this.cursor + 1);
    this.history.push(this.snapshot());
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.cursor = this.history.length - 1;
    this.dispatchEvent(new CustomEvent('history'));
    return true;
  }

  /** Throws away uncommitted changes (e.g. a cancelled drag). */
  revert() {
    this.restore(this.history[this.cursor]);
  }

  get canUndo() {
    return this.cursor > 0;
  }

  get canRedo() {
    return this.cursor < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo) return;
    this.cursor--;
    this.restore(this.history[this.cursor]);
  }

  redo() {
    if (!this.canRedo) return;
    this.cursor++;
    this.restore(this.history[this.cursor]);
  }

  private restore(snap: Snapshot) {
    const before = this.state;
    this.state = { ...snap, annots: { ...snap.annots } };
    if (before.pages !== this.state.pages) {
      this.emit({ kind: 'all', pageIds: this.state.pages.map((p) => p.id) });
    } else {
      // only repaint the pages whose marks actually differ
      const pageIds = this.state.pages.map((p) => p.id).filter((id) => before.annots[id] !== this.state.annots[id]);
      if (pageIds.length) this.emit({ kind: 'annots', pageIds });
    }
    if (before.forms !== this.state.forms) this.emit({ kind: 'forms' });
    if (before.decor !== this.state.decor) this.emit({ kind: 'decor' });
    if (before.outline !== this.state.outline) this.emit({ kind: 'outline' });
    this.dispatchEvent(new CustomEvent('history'));
  }

  get dirty(): boolean {
    return !EditorDoc.same(this.history[this.cursor], this.savedAt) || this.sourceEdits !== this.sourceEditsSaved;
  }

  /** A document made in Inkleaf (converted, say) that exists nowhere on disk yet. */
  markUnsaved() {
    this.sourceEdits++;
    this.dispatchEvent(new CustomEvent('history'));
  }

  /**
   * Identifies the state a save is being made from. Saving takes a moment,
   * and edits made meanwhile mustn't be marked as saved.
   */
  version(): { snapshot: Snapshot; sourceEdits: number } {
    return { snapshot: this.history[this.cursor], sourceEdits: this.sourceEdits };
  }

  markSaved(name: string, path: string | null, at = this.version()) {
    this.name = name;
    this.path = path;
    this.sourceEditsSaved = at.sourceEdits;
    this.savedAt = at.snapshot;
    this.dispatchEvent(new CustomEvent('history'));
  }

  private emit(detail: ChangeDetail) {
    this.dispatchEvent(new CustomEvent<ChangeDetail>('change', { detail }));
  }
}

/** "D:20240131120000+05'30'" → milliseconds, or null. */
export function parsePdfDate(text: string | null | undefined): number | null {
  const m = text?.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const [, y, mo = '01', d = '01', hh = '00', mi = '00', ss = '00', sign, oh = '00', om = '00'] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  if (sign === '+' || sign === '-') ms -= (sign === '+' ? 1 : -1) * (+oh * 60 + +om) * 60000;
  return Number.isFinite(ms) ? ms : null;
}
