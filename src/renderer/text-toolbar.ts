// SPDX-License-Identifier: GPL-3.0-or-later
// The little bar that floats above a text box while you type in it or have
// it selected: font, size, bold/italic/underline, colours, alignment,
// opacity and delete. Everything goes through editor.applyStyle, so it stays
// in step with the properties panel.

import { allFamilies, Family, getFamily, loadFace, onFontsChanged, pickFace, systemFamilies } from './custom-fonts';
import type { EditorDoc } from './document';
import type { Editor } from './editor';
import { cssFamily } from './fonts';
import { annotBounds } from './geometry';
import { INK_COLORS } from './styles';
import type { FontFamily, ReplaceAnnot, TextAlign, TextAnnot } from './types';
import { h, icon, toast } from './ui';
import type { Viewer } from './viewer';

type TextLike = TextAnnot | ReplaceAnnot;
type Patch = Partial<Pick<TextLike, 'font' | 'family' | 'size' | 'bold' | 'italic' | 'underline' | 'color' | 'background' | 'align' | 'opacity'>>;

const STANDARD: { font: FontFamily; name: string }[] = [
  { font: 'sans', name: 'Sans serif' },
  { font: 'serif', name: 'Serif' },
  { font: 'mono', name: 'Monospace' },
];

const BACKGROUNDS = ['#ffffff', '#fff3a3', '#d9f2e4', '#dbeafe', '#fde2e7', '#1a1a1a'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72];
const GAP = 8;

/** Rough standard-font fallback for an installed family, by its name. */
function guessStandard(name: string): FontFamily {
  if (/mono|courier|consol|menlo|code/i.test(name)) return 'mono';
  if (/serif|times|georgia|garamond|cambria|book|roman/i.test(name) && !/sans/i.test(name)) return 'serif';
  return 'sans';
}

export class TextToolbar {
  private el: HTMLDivElement;
  private pop: HTMLElement | null = null;
  private signature = '';
  private frame = 0;

  constructor(private editor: Editor, private viewer: Viewer, private getDoc: () => EditorDoc | null) {
    this.el = h('div', { class: 'text-toolbar', role: 'toolbar', 'aria-label': 'Text formatting', hidden: true });
    document.body.append(this.el);

    // Buttons shouldn't steal the caret from the text box; fields need it.
    this.el.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('input, select')) e.preventDefault();
    });
    // If focus leaves both the bar and the text box, typing is over.
    this.el.addEventListener('focusout', () => setTimeout(() => {
      const focused = document.activeElement;
      if (this.editor.text.active && !focused?.closest('.text-toolbar, .text-editor')) this.editor.text.finish();
    }, 0));
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // tool shortcuts shouldn't fire while using the bar
      if (e.key === 'Escape') {
        if (this.pop) this.closePop();
        this.editor.text.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.pop && !(e.target as HTMLElement).closest('.text-toolbar')) this.closePop();
    }, true);

    for (const event of ['toolchange', 'selectionchange', 'stylechange']) {
      editor.addEventListener(event, () => this.update());
    }
    onFontsChanged(() => {
      this.signature = '';
      this.update();
    });
  }

  private target(): { pageId: string; annot: TextLike } | null {
    const active = this.editor.activeAnnot();
    if (!active || (active.annot.type !== 'text' && active.annot.type !== 'replace')) return null;
    return active as { pageId: string; annot: TextLike };
  }

  /** Shows, hides or refreshes the bar, then keeps it glued to the box. */
  update() {
    const target = this.target();
    if (!target) {
      this.hide();
      return;
    }
    const a = target.annot;
    const signature = JSON.stringify([a.id, a.font, a.family, a.size, a.bold, a.italic, a.underline, a.color, a.background, a.align, a.opacity, a.type]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.render(a);
    }
    this.el.hidden = false;
    if (!this.frame) this.follow();
  }

  private hide() {
    this.el.hidden = true;
    this.closePop();
    this.signature = '';
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** Repositions every frame while visible: cheap, and catches scrolls, zooms and drags. */
  private follow = () => {
    this.frame = 0;
    const target = this.target();
    if (!target) {
      this.hide();
      return;
    }
    const a = target.annot;
    const signature = JSON.stringify([a.id, a.font, a.family, a.size, a.bold, a.italic, a.underline, a.color, a.background, a.align, a.opacity, a.type]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.render(a);
    }
    this.place(target.pageId, a);
    this.frame = requestAnimationFrame(this.follow);
  };

  private place(pageId: string, a: TextLike) {
    const view = this.viewer.views.get(pageId);
    if (!view?.viewport) {
      this.el.style.visibility = 'hidden';
      return;
    }
    const b = annotBounds(a);
    const page = view.overlay.getBoundingClientRect();
    const corners = [
      this.viewer.toLocal(view, b.x, b.y), this.viewer.toLocal(view, b.x + b.w, b.y),
      this.viewer.toLocal(view, b.x, b.y + b.h), this.viewer.toLocal(view, b.x + b.w, b.y + b.h),
    ];
    const left = page.left + Math.min(...corners.map((c) => c[0]));
    const right = page.left + Math.max(...corners.map((c) => c[0]));
    const top = page.top + Math.min(...corners.map((c) => c[1]));
    const bottom = page.top + Math.max(...corners.map((c) => c[1]));

    const area = this.viewer.container.getBoundingClientRect();
    const offscreen = bottom < area.top || top > area.bottom || right < area.left || left > area.right;
    this.el.style.visibility = offscreen ? 'hidden' : 'visible';
    if (offscreen) return;

    const w = this.el.offsetWidth, hgt = this.el.offsetHeight;
    // above the box if there's room, otherwise below it
    let y = top - hgt - GAP;
    if (y < area.top + 4) y = bottom + GAP;
    y = Math.min(Math.max(y, area.top + 4), area.bottom - hgt - 4);
    let x = left;
    x = Math.min(Math.max(x, area.left + 8), area.right - w - 8);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private apply(patch: Patch, options: { remember?: boolean; focus?: boolean } = {}) {
    this.editor.applyStyle('text', patch, options);
  }

  // --- building the bar ----------------------------------------------------------

  private render(a: TextLike) {
    this.closePop();
    const family = getFamily(a.family);
    const fontLabel = family?.name ?? STANDARD.find((s) => s.font === a.font)!.name;

    const font = h('button', { class: 'tt-font', title: 'Font', 'aria-haspopup': 'listbox' },
      h('span', { class: 'tt-font-name', style: `font-family: ${family ? `"${family.css}", ` : ''}${cssFamily(a.font)}` }, fontLabel),
      icon('chevron-down'));
    font.addEventListener('click', () => this.togglePop(font, () => this.fontMenu(a)));

    const size = h('input', { class: 'tt-size', type: 'number', min: '4', max: '200', step: '0.5', value: String(a.size), title: 'Font size', list: 'tt-sizes' });
    const sizes = h('datalist', { id: 'tt-sizes' }, ...SIZES.map((s) => new Option(String(s))));
    const setSize = () => {
      const n = Math.max(4, Math.min(200, Math.round((Number(size.value) || a.size) * 2) / 2));
      size.value = String(n);
      if (n !== a.size) this.apply({ size: n });
    };
    size.addEventListener('change', setSize);
    size.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setSize();
        this.editor.text.focus();
      }
    });

    const mac = /Mac/.test(navigator.platform);
    const toggle = (name: 'bold' | 'italic' | 'underline', title: string, key: string) => {
      const b = h('button', { class: 'tt-btn', title: mac ? title : `${title} (${key})`, 'aria-pressed': String(!!a[name]) }, icon(name));
      b.addEventListener('click', () => this.apply({ [name]: !a[name] }));
      return b;
    };

    const colour = h('button', { class: 'tt-btn tt-colour', title: 'Text colour' }, icon('baseline'),
      h('span', { class: 'tt-bar', style: `background: ${a.color}` }));
    colour.addEventListener('click', () => this.togglePop(colour, () => this.swatchPop(INK_COLORS, a.color, false, (color) => this.apply({ color: color! }))));

    const background = h('button', { class: 'tt-btn tt-colour', title: 'Background colour' }, icon('paint-bucket'),
      h('span', { class: `tt-bar${a.background ? '' : ' none'}`, style: a.background ? `background: ${a.background}` : '' }));
    background.addEventListener('click', () => this.togglePop(background, () =>
      this.swatchPop(BACKGROUNDS, a.background ?? null, true, (bg) => this.apply({ background: bg }))));

    const align = h('div', { class: 'tt-seg', role: 'group', 'aria-label': 'Alignment' },
      ...(['left', 'center', 'right'] as TextAlign[]).map((value) => {
        const b = h('button', { class: 'tt-btn', title: `Align ${value}`, 'aria-pressed': String((a.align ?? 'left') === value) }, icon(`align-${value}`));
        b.addEventListener('click', () => this.apply({ align: value }));
        return b;
      }));

    const opacity = h('button', { class: 'tt-btn tt-opacity', title: 'Opacity' }, `${Math.round((a.opacity ?? 1) * 100)}%`);
    opacity.addEventListener('click', () => this.togglePop(opacity, () => this.opacityPop(a.opacity ?? 1)));

    const remove = h('button', { class: 'tt-btn danger', title: a.type === 'replace' ? 'Undo this edit (puts the original text back)' : 'Delete text box' }, icon('trash-2'));
    remove.addEventListener('click', () => this.remove(a));

    const sep = () => h('span', { class: 'tt-sep' });
    this.el.replaceChildren(font, size, sizes, sep(),
      toggle('bold', 'Bold', 'Ctrl+B'), toggle('italic', 'Italic', 'Ctrl+I'), toggle('underline', 'Underline', 'Ctrl+U'), sep(),
      colour, background, sep(), align, sep(), opacity, remove);
  }

  private remove(a: TextLike) {
    const found = this.getDoc()?.findAnnot(a.id);
    if (!found) return;
    if (this.editor.text.active) this.editor.text.finish();
    // finishing may already have dropped an empty box
    if (!this.getDoc()?.findAnnot(a.id)) return;
    this.editor.select({ pageId: found.pageId, id: a.id });
    this.editor.deleteSelected();
  }

  // --- popovers ---------------------------------------------------------------------

  private togglePop(anchor: HTMLElement, build: () => HTMLElement) {
    const wasFor = this.pop?.dataset.anchor;
    this.closePop();
    const id = anchor.title;
    if (wasFor === id) return;
    const pop = build();
    pop.dataset.anchor = id;
    pop.classList.add('tt-pop');
    this.el.append(pop);
    // line it up under its button, but keep it on screen
    const bar = this.el.getBoundingClientRect(), btn = anchor.getBoundingClientRect();
    const room = window.innerHeight - bar.bottom;
    pop.style.left = `${Math.max(0, Math.min(btn.left - bar.left, window.innerWidth - bar.left - pop.offsetWidth - 8))}px`;
    if (room < pop.offsetHeight + 12) pop.classList.add('above');
    this.pop = pop;
    pop.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }

  private closePop() {
    const pop = this.pop;
    this.pop = null;
    if (!pop) return;
    // hand the caret back before the focused search box disappears, or
    // losing focus would end the typing
    const hadFocus = pop.contains(document.activeElement);
    if (hadFocus) this.editor.text.focus();
    pop.remove();
  }

  private swatchPop(colours: string[], current: string | null, allowNone: boolean, pick: (c: string | null) => void) {
    const done = (c: string | null) => {
      pick(c);
      this.closePop();
    };
    const grid = h('div', { class: 'tt-swatches' });
    if (allowNone) {
      const none = h('button', { class: 'tt-swatch none', title: 'No background', 'aria-pressed': String(!current) });
      none.addEventListener('click', () => done(null));
      grid.append(none);
    }
    for (const c of colours) {
      const b = h('button', { class: 'tt-swatch', title: c, style: `background: ${c}`, 'aria-pressed': String(current?.toLowerCase() === c) });
      b.addEventListener('click', () => done(c));
      grid.append(b);
    }
    const custom = h('input', { type: 'color', class: 'tt-swatch custom', title: 'Custom colour', value: current?.startsWith('#') ? current : '#000000' });
    custom.addEventListener('input', () => pick(custom.value));
    custom.addEventListener('change', () => this.editor.text.focus());
    grid.append(custom);
    return h('div', {}, grid);
  }

  private opacityPop(current: number) {
    const value = h('span', { class: 'tt-range-value' }, `${Math.round(current * 100)}%`);
    const range = h('input', { type: 'range', min: '10', max: '100', step: '5', value: String(Math.round(current * 100)), 'aria-label': 'Opacity' });
    range.addEventListener('input', () => {
      value.textContent = `${range.value}%`;
      this.apply({ opacity: Number(range.value) / 100 }, { focus: false });
    });
    range.addEventListener('change', () => this.editor.text.focus());
    return h('div', { class: 'tt-range' }, range, value);
  }

  private fontMenu(a: TextLike) {
    const search = h('input', { type: 'search', class: 'tt-search', placeholder: 'Search fonts', 'aria-label': 'Search fonts' });
    const list = h('div', { class: 'tt-font-list', role: 'listbox' });
    const menu = h('div', { class: 'font-menu' }, h('div', { class: 'tt-search-wrap' }, icon('search'), search), list);

    const doc = this.getDoc();
    const ids = doc ? [...doc.sources.keys()] : [];
    const inDocument = allFamilies().filter((f) => f.source === 'document' && ids.some((id) => f.key.startsWith(`doc:${id}:`)));
    let installed: Family[] | null = null;
    let failed = false;

    const choose = async (patch: Patch, family?: Family) => {
      this.closePop();
      this.apply(patch, { remember: family?.source !== 'document' });
      if (!family) return;
      const face = await loadFace(family, pickFace(family, a.bold, a.italic));
      if (!face) {
        const why = pickFace(family, a.bold, a.italic).unusable ?? 'That font couldn’t be used.';
        toast(`${why} Using ${STANDARD.find((s) => s.font === patch.font)?.name.toLowerCase() ?? 'a standard font'} instead.`, 'error');
        this.apply({ family: undefined });
      }
    };

    const item = (label: string, css: string, selected: boolean, onPick: () => void, note?: string) => {
      const b = h('button', { class: 'tt-font-item', role: 'option', 'aria-selected': String(selected) },
        h('span', { style: `font-family: ${css}` }, label), note ? h('small', {}, note) : null, selected ? icon('check') : null);
      b.addEventListener('click', onPick);
      return b;
    };

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const match = (name: string) => !q || name.toLowerCase().includes(q);
      const groups: HTMLElement[] = [];
      const group = (title: string, items: HTMLElement[]) => {
        if (items.length) groups.push(h('div', { class: 'tt-font-group' }, title), ...items);
      };

      group('In this document', inDocument.filter((f) => match(f.name)).map((f) =>
        item(f.name, `"${f.css}", ${cssFamily(a.font)}`, a.family === f.key, () => choose({ family: f.key }, f), 'original')));
      group('Standard', STANDARD.filter((s) => match(s.name)).map((s) =>
        item(s.name, cssFamily(s.font), !a.family && a.font === s.font, () => choose({ font: s.font, family: undefined }))));

      if (installed) {
        const found = installed.filter((f) => match(f.name));
        // a few hundred buttons is plenty; searching narrows the rest
        group('On this computer', found.slice(0, 300).map((f) =>
          item(f.name, `"${f.name.replace(/"/g, '')}", ${cssFamily(guessStandard(f.name))}`, a.family === f.key,
            () => choose({ family: f.key, font: guessStandard(f.name) }, f))));
        if (!found.length && q) groups.push(h('div', { class: 'tt-font-note' }, 'No installed fonts match.'));
      } else {
        groups.push(h('div', { class: 'tt-font-group' }, 'On this computer'),
          h('div', { class: 'tt-font-note' }, failed ? 'Installed fonts couldn’t be listed.' : 'Loading installed fonts…'));
      }
      list.replaceChildren(...groups);
    };

    search.addEventListener('input', draw);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        list.querySelector<HTMLButtonElement>('.tt-font-item')?.click();
      }
    });
    systemFamilies().then((fams) => {
      installed = fams;
      failed = !fams.length;
      if (failed) installed = null;
      if (menu.isConnected) draw();
    });
    draw();
    return menu;
  }
}
