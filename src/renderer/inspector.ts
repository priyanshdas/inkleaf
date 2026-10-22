// SPDX-License-Identifier: GPL-3.0-or-later
import { getFamily } from './custom-fonts';
import type { EditorDoc } from './document';
import { Editor, styleGroupFor } from './editor';
import { HIGHLIGHT_COLORS, INK_COLORS, NOTE_COLORS, STAMP_COLORS, STAMPS, ToolStyles } from './styles';
import type { Annot, FieldAnnot, FieldKind, FontFamily, Tool } from './types';
import { h, icon } from './ui';

// The properties panel on the right. It describes whatever you're about to
// do (the current tool) or have selected, and shows the document when
// there's nothing more specific to say.

interface ToolInfo {
  title: string;
  icon: string;
  hint: string;
}

const TOOLS: Record<Tool, ToolInfo> = {
  select: { title: 'Select', icon: 'mouse-pointer-2', hint: 'Click a mark to select it. Double-click text to edit it.' },
  hand: { title: 'Pan', icon: 'hand', hint: 'Drag to move around. You can also hold Space with any tool.' },
  'edit-text': { title: 'Edit text', icon: 'text-cursor-input', hint: 'Click a line of text in the PDF to change it. The old words are removed from the file when you save.' },
  text: { title: 'Add text', icon: 'type', hint: 'Click anywhere on a page to start typing.' },
  pen: { title: 'Draw', icon: 'pen-line', hint: 'Draw freehand on the page.' },
  highlight: { title: 'Highlight', icon: 'highlighter', hint: 'Drag across text to highlight it.' },
  rect: { title: 'Shapes', icon: 'shapes', hint: 'Drag to draw. Hold Shift for a perfect square or circle.' },
  ellipse: { title: 'Shapes', icon: 'shapes', hint: 'Drag to draw. Hold Shift for a perfect square or circle.' },
  line: { title: 'Shapes', icon: 'shapes', hint: 'Drag to draw. Hold Shift to snap to 45°.' },
  arrow: { title: 'Shapes', icon: 'shapes', hint: 'Drag to draw. Hold Shift to snap to 45°.' },
  whiteout: { title: 'White-out', icon: 'rectangle-horizontal', hint: 'Covers what’s underneath. To remove text from the file for good, use Redact.' },
  redact: { title: 'Redact', icon: 'eye-off', hint: 'Drag over sensitive text. It’s permanently removed from the file when you save.' },
  eraser: { title: 'Erase', icon: 'eraser', hint: 'Click or drag across marks to remove them.' },
  sign: { title: 'Sign', icon: 'signature', hint: 'Click on the page to place your signature. Press Esc to cancel.' },
  image: { title: 'Image', icon: 'image', hint: 'Click on the page to place the image. Press Esc to cancel.' },
  note: { title: 'Comment', icon: 'message-square', hint: 'Click on the page to add a sticky note. Saved as a standard PDF comment that any reader can open.' },
  stamp: { title: 'Stamp', icon: 'stamp', hint: 'Pick a stamp, then click on the page to place it.' },
  field: { title: 'Form field', icon: 'text-cursor', hint: 'Drag a box on the page (or just click) to add a fillable field.' },
  crop: { title: 'Crop', icon: 'crop', hint: 'Drag around the part of the page to keep. You’ll be asked whether to crop just this page or all of them.' },
};

const ANNOT_NAMES: Record<Annot['type'], string> = {
  ink: 'Drawing', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse',
  highlight: 'Highlight', whiteout: 'White-out', redact: 'Redaction', text: 'Text',
  replace: 'Edited text', image: 'Image', note: 'Comment', stamp: 'Stamp', field: 'Form field',
};

const FIELD_KINDS: { label: string; value: FieldKind }[] = [
  { label: 'Text', value: 'text' }, { label: 'Paragraph', value: 'multiline' },
  { label: 'Checkbox', value: 'checkbox' }, { label: 'Dropdown', value: 'dropdown' },
];

const SHAPES: { tool: Tool; label: string; icon: string }[] = [
  { tool: 'rect', label: 'Rectangle', icon: 'square' },
  { tool: 'ellipse', label: 'Ellipse', icon: 'circle' },
  { tool: 'line', label: 'Line', icon: 'minus' },
  { tool: 'arrow', label: 'Arrow', icon: 'move-up-right' },
];

const WIDTHS = [0.5, 1, 2, 4, 8];

function groupForTool(tool: Tool): keyof ToolStyles | null {
  switch (tool) {
    case 'pen': return 'pen';
    case 'highlight': return 'highlight';
    case 'rect':
    case 'ellipse': return 'shape';
    case 'line':
    case 'arrow': return 'line';
    case 'text':
    case 'edit-text': return 'text';
    case 'whiteout': return 'whiteout';
    case 'redact': return 'redact';
    case 'note': return 'note';
    case 'stamp': return 'stamp';
    case 'field': return 'field';
    default: return null;
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class Inspector {
  constructor(
    private root: HTMLElement,
    private editor: Editor,
    private getDoc: () => EditorDoc | null,
    private run: (command: string) => void,
  ) {
    for (const event of ['toolchange', 'selectionchange', 'stylechange']) {
      editor.addEventListener(event, () => this.render());
    }
    // keep focus on the text being edited when clicking our buttons
    root.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (this.editor.text.active && target.closest('button') && !target.closest('select, input')) e.preventDefault();
    });
    this.render();
  }

  render() {
    const editor = this.editor;
    const doc = this.getDoc();
    if (!doc) {
      this.root.replaceChildren();
      return;
    }
    const active = editor.activeAnnot();
    const tool = editor.tool;
    const parts: (HTMLElement | null)[] = [];

    if (active) {
      parts.push(this.header(active.annot.type === 'image' ? 'image' : TOOLS[toolFor(active.annot.type)].icon,
        editor.text.active ? `Editing ${ANNOT_NAMES[active.annot.type].toLowerCase()}` : ANNOT_NAMES[active.annot.type],
        editor.text.active ? 'Press Esc or click outside when you’re done.' : null));
    } else {
      const info = TOOLS[tool];
      parts.push(this.header(info.icon, info.title, info.hint));
    }

    if (!active && (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow')) {
      parts.push(this.section('Shape', this.shapePicker(tool)));
    }

    const group = active ? styleGroupFor(active.annot.type) : groupForTool(tool);
    if (group && active?.annot.type !== 'image') {
      const values = active ? { ...editor.styles[group], ...(active.annot as object) } : editor.styles[group];
      parts.push(...this.controls(group, values as Record<string, unknown>));
    }

    if (active?.annot.type === 'field') parts.push(...this.fieldProperties(active.pageId, active.annot));
    if (!active && tool === 'crop') parts.push(this.section('Crop', h('div', { class: 'insp-actions' },
      this.actionButton('maximize-2', 'Remove crop from this page', () => this.run('uncrop-page')),
      this.actionButton('files', 'Remove crop from all pages', () => this.run('uncrop-all')),
    )));
    if (active && !editor.text.active) parts.push(this.section('Actions', this.actions(active.annot)));
    if (!active && (tool === 'select' || tool === 'hand')) parts.push(...this.documentPanel(doc));

    this.root.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  }

  // --- building blocks --------------------------------------------------------

  private header(iconName: string, title: string, hint: string | null) {
    return h('header', { class: 'insp-head' },
      h('div', { class: 'insp-title' }, h('span', { class: 'insp-icon' }, icon(iconName)), h('h2', {}, title)),
      hint ? h('p', { class: 'insp-hint' }, hint) : null,
    );
  }

  private section(label: string, ...content: (HTMLElement | null)[]) {
    return h('section', { class: 'insp-section' },
      h('h3', {}, label),
      ...content,
    );
  }

  private apply<K extends keyof ToolStyles>(group: K, patch: Partial<ToolStyles[K]>) {
    this.editor.applyStyle(group, patch);
  }

  private swatches(colors: string[], current: string, onPick: (c: string) => void, allowCustom = true) {
    const row = h('div', { class: 'swatch-grid' });
    for (const color of colors) {
      const b = h('button', {
        class: 'swatch',
        style: `--swatch:${color}`,
        title: color,
        'aria-label': `Colour ${color}`,
        'aria-pressed': String(color.toLowerCase() === current?.toLowerCase()),
      });
      b.addEventListener('click', () => onPick(color));
      row.append(b);
    }
    if (allowCustom) {
      const custom = h('input', { type: 'color', class: 'swatch swatch-custom', value: current?.startsWith('#') ? current : '#000000', title: 'Custom colour' });
      custom.addEventListener('change', () => onPick(custom.value));
      row.append(custom);
    }
    return row;
  }

  /** Segmented buttons that show each thickness as a line. */
  private widths(current: number, onPick: (w: number) => void) {
    const row = h('div', { class: 'segmented' });
    for (const w of WIDTHS) {
      const b = h('button', { class: 'seg', title: `${w} pt`, 'aria-pressed': String(Math.abs(w - current) < 0.01) },
        h('span', { class: 'width-line', style: `height:${Math.max(1, Math.min(w, 8))}px;opacity:${w < 1 ? 0.5 : 1}` }));
      b.addEventListener('click', () => onPick(w));
      row.append(b);
    }
    return row;
  }

  private segmented<T extends string | number>(options: { label: string; value: T; icon?: string }[], current: T, onPick: (v: T) => void) {
    const row = h('div', { class: 'segmented' });
    for (const o of options) {
      const b = h('button', { class: 'seg', title: o.label, 'aria-pressed': String(o.value === current) },
        o.icon ? icon(o.icon) : o.label);
      b.addEventListener('click', () => onPick(o.value));
      row.append(b);
    }
    return row;
  }

  private shapePicker(tool: Tool) {
    return this.segmented(SHAPES.map((s) => ({ label: s.label, value: s.tool, icon: s.icon })), tool, (t) => this.editor.setTool(t));
  }

  private controls(group: keyof ToolStyles, v: Record<string, unknown>): HTMLElement[] {
    switch (group) {
      case 'pen':
        return [
          this.section('Colour', this.swatches(INK_COLORS, v.color as string, (color) => this.apply('pen', { color }))),
          this.section('Thickness', this.widths(v.width as number, (width) => this.apply('pen', { width }))),
          this.section('Opacity', this.segmented(
            [{ label: '25%', value: 0.25 }, { label: '50%', value: 0.5 }, { label: '75%', value: 0.75 }, { label: '100%', value: 1 }],
            v.opacity as number, (opacity) => this.apply('pen', { opacity }))),
        ];
      case 'highlight':
        return [this.section('Colour', this.swatches(HIGHLIGHT_COLORS, v.color as string, (color) => this.apply('highlight', { color })))];
      case 'shape': {
        const fill = v.fill === null || v.fill === undefined ? 'none' : v.fill === '#ffffff' ? 'white' : 'tint';
        return [
          this.section('Outline', this.swatches(INK_COLORS.slice(0, 7), v.color as string, (color) =>
            this.apply('shape', { color, ...(fill === 'tint' ? { fill: tint(color) } : {}) }))),
          this.section('Thickness', this.widths(v.width as number, (width) => this.apply('shape', { width }))),
          this.section('Fill', this.segmented(
            [{ label: 'None', value: 'none' }, { label: 'White', value: 'white' }, { label: 'Tint', value: 'tint' }],
            fill, (f) => this.apply('shape', { fill: f === 'none' ? null : f === 'white' ? '#ffffff' : tint(v.color as string) }))),
        ];
      }
      case 'line':
        return [
          this.section('Colour', this.swatches(INK_COLORS.slice(0, 7), v.color as string, (color) => this.apply('line', { color }))),
          this.section('Thickness', this.widths(v.width as number, (width) => this.apply('line', { width }))),
        ];
      case 'text':
        return this.textControls(v);
      case 'whiteout':
        return [this.section('Colour', this.swatches(['#ffffff', '#f8f8f4', '#000000'], v.color as string, (color) => this.apply('whiteout', { color })))];
      case 'redact':
        return [this.section('Box colour', this.swatches(['#000000', '#ffffff'], v.color as string, (color) => this.apply('redact', { color }), false))];
      case 'note':
        return [this.section('Colour', this.swatches(NOTE_COLORS, v.color as string, (color) => this.apply('note', { color }), false))];
      case 'stamp':
        return this.stampControls(v);
      case 'field':
        {
        const kinds = this.segmented(FIELD_KINDS, v.kind as FieldKind, (kind) => this.apply('field', { kind }));
        kinds.classList.add('two-rows');
        return [this.section('Field type', kinds)];
      }
    }
  }

  private stampControls(v: Record<string, unknown>): HTMLElement[] {
    const label = String(v.label ?? '');
    const chips = h('div', { class: 'chips stamp-chips' }, ...STAMPS.map((s) => {
      const b = h('button', { class: 'chip', 'aria-pressed': String(s === label) }, s);
      b.addEventListener('click', () => this.apply('stamp', { label: s }));
      return b;
    }));
    const custom = h('input', { class: 'field-input', placeholder: 'Your own words', value: STAMPS.includes(label) ? '' : label, maxlength: '40' });
    custom.addEventListener('change', () => {
      const text = custom.value.trim().toUpperCase();
      if (text) this.apply('stamp', { label: text });
    });
    const dated = h('input', { type: 'checkbox', checked: !!v.date });
    dated.addEventListener('change', () => this.apply('stamp', { date: dated.checked }));
    return [
      this.section('Stamp', chips, custom),
      this.section('Colour', this.swatches(STAMP_COLORS, v.color as string, (color) => this.apply('stamp', { color }), false)),
      this.section('Date', h('label', { class: 'check' }, dated, ' Add today’s date')),
    ];
  }

  /** Name, choices and "required" for a form field being designed. */
  private fieldProperties(pageId: string, f: FieldAnnot): HTMLElement[] {
    const doc = this.getDoc();
    const update = (patch: Partial<FieldAnnot>) => {
      const current = doc?.annots(pageId).find((a) => a.id === f.id);
      if (!doc || current?.type !== 'field') return;
      doc.updateAnnot(pageId, { ...current, ...patch });
      doc.commit();
    };
    const name = h('input', { class: 'field-input', value: f.name, maxlength: '60', 'aria-label': 'Field name' });
    name.addEventListener('change', () => update({ name: name.value.trim() || f.name }));
    const required = h('input', { type: 'checkbox', checked: f.required });
    required.addEventListener('change', () => update({ required: required.checked }));
    const parts = [
      this.section('Name', name, h('p', { class: 'insp-note' }, 'Shown to people filling the form, and used when the answers are collected.')),
      this.section('Rules', h('label', { class: 'check' }, required, ' Must be filled in')),
    ];
    if (f.kind === 'dropdown') {
      const options = h('textarea', { class: 'field-input', rows: '4', 'aria-label': 'Choices, one per line' });
      options.value = f.options.join('\n');
      options.addEventListener('change', () => update({ options: options.value.split('\n').map((o) => o.trim()).filter(Boolean) }));
      parts.splice(1, 0, this.section('Choices', options, h('p', { class: 'insp-note' }, 'One per line.')));
    }
    return parts;
  }

  private textControls(v: Record<string, unknown>): HTMLElement[] {
    const font = h('select', { class: 'field-select', title: 'Font' },
      new Option('Sans serif', 'sans'), new Option('Serif', 'serif'), new Option('Monospace', 'mono'));
    // a document or installed font shows up as its own entry at the top
    const custom = getFamily(v.family as string | undefined);
    if (custom) font.prepend(new Option(custom.source === 'document' ? `${custom.name} (original)` : custom.name, 'custom'));
    font.value = custom ? 'custom' : v.font as string;
    font.addEventListener('change', () => {
      if (font.value !== 'custom') this.apply('text', { font: font.value as FontFamily, family: undefined });
    });

    const size = h('input', { class: 'number', type: 'number', min: '4', max: '200', step: '0.5', value: String(v.size), title: 'Font size' });
    const setSize = (n: number) => {
      const clamped = Math.max(4, Math.min(200, Math.round(n * 2) / 2));
      size.value = String(clamped);
      this.apply('text', { size: clamped });
    };
    size.addEventListener('change', () => setSize(Number(size.value) || 12));
    const smaller = h('button', { class: 'step', title: 'Smaller' }, icon('minus'));
    smaller.addEventListener('click', () => setSize(Number(size.value) - 1));
    const larger = h('button', { class: 'step', title: 'Larger' }, icon('plus'));
    larger.addEventListener('click', () => setSize(Number(size.value) + 1));

    const toggle = (name: 'bold' | 'italic' | 'underline', title: string) => {
      const b = h('button', { class: 'seg', title, 'aria-pressed': String(!!v[name]) }, icon(name));
      b.addEventListener('click', () => this.apply('text', { [name]: !v[name] } as Partial<ToolStyles['text']>));
      return b;
    };

    return [
      this.section('Font', font, h('div', { class: 'insp-row' },
        h('div', { class: 'stepper' }, smaller, size, larger),
        h('div', { class: 'segmented compact' }, toggle('bold', 'Bold'), toggle('italic', 'Italic'), toggle('underline', 'Underline')))),
      this.section('Colour', this.swatches(INK_COLORS, v.color as string, (color) => this.apply('text', { color }))),
    ];
  }

  private actionButton(iconName: string, label: string, fn: () => void, options: { danger?: boolean; hint?: string } = {}) {
    const b = h('button', { class: `insp-action${options.danger ? ' danger' : ''}` },
      icon(iconName),
      h('span', {}, label),
      options.hint ? h('kbd', {}, options.hint) : null,
    );
    b.addEventListener('click', fn);
    return b;
  }

  private actions(a: Annot) {
    const editor = this.editor;
    const doc = this.getDoc();
    const list = h('div', { class: 'insp-actions' });
    if (a.type === 'text' || a.type === 'replace') {
      list.append(this.actionButton('pencil', 'Edit text', () => editor.editSelectedText(), { hint: 'Dbl-click' }));
    }
    if (a.type === 'image') {
      list.append(this.actionButton('rotate-cw', 'Rotate 90°', () => {
        if (!doc || !editor.selection) return;
        // turn clockwise on screen, keeping the image centred in place
        const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
        doc.updateAnnot(editor.selection.pageId, { ...a, angle: (a.angle + 270) % 360, x: cx - a.h / 2, y: cy - a.w / 2, w: a.h, h: a.w });
        doc.commit();
      }));
    }
    list.append(
      this.actionButton('layers', 'Bring to front', () => {
        if (!doc || !editor.selection) return;
        doc.bringToFront(editor.selection.pageId, a.id);
        doc.commit();
      }),
      this.actionButton('copy', 'Duplicate', () => editor.duplicateSelected(), { hint: 'Ctrl+D' }),
      this.actionButton('trash-2', 'Delete', () => editor.deleteSelected(), { danger: true, hint: 'Del' }),
    );
    return list;
  }

  private documentPanel(doc: EditorDoc): HTMLElement[] {
    const main = doc.sources.get(doc.mainSource);
    const facts: [string, string][] = [
      ['Pages', String(doc.pages.length)],
      ['Size', main ? formatBytes(main.bytes.length) : '—'],
      ['Location', doc.path ?? 'Not saved yet'],
    ];
    if (doc.wasProtected) facts.push(['Protection', 'Was protected; saves unlocked']);
    if (doc.dirty) facts.push(['Changes', 'Not saved']);

    return [
      this.section('Document',
        h('p', { class: 'doc-name', title: doc.name }, doc.name),
        h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { title: v }, v)])),
      ),
      this.section('Pages', h('div', { class: 'insp-actions' },
        this.actionButton('rotate-cw', 'Rotate current page', () => this.run('rotate-right')),
        this.actionButton('file-plus-2', 'Insert blank page', () => this.run('insert-blank')),
        this.actionButton('file-plus', 'Merge another PDF', () => this.run('insert-pdf')),
        this.actionButton('file-output', 'Extract pages', () => this.run('extract')),
        this.actionButton('scissors', 'Split document', () => this.run('split')),
      )),
    ];
  }
}

function toolFor(type: Annot['type']): Tool {
  switch (type) {
    case 'ink': return 'pen';
    case 'replace': return 'edit-text';
    case 'text': return 'text';
    case 'highlight': return 'highlight';
    case 'whiteout': return 'whiteout';
    case 'redact': return 'redact';
    case 'image': return 'image';
    case 'line': return 'line';
    case 'arrow': return 'arrow';
    case 'ellipse': return 'ellipse';
    case 'note': return 'note';
    case 'stamp': return 'stamp';
    case 'field': return 'field';
    default: return 'rect';
  }
}

/** A pale version of a colour, for shape fills. */
function tint(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.82);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
