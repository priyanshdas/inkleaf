// SPDX-License-Identifier: GPL-3.0-or-later
// PDF → Excel, PowerPoint, plain text, Markdown and HTML.

import type { PDFDocumentProxy } from './pdf';
import { documentStructure, Line, lineSpans, pagePicture, PageStructure, pieces, Span, toLines } from './pdf-structure';

type Progress = (page: number, total: number) => void;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const plain = (spans: Span[]) => spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();

// --- text, Markdown, HTML ----------------------------------------------------------

export async function pdfToText(pdf: PDFDocumentProxy, progress: Progress): Promise<string> {
  const pages = await documentStructure(pdf, progress);
  return pages.map((p, i) => {
    const body = p.blocks.map((b) => (b.kind === 'picture' ? '[picture]' : plain(b.spans))).join('\n\n');
    return pages.length > 1 ? `${body}\n\n--- page ${i + 1} ---` : body;
  }).join('\n\n').trim() + '\n';
}

/** Markdown escapes for characters that would otherwise start formatting. */
const md = (s: string) => s.replace(/([\\`*_[\]#<>|])/g, '\\$1');

function mdSpans(spans: Span[]): string {
  return spans.map((s) => {
    const t = s.text;
    if (!t.trim() || (!s.bold && !s.italic)) return md(t);
    // keep the spaces outside the markers, or Markdown ignores them
    const [, lead, core, trail] = t.match(/^(\s*)(.*?)(\s*)$/)!;
    const mark = s.bold && s.italic ? '***' : s.bold ? '**' : '*';
    return `${lead}${mark}${md(core)}${mark}${trail}`;
  }).join('').replace(/\s+/g, ' ').trim();
}

export async function pdfToMarkdown(pdf: PDFDocumentProxy, progress: Progress): Promise<string> {
  const pages = await documentStructure(pdf, progress);
  const out: string[] = [];
  pages.forEach((p, i) => {
    if (i > 0) out.push('---');
    for (const b of p.blocks) {
      if (b.kind === 'picture') out.push(`*[Page ${i + 1} is a picture]*`);
      else if (b.kind === 'heading') out.push(`${b.level === 1 ? '#' : '##'} ${plain(b.spans).replace(/([\\`*_[\]#])/g, '\\$1')}`);
      else out.push(mdSpans(b.spans));
    }
  });
  return out.join('\n\n') + '\n';
}

function htmlSpans(spans: Span[]): string {
  return spans.map((s) => {
    let t = escapeHtml(s.text);
    if (s.bold) t = `<strong>${t}</strong>`;
    if (s.italic) t = `<em>${t}</em>`;
    if (s.font === 'Courier New') t = `<code>${t}</code>`;
    return t;
  }).join('');
}

export async function pdfToHtml(pdf: PDFDocumentProxy, title: string, progress: Progress): Promise<string> {
  const pages = await documentStructure(pdf, progress);
  const toDataUrl = (bytes: Uint8Array) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(s)}`;
  };
  const body = pages.map((p) => `<section class="page">\n${p.blocks.map((b) => {
    if (b.kind === 'picture') return `<img src="${toDataUrl(b.data)}" alt="">`;
    const style = b.centred ? ' style="text-align:center"' : '';
    if (b.kind === 'heading') return `<h${b.level}${style}>${htmlSpans(b.spans)}</h${b.level}>`;
    return `<p${style}>${htmlSpans(b.spans)}</p>`;
  }).join('\n')}\n</section>`).join('\n<hr>\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Inkleaf">
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #1a1a1a; }
  h1, h2 { line-height: 1.25; }
  img { max-width: 100%; height: auto; border: 1px solid #ddd; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 2.5rem 0; }
  code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// --- Excel ---------------------------------------------------------------------------------

/**
 * Finds the table in a page: each line is a row, and its words are split
 * into cells where there's a wide gap. Cell positions from every row are
 * then clustered into columns, so a value lands in the same column as the
 * ones above it even when some rows have empty cells.
 */
export function pageTable(lines: Line[]): string[][] {
  type Cell = { x0: number; x1: number; text: string };
  const rows: Cell[][] = lines.map((line) => {
    const cells: Cell[] = [];
    let current: Cell | null = null;
    for (const p of line.pieces) {
      const gap = current ? p.x - current.x1 : Infinity;
      if (!current || gap > Math.max(p.size * 1.2, 8)) {
        current = { x0: p.x, x1: p.x + p.width, text: p.str };
        cells.push(current);
      } else {
        current.text += (gap > p.size * 0.15 && !/\s$/.test(current.text) ? ' ' : '') + p.str;
        current.x1 = p.x + p.width;
      }
    }
    return cells.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
  });

  // Columns are the horizontal bands that table cells occupy: cells that
  // overlap sideways belong together, which keeps right-aligned numbers
  // under their heading. Only rows with several cells shape the columns, so
  // a long title line doesn't swallow the whole table.
  const bands: { x0: number; x1: number }[] = [];
  for (const c of rows.filter((r) => r.length > 1).flat().sort((a, b) => a.x0 - b.x0)) {
    const last = bands[bands.length - 1];
    if (last && c.x0 <= last.x1 + 3) last.x1 = Math.max(last.x1, c.x1);
    else bands.push({ x0: c.x0, x1: c.x1 });
  }
  if (!bands.length) bands.push({ x0: -Infinity, x1: Infinity });
  const columnOf = (c: Cell) => {
    let best = 0, bestScore = -Infinity;
    bands.forEach((b, i) => {
      const overlap = Math.min(b.x1, c.x1) - Math.max(b.x0, c.x0);
      const score = overlap > 0 ? overlap : -Math.min(Math.abs(c.x0 - b.x0), Math.abs(c.x1 - b.x1));
      if (score > bestScore) [best, bestScore] = [i, score];
    });
    return best;
  };
  return rows.filter((r) => r.length).map((r) => {
    const out: string[] = new Array(bands.length).fill('');
    for (const c of r) {
      const i = columnOf(c);
      out[i] = out[i] ? `${out[i]} ${c.text}` : c.text;
    }
    // trailing empty cells aren't worth keeping
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  });
}

/** "1,234.50", "₹ 18,450", "12%" → numbers Excel can add up; anything else stays text. */
export function asNumber(text: string): number | null {
  const t = text.replace(/[\s,₹$€£]/g, '');
  if (!/^[-+(]?\d+(\.\d+)?\)?%?$/.test(t)) return null;
  let n = Number(t.replace(/[()%]/g, ''));
  if (/^\(.*\)$/.test(t)) n = -n; // accounting negatives
  if (t.endsWith('%')) n /= 100;
  return Number.isFinite(n) ? n : null;
}

export async function pdfToExcel(pdf: PDFDocumentProxy, progress: Progress): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const book = new ExcelJS.Workbook();
  book.creator = 'Inkleaf';
  for (let n = 1; n <= pdf.numPages; n++) {
    progress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const table = pageTable(toLines(await pieces(page)));
    const sheet = book.addWorksheet(`Page ${n}`);
    for (const row of table) {
      const added = sheet.addRow(row.map((cell) => {
        const num = asNumber(cell);
        return num ?? cell;
      }));
      row.forEach((cell, i) => {
        if (cell.endsWith('%') && asNumber(cell) !== null) added.getCell(i + 1).numFmt = '0.##%';
      });
    }
    // size columns to their longest value, within reason
    sheet.columns.forEach((col) => {
      let longest = 8;
      col.eachCell?.({ includeEmpty: false }, (c) => {
        longest = Math.max(longest, String(c.value ?? '').length);
      });
      col.width = Math.min(60, longest + 2);
    });
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}

// --- PowerPoint ----------------------------------------------------------------------------

/** One slide per page, each showing the page exactly; its text goes in the notes. */
export async function pdfToPowerPoint(pdf: PDFDocumentProxy, title: string, progress: Progress): Promise<Uint8Array> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pres = new PptxGenJS();
  pres.author = 'Inkleaf';
  pres.title = title;
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  // slides are sized in inches, like the PDF's first page
  pres.defineLayout({ name: 'PDF', width: first.width / 72, height: first.height / 72 });
  pres.layout = 'PDF';

  for (let n = 1; n <= pdf.numPages; n++) {
    progress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const pic = await pagePicture(page, 150);
    let base64 = '';
    for (let i = 0; i < pic.data.length; i += 0x8000) base64 += String.fromCharCode(...pic.data.subarray(i, i + 0x8000));
    const slide = pres.addSlide();
    // fit the page inside the slide, centred, keeping its shape
    const sw = first.width / 72, sh = first.height / 72;
    const scale = Math.min(sw / (view.width / 72), sh / (view.height / 72));
    const w = (view.width / 72) * scale, h = (view.height / 72) * scale;
    slide.addImage({ data: `data:image/jpeg;base64,${btoa(base64)}`, x: (sw - w) / 2, y: (sh - h) / 2, w, h });
    const text = toLines(await pieces(page)).map((l) => lineSpans(l).map((s) => s.text).join('')).join('\n').trim();
    if (text) slide.addNotes(text);
  }
  const out = await pres.write({ outputType: 'uint8array' });
  return out as Uint8Array;
}

export type { PageStructure };
