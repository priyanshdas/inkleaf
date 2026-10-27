// SPDX-License-Identifier: GPL-3.0-or-later
// Selecting the PDF's own words with the Select tool. The words are laid
// out invisibly over each page (see PageView.layOutText). Left to itself the
// browser jumps to the end of the page as soon as the pointer leaves a word,
// and won't start a selection in the margin, so the drag is followed here
// instead: each end of the selection snaps to the word nearest the pointer.

interface Spot { node: Node; offset: number }

/** How far above or below a line (in screen pixels) a press still starts selecting it. */
const NEAR = 6;

let anchor: Spot | null = null;
let layer: HTMLElement | null = null;

/** Starts selecting if the press is on, or beside, a page's words. */
export function startTextSelect(e: PointerEvent): boolean {
  const page = (e.target as HTMLElement).closest('.page');
  const found = page?.querySelector<HTMLElement>('.page-text-layer');
  if (!found || !found.querySelector('span')) return false;
  // only on or level with a line of text: a press out in the empty part of
  // the page shouldn't grab words from somewhere else
  const spot = spotAt(found, e.clientX, e.clientY, false, NEAR);
  if (!spot) return false;
  anchor = spot;
  layer = found;
  window.getSelection()?.collapse(spot.node, spot.offset);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return true;
}

/** Double-click on a word selects the whole word. */
export function selectWordAt(e: MouseEvent): boolean {
  const page = (e.target as HTMLElement).closest('.page');
  const found = page?.querySelector<HTMLElement>('.page-text-layer');
  if (!found) return false;
  const spot = spotAt(found, e.clientX, e.clientY, true);
  if (!spot) return false;
  const text = spot.node.textContent ?? '';
  let a = spot.offset, b = spot.offset;
  const word = /[\p{L}\p{N}_'’-]/u;
  while (a > 0 && word.test(text[a - 1])) a--;
  while (b < text.length && word.test(text[b])) b++;
  if (a === b) return false;
  window.getSelection()?.setBaseAndExtent(spot.node, a, spot.node, b);
  return true;
}

/** The words selected on a page, if any. */
export function pageTextSelection(): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return '';
  const node = selection.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest('.page-text') ? selection.toString() : '';
}

export function clearPageText() {
  if (pageTextSelection()) window.getSelection()?.removeAllRanges();
}

function move(e: PointerEvent) {
  if (!anchor || !layer) return;
  const spot = spotAt(layer, e.clientX, e.clientY);
  if (spot) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, spot.node, spot.offset);
}

function end() {
  anchor = null;
  layer = null;
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', end);
  window.removeEventListener('pointercancel', end);
}

/**
 * The place in the text nearest a point: inside the word under it, or at
 * the start or end of the nearest line when the point is beside the text.
 * With `onWord`, only a point actually on a word counts.
 */
function spotAt(layer: HTMLElement, x: number, y: number, onWord = false, maxDy = Infinity): Spot | null {
  let best: HTMLElement | null = null;
  let bestRect: DOMRect | null = null;
  let bestScore = Infinity;
  let bestDy = Infinity;
  for (const span of layer.querySelectorAll<HTMLElement>('span:not(.markedContent)')) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent) continue;
    const r = span.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // distance to the line counts far more than distance along it, so a
    // point in the margin picks its own line rather than the one above
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const score = dy * 10 + dx;
    if (score < bestScore) {
      bestScore = score;
      bestDy = dy;
      best = span;
      bestRect = r;
    }
  }
  if (!best || !bestRect) return null;
  if (onWord && bestScore > 0) return null;
  if (bestDy > maxDy) return null;
  const node = best.firstChild as Text;
  return { node, offset: offsetAt(node, x, y) };
}

/**
 * Which character boundary along a line is nearest a point. Measured along
 * the line's own direction, so it works on turned pages and slanted text.
 */
function offsetAt(node: Text, x: number, y: number): number {
  const length = node.textContent!.length;
  const range = document.createRange();
  const centres: [number, number][] = [];
  for (let i = 0; i < length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    centres.push([r.left + r.width / 2, r.top + r.height / 2]);
  }
  if (!length) return 0;
  const [x0, y0] = centres[0];
  const [x1, y1] = centres[length - 1];
  let ax = x1 - x0, ay = y1 - y0;
  const n = Math.hypot(ax, ay);
  if (n < 0.5) [ax, ay] = [1, 0]; // one character: assume left to right
  else [ax, ay] = [ax / n, ay / n];
  const along = (px: number, py: number) => (px - x0) * ax + (py - y0) * ay;
  const t = along(x, y);
  let offset = 0;
  for (const [cx, cy] of centres) if (along(cx, cy) < t) offset++;
  return offset;
}
