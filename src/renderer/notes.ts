// SPDX-License-Identifier: GPL-3.0-or-later
// Comments: the sticky-note card that opens next to a selected note, and the
// list of every comment in the sidebar.

import type { EditorDoc } from './document';
import { commentAuthor, Editor } from './editor';
import { NOTE_COLORS } from './styles';
import type { NoteAnnot } from './types';
import { h, icon } from './ui';
import type { Viewer } from './viewer';

function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** The card for reading and writing one comment. */
export class NotePopup {
  private el: HTMLDivElement;
  private area: HTMLTextAreaElement;
  private meta: HTMLSpanElement;
  private colours: HTMLDivElement;
  private noteId = '';
  private pageId = '';
  private frame = 0;

  constructor(private editor: Editor, private viewer: Viewer, private getDoc: () => EditorDoc | null) {
    this.area = h('textarea', { class: 'note-text', rows: '4', placeholder: 'Write a comment…', 'aria-label': 'Comment' });
    this.meta = h('span', { class: 'note-meta' });
    this.colours = h('div', { class: 'note-colours' });
    const remove = h('button', { class: 'note-delete', title: 'Delete comment' }, icon('trash-2'));
    this.el = h('div', { class: 'note-card', hidden: true, role: 'dialog', 'aria-label': 'Comment' },
      h('div', { class: 'note-head' }, icon('message-square'), this.meta),
      this.area,
      h('div', { class: 'note-foot' }, this.colours, h('span', { class: 'spacer' }), remove));
    document.body.append(this.el);

    this.area.addEventListener('input', () => {
      const found = this.current();
      if (found) this.getDoc()!.updateAnnot(this.pageId, { ...found, text: this.area.value }, { quiet: true });
    });
    this.area.addEventListener('change', () => this.getDoc()?.commit());
    this.area.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing letters shouldn't switch tools
      if (e.key === 'Escape') {
        this.getDoc()?.commit();
        this.editor.select(null);
      }
    });
    remove.addEventListener('click', () => {
      if (!this.current()) return;
      this.editor.deleteSelected();
    });
    // keep focus in the text box when clicking the colours
    this.el.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('textarea')) e.preventDefault();
    });

    editor.addEventListener('selectionchange', () => this.update());
    editor.addEventListener('toolchange', () => this.update());
    editor.addEventListener('note-created', () => {
      this.update();
      requestAnimationFrame(() => this.area.focus());
    });
  }

  private current(): NoteAnnot | null {
    const a = this.getDoc()?.annots(this.pageId).find((x) => x.id === this.noteId);
    return a?.type === 'note' ? a : null;
  }

  update() {
    const active = this.editor.activeAnnot();
    if (!active || active.annot.type !== 'note') {
      if (this.noteId) this.getDoc()?.commit();
      this.noteId = '';
      this.el.hidden = true;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      return;
    }
    const note = active.annot;
    if (note.id !== this.noteId) {
      this.noteId = note.id;
      this.pageId = active.pageId;
      this.area.value = note.text;
    }
    this.meta.textContent = `${note.author || 'You'} · ${when(note.created)}`;
    this.colours.replaceChildren(...NOTE_COLORS.map((c) => {
      const b = h('button', { class: 'note-colour', style: `background:${c}`, title: 'Note colour', 'aria-pressed': String(c === note.color) });
      b.addEventListener('click', () => this.editor.applyStyle('note', { color: c }));
      return b;
    }));
    this.el.hidden = false;
    if (!this.frame) this.follow();
  }

  /** Stays next to the note while scrolling and zooming. */
  private follow = () => {
    this.frame = 0;
    const note = this.current();
    const view = this.viewer.views.get(this.pageId);
    if (!note || !view?.viewport || this.el.hidden) return;
    const page = view.overlay.getBoundingClientRect();
    const [x, y] = this.viewer.toLocal(view, note.x + note.w, note.y + note.h);
    const area = this.viewer.container.getBoundingClientRect();
    const w = this.el.offsetWidth, hgt = this.el.offsetHeight;
    let left = page.left + x + 8, top = page.top + y - 4;
    if (left + w > area.right - 8) left = page.left + x - note.w * this.viewer.scale - w - 8;
    top = Math.max(area.top + 8, Math.min(top, area.bottom - hgt - 8));
    const hiddenAway = page.top + y > area.bottom || page.top + y < area.top - 20;
    this.el.style.visibility = hiddenAway ? 'hidden' : 'visible';
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    this.frame = requestAnimationFrame(this.follow);
  };
}

/** Every comment in the document, newest page order, in the sidebar. */
export class CommentsPanel {
  constructor(
    private root: HTMLElement,
    private editor: Editor,
    private viewer: Viewer,
    private getDoc: () => EditorDoc | null,
    private defaultAuthor: () => string,
  ) {}

  /** How many comments there are, for the tab's badge. */
  count(): number {
    const doc = this.getDoc();
    if (!doc) return 0;
    return doc.pages.reduce((n, p) => n + doc.annots(p.id).filter((a) => a.type === 'note').length, 0);
  }

  render() {
    const doc = this.getDoc();
    if (!doc) {
      this.root.replaceChildren();
      return;
    }
    const name = h('input', { class: 'field-input', value: commentAuthor() || this.defaultAuthor(), placeholder: 'Your name', 'aria-label': 'Your name on new comments' });
    name.addEventListener('change', () => {
      try {
        localStorage.setItem('inkleaf.author', name.value.trim());
      } catch {
        // fine: comments just won't remember the name
      }
    });

    const items: HTMLElement[] = [];
    doc.pages.forEach((page, index) => {
      for (const a of doc.annots(page.id)) {
        if (a.type !== 'note') continue;
        const selected = this.editor.selection?.id === a.id;
        const item = h('button', { class: `comment-item${selected ? ' selected' : ''}` },
          h('span', { class: 'comment-dot', style: `background:${a.color}` }),
          h('span', { class: 'comment-body' },
            h('span', { class: 'comment-meta' }, `${a.author || 'You'} · Page ${index + 1}`),
            h('span', { class: `comment-text${a.text.trim() ? '' : ' empty'}` }, a.text.trim() || 'Empty comment'),
          ));
        item.addEventListener('click', () => {
          if (this.editor.tool !== 'select' && this.editor.tool !== 'note') this.editor.setTool('select');
          this.viewer.scrollToPage(page.id, false);
          this.editor.select({ pageId: page.id, id: a.id });
        });
        items.push(item);
      }
    });

    this.root.replaceChildren(
      h('label', { class: 'side-field' }, h('span', { class: 'field-label' }, 'Your name on comments'), name),
      items.length
        ? h('div', { class: 'comment-list' }, ...items)
        : h('div', { class: 'side-empty' }, icon('message-square'),
            h('p', {}, 'No comments yet. Pick the Comment tool (N) and click on a page to add one.')),
    );
  }
}
