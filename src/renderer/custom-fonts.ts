// SPDX-License-Identifier: GPL-3.0-or-later
// Fonts beyond the 14 built into every PDF reader: the ones embedded in the
// document you're editing, and the ones installed on this computer.
//
// A family (say "Calibri") has one or more faces (Regular, Bold, ...). Each
// face's font file is loaded on demand and used three ways: registered as a
// browser FontFace so the screen shows it, parsed with fontkit for exact
// glyph widths and coverage, and embedded into the PDF when you save.

import type { Font as FontkitFont } from '@pdf-lib/fontkit';

export interface Face {
  key: string;
  postscriptName: string;
  bold: boolean;
  italic: boolean;
  /** Fetches the font file. */
  load: () => Promise<Uint8Array>;
  // filled in once loaded
  bytes?: Uint8Array;
  fk?: FontkitFont;
  coverage?: Set<number>;
  /** Licence or format means it can't be put into a PDF. */
  unusable?: string;
}

export interface Family {
  /** 'doc:…' for fonts from a PDF, 'sys:…' for installed fonts, 'script:…' for Noto fonts. */
  key: string;
  name: string;
  source: 'document' | 'system' | 'script';
  /** CSS family the faces are registered under. */
  css: string;
  faces: Face[];
  /** Characters the browser may use this family for (CSS unicode-range). */
  unicodeRange?: string;
}

const families = new Map<string, Family>();
const loading = new Map<string, Promise<Face | null>>();
const listeners = new Set<() => void>();
let counter = 0;

type Fontkit = { create(data: Uint8Array, postscriptName?: string): FontkitFont & { fonts?: unknown[] } };
let fontkitModule: Promise<Fontkit> | null = null;
const fontkit = () => (fontkitModule ??= import('@pdf-lib/fontkit').then((m) => (m.default ?? m) as unknown as Fontkit));

/**
 * fontkit stumbles over mark anchors that are deliberately empty (an
 * OpenType font may say "this mark doesn't attach to that letter"); some
 * fonts, such as Noto Sans Gurmukhi, have them. Empty anchors are skipped
 * instead. The class isn't exported, so it's patched through the first font
 * that uses it.
 */
let anchorsPatched = false;
export function patchFontkit(fk: FontkitFont) {
  if (anchorsPatched) return;
  type Gpos = { applyAnchor(m: { markAnchor?: unknown }, base: unknown, i: number): void; getAnchor(a: unknown): { x: number; y: number } };
  try {
    (fk as unknown as { layout(t: string): unknown }).layout('a');
    const gpos = (fk as unknown as { _layoutEngine?: { engine?: { GPOSProcessor?: Gpos } } })._layoutEngine?.engine?.GPOSProcessor;
    if (!gpos) return;
    const proto = Object.getPrototypeOf(gpos) as Gpos;
    const applyAnchor = proto.applyAnchor;
    const getAnchor = proto.getAnchor;
    proto.applyAnchor = function (mark, base, i) {
      if (!base || !mark?.markAnchor) return;
      applyAnchor.call(this, mark, base, i);
    };
    proto.getAnchor = function (anchor) {
      return anchor ? getAnchor.call(this, anchor) : { x: 0, y: 0 };
    };
    anchorsPatched = true;
  } catch {
    // a font without a usable GPOS table: try with the next one
  }
}

export function onFontsChanged(fn: () => void) {
  listeners.add(fn);
}

function changed() {
  listeners.forEach((fn) => fn());
}

export function getFamily(key: string | undefined | null): Family | undefined {
  return key ? families.get(key) : undefined;
}

/** Families offered in the font list (script fonts work behind the scenes). */
export function allFamilies(): Family[] {
  return [...families.values()].filter((f) => f.source !== 'script');
}

export function registerFamily(family: Family) {
  families.set(family.key, family);
}

/** The face that best matches the requested weight and slant. */
export function pickFace(family: Family, bold: boolean, italic: boolean): Face {
  const score = (f: Face) => (f.bold === bold ? 0 : 2) + (f.italic === italic ? 0 : 1);
  return [...family.faces].sort((a, b) => score(a) - score(b))[0];
}

/** Loads a face's file, registers it for display and parses it for metrics. */
export function loadFace(family: Family, face: Face): Promise<Face | null> {
  let pending = loading.get(face.key);
  if (!pending) {
    pending = (async () => {
      try {
        const bytes = await face.load();
        const kit = await fontkit();
        // (no PostScript name here: fontkit only accepts one for collections)
        const fk = kit.create(bytes) as FontkitFont & { fonts?: unknown[] };
        if (fk.fonts) {
          // a .ttc collection: we'd need to split it out before embedding
          face.unusable = 'This font is stored in a collection file that can’t be embedded in a PDF.';
          return null;
        }
        // OS/2 fsType bit 1: the font's licence forbids embedding it
        const fsType = (fk as unknown as { 'OS/2'?: { fsType?: number } })['OS/2']?.fsType ?? 0;
        if ((fsType & 0x000f) === 0x0002) {
          face.unusable = 'This font’s licence doesn’t allow embedding it in a PDF.';
          return null;
        }
        patchFontkit(fk);
        face.bytes = bytes;
        face.fk = fk;
        face.coverage = new Set(fk.characterSet);
        const css = new FontFace(family.css, bytes as BufferSource, {
          weight: face.bold ? '700' : '400',
          style: face.italic ? 'italic' : 'normal',
          ...(family.unicodeRange ? { unicodeRange: family.unicodeRange } : {}),
        });
        await css.load();
        document.fonts.add(css);
        changed();
        return face;
      } catch (err) {
        console.warn('font failed to load', face.postscriptName, err);
        if (family.source === 'script') {
          // usually a download that failed (offline?): try again later
          setTimeout(() => loading.delete(face.key), 20_000);
          return null;
        }
        face.unusable = 'This font couldn’t be read.';
        return null;
      }
    })();
    loading.set(face.key, pending);
  }
  return pending;
}

/** True when every character of `text` has a glyph in the face. */
export function covers(face: Face, text: string): boolean {
  if (!face.coverage) return false;
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue;
    if (!face.coverage.has(ch.codePointAt(0)!)) return false;
  }
  return true;
}

/** Width of one line in points, from the font's own advance widths. */
export function faceWidth(face: Face, line: string, size: number): number {
  const fk = face.fk!;
  const run = fk.layout(line);
  return (run.advanceWidth / fk.unitsPerEm) * size;
}

// --- fonts embedded in the document ---------------------------------------------------

function stripSubset(name: string) {
  return name.replace(/^[A-Z]{6}\+/, '');
}

function prettyName(postscript: string) {
  // "Calibri-BoldItalic" → "Calibri", "TimesNewRomanPSMT" → "Times New Roman"
  return stripSubset(postscript)
    .replace(/[-,](Bold|Italic|Oblique|Regular|Roman|Medium|Light|Semibold|SemiBold|Black|Heavy|Book)+.*$/i, '')
    .replace(/(PSMT|PS|MT)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim() || postscript;
}

/**
 * A font embedded in the PDF, offered for reuse only if it's safe: its
 * character map must be Unicode (some PDF makers map their own private codes
 * instead, which would turn typing into gibberish), and it must reproduce the
 * original line's letters at the original widths.
 */
export async function documentFont(
  srcId: string,
  postscriptName: string,
  fetchFile: () => Promise<Uint8Array>,
  check: { text: string; width: number; size: number },
  style: { bold: boolean; italic: boolean },
): Promise<Family | null> {
  const key = `doc:${srcId}:${stripSubset(postscriptName)}`;
  let family = families.get(key);
  if (!family) {
    family = {
      key,
      name: prettyName(postscriptName),
      source: 'document',
      css: `ikdoc${++counter}`,
      faces: [{ key: `${key}#0`, postscriptName: '', bold: style.bold, italic: style.italic, load: fetchFile }],
    };
    families.set(key, family);
  }
  const face = await loadFace(family, family.faces[0]);
  if (!face?.fk) return null;
  // the file knows its own proper name better than we can guess it
  const own = (face.fk as unknown as { familyName?: string }).familyName;
  if (own) family.name = own;

  const tables = ((face.fk as unknown as { cmap?: { tables?: { platformID: number; encodingID: number }[] } }).cmap?.tables) ?? [];
  const unicode = tables.some((t) => t.platformID === 0 || (t.platformID === 3 && (t.encodingID === 1 || t.encodingID === 10)));
  if (!unicode || !covers(face, check.text)) return null;
  const width = faceWidth(face, check.text, check.size);
  if (check.width > 0 && Math.abs(width - check.width) / check.width > 0.04) return null;
  return family;
}

// --- fonts installed on this computer -----------------------------------------------------

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

let systemList: Promise<Family[]> | null = null;

/** Families installed on this computer. Needs a click to have started it. */
export function systemFamilies(): Promise<Family[]> {
  systemList ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
    if (!query) return [];
    let fonts: LocalFontData[];
    try {
      fonts = await query.call(window);
    } catch (err) {
      console.warn('local fonts unavailable', err);
      systemList = null; // allow another try later
      return [];
    }
    const byFamily = new Map<string, LocalFontData[]>();
    for (const f of fonts) {
      const list = byFamily.get(f.family) ?? [];
      list.push(f);
      byFamily.set(f.family, list);
    }
    const result: Family[] = [];
    for (const [name, list] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const key = `sys:${name}`;
      let family = families.get(key);
      if (!family) {
        family = {
          key,
          name,
          source: 'system',
          css: `iksys${++counter}`,
          faces: list.map((f) => ({
            key: `${key}#${f.postscriptName}`,
            postscriptName: f.postscriptName,
            bold: /bold|black|heavy|semibold|demibold/i.test(f.style),
            italic: /italic|oblique/i.test(f.style),
            load: async () => new Uint8Array(await (await f.blob()).arrayBuffer()),
          })),
        };
        // drop odd weights (Light, Thin…) unless that's all there is
        const plain = family.faces.filter((f) => {
          const style = list.find((x) => x.postscriptName === f.postscriptName)!.style;
          return /^(regular|normal|book|roman|bold|italic|oblique|bold italic|bold oblique)$/i.test(style.trim());
        });
        if (plain.length) family.faces = plain;
        families.set(key, family);
      }
      result.push(family);
    }
    return result;
  })();
  return systemList;
}
