// SPDX-License-Identifier: GPL-3.0-or-later
// Things that go on every page: a watermark, page numbers, and header and
// footer text. They're described once for the document (see Decor in
// types.ts) and turned into ordinary text blocks per page, so the screen and
// the saved PDF draw them with exactly the same code as any other text.

import type { EditorDoc } from './document';
import { measureText } from './fonts';
import { rotateVec } from './geometry';
import type { Band, Box, NumberStyle, PageRef, TextAlign, TextAnnot } from './types';

/** Distance from the page edge to header, footer and page numbers, in points. */
const MARGIN = 28;

/**
 * Maps a point given in "as displayed" page coordinates (points from the
 * top-left corner of the page as you see it, y going down) to PDF user
 * space, for a page shown with `rotation` degrees clockwise.
 */
export function displayToUser(box: Box, rotation: number, dx: number, dy: number): [number, number] {
  const x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
  switch (((rotation % 360) + 360) % 360) {
    case 90: return [x0 + dy, y0 + dx];
    case 180: return [x1 - dx, y0 + dy];
    case 270: return [x1 - dy, y1 - dx];
    default: return [x0 + dx, y1 - dy];
  }
}

function pageLabel(style: NumberStyle, n: number, total: number): string {
  switch (style) {
    case 'n-of-total': return `${n} of ${total}`;
    case 'page-n': return `Page ${n}`;
    case 'page-n-of-total': return `Page ${n} of ${total}`;
    default: return String(n);
  }
}

function fill(template: string, values: { page: number; total: number; file: string }): string {
  return template
    .replace(/\{page\}/gi, String(values.page))
    .replace(/\{total\}/gi, String(values.total))
    .replace(/\{file\}/gi, values.file.replace(/\.pdf$/i, ''))
    .replace(/\{date\}/gi, new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
}

const base = { bold: false, italic: false, underline: false, background: null } as const;

/** The decorations for one page, as text blocks in that page's user space. */
export function decorTexts(doc: EditorDoc, ref: PageRef): TextAnnot[] {
  const decor = doc.decor;
  if (!decor.watermark && !decor.numbers && !decor.header && !decor.footer) return [];

  const index = doc.pageIndex(ref.id);
  if (index < 0) return [];
  const total = doc.pages.length;
  const box = doc.viewBox(ref);
  const rotation = doc.displayRotation(ref);
  const { width: pw, height: ph } = doc.displaySize(ref);
  const out: TextAnnot[] = [];

  /** Places one line of text at a display position, turned `turn` degrees CCW. */
  const place = (id: string, text: string, size: number, color: string, opacity: number,
    anchor: { x: number; y: number }, align: TextAlign, valign: 'top' | 'bottom' | 'middle', turn = 0) => {
    if (!text.trim()) return;
    const style = { ...base, text, size, font: 'sans' as const, color, align, opacity };
    const { width, height } = measureText({ ...style });
    // top-left of the block relative to the anchor, before turning
    const ox = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
    const oy = valign === 'middle' ? -height / 2 : valign === 'bottom' ? -height : 0;
    // turning counter-clockwise on screen, where y points down
    const [rx, ry] = rotateVec(ox, -oy, turn);
    const [x, y] = displayToUser(box, rotation, anchor.x + rx, anchor.y - ry);
    out.push({ id: `decor-${id}`, type: 'text', x, y, angle: rotation + turn, ...style });
  };

  const values = { page: index + 1, total, file: doc.name };

  const band = (b: Band | null, where: 'header' | 'footer') => {
    if (!b) return;
    const y = where === 'header' ? MARGIN : ph - MARGIN;
    const valign = where === 'header' ? 'top' : 'bottom';
    place(`${where}-l`, fill(b.left, values), b.size, '#444444', 1, { x: MARGIN, y }, 'left', valign);
    place(`${where}-c`, fill(b.center, values), b.size, '#444444', 1, { x: pw / 2, y }, 'center', valign);
    place(`${where}-r`, fill(b.right, values), b.size, '#444444', 1, { x: pw - MARGIN, y }, 'right', valign);
  };
  band(decor.header, 'header');
  band(decor.footer, 'footer');

  const numbers = decor.numbers;
  if (numbers && !(numbers.skipFirst && index === 0)) {
    const n = numbers.start + index - (numbers.skipFirst ? 1 : 0);
    const shownTotal = total - (numbers.skipFirst ? 1 : 0) + numbers.start - 1;
    const x = numbers.align === 'left' ? MARGIN : numbers.align === 'right' ? pw - MARGIN : pw / 2;
    // keep clear of a header or footer on the same edge
    const sharing = numbers.vertical === 'top' ? decor.header : decor.footer;
    const shift = sharing ? sharing.size * 1.6 : 0;
    const y = numbers.vertical === 'top' ? MARGIN + shift : ph - MARGIN - shift;
    place('number', pageLabel(numbers.style, n, shownTotal), numbers.size, '#333333', 1, { x, y }, numbers.align,
      numbers.vertical === 'top' ? 'top' : 'bottom');
  }

  const w = decor.watermark;
  if (w?.text.trim()) {
    // diagonal from bottom-left to top-right, whatever the page's shape
    const turn = w.diagonal ? (Math.atan2(ph, pw) * 180) / Math.PI : 0;
    // shrink to fit small (or cropped) pages rather than run off the edge
    const room = (w.diagonal ? Math.hypot(pw, ph) : pw) * 0.8;
    const natural = measureText({ ...base, text: w.text, size: w.size, font: 'sans', color: w.color }).width;
    const size = natural > room ? (w.size * room) / natural : w.size;
    place('watermark', w.text, size, w.color, w.opacity, { x: pw / 2, y: ph / 2 }, 'center', 'middle', turn);
  }
  return out;
}

export function hasDecor(doc: EditorDoc): boolean {
  const d = doc.decor;
  return !!(d.watermark || d.numbers || d.header || d.footer);
}
