// SPDX-License-Identifier: GPL-3.0-or-later
// XFA forms: the kind many government, tax and immigration forms still use.
//
// An XFA form isn't drawn like an ordinary PDF. Its pages, fields and layout
// are described in XML inside the file, and the PDF pages themselves only
// hold a "Please wait…" message for readers that can't do XFA. pdf.js can
// lay the XML out as HTML (with enableXfa, see pdf.ts), and that's what's
// shown here, over each page, with real fields to type into, tick and pick.
//
// What's typed goes into pdf.js's annotation storage. Saving hands that back
// to pdf.js, which writes it into the form's data inside the file, so it
// stays a proper XFA form that the office it's for can still read
// (exporter.ts). "Save as a regular PDF" instead prints the filled pages to an
// ordinary PDF, which every InkLeaf tool can then work on.
//
// What XFA can do that this can't: run the form's own scripts (sums that fill
// themselves in, buttons that add rows, barcodes made from the answers).

import { XfaLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { t } from '../shared/i18n';
import type { EditorDoc } from './document';
import { h, icon } from './ui';
import type { PageView } from './viewer';

/** The document's XFA form, or null if it's an ordinary PDF. */
export function xfaOf(doc: EditorDoc | null | undefined): PDFDocumentProxy | null {
  const pdf = doc?.sources.get(doc.mainSource)?.pdf;
  return pdf?.isPureXfa ? pdf : null;
}

/** Links in a form open in the browser, never inside InkLeaf. */
const linkService = {
  addLinkAttributes(link: HTMLAnchorElement, url: string) {
    link.href = url;
    link.rel = 'noopener noreferrer nofollow';
    link.target = '_blank';
  },
};

const xfaOfPage = new WeakMap<PDFPageProxy, Promise<unknown>>();
function pageXfa(page: PDFPageProxy) {
  let found = xfaOfPage.get(page);
  if (!found) {
    found = page.getXfa();
    xfaOfPage.set(page, found);
  }
  return found;
}

/**
 * Many forms carry a red "JavaScript has been disabled, please enable it"
 * line that their own scripts hide in Acrobat. InkLeaf doesn't run form
 * scripts, and there's nothing for anyone to turn on, so the line is hidden
 * here too. The note bar (XfaBar) says what does and doesn't work instead.
 */
function hideScriptWarnings(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('.xfaDraw')) {
    const text = el.textContent ?? '';
    if (text.length > 400 || !/javascript/i.test(text) || !/disabl|enabl|activ/i.test(text)) continue;
    if (el.querySelector('input, select, textarea, button')) continue;
    el.style.visibility = 'hidden';
    el.dataset.inkleafHidden = '';
  }
}

/** Lays each page's XFA form over the page, and keeps it in step with the zoom. */
export class XfaPages {
  private built = new WeakMap<PageView, { div: HTMLDivElement; page: PDFPageProxy }>();

  constructor(private getDoc: () => EditorDoc | null, private onEdit: (doc: EditorDoc) => void) {}

  async layout(view: PageView): Promise<void> {
    const doc = this.getDoc();
    const pdf = xfaOf(doc);
    if (!doc || !pdf || !view.pdfPage || !view.viewport || view.ref.src !== doc.mainSource) return;
    const page = view.pdfPage;
    const viewport = view.viewport.clone({ dontFlip: true });
    const known = this.built.get(view);
    if (known && known.page === page && known.div.isConnected) {
      XfaLayer.update({ viewport, div: known.div } as never);
      return;
    }
    const xfaHtml = await pageXfa(page);
    if (!xfaHtml || view.pdfPage !== page) return;
    const div = document.createElement('div');
    div.className = 'page-xfa';
    view.forms.replaceChildren(div);
    XfaLayer.render({ viewport, div, xfaHtml: xfaHtml as never, annotationStorage: pdf.annotationStorage, linkService: linkService as never, intent: 'display' });
    hideScriptWarnings(div);
    // anything typed, ticked or picked means there's something to save
    const changed = () => this.onEdit(doc);
    div.addEventListener('input', changed);
    div.addEventListener('change', changed);
    this.built.set(view, { div, page });
  }
}

/**
 * What's been done to an XFA form that an XFA form can't hold: comments,
 * drawings, stamps, headers and footers, page changes. Those need a regular
 * PDF copy (Save as a Regular PDF). Null if there's nothing.
 */
export function xfaUnsaveable(doc: EditorDoc): string | null {
  const source = doc.sources.get(doc.mainSource);
  if (!source) return null;
  const pages = doc.pages;
  const pagesChanged = pages.length !== source.pages.length
    || pages.some((p, i) => p.src !== doc.mainSource || p.index !== i || p.rotation);
  const marked = pages.some((p) => doc.annots(p.id).length);
  const decor = doc.decor;
  const decorated = !!(decor.watermark || decor.numbers || decor.header || decor.footer);
  return pagesChanged || marked || decorated || doc.outline ? 'changed' : null;
}

/**
 * A small copy of one page of the form, for the page thumbnails: laid out as
 * printed, with the answers so far, and nothing in it can be clicked.
 */
export async function xfaThumbnail(pdf: PDFDocumentProxy, page: PDFPageProxy, scale: number): Promise<HTMLElement> {
  const wrap = document.createElement('div');
  wrap.className = 'thumb-xfa';
  wrap.setAttribute('aria-hidden', 'true');
  const div = document.createElement('div');
  wrap.append(div);
  const viewport = page.getViewport({ scale }).clone({ dontFlip: true });
  XfaLayer.render({ viewport, div, xfaHtml: (await pageXfa(page)) as never, annotationStorage: pdf.annotationStorage, linkService: linkService as never, intent: 'print' });
  hideScriptWarnings(div);
  for (const el of div.querySelectorAll<HTMLElement>('input, select, textarea, button, a')) el.tabIndex = -1;
  return wrap;
}

/** The filled form as a PDF that's still an XFA form, the answers written into it. */
export async function saveXfa(pdf: PDFDocumentProxy): Promise<Uint8Array> {
  return pdf.saveDocument();
}

/**
 * The form's own fonts, as CSS, so a printed copy looks like the form and
 * not like the system's stand-ins. pdf.js keeps their data because InkLeaf
 * opens files with fontExtraProperties (pdf.ts).
 */
function fontRules(pdf: PDFDocumentProxy): string {
  const objects = (pdf as unknown as { _transport?: { commonObjs?: Iterable<[string, unknown]> } })._transport?.commonObjs;
  const rules: string[] = [];
  if (!objects) return '';
  try {
    for (const [, font] of objects) {
      const rule = (font as { createFontFaceRule?: () => string | null })?.createFontFaceRule?.();
      if (rule) rules.push(rule);
    }
  } catch {
    // a pdf.js that keeps these differently: the system's fonts stand in
  }
  return rules.join('\n');
}

/** A blob: picture as a data: one, so it survives being printed elsewhere. */
async function inline(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(url);
    reader.readAsDataURL(blob);
  });
}

/** Writes what's been typed, ticked and picked into the HTML itself, so it prints. */
function freezeValues(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLInputElement>('input')) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) el.setAttribute('checked', '');
      else el.removeAttribute('checked');
    } else {
      el.setAttribute('value', el.value);
    }
  }
  for (const el of root.querySelectorAll('textarea')) el.textContent = el.value;
  for (const el of root.querySelectorAll('select')) {
    for (const option of el.options) {
      if (option.selected) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    }
  }
}

/** Points to CSS pixels: what the HTML is laid out in, at true size. */
const PX = 96 / 72;

/**
 * The filled form as an ordinary PDF: each page laid out as it shows on
 * screen, with the form's fonts, then printed to a page of exactly its size.
 * Text stays text, so it can be searched, copied and edited afterwards.
 */
export async function xfaToRegularPdf(pdf: PDFDocumentProxy, htmlToPdf: (html: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const css = await (await fetch('./vendor/pdfjs/xfa.css')).text();
  const pages: string[] = [];
  const sizes: string[] = [];
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden';
  document.body.append(holder);
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: PX }).clone({ dontFlip: true });
      const xfaHtml = await page.getXfa();
      const div = document.createElement('div');
      holder.replaceChildren(div);
      XfaLayer.render({ viewport, div, xfaHtml: xfaHtml as never, annotationStorage: pdf.annotationStorage, linkService: linkService as never, intent: 'print' });
      hideScriptWarnings(div);
      freezeValues(div);
      for (const img of div.querySelectorAll('img')) {
        if (img.src.startsWith('blob:')) img.setAttribute('src', await inline(img.src));
      }
      const w = viewport.width / PX, h = viewport.height / PX;
      sizes.push(`@page p${n} { size: ${w}pt ${h}pt; margin: 0; }`);
      pages.push(`<section class="sheet" style="page: p${n}; width: ${viewport.width}px; height: ${viewport.height}px">${div.outerHTML}</section>`);
    }
  } finally {
    holder.remove();
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${fontRules(pdf)}
${css}
${sizes.join('\n')}
html, body { margin: 0; padding: 0; background: #fff; }
.sheet { position: relative; overflow: hidden; break-after: page; }
.sheet:last-child { break-after: auto; }
.xfaLayer { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
/* on paper, fields look like the form: no blue fill, no red "required" box */
.xfaLayer *:required { outline: none; }
.xfaTextfield, .xfaSelect { background-image: none; }
</style></head><body>${pages.join('')}</body></html>`;
  return htmlToPdf(html);
}

// --- Find -------------------------------------------------------------------------------------
// An XFA page has no text positions for the usual search (text-finder.ts),
// so Find looks through the form's own words: the same HTML laid out off
// screen to count the hits on every page, and the HTML on screen to mark
// them. Both come from the same layout, so the nth hit is the same place.

/** The visible bits of text in a laid-out XFA page, in reading order. */
function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('[data-inkleaf-hidden], select, style, script')
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  });
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.trim()) found.push(n as Text);
  }
  return found;
}

function hitsIn(text: string, needle: string, matchCase: boolean): number[] {
  const hay = matchCase ? text : text.toLowerCase();
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1 && needle; i = hay.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

/** How many times the words turn up on one page of the form. `needle` is lower case unless matchCase. */
export async function xfaCount(pdf: PDFDocumentProxy, index: number, needle: string, matchCase: boolean): Promise<number> {
  const page = await pdf.getPage(index + 1);
  const div = document.createElement('div');
  const viewport = page.getViewport({ scale: 1 }).clone({ dontFlip: true });
  XfaLayer.render({ viewport, div, xfaHtml: (await pageXfa(page)) as never, annotationStorage: pdf.annotationStorage, linkService: linkService as never, intent: 'display' });
  hideScriptWarnings(div);
  let count = 0;
  for (const node of textNodes(div)) count += hitsIn(node.data, needle, matchCase).length;
  return count;
}

/** Where each hit is on a page shown on screen, as boxes on the screen. */
export function xfaHitBoxes(root: HTMLElement, needle: string, matchCase: boolean): DOMRect[][] {
  const boxes: DOMRect[][] = [];
  for (const node of textNodes(root)) {
    for (const at of hitsIn(node.data, needle, matchCase)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      boxes.push([...range.getClientRects()]);
    }
  }
  return boxes;
}

// --- Note bar ---------------------------------------------------------------------------------

/**
 * A small note over the pages while an XFA form is open: that it's an XFA
 * form, what works, and one click to a regular copy for everything else.
 */
export class XfaBar {
  private el: HTMLElement;
  private dismissed = new WeakSet<EditorDoc>();
  private doc: EditorDoc | null = null;

  constructor(host: HTMLElement, onRegular: () => void) {
    const regular = h('button', { class: 'xfa-bar-btn' }, t('Save as a Regular PDF…'));
    const close = h('button', { class: 'xfa-bar-close', title: t('Hide'), 'aria-label': t('Hide') }, icon('x'));
    this.el = h('div', { class: 'xfa-bar', role: 'note', hidden: true },
      icon('file-text'),
      h('span', { class: 'xfa-bar-text' },
        t('XFA form: type your answers and save as usual. Its own buttons and sums don’t run here yet.')),
      regular, close);
    regular.addEventListener('click', onRegular);
    close.addEventListener('click', () => {
      if (this.doc) this.dismissed.add(this.doc);
      this.el.hidden = true;
    });
    host.append(this.el);
  }

  update(doc: EditorDoc | null) {
    this.doc = doc;
    this.el.hidden = !doc || !xfaOf(doc) || this.dismissed.has(doc);
  }
}
