// SPDX-License-Identifier: GPL-3.0-or-later
// Only types from pdf-lib here: the library itself is loaded on demand, so it
// doesn't slow down start-up.
import type { PDFFont, StandardFonts } from 'pdf-lib';
import bidiFactory from 'bidi-js';
import { covers, Face, Family, faceWidth, getFamily, loadFace, pickFace } from './custom-fonts';
import { CharClass, classify, FontScript, hanScript, loadScriptFace, scriptCssStack, scriptFace } from './script-fonts';
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
  // the chosen font first; then each script's font, which the browser only
  // uses for that script's characters; then the standard PDF font's look-alike
  const chosen = getFamily(style.family);
  const stack = `${chosen ? `"${chosen.css}", ` : ''}${scriptCssStack(hanFor(style.text ?? ''))}, ${CSS_STACK[style.font]}`;
  return `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : '400 '}${sizePx}px ${stack}`;
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
  if (custom && !needsShaping(line)) return faceWidth(custom.face, line, size);
  let total = 0;
  for (const run of lineRuns(style, line)) total += runWidth(style, run, size);
  return total;
}

// --- mixed scripts and right-to-left text ---------------------------------------------------
//
// A line is split into runs: stretches in one font and one direction. Fonts
// are picked per character (see script-fonts.ts), and the runs are put in
// visual order with the Unicode bidirectional algorithm, so Arabic and Hebrew
// read right to left while numbers and Latin words inside them don't.

export interface TextRun {
  text: string;
  /** null: the standard PDF font for the style. */
  face: Face | null;
  rtl: boolean;
  /** The face it should have, still loading; measured with a stand-in meanwhile. */
  pending?: FontScript;
}

const bidi = bidiFactory();

/** Characters the standard PDF fonts can write (WinAnsi). */
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
const winAnsi = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);

/** True when a line needs more than one font or the bidi algorithm. */
export function needsShaping(line: string): boolean {
  for (const ch of line) if (!winAnsi(ch.codePointAt(0)!)) return true;
  return false;
}

/** Japanese text uses Japanese forms of Chinese characters, Korean Korean ones. */
function hanFor(text: string): 'sc' | 'tc' | 'jp' | 'kr' {
  for (const ch of text) {
    const c = classify(ch.codePointAt(0)!);
    if (c === 'jp') return 'jp';
    if (c === 'kr') return 'kr';
  }
  return hanScript();
}

/** The face the person chose for this text, loaded, whatever it covers. */
function chosenFace(style: StyleLike): Face | null {
  const family = getFamily(style.family);
  if (!family) return null;
  const face = pickFace(family, style.bold, style.italic);
  if (!face.fk) {
    if (!face.unusable) loadFace(family, face);
    return null;
  }
  return face;
}

const runCache = new Map<string, TextRun[]>();

/** Splits a line into runs in visual (left to right) order. */
export function lineRuns(style: StyleLike, line: string): TextRun[] {
  if (!needsShaping(line)) {
    const custom = activeFace({ ...style, text: line });
    return [{ text: line, face: custom?.face ?? null, rtl: false }];
  }
  const chosen = chosenFace(style);
  const key = `${chosen?.key ?? ''}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}|${hanScript()}|${line}`;
  const cached = runCache.get(key);
  if (cached && !cached.some((r) => r.pending && scriptFace(r.pending, style.bold, style.italic))) return cached;

  const han = hanFor(line);
  const chars = Array.from(line);
  type Slot = { face: Face | null; pending?: FontScript };
  const slots: Slot[] = [];
  const pick = (cp: number, cls: CharClass): Slot => {
    if (chosen?.coverage?.has(cp)) return { face: chosen };
    if (winAnsi(cp)) return { face: null };
    const script: FontScript = cls === 'han' ? han : cls === 'common' || cls === 'mark' ? 'symbols' : cls;
    const order: FontScript[] = [script, 'symbols', 'latin'];
    for (const s of order) {
      const face = scriptFace(s, style.bold, style.italic);
      if (face?.coverage?.has(cp)) return { face };
      if (!face && s === script) return { face: null, pending: s };
    }
    // nothing has it: write it in the fallback font, which shows a box
    return { face: scriptFace('symbols', false, false), pending: scriptFace('symbols', false, false) ? undefined : 'symbols' };
  };
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)!;
    const cls = classify(cp);
    // marks and joiners belong with the letter before them
    if (cls === 'mark' && i > 0) slots.push(slots[i - 1]);
    else slots.push(pick(cp, cls));
  }

  // bidi levels are per UTF-16 unit; take each character's first unit
  const { levels } = bidi.getEmbeddingLevels(line);
  const charLevels: number[] = [];
  for (let i = 0, unit = 0; i < chars.length; unit += chars[i].length, i++) charLevels.push(levels[unit]);

  type Logical = { text: string; slot: Slot; level: number };
  const logical: Logical[] = [];
  chars.forEach((ch, i) => {
    const last = logical[logical.length - 1];
    if (last && last.slot.face === slots[i].face && last.slot.pending === slots[i].pending && last.level === charLevels[i]) last.text += ch;
    else logical.push({ text: ch, slot: slots[i], level: charLevels[i] });
  });

  // UAX #9 rule L2: from the highest level down to the lowest odd one,
  // reverse every stretch of runs at that level or higher
  const max = Math.max(...logical.map((r) => r.level));
  const minOdd = Math.min(...logical.map((r) => (r.level % 2 ? r.level : Infinity)));
  for (let level = max; level >= minOdd && level > 0; level--) {
    for (let i = 0; i < logical.length; ) {
      if (logical[i].level < level) { i++; continue; }
      let j = i;
      while (j < logical.length && logical[j].level >= level) j++;
      logical.splice(i, j - i, ...logical.slice(i, j).reverse());
      i = j;
    }
  }

  const runs = logical.map((r): TextRun => {
    const rtl = r.level % 2 === 1;
    // brackets and similar flip in right-to-left text
    let text = rtl ? Array.from(r.text).map((c) => bidi.getMirroredCharacter(c) ?? c).join('') : r.text;
    // the shaper puts right-to-left glyphs in visual order itself; the
    // standard fonts aren't shaped, so their characters are reversed here
    if (rtl && !r.slot.face) text = Array.from(text).reverse().join('');
    return { text, face: r.slot.face, rtl, pending: r.slot.pending };
  });
  if (runCache.size > 500) runCache.clear();
  runCache.set(key, runs);
  return runs;
}

const widthCache = new Map<string, number>();

type Fk = NonNullable<Face['fk']>;
export interface Shaped {
  glyphs: { id: number; advanceWidth: number; codePoints: number[] }[];
  positions: { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[];
  advanceWidth: number;
}

/** Shapes text with fontkit (the typings leave out its script and direction arguments). */
export function shape(fk: Fk, text: string, rtl: boolean): Shaped {
  const layout = fk.layout as unknown as (t: string, f?: unknown, s?: string, l?: string, d?: string) => Shaped;
  return layout.call(fk, text, undefined, undefined, undefined, rtl ? 'rtl' : 'ltr');
}

/** Width of a run in points. */
export function runWidth(style: StyleLike, run: TextRun, size: number): number {
  if (run.face?.fk) {
    const key = `${run.face.key}|${run.rtl ? 'r' : 'l'}|${run.text}`;
    let units = widthCache.get(key);
    if (units === undefined) {
      const fk = run.face.fk;
      units = shape(fk, run.text, run.rtl).advanceWidth / fk.unitsPerEm;
      if (widthCache.size > 2000) widthCache.clear();
      widthCache.set(key, units);
    }
    return units * size;
  }
  const font = metrics?.get(standardFontName(style));
  if (font && !run.pending) {
    try {
      return font.widthOfTextAtSize(run.text, size);
    } catch {
      // not WinAnsi after all; measure on screen instead
    }
  }
  return fallbackWidth(style, run.text, size);
}

/**
 * Loads every font a piece of text needs (downloading CJK fonts if
 * necessary), so measuring and saving it are exact.
 */
export async function prepareFonts(style: StyleLike, text: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pending = new Set<FontScript>();
    for (const line of textLines(text)) for (const run of lineRuns(style, line)) if (run.pending) pending.add(run.pending);
    if (!pending.size) return;
    await Promise.all([...pending].map((s) => loadScriptFace(s, style.bold, style.italic)));
  }
}

/** Base direction of a line: right to left if its first strong letter is. */
export function lineDirection(line: string): 'ltr' | 'rtl' {
  const { paragraphs } = bidi.getEmbeddingLevels(line);
  return paragraphs[0]?.level % 2 ? 'rtl' : 'ltr';
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
