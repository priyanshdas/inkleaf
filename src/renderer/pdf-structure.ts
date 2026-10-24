// SPDX-License-Identifier: GPL-3.0-or-later
// Reading the structure back out of a PDF, for exporting to Word, HTML,
// Markdown, text and Excel.
//
// A PDF only knows where each piece of text is drawn, not what it means, so
// this rebuilds it: pieces on the same baseline become a line, lines close
// together in the same size become a paragraph, noticeably larger text
// becomes a heading, and pages that are mostly pictures (scans) are kept as
// a picture. Columns and tables come out as plain paragraphs (the Excel
// export has its own way of finding columns).

import type { PDFDocumentProxy, PDFPageProxy } from './pdf';

export interface Piece {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  bold: boolean;
  italic: boolean;
  /** A common font to stand in for the PDF's: 'Calibri', 'Times New Roman' or 'Courier New'. */
  font: string;
}

export interface Line {
  pieces: Piece[];
  y: number;
  size: number;
  x0: number;
  x1: number;
}

/** A run of text in one style. */
export interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  font: string;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2; spans: Span[]; centred: boolean; size: number }
  | { kind: 'paragraph'; spans: Span[]; centred: boolean; size: number }
  | { kind: 'picture'; data: Uint8Array; width: number; height: number };

export interface PageStructure {
  /** Page size in points. */
  width: number;
  height: number;
  blocks: Block[];
  lines: Line[];
}

/** Text pieces of a page, upright text only, in page coordinates. */
export async function pieces(page: PDFPageProxy): Promise<Piece[]> {
  // drawing the page once makes pdf.js load its fonts, which is how we learn
  // their real names (and so bold and italic)
  await page.getOperatorList();
  const content = await page.getTextContent();
  const out: Piece[] = [];
  for (const item of content.items) {
    // pdf.js bridges gaps with space-only items as wide as the gap; the gap
    // itself is what tells words and table columns apart, so skip them
    if (!('str' in item) || !item.str.trim()) continue;
    const [a, b, , d, e, f] = item.transform as number[];
    if (Math.abs(b) > 0.01 * Math.abs(a)) continue; // turned text: skip
    let name = '';
    try {
      name = (page.commonObjs.get(item.fontName) as { name?: string })?.name ?? '';
    } catch {
      // font not loaded; fall back to plain text
    }
    const style = content.styles[item.fontName];
    out.push({
      str: item.str,
      x: e,
      y: f,
      size: Math.abs(d) || Math.abs(a),
      width: item.width,
      bold: /bold|black|heavy|semibold|demi/i.test(name),
      italic: /italic|oblique/i.test(name),
      font: /mono|courier|consol/i.test(`${name} ${style?.fontFamily ?? ''}`) ? 'Courier New'
        : /serif|times|georgia|garamond|cambria/i.test(name) && !/sans/i.test(name) ? 'Times New Roman' : 'Calibri',
    });
  }
  return out;
}

export function toLines(list: Piece[]): Line[] {
  const sorted = [...list].sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Line[] = [];
  for (const p of sorted) {
    const line = lines.find((l) => Math.abs(l.y - p.y) < Math.max(2, Math.min(l.size, p.size) * 0.5));
    if (line) {
      line.pieces.push(p);
      line.size = Math.max(line.size, p.size);
      line.x0 = Math.min(line.x0, p.x);
      line.x1 = Math.max(line.x1, p.x + p.width);
    } else {
      lines.push({ pieces: [p], y: p.y, size: p.size, x0: p.x, x1: p.x + p.width });
    }
  }
  for (const l of lines) l.pieces.sort((p, q) => p.x - q.x);
  return lines.sort((p, q) => q.y - p.y);
}

/** A line's text as styled spans, with spaces where the PDF left gaps. */
export function lineSpans(line: Line): Span[] {
  const out: Span[] = [];
  let end = -Infinity;
  let last = '';
  for (const p of line.pieces) {
    const gap = p.x - end;
    const needsSpace = end > -Infinity && gap > p.size * 0.15 && !/\s$/.test(last) && !/^\s/.test(p.str);
    const text = (needsSpace ? ' ' : '') + p.str;
    const prev = out[out.length - 1];
    // merge neighbours in the same style, so exports aren't one span per word
    if (prev && prev.bold === p.bold && prev.italic === p.italic && prev.font === p.font && Math.abs(prev.size - p.size) < 0.3) prev.text += text;
    else out.push({ text, bold: p.bold, italic: p.italic, size: p.size, font: p.font });
    end = p.x + p.width;
    last = text;
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 11;
}

/** The whole page as a JPEG, at `dpi`. */
export async function pagePicture(page: PDFPageProxy, dpi = 150, type: 'jpeg' | 'png' = 'jpeg'): Promise<{ data: Uint8Array; width: number; height: number }> {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
  const blob = await canvas.convertToBlob({ type: `image/${type}`, quality: 0.85 });
  return { data: new Uint8Array(await blob.arrayBuffer()), width: viewport.width, height: viewport.height };
}

/** Headings, paragraphs and pictures for one page. */
export async function pageStructure(page: PDFPageProxy): Promise<PageStructure> {
  const view = page.getViewport({ scale: 1 });
  const list = await pieces(page);
  const characters = list.reduce((sum, p) => sum + p.str.trim().length, 0);
  const lines = toLines(list);

  if (characters < 20) {
    // a scan or a picture page: keep it as a picture
    const pic = await pagePicture(page);
    return { width: view.width, height: view.height, lines, blocks: [{ kind: 'picture', ...pic }] };
  }

  const body = median(lines.map((l) => l.size));
  const blocks: Block[] = [];
  let paragraph: Line[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    const size = paragraph[0].size;
    // centred if every line sits in the middle of the page
    const centred = paragraph.every((l) => Math.abs((l.x0 + l.x1) / 2 - view.width / 2) < view.width * 0.04) && paragraph[0].x1 - paragraph[0].x0 < view.width * 0.7;
    const spans: Span[] = [];
    paragraph.forEach((l, i) => {
      if (i > 0 && spans.length && !/[\s-]$/.test(spans[spans.length - 1].text)) spans[spans.length - 1].text += ' ';
      spans.push(...lineSpans(l));
    });
    if (size >= body * 1.6) blocks.push({ kind: 'heading', level: 1, spans, centred, size });
    else if (size >= body * 1.25) blocks.push({ kind: 'heading', level: 2, spans, centred, size });
    else blocks.push({ kind: 'paragraph', spans, centred, size });
    paragraph = [];
  };

  for (const line of lines) {
    const prev = paragraph[paragraph.length - 1];
    const gap = prev ? prev.y - line.y : 0;
    const sameStyle = prev && Math.abs(prev.size - line.size) < 0.6;
    // a new paragraph after a bigger gap, a size change, or an indented first line
    const startsNew = !prev || !sameStyle || gap > line.size * 1.75 || line.x0 > prev.x0 + line.size * 1.5;
    if (startsNew) flush();
    paragraph.push(line);
  }
  flush();
  return { width: view.width, height: view.height, lines, blocks };
}

/** Every page's structure, reporting progress as it goes. */
export async function documentStructure(pdf: PDFDocumentProxy, progress: (page: number, total: number) => void): Promise<PageStructure[]> {
  const out: PageStructure[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    progress(n, pdf.numPages);
    out.push(await pageStructure(await pdf.getPage(n)));
  }
  return out;
}
