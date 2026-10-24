// SPDX-License-Identifier: GPL-3.0-or-later
import fontkit from '@pdf-lib/fontkit';
import {
  BlendMode,
  degrees,
  LineCapStyle,
  PDFContentStream,
  popGraphicsState,
  pushGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  setTextRenderingMode,
  TextRenderingMode,
  PDFName,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFString,
  PDFRef,
  PDFOperator,
  StandardFonts,
  PDFRawStream,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFFont,
  PDFImage,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFTextField,
  rgb,
  RGB,
} from 'pdf-lib';
import { core, RedactJob } from './core';
import type { EditorDoc } from './document';
import { getFamily } from './custom-fonts';
import {
  activeFace, BASELINE, fitsStandardFont, LINE_HEIGHT, lineOffsets, lineRuns, lineWidth, loadFontMetrics, measureText,
  needsShaping, prepareFonts, runWidth, shape, standardFontName, textLines, TextRun,
} from './fonts';
import type { Face } from './custom-fonts';
import { frameToUser, imageLocalSize, rotateVec } from './geometry';
import { decorTexts } from './decor';
import { arrowHead, STAMP_BASELINE, stampLayout, TEXT_PAD, UNDERLINE_OFFSET, UNDERLINE_THICKNESS } from './render';
import type { Annot, FieldAnnot, NoteAnnot, OutlineItem, PageRef, StampAnnot, TextStyle } from './types';

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

function color(hex: string): RGB {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * A ready-made block of content-stream text that pdf-lib can place among its
 * own operators. pdf-lib only asks an operator for its size and bytes, so a
 * whole pen stroke can travel as one object instead of hundreds. It's built
 * on pdf-lib's operator prototype so pdf-lib's type checks accept it.
 */
function rawOperators(text: string): PDFOperator {
  const bytes = new TextEncoder().encode(text);
  const op = Object.create(PDFOperator.prototype) as PDFOperator & Record<string, unknown>;
  Object.assign(op, {
    name: 'raw',
    args: [],
    sizeInBytes: () => bytes.length,
    copyBytesInto: (buffer: Uint8Array, offset: number) => {
      buffer.set(bytes, offset);
      return bytes.length;
    },
    clone: () => op,
    toString: () => text,
  });
  return op;
}

/** Short number formatting: 0.1 pt is far finer than anyone can see. */
const n1 = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * A pen stroke as PDF drawing commands: the same midpoint-smoothed curve the
 * screen draws, with each quadratic segment written as the equivalent cubic.
 * Writing the commands directly is several times faster than handing pdf-lib
 * an SVG path to parse.
 */
function inkOperators(points: [number, number][], c: RGB, width: number): PDFOperator {
  let out = `q ${n3(c.red)} ${n3(c.green)} ${n3(c.blue)} RG ${n3(width)} w 1 J 1 j ${n1(points[0][0])} ${n1(points[0][1])} m`;
  if (points.length === 1) {
    out += ` ${n1(points[0][0] + 0.01)} ${n1(points[0][1])} l`;
  } else {
    let [px, py] = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      const [cx, cy] = points[i];
      const ex = (cx + points[i + 1][0]) / 2, ey = (cy + points[i + 1][1]) / 2;
      // quadratic (p, c, e) as a cubic: control points 2/3 of the way to c
      out += `\n${n1(px + (2 / 3) * (cx - px))} ${n1(py + (2 / 3) * (cy - py))} ${n1(ex + (2 / 3) * (cx - ex))} ${n1(ey + (2 / 3) * (cy - ey))} ${n1(ex)} ${n1(ey)} c`;
      px = ex;
      py = ey;
    }
    const last = points[points.length - 1];
    out += `\n${n1(last[0])} ${n1(last[1])} l`;
  }
  return rawOperators(`${out} S Q`);
}

/** Pen strokes as an SVG path in pdf-lib's flipped-y convention. */
function strokePath(points: [number, number][]): string {
  const p = (x: number, y: number) => `${x.toFixed(2)} ${(-y).toFixed(2)}`;
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${p(x, y)} L ${p(x + 0.01, y)}`;
  }
  let d = `M ${p(...points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q ${p(x, y)} ${p((x + nx) / 2, (y + ny) / 2)}`;
  }
  return d + ` L ${p(...points[points.length - 1])}`;
}

/** The parts of pdf-lib's font embedder that shaped text works with. */
type ShapedEmbedder = {
  font: Parameters<typeof shape>[0];
  used: Map<number, { id: number }>;
  glyphCache: { access(): unknown[]; invalidate(): void };
  serializeFont(): Promise<Uint8Array>;
};

/** Everything that needs per-file caching while one PDF is being written. */
class Writer {
  private fonts = new Map<string, PDFFont>();
  private custom = new Map<string, PDFFont>();
  private unicode: PDFFont | null = null;
  private images = new Map<string, PDFImage>();
  readonly warnings = new Set<string>();

  constructor(private out: PDFDocument, private doc: EditorDoc) {}

  async unicodeFont(): Promise<PDFFont> {
    if (!this.unicode) {
      const bytes = await (await fetch('./assets/fonts/DejaVuSans.ttf')).arrayBuffer();
      this.unicode = await this.out.embedFont(bytes, { subset: true });
    }
    return this.unicode;
  }

  /**
   * The font to write `style` in, and whether bold or italic has to be
   * imitated because the chosen face doesn't come in that style.
   */
  async font(style: TextStyle): Promise<{ font: PDFFont; fakeBold: boolean; fakeItalic: boolean }> {
    const custom = activeFace(style);
    if (custom?.face.bytes) {
      let embedded = this.custom.get(custom.face.key);
      if (!embedded) {
        embedded = await this.out.embedFont(custom.face.bytes, { subset: true });
        this.custom.set(custom.face.key, embedded);
      }
      return { font: embedded, fakeBold: style.bold && !custom.face.bold, fakeItalic: style.italic && !custom.face.italic };
    }
    if (style.family) {
      const family = getFamily(style.family);
      this.warnings.add(`Some text couldn’t use ${family?.name ?? 'its chosen font'} (it doesn’t have every letter typed), so it was saved in a standard font.`);
    }
    return { font: await this.standardFont(style), fakeBold: false, fakeItalic: false };
  }

  private async standardFont(style: TextStyle): Promise<PDFFont> {
    if (!fitsStandardFont(style, style.text)) {
      if (style.bold || style.italic || style.font !== 'sans') {
        this.warnings.add('Some text uses characters the built-in PDF fonts can’t show, so it was saved in DejaVu Sans instead.');
      }
      return this.unicodeFont();
    }
    const name = standardFontName(style);
    if (!this.fonts.has(name)) this.fonts.set(name, await this.out.embedFont(name));
    return this.fonts.get(name)!;
  }

  async standard(name: StandardFonts): Promise<PDFFont> {
    if (!this.fonts.has(name)) this.fonts.set(name, await this.out.embedFont(name));
    return this.fonts.get(name)!;
  }

  /**
   * Text that mixes fonts or directions (any script beyond Western European
   * letters): each line is drawn run by run, in visual order, with complex
   * scripts shaped glyph by glyph.
   */
  private async drawMixedText(page: PDFPage, a: Annot & TextStyle & { x: number; y: number; angle: number }) {
    const lines = textLines(a.text);
    const { width, height } = measureText(a);
    const offsets = lineOffsets(a, width);
    const opacity = a.opacity ?? 1;
    const ink = color(a.color);
    if (a.background) {
      const pad = a.size * TEXT_PAD;
      const [x, y] = frameToUser(a, -pad, height + pad);
      page.drawRectangle({ x, y, width: width + pad * 2, height: height + pad * 2, color: color(a.background), opacity, rotate: degrees(a.angle) });
    }
    let missing = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const baseline = i * a.size * LINE_HEIGHT + a.size * BASELINE;
      let cursor = offsets[i];
      for (const run of lineRuns(a, lines[i])) {
        const w = runWidth(a, run, a.size);
        const [x, y] = frameToUser(a, cursor, baseline);
        if (run.face?.bytes) {
          const fakeBold = a.bold && !run.face.bold;
          const fakeItalic = a.italic && !run.face.italic;
          await this.drawShapedRun(page, run, await this.faceFont(run.face), { x, y, size: a.size, angle: a.angle, ink, opacity, fakeBold, fakeItalic });
        } else if (run.text.trim()) {
          if (run.pending) missing = true;
          const font = await this.standardFont({ ...a, text: run.text });
          page.drawText(run.text, { x, y, size: a.size, font, color: ink, opacity, rotate: degrees(a.angle) });
        }
        cursor += w;
      }
      if (a.underline) {
        const under = i * a.size * LINE_HEIGHT + a.size * (BASELINE + UNDERLINE_OFFSET + UNDERLINE_THICKNESS / 2);
        const lw = lineWidth(a, lines[i], a.size);
        const [x1, y1] = frameToUser(a, offsets[i], under);
        const [x2, y2] = frameToUser(a, offsets[i] + lw, under);
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(0.5, a.size * UNDERLINE_THICKNESS), color: ink, opacity });
      }
    }
    if (missing) this.warnings.add('Some text needs a language pack that couldn’t be downloaded, so it may not show correctly. Connect to the internet and save again.');
  }

  /**
   * Draws one shaped run. Each glyph is placed exactly where the shaper put
   * it: advances that differ from the font's own widths (kerning, joined
   * Arabic letters) become TJ adjustments, and marks that sit above or
   * below a letter (Hindi vowel signs, Arabic vowels) use text rise.
   */
  private async drawShapedRun(page: PDFPage, run: TextRun, font: PDFFont, o: {
    x: number; y: number; size: number; angle: number; ink: RGB; opacity: number; fakeBold: boolean; fakeItalic: boolean;
  }) {
    const embedder = (font as unknown as { embedder: ShapedEmbedder }).embedder;
    const fk = embedder.font;
    const shaped = shape(fk, run.text, run.rtl);
    const k = 1000 / fk.unitsPerEm;
    const context = this.out.context;
    const items: (PDFHexString | number)[] = [];
    const ops: PDFOperator[] = [];
    const num = (n: number) => Math.round(n * 1000) / 1000;
    const flush = () => {
      if (items.length) ops.push(PDFOperator.of('TJ' as never, [context.obj(items.splice(0))]));
    };
    let rise = 0;
    shaped.glyphs.forEach((glyph, i) => {
      const p = shaped.positions[i];
      const id = glyph.id;
      if (!embedder.used.has(id)) embedder.used.set(id, glyph);
      const wantRise = p.yOffset * k * o.size / 1000;
      if (Math.abs(wantRise - rise) > 1e-4) {
        flush();
        ops.push(PDFOperator.of('Ts' as never, [context.obj(num(wantRise))]));
        rise = wantRise;
      }
      // TJ numbers move left by thousandths of the font size
      if (p.xOffset) items.push(num(-p.xOffset * k));
      items.push(PDFHexString.of(id.toString(16).padStart(4, '0')));
      const extra = p.xAdvance - p.xOffset - glyph.advanceWidth;
      if (Math.abs(extra) > 0.01) items.push(num(-extra * k));
    });
    flush();
    (font as unknown as { modified: boolean }).modified = true;

    const fontKey = (page as unknown as { node: { newFontDictionary(n: string, r: PDFRef): PDFName } }).node.newFontDictionary(font.name, font.ref);
    const gsKey = (page as unknown as { maybeEmbedGraphicsState(o: { opacity?: number; borderOpacity?: number }): string | undefined })
      .maybeEmbedGraphicsState({ opacity: o.opacity, borderOpacity: o.opacity });
    const r = (o.angle * Math.PI) / 180;
    const skew = o.fakeItalic ? Math.tan((12 * Math.PI) / 180) : 0;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    page.pushOperators(
      pushGraphicsState(),
      ...(gsKey ? [PDFOperator.of('gs' as never, [gsKey])] : []),
      PDFOperator.of('BT' as never),
      PDFOperator.of('Tf' as never, [fontKey, context.obj(o.size)]),
      PDFOperator.of('rg' as never, [context.obj(o.ink.red), context.obj(o.ink.green), context.obj(o.ink.blue)]),
      ...(o.fakeBold ? [
        PDFOperator.of('Tr' as never, [context.obj(2)]),
        PDFOperator.of('RG' as never, [context.obj(o.ink.red), context.obj(o.ink.green), context.obj(o.ink.blue)]),
        PDFOperator.of('w' as never, [context.obj(num(o.size * 0.035))]),
      ] : []),
      // rotation, then the slant for imitated italic, then the position
      PDFOperator.of('Tm' as never, [cos, sin, num(-sin + skew * cos), num(cos + skew * sin), num(o.x), num(o.y)].map((v) => context.obj(num(v)))),
      ...ops,
      PDFOperator.of('ET' as never),
      popGraphicsState(),
    );
  }

  async drawStamp(page: PDFPage, a: StampAnnot) {
    const L = stampLayout(a);
    const c = color(a.color);
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    // a point in the stamp's own frame (y down from its centre) in user space
    const at = (lx: number, ly: number) => {
      const [dx, dy] = rotateVec(lx, -ly, a.angle);
      return { x: cx + dx, y: cy + dy };
    };
    const inset = L.border / 2;
    const w = L.lw - L.border, h = L.lh - L.border, r = Math.min(L.radius, w / 2, h / 2);
    const x0 = -L.lw / 2 + inset, y0 = -L.lh / 2 + inset;
    // rounded rectangle in pdf-lib's SVG convention (y down), around the centre
    const path = `M ${x0 + r} ${y0} H ${x0 + w - r} Q ${x0 + w} ${y0} ${x0 + w} ${y0 + r} V ${y0 + h - r} Q ${x0 + w} ${y0 + h} ${x0 + w - r} ${y0 + h} H ${x0 + r} Q ${x0} ${y0 + h} ${x0} ${y0 + h - r} V ${y0 + r} Q ${x0} ${y0} ${x0 + r} ${y0} Z`;
    page.drawSvgPath(path, { x: cx, y: cy, rotate: degrees(a.angle), color: c, opacity: 0.07, borderColor: c, borderWidth: L.border, borderOpacity: 0.92 });
    const bold = await this.standard(StandardFonts.HelveticaBold);
    const regular = await this.standard(StandardFonts.Helvetica);
    const label = at(-L.labelWidth / 2, L.labelMid + L.labelSize * STAMP_BASELINE);
    page.drawText(a.label, { ...label, size: L.labelSize, font: bold, color: c, opacity: 0.92, rotate: degrees(a.angle) });
    if (a.date) {
      const date = at(-L.dateWidth / 2, L.dateMid + L.dateSize * STAMP_BASELINE);
      page.drawText(a.date, { ...date, size: L.dateSize, font: regular, color: c, opacity: 0.92, rotate: degrees(a.angle) });
    }
  }

  async image(assetId: string): Promise<PDFImage | null> {
    if (this.images.has(assetId)) return this.images.get(assetId)!;
    const asset = this.doc.assets.get(assetId);
    if (!asset) return null;
    const bytes = await (await fetch(asset.dataUrl)).arrayBuffer();
    const image = asset.dataUrl.startsWith('data:image/jpeg')
      ? await this.out.embedJpg(bytes)
      : await this.out.embedPng(bytes);
    this.images.set(assetId, image);
    return image;
  }

  /**
   * The embedded copy of a face for shaped text (one per face per file).
   * pdf-lib writes the font dictionary, widths and text-extraction map for
   * just the glyphs used; HarfBuzz makes the font file itself (subset.ts).
   */
  private async faceFont(face: Face): Promise<PDFFont> {
    const key = `shaped:${face.key}`;
    let embedded = this.custom.get(key);
    if (!embedded) {
      embedded = await this.out.embedFont(face.bytes!, { subset: false });
      const used = new Map<number, { id: number }>();
      const embedder = (embedded as unknown as { embedder: ShapedEmbedder }).embedder;
      embedder.used = used;
      embedder.glyphCache = { access: () => [...used.values()].sort((a, b) => a.id - b.id), invalidate: () => {} };
      const bytes = face.bytes!;
      embedder.serializeFont = async () => (await import('./subset')).subsetFont(bytes, used.keys());
      this.custom.set(key, embedded);
    }
    return embedded;
  }

  async drawText(page: PDFPage, a: Annot & TextStyle & { x: number; y: number; angle: number }) {
    if (needsShaping(a.text)) {
      await prepareFonts(a, a.text);
      return this.drawMixedText(page, a);
    }
    const { font, fakeBold, fakeItalic } = await this.font(a);
    const lines = textLines(a.text);
    const { width, height } = measureText(a);
    const offsets = lineOffsets(a, width);
    const opacity = a.opacity ?? 1;
    const ink = color(a.color);

    if (a.background) {
      const pad = a.size * TEXT_PAD;
      const [x, y] = frameToUser(a, -pad, height + pad);
      page.drawRectangle({ x, y, width: width + pad * 2, height: height + pad * 2, color: color(a.background), opacity, rotate: degrees(a.angle) });
    }

    // Bold a face doesn't have is imitated the usual way, by outlining the
    // letters as well as filling them; italic by slanting them 12°.
    if (fakeBold) {
      page.pushOperators(
        pushGraphicsState(),
        setTextRenderingMode(TextRenderingMode.FillAndOutline),
        setLineWidth(a.size * 0.035),
        setStrokingRgbColor(ink.red, ink.green, ink.blue),
      );
    }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const baseline = i * a.size * LINE_HEIGHT + a.size * BASELINE;
      const [x, y] = frameToUser(a, offsets[i], baseline);
      page.drawText(lines[i], {
        x, y, size: a.size, font, color: ink, opacity,
        rotate: degrees(a.angle),
        xSkew: degrees(fakeItalic ? 12 : 0),
      });
    }
    if (fakeBold) page.pushOperators(popGraphicsState());

    if (a.underline) {
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        const under = i * a.size * LINE_HEIGHT + a.size * (BASELINE + UNDERLINE_OFFSET + UNDERLINE_THICKNESS / 2);
        const lw = lineWidth(a, lines[i], a.size);
        const [x1, y1] = frameToUser(a, offsets[i], under);
        const [x2, y2] = frameToUser(a, offsets[i] + lw, under);
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(0.5, a.size * UNDERLINE_THICKNESS), color: ink, opacity });
      }
    }
  }

  async draw(page: PDFPage, a: Annot) {
    switch (a.type) {
      case 'ink':
        if (a.opacity >= 1) {
          page.pushOperators(inkOperators(a.points, color(a.color), a.width));
          break;
        }
        // see-through ink needs a graphics state, which pdf-lib's path
        // drawing sets up for us
        page.drawSvgPath(strokePath(a.points), {
          x: 0,
          y: 0,
          borderColor: color(a.color),
          borderWidth: a.width,
          borderOpacity: a.opacity,
          borderLineCap: LineCapStyle.Round,
        });
        break;
      case 'line':
        page.drawLine({
          start: { x: a.x1, y: a.y1 },
          end: { x: a.x2, y: a.y2 },
          thickness: a.width,
          color: color(a.color),
          lineCap: LineCapStyle.Round,
        });
        break;
      case 'arrow': {
        const head = arrowHead(a);
        page.drawLine({
          start: { x: a.x1, y: a.y1 },
          end: { x: head.neck[0], y: head.neck[1] },
          thickness: a.width,
          color: color(a.color),
          lineCap: LineCapStyle.Round,
        });
        const [t, l, r] = [head.tip, head.left, head.right];
        page.drawSvgPath(`M ${t[0]} ${-t[1]} L ${l[0]} ${-l[1]} L ${r[0]} ${-r[1]} Z`, { x: 0, y: 0, color: color(a.color) });
        break;
      }
      case 'rect':
        page.drawRectangle({
          x: a.x, y: a.y, width: a.w, height: a.h,
          color: a.fill ? color(a.fill) : undefined,
          borderColor: a.width > 0 ? color(a.color) : undefined,
          borderWidth: a.width,
        });
        break;
      case 'ellipse':
        page.drawEllipse({
          x: a.x + a.w / 2, y: a.y + a.h / 2, xScale: a.w / 2, yScale: a.h / 2,
          color: a.fill ? color(a.fill) : undefined,
          borderColor: a.width > 0 ? color(a.color) : undefined,
          borderWidth: a.width,
        });
        break;
      case 'highlight':
        page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: color(a.color), blendMode: BlendMode.Multiply });
        break;
      case 'whiteout':
      case 'redact':
        page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: color(a.color) });
        break;
      case 'replace':
        page.drawRectangle({ x: a.cover.x, y: a.cover.y, width: a.cover.w, height: a.cover.h, color: color(a.cover.color) });
        await this.drawText(page, a);
        break;
      case 'text':
        await this.drawText(page, a);
        break;
      case 'stamp':
        await this.drawStamp(page, a);
        break;
      case 'note':
      case 'field':
        // real PDF annotations and form fields, added separately
        break;
      case 'image': {
        const image = await this.image(a.asset);
        if (!image) break;
        const { lw, lh } = imageLocalSize(a);
        // pdf-lib rotates around the image's own bottom-left corner, so work
        // out where that corner lands once the picture is turned in its box
        const [dx, dy] = rotateVec(-lw / 2, -lh / 2, a.angle);
        page.drawImage(image, {
          x: a.x + a.w / 2 + dx,
          y: a.y + a.h / 2 + dy,
          width: lw,
          height: lh,
          rotate: degrees(a.angle),
        });
        break;
      }
    }
  }
}

function redactionJobs(doc: EditorDoc, pages: readonly PageRef[]): Map<string, RedactJob[]> {
  const bySource = new Map<string, RedactJob[]>();
  for (const page of pages) {
    const rects = doc
      .annots(page.id)
      .flatMap((a) => (a.type === 'replace' ? [a.cover] : a.type === 'redact' ? [a] : []))
      .map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }));
    if (!rects.length) continue;
    const jobs = bySource.get(page.src) ?? [];
    jobs.push({ page: page.index, rects });
    bySource.set(page.src, jobs);
  }
  return bySource;
}

async function fillForms(out: PDFDocument, doc: EditorDoc, writer: Writer) {
  const entries = Object.entries(doc.forms);
  if (!entries.length) return;
  const form = out.getForm();

  for (const [name, value] of entries) {
    let field;
    try {
      field = form.getField(name);
    } catch {
      writer.warnings.add(`Couldn’t find form field “${name}” in the file, so its value wasn’t saved.`);
      continue;
    }
    try {
      if (field instanceof PDFTextField) {
        const text = String(value);
        const max = field.getMaxLength();
        field.setText(max !== undefined ? text.slice(0, max) : text);
      } else if (field instanceof PDFCheckBox) {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && field.getOptions().includes(value)) field.select(value);
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (typeof value === 'string' && value) field.select(value);
        else field.clear();
      }
    } catch (err) {
      writer.warnings.add(`Form field “${name}” couldn’t be filled: ${(err as Error).message}`);
    }
  }

  try {
    form.updateFieldAppearances();
  } catch {
    // Helvetica can't draw some characters; fall back to a Unicode font
    form.updateFieldAppearances(await writer.unicodeFont());
  }
}

/** Draws rotation, crop and marks onto one output page. */
async function decoratePage(page: PDFPage, ref: PageRef, doc: EditorDoc, writer: Writer) {
  page.setRotation(degrees(doc.displayRotation(ref)));
  if (ref.crop) {
    page.setCropBox(ref.crop.x, ref.crop.y, ref.crop.w, ref.crop.h);
    // trim boxes beyond the crop would make some viewers show the old edges
    for (const key of ['TrimBox', 'BleedBox', 'ArtBox']) page.node.delete(PDFName.of(key));
  }
  const annots = doc.annots(ref.id);
  // highlights first so later marks sit on top of them, like on screen
  for (const a of annots) if (a.type === 'highlight') await writer.draw(page, a);
  // then watermark, page numbers, header and footer, under everything else
  for (const t of decorTexts(doc, ref)) await writer.drawText(page, t);
  for (const a of annots) if (a.type !== 'highlight') await writer.draw(page, a);

  replaceNotes(page, annots.filter((a): a is NoteAnnot => a.type === 'note'));
}

const hexColour = (hex: string) => {
  const c = color(hex);
  return [c.red, c.green, c.blue];
};

/**
 * Sticky notes become standard PDF comments, which every reader shows. The
 * file's own comments were read in when it was opened (and may have been
 * edited or deleted since), so the old ones are taken out first.
 */
function replaceNotes(page: PDFPage, notes: NoteAnnot[]) {
  const ctx = page.doc.context;
  const list = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (list) {
    const subtype = (d: PDFDict | undefined) => d?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
    for (let i = list.size() - 1; i >= 0; i--) {
      const annot = list.lookupMaybe(i, PDFDict);
      const kind = subtype(annot);
      const parent = annot?.lookupMaybe(PDFName.of('Parent'), PDFDict);
      if (kind === '/Text' || (kind === '/Popup' && subtype(parent) === '/Text')) list.remove(i);
    }
  }
  for (const n of notes) {
    const when = PDFString.fromDate(new Date(n.created));
    const dict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [n.x, n.y, n.x + n.w, n.y + n.h],
      Contents: PDFHexString.fromText(n.text),
      T: PDFHexString.fromText(n.author || 'Inkleaf'),
      C: hexColour(n.color),
      Name: 'Comment',
      F: 4 | 16 | 8, // print, no zoom, no rotate: an icon that stays icon-sized
      Open: false,
    });
    dict.set(PDFName.of('M'), when);
    dict.set(PDFName.of('CreationDate'), when);
    page.node.addAnnot(ctx.register(dict));
  }
}

/** Form fields designed in Inkleaf become real, fillable AcroForm fields. */
async function createFields(out: PDFDocument, pages: readonly PageRef[], doc: EditorDoc, writer: Writer) {
  const wanted = pages.map((ref, i) => ({ i, fields: doc.annots(ref.id).filter((a): a is FieldAnnot => a.type === 'field') }))
    .filter((p) => p.fields.length);
  if (!wanted.length) return;
  const form = out.getForm();
  const taken = new Set(form.getFields().map((f) => f.getName()));
  const font = await writer.standard(StandardFonts.Helvetica);
  for (const { i, fields } of wanted) {
    const page = out.getPage(i);
    for (const f of fields) {
      let name = (f.name.trim() || 'Field').replace(/\./g, ' ');
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name} ${n}`)) n++;
        writer.warnings.add(`Two form fields were both called “${name}”, so one was saved as “${name} ${n}”.`);
        name = `${name} ${n}`;
      }
      taken.add(name);
      const place = {
        x: f.x, y: f.y, width: f.w, height: f.h, font,
        rotate: degrees(f.angle),
        borderColor: rgb(0.55, 0.6, 0.58), borderWidth: 1,
        backgroundColor: rgb(1, 1, 1),
      };
      try {
        if (f.kind === 'checkbox') {
          const box = form.createCheckBox(name);
          box.addToPage(page, { ...place, font: undefined } as never);
          if (f.required) box.enableRequired();
        } else if (f.kind === 'dropdown') {
          const drop = form.createDropdown(name);
          const options = f.options.map((o) => o.trim()).filter(Boolean);
          if (options.length) drop.addOptions(options);
          drop.addToPage(page, place);
          if (f.required) drop.enableRequired();
        } else {
          const text = form.createTextField(name);
          if (f.kind === 'multiline') text.enableMultiline();
          text.addToPage(page, place);
          if (f.required) text.enableRequired();
        }
      } catch (err) {
        writer.warnings.add(`Form field “${name}” couldn’t be added: ${(err as Error).message}`);
      }
    }
  }
  form.updateFieldAppearances(font);
}

/** Writes Inkleaf-edited bookmarks, replacing the file's own. */
function writeOutline(out: PDFDocument, items: readonly OutlineItem[], pageRefs: Map<string, PDFRef>) {
  const ctx = out.context;
  const usable = (list: readonly OutlineItem[]): OutlineItem[] =>
    list.map((it) => ({ ...it, children: usable(it.children) })).filter((it) => (it.pageId && pageRefs.has(it.pageId)) || it.children.length);
  const top = usable(items);
  if (!top.length) {
    out.catalog.delete(PDFName.of('Outlines'));
    return;
  }
  const rootRef = ctx.nextRef();
  /** Writes one level; returns the count of visible descendants. */
  const level = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((it, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parent });
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      const target = it.pageId ? pageRefs.get(it.pageId) : undefined;
      if (target) dict.set(PDFName.of('Dest'), ctx.obj([target, 'XYZ', null, null, null]));
      if (it.children.length) {
        const kids = level(it.children, refs[i]);
        dict.set(PDFName.of('First'), kids.first);
        dict.set(PDFName.of('Last'), kids.last);
        dict.set(PDFName.of('Count'), ctx.obj(kids.count));
        count += kids.count;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const { first, last, count } = level(top, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: count }));
  out.catalog.set(PDFName.of('Outlines'), rootRef);
}

/** Fields, bookmarks: things that need the finished page list of an output. */
async function finishPages(out: PDFDocument, pages: readonly PageRef[], doc: EditorDoc, writer: Writer) {
  await createFields(out, pages, doc, writer);
  if (doc.outline) {
    const refs = new Map(pages.map((p, i) => [p.id, out.getPage(i).ref] as const));
    writeOutline(out, doc.outline, refs);
  }
}

/** zlib-compresses bytes with the browser's native (C++) deflate. */
async function nativeDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * pdf-lib compresses the page content it creates with a JavaScript deflate,
 * which was the slowest part of saving. Swap those streams for natively
 * compressed copies first; the PDF ends up the same, just sooner.
 */
async function compressNewContent(out: PDFDocument) {
  const jobs = out.context
    .enumerateIndirectObjects()
    .filter(([, obj]) => obj instanceof PDFContentStream)
    .map(async ([ref, obj]) => {
      const stream = obj as PDFContentStream;
      const compressed = await nativeDeflate(stream.getUnencodedContents());
      const dict = stream.dict.clone(out.context);
      dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      dict.delete(PDFName.of('Length'));
      out.context.assign(ref, PDFRawStream.of(dict, compressed));
    });
  await Promise.all(jobs);
}

async function finish(out: PDFDocument, writer: Writer, warnings: string[], needsCleanUp: boolean): Promise<ExportResult> {
  if (typeof CompressionStream !== 'undefined') await compressNewContent(out);
  out.setProducer('Inkleaf');
  out.setModificationDate(new Date());
  const saved = await out.save({ useObjectStreams: true, updateFieldAppearances: false });
  let bytes: Uint8Array = saved;
  // Only needed when pages were dropped: their content would otherwise linger
  // unreferenced in the file. It's a full re-parse, so skip it when we can.
  if (needsCleanUp) {
    try {
      bytes = await core.finalize(saved);
    } catch (err) {
      console.warn('finalize failed, keeping pdf-lib output', err);
    }
  }
  return { bytes, warnings: [...new Set([...warnings, ...writer.warnings])] };
}

/**
 * Builds a PDF from the current state of `doc`. Pass `pageIds` to export
 * only some pages (for Extract), in document order.
 */
export async function exportPdf(doc: EditorDoc, pageIds?: string[]): Promise<ExportResult> {
  const [result] = await exportBatch(doc, [pageIds ?? null]);
  return result;
}

/**
 * Builds several PDFs at once (for Split). The source files are read and
 * redacted once for the whole batch rather than once per output file.
 * A null group means the whole document.
 */
export async function exportBatch(doc: EditorDoc, groups: (string[] | null)[]): Promise<ExportResult[]> {
  await loadFontMetrics();
  const groupPages = groups.map((ids) => {
    const wanted = ids ? new Set(ids) : null;
    const pages = doc.pages.filter((p) => !wanted || wanted.has(p.id));
    if (!pages.length) throw new Error('There are no pages to save.');
    return pages;
  });

  // 1. Strip redacted and replaced text out of the source files first, while
  //    page numbers still refer to the originals.
  const warnings: string[] = [];
  const everyPage = [...new Set(groupPages.flat())];
  const sourceBytes = new Map<string, Uint8Array>();
  for (const [srcId, jobs] of redactionJobs(doc, everyPage)) {
    const { pdf, report } = await core.redact(doc.sources.get(srcId)!.bytes, jobs);
    sourceBytes.set(srcId, pdf);
    warnings.push(...report.warnings);
  }
  const bytesFor = (srcId: string) => sourceBytes.get(srcId) ?? doc.sources.get(srcId)!.bytes;

  const results: ExportResult[] = [];
  const parsed = new Map<string, Promise<PDFDocument>>();
  let formsWriter: Writer | null = null;

  /** Each source parsed once per batch; the main one gets its forms filled. */
  const source = (srcId: string) => {
    let pending = parsed.get(srcId);
    if (!pending) {
      pending = PDFDocument.load(bytesFor(srcId), { updateMetadata: false }).then(async (pdf) => {
        if (srcId === doc.mainSource) {
          pdf.registerFontkit(fontkit);
          formsWriter = new Writer(pdf, doc);
          await fillForms(pdf, doc, formsWriter);
        }
        return pdf;
      });
      parsed.set(srcId, pending);
    }
    return pending;
  };

  for (const pages of groupPages) {
    const isWhole = pages.length === doc.pages.length;

    if (isWhole) {
      // 2a. The whole document: keep the main file as the base so its forms,
      //     bookmarks and metadata survive.
      const out = await PDFDocument.load(bytesFor(doc.mainSource), { updateMetadata: false });
      out.registerFontkit(fontkit);
      const writer = new Writer(out, doc);
      await fillForms(out, doc, writer);

      const mainPages = out.getPages();
      const copied = new Map<string, Map<number, PDFPage>>();
      for (const srcId of new Set(pages.map((p) => p.src))) {
        if (srcId === doc.mainSource) continue;
        const indices = [...new Set(pages.filter((p) => p.src === srcId).map((p) => p.index))];
        const result = await out.copyPages(await source(srcId), indices);
        copied.set(srcId, new Map(indices.map((index, i) => [index, result[i]])));
      }
      const targets = pages.map((p) =>
        p.src === doc.mainSource ? mainPages[p.index] : copied.get(p.src)!.get(p.index)!,
      );

      const unchanged = targets.length === mainPages.length && targets.every((t, i) => t === mainPages[i]);
      if (!unchanged) {
        // Append everything in the new order, then drop the original run from
        // the front. Pages that weren't re-added fall out of the page tree,
        // and the clean-up pass removes their content from the file.
        const originalCount = out.getPageCount();
        for (const page of targets) out.addPage(page);
        for (let i = 0; i < originalCount; i++) out.removePage(0);
      }
      for (let i = 0; i < pages.length; i++) await decoratePage(out.getPage(i), pages[i], doc, writer);
      await finishPages(out, pages, doc, writer);
      results.push(await finish(out, writer, warnings, !unchanged));
      continue;
    }

    // 2b. Some pages: start a fresh file and copy just those in, so we never
    //     carry (or have to clean up) the rest of the document.
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const writer = new Writer(out, doc);
    const copiedPages: PDFPage[] = new Array(pages.length);
    for (const srcId of new Set(pages.map((p) => p.src))) {
      const positions = pages.map((p, i) => (p.src === srcId ? i : -1)).filter((i) => i >= 0);
      const result = await out.copyPages(await source(srcId), positions.map((i) => pages[i].index));
      positions.forEach((pos, k) => (copiedPages[pos] = result[k]));
    }
    for (const page of copiedPages) out.addPage(page);
    for (let i = 0; i < pages.length; i++) await decoratePage(out.getPage(i), pages[i], doc, writer);
    await finishPages(out, pages, doc, writer);
    const result = await finish(out, writer, warnings, false);
    if (formsWriter) result.warnings = [...new Set([...result.warnings, ...(formsWriter as Writer).warnings])];
    results.push(result);
  }
  return results;
}
