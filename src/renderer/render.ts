// SPDX-License-Identifier: GPL-3.0-or-later
import { BASELINE, cssFamily, cssFont, LINE_HEIGHT, lineDirection, lineOffsets, lineWidth, measureText, needsShaping, textLines } from './fonts';
import { annotBounds, handlesFor, imageLocalSize, Point } from './geometry';
import type { Annot, FieldAnnot, ImageAnnot, LineAnnot, NoteAnnot, StampAnnot, TextStyle } from './types';

export type Transform = [number, number, number, number, number, number];

const RAD = Math.PI / 180;

/** Applies a user-space → device transform to a point. */
export function apply(t: Transform, x: number, y: number): Point {
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

export function arrowHead(a: LineAnnot): { tip: Point; left: Point; right: Point; neck: Point } {
  const len = Math.max(a.width * 4, 8);
  const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const spread = 26 * RAD;
  const tip: Point = [a.x2, a.y2];
  const left: Point = [a.x2 - len * Math.cos(angle - spread), a.y2 - len * Math.sin(angle - spread)];
  const right: Point = [a.x2 - len * Math.cos(angle + spread), a.y2 - len * Math.sin(angle + spread)];
  // stop the shaft a little short so its round cap doesn't poke past the tip
  const neck: Point = [a.x2 - len * 0.7 * Math.cos(angle), a.y2 - len * 0.7 * Math.sin(angle)];
  return { tip, left, right, neck };
}

/** Smooths a pen stroke by curving through the midpoints between samples. */
export function tracePath(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  if (points.length === 1) {
    ctx.lineTo(points[0][0] + 0.01, points[0][1]);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/** Padding around a text background, as a fraction of the font size. */
export const TEXT_PAD = 0.18;

export function drawTextBlock(ctx: CanvasRenderingContext2D, style: TextStyle) {
  const lines = textLines(style.text);
  const { width, height } = measureText(style);
  const offsets = lineOffsets(style, width);
  ctx.save();
  ctx.globalAlpha *= style.opacity ?? 1;

  if (style.background) {
    const pad = style.size * TEXT_PAD;
    ctx.fillStyle = style.background;
    ctx.fillRect(-pad, -pad, width + pad * 2, height + pad * 2);
  }

  ctx.fillStyle = style.color;
  ctx.textBaseline = 'alphabetic';
  ctx.font = cssFont(style, style.size);
  lines.forEach((line, i) => {
    if (!line) return;
    // The screen font is a stand-in for the PDF font, so stretch each line
    // to the exact width it will have in the saved file.
    const target = lineWidth(style, line, style.size);
    const measured = ctx.measureText(line).width;
    const baseline = i * style.size * LINE_HEIGHT + style.size * BASELINE;
    ctx.save();
    ctx.translate(offsets[i], baseline);
    // Arabic and Hebrew lines order their words right to left, as in the PDF
    ctx.direction = needsShaping(line) ? lineDirection(line) : 'ltr';
    ctx.textAlign = 'left';
    if (measured > 0 && target > 0) ctx.scale(target / measured, 1);
    ctx.fillText(line, 0, 0);
    ctx.restore();
    if (style.underline) {
      ctx.fillRect(offsets[i], baseline + style.size * UNDERLINE_OFFSET, target, Math.max(0.5, style.size * UNDERLINE_THICKNESS));
    }
  });
  ctx.restore();
}

/** Underline position below the baseline and thickness, as fractions of size. */
export const UNDERLINE_OFFSET = 0.11;
export const UNDERLINE_THICKNESS = 0.06;

/**
 * Where the words go inside a stamp, in its own frame: centred on the
 * stamp, y going down, before any turn. Shared with the PDF writer so the
 * saved stamp matches the screen.
 */
export function stampLayout(a: StampAnnot) {
  const sideways = Math.abs(Math.round(a.angle / 90)) % 2 === 1;
  const lw = sideways ? a.h : a.w, lh = sideways ? a.w : a.h;
  const style = { font: 'sans' as const, bold: true, italic: false };
  let labelSize = a.date ? lh * 0.42 : lh * 0.56;
  const room = lw * 0.86;
  const labelWidth = (size: number) => lineWidth(style, a.label, size);
  if (labelWidth(labelSize) > room) labelSize *= room / labelWidth(labelSize);
  const dateSize = Math.min(lh * 0.2, labelSize * 0.6);
  // vertical centre of each line, from the stamp's centre
  const labelMid = a.date ? -lh * 0.12 : 0;
  const dateMid = lh * 0.26;
  return {
    lw, lh, style, labelSize, dateSize, labelMid, dateMid,
    labelWidth: labelWidth(labelSize),
    dateWidth: a.date ? lineWidth({ font: 'sans', bold: false, italic: false }, a.date, dateSize) : 0,
    border: Math.max(1.2, lh * 0.055),
    radius: lh * 0.16,
  };
}

/** Baseline below the middle of a stamp's line, as a fraction of its size. */
export const STAMP_BASELINE = 0.36;

function drawStamp(ctx: CanvasRenderingContext2D, a: StampAnnot) {
  const L = stampLayout(a);
  ctx.translate(a.x + a.w / 2, a.y + a.h / 2);
  ctx.rotate(a.angle * RAD);
  ctx.scale(1, -1);
  const inset = L.border / 2;
  ctx.beginPath();
  ctx.roundRect(-L.lw / 2 + inset, -L.lh / 2 + inset, L.lw - L.border, L.lh - L.border, L.radius);
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = a.color;
  ctx.fill();
  ctx.globalAlpha = 0.92;
  ctx.lineWidth = L.border;
  ctx.strokeStyle = a.color;
  ctx.stroke();
  const line = (text: string, size: number, mid: number, target: number, bold: boolean) => {
    ctx.font = `${bold ? '700 ' : ''}${size}px ${cssFamily('sans')}`;
    ctx.textBaseline = 'alphabetic';
    const measured = ctx.measureText(text).width;
    ctx.save();
    ctx.translate(-target / 2, mid + size * STAMP_BASELINE);
    if (measured > 0) ctx.scale(target / measured, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  ctx.fillStyle = a.color;
  line(a.label, L.labelSize, L.labelMid, L.labelWidth, true);
  if (a.date) line(a.date, L.dateSize, L.dateMid, L.dateWidth, false);
}

/** A comment's icon: a little speech-bubble card in the note's colour. */
function drawNote(ctx: CanvasRenderingContext2D, a: NoteAnnot) {
  const { x, y, w, h } = a;
  ctx.save();
  ctx.translate(x, y + h);
  ctx.scale(w / 20, -h / 20); // draw on a 20×20 grid, y down
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 0.6;
  ctx.beginPath();
  ctx.moveTo(3, 2);
  ctx.lineTo(17, 2);
  ctx.quadraticCurveTo(18.5, 2, 18.5, 3.5);
  ctx.lineTo(18.5, 12.5);
  ctx.quadraticCurveTo(18.5, 14, 17, 14);
  ctx.lineTo(9, 14);
  ctx.lineTo(5, 18);
  ctx.lineTo(5.5, 14);
  ctx.lineTo(3, 14);
  ctx.quadraticCurveTo(1.5, 14, 1.5, 12.5);
  ctx.lineTo(1.5, 3.5);
  ctx.quadraticCurveTo(1.5, 2, 3, 2);
  ctx.closePath();
  ctx.fillStyle = a.color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (const [ly, lw] of [[5.5, 11], [8, 11], [10.5, 7]]) ctx.fillRect(4.5, ly, lw, 1.1);
  ctx.restore();
}

const FIELD_LABELS: Record<FieldAnnot['kind'], string> = {
  text: 'Text', multiline: 'Paragraph', checkbox: '✓', dropdown: '▾',
};

/** A form field being designed: a tinted box with its name. */
function drawField(ctx: CanvasRenderingContext2D, a: FieldAnnot) {
  ctx.fillStyle = 'rgba(43, 115, 86, 0.10)';
  ctx.fillRect(a.x, a.y, a.w, a.h);
  ctx.save();
  // the dash pattern is set in device pixels so it looks the same at any zoom
  const t = ctx.getTransform();
  const unit = 1 / Math.hypot(t.a, t.b);
  ctx.setLineDash([4 * unit, 3 * unit]);
  ctx.lineWidth = 1.2 * unit;
  ctx.strokeStyle = '#2b7356';
  ctx.strokeRect(a.x, a.y, a.w, a.h);
  ctx.restore();
  const size = Math.max(5, Math.min(9, a.h * 0.55));
  ctx.save();
  ctx.translate(a.x, a.y + a.h);
  ctx.scale(1, -1);
  ctx.fillStyle = '#1f5a43';
  ctx.font = `600 ${size}px ${cssFamily('sans')}`;
  ctx.textBaseline = 'middle';
  if (a.kind === 'checkbox') {
    ctx.textAlign = 'center';
    ctx.fillText(FIELD_LABELS.checkbox, a.w / 2, a.h / 2);
  } else {
    const label = a.name + (a.required ? ' *' : '');
    ctx.fillText(label, 3, a.kind === 'multiline' ? Math.min(a.h / 2, size) : a.h / 2, Math.max(4, a.w - 14));
    ctx.textAlign = 'right';
    ctx.globalAlpha = 0.6;
    if (a.kind === 'dropdown') ctx.fillText(FIELD_LABELS.dropdown, a.w - 3, a.h / 2);
  }
  ctx.restore();
}

function drawImage(ctx: CanvasRenderingContext2D, a: ImageAnnot, img: HTMLImageElement | undefined) {
  const { lw, lh } = imageLocalSize(a);
  ctx.translate(a.x + a.w / 2, a.y + a.h / 2);
  ctx.rotate(a.angle * RAD);
  ctx.scale(1, -1);
  if (img?.complete && img.naturalWidth) {
    ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh);
  } else {
    ctx.fillStyle = 'rgba(120,120,120,0.15)';
    ctx.fillRect(-lw / 2, -lh / 2, lw, lh);
  }
}

/**
 * Draws one annotation. The context's transform must already map PDF user
 * space to canvas pixels.
 */
export function drawAnnot(ctx: CanvasRenderingContext2D, a: Annot, images: Map<string, HTMLImageElement>) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (a.type) {
    case 'ink':
      ctx.globalAlpha = a.opacity;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      tracePath(ctx, a.points);
      ctx.stroke();
      break;
    case 'line':
    case 'arrow': {
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      if (a.type === 'arrow') {
        const head = arrowHead(a);
        ctx.lineTo(...head.neck);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(...head.tip);
        ctx.lineTo(...head.left);
        ctx.lineTo(...head.right);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
      }
      break;
    }
    case 'rect':
    case 'ellipse':
      ctx.beginPath();
      if (a.type === 'rect') ctx.rect(a.x, a.y, a.w, a.h);
      else ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
      if (a.fill) {
        ctx.fillStyle = a.fill;
        ctx.fill();
      }
      if (a.width > 0) {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        ctx.stroke();
      }
      break;
    case 'highlight':
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      break;
    case 'whiteout':
    case 'redact':
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      break;
    case 'text':
    case 'replace':
      if (a.type === 'replace') {
        ctx.fillStyle = a.cover.color;
        ctx.fillRect(a.cover.x, a.cover.y, a.cover.w, a.cover.h);
      }
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle * RAD);
      ctx.scale(1, -1);
      drawTextBlock(ctx, a);
      break;
    case 'image':
      drawImage(ctx, a, images.get(a.asset));
      break;
    case 'note':
      drawNote(ctx, a);
      break;
    case 'stamp':
      drawStamp(ctx, a);
      break;
    case 'field':
      drawField(ctx, a);
      break;
  }
  ctx.restore();
}

export interface DrawOptions {
  /** Separate canvas for highlights, composited with multiply over the page. */
  highlights?: CanvasRenderingContext2D | null;
  /** Annotations not to draw (e.g. the one being edited). */
  skip?: Set<string>;
  /** For replacements being edited: draw the cover but not the old text. */
  coverOnly?: Set<string>;
}

export function drawAnnots(
  ctx: CanvasRenderingContext2D,
  transform: Transform,
  annots: Annot[],
  images: Map<string, HTMLImageElement>,
  options: DrawOptions = {},
) {
  const hl = options.highlights ?? null;
  // Highlights go first (and on their own layer when there is one) so they
  // tint the page underneath rather than the other annotations.
  for (const a of annots) {
    if (a.type !== 'highlight' || options.skip?.has(a.id)) continue;
    const target = hl ?? ctx;
    target.save();
    target.setTransform(...transform);
    if (!hl) target.globalCompositeOperation = 'multiply';
    drawAnnot(target, a, images);
    target.restore();
  }
  for (const a of annots) {
    if (a.type === 'highlight' || options.skip?.has(a.id)) continue;
    ctx.save();
    ctx.setTransform(...transform);
    if (options.coverOnly?.has(a.id) && a.type === 'replace') {
      ctx.fillStyle = a.cover.color;
      ctx.fillRect(a.cover.x, a.cover.y, a.cover.w, a.cover.h);
    } else {
      drawAnnot(ctx, a, images);
    }
    ctx.restore();
  }
}

/** Dashed outline and grab handles for the selected annotation, in device pixels. */
export function drawSelection(ctx: CanvasRenderingContext2D, transform: Transform, a: Annot, dpr: number) {
  const b = annotBounds(a);
  const corners = [
    apply(transform, b.x, b.y),
    apply(transform, b.x + b.w, b.y),
    apply(transform, b.x + b.w, b.y + b.h),
    apply(transform, b.x, b.y + b.h),
  ];
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const pad = 4 * dpr;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const x1 = Math.max(...xs) + pad, y1 = Math.max(...ys) + pad;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f7a5b';
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.25 * dpr;
  ctx.setLineDash([5 * dpr, 4 * dpr]);
  if (a.type !== 'line' && a.type !== 'arrow') ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);

  const size = 8 * dpr;
  ctx.fillStyle = '#fff';
  for (const [hx, hy] of handlesFor(a)) {
    const [px, py] = apply(transform, hx, hy);
    ctx.beginPath();
    ctx.rect(px - size / 2, py - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
