// SPDX-License-Identifier: GPL-3.0-or-later
// Scan to PDF: scan pages on a scanner or all-in-one printer, take pictures
// of paper with a webcam, or pick photos from a phone; straighten each page
// from its four corners, clean it up so it looks scanned rather than
// photographed, and make a PDF (or add the pages to the open one).

import { t } from '../shared/i18n';
import { embeddable } from './tools';
import { h, icon, modal, toast } from './ui';

type Mode = 'original' | 'document' | 'bw';
type Pt = { x: number; y: number };

interface ScanPage {
  id: number;
  source: ImageBitmap;
  /** Corners in source pixels: top-left, top-right, bottom-right, bottom-left. */
  corners: [Pt, Pt, Pt, Pt];
  mode: Mode;
  /** Quarter turns applied after straightening. */
  turns: number;
  /** -100 to 100; 0 leaves the page as it is. */
  brightness: number;
  contrast: number;
  /** Came from a scanner, so the scanner settings' sliders adjust it. */
  scanned?: boolean;
  thumb: string;
}

let nextId = 1;

// --- finding the page -------------------------------------------------------------------

/**
 * Guesses where the sheet of paper is: paper is usually the big, bright
 * thing in the photo. Brightness is split into light and dark with Otsu's
 * method, then the corners are the light pixels furthest out along each
 * diagonal. When nothing convincing turns up, the whole photo is used.
 */
export function findPage(bitmap: ImageBitmap): [Pt, Pt, Pt, Pt] {
  const whole: [Pt, Pt, Pt, Pt] = [{ x: 0, y: 0 }, { x: bitmap.width, y: 0 }, { x: bitmap.width, y: bitmap.height }, { x: 0, y: bitmap.height }];
  const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), hgt = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, hgt);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, hgt);
  const { data } = ctx.getImageData(0, 0, w, hgt);
  const lum = new Uint8Array(w * hgt);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
    hist[lum[i]]++;
  }
  // Otsu
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = lum.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) [best, threshold] = [between, t];
  }
  let light = 0;
  const tl = { s: Infinity, x: 0, y: 0 }, tr = { s: -Infinity, x: 0, y: 0 }, br = { s: -Infinity, x: 0, y: 0 }, bl = { s: Infinity, x: 0, y: 0 };
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] <= threshold) continue;
      light++;
      if (x + y < tl.s) Object.assign(tl, { s: x + y, x, y });
      if (x + y > br.s) Object.assign(br, { s: x + y, x, y });
      if (x - y > tr.s) Object.assign(tr, { s: x - y, x, y });
      if (x - y < bl.s) Object.assign(bl, { s: x - y, x, y });
    }
  }
  const share = light / lum.length;
  // a page that fills almost everything, or hardly anything, isn't a find
  if (share < 0.15 || share > 0.93) return whole;
  const quad = [tl, tr, br, bl].map((p) => ({ x: p.x / scale, y: p.y / scale })) as [Pt, Pt, Pt, Pt];
  const area = Math.abs(quad.reduce((a, p, i) => { const q = quad[(i + 1) % 4]; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;
  if (area < bitmap.width * bitmap.height * 0.12) return whole;
  return quad;
}

// --- straightening ------------------------------------------------------------------------

/** The homography taking the unit square to the quad (Heckbert's method). */
function squareToQuad([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt]) {
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
  return (u: number, v: number) => {
    const z = g * u + hh * v + 1;
    return [(a * u + b * v + c) / z, (d * u + e * v + f) / z] as const;
  };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Cuts the page out of the photo and squares it up. */
function straighten(page: ScanPage, maxSide = 2200): ImageData {
  const [c0, c1, c2, c3] = page.corners;
  let w = Math.max(dist(c0, c1), dist(c3, c2)), hgt = Math.max(dist(c0, c3), dist(c1, c2));
  const shrink = Math.min(1, maxSide / Math.max(w, hgt));
  w = Math.max(1, Math.round(w * shrink));
  hgt = Math.max(1, Math.round(hgt * shrink));

  const src = new OffscreenCanvas(page.source.width, page.source.height);
  const sctx = src.getContext('2d')!;
  sctx.drawImage(page.source, 0, 0);
  const { data: s, width: sw, height: sh } = sctx.getImageData(0, 0, src.width, src.height);
  const out = new ImageData(w, hgt);
  const o = out.data;
  const map = squareToQuad(page.corners);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const [fx, fy] = map((x + 0.5) / w, (y + 0.5) / hgt);
      // bilinear sampling
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx - 0.5))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy - 0.5)));
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, fx - 0.5 - x0)), ty = Math.max(0, Math.min(1, fy - 0.5 - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const k = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = s[i00 + ch] + (s[i10 + ch] - s[i00 + ch]) * tx;
        const bottom = s[i01 + ch] + (s[i11 + ch] - s[i01 + ch]) * tx;
        o[k + ch] = top + (bottom - top) * ty;
      }
      o[k + 3] = 255;
    }
  }
  return out;
}

// --- cleaning up ------------------------------------------------------------------------------

/**
 * "Document" evens out the lighting: each pixel is divided by a heavily
 * blurred copy of the page (the paper's own brightness, shadows and all), so
 * the paper turns white and the ink stays dark. "Black & white" goes one
 * step further and keeps only ink.
 */
function enhance(img: ImageData, mode: Mode): ImageData {
  if (mode === 'original') return img;
  const { width: w, height: hgt, data } = img;
  // the background: a small, blurred copy, scaled back up
  const small = new OffscreenCanvas(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(hgt / 8)));
  const full = new OffscreenCanvas(w, hgt);
  full.getContext('2d')!.putImageData(img, 0, 0);
  const sctx = small.getContext('2d')!;
  sctx.filter = 'blur(6px)';
  sctx.drawImage(full, 0, 0, small.width, small.height);
  const bgSmall = sctx.getImageData(0, 0, small.width, small.height);
  const bg = new OffscreenCanvas(w, hgt);
  const bctx = bg.getContext('2d')!;
  const tmp = new OffscreenCanvas(small.width, small.height);
  // the brightest nearby value wins, so lines of ink don't darken the paper
  tmp.getContext('2d')!.putImageData(maxFilter(bgSmall, 2), 0, 0);
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(tmp, 0, 0, w, hgt);
  const b = bctx.getImageData(0, 0, w, hgt).data;

  const out = new ImageData(w, hgt);
  const o = out.data;
  for (let i = 0; i < data.length; i += 4) {
    let lumOut = 0;
    for (let ch = 0; ch < 3; ch++) {
      // flatten, then push near-white to white and lift contrast a little
      let v = (data[i + ch] / Math.max(1, b[i + ch])) * 255;
      v = (v - 40) * (255 / 190);
      v = Math.max(0, Math.min(255, v));
      o[i + ch] = v;
      lumOut += v * (ch === 0 ? 0.299 : ch === 1 ? 0.587 : 0.114);
    }
    if (mode === 'bw') {
      const ink = lumOut < 175 ? 0 : 255;
      o[i] = o[i + 1] = o[i + 2] = ink;
    }
    o[i + 3] = 255;
  }
  return out;
}

function maxFilter(img: ImageData, r: number): ImageData {
  const { width: w, height: hgt, data } = img;
  const out = new ImageData(w, hgt);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let m = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(hgt - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            m = Math.max(m, data[(yy * w + xx) * 4 + ch]);
          }
        }
        out.data[k + ch] = m;
      }
      out.data[k + 3] = 255;
    }
  }
  return out;
}

function rotated(img: ImageData, turns: number): OffscreenCanvas {
  const t = ((turns % 4) + 4) % 4;
  const c = new OffscreenCanvas(t % 2 ? img.height : img.width, t % 2 ? img.width : img.height);
  const ctx = c.getContext('2d')!;
  const flat = new OffscreenCanvas(img.width, img.height);
  flat.getContext('2d')!.putImageData(img, 0, 0);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((t * Math.PI) / 2);
  ctx.drawImage(flat, -img.width / 2, -img.height / 2);
  return c;
}

/** The browser's own brightness and contrast filters, scaled so the sliders' ends stay usable. */
const lightFilter = (brightness: number, contrast: number) =>
  brightness || contrast ? `brightness(${100 + brightness * 0.6}%) contrast(${100 + contrast * 0.8}%)` : 'none';

/** Brightness and contrast, before any clean-up, so black & white takes them into account. */
function adjust(img: ImageData, brightness: number, contrast: number): ImageData {
  if (!brightness && !contrast) return img;
  const from = new OffscreenCanvas(img.width, img.height);
  from.getContext('2d')!.putImageData(img, 0, 0);
  const to = new OffscreenCanvas(img.width, img.height);
  const ctx = to.getContext('2d')!;
  ctx.filter = lightFilter(brightness, contrast);
  ctx.drawImage(from, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

async function finished(page: ScanPage, maxSide?: number): Promise<OffscreenCanvas> {
  return rotated(enhance(adjust(straighten(page, maxSide), page.brightness, page.contrast), page.mode), page.turns);
}

async function canvasBytes(c: OffscreenCanvas, type: 'image/jpeg' | 'image/png', quality = 0.85) {
  return new Uint8Array(await (await c.convertToBlob({ type, quality })).arrayBuffer());
}

/** Builds the PDF: A4-width pages, as tall as each scan needs. */
export async function scansToPdf(pages: ScanPage[], progress: (m: string) => void): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    progress(t('Cleaning up page {n} of {total}…', { n: i + 1, total: pages.length }));
    const c = await finished(pages[i]);
    // black and white compresses far better losslessly
    const img = pages[i].mode === 'bw' ? await out.embedPng(await canvasBytes(c, 'image/png')) : await out.embedJpg(await canvasBytes(c, 'image/jpeg'));
    const landscape = c.width > c.height * 1.15;
    const pw = landscape ? 841.89 : 595.28;
    const ph = (pw * c.height) / c.width;
    out.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
  out.setProducer('InkLeaf PDF');
  out.setTitle('Scan');
  return out.save();
}

// --- the dialog --------------------------------------------------------------------------------

async function thumbOf(page: ScanPage): Promise<string> {
  const c = await finished(page, 260);
  return URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 }));
}

export interface Scanned {
  /** Builds the PDF; slow for many pages, so it runs under the busy indicator. */
  make(progress: (message: string) => void): Promise<Uint8Array>;
  pages: number;
  ocr: boolean;
}

// --- scanner settings --------------------------------------------------------------------------

type PaperSize = 'glass' | 'a4' | 'a5' | 'letter' | 'legal' | 'custom';
interface ScannerSettings {
  color: 'color' | 'gray' | 'bw';
  dpi: number;
  source: 'glass' | 'feeder' | 'duplex';
  size: PaperSize;
  /** A custom size, in `unit`. */
  width: number;
  height: number;
  unit: 'mm' | 'in';
  brightness: number;
  contrast: number;
}
const DEFAULTS: ScannerSettings = { color: 'color', dpi: 200, source: 'glass', size: 'glass', width: 210, height: 297, unit: 'mm', brightness: 0, contrast: 0 };
/** Paper sizes in millimetres. */
const PAPER: Record<Exclude<PaperSize, 'glass' | 'custom'>, [number, number]> = { a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4], legal: [215.9, 355.6] };
const RESOLUTIONS = [75, 100, 150, 200, 300, 400, 600];

const SCANNER_KEY = 'inkleaf.scanner';
/** The scanner used last, and each scanner's settings from last time. */
interface Stored { last?: string; scanners: Record<string, Partial<ScannerSettings>> }
function loadStored(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(SCANNER_KEY) ?? '{}');
    // before scanners had their own settings: one scanner, colour and resolution
    if (typeof raw.id === 'string') return { last: raw.id, scanners: { [raw.id]: { color: raw.color, dpi: raw.dpi } } };
    return { last: typeof raw.last === 'string' ? raw.last : undefined, scanners: raw.scanners && typeof raw.scanners === 'object' ? raw.scanners : {} };
  } catch {
    return { scanners: {} };
  }
}

/** The part of a scan that's the chosen paper size, from the glass's top corner where paper goes. */
function paperCorners(s: ScannerSettings, bitmap: ImageBitmap, dpi: number): [Pt, Pt, Pt, Pt] {
  let w = bitmap.width, hgt = bitmap.height;
  const mm = s.size === 'custom'
    ? [s.width, s.height].map((v) => (s.unit === 'in' ? v * 25.4 : v))
    : s.size === 'glass' ? null : PAPER[s.size];
  if (mm && mm[0] > 0 && mm[1] > 0) {
    w = Math.min(w, Math.round((mm[0] / 25.4) * dpi));
    hgt = Math.min(hgt, Math.round((mm[1] / 25.4) * dpi));
  }
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: hgt }, { x: 0, y: hgt }];
}

/**
 * The scanning dialog. Resolves to the pages taken, or null if cancelled.
 * `insert` is for adding pages to the open document: the dialog says so, and
 * starts on the scanner.
 */
export async function scanDialog(options: { insert?: boolean } = {}): Promise<Scanned | null> {
  const api = window.inkleaf;
  const hasScanner = !!api.listScanners && !!api.scanPages;
  const pages: ScanPage[] = [];
  let current: ScanPage | null = null;
  let stream: MediaStream | null = null;

  const video = h('video', { class: 'scan-video', autoplay: true, muted: true, playsinline: true }) as HTMLVideoElement;
  const editCanvas = h('canvas', { class: 'scan-canvas' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'scan-stage' }, h('div', { class: 'scan-empty' }, icon('scan-line'), h('p', {}, t('Point your camera at a page, or add photos you’ve already taken.'))));
  const strip = h('div', { class: 'scan-strip' });
  const count = h('span', { class: 'scan-count' }, t('No pages yet'));

  const cameraBtn = h('button', { class: 'btn' }, icon('camera'), t('Use camera'));
  const captureBtn = h('button', { class: 'btn btn-primary', hidden: true }, icon('aperture'), t('Take picture'));
  const photosBtn = h('button', { class: 'btn' }, icon('images'), t('Add photos…'));

  // a scanner or all-in-one printer
  const scannerBtn = h('button', { class: 'btn', hidden: !hasScanner }, icon('printer'), t('Use scanner'));
  const scannerPick = h('select', { class: 'field-input scanner-pick', 'aria-label': t('Scanner') }) as HTMLSelectElement;
  const scannerColor = h('select', { class: 'field-input scanner-color', 'aria-label': t('Colour') },
    new Option(t('Colour'), 'color'), new Option(t('Greyscale'), 'gray'), new Option(t('Black & white'), 'bw')) as HTMLSelectElement;
  const scanBtn = h('button', { class: 'btn btn-primary scanner-go' }, icon('scan-line'), t('Scan page')) as HTMLButtonElement;
  const findBtn = h('button', { class: 'btn small btn-ghost', title: t('Look for scanners again') }, icon('refresh-cw'));
  const settingsBtn = h('button', { class: 'btn small btn-ghost scanner-settings-btn', title: t('Scanner settings'), 'aria-expanded': 'false' }, icon('sliders-horizontal'), t('Settings')) as HTMLButtonElement;
  const scannerNote = h('span', { class: 'field-hint scanner-note' });

  // the settings: where the paper is, resolution, paper size, brightness and contrast
  const sourcePick = h('select', { class: 'field-input scanner-source' },
    new Option(t('Glass'), 'glass'), new Option(t('Document feeder'), 'feeder'), new Option(t('Feeder, both sides'), 'duplex')) as HTMLSelectElement;
  const dpiPick = h('select', { class: 'field-input scanner-dpi' }, ...RESOLUTIONS.map((n) => new Option(
    n === 150 ? t('Draft (150 dpi)') : n === 200 ? t('Standard (200 dpi)') : n === 300 ? t('Fine (300 dpi)') : t('{n} dpi', { n }), String(n)))) as HTMLSelectElement;
  const sizePick = h('select', { class: 'field-input scanner-size' },
    new Option(t('Whole glass'), 'glass'), new Option('A4', 'a4'), new Option('A5', 'a5'),
    new Option(t('Letter'), 'letter'), new Option(t('Legal'), 'legal'), new Option(t('Custom size'), 'custom')) as HTMLSelectElement;
  const widthIn = h('input', { class: 'field-input scanner-width', type: 'number', min: '10', step: 'any', 'aria-label': t('Width') }) as HTMLInputElement;
  const heightIn = h('input', { class: 'field-input scanner-height', type: 'number', min: '10', step: 'any', 'aria-label': t('Height') }) as HTMLInputElement;
  const unitPick = h('select', { class: 'field-input scanner-unit', 'aria-label': t('Unit') }, new Option('mm', 'mm'), new Option('in', 'in')) as HTMLSelectElement;
  const customSize = h('span', { class: 'scanner-custom' }, widthIn, h('span', {}, '×'), heightIn, unitPick);
  const slider = (cls: string) => h('input', { class: `scanner-${cls}`, type: 'range', min: '-100', max: '100', step: '1' }) as HTMLInputElement;
  const brightness = slider('brightness');
  const contrast = slider('contrast');
  const brightnessOut = h('output', { class: 'scanner-value' });
  const contrastOut = h('output', { class: 'scanner-value' });
  const resetLight = h('button', { class: 'btn small btn-ghost', title: t('Reset brightness and contrast') }, icon('rotate-ccw'));
  const field = (label: string, ...controls: Node[]) => h('label', { class: 'scanner-field' }, h('span', { class: 'scanner-label' }, label), ...controls);
  const settingsPanel = h('div', { class: 'scanner-settings', hidden: true },
    field(t('Paper'), sourcePick),
    field(t('Resolution'), dpiPick),
    field(t('Page size'), sizePick, customSize),
    field(t('Brightness'), brightness, brightnessOut),
    field(t('Contrast'), contrast, contrastOut, resetLight),
    h('span', { class: 'field-hint scanner-settings-hint' }, t('Brightness and contrast also change the page you’re looking at, if it came from the scanner.')),
  );
  const scannerBar = h('div', { class: 'scanner-bar', hidden: true }, scannerPick, scannerColor, settingsBtn, findBtn, scanBtn, settingsPanel, scannerNote);

  const stored = loadStored();
  const settingsFor = (id: string): ScannerSettings => ({ ...DEFAULTS, ...(stored.scanners[id] ?? {}) });
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const show = (s: ScannerSettings) => {
    scannerColor.value = s.color;
    sourcePick.value = s.source;
    dpiPick.value = String(RESOLUTIONS.includes(s.dpi) ? s.dpi : DEFAULTS.dpi);
    sizePick.value = s.size;
    widthIn.value = String(s.width);
    heightIn.value = String(s.height);
    unitPick.value = s.unit;
    brightness.value = String(s.brightness);
    contrast.value = String(s.contrast);
    refreshControls();
  };
  const read = (): ScannerSettings => ({
    color: scannerColor.value as ScannerSettings['color'],
    dpi: Number(dpiPick.value),
    source: sourcePick.value as ScannerSettings['source'],
    size: sizePick.value as PaperSize,
    width: Number(widthIn.value) || DEFAULTS.width,
    height: Number(heightIn.value) || DEFAULTS.height,
    unit: unitPick.value as 'mm' | 'in',
    brightness: Number(brightness.value),
    contrast: Number(contrast.value),
  });
  function refreshControls() {
    customSize.hidden = sizePick.value !== 'custom';
    brightnessOut.textContent = signed(Number(brightness.value));
    contrastOut.textContent = signed(Number(contrast.value));
    const feeder = sourcePick.value !== 'glass';
    scanBtn.replaceChildren(icon('scan-line'), feeder ? t('Scan pages') : t('Scan page'));
  }
  const remember = () => {
    refreshControls();
    if (!scannerPick.value) return;
    stored.last = scannerPick.value;
    stored.scanners[scannerPick.value] = read();
    try {
      localStorage.setItem(SCANNER_KEY, JSON.stringify(stored));
    } catch {
      // only a convenience
    }
  };
  show(settingsFor(stored.last ?? ''));
  scannerPick.addEventListener('change', () => { show(settingsFor(scannerPick.value)); remember(); });
  [scannerColor, sourcePick, dpiPick, sizePick, widthIn, heightIn, unitPick].forEach((el) => el.addEventListener('change', remember));
  // inches and millimetres: keep the same size when the unit changes
  let unitWas = unitPick.value;
  unitPick.addEventListener('change', () => {
    const k = unitPick.value === 'in' && unitWas === 'mm' ? 1 / 25.4 : unitPick.value === 'mm' && unitWas === 'in' ? 25.4 : 1;
    unitWas = unitPick.value;
    widthIn.value = String(Math.round(Number(widthIn.value) * k * 100) / 100);
    heightIn.value = String(Math.round(Number(heightIn.value) * k * 100) / 100);
    remember();
  });
  settingsBtn.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settingsPanel.hidden));
  });
  // the sliders show their effect straight away on a page from the scanner
  let thumbTimer = 0;
  const light = () => {
    remember();
    if (!current?.scanned) return;
    current.brightness = Number(brightness.value);
    current.contrast = Number(contrast.value);
    draw();
    clearTimeout(thumbTimer);
    const p = current;
    thumbTimer = window.setTimeout(() => void updateThumb(p), 250);
  };
  brightness.addEventListener('input', light);
  contrast.addEventListener('input', light);
  resetLight.addEventListener('click', (e) => {
    e.preventDefault();
    brightness.value = contrast.value = '0';
    light();
  });
  const mode = h('select', { class: 'field-input scan-mode', title: t('How the page is cleaned up') },
    new Option(t('Document (whiter paper, sharper ink)'), 'document'),
    new Option(t('Black & white'), 'bw'),
    new Option(t('Original colours'), 'original'));
  const turnBtn = h('button', { class: 'btn small btn-ghost', title: t('Turn the page') }, icon('rotate-cw'));
  const resetBtn = h('button', { class: 'btn small btn-ghost', title: t('Use the whole photo') }, icon('maximize'));
  const removeBtn = h('button', { class: 'btn small btn-ghost', title: t('Remove this page') }, icon('trash-2'));
  const pageTools = h('div', { class: 'scan-page-tools', hidden: true }, h('span', { class: 'field-hint' }, t('Drag the corners onto the page’s corners.')), mode, turnBtn, resetBtn, removeBtn);
  const ocr = h('input', { type: 'checkbox' }) as HTMLInputElement;

  const stopCamera = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    captureBtn.hidden = true;
    cameraBtn.hidden = false;
  };

  const findScanners = async () => {
    scannerPick.replaceChildren(new Option(t('Looking for scanners…'), ''));
    scannerPick.disabled = scanBtn.disabled = true;
    scannerNote.textContent = '';
    const found = await api.listScanners!().catch(() => ({ ok: false as const, message: t('InkLeaf PDF couldn’t look for scanners.') }));
    scannerPick.disabled = false;
    if (!found.ok || !found.scanners.length) {
      scannerPick.replaceChildren(new Option(t('No scanner found'), ''));
      scannerNote.textContent = found.ok
        ? t('Check the scanner is switched on and connected. Some printers need their maker’s full software for scanning, not just the printer driver.')
        : (found.message ?? '');
      return;
    }
    scannerPick.replaceChildren(...found.scanners.map((s) => new Option(s.name, s.id)));
    if (stored.last && found.scanners.some((s) => s.id === stored.last)) scannerPick.value = stored.last;
    show(settingsFor(scannerPick.value));
    scanBtn.disabled = false;
  };
  const openScanner = () => {
    if (stream) stopCamera();
    scannerBar.hidden = false;
    scannerBtn.hidden = true;
    if (!pages.length) stage.replaceChildren(h('div', { class: 'scan-empty' }, icon('printer'), h('p', {}, t('Put the page face down on the scanner’s glass, close the lid, then press Scan page.'))));
    void findScanners();
  };
  scannerBtn.addEventListener('click', openScanner);
  findBtn.addEventListener('click', () => void findScanners());
  scanBtn.addEventListener('click', async () => {
    if (!scannerPick.value) return;
    const settings = read();
    const feeder = settings.source !== 'glass';
    scanBtn.disabled = true;
    scanBtn.replaceChildren(h('span', { class: 'spinner' }), t('Scanning…'));
    scannerNote.textContent = '';
    stage.replaceChildren(h('div', { class: 'scan-empty' }, h('span', { class: 'spinner large' }),
      h('p', {}, feeder ? t('Scanning the pages in the feeder…') : t('Scanning… keep the lid closed until it’s done.'))));
    try {
      const result = await api.scanPages!(scannerPick.value, { dpi: settings.dpi, color: settings.color, source: settings.source });
      if (!result.ok) {
        scannerNote.textContent = result.message;
        select(current);
        return;
      }
      let last: ScanPage | null = null;
      for (const data of result.pages) {
        const bitmap = await createImageBitmap(new Blob([data as BlobPart]));
        // a scan is already straight and square: keep the paper size asked
        // for, and its colours, unless the person picks a clean-up for the page
        const p = await addBitmap(bitmap, { corners: paperCorners(settings, bitmap, result.dpi), mode: settings.color === 'bw' ? 'bw' : 'original', brightness: settings.brightness, contrast: settings.contrast, scanned: true });
        last = p;
      }
      select(last);
      scannerNote.textContent = feeder
        ? t('{count, plural, one {# page} other {# pages}} scanned from the feeder.', { count: result.pages.length })
        : t('Page {n} scanned. Put the next page on the glass and press Scan page again.', { n: pages.length });
    } catch {
      scannerNote.textContent = t('The scan couldn’t be read. Try again.');
      select(current);
    } finally {
      scanBtn.disabled = false;
      refreshControls();
    }
  });

  const refreshStrip = () => {
    strip.replaceChildren(...pages.map((p, i) => {
      const el = h('button', { class: `scan-thumb${p === current ? ' active' : ''}`, title: t('Page {n}', { n: i + 1 }) }, h('img', { src: p.thumb, alt: '' }), h('span', {}, String(i + 1)));
      el.addEventListener('click', () => select(p));
      return el;
    }));
    count.textContent = pages.length ? t('{count, plural, one {# page} other {# pages}}', { count: pages.length }) : t('No pages yet');
  };

  const updateThumb = async (p: ScanPage) => {
    const old = p.thumb;
    p.thumb = await thumbOf(p);
    if (old) URL.revokeObjectURL(old);
    refreshStrip();
  };

  // corner editing on the canvas
  let fit = { scale: 1, ox: 0, oy: 0 };
  const draw = () => {
    if (!current) return;
    const box = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(200, box.width), bh = Math.max(200, box.height);
    editCanvas.width = bw * dpr;
    editCanvas.height = bh * dpr;
    editCanvas.style.width = `${bw}px`;
    editCanvas.style.height = `${bh}px`;
    const ctx = editCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    const src = current.source;
    const scale = Math.min((bw - 24) / src.width, (bh - 24) / src.height);
    fit = { scale, ox: (bw - src.width * scale) / 2, oy: (bh - src.height * scale) / 2 };
    ctx.filter = lightFilter(current.brightness, current.contrast);
    ctx.drawImage(src, fit.ox, fit.oy, src.width * scale, src.height * scale);
    ctx.filter = 'none';
    const pts = current.corners.map((p) => ({ x: fit.ox + p.x * scale, y: fit.oy + p.y * scale }));
    // dim everything outside the page
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, bw, bh);
    ctx.moveTo(pts[0].x, pts[0].y);
    [3, 2, 1].forEach((i) => ctx.lineTo(pts[i].x, pts[i].y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(10, 20, 16, 0.45)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#93e6c1';
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#2b7356';
      ctx.stroke();
    }
  };
  let dragging = -1;
  editCanvas.addEventListener('pointerdown', (e) => {
    if (!current) return;
    const r = editCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bestD = 28;
    current.corners.forEach((p, i) => {
      const d = Math.hypot(fit.ox + p.x * fit.scale - x, fit.oy + p.y * fit.scale - y);
      if (d < bestD) [best, bestD] = [i, d];
    });
    if (best < 0) return;
    dragging = best;
    editCanvas.setPointerCapture(e.pointerId);
  });
  editCanvas.addEventListener('pointermove', (e) => {
    if (dragging < 0 || !current) return;
    const r = editCanvas.getBoundingClientRect();
    current.corners[dragging] = {
      x: Math.max(0, Math.min(current.source.width, (e.clientX - r.left - fit.ox) / fit.scale)),
      y: Math.max(0, Math.min(current.source.height, (e.clientY - r.top - fit.oy) / fit.scale)),
    };
    draw();
  });
  const endDrag = () => {
    if (dragging < 0 || !current) return;
    dragging = -1;
    updateThumb(current);
  };
  editCanvas.addEventListener('pointerup', endDrag);
  editCanvas.addEventListener('pointercancel', endDrag);

  function select(p: ScanPage | null) {
    current = p;
    if (p) {
      if (stream) stopCamera();
      stage.replaceChildren(editCanvas);
      mode.value = p.mode;
      pageTools.hidden = false;
      requestAnimationFrame(draw);
    } else {
      pageTools.hidden = true;
      if (!stream) stage.replaceChildren(h('div', { class: 'scan-empty' }, icon('scan-line'), h('p', {}, pages.length ? t('Pick a page below to adjust it, or add more.') : t('Point your camera at a page, or add photos you’ve already taken.'))));
    }
    refreshStrip();
  }

  const addBitmap = async (bitmap: ImageBitmap, from?: Partial<ScanPage>) => {
    const p: ScanPage = { id: nextId++, source: bitmap, corners: findPage(bitmap), mode: (mode.value as Mode) || 'document', turns: 0, brightness: 0, contrast: 0, thumb: '', ...from };
    pages.push(p);
    await updateThumb(p);
    return p;
  };

  cameraBtn.addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 }, facingMode: 'environment' }, audio: false });
    } catch (err) {
      const name = (err as DOMException).name;
      toast(name === 'NotFoundError' || name === 'OverconstrainedError' ? t('No camera was found. You can add photos instead.') : t('InkLeaf PDF couldn’t use the camera. Check that no other app is using it, and that camera access is allowed in your system settings.'), 'error', 7000);
      return;
    }
    current = null;
    pageTools.hidden = true;
    scannerBar.hidden = true;
    scannerBtn.hidden = !hasScanner;
    video.srcObject = stream;
    stage.replaceChildren(video);
    cameraBtn.hidden = true;
    captureBtn.hidden = false;
    refreshStrip();
  });
  captureBtn.addEventListener('click', async () => {
    if (!stream || !video.videoWidth) return;
    const bitmap = await createImageBitmap(video);
    stage.classList.add('flash');
    setTimeout(() => stage.classList.remove('flash'), 180);
    await addBitmap(bitmap);
    // the camera stays on for the next page; the strip shows what was taken
  });
  photosBtn.addEventListener('click', async () => {
    const files = await window.inkleaf.pickImages();
    let last: ScanPage | null = null;
    for (const file of files) {
      try {
        const img = await embeddable(file);
        last = await addBitmap(await createImageBitmap(new Blob([img.bytes as BlobPart])));
      } catch {
        toast(t('Couldn’t read “{name}”.', { name: file.name }), 'error');
      }
    }
    if (last) select(last);
  });
  mode.addEventListener('change', () => {
    if (!current) return;
    current.mode = mode.value as Mode;
    updateThumb(current);
  });
  turnBtn.addEventListener('click', () => {
    if (!current) return;
    current.turns = (current.turns + 1) % 4;
    updateThumb(current);
  });
  resetBtn.addEventListener('click', () => {
    if (!current) return;
    const { width: w, height: hgt } = current.source;
    current.corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: hgt }, { x: 0, y: hgt }];
    draw();
    updateThumb(current);
  });
  removeBtn.addEventListener('click', () => {
    if (!current) return;
    const i = pages.indexOf(current);
    pages.splice(i, 1);
    URL.revokeObjectURL(current.thumb);
    current.source.close();
    select(pages[Math.min(i, pages.length - 1)] ?? null);
  });
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  const body = h('div', { class: 'scan' },
    h('div', { class: 'scan-bar' }, scannerBtn, cameraBtn, captureBtn, photosBtn, h('span', { class: 'spacer' }), count),
    scannerBar,
    stage,
    pageTools,
    strip,
    h('label', { class: 'check' }, ocr, h('span', {}, t('Recognise the text afterwards, so it can be searched and copied'))),
  );
  if (options.insert && hasScanner) openScanner();
  const choice = await modal({
    title: options.insert ? t('Insert scanned pages') : t('Scan to PDF'),
    wide: true,
    body,
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: options.insert ? t('Insert pages') : t('Make PDF'), value: 'ok', primary: true }],
    validate: async (value) => {
      if (value === 'ok' && !pages.length) {
        toast(t('Add at least one page first.'), 'info');
        return false;
      }
      return true;
    },
  });
  stopCamera();
  window.removeEventListener('resize', onResize);
  if (choice !== 'ok') {
    pages.forEach((p) => (URL.revokeObjectURL(p.thumb), p.source.close()));
    return null;
  }
  return {
    pages: pages.length,
    ocr: ocr.checked,
    make: async (progress) => {
      try {
        return await scansToPdf(pages, progress);
      } finally {
        pages.forEach((p) => (URL.revokeObjectURL(p.thumb), p.source.close()));
      }
    },
  };
}
