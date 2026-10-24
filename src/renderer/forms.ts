// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../shared/i18n';
import type { EditorDoc } from './document';
import type { FormValue } from './types';
import type { PageView, Viewer } from './viewer';

// The subset of pdf.js's widget annotation data we use.
interface Widget {
  id: string;
  subtype: string;
  fieldType?: 'Tx' | 'Btn' | 'Ch' | 'Sig';
  fieldName?: string;
  fieldValue?: string | string[] | null;
  rect: [number, number, number, number];
  readOnly?: boolean;
  hidden?: boolean;
  multiLine?: boolean;
  password?: boolean;
  maxLen?: number;
  comb?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
  combo?: boolean;
  multiSelect?: boolean;
  textAlignment?: number;
  defaultAppearanceData?: { fontSize?: number };
}

export interface SignFieldRequest {
  pageId: string;
  rect: { x: number; y: number; w: number; h: number };
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;

/**
 * Draws the PDF's own form fields as real HTML inputs over the page. Typing
 * into them updates the document's form values, which are written back into
 * the AcroForm when you save.
 */
export class FormLayer extends EventTarget {
  private widgets = new WeakMap<object, Promise<Widget[]>>();
  private elements = new Map<string, { widget: Widget; el: FieldElement; pageId: string }[]>();
  private built = new WeakSet<PageView>();

  constructor(private viewer: Viewer, private getDoc: () => EditorDoc | null) {
    super();
  }

  reset() {
    this.elements.clear();
    this.built = new WeakSet();
  }

  /** True if any page of the main file has fillable fields. */
  async hasFields(): Promise<boolean> {
    const doc = this.getDoc();
    if (!doc) return false;
    const pdf = doc.sources.get(doc.mainSource)!.pdf;
    try {
      const fields = await pdf.getFieldObjects();
      return !!fields && Object.keys(fields).length > 0;
    } catch {
      return false;
    }
  }

  private widgetsFor(view: PageView): Promise<Widget[]> {
    const page = view.pdfPage!;
    let pending = this.widgets.get(page);
    if (!pending) {
      pending = page.getAnnotations({ intent: 'display' }).then((annots) =>
        (annots as Widget[]).filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton),
      );
      this.widgets.set(page, pending);
    }
    return pending;
  }

  /** Called by the viewer each time a page renders (zoom changes size). */
  async layout(view: PageView) {
    const doc = this.getDoc();
    if (!doc || view.ref.src !== doc.mainSource || !view.pdfPage || !view.viewport) {
      view.forms.replaceChildren();
      return;
    }
    const widgets = await this.widgetsFor(view);
    if (!this.built.has(view)) {
      this.built.add(view);
      view.forms.replaceChildren();
      for (const w of widgets) {
        const el = this.build(w, view);
        if (!el) continue;
        view.forms.append(el);
        const list = this.elements.get(w.fieldName!) ?? [];
        list.push({ widget: w, el, pageId: view.ref.id });
        this.elements.set(w.fieldName!, list);
      }
      this.sync();
    }

    const scale = this.viewer.scale;
    for (const entry of this.allEntries()) {
      if (entry.pageId !== view.ref.id) continue;
      const [rx1, ry1, rx2, ry2] = entry.widget.rect;
      const [x1, y1] = view.viewport.convertToViewportPoint(rx1, ry1);
      const [x2, y2] = view.viewport.convertToViewportPoint(rx2, ry2);
      const left = Math.min(x1, x2), top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
      Object.assign(entry.el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

      if (entry.el instanceof HTMLInputElement && (entry.el.type === 'checkbox' || entry.el.type === 'radio')) continue;
      const pdfHeight = Math.abs(entry.widget.rect[3] - entry.widget.rect[1]);
      const declared = entry.widget.defaultAppearanceData?.fontSize;
      const auto = entry.widget.multiLine ? 10 : Math.min(pdfHeight * 0.66, 13);
      entry.el.style.fontSize = `${Math.max(6, (declared || auto) * scale)}px`;
    }
  }

  private *allEntries() {
    for (const list of this.elements.values()) yield* list;
  }

  private initialValue(w: Widget): FormValue {
    const raw = Array.isArray(w.fieldValue) ? w.fieldValue[0] : w.fieldValue;
    if (w.checkBox) return !!raw && raw !== 'Off' && (!w.exportValue || raw === w.exportValue);
    if (w.radioButton) return raw && raw !== 'Off' ? raw : '';
    if (w.fieldType === 'Ch') {
      const match = w.options?.find((o) => o.exportValue === raw || o.displayValue === raw);
      return match?.displayValue ?? raw ?? '';
    }
    return raw ?? '';
  }

  private value(w: Widget): FormValue {
    const doc = this.getDoc()!;
    return w.fieldName! in doc.forms ? doc.forms[w.fieldName!] : this.initialValue(w);
  }

  private commit(name: string, value: FormValue, live = false) {
    const doc = this.getDoc();
    if (!doc) return;
    doc.setForm(name, value);
    if (!live) doc.commit();
    this.sync(name);
  }

  private build(w: Widget, view: PageView): FieldElement | null {
    const name = w.fieldName!;
    let el: FieldElement;

    if (w.fieldType === 'Tx') {
      const text = w.multiLine ? document.createElement('textarea') : document.createElement('input');
      if (text instanceof HTMLInputElement) text.type = w.password ? 'password' : 'text';
      if (w.maxLen) text.maxLength = w.maxLen;
      if (w.comb && w.maxLen) text.style.letterSpacing = '0.4em';
      text.style.textAlign = ['left', 'center', 'right'][w.textAlignment ?? 0] ?? 'left';
      text.addEventListener('input', () => this.commit(name, text.value, true));
      text.addEventListener('change', () => this.commit(name, text.value));
      el = text;
    } else if (w.fieldType === 'Btn' && (w.checkBox || w.radioButton)) {
      const box = document.createElement('input');
      box.type = w.checkBox ? 'checkbox' : 'radio';
      box.name = `${view.ref.id}:${name}`;
      box.addEventListener('change', () => {
        if (w.checkBox) this.commit(name, box.checked);
        else if (box.checked) this.commit(name, w.buttonValue ?? '');
      });
      el = box;
    } else if (w.fieldType === 'Ch') {
      const select = document.createElement('select');
      if (w.multiSelect) select.size = Math.min(4, w.options?.length ?? 2);
      if (w.combo) select.append(new Option('', ''));
      for (const o of w.options ?? []) select.append(new Option(o.displayValue, o.displayValue));
      select.addEventListener('change', () => this.commit(name, select.value));
      el = select;
    } else if (w.fieldType === 'Sig') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t('Click to sign');
      button.addEventListener('click', () => {
        const [x1, y1, x2, y2] = w.rect;
        const detail: SignFieldRequest = {
          pageId: view.ref.id,
          rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
        };
        this.dispatchEvent(new CustomEvent('sign-field', { detail }));
      });
      el = button;
    } else {
      return null;
    }

    el.classList.add('form-field', `form-${el.tagName.toLowerCase()}`);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) el.classList.add('form-toggle');
    el.title = name;
    if (w.readOnly && !(el instanceof HTMLButtonElement)) el.disabled = true;
    return el;
  }

  /** Pushes document values into the inputs (after undo, or edits in a twin field). */
  sync(only?: string) {
    for (const [name, list] of this.elements) {
      if (only && name !== only) continue;
      for (const { widget, el } of list) {
        const value = this.value(widget);
        if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!value;
        else if (el instanceof HTMLInputElement && el.type === 'radio') el.checked = value === widget.buttonValue;
        else if (el instanceof HTMLButtonElement) continue;
        else if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
      }
    }
  }
}
