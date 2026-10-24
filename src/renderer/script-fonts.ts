// SPDX-License-Identifier: GPL-3.0-or-later
// Fonts for the world's writing systems.
//
// Text can mix scripts freely ("Invoice नंबर 42 فاتورة"). Each character is
// written with the first font that has it: the font the person chose, then
// the standard PDF fonts (for Western European letters), then the Noto font
// for the character's script. Most Noto fonts ship with the app; Chinese,
// Japanese and Korean download the first time they're needed.
//
// The same fonts are registered with the browser, limited to their script's
// characters (unicode-range), so the screen picks the same font for each
// character as the saved PDF does.

// fontkit's shapers for Indic and South-East Asian scripts were compiled
// expecting this helper to exist globally
import 'regenerator-runtime/runtime';
import { DOWNLOADED_SCRIPTS, type Script } from '../shared/languages';
import { Face, Family, loadFace, registerFamily } from './custom-fonts';

/** Scripts plus the fallback for symbols, arrows and the like. */
export type FontScript = Script | 'symbols';

/** Unicode blocks for each script (inclusive ranges). */
const RANGES: [FontScript, number, number][] = [
  ['latin', 0x0100, 0x024f], ['latin', 0x0250, 0x02af], ['latin', 0x0370, 0x03ff], ['latin', 0x0400, 0x052f],
  ['latin', 0x1c80, 0x1c8f], ['latin', 0x1e00, 0x1eff], ['latin', 0x1f00, 0x1fff], ['latin', 0x2c60, 0x2c7f],
  ['latin', 0x2de0, 0x2dff], ['latin', 0xa640, 0xa69f], ['latin', 0xa720, 0xa7ff], ['latin', 0x20a0, 0x20cf],
  ['armenian', 0x0530, 0x058f], ['armenian', 0xfb13, 0xfb17],
  ['hebrew', 0x0590, 0x05ff], ['hebrew', 0xfb1d, 0xfb4f],
  ['arabic', 0x0600, 0x06ff], ['arabic', 0x0750, 0x077f], ['arabic', 0x0870, 0x08ff], ['arabic', 0xfb50, 0xfdff], ['arabic', 0xfe70, 0xfeff],
  ['devanagari', 0x0900, 0x097f], ['devanagari', 0xa8e0, 0xa8ff], ['devanagari', 0x1cd0, 0x1cff],
  ['bengali', 0x0980, 0x09ff], ['gurmukhi', 0x0a00, 0x0a7f], ['gujarati', 0x0a80, 0x0aff], ['oriya', 0x0b00, 0x0b7f],
  ['tamil', 0x0b80, 0x0bff], ['telugu', 0x0c00, 0x0c7f], ['kannada', 0x0c80, 0x0cff], ['malayalam', 0x0d00, 0x0d7f],
  ['sinhala', 0x0d80, 0x0dff], ['thai', 0x0e00, 0x0e7f], ['lao', 0x0e80, 0x0eff],
  ['myanmar', 0x1000, 0x109f], ['myanmar', 0xa9e0, 0xa9ff], ['myanmar', 0xaa60, 0xaa7f],
  ['georgian', 0x10a0, 0x10ff], ['georgian', 0x1c90, 0x1cbf], ['georgian', 0x2d00, 0x2d2f],
  ['kr', 0x1100, 0x11ff], ['kr', 0x3130, 0x318f], ['kr', 0xa960, 0xa97f], ['kr', 0xac00, 0xd7ff],
  ['ethiopic', 0x1200, 0x139f], ['ethiopic', 0x2d80, 0x2ddf], ['ethiopic', 0xab00, 0xab2f],
  ['khmer', 0x1780, 0x17ff], ['khmer', 0x19e0, 0x19ff],
  ['jp', 0x3040, 0x30ff], ['jp', 0x31f0, 0x31ff], ['jp', 0xff65, 0xff9f],
  ['symbols', 0x2100, 0x2bff], ['symbols', 0x2e00, 0x2e7f],
];

/** Han (Chinese characters, used by all three) and shared CJK punctuation. */
const HAN: [number, number][] = [
  [0x2e80, 0x2fff], [0x3000, 0x303f], [0x3100, 0x312f], [0x31a0, 0x31bf], [0x31c0, 0x31ef], [0x3200, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff64], [0xffa0, 0xffef], [0x20000, 0x3ffff],
];

const inRanges = (cp: number, ranges: [number, number][]) => ranges.some(([a, b]) => cp >= a && cp <= b);

export type CharClass = FontScript | 'han' | 'mark' | 'common';

/** Which script a character belongs to, for choosing its font. */
export function classify(cp: number): CharClass {
  // combining marks and joiners stay with the letter before them
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff)) return 'mark';
  if (cp < 0x0100 || (cp >= 0x2000 && cp <= 0x206f)) return 'common';
  if (inRanges(cp, HAN)) return 'han';
  for (const [script, a, b] of RANGES) if (cp >= a && cp <= b) return script;
  return 'common';
}

// --- which CJK font Chinese characters use ------------------------------------------------

/** Han characters look different in Chinese, Japanese and Korean typography. */
export function hanScript(): 'sc' | 'tc' | 'jp' | 'kr' {
  try {
    const saved = localStorage.getItem('inkleaf.han');
    if (saved === 'sc' || saved === 'tc' || saved === 'jp' || saved === 'kr') return saved;
  } catch {
    // fall through
  }
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('ja')) return 'jp';
  if (lang.startsWith('ko')) return 'kr';
  if (/^zh-(tw|hk|mo|hant)/.test(lang)) return 'tc';
  return 'sc';
}

export function setHanScript(script: 'sc' | 'tc' | 'jp' | 'kr') {
  try {
    localStorage.setItem('inkleaf.han', script);
  } catch {
    // only remembered for this session
  }
}

// --- the font families -----------------------------------------------------------------------

/** Font file names (without -Regular.ttf) for each script. */
const FILES: Record<FontScript, string> = {
  latin: 'NotoSans', arabic: 'NotoSansArabic', hebrew: 'NotoSansHebrew', devanagari: 'NotoSansDevanagari',
  bengali: 'NotoSansBengali', gujarati: 'NotoSansGujarati', gurmukhi: 'NotoSansGurmukhi', tamil: 'NotoSansTamil',
  telugu: 'NotoSansTelugu', kannada: 'NotoSansKannada', malayalam: 'NotoSansMalayalam', oriya: 'NotoSansOriya',
  sinhala: 'NotoSansSinhala', thai: 'NotoSansThai', lao: 'NotoSansLao', khmer: 'NotoSansKhmer',
  myanmar: 'NotoSansMyanmar', ethiopic: 'NotoSansEthiopic', georgian: 'NotoSansGeorgian', armenian: 'NotoSansArmenian',
  sc: 'NotoSansSC', tc: 'NotoSansTC', jp: 'NotoSansJP', kr: 'NotoSansKR',
  symbols: 'DejaVuSans',
};

const hex = (n: number) => n.toString(16).toUpperCase();

function unicodeRange(script: FontScript): string {
  const ranges: [number, number][] = RANGES.filter((r) => r[0] === script).map((r) => [r[1], r[2]]);
  if (script === 'sc' || script === 'tc' || script === 'jp' || script === 'kr') ranges.push(...HAN);
  return ranges.map(([a, b]) => `U+${hex(a)}-${hex(b)}`).join(', ');
}

const families = new Map<FontScript, Family>();

/** True when a pack has to be downloaded before this script can be used. */
export const isDownloaded = (script: FontScript) => DOWNLOADED_SCRIPTS.has(script as Script);

/** Pack file names a script's fonts need. */
export function packFiles(script: FontScript): string[] {
  return isDownloaded(script) ? [`fonts/${FILES[script]}-Regular.ttf`, `fonts/${FILES[script]}-Bold.ttf`] : [];
}

function fetchBytes(url: string): Promise<Uint8Array> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
  }).then((b) => new Uint8Array(b));
}

export function scriptFamily(script: FontScript): Family {
  let family = families.get(script);
  if (family) return family;
  const base = FILES[script];
  const face = (style: string, bold: boolean, italic: boolean): Face => ({
    key: `script:${script}#${style}`,
    postscriptName: `${base}-${style}`,
    bold,
    italic,
    load: async () => {
      if (script === 'symbols') return fetchBytes('./assets/fonts/DejaVuSans.ttf');
      if (isDownloaded(script)) {
        const file = `fonts/${base}-${bold ? 'Bold' : 'Regular'}.ttf`;
        await window.inkleaf.ensurePacks([file]);
        return fetchBytes(`./packs/${file}`);
      }
      return fetchBytes(`./assets/fonts/noto/${base}-${style}.ttf`);
    },
  });
  const faces = script === 'symbols'
    ? [face('Regular', false, false)]
    : script === 'latin'
      ? [face('Regular', false, false), face('Bold', true, false), face('Italic', false, true), face('BoldItalic', true, true)]
      : [face('Regular', false, false), face('Bold', true, false)];
  family = { key: `script:${script}`, name: base, source: 'script', css: `ikscript-${script}`, faces, unicodeRange: unicodeRange(script) };
  families.set(script, family);
  registerFamily(family);
  return family;
}

/**
 * The face for a script in roughly the requested style, if it's loaded. If
 * it isn't, loading starts (and downloading, for CJK) and the caller gets
 * null for now; the screen redraws once it arrives.
 */
export function scriptFace(script: FontScript, bold: boolean, italic: boolean): Face | null {
  const family = scriptFamily(script);
  const score = (f: Face) => (f.bold === bold ? 0 : 2) + (f.italic === italic ? 0 : 1);
  const face = [...family.faces].sort((a, b) => score(a) - score(b))[0];
  if (face.fk) return face;
  void loadFace(family, face);
  return null;
}

/** Loads (downloading if needed) the face for a script and waits for it. */
export async function loadScriptFace(script: FontScript, bold: boolean, italic: boolean): Promise<Face | null> {
  const family = scriptFamily(script);
  const score = (f: Face) => (f.bold === bold ? 0 : 2) + (f.italic === italic ? 0 : 1);
  const face = [...family.faces].sort((a, b) => score(a) - score(b))[0];
  return face.fk ? face : loadFace(family, face);
}

/** CSS families for every script, for the end of a font stack. */
export function scriptCssStack(han: 'sc' | 'tc' | 'jp' | 'kr' = hanScript()): string {
  const order: FontScript[] = ['latin', 'arabic', 'hebrew', 'devanagari', 'bengali', 'gujarati', 'gurmukhi', 'tamil', 'telugu',
    'kannada', 'malayalam', 'oriya', 'sinhala', 'thai', 'lao', 'khmer', 'myanmar', 'ethiopic', 'georgian', 'armenian',
    han, 'sc', 'tc', 'jp', 'kr', 'symbols'];
  return [...new Set(order)].map((s) => `"ikscript-${s}"`).join(', ');
}
