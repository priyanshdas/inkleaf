// SPDX-License-Identifier: GPL-3.0-or-later
// PDF → Word. A PDF only knows where each piece of text is drawn, not what
// it means, so this rebuilds the structure: pieces on the same baseline
// become a line, lines close together with the same size become a
// paragraph, and noticeably larger text becomes a heading. Pages that are
// mostly pictures (scans) are copied in as a picture instead.
//
// It's meant for getting the words out to keep working on them. Complex
// layouts (columns, tables, forms) come out as plain paragraphs.

import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import type { PDFDocumentProxy, PDFPageProxy } from './pdf';

interface Piece {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  bold: boolean;
  italic: boolean;
  font: string;
}

interface Line {
  pieces: Piece[];
  y: number;
  size: number;
  x0: number;
  x1: number;
}

/** Text pieces of a page, upright text only, in page coordinates. */
async function pieces(page: PDFPageProxy): Promise<Piece[]> {
  // drawing the page once makes pdf.js load its fonts, which is how we learn
  // their real names (and so bold and italic)
  await page.getOperatorList();
  const content = await page.getTextContent();
  const out: Piece[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
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

function toLines(list: Piece[]): Line[] {
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

/** Words of a line as styled runs, with spaces where the PDF left gaps. */
function runs(line: Line): TextRun[] {
  const out: TextRun[] = [];
  let end = -Infinity;
  let last = '';
  for (const p of line.pieces) {
    const gap = p.x - end;
    const needsSpace = end > -Infinity && gap > p.size * 0.15 && !/\s$/.test(last) && !/^\s/.test(p.str);
    const text = (needsSpace ? ' ' : '') + p.str;
    out.push(new TextRun({ text, bold: p.bold, italics: p.italic, size: Math.round(p.size * 2), font: p.font }));
    end = p.x + p.width;
    last = text;
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 11;
}

async function pagePicture(page: PDFPageProxy): Promise<{ data: Uint8Array; width: number; height: number }> {
  const viewport = page.getViewport({ scale: 150 / 72 });
  const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { data: new Uint8Array(await blob.arrayBuffer()), width: viewport.width, height: viewport.height };
}

export async function pdfToWord(pdf: PDFDocumentProxy, progress: (page: number, total: number) => void): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  const first = await pdf.getPage(1);
  const size = first.getViewport({ scale: 1 });
  // usable width in points on the first page, for scaling page pictures
  const usable = size.width - 2 * 54;

  for (let n = 1; n <= pdf.numPages; n++) {
    progress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const list = await pieces(page);
    const characters = list.reduce((sum, p) => sum + p.str.trim().length, 0);

    if (n > 1) children.push(new Paragraph({ children: [new PageBreak()] }));

    if (characters < 20) {
      // a scan or a picture page: keep it as a picture
      const pic = await pagePicture(page);
      const w = Math.min(usable, (pic.width * 72) / 150);
      const hgt = w * (pic.height / pic.width);
      children.push(new Paragraph({ children: [new ImageRun({ type: 'jpg', data: pic.data, transformation: { width: (w * 96) / 72, height: (hgt * 96) / 72 } })] }));
      continue;
    }

    const lines = toLines(list);
    const body = median(lines.map((l) => l.size));
    const view = page.getViewport({ scale: 1 });
    let paragraph: Line[] = [];

    const flush = () => {
      if (!paragraph.length) return;
      const size = paragraph[0].size;
      const level = size >= body * 1.6 ? HeadingLevel.HEADING_1 : size >= body * 1.25 ? HeadingLevel.HEADING_2 : undefined;
      // centred if every line sits in the middle of the page
      const centred = paragraph.every((l) => Math.abs((l.x0 + l.x1) / 2 - view.width / 2) < view.width * 0.04) && paragraph[0].x1 - paragraph[0].x0 < view.width * 0.7;
      const textRuns: TextRun[] = [];
      paragraph.forEach((l, i) => {
        if (i > 0) textRuns.push(new TextRun({ text: ' ' }));
        textRuns.push(...runs(l));
      });
      children.push(new Paragraph({
        children: textRuns,
        heading: level,
        alignment: centred ? AlignmentType.CENTER : undefined,
        spacing: { after: Math.round(size * 6) },
      }));
      paragraph = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = paragraph[paragraph.length - 1];
      const gap = prev ? prev.y - line.y : 0;
      const sameStyle = prev && Math.abs(prev.size - line.size) < 0.6;
      // a new paragraph after a bigger gap, a size change, or an indented first line
      const startsNew = !prev || !sameStyle || gap > line.size * 1.75 || line.x0 > prev.x0 + line.size * 1.5;
      if (startsNew) flush();
      paragraph.push(line);
    }
    flush();
  }

  const doc = new Document({
    creator: 'Inkleaf',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: {
        page: {
          // twips (1/20 pt)
          size: { width: Math.round(size.width * 20), height: Math.round(size.height * 20) },
          margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
        },
      },
      children,
    }],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
