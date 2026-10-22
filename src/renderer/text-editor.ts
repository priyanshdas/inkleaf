// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditorDoc } from './document';
import { cssFont, LINE_HEIGHT, measureText } from './fonts';
import type { ReplaceAnnot, TextAnnot } from './types';
import type { PageView, Viewer } from './viewer';

type Editable = TextAnnot | ReplaceAnnot;

/**
 * Edits text in place with a borderless <textarea> laid exactly over where
 * the text will be drawn. While it's open the canvas skips that annotation,
 * so you only ever see one copy of the words.
 */
export class TextEditor {
  private area: HTMLTextAreaElement | null = null;
  private view: PageView | null = null;
  private pageId = '';
  private annotId = '';
  private isNew = false;
  private onDone: (() => void) | null = null;
  /** Told whenever editing ends; `byKey` is true for Esc or Ctrl+Enter. */
  /** Ctrl+B / I / U while typing; the editor turns these into style changes. */
  onStyleKey: ((name: 'bold' | 'italic' | 'underline') => void) | null = null;
  /** Told when a box opens for typing. */
  onStarted: (() => void) | null = null;
  onFinished: ((info: { pageId: string; id: string; kept: boolean; byKey: boolean }) => void) | null = null;

  constructor(private viewer: Viewer, private getDoc: () => EditorDoc | null) {}

  get active() {
    return this.area !== null;
  }

  get editingId() {
    return this.annotId;
  }

  isEditing(id: string) {
    return this.active && this.annotId === id;
  }

  private current(): Editable | null {
    const a = this.getDoc()?.annots(this.pageId).find((x) => x.id === this.annotId);
    return a && (a.type === 'text' || a.type === 'replace') ? a : null;
  }

  start(view: PageView, annot: Editable, options: { isNew?: boolean; selectAll?: boolean; onDone?: () => void } = {}) {
    this.finish();
    this.view = view;
    this.pageId = view.ref.id;
    this.annotId = annot.id;
    this.isNew = !!options.isNew;
    this.onDone = options.onDone ?? null;

    const area = document.createElement('textarea');
    area.className = 'text-editor';
    area.spellcheck = true;
    area.value = annot.text;
    area.setAttribute('aria-label', 'Text');
    area.addEventListener('input', () => this.onInput());
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        this.finish(true);
      }
      const mod = e.metaKey || e.ctrlKey;
      const style = ({ b: 'bold', i: 'italic', u: 'underline' } as const)[e.key.toLowerCase() as 'b' | 'i' | 'u'];
      if (mod && !e.altKey && !e.shiftKey && style) {
        e.preventDefault();
        this.onStyleKey?.(style);
      }
      // keep app shortcuts (tool letters, delete) from firing while typing
      e.stopPropagation();
    });
    area.addEventListener('blur', () => {
      // clicks on the properties panel or the text toolbar (font size,
      // the font list...) keep the editor open
      setTimeout(() => {
        const focused = document.activeElement;
        if (this.area === area && !focused?.closest('#inspector, .text-toolbar, .font-menu')) this.finish();
      }, 0);
    });

    this.area = area;
    view.overlay.append(area);
    this.layout();
    this.viewer.redraw([this.pageId]);
    area.focus();
    if (options.selectAll) area.select();
    else area.setSelectionRange(area.value.length, area.value.length);
    this.onStarted?.();
  }

  /** Repositions and restyles the textarea (after zoom, or a style change). */
  layout() {
    const area = this.area, view = this.view, annot = this.current();
    if (!area || !view?.viewport || !annot) return;
    const doc = this.getDoc()!;
    const scale = this.viewer.scale;
    const [left, top] = this.viewer.toLocal(view, annot.x, annot.y);
    const style = { ...annot, text: area.value || ' ' };
    const { width, height } = measureText(style);
    const turn = doc.displayRotation(view.ref) - annot.angle;

    // The box is a little wider than the text so the caret has room. With
    // centred or right-aligned text that extra room would push the words
    // along, so the box is shifted back by the same amount.
    const room = annot.size * scale + 8;
    const before = annot.align === 'center' ? room / 2 : annot.align === 'right' ? room : 0;
    const pad = annot.background ? annot.size * scale * 0.18 : 0;
    Object.assign(area.style, {
      left: `${left}px`,
      top: `${top}px`,
      font: cssFont(style, annot.size * scale),
      lineHeight: String(LINE_HEIGHT),
      color: annot.color,
      textAlign: annot.align ?? 'left',
      textDecoration: annot.underline ? 'underline' : 'none',
      backgroundColor: annot.background ?? 'transparent',
      boxShadow: pad ? `0 0 0 ${pad}px ${annot.background}` : '',
      opacity: String(annot.opacity ?? 1),
      paddingRight: '2px',
      width: `${Math.ceil(width * scale) + room + 2}px`,
      height: `${Math.ceil(height * scale) + 2}px`,
      transform: `${turn ? `rotate(${turn}deg) ` : ''}translateX(${-before}px)`,
    });
  }

  private onInput() {
    const doc = this.getDoc();
    const annot = this.current();
    if (!doc || !annot || !this.area) return;
    // the canvas hides text while it's being edited, so there's nothing to
    // repaint on each keystroke; the page catches up when editing ends
    doc.updateAnnot(this.pageId, { ...annot, text: this.area.value }, { quiet: annot.type === 'text' });
    this.layout();
  }

  /** Applies a style change from the options bar while editing. */
  restyle(patch: Partial<Editable>, options: { focus?: boolean } = {}) {
    const doc = this.getDoc();
    const annot = this.current();
    if (!doc || !annot) return;
    doc.updateAnnot(this.pageId, { ...annot, ...patch } as Editable);
    this.layout();
    if (options.focus !== false) this.area?.focus();
  }

  /** Puts the caret back in the text box (after using a menu, say). */
  focus() {
    this.area?.focus();
  }

  finish(byKey = false) {
    const area = this.area;
    if (!area) return;
    this.area = null;
    area.remove();

    const doc = this.getDoc();
    const annot = this.current();
    let kept = false;
    if (doc && annot) {
      kept = true;
      const text = area.value.replace(/\s+$/, '');
      if (annot.type === 'text' && !text.trim()) {
        // an empty new text box is just a stray click
        doc.removeAnnot(this.pageId, annot.id);
        kept = false;
      } else if (annot.type === 'replace' && text === annot.original && this.isNew) {
        // opened an existing line and changed nothing: don't touch the file
        doc.removeAnnot(this.pageId, annot.id);
        kept = false;
      } else {
        doc.updateAnnot(this.pageId, { ...annot, text });
      }
      doc.commit();
    }

    const pageId = this.pageId;
    const id = this.annotId;
    this.annotId = '';
    this.view = null;
    this.viewer.redraw([pageId]);
    const done = this.onDone;
    this.onDone = null;
    done?.();
    this.onFinished?.({ pageId, id, kept, byKey });
  }
}
