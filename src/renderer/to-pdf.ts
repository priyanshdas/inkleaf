// SPDX-License-Identifier: GPL-3.0-or-later
// Turning other files into PDFs: Word, Excel, PowerPoint, OpenDocument,
// text, Markdown, web pages and pictures.
//
// When LibreOffice is installed, office files go through it, which keeps
// their layout exactly. Without it, Inkleaf's own converters take over:
// Word documents keep their text, headings, lists, tables and pictures;
// spreadsheets become tables, one sheet after another; slides keep their
// text, pictures and simple shapes. Everything happens on this computer.

import { t } from '../shared/i18n';
import { embeddable } from './tools';

export interface Converted {
  bytes: Uint8Array;
  /** Anything the user should know about how faithful the result is. */
  notes: string[];
}

const ext = (name: string) => name.split('.').pop()!.toLowerCase();
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const decode = (data: Uint8Array) => new TextDecoder('utf-8').decode(data).replace(/^﻿/, '');

const OFFICE = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']);
const PICTURES = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

/** Styles for documents rendered from HTML: plain, readable, print-friendly. */
const DOC_CSS = `
  /* ligatures would turn "office" into o-ﬃ-ce for anyone copying or searching the PDF */
  * { font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0; }
  body { font: 11pt/1.5 Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 10pt; } h2 { font-size: 15pt; margin: 16pt 0 8pt; } h3 { font-size: 12.5pt; margin: 14pt 0 6pt; }
  p { margin: 0 0 8pt; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 8pt 0 12pt; max-width: 100%; }
  td, th { border: 0.75pt solid #b5bcc0; padding: 3pt 6pt; vertical-align: top; }
  th { background: #f0f3f1; text-align: left; }
  pre, code { font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 9.5pt; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  blockquote { margin: 0 0 8pt; padding-left: 10pt; border-left: 3pt solid #d4dbd7; color: #4a5852; }
  a { color: #1d3f91; }
`;

const page = (title: string, body: string, extraCss = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOC_CSS}${extraCss}</style></head><body>${body}</body></html>`;

async function picturePdf(file: { name: string; data: Uint8Array }): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const img = await embeddable(file);
  const out = await PDFDocument.create();
  const embedded = img.jpeg ? await out.embedJpg(img.bytes) : await out.embedPng(img.bytes);
  // fit on an A4 page, turned to suit the picture
  const landscape = img.width > img.height;
  const [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89];
  const w = (img.width * 72) / 96, h = (img.height * 72) / 96;
  const scale = Math.min((pw - 56) / w, (ph - 56) / h, 1.5);
  out.addPage([pw, ph]).drawImage(embedded, { x: (pw - w * scale) / 2, y: (ph - h * scale) / 2, width: w * scale, height: h * scale });
  return out.save();
}

async function docxHtml(data: Uint8Array): Promise<{ html: string; warnings: number }> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.convertToHtml({ arrayBuffer: data.slice().buffer as ArrayBuffer });
  return { html: result.value, warnings: result.messages.filter((m: { type: string }) => m.type === 'warning').length };
}

/** RFC 4180 CSV, also accepting semicolons (common in Europe) when there are no commas. */
export function parseCsv(text: string): string[][] {
  const first = text.split('\n', 1)[0];
  const sep = !first.includes(',') && first.includes(';') ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const tableHtml = (rows: string[][], header = true) =>
  `<table>${rows.map((r, i) => `<tr>${r.map((c) => (header && i === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join('')}</tr>`).join('')}</table>`;

async function spreadsheetHtml(data: Uint8Array): Promise<{ html: string; wide: boolean }> {
  const ExcelJS = (await import('exceljs')).default;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data.slice().buffer as ArrayBuffer);
  let widest = 0;
  const sections: string[] = [];
  book.eachSheet((sheet) => {
    if (sheet.state && sheet.state !== 'visible') return;
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.max(row.cellCount, sheet.actualColumnCount); c++) {
        const cell = row.getCell(c);
        const css: string[] = [];
        if (cell.font?.bold) css.push('font-weight:700');
        if (cell.font?.italic) css.push('font-style:italic');
        const align = cell.alignment?.horizontal ?? (typeof cell.value === 'number' ? 'right' : undefined);
        if (align && ['left', 'center', 'right'].includes(align)) css.push(`text-align:${align}`);
        const fill = (cell.fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb;
        if (fill && fill.length === 8 && fill !== 'FFFFFFFF') css.push(`background:#${fill.slice(2)}`);
        cells.push(`<td${css.length ? ` style="${css.join(';')}"` : ''}>${escapeHtml(cell.text ?? '')}</td>`);
      }
      widest = Math.max(widest, cells.length);
      rows.push(`<tr>${cells.join('')}</tr>`);
    });
    if (rows.length) sections.push(`<h2>${escapeHtml(sheet.name)}</h2><table>${rows.join('')}</table>`);
  });
  if (!sections.length) throw new Error(t('This spreadsheet is empty.'));
  return { html: sections.join('<div style="break-after:page"></div>'), wide: widest > 7 };
}

/** Converts one file. Throws a readable error when the format can't be done here. */
export async function convertToPdf(file: { name: string; data: Uint8Array }, progress: (message: string) => void): Promise<Converted> {
  const kind = ext(file.name);
  const title = file.name.replace(/\.[^.]+$/, '');
  const api = window.inkleaf;

  if (kind === 'pdf') return { bytes: file.data, notes: [] };
  if (PICTURES.has(kind)) return { bytes: await picturePdf(file), notes: [] };

  if (OFFICE.has(kind) && (await api.officeAvailable())) {
    progress(t('Converting “{name}” with LibreOffice…', { name: file.name }));
    return { bytes: await api.officeToPdf(file.name, file.data), notes: [] };
  }

  const builtIn = t('Converted with Inkleaf’s built-in converter. For an exact copy of the layout, install LibreOffice (free) and convert again.');
  progress(t('Converting “{name}”…', { name: file.name }));
  switch (kind) {
    case 'docx': {
      const { html, warnings } = await docxHtml(file.data);
      const notes = [builtIn];
      if (warnings) notes.push(t('Some formatting in the Word file had no equivalent and was simplified.'));
      return { bytes: await api.htmlToPdf(page(title, html)), notes };
    }
    case 'xlsx': {
      const { html, wide } = await spreadsheetHtml(file.data);
      return { bytes: await api.htmlToPdf(page(title, html, 'td { font-size: 9.5pt; } h2 { font-size: 12pt; }'), { landscape: wide, margin: 0.5 }), notes: [builtIn] };
    }
    case 'csv': {
      const rows = parseCsv(decode(file.data));
      if (!rows.length) throw new Error(t('This CSV file is empty.'));
      const wide = Math.max(...rows.map((r) => r.length)) > 7;
      return { bytes: await api.htmlToPdf(page(title, tableHtml(rows), 'td, th { font-size: 9.5pt; }'), { landscape: wide, margin: 0.5 }), notes: [] };
    }
    case 'pptx': {
      const { pptxToHtml } = await import('./pptx');
      const deck = await pptxToHtml(file.data);
      return { bytes: await api.htmlToPdf(deck.html, { width: deck.width, height: deck.height, margin: 0 }), notes: [builtIn] };
    }
    case 'md':
    case 'markdown': {
      const { marked } = await import('marked');
      // raw HTML inside Markdown is shown as text, not run
      const html = await marked.parse(decode(file.data).replace(/</g, '&lt;'), { gfm: true });
      return { bytes: await api.htmlToPdf(page(title, html)), notes: [] };
    }
    case 'txt':
      return { bytes: await api.htmlToPdf(page(title, `<pre>${escapeHtml(decode(file.data))}</pre>`, 'pre { font-size: 10pt; }')), notes: [] };
    case 'html':
    case 'htm':
      // printed as it is; scripts don't run and nothing loads from the internet
      return { bytes: await api.htmlToPdf(decode(file.data)), notes: [t('Web pages are printed without running their scripts or loading anything from the internet, so pictures that live online won’t appear.')] };
    default: {
      const names: Record<string, string> = { doc: t('Old Word (.doc)'), odt: t('OpenDocument text'), rtf: t('RTF'), xls: t('Old Excel (.xls)'), ods: t('OpenDocument spreadsheet'), ppt: t('Old PowerPoint (.ppt)'), odp: t('OpenDocument presentation') };
      throw new Error(t('{format} files need LibreOffice to convert. It’s free from libreoffice.org; once it’s installed, Inkleaf uses it automatically. Or save the file as .docx, .xlsx or .pptx and convert that.', { format: names[kind] ?? `.${kind}` }));
    }
  }
}
