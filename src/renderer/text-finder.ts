// SPDX-License-Identifier: GPL-3.0-or-later
import { core } from './core';
import { documentFont, Family } from './custom-fonts';
import type { EditorDoc } from './document';
import { BASELINE } from './fonts';
import { newId, rotateVec, unionBox } from './geometry';
import type { Box, FontFamily, ReplaceAnnot } from './types';
import type { PDFPageProxy } from './pdf';
import type { PageView, Viewer } from './viewer';

export interface TextRun {
  str: string;
  /** Baseline start in user space. */
  x: number;
  y: number;
  /** Length along the baseline, in points. */
  width: number;
  size: number;
  /** Counter-clockwise, degrees. */
  angle: number;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  /** The font's name inside the PDF, e.g. "ABCDEF+Calibri". */
  fontName: string;
}

const cache = new WeakMap<object, Promise<TextRun[]>>();

export const ASCENT = 0.9;
export const DESCENT = 0.24;

function guessFamily(family: string, name: string): FontFamily {
  const s = `${family} ${name}`.toLowerCase();
  if (/mono|courier|consol|menlo/.test(s)) return 'mono';
  if (/serif|times|georgia|garamond|roman|cambria|minion|book/.test(s) && !/sans/.test(s)) return 'serif';
  return 'sans';
}

/** Text runs on a page with enough geometry to hit-test and replace them. */
export function textRuns(view: PageView): Promise<TextRun[]> {
  return pageRuns(view.pdfPage!);
}

/** The same, for a page that may not be on screen (Find, Compare). */
export function pageRuns(page: PDFPageProxy): Promise<TextRun[]> {
  let pending = cache.get(page);
  if (!pending) {
    pending = page.getTextContent().then((content) => {
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [a, b, c, d, e, f] = item.transform as number[];
        const size = Math.hypot(c, d) || Math.hypot(a, b);
        if (!size || !item.width) continue;
        const style = content.styles[item.fontName] ?? { fontFamily: '' };
        if ((style as { vertical?: boolean }).vertical) continue;

        // the real font name (e.g. "ABCDEF+Arial-BoldMT") tells us weight and slant
        let name = '';
        try {
          const font = page.commonObjs.get(item.fontName) as { name?: string } | undefined;
          name = font?.name ?? '';
        } catch {
          // fonts load lazily; if it isn't here yet we'll go by family alone
        }
        runs.push({
          str: item.str,
          x: e,
          y: f,
          width: item.width,
          size,
          angle: (Math.atan2(b, a) * 180) / Math.PI,
          font: guessFamily(style.fontFamily, name),
          bold: /bold|black|heavy|semibold|demi/i.test(name),
          italic: /italic|oblique/i.test(name),
          fontName: name,
        });
      }
      return runs;
    });
    cache.set(page, pending);
  }
  return pending;
}

export function runAt(runs: TextRun[], x: number, y: number, tol = 1): TextRun | null {
  for (const run of runs) {
    const [lx, ly] = rotateVec(x - run.x, y - run.y, -run.angle);
    if (lx >= -tol && lx <= run.width + tol && ly >= -run.size * DESCENT - tol && ly <= run.size * ASCENT + tol) {
      return run;
    }
  }
  return null;
}

/** The area a run occupies, as an axis-aligned box in user space. */
export function runBox(run: TextRun, pad = 0.6): Box {
  const corner = (lx: number, ly: number): [number, number] => {
    const [dx, dy] = rotateVec(lx, ly, run.angle);
    return [run.x + dx, run.y + dy];
  };
  const top = run.size * ASCENT, bottom = -run.size * DESCENT;
  return unionBox([corner(-pad, bottom), corner(run.width + pad, bottom), corner(-pad, top), corner(run.width + pad, top)]);
}

type RGB = [number, number, number];

const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const distance = (p: RGB, q: RGB) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/**
 * Works out the background and ink colours of a run by looking at the
 * rendered page: the background is the most common colour just outside the
 * run's box, the ink is whatever inside differs from it the most.
 */
function sampleColors(viewer: Viewer, view: PageView, box: Box): { background: string; ink: string } {
  const corners = [
    viewer.toLocal(view, box.x, box.y),
    viewer.toLocal(view, box.x + box.w, box.y + box.h),
  ];
  const x0 = Math.min(corners[0][0], corners[1][0]), x1 = Math.max(corners[0][0], corners[1][0]);
  const y0 = Math.min(corners[0][1], corners[1][1]), y1 = Math.max(corners[0][1], corners[1][1]);

  const counts = new Map<string, { rgb: RGB; n: number }>();
  const edge = 2;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const points: [number, number][] = [
      [x0 + (x1 - x0) * t, y0 - edge],
      [x0 + (x1 - x0) * t, y1 + edge],
      [x0 - edge, y0 + (y1 - y0) * t],
      [x1 + edge, y0 + (y1 - y0) * t],
    ];
    for (const [px, py] of points) {
      const rgb = view.sample(px, py);
      // bucket similar shades together so anti-aliasing doesn't win
      const key = rgb.map((v) => v >> 3).join(',');
      const entry = counts.get(key);
      if (entry) entry.n++;
      else counts.set(key, { rgb, n: 1 });
    }
  }
  const background = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.rgb ?? [255, 255, 255];

  let ink: RGB = [0, 0, 0];
  let best = 0;
  for (let i = 1; i < 24; i++) {
    for (let j = 1; j < 6; j++) {
      const rgb = view.sample(x0 + ((x1 - x0) * i) / 24, y0 + ((y1 - y0) * j) / 6);
      const d = distance(rgb, background);
      if (d > best) {
        best = d;
        ink = rgb;
      }
    }
  }
  if (best < 60) ink = background[0] + background[1] + background[2] > 380 ? [0, 0, 0] : [255, 255, 255];
  return { background: hex(background), ink: hex(ink) };
}

export function replacementFor(viewer: Viewer, view: PageView, run: TextRun): ReplaceAnnot {
  const cover = runBox(run);
  const { background, ink } = sampleColors(viewer, view, cover);
  const size = Math.round(run.size * 10) / 10;
  // our text frame starts at the top of the line box, a little above the baseline
  const [dx, dy] = rotateVec(0, size * BASELINE, run.angle);
  return {
    id: newId('r'),
    type: 'replace',
    x: run.x + dx,
    y: run.y + dy,
    angle: run.angle,
    text: run.str,
    original: run.str,
    size,
    font: run.font,
    bold: run.bold,
    italic: run.italic,
    color: ink,
    cover: { ...cover, color: background },
  };
}

const familyLookups = new WeakMap<TextRun, Promise<Family | null>>();

/**
 * The run's own embedded font, when it's safe to type with (see
 * documentFont). Cached per run, so hovering a line warms it up and the
 * click that follows usually finds it ready.
 */
export function originalFamily(doc: EditorDoc, view: PageView, run: TextRun): Promise<Family | null> {
  let pending = familyLookups.get(run);
  if (!pending) {
    const source = doc.sources.get(view.ref.src);
    pending = !source || !run.fontName
      ? Promise.resolve(null)
      : documentFont(
          source.id,
          run.fontName,
          async () => (await core.fontFile(source.bytes, view.ref.index, run.fontName)).data,
          { text: run.str, width: run.width, size: run.size },
          { bold: run.bold, italic: run.italic },
        ).catch(() => null);
    familyLookups.set(run, pending);
  }
  return pending;
}

/** Resolves to `fallback` if `promise` takes longer than `ms`. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// --- searching ------------------------------------------------------------------

let measurer: CanvasRenderingContext2D | null = null;

/**
 * Where characters [from, to) of a run sit along its baseline, in points.
 * PDFs don't tell us each letter's width here, so this shares the run's
 * known length out in proportion to how wide a similar font draws them.
 */
export function runSpan(run: TextRun, from: number, to: number): [number, number] {
  measurer ??= document.createElement('canvas').getContext('2d')!;
  const family = run.font === 'mono' ? 'monospace' : run.font === 'serif' ? 'serif' : 'sans-serif';
  measurer.font = `${run.bold ? '700 ' : ''}${run.italic ? 'italic ' : ''}20px ${family}`;
  const full = measurer.measureText(run.str).width || 1;
  const k = run.width / full;
  return [measurer.measureText(run.str.slice(0, from)).width * k, measurer.measureText(run.str.slice(0, to)).width * k];
}

/** The box covering part of a run, axis-aligned in user space. */
export function spanBox(run: TextRun, x0: number, x1: number): Box {
  const corner = (lx: number, ly: number): [number, number] => {
    const [dx, dy] = rotateVec(lx, ly, run.angle);
    return [run.x + dx, run.y + dy];
  };
  const top = run.size * ASCENT, bottom = -run.size * DESCENT;
  return unionBox([corner(x0, bottom), corner(x1, bottom), corner(x0, top), corner(x1, top)]);
}

/** Corners of part of a run in user space: top-left, top-right, bottom-left. */
export type Quad = [[number, number], [number, number], [number, number]];

export function spanQuad(run: TextRun, x0: number, x1: number): Quad {
  const corner = (lx: number, ly: number): [number, number] => {
    const [dx, dy] = rotateVec(lx, ly, run.angle);
    return [run.x + dx, run.y + dy];
  };
  const top = run.size * ASCENT, bottom = -run.size * DESCENT;
  return [corner(x0, top), corner(x1, top), corner(x0, bottom)];
}

/**
 * A page's text as one string, joining runs with spaces, plus where each run
 * starts in it, so a match can be traced back to the runs it covers.
 */
export interface PageText {
  text: string;
  runs: TextRun[];
  starts: number[];
}

export async function pageText(page: PDFPageProxy): Promise<PageText> {
  const runs = await pageRuns(page);
  let text = '';
  const starts: number[] = [];
  for (const run of runs) {
    starts.push(text.length);
    text += run.str;
    if (!/\s$/.test(run.str)) text += ' ';
  }
  return { text, runs, starts };
}

/** Shapes covering characters [from, to) of a page's joined text, turned with it. */
export function matchQuads(pt: PageText, from: number, to: number): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i < pt.runs.length; i++) {
    const start = pt.starts[i], end = start + pt.runs[i].str.length;
    if (end <= from || start >= to) continue;
    const a = Math.max(from, start) - start, b = Math.min(to, end) - start;
    if (b <= a) continue;
    const [x0, x1] = runSpan(pt.runs[i], a, b);
    quads.push(spanQuad(pt.runs[i], x0, x1));
  }
  return quads;
}

/**
 * Places a quad over a page as an absolutely positioned element, given a
 * function from user space to the element's local CSS pixels.
 */
export function placeQuad(el: HTMLElement, quad: Quad, toLocal: (x: number, y: number) => [number, number], pad = 0) {
  const [tl, tr, bl] = quad.map(([x, y]) => toLocal(x, y));
  const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const height = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
  Object.assign(el.style, {
    left: `${tl[0] - pad}px`,
    top: `${tl[1] - pad}px`,
    width: `${width + pad * 2}px`,
    height: `${height + pad * 2}px`,
    transformOrigin: `${pad}px ${pad}px`,
    transform: angle ? `rotate(${angle}rad)` : '',
  });
}

/** Boxes covering characters [from, to) of a page's joined text. */
export function matchBoxes(pt: PageText, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  for (let i = 0; i < pt.runs.length; i++) {
    const start = pt.starts[i], end = start + pt.runs[i].str.length;
    if (end <= from || start >= to) continue;
    const a = Math.max(from, start) - start, b = Math.min(to, end) - start;
    if (b <= a) continue;
    const [x0, x1] = runSpan(pt.runs[i], a, b);
    boxes.push(spanBox(pt.runs[i], x0, x1));
  }
  return boxes;
}
