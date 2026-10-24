// SPDX-License-Identifier: GPL-3.0-or-later
// PDF → Word, built from the structure pdf-structure.ts reads out of the
// pages: headings, paragraphs and pictures. It's meant for getting the words
// out to keep working on them; complex layouts come out as plain paragraphs.

import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import type { PDFDocumentProxy } from './pdf';
import { documentStructure, PageStructure, Span } from './pdf-structure';

const run = (s: Span) => new TextRun({ text: s.text, bold: s.bold, italics: s.italic, size: Math.round(s.size * 2), font: s.font });

export async function pdfToWord(pdf: PDFDocumentProxy, progress: (page: number, total: number) => void): Promise<Uint8Array> {
  return structureToWord(await documentStructure(pdf, progress));
}

/** A Word file from page structure (also used for translated documents). */
export async function structureToWord(pages: PageStructure[]): Promise<Uint8Array> {
  const size = pages[0] ?? { width: 595, height: 842 };
  // usable width in points on the first page, for scaling page pictures
  const usable = size.width - 2 * 54;
  const children: Paragraph[] = [];

  pages.forEach((page, n) => {
    if (n > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const block of page.blocks) {
      if (block.kind === 'picture') {
        const w = Math.min(usable, (block.width * 72) / 150);
        const h = w * (block.height / block.width);
        children.push(new Paragraph({ children: [new ImageRun({ type: 'jpg', data: block.data, transformation: { width: (w * 96) / 72, height: (h * 96) / 72 } })] }));
        continue;
      }
      children.push(new Paragraph({
        children: block.spans.map(run),
        heading: block.kind === 'heading' ? (block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined,
        alignment: block.centred ? AlignmentType.CENTER : undefined,
        spacing: { after: Math.round(block.size * 6) },
      }));
    }
  });

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
