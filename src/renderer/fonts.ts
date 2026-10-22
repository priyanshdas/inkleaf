// SPDX-License-Identifier: GPL-3.0-or-later
// Only types from pdf-lib here: the library itself is loaded on demand, so it
// doesn't slow down start-up.
import type { PDFFont, StandardFonts } from 'pdf-lib';
import { covers, Face, Family, faceWidth, getFamily, loadFace, pickFace } from './custom-fonts';
import type { FontFamily, TextStyle } from './types';

/** What text helpers need to know: the style, plus the text when a custom font may apply. */
type StyleLike = Pick<TextStyle, 'font' | 'bold' | 'italic'> & { family?: string; text?: string };

/**
 * The document or installed font this text will actually be set in, or null
 * for a standard PDF font. A custom font is only used once it's loaded and
 * has every character of the text; otherwise the standard fallback is shown
 * (and saved), so the screen never promises something the PDF can't do.
 */
export function activeFace(style: StyleLike): { family: Family; face: Face } | null {
  const family = getFamily(style.family);
  if (!family) return null;
  const face = pickFace(family, style.bold, style.italic);
  if (!face.fk) {
    if (!face.unusable) loadFace(family, face);
    return null;
  }
  return covers(face, style.text ?? '') ? { family, face } : null;
}

// Text layout shared by the canvas renderer, the inline editor and the PDF
// writer, so all three agree on where each line sits.
export const LINE_HEIGHT = 1.2;
/** Distance from the top of a line box to its baseline, as a fraction of size. */
export const BASELINE = 0.94;

const STANDARD = {
  // regular, bold, italic, bold italic (the names pdf-lib's StandardFonts uses)
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
} as unknown as Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]>;

const CSS_STACK: Record<FontFamily, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif',
  mono: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace',
};

export function standardFontName(style: Pick<TextStyle, 'font' | 'bold' | 'italic'>): StandardFonts {
  const variant = (style.bold ? 1 : 0) + (style.italic ? 2 : 0);
  return STANDARD[style.font][variant];
}

export function cssFont(style: StyleLike, sizePx: number): string {
  const custom = activeFace(style);
  const family = custom ? `"${custom.family.css}", ${CSS_STACK[style.font]}` : CSS_STACK[style.font];
  return `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : '400 '}${sizePx}px ${family}`;
}

export function cssFamily(font: FontFamily): string {
  return CSS_STACK[font];
}

// pdf-lib ships the Adobe metrics for the standard fonts. We embed them into a
// throwaway document once and reuse the PDFFont objects purely for measuring.
let metrics: Map<StandardFonts, PDFFont> | null = null;

let loading: Promise<void> | null = null;

/**
 * Loads exact widths for the standard PDF fonts. Called once the window is
 * up rather than before, and safe to call any number of times; until it
 * finishes, text is measured with the closest system font instead.
 */
export function loadFontMetrics(): Promise<void> {
  loading ??= import('pdf-lib').then(async ({ PDFDocument }) => {
    const doc = await PDFDocument.create();
    const next = new Map<StandardFonts, PDFFont>();
    for (const variants of Object.values(STANDARD)) {
      for (const name of variants) next.set(name, doc.embedStandardFont(name));
    }
    metrics = next;
  });
  return loading;
}

const measureCanvas = document.createElement('canvas').getContext('2d')!;

function fallbackWidth(style: StyleLike, line: string, size: number) {
  measureCanvas.font = cssFont({ ...style, family: undefined }, 100);
  return (measureCanvas.measureText(line).width / 100) * size;
}

/** True when every character can be written with the matching standard font. */
export function fitsStandardFont(style: Pick<TextStyle, 'font' | 'bold' | 'italic'>, text: string): boolean {
  const font = metrics?.get(standardFontName(style));
  if (!font) return false;
  try {
    font.encodeText(text.replace(/\n/g, ''));
    return true;
  } catch {
    return false;
  }
}

/** Width of one line of text in points. Pass `style.text` so custom fonts can be checked. */
export function lineWidth(style: StyleLike, line: string, size: number): number {
  const custom = activeFace(style);
  if (custom) return faceWidth(custom.face, line, size);
  const font = metrics?.get(standardFontName(style));
  if (font) {
    try {
      return font.widthOfTextAtSize(line, size);
    } catch {
      // characters outside WinAnsi; we'll embed a Unicode font for these
    }
  }
  return fallbackWidth(style, line, size);
}

export function textLines(text: string): string[] {
  return text.split('\n');
}

/** Horizontal shift of each line inside the block for the alignment. */
export function lineOffsets(style: TextStyle, blockWidth: number): number[] {
  const factor = style.align === 'center' ? 0.5 : style.align === 'right' ? 1 : 0;
  return textLines(style.text).map((line) => (factor ? (blockWidth - lineWidth(style, line, style.size)) * factor : 0));
}

/** Size of a block of text in its own (unrotated) frame, in points. */
export function measureText(style: TextStyle): { width: number; height: number } {
  const lines = textLines(style.text);
  let width = 0;
  for (const line of lines) width = Math.max(width, lineWidth(style, line, style.size));
  return { width: Math.max(width, style.size * 0.3), height: lines.length * style.size * LINE_HEIGHT };
}
