// SPDX-License-Identifier: GPL-3.0-or-later
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';

export type { PDFDocumentProxy, PDFPageProxy };
export type PageViewport = ReturnType<PDFPageProxy['getViewport']>;
export const AnnotationMode = pdfjs.AnnotationMode;

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js transfers the buffer to its worker, so hand it a copy and keep ours.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    wasmUrl: './vendor/pdfjs/wasm/',
    iccUrl: './vendor/pdfjs/iccs/',
    enableXfa: false,
    // keeps each font's real name ("ABCDEF+Calibri-Bold") on hand, which
    // Edit text uses to match weight, slant and the original font file
    fontExtraProperties: true,
    // we decrypt with the Rust core before pdf.js ever sees a file, so a
    // password prompt here would mean something has gone wrong
    password: '',
  });
  return task.promise;
}

export interface PageInfo {
  /** Size of the visible page area in points, before rotation. */
  width: number;
  height: number;
  /** The visible area itself, [x0, y0, x1, y1] in user space. */
  view: [number, number, number, number];
  /** The page's own /Rotate, in degrees clockwise. */
  rotate: number;
}

export async function readPageInfo(pdf: PDFDocumentProxy): Promise<PageInfo[]> {
  // ask for every page at once; the worker answers them in parallel, which is
  // far quicker than one round trip per page
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  return pages.map((page) => {
    const [x0, y0, x1, y1] = page.view;
    return { width: x1 - x0, height: y1 - y0, rotate: page.rotate, view: [x0, y0, x1, y1] };
  });
}

/**
 * A viewport for a page, optionally showing only part of it (a crop). pdf.js
 * doesn't export its viewport class, so a crop borrows the constructor from
 * an ordinary viewport.
 */
export function pageViewport(page: PDFPageProxy, scale: number, rotation: number, crop?: { x: number; y: number; w: number; h: number } | null): PageViewport {
  const vp = page.getViewport({ scale, rotation });
  if (!crop) return vp;
  const Viewport = vp.constructor as new (options: object) => PageViewport;
  return new Viewport({
    viewBox: [crop.x, crop.y, crop.x + crop.w, crop.y + crop.h],
    userUnit: (page as unknown as { userUnit?: number }).userUnit ?? 1,
    scale,
    rotation,
    offsetX: 0,
    offsetY: 0,
    dontFlip: false,
  });
}

const ENCRYPT = new TextEncoder().encode('/Encrypt');

function contains(bytes: Uint8Array, needle: Uint8Array, from: number, to: number): boolean {
  const first = needle[0];
  for (let i = bytes.indexOf(first, from); i !== -1 && i <= to - needle.length; i = bytes.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && bytes[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

/**
 * Quick check for encryption. The /Encrypt entry lives in the trailer, which
 * is at the end of the file (and near the start too in "fast web view"
 * files), so there's no need to read the middle of a big PDF.
 */
export function mightBeEncrypted(bytes: Uint8Array): boolean {
  const window = 1 << 20;
  if (bytes.length <= window * 2) return contains(bytes, ENCRYPT, 0, bytes.length);
  return contains(bytes, ENCRYPT, 0, window) || contains(bytes, ENCRYPT, bytes.length - window, bytes.length);
}
