// SPDX-License-Identifier: GPL-3.0-or-later
import { measureText } from './fonts';
import type { Annot, Box, ImageAnnot, ReplaceAnnot, TextAnnot } from './types';

export type Point = [number, number];

const RAD = Math.PI / 180;

export function normBox(x0: number, y0: number, x1: number, y1: number): Box {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function boxContains(b: Box, x: number, y: number, pad = 0): boolean {
  return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function unionBox(points: Point[], pad = 0): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** Rotates a vector counter-clockwise (y up) by `deg`. */
export function rotateVec(x: number, y: number, deg: number): Point {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD);
  return [x * c - y * s, x * s + y * c];
}

// --- text frames -----------------------------------------------------------
// Text lives in its own little frame: origin at the top-left of the first
// line, x along the line, y going *down* the lines, turned by `angle`.

type Frame = Pick<TextAnnot, 'x' | 'y' | 'angle'>;

export function frameToUser(f: Frame, lx: number, ly: number): Point {
  const [dx, dy] = rotateVec(lx, -ly, f.angle);
  return [f.x + dx, f.y + dy];
}

export function userToFrame(f: Frame, ux: number, uy: number): Point {
  const [lx, ly] = rotateVec(ux - f.x, uy - f.y, -f.angle);
  return [lx, -ly];
}

/** The text block in its own frame, including any background padding. */
function textFrameBox(a: TextAnnot | ReplaceAnnot) {
  const { width, height } = measureText(a);
  const pad = a.background ? a.size * 0.18 : 0;
  return { x0: -pad, y0: -pad, x1: width + pad, y1: height + pad };
}

export function textBounds(a: TextAnnot | ReplaceAnnot): Box {
  const b = textFrameBox(a);
  return unionBox([
    frameToUser(a, b.x0, b.y0),
    frameToUser(a, b.x1, b.y0),
    frameToUser(a, b.x0, b.y1),
    frameToUser(a, b.x1, b.y1),
  ]);
}

/** Width/height of an image as it appears on the page, before box rotation. */
export function imageLocalSize(a: ImageAnnot): { lw: number; lh: number } {
  const sideways = Math.abs(Math.round(a.angle / 90)) % 2 === 1;
  return sideways ? { lw: a.h, lh: a.w } : { lw: a.w, lh: a.h };
}

// --- bounds & hit testing ----------------------------------------------------

export function annotBounds(a: Annot): Box {
  switch (a.type) {
    case 'ink':
      return unionBox(a.points, a.width / 2);
    case 'line':
    case 'arrow': {
      const pad = a.type === 'arrow' ? Math.max(a.width * 3, 8) : a.width / 2;
      return unionBox([[a.x1, a.y1], [a.x2, a.y2]], pad);
    }
    case 'text':
    case 'replace':
      return textBounds(a);
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Does a click at (x, y) user space land on this annotation? `tol` is in points. */
export function hitTest(a: Annot, x: number, y: number, tol: number): boolean {
  switch (a.type) {
    case 'ink': {
      const reach = a.width / 2 + tol;
      if (a.points.length === 1) return Math.hypot(x - a.points[0][0], y - a.points[0][1]) <= reach;
      for (let i = 1; i < a.points.length; i++) {
        const [x1, y1] = a.points[i - 1], [x2, y2] = a.points[i];
        if (distToSegment(x, y, x1, y1, x2, y2) <= reach) return true;
      }
      return false;
    }
    case 'line':
    case 'arrow':
      return distToSegment(x, y, a.x1, a.y1, a.x2, a.y2) <= a.width / 2 + tol;
    case 'rect': {
      if (a.fill) return boxContains(a, x, y, tol);
      const edge = a.width / 2 + tol;
      const outer = boxContains(a, x, y, edge);
      const inner = a.w > edge * 2 && a.h > edge * 2 &&
        x > a.x + edge && x < a.x + a.w - edge && y > a.y + edge && y < a.y + a.h - edge;
      return outer && !inner;
    }
    case 'ellipse': {
      const rx = a.w / 2, ry = a.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const cx = a.x + rx, cy = a.y + ry;
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (a.fill) return r <= 1 + tol / Math.min(rx, ry);
      return Math.abs(r - 1) * Math.min(rx, ry) <= a.width / 2 + tol;
    }
    case 'text':
    case 'replace': {
      const b = textFrameBox(a);
      const [lx, ly] = userToFrame(a, x, y);
      return lx >= b.x0 - tol && lx <= b.x1 + tol && ly >= b.y0 - tol && ly <= b.y1 + tol;
    }
    default:
      return boxContains(a, x, y, tol);
  }
}

// --- moving & resizing -------------------------------------------------------

export function moveAnnot<T extends Annot>(a: T, dx: number, dy: number): T {
  switch (a.type) {
    case 'ink':
      return { ...a, points: a.points.map(([x, y]) => [x + dx, y + dy]) };
    case 'line':
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    // a replacement's cover stays where the original text was; only the new
    // words move
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

/** Corner handles for box-like annotations, endpoints for lines. */
export function handlesFor(a: Annot): Point[] {
  switch (a.type) {
    case 'line':
    case 'arrow':
      return [[a.x1, a.y1], [a.x2, a.y2]];
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'whiteout':
    case 'redact':
    case 'image':
    case 'stamp':
    case 'field':
      return [[a.x, a.y], [a.x + a.w, a.y], [a.x, a.y + a.h], [a.x + a.w, a.y + a.h]];
    default:
      return [];
  }
}

/** Drags handle `index` (from handlesFor) to (x, y). */
export function dragHandle<T extends Annot>(a: T, index: number, x: number, y: number, keepRatio: boolean): T {
  if (a.type === 'line' || a.type === 'arrow') {
    return index === 0 ? { ...a, x1: x, y1: y } : { ...a, x2: x, y2: y };
  }
  if (!('w' in a)) return a;

  const corners = handlesFor(a);
  const [fx, fy] = corners[3 - index]; // the opposite corner stays put
  let box = normBox(fx, fy, x, y);

  if (keepRatio && a.w > 0 && a.h > 0) {
    const ratio = a.w / a.h;
    const w = Math.max(box.w, box.h * ratio);
    const h = w / ratio;
    box = normBox(fx, fy, fx + Math.sign(x - fx || 1) * w, fy + Math.sign(y - fy || 1) * h);
  }
  const min = 2;
  return { ...a, ...box, w: Math.max(box.w, min), h: Math.max(box.h, min) };
}

/** Drops points closer than `minDist` to keep pen strokes light. */
export function simplifyStroke(points: Point[], minDist: number): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [lx, ly] = out[out.length - 1];
    if (Math.hypot(points[i][0] - lx, points[i][1] - ly) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function newId(prefix = 'a'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;
}
