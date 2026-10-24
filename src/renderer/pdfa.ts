// SPDX-License-Identifier: GPL-3.0-or-later
// PDF → PDF/A-2b, the ISO standard for keeping documents readable for decades.
//
// A PDF/A file has to carry everything it needs inside itself. In practice
// that means:
//
// - Every font is embedded. Most PDFs lean on the "standard" fonts
//   (Helvetica, Times, Courier, and Arial and friends) being on the reader's
//   computer. Those are swapped for the Liberation fonts, which have exactly
//   the same letter widths, so nothing on the page moves.
// - Colours are tied to a known colour space (an sRGB "output intent").
// - The document describes itself in XMP metadata, including the claim that
//   it's PDF/A-2b, matching its ordinary document properties.
// - Nothing can run or reach outside: no JavaScript, no launch actions, no
//   attached files, every comment and field has a fixed appearance.
//
// Anything that can't be fixed here (a non-standard font that was never
// embedded, say) is reported rather than hidden.

import { t } from '../shared/i18n';
import type { PDFContext, PDFDict as PDFDictType, PDFDocument as PDFDocumentType, PDFName as PDFNameType, PDFNumber as PDFNumberType, PDFRef as PDFRefType } from 'pdf-lib';

type Lib = typeof import('pdf-lib');
type Fontkit = { create(data: Uint8Array): FontkitFont };
interface FontkitFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  numGlyphs: number;
  glyphForCodePoint(cp: number): { id: number; advanceWidth: number };
  getGlyph(id: number): { name?: string; advanceWidth: number };
}

export interface PdfAResult {
  bytes: Uint8Array;
  /** Things that may stop the file passing a strict validator. */
  warnings: string[];
  fontsEmbedded: number;
}

/** Windows-1252 codes 128–159, which differ from Latin-1. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const winAnsi = (code: number) => WIN_ANSI_HIGH[code] ?? code;

type Family = 'Sans' | 'Serif' | 'Mono';
type Style = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';

/** Which Liberation font stands in for a standard (or very common) font name. */
export function liberationFor(baseFont: string): { family: Family; style: Style } | null {
  const name = baseFont.replace(/^[A-Z]{6}\+/, '');
  const family: Family | null =
    /^(Helvetica|Arial|ArialMT|Arial-|Arial,|Liberation ?Sans|Arimo)/i.test(name) ? 'Sans'
      : /^(Times|TimesNewRoman|Times New Roman|Liberation ?Serif|Tinos)/i.test(name) ? 'Serif'
        : /^(Courier|CourierNew|Courier New|Liberation ?Mono|Cousine)/i.test(name) ? 'Mono'
          : null;
  if (!family) return null;
  const bold = /bold|black|heavy/i.test(name);
  const italic = /italic|oblique/i.test(name);
  return { family, style: bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular' };
}

/** "Times-Roman" with no style words → Regular; for readable names in warnings. */
const nameOf = (lib: Lib, dict: PDFDictType) => dict.lookupMaybe(lib.PDFName.of('BaseFont'), lib.PDFName)?.decodeText() ?? 'unnamed';

class FontEmbedder {
  private files = new Map<string, { ref: PDFRefType; fk: FontkitFont; byName: Map<string, number> | null }>();

  constructor(private lib: Lib, private ctx: PDFContext, private fontkit: Fontkit) {}

  private async load(family: Family, style: Style) {
    const key = `${family}-${style}`;
    let entry = this.files.get(key);
    if (!entry) {
      const bytes = new Uint8Array(await (await fetch(`./assets/fonts/liberation/Liberation${family}-${style}.ttf`)).arrayBuffer());
      const fk = this.fontkit.create(bytes);
      const stream = this.ctx.flateStream(bytes, { Length1: bytes.length });
      entry = { ref: this.ctx.register(stream), fk, byName: null };
      this.files.set(key, entry);
    }
    return entry;
  }

  /** Glyph names → ids, for fonts whose encoding lists glyphs by name. */
  private names(entry: { fk: FontkitFont; byName: Map<string, number> | null }) {
    if (!entry.byName) {
      entry.byName = new Map();
      for (let id = 0; id < entry.fk.numGlyphs; id++) {
        const name = entry.fk.getGlyph(id).name;
        if (name) entry.byName.set(name, id);
      }
    }
    return entry.byName;
  }

  /**
   * Turns a standard Type 1 font reference into an embedded TrueType font with
   * the same name-to-letter mapping and widths that match the embedded file.
   */
  async embed(dict: PDFDictType, pick: { family: Family; style: Style }) {
    const { PDFName, PDFArray, PDFNumber } = this.lib;
    const entry = await this.load(pick.family, pick.style);
    const fk = entry.fk;
    const scale = 1000 / fk.unitsPerEm;
    const fontName = `Liberation${pick.family}-${pick.style}`;

    // codes → widths, through the font's encoding (and any Differences)
    const encoding = dict.lookup(PDFName.of('Encoding'));
    const differences = new Map<number, string>();
    if (encoding instanceof this.lib.PDFDict) {
      const diffs = encoding.lookupMaybe(PDFName.of('Differences'), PDFArray);
      let code = 0;
      for (let i = 0; diffs && i < diffs.size(); i++) {
        const v = diffs.lookup(i);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) differences.set(code++, v.decodeText());
      }
    }
    const widths: number[] = [];
    for (let code = 0; code <= 255; code++) {
      const glyphName = differences.get(code);
      let id: number | undefined;
      if (glyphName) id = this.names(entry).get(glyphName);
      const glyph = id !== undefined ? fk.getGlyph(id) : fk.glyphForCodePoint(winAnsi(code));
      widths.push(Math.round(glyph.advanceWidth * scale));
    }

    const flags = (pick.family === 'Mono' ? 1 : 0) | (pick.family === 'Serif' ? 2 : 0) | 32 | (pick.style.includes('Italic') ? 64 : 0);
    const descriptor = this.ctx.obj({
      Type: 'FontDescriptor',
      FontName: fontName,
      Flags: flags,
      FontBBox: [fk.bbox.minX, fk.bbox.minY, fk.bbox.maxX, fk.bbox.maxY].map((v) => Math.round(v * scale)),
      ItalicAngle: fk.italicAngle,
      Ascent: Math.round(fk.ascent * scale),
      Descent: Math.round(fk.descent * scale),
      CapHeight: Math.round(fk.capHeight * scale),
      StemV: pick.style.includes('Bold') ? 140 : 80,
      FontFile2: entry.ref,
    });
    dict.set(PDFName.of('Subtype'), PDFName.of('TrueType'));
    dict.set(PDFName.of('BaseFont'), PDFName.of(fontName));
    dict.set(PDFName.of('FirstChar'), this.ctx.obj(0));
    dict.set(PDFName.of('LastChar'), this.ctx.obj(255));
    dict.set(PDFName.of('Widths'), this.ctx.obj(widths));
    dict.set(PDFName.of('FontDescriptor'), this.ctx.register(descriptor));
    // a plain name encoding other than WinAnsi/MacRoman isn't allowed for
    // TrueType in PDF/A; Standard encoding text is the same for ASCII
    if (!(encoding instanceof this.lib.PDFDict)) {
      const named = encoding instanceof PDFName ? encoding.decodeText() : '';
      if (named !== 'MacRomanEncoding') dict.set(PDFName.of('Encoding'), PDFName.of('WinAnsiEncoding'));
    } else if (!encoding.get(PDFName.of('BaseEncoding'))) {
      encoding.set(PDFName.of('BaseEncoding'), PDFName.of('WinAnsiEncoding'));
    }
  }

  /** Adds the font file to a TrueType font that has metrics but no file. */
  async attach(descriptor: PDFDictType, pick: { family: Family; style: Style }) {
    const entry = await this.load(pick.family, pick.style);
    descriptor.set(this.lib.PDFName.of('FontFile2'), entry.ref);
  }
}

/** The XMP packet stating PDF/A-2b, matching the document information. */
function xmp(info: { title: string; author: string; created: Date; modified: Date }): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(info.title)}</rdf:li></rdf:Alt></dc:title>
${info.author ? `   <dc:creator><rdf:Seq><rdf:li>${esc(info.author)}</rdf:li></rdf:Seq></dc:creator>\n` : ''}   <xmp:CreatorTool>Inkleaf</xmp:CreatorTool>
   <xmp:CreateDate>${iso(info.created)}</xmp:CreateDate>
   <xmp:ModifyDate>${iso(info.modified)}</xmp:ModifyDate>
   <xmp:MetadataDate>${iso(info.modified)}</xmp:MetadataDate>
   <pdf:Producer>Inkleaf</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** A fixed appearance for a sticky note: PDF/A won't let readers draw their own. */
function noteAppearance(lib: Lib, ctx: PDFContext, annot: PDFDictType): PDFRefType {
  const rect = annot.lookupMaybe(lib.PDFName.of('Rect'), lib.PDFArray);
  const nums = rect ? [0, 1, 2, 3].map((i) => (rect.lookup(i) as PDFNumberType).asNumber()) : [0, 0, 20, 20];
  const w = Math.abs(nums[2] - nums[0]) || 20, h = Math.abs(nums[3] - nums[1]) || 20;
  const c = annot.lookupMaybe(lib.PDFName.of('C'), lib.PDFArray);
  const rgb = c && c.size() === 3 ? [0, 1, 2].map((i) => (c.lookup(i) as PDFNumberType).asNumber()) : [1, 0.82, 0.4];
  const k = (v: number) => v.toFixed(3);
  // a rounded card with three lines, like the note icon on screen
  const content = `q ${k(rgb[0])} ${k(rgb[1])} ${k(rgb[2])} rg 0.35 0.35 0.35 RG 0.6 w
${(w * 0.08).toFixed(2)} ${(h * 0.25).toFixed(2)} ${(w * 0.84).toFixed(2)} ${(h * 0.67).toFixed(2)} re B
0.3 0.3 0.3 rg ${(w * 0.22).toFixed(2)} ${(h * 0.7).toFixed(2)} ${(w * 0.56).toFixed(2)} ${(h * 0.05).toFixed(2)} re f
${(w * 0.22).toFixed(2)} ${(h * 0.56).toFixed(2)} ${(w * 0.56).toFixed(2)} ${(h * 0.05).toFixed(2)} re f
${(w * 0.22).toFixed(2)} ${(h * 0.42).toFixed(2)} ${(w * 0.36).toFixed(2)} ${(h * 0.05).toFixed(2)} re f Q`;
  const stream = ctx.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] });
  return ctx.register(stream);
}

export async function toPdfA(input: Uint8Array, title: string): Promise<PdfAResult> {
  const lib = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default as unknown as Fontkit;
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFNumber, PDFStream } = lib;
  const doc: PDFDocumentType = await PDFDocument.load(input, { updateMetadata: false });
  const ctx = doc.context;
  const warnings = new Set<string>();
  const embedder = new FontEmbedder(lib, ctx, fontkit);
  let fontsEmbedded = 0;
  const N = (s: string) => PDFName.of(s);

  // 1. fonts
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.lookupMaybe(N('Type'), PDFName)?.decodeText() !== 'Font') continue;
    const subtype = obj.lookupMaybe(N('Subtype'), PDFName)?.decodeText();
    if (subtype === 'Type0' || subtype === 'Type3') {
      if (subtype === 'Type0') {
        const kid = obj.lookupMaybe(N('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
        const fd = kid?.lookupMaybe(N('FontDescriptor'), PDFDict);
        if (fd && !fd.get(N('FontFile2')) && !fd.get(N('FontFile3')) && !fd.get(N('FontFile'))) {
          warnings.add(t('The font “{font}” isn’t embedded and can’t be replaced, so the file may not pass a strict PDF/A check.', { font: nameOf(lib, obj) }));
        }
      }
      continue;
    }
    const descriptor = obj.lookupMaybe(N('FontDescriptor'), PDFDict);
    const hasFile = descriptor && (descriptor.get(N('FontFile')) || descriptor.get(N('FontFile2')) || descriptor.get(N('FontFile3')));
    if (hasFile) continue;
    const base = nameOf(lib, obj);
    const pick = liberationFor(base);
    if (!pick) {
      warnings.add(t('The font “{font}” isn’t embedded in the original and has no free equivalent, so the file may not pass a strict PDF/A check.', { font: base }));
      continue;
    }
    if (descriptor && subtype === 'TrueType') await embedder.attach(descriptor, pick);
    else await embedder.embed(obj, pick);
    fontsEmbedded++;
  }

  // 2. nothing that runs or reaches outside
  const catalog = doc.catalog;
  for (const key of ['OpenAction', 'AA']) {
    const action = catalog.lookup(N(key));
    if (action) catalog.delete(N(key));
  }
  const names = catalog.lookupMaybe(N('Names'), PDFDict);
  if (names?.get(N('JavaScript'))) names.delete(N('JavaScript'));
  if (names?.get(N('EmbeddedFiles'))) {
    names.delete(N('EmbeddedFiles'));
    warnings.add(t('Files attached inside the PDF were removed: PDF/A-2 can’t carry them.'));
  }
  const form = catalog.lookupMaybe(N('AcroForm'), PDFDict);
  if (form) {
    form.delete(N('NeedAppearances'));
    form.delete(N('XFA'));
  }

  // 3. comments and fields: always printed, never hidden, with a fixed look
  for (const page of doc.getPages()) {
    page.node.delete(N('AA'));
    // slide-show transitions mean nothing in an archive, and validators can't check them
    page.node.delete(N('Trans'));
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    for (let i = annots ? annots.size() - 1 : -1; i >= 0; i--) {
      const annot = annots!.lookupMaybe(i, PDFDict);
      if (!annot) continue;
      const kind = annot.lookupMaybe(N('Subtype'), PDFName)?.decodeText();
      const action = annot.lookupMaybe(N('A'), PDFDict);
      const actionType = action?.lookupMaybe(N('S'), PDFName)?.decodeText();
      if (actionType && ['JavaScript', 'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView'].includes(actionType)) annot.delete(N('A'));
      annot.delete(N('AA'));
      if (kind && ['Sound', 'Movie', 'Screen', '3D', 'RichMedia', 'FileAttachment'].includes(kind)) {
        annots!.remove(i);
        continue;
      }
      if (kind === 'Popup') continue;
      // flags: Print on; Invisible, Hidden, NoView, ToggleNoView off
      const flags = annot.lookupMaybe(N('F'), PDFNumber)?.asNumber() ?? 0;
      annot.set(N('F'), ctx.obj((flags | 4) & ~(1 | 2 | 32 | 256)));
      if (kind !== 'Link' && !annot.get(N('AP'))) {
        if (kind === 'Text') annot.set(N('AP'), ctx.obj({ N: noteAppearance(lib, ctx, annot) }));
        else warnings.add(`A “${kind}” annotation has no fixed appearance, so the file may not pass a strict PDF/A check.`);
      }
      // PDF/A allows one appearance only: drop rollover and pressed looks
      const ap = annot.lookupMaybe(N('AP'), PDFDict);
      ap?.delete(N('R'));
      ap?.delete(N('D'));
    }
  }

  // 4. colour: an sRGB output intent
  const icc = new Uint8Array(await (await fetch('./assets/icc/sRGB.icc')).arrayBuffer());
  const profile = ctx.register(ctx.flateStream(icc, { N: 3 }));
  catalog.set(N('OutputIntents'), ctx.obj([{
    Type: 'OutputIntent', S: 'GTS_PDFA1',
    OutputConditionIdentifier: lib.PDFString.of('sRGB IEC61966-2.1'),
    Info: lib.PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: lib.PDFString.of('http://www.color.org'),
    DestOutputProfile: profile,
  }]));

  // 5. metadata: document info and matching XMP
  const now = new Date();
  const author = doc.getAuthor() ?? '';
  const docTitle = doc.getTitle() || title;
  const created = doc.getCreationDate() ?? now;
  // only keys XMP repeats may stay in the info dictionary
  const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDictType | undefined;
  for (const key of ['Subject', 'Keywords', 'Creator', 'Trapped']) info?.delete(N(key));
  doc.setTitle(docTitle, { showInWindowTitleBar: true });
  if (author) doc.setAuthor(author);
  doc.setProducer('Inkleaf');
  doc.setCreationDate(created);
  doc.setModificationDate(now);
  // XMP must be UTF-8; a plain string would be written byte-per-character
  const meta = ctx.stream(new TextEncoder().encode(xmp({ title: docTitle, author, created, modified: now })), { Type: 'Metadata', Subtype: 'XML' });
  catalog.set(N('Metadata'), ctx.register(meta));
  catalog.set(N('MarkInfo'), ctx.obj({ Marked: false }));

  // 6. a permanent file identifier
  const id = PDFHexString.of(Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
  ctx.trailerInfo.ID = ctx.obj([id, id]);

  // transparency is fine in PDF/A-2, but every stream must be readable
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const filter = obj.dict.lookup(N('Filter'));
      const names2 = filter instanceof PDFArray ? Array.from({ length: filter.size() }, (_, i) => (filter.lookup(i) as PDFNameType).decodeText()) : filter instanceof PDFName ? [filter.decodeText()] : [];
      if (names2.includes('LZWDecode')) warnings.add(t('Some content uses old LZW compression, which PDF/A doesn’t allow.'));
    }
  }

  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes, warnings: [...warnings], fontsEmbedded };
}
