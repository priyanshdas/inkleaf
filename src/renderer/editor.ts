// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditorDoc } from './document';
import { annotBounds, dragHandle, handlesFor, hitTest, moveAnnot, newId, normBox, Point, simplifyStroke } from './geometry';
import { DEFAULT_STYLES, loadStyles, saveStyles, ToolStyles } from './styles';
import { TextEditor } from './text-editor';
import { originalFamily, replacementFor, runAt, runBox, textRuns, within } from './text-finder';
import { lineWidth } from './fonts';
import type { Annot, Box, FieldAnnot, FieldKind, ImageAnnot, NoteAnnot, StampAnnot, TextAnnot, Tool } from './types';
import { isModalOpen } from './ui';
import type { PageView, Viewer } from './viewer';

type Drag =
  | { kind: 'pan'; x: number; y: number; left: number; top: number }
  | { kind: 'move'; view: PageView; original: Annot; start: Point; moved: boolean; editOnClick?: boolean }
  | { kind: 'handle'; view: PageView; original: Annot; index: number }
  | { kind: 'ink'; view: PageView; id: string; points: Point[] }
  | { kind: 'box'; view: PageView; id: string; start: Point }
  | { kind: 'line'; view: PageView; id: string; start: Point }
  | { kind: 'erase'; view: PageView; erased: number }
  | { kind: 'crop'; view: PageView; start: Point; el: HTMLDivElement };

/** Who new comments are from; set in the comments panel. */
export function commentAuthor(): string {
  try {
    return localStorage.getItem('inkleaf.author') ?? '';
  } catch {
    return '';
  }
}

/** Default size of a new form field of each kind, in points. */
const FIELD_SIZES: Record<FieldKind, [number, number]> = {
  text: [170, 22], multiline: [220, 64], checkbox: [14, 14], dropdown: [150, 22],
};
const FIELD_NAMES: Record<FieldKind, string> = {
  text: 'Text', multiline: 'Comments', checkbox: 'Check', dropdown: 'Choice',
};

export interface Placement {
  assetId: string;
  /** Default width in points when dropped. */
  width: number;
  /** Tool to return to afterwards. */
  then: Tool;
}

const BOX_TOOLS = new Set<Tool>(['highlight', 'rect', 'ellipse', 'whiteout', 'redact', 'field']);

export interface Selection {
  pageId: string;
  id: string;
}

export class Editor extends EventTarget {
  tool: Tool = 'select';
  selection: Selection | null = null;
  styles: ToolStyles = loadStyles();
  placement: Placement | null = null;
  readonly text: TextEditor;
  /**
   * Asked before switching to a tool. Returning false blocks the switch and
   * fires a 'locked' event naming the tool, so the app can explain why.
   */
  canUseTool: (tool: Tool) => boolean = () => true;

  private drag: Drag | null = null;
  private spaceDown = false;
  private toolBeforeSpace: Tool | null = null;
  private clipboard: { annot: Annot; pasteCount: number } | null = null;
  private hoverOutline: HTMLDivElement | null = null;
  private ghost: HTMLImageElement | null = null;

  constructor(private viewer: Viewer, private getDoc: () => EditorDoc | null) {
    super();
    this.text = new TextEditor(viewer, getDoc);
    // After Esc the box stays selected, so it can be dragged or restyled
    // straight away without hunting for it again.
    this.text.onFinished = ({ pageId, id, kept, byKey }) => {
      if (kept && byKey) this.select({ pageId, id });
      this.dispatchEvent(new CustomEvent('selectionchange'));
    };
    this.text.onStarted = () => this.dispatchEvent(new CustomEvent('selectionchange'));
    this.text.onStyleKey = (name) => {
      const a = this.activeAnnot()?.annot;
      if (a && (a.type === 'text' || a.type === 'replace')) this.applyStyle('text', { [name]: !a[name] });
    };
    this.attach();
  }

  private get doc() {
    return this.getDoc();
  }

  /** A drag (drawing, moving, resizing) is under way. */
  get gesturing(): boolean {
    return this.drag !== null;
  }

  // --- hooks used by the viewer ---------------------------------------------

  hidden(): Set<string> {
    const ids = new Set<string>();
    const doc = this.doc;
    if (this.text.active && doc) {
      const found = doc.findAnnot(this.text.editingId);
      if (found?.annot.type === 'text') ids.add(found.annot.id);
    }
    return ids;
  }

  coverOnly(): Set<string> {
    const doc = this.doc;
    if (!this.text.active || !doc) return new Set();
    const found = doc.findAnnot(this.text.editingId);
    return found?.annot.type === 'replace' ? new Set([found.annot.id]) : new Set();
  }

  selectedId(): string | null {
    return this.text.active ? null : this.selection?.id ?? null;
  }

  // --- tool & selection --------------------------------------------------------

  setTool(tool: Tool) {
    if (!this.canUseTool(tool)) {
      this.dispatchEvent(new CustomEvent<Tool>('locked', { detail: tool }));
      return;
    }
    if (this.text.active) this.text.finish();
    if (tool !== 'image' && tool !== 'sign') this.cancelPlacement();
    if (tool !== 'select') this.select(null);
    this.tool = tool;
    this.viewer.container.dataset.tool = tool;
    this.clearHover();
    this.dispatchEvent(new CustomEvent('toolchange'));
  }

  select(selection: Selection | null) {
    const before = this.selection;
    this.selection = selection;
    const pages = [before?.pageId, selection?.pageId].filter((p): p is string => !!p);
    this.viewer.redraw([...new Set(pages)]);
    this.dispatchEvent(new CustomEvent('selectionchange'));
  }

  selectedAnnot(): Annot | null {
    if (!this.selection || !this.doc) return null;
    return this.doc.annots(this.selection.pageId).find((a) => a.id === this.selection!.id) ?? null;
  }

  /** The annotation the options bar should describe: being edited, or selected. */
  activeAnnot(): { pageId: string; annot: Annot } | null {
    const doc = this.doc;
    if (!doc) return null;
    if (this.text.active) return doc.findAnnot(this.text.editingId);
    const a = this.selectedAnnot();
    return a ? { pageId: this.selection!.pageId, annot: a } : null;
  }

  /** Changes style for the current tool and anything selected or being edited. */
  applyStyle<K extends keyof ToolStyles>(group: K, patch: Partial<ToolStyles[K]>, options: { remember?: boolean; focus?: boolean } = {}) {
    // a font from inside one PDF means nothing to the next, so that kind of
    // choice changes the text in hand without becoming the default
    if (options.remember !== false) {
      Object.assign(this.styles[group], patch);
      saveStyles(this.styles);
    }

    const doc = this.doc;
    const active = this.activeAnnot();
    if (doc && active) {
      const a = active.annot;
      let updated = { ...a, ...patch } as Annot;
      if (updated.type === 'stamp' && 'date' in patch) {
        // the tool remembers "with a date"; a stamp stores the date itself
        const want = (patch as { date?: boolean }).date;
        updated = { ...updated, date: want ? (a.type === 'stamp' && a.date) || new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null };
      }
      if (this.text.active) {
        this.text.restyle(patch as Partial<TextAnnot>, { focus: options.focus });
      } else if (styleGroupFor(a.type) === group) {
        doc.updateAnnot(active.pageId, updated);
        doc.commit();
      }
    }
    this.dispatchEvent(new CustomEvent('stylechange'));
  }

  resetStyles() {
    this.styles = structuredClone(DEFAULT_STYLES);
    saveStyles(this.styles);
    this.dispatchEvent(new CustomEvent('stylechange'));
  }

  editSelectedText() {
    const a = this.selectedAnnot();
    const view = this.selection && this.viewer.views.get(this.selection.pageId);
    if (!a || !view || (a.type !== 'text' && a.type !== 'replace')) return;
    this.select(null);
    this.text.start(view, a);
  }

  // --- placing images and signatures ---------------------------------------------

  startPlacement(placement: Placement) {
    this.setTool(placement.then === 'sign' ? 'sign' : 'image');
    this.placement = placement;
    this.dispatchEvent(new CustomEvent('toolchange'));
  }

  cancelPlacement() {
    this.placement = null;
    this.ghost?.remove();
    this.ghost = null;
  }

  private placeAt(view: PageView, ux: number, uy: number) {
    const doc = this.doc!;
    const placement = this.placement!;
    const asset = doc.assets.get(placement.assetId);
    if (!asset) return;
    // the page is shown turned clockwise by its rotation, so turning the
    // picture counter-clockwise by the same amount makes it read upright
    const angle = doc.displayRotation(view.ref);
    const lw = placement.width;
    const lh = (lw * asset.height) / asset.width;
    const sideways = angle % 180 !== 0;
    const w = sideways ? lh : lw, h = sideways ? lw : lh;
    const annot: ImageAnnot = { id: newId('img'), type: 'image', x: ux - w / 2, y: uy - h / 2, w, h, angle, asset: asset.id };
    doc.addAnnot(view.ref.id, annot);
    doc.commit();
    this.cancelPlacement();
    this.setTool('select');
    this.select({ pageId: view.ref.id, id: annot.id });
  }

  private showGhost(view: PageView, clientX: number, clientY: number) {
    const doc = this.doc!;
    const asset = doc.assets.get(this.placement!.assetId);
    if (!asset) return;
    if (!this.ghost) {
      this.ghost = new Image();
      this.ghost.className = 'placement-ghost';
      this.ghost.src = asset.dataUrl;
    }
    if (this.ghost.parentElement !== view.overlay) view.overlay.append(this.ghost);
    const [x, y] = this.viewer.local(view, clientX, clientY);
    const wPx = this.placement!.width * this.viewer.scale;
    const hPx = (wPx * asset.height) / asset.width;
    Object.assign(this.ghost.style, { left: `${x - wPx / 2}px`, top: `${y - hPx / 2}px`, width: `${wPx}px`, height: `${hPx}px` });
  }

  // --- deleting, copying -----------------------------------------------------------

  deleteSelected() {
    const doc = this.doc;
    if (!doc || !this.selection) return false;
    doc.removeAnnot(this.selection.pageId, this.selection.id);
    doc.commit();
    this.select(null);
    return true;
  }

  copySelected(cut = false) {
    const a = this.selectedAnnot();
    if (!a) return false;
    this.clipboard = { annot: structuredClone(a), pasteCount: 0 };
    if (cut) this.deleteSelected();
    return true;
  }

  paste() {
    const doc = this.doc;
    if (!doc || !this.clipboard) return false;
    const pageId = this.viewer.currentPageId ?? doc.pages[0]?.id;
    if (!pageId) return false;
    this.clipboard.pasteCount++;
    const offset = 12 * this.clipboard.pasteCount;
    const copy = { ...moveAnnot(structuredClone(this.clipboard.annot), offset, -offset), id: newId('a') } as Annot;
    // a pasted replacement no longer sits on the text it replaced, so it
    // becomes ordinary text
    const annot: Annot = copy.type === 'replace'
      ? { id: copy.id, type: 'text', x: copy.x, y: copy.y, angle: copy.angle, text: copy.text, size: copy.size, font: copy.font, family: copy.family, bold: copy.bold, italic: copy.italic, underline: copy.underline, color: copy.color, background: copy.background, align: copy.align, opacity: copy.opacity }
      : copy;
    doc.addAnnot(pageId, annot);
    doc.commit();
    if (this.tool !== 'select') this.setTool('select');
    this.select({ pageId, id: annot.id });
    return true;
  }

  duplicateSelected() {
    if (!this.copySelected()) return false;
    const pageId = this.selection!.pageId;
    const current = this.viewer.currentPageId;
    this.viewer.currentPageId = pageId;
    this.paste();
    this.viewer.currentPageId = current;
    return true;
  }

  nudge(dxPx: number, dyPx: number) {
    const doc = this.doc;
    const a = this.selectedAnnot();
    const view = this.selection && this.viewer.views.get(this.selection.pageId);
    if (!doc || !a || !view?.viewport) return;
    // convert a screen-direction nudge into user space, honouring rotation
    const [x0, y0] = view.viewport.convertToPdfPoint(0, 0);
    const [x1, y1] = view.viewport.convertToPdfPoint(dxPx * this.viewer.scale, dyPx * this.viewer.scale);
    doc.updateAnnot(this.selection!.pageId, moveAnnot(a, x1 - x0, y1 - y0));
  }

  // --- pointer handling -----------------------------------------------------------

  private attach() {
    const root = this.viewer.container;
    root.addEventListener('pointerdown', (e) => {
      if (this.touchDown(e)) return;
      this.onPointerDown(e);
    });
    // a pinch takes over from whatever the first finger started
    root.addEventListener('pointermove', (e) => this.touchMove(e));
    const lift = (e: PointerEvent) => this.touchUp(e);
    root.addEventListener('pointerup', lift);
    root.addEventListener('pointercancel', lift);
    // Clicking the page shouldn't move keyboard focus (or start a text
    // selection); otherwise a text box we just opened would lose focus at once.
    root.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('.text-editor, .form-field')) e.preventDefault();
    });
    root.addEventListener('pointermove', (e) => this.onPointerMove(e));
    root.addEventListener('pointerup', (e) => this.onPointerUp(e));
    root.addEventListener('pointercancel', () => this.cancelDrag());
    root.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    root.addEventListener('pointerleave', () => {
      this.clearHover();
      this.ghost?.remove();
    });
    root.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // trackpad pinches arrive as small ctrl+wheel deltas
      const factor = Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 10 ? 0.01 : 0.002));
      this.viewer.setScale(this.viewer.scale * factor, e);
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  // --- touch: two fingers zoom and scroll, whatever tool is picked ---------------------------------

  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; scale: number; mid: { x: number; y: number }; frame: number } | null = null;

  private fingers() {
    const [a, b] = [...this.touches.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  /** Returns true when the touch belongs to a pinch, so the tools should leave it alone. */
  private touchDown(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size < 2) return this.pinch !== null;
    if (!this.pinch) {
      // undo whatever the first finger began (a stroke, a move) and switch to zooming
      this.cancelDrag();
      const { distance, mid } = this.fingers();
      this.pinch = { distance, scale: this.viewer.scale, mid, frame: 0 };
    }
    return true;
  }

  private touchMove(e: PointerEvent) {
    if (e.pointerType !== 'touch' || !this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = this.pinch;
    if (!pinch || this.touches.size < 2) return;
    e.stopImmediatePropagation();
    if (pinch.frame) return;
    pinch.frame = requestAnimationFrame(() => {
      pinch.frame = 0;
      if (this.pinch !== pinch || this.touches.size < 2) return;
      const { distance, mid } = this.fingers();
      this.viewer.setScale(pinch.scale * (distance / pinch.distance), { clientX: mid.x, clientY: mid.y });
      const c = this.viewer.container;
      c.scrollLeft -= mid.x - pinch.mid.x;
      c.scrollTop -= mid.y - pinch.mid.y;
      pinch.mid = mid;
    });
  }

  private touchUp(e: PointerEvent) {
    if (e.pointerType !== 'touch') return;
    this.touches.delete(e.pointerId);
    // the pinch ends once every finger is off the screen
    if (!this.touches.size && this.pinch) {
      cancelAnimationFrame(this.pinch.frame);
      this.pinch = null;
    }
  }

  private tolerance() {
    return 5 / this.viewer.scale;
  }

  private topmostAt(view: PageView, ux: number, uy: number, filter?: (a: Annot) => boolean): Annot | null {
    const annots = this.doc!.annots(view.ref.id);
    for (let i = annots.length - 1; i >= 0; i--) {
      const a = annots[i];
      if (filter && !filter(a)) continue;
      if (hitTest(a, ux, uy, this.tolerance())) return a;
    }
    return null;
  }

  private handleAt(view: PageView, clientX: number, clientY: number): number {
    const a = this.selectedAnnot();
    if (!a || this.selection!.pageId !== view.ref.id) return -1;
    const [px, py] = this.viewer.local(view, clientX, clientY);
    const handles = handlesFor(a);
    for (let i = 0; i < handles.length; i++) {
      const [hx, hy] = this.viewer.toLocal(view, ...handles[i]);
      if (Math.abs(hx - px) <= 7 && Math.abs(hy - py) <= 7) return i;
    }
    return -1;
  }

  private onPointerDown(e: PointerEvent) {
    const doc = this.doc;
    if (!doc || e.button === 1 || (e.button === 0 && this.spaceDown)) {
      if (doc) this.startPan(e);
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.text-editor, .form-field')) return;

    const view = this.viewer.viewAt(e.target);
    const wasEditing = this.text.active;
    if (wasEditing) this.text.finish();

    if (!view?.viewport) {
      this.select(null);
      if (this.tool === 'hand' || e.pointerType === 'touch') this.startPan(e);
      return;
    }

    const [ux, uy] = this.viewer.toUser(view, e.clientX, e.clientY);
    const pageId = view.ref.id;
    const capture = () => this.viewer.container.setPointerCapture(e.pointerId);

    switch (this.tool) {
      case 'hand':
        this.startPan(e);
        return;

      case 'select': {
        const handle = this.handleAt(view, e.clientX, e.clientY);
        if (handle >= 0) {
          this.drag = { kind: 'handle', view, original: this.selectedAnnot()!, index: handle };
          this.viewer.beginLive(pageId, this.selection!.id);
          capture();
          return;
        }
        const hit = this.topmostAt(view, ux, uy);
        if (hit) {
          this.select({ pageId, id: hit.id });
          this.drag = { kind: 'move', view, original: hit, start: [ux, uy], moved: false };
          capture();
        } else {
          this.select(null);
          // on a touch screen, dragging an empty spot scrolls the page
          if (e.pointerType === 'touch') this.startPan(e);
        }
        return;
      }

      case 'eraser': {
        this.drag = { kind: 'erase', view, erased: 0 };
        this.eraseAt(view, ux, uy);
        capture();
        return;
      }

      case 'pen': {
        const s = this.styles.pen;
        const id = newId('ink');
        doc.addAnnot(pageId, { id, type: 'ink', points: [[ux, uy]], color: s.color, width: s.width, opacity: s.opacity });
        this.drag = { kind: 'ink', view, id, points: [[ux, uy]] };
        this.viewer.beginLive(pageId, id);
        capture();
        return;
      }

      case 'line':
      case 'arrow': {
        const s = this.styles.line;
        const id = newId('ln');
        doc.addAnnot(pageId, { id, type: this.tool, x1: ux, y1: uy, x2: ux, y2: uy, color: s.color, width: s.width });
        this.drag = { kind: 'line', view, id, start: [ux, uy] };
        this.viewer.beginLive(pageId, id);
        capture();
        return;
      }

      case 'text': {
        // press on a text box: drag moves it, a plain click types in it
        const existing = this.topmostAt(view, ux, uy, (a) => a.type === 'text' || a.type === 'replace');
        if (existing) {
          this.pressText(view, existing, ux, uy, capture);
          return;
        }
        if (wasEditing) return; // that click just closed the editor
        if (this.selection) {
          this.select(null);
          return; // first click away from a selected box just lets go of it
        }
        const s = this.styles.text;
        const angle = doc.displayRotation(view.ref);
        // put the caret where the click was, roughly centred on the line
        const [ox, oy] = this.viewer.toUser(view, e.clientX - 2, e.clientY - s.size * this.viewer.scale * 0.6);
        const annot: TextAnnot = { id: newId('txt'), type: 'text', x: ox, y: oy, angle, text: '', ...s };
        doc.addAnnot(pageId, annot);
        this.text.start(view, annot, { isNew: true });
        e.preventDefault();
        return;
      }

      case 'edit-text': {
        if (wasEditing) return;
        e.preventDefault();
        const existing = this.topmostAt(view, ux, uy, (a) => a.type === 'text' || a.type === 'replace');
        if (existing) {
          this.pressText(view, existing, ux, uy, capture);
          return;
        }
        this.select(null);
        textRuns(view).then(async (runs) => {
          const run = runAt(runs, ux, uy, this.tolerance());
          if (!run || this.tool !== 'edit-text') return;
          this.clearHover();
          const annot = replacementFor(this.viewer, view, run);
          // Keep the line's own font when it's embedded and safe to reuse.
          // Usually it's already loaded from hovering; don't keep the click
          // waiting long if it isn't.
          const lookup = originalFamily(doc, view, run);
          const family = await within(lookup, 700, null);
          if (this.tool !== 'edit-text' || this.text.active) return;
          if (family) annot.family = family.key;
          doc.addAnnot(pageId, annot);
          this.text.start(view, annot, { isNew: true, selectAll: true });
          if (!family) {
            // arrived late: switch over if the user is still in that box
            lookup.then((late) => {
              if (late && this.text.isEditing(annot.id)) this.text.restyle({ family: late.key });
            });
          }
        });
        return;
      }

      case 'image':
      case 'sign':
        if (this.placement) this.placeAt(view, ux, uy);
        return;

      case 'note': {
        // a click on an existing note opens it rather than stacking another
        const existing = this.topmostAt(view, ux, uy, (a) => a.type === 'note');
        if (existing) {
          this.select({ pageId, id: existing.id });
          this.drag = { kind: 'move', view, original: existing, start: [ux, uy], moved: false };
          capture();
          return;
        }
        const s = this.styles.note;
        const note: NoteAnnot = {
          id: newId('note'), type: 'note', x: ux - 4, y: uy - 16, w: 20, h: 20,
          text: '', color: s.color, author: commentAuthor(), created: Date.now(),
        };
        doc.addAnnot(pageId, note);
        doc.commit();
        this.select({ pageId, id: note.id });
        this.dispatchEvent(new CustomEvent('note-created', { detail: note.id }));
        e.preventDefault();
        return;
      }

      case 'stamp': {
        const stamp = this.newStamp(view, ux, uy);
        doc.addAnnot(pageId, stamp);
        doc.commit();
        this.setTool('select');
        this.select({ pageId, id: stamp.id });
        return;
      }

      case 'crop': {
        const el = document.createElement('div');
        el.className = 'crop-rect';
        view.overlay.append(el);
        this.drag = { kind: 'crop', view, start: [ux, uy], el };
        capture();
        e.preventDefault();
        return;
      }

      default:
        if (BOX_TOOLS.has(this.tool)) {
          const id = newId('box');
          doc.addAnnot(pageId, this.newBox(id, ux, uy));
          this.drag = { kind: 'box', view, id, start: [ux, uy] };
          this.viewer.beginLive(pageId, id);
          capture();
        }
    }
  }

  /** Starts a press on a text box: dragging moves it, a click edits it. */
  private pressText(view: PageView, annot: Annot, ux: number, uy: number, capture: () => void) {
    this.select({ pageId: view.ref.id, id: annot.id });
    this.drag = { kind: 'move', view, original: annot, start: [ux, uy], moved: false, editOnClick: true };
    capture();
  }

  private newBox(id: string, x: number, y: number): Annot {
    const base = { id, x, y, w: 0, h: 0 };
    switch (this.tool) {
      case 'highlight':
        return { ...base, type: 'highlight', color: this.styles.highlight.color };
      case 'whiteout':
        return { ...base, type: 'whiteout', color: this.styles.whiteout.color };
      case 'redact':
        return { ...base, type: 'redact', color: this.styles.redact.color };
      case 'ellipse':
        return { ...base, type: 'ellipse', ...this.styles.shape };
      case 'field': {
        const kind = this.styles.field.kind;
        const field: FieldAnnot = { ...base, type: 'field', kind, name: this.fieldName(kind), options: kind === 'dropdown' ? ['Option 1', 'Option 2'] : [], required: false, angle: 0 };
        return field;
      }
      default:
        return { ...base, type: 'rect', ...this.styles.shape };
    }
  }

  /** A name no other field in the document has yet: "Text 1", "Text 2"... */
  private fieldName(kind: FieldKind): string {
    const doc = this.doc!;
    const used = new Set(doc.pages.flatMap((p) => doc.annots(p.id)).filter((a) => a.type === 'field').map((a) => (a as FieldAnnot).name));
    let n = 1;
    while (used.has(`${FIELD_NAMES[kind]} ${n}`)) n++;
    return `${FIELD_NAMES[kind]} ${n}`;
  }

  /** A stamp centred on (ux, uy), sized to fit its words and turned upright. */
  private newStamp(view: PageView, ux: number, uy: number): StampAnnot {
    const s = this.styles.stamp;
    const h = 40;
    const date = s.date ? new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    const labelSize = date ? h * 0.42 : h * 0.56;
    const words = lineWidth({ font: 'sans', bold: true, italic: false }, s.label, labelSize);
    const w = Math.max(h * 2.2, words / 0.86 + h * 0.5);
    const angle = this.doc!.displayRotation(view.ref);
    const sideways = angle % 180 !== 0;
    const bw = sideways ? h : w, bh = sideways ? w : h;
    return { id: newId('stamp'), type: 'stamp', x: ux - bw / 2, y: uy - bh / 2, w: bw, h: bh, label: s.label, color: s.color, date, angle };
  }

  private startPan(e: PointerEvent) {
    const c = this.viewer.container;
    this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, left: c.scrollLeft, top: c.scrollTop };
    c.setPointerCapture(e.pointerId);
    c.classList.add('panning');
    e.preventDefault();
  }

  private eraseAt(view: PageView, ux: number, uy: number) {
    const hit = this.topmostAt(view, ux, uy);
    if (hit && this.drag?.kind === 'erase') {
      this.doc!.removeAnnot(view.ref.id, hit.id);
      this.drag.erased++;
    }
  }

  private onPointerMove(e: PointerEvent) {
    const doc = this.doc;
    if (!doc) return;
    const drag = this.drag;

    if (!drag) {
      this.hover(e);
      return;
    }
    if (drag.kind === 'pan') {
      const c = this.viewer.container;
      c.scrollLeft = drag.left - (e.clientX - drag.x);
      c.scrollTop = drag.top - (e.clientY - drag.y);
      return;
    }

    const view = drag.view;
    if (!view.viewport) return;
    const pageId = view.ref.id;
    const [ux, uy] = this.viewer.toUser(view, e.clientX, e.clientY);

    switch (drag.kind) {
      case 'move': {
        const dx = ux - drag.start[0], dy = uy - drag.start[1];
        if (!drag.moved && Math.hypot(dx, dy) * this.viewer.scale < 3) return;
        if (!drag.moved) this.viewer.beginLive(pageId, drag.original.id);
        drag.moved = true;
        doc.updateAnnot(pageId, moveAnnot(drag.original, dx, dy));
        break;
      }
      case 'handle':
        doc.updateAnnot(pageId, dragHandle(drag.original, drag.index, ux, uy, drag.original.type === 'image' ? !e.shiftKey : e.shiftKey));
        break;
      case 'ink': {
        // coalesced events give a smoother line on fast strokes
        const events = e.getCoalescedEvents?.() ?? [e];
        for (const ev of events.length ? events : [e]) {
          drag.points.push(this.viewer.toUser(view, ev.clientX, ev.clientY));
        }
        const a = doc.annots(pageId).find((x) => x.id === drag.id);
        // the same array grows during the stroke; it is replaced by a simplified copy on release
        if (a?.type === 'ink') doc.updateAnnot(pageId, { ...a, points: drag.points });
        break;
      }
      case 'box': {
        const a = doc.annots(pageId).find((x) => x.id === drag.id);
        if (!a || !('w' in a)) break;
        let [x1, y1] = [ux, uy];
        if (e.shiftKey && (a.type === 'rect' || a.type === 'ellipse')) {
          const side = Math.max(Math.abs(ux - drag.start[0]), Math.abs(uy - drag.start[1]));
          x1 = drag.start[0] + Math.sign(ux - drag.start[0] || 1) * side;
          y1 = drag.start[1] + Math.sign(uy - drag.start[1] || 1) * side;
        }
        doc.updateAnnot(pageId, { ...a, ...normBox(drag.start[0], drag.start[1], x1, y1) });
        break;
      }
      case 'line': {
        const a = doc.annots(pageId).find((x) => x.id === drag.id);
        if (!a || (a.type !== 'line' && a.type !== 'arrow')) break;
        let [x2, y2] = [ux, uy];
        if (e.shiftKey) {
          // snap to 45° steps
          const angle = Math.round(Math.atan2(uy - drag.start[1], ux - drag.start[0]) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(ux - drag.start[0], uy - drag.start[1]);
          x2 = drag.start[0] + Math.cos(angle) * len;
          y2 = drag.start[1] + Math.sin(angle) * len;
        }
        doc.updateAnnot(pageId, { ...a, x2, y2 });
        break;
      }
      case 'erase':
        this.eraseAt(view, ux, uy);
        break;
      case 'crop': {
        const [ax, ay] = this.viewer.toLocal(view, drag.start[0], drag.start[1]);
        const [bx, by] = this.viewer.toLocal(view, ux, uy);
        Object.assign(drag.el.style, {
          left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`,
          width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px`,
        });
        break;
      }
    }
  }

  private onPointerUp(_e: PointerEvent) {
    const doc = this.doc;
    const drag = this.drag;
    this.drag = null;
    this.viewer.endLive();
    this.viewer.container.classList.remove('panning');
    if (!doc || !drag || drag.kind === 'pan') return;
    const pageId = drag.view.ref.id;

    if (drag.kind === 'crop') {
      const [ux, uy] = this.viewer.toUser(drag.view, _e.clientX, _e.clientY);
      const box = normBox(drag.start[0], drag.start[1], ux, uy);
      if (box.w * this.viewer.scale < 12 || box.h * this.viewer.scale < 12) {
        drag.el.remove();
        return;
      }
      // the app asks which pages to crop, then removes the outline
      this.dispatchEvent(new CustomEvent<{ pageId: string; box: Box; el: HTMLElement }>('crop', { detail: { pageId, box, el: drag.el } }));
      return;
    }

    switch (drag.kind) {
      case 'move':
        if (drag.moved) {
          doc.commit();
        } else if (drag.editOnClick) {
          const a = doc.annots(pageId).find((x) => x.id === drag.original.id);
          if (a && (a.type === 'text' || a.type === 'replace')) {
            this.select(null);
            this.text.start(drag.view, a);
          }
        }
        break;
      case 'handle':
      case 'erase':
        doc.commit();
        break;
      case 'ink': {
        const a = doc.annots(pageId).find((x) => x.id === drag.id);
        if (a?.type === 'ink') {
          doc.updateAnnot(pageId, { ...a, points: simplifyStroke(drag.points, 0.35) });
          doc.commit();
        }
        break;
      }
      case 'box': {
        const a = doc.annots(pageId).find((x) => x.id === drag.id);
        const tooSmall = !a || !('w' in a) || a.w * this.viewer.scale < 4 || a.h * this.viewer.scale < 4;
        if (tooSmall && a && (a.type === 'rect' || a.type === 'ellipse')) {
          // a plain click drops a default-sized shape
          doc.updateAnnot(pageId, { ...a, x: a.x - 40, y: a.y - 30, w: 80, h: 60 });
        } else if (tooSmall && a?.type === 'field') {
          const [w, h] = FIELD_SIZES[a.kind];
          doc.updateAnnot(pageId, { ...a, y: a.y - h, w, h });
        } else if (tooSmall) {
          doc.removeAnnot(pageId, drag.id);
          doc.revert();
          return;
        }
        doc.commit();
        if (a && (a.type === 'rect' || a.type === 'ellipse' || a.type === 'field')) this.select({ pageId, id: a.id });
        break;
      }
      case 'line': {
        const a = doc.annots(pageId).find((x) => x.id === drag.id);
        if (a && (a.type === 'line' || a.type === 'arrow') && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) * this.viewer.scale < 4) {
          doc.removeAnnot(pageId, drag.id);
          doc.revert();
          return;
        }
        doc.commit();
        if (a) this.select({ pageId, id: a.id });
        break;
      }
    }
  }

  cancelDrag() {
    if (this.drag?.kind === 'crop') this.drag.el.remove();
    else if (this.drag && this.drag.kind !== 'pan') this.doc?.revert();
    this.drag = null;
    this.viewer.endLive();
    this.viewer.container.classList.remove('panning');
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.tool !== 'select' || !this.doc) return;
    const view = this.viewer.viewAt(e.target);
    if (!view?.viewport) return;
    const [ux, uy] = this.viewer.toUser(view, e.clientX, e.clientY);
    const hit = this.topmostAt(view, ux, uy, (a) => a.type === 'text' || a.type === 'replace');
    if (hit && (hit.type === 'text' || hit.type === 'replace')) {
      this.select(null);
      this.text.start(view, hit);
    }
  }

  // --- hover feedback -------------------------------------------------------------

  private clearHover() {
    this.hoverOutline?.remove();
    this.hoverOutline = null;
  }

  private hover(e: PointerEvent) {
    const view = this.viewer.viewAt(e.target);
    const container = this.viewer.container;
    if (!view?.viewport) {
      this.clearHover();
      return;
    }

    if (this.placement) {
      this.showGhost(view, e.clientX, e.clientY);
      return;
    }

    const [ux, uy] = this.viewer.toUser(view, e.clientX, e.clientY);

    if (this.tool === 'select') {
      const onHandle = this.handleAt(view, e.clientX, e.clientY) >= 0;
      const onAnnot = !onHandle && !!this.topmostAt(view, ux, uy);
      container.dataset.hover = onHandle ? 'handle' : onAnnot ? 'annot' : '';
      return;
    }

    if (this.tool === 'text' || this.tool === 'edit-text') {
      const onText = !this.text.active && !!this.topmostAt(view, ux, uy, (a) => a.type === 'text' || a.type === 'replace');
      container.dataset.hover = onText ? 'annot' : '';
      if (this.tool === 'text') return;
    }

    if (this.tool === 'edit-text' && !this.text.active) {
      if (this.topmostAt(view, ux, uy, (a) => a.type === 'text' || a.type === 'replace')) {
        this.clearHover();
        return;
      }
      textRuns(view).then((runs) => {
        const run = runAt(runs, ux, uy, this.tolerance());
        if (!run || this.tool !== 'edit-text') {
          this.clearHover();
          return;
        }
        if (this.doc) void originalFamily(this.doc, view, run); // warm up the font for the click
        const box = runBox(run);
        const [ax, ay] = this.viewer.toLocal(view, box.x, box.y);
        const [bx, by] = this.viewer.toLocal(view, box.x + box.w, box.y + box.h);
        if (!this.hoverOutline) {
          this.hoverOutline = document.createElement('div');
          this.hoverOutline.className = 'text-hover';
        }
        if (this.hoverOutline.parentElement !== view.overlay) view.overlay.append(this.hoverOutline);
        Object.assign(this.hoverOutline.style, {
          left: `${Math.min(ax, bx)}px`,
          top: `${Math.min(ay, by)}px`,
          width: `${Math.abs(bx - ax)}px`,
          height: `${Math.abs(by - ay)}px`,
        });
      });
    }
  }

  // --- keyboard --------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent) {
    if (isModalOpen()) return;
    const target = e.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === ' ' && !this.spaceDown) {
      this.spaceDown = true;
      if (this.tool !== 'hand') {
        this.toolBeforeSpace = this.tool;
        this.viewer.container.dataset.tool = 'hand';
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      if (this.placement) this.setTool('select');
      else if (this.selection) this.select(null);
      else if (this.tool !== 'select') this.setTool('select');
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }

    if (e.key.startsWith('Arrow') && this.selection && !mod) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      this.nudge(dx, dy);
      return;
    }

    // copy/cut/paste/undo arrive through the menu (see app.ts) so they work
    // the same whether or not the menu swallows the keystroke
    if (mod) return;

    if (e.altKey || !this.doc) return;
    const tools: Record<string, Tool> = {
      v: 'select', h: 'hand', t: 'text', e: 'edit-text', p: 'pen', m: 'highlight',
      r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout', b: 'redact', x: 'eraser', n: 'note', k: 'stamp',
    };
    const tool = tools[e.key.toLowerCase()];
    if (tool) {
      e.preventDefault();
      this.setTool(tool);
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    if (e.key === ' ' && this.spaceDown) {
      this.spaceDown = false;
      this.viewer.container.dataset.tool = this.toolBeforeSpace ?? this.tool;
      this.toolBeforeSpace = null;
    }
    if (e.key.startsWith('Arrow') && this.selection) this.doc?.commit();
  }

  /** Bounds of the selection in client pixels, for positioning popovers. */
  selectionRect(): DOMRect | null {
    const a = this.selectedAnnot();
    const view = this.selection && this.viewer.views.get(this.selection.pageId);
    if (!a || !view?.viewport) return null;
    const b = annotBounds(a);
    const [x0, y0] = this.viewer.toLocal(view, b.x, b.y);
    const [x1, y1] = this.viewer.toLocal(view, b.x + b.w, b.y + b.h);
    const r = view.el.getBoundingClientRect();
    return new DOMRect(r.left + Math.min(x0, x1), r.top + Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
}

export function styleGroupFor(type: Annot['type']): keyof ToolStyles {
  switch (type) {
    case 'ink': return 'pen';
    case 'highlight': return 'highlight';
    case 'rect':
    case 'ellipse': return 'shape';
    case 'line':
    case 'arrow': return 'line';
    case 'whiteout': return 'whiteout';
    case 'redact': return 'redact';
    case 'note': return 'note';
    case 'stamp': return 'stamp';
    case 'field': return 'field';
    default: return 'text';
  }
}

