// SPDX-License-Identifier: GPL-3.0-or-later
// Page enhancer: makes faded scans, grey photocopies and photos of documents
// easier to read.
//
// Two ways to use it, built on the same steps so they look the same:
//   - on screen, as a filter over each page's picture (instant, and the file
//     is never touched; your own marks on top aren't filtered);
//   - "Save enhanced copy", which draws every page with the steps applied and
//     saves them as a new PDF.
//
// The steps, in order: greyscale → levels (whiten the paper, deepen the ink)
// → brightness and contrast → sharpen → night (light text on dark).

import { msg, t } from '../shared/i18n';
import { h, icon } from './ui';
import type { Viewer } from './viewer';

export interface Enhance {
  /** -50 … 100 */
  contrast: number;
  /** -50 … 50 */
  brightness: number;
  /** 0 … 100 */
  sharpness: number;
  /** Make the paper white and the ink dark, measured for each page. */
  whiten: boolean;
  greyscale: boolean;
  /** Light text on a dark page, for reading at night. Screen only. */
  night: boolean;
}

export const NEUTRAL: Enhance = { contrast: 0, brightness: 0, sharpness: 0, whiten: false, greyscale: false, night: false };

export const PRESETS: { id: string; label: string; settings: Enhance }[] = [
  { id: 'auto', label: msg('Auto'), settings: { contrast: 15, brightness: 0, sharpness: 35, whiten: true, greyscale: false, night: false } },
  { id: 'scan', label: msg('Scan'), settings: { contrast: 25, brightness: 0, sharpness: 55, whiten: true, greyscale: true, night: false } },
  { id: 'faded', label: msg('Faded'), settings: { contrast: 45, brightness: -6, sharpness: 40, whiten: true, greyscale: false, night: false } },
  { id: 'ink', label: msg('Darker text'), settings: { contrast: 35, brightness: -12, sharpness: 30, whiten: true, greyscale: true, night: false } },
  { id: 'night', label: msg('Night'), settings: { contrast: 10, brightness: 0, sharpness: 0, whiten: true, greyscale: false, night: true } },
];

export const isNeutral = (s: Enhance) =>
  !s.contrast && !s.brightness && !s.sharpness && !s.whiten && !s.greyscale && !s.night;

// --- the maths, shared by the screen filter and the saved copy -----------------------------------

/**
 * Where a page's ink (black) and paper (white) sit, from 0 to 1. The paper is measured per
 * colour channel, so yellowed or blue-grey paper comes out neutral white rather than brighter
 * and still tinted.
 */
export interface Levels {
  /** the ink's red, green and blue */
  black: [number, number, number];
  /** the paper's red, green and blue */
  white: [number, number, number];
  /** the ink's and paper's overall brightness, used when the page is turned grey */
  greyBlack: number;
  greyWhite: number;
}
const FLAT: Levels = { black: [0, 0, 0], white: [1, 1, 1], greyBlack: 0, greyWhite: 1 };

const luma = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722;

/**
 * Measures a page: the paper is the most common bright tone, the ink the darkest few pixels.
 * Leaves pages alone that are already clean.
 */
export function measureLevels(data: Uint8ClampedArray): Levels {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    hist[luma(data[i], data[i + 1], data[i + 2]) | 0]++;
    n++;
  }
  if (!n) return FLAT;
  // paper: the busiest tone in the brighter part of the page
  let paper = 255;
  let most = 0;
  for (let v = 110; v < 256; v++) {
    if (hist[v] > most) {
      most = hist[v];
      paper = v;
    }
  }
  // ink: the darkest 0.2% (ignoring specks)
  let seen = 0;
  let ink = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= n * 0.002) {
      ink = v;
      break;
    }
  }
  // the colours of both: the average of the pixels with those tones, so a tinted page turns
  // neutral (black on white) instead of just brighter
  const paperSum = [0, 0, 0], inkSum = [0, 0, 0];
  let paperCount = 0, inkCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = luma(data[i], data[i + 1], data[i + 2]);
    if (Math.abs(l - paper) <= 6) {
      for (let c = 0; c < 3; c++) paperSum[c] += data[i + c];
      paperCount++;
    } else if (l <= ink) {
      for (let c = 0; c < 3; c++) inkSum[c] += data[i + c];
      inkCount++;
    }
  }
  // a little under the paper's tone, so its grain turns white too
  const whitePoint = (v: number) => Math.max(0.55, (v - 8) / 255);
  // faded ink can sit halfway to the paper; pulling it down to black is the point
  const blackPoint = (v: number) => {
    const b = Math.min(0.5, v / 255);
    return b < 0.05 ? 0 : b;
  };
  const white = paperSum.map((v) => whitePoint(paperCount ? v / paperCount : paper)) as [number, number, number];
  const black = inkSum.map((v) => blackPoint(inkCount ? v / inkCount : ink)) as [number, number, number];
  let greyWhite = whitePoint(paper);
  const greyBlack = blackPoint(ink);
  if (white.every((w) => w > 0.97)) {
    white.fill(1);
    greyWhite = 1;
  }
  if (greyWhite - greyBlack < 0.18) return FLAT;
  return { black, white, greyBlack, greyWhite };
}

type Curve = { slope: number; intercept: number };

/**
 * Levels, brightness and contrast together, as one straight line per colour channel:
 * out = in × slope + intercept.
 */
export function toneCurves(s: Enhance, levels: Levels): [Curve, Curve, Curve] {
  const l = s.whiten ? levels : FLAT;
  const k = 1 + s.contrast / 100;
  const b = (s.brightness / 100) * 0.5;
  return [0, 1, 2].map((ch) => {
    const white = s.greyscale ? l.greyWhite : l.white[ch];
    const black = s.greyscale ? l.greyBlack : l.black[ch];
    const a = 1 / Math.max(0.05, white - black);
    const c = -black * a;
    return { slope: a * k, intercept: (c - 0.5) * k + 0.5 + b };
  }) as [Curve, Curve, Curve];
}

/** How strongly to sharpen: the weight of each neighbour in a 3×3 sharpening kernel. */
const sharpenWeight = (s: Enhance) => (s.sharpness / 100) * 0.9;

/** Night mode: inverted, but onto a soft dark grey with light grey text, rather than pure black and white. */
const NIGHT = { slope: -0.8, intercept: 0.9 };

/** Applies the steps to pixels (in place). Night mode is for the screen, so it's left out here. */
export function enhancePixels(image: ImageData, s: Enhance, levels: Levels) {
  const { data, width, height } = image;
  const luts = toneCurves(s, levels).map(({ slope, intercept }) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round((v / 255 * slope + intercept) * 255);
    return lut;
  });
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (s.greyscale) r = g = b = Math.round(luma(r, g, b));
    data[i] = luts[0][r];
    data[i + 1] = luts[1][g];
    data[i + 2] = luts[2][b];
  }
  const w = sharpenWeight(s);
  if (w > 0) {
    const src = new Uint8ClampedArray(data);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const up = y > 0 ? -row : 0;
      const down = y < height - 1 ? row : 0;
      for (let x = 0; x < width; x++) {
        const i = y * row + x * 4;
        const left = x > 0 ? -4 : 0;
        const right = x < width - 1 ? 4 : 0;
        for (let ch = 0; ch < 3; ch++) {
          const p = i + ch;
          data[p] = src[p] * (1 + 4 * w) - w * (src[p + up] + src[p + down] + src[p + left] + src[p + right]);
        }
      }
    }
  }
}

// --- on screen ---------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The same steps as enhancePixels (plus night mode), as an SVG filter the browser runs on the GPU. */
function buildFilter(id: string, s: Enhance, levels: Levels): SVGFilterElement {
  const f = svg('filter', { id, 'color-interpolation-filters': 'sRGB', x: 0, y: 0, width: 1, height: 1 });
  if (s.greyscale) f.append(svg('feColorMatrix', { type: 'saturate', values: 0 }));
  const curves = toneCurves(s, levels);
  if (curves.some((c) => Math.abs(c.slope - 1) > 1e-4 || Math.abs(c.intercept) > 1e-4)) {
    const tone = svg('feComponentTransfer', {});
    (['feFuncR', 'feFuncG', 'feFuncB'] as const).forEach((ch, i) => tone.append(svg(ch, { type: 'linear', ...curves[i] })));
    f.append(tone);
  }
  const w = sharpenWeight(s);
  if (w > 0) {
    f.append(svg('feConvolveMatrix', {
      order: 3, preserveAlpha: 'true', edgeMode: 'duplicate',
      kernelMatrix: `0 ${-w} 0 ${-w} ${1 + 4 * w} ${-w} 0 ${-w} 0`,
    }));
  }
  if (s.night) {
    const inv = svg('feComponentTransfer', {});
    for (const ch of ['feFuncR', 'feFuncG', 'feFuncB'] as const) inv.append(svg(ch, { type: 'linear', ...NIGHT }));
    f.append(inv, svg('feColorMatrix', { type: 'hueRotate', values: 180 }));
  }
  return f;
}

/** Pixels of a page's picture, scaled down but still sharp enough that thin text keeps its tone. */
function sample(canvas: HTMLCanvasElement): Uint8ClampedArray | null {
  if (!canvas.width || !canvas.height) return null;
  const scale = Math.min(1, 800 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale)), hgt = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = hgt;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, hgt);
  try {
    return ctx.getImageData(0, 0, w, hgt).data;
  } catch {
    return null;
  }
}

/**
 * Shows the pages of the open document enhanced. Each page gets its own filter, since every
 * page of a scan has its own paper and ink tones. The page's marks aren't touched.
 */
export class EnhancedView {
  private defs: SVGDefsElement;
  private settings: Enhance = NEUTRAL;
  private levels = new Map<string, Levels>();
  private queued = new Set<string>();
  private frame = 0;

  constructor(private viewer: Viewer) {
    const root = svg('svg', { width: 0, height: 0, 'aria-hidden': 'true' });
    root.style.position = 'absolute';
    this.defs = svg('defs', {});
    root.append(this.defs);
    document.body.append(root);
    // pages are drawn (and redrawn at each zoom) as they scroll into view: filter each new one
    new MutationObserver((records) => {
      if (isNeutral(this.settings)) return;
      for (const r of records) {
        for (const node of r.addedNodes) {
          const page = (node as HTMLElement).closest?.('.page') as HTMLElement | null;
          if (page?.dataset.pageId) this.queue(page.dataset.pageId);
        }
      }
    }).observe(viewer.pagesEl, { childList: true, subtree: true });
  }

  get current(): Enhance {
    return this.settings;
  }

  get active(): boolean {
    return !isNeutral(this.settings);
  }

  /** New settings for every page (NEUTRAL turns it off). */
  set(settings: Enhance) {
    this.settings = { ...settings };
    for (const id of this.viewer.views.keys()) this.queue(id);
    document.documentElement.classList.toggle('enhanced', this.active);
  }

  /** Another document is showing: its pages are measured afresh. */
  reset(settings: Enhance = NEUTRAL) {
    this.levels.clear();
    this.defs.replaceChildren();
    this.set(settings);
  }

  private queue(id: string) {
    this.queued.add(id);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.frame = 0;
    const ids = [...this.queued];
    this.queued.clear();
    for (const id of ids) this.apply(id);
  }

  private apply(id: string) {
    const view = this.viewer.views.get(id);
    const filterId = `enhance-${id.replace(/[^\w-]/g, '_')}`;
    this.defs.querySelector(`#${CSS.escape(filterId)}`)?.remove();
    if (!view) return;
    if (!this.active) {
      view.el.style.removeProperty('--enhance');
      return;
    }
    let levels = this.levels.get(id);
    if (this.settings.whiten && !levels) {
      // measured from the picture already on screen; until there is one, try again when it arrives
      const pixels = sample(view.base.width ? view.base : view.preview);
      if (pixels) {
        levels = measureLevels(pixels);
        this.levels.set(id, levels);
      }
    }
    this.defs.append(buildFilter(filterId, this.settings, levels ?? FLAT));
    view.el.style.setProperty('--enhance', `url(#${filterId})`);
  }
}

// --- the saved copy ----------------------------------------------------------------------------

/** Print-quality pictures without huge files. */
const COPY_DPI = 200;
const MAX_SIDE = 3600;

/**
 * Draws every page of a PDF with the enhancement applied, into a new PDF of the same page sizes.
 * The pages become pictures, so their text can't be selected until it's recognised again (OCR).
 */
export async function enhancedCopy(bytes: Uint8Array, s: Enhance, progress: (done: number, total: number) => void): Promise<Uint8Array> {
  const { loadPdf } = await import('./pdf');
  const { PDFDocument } = await import('pdf-lib');
  const source = await loadPdf(bytes);
  const out = await PDFDocument.create();
  try {
    for (let i = 1; i <= source.numPages; i++) {
      progress(i - 1, source.numPages);
      const page = await source.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(COPY_DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise;
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      enhancePixels(image, { ...s, night: false }, s.whiten ? measureLevels(sample(canvas) ?? image.data) : FLAT);
      ctx.putImageData(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('Couldn’t prepare a page')))), 'image/jpeg', 0.85));
      canvas.width = canvas.height = 0;
      const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      out.addPage([base.width, base.height]).drawImage(jpg, { x: 0, y: 0, width: base.width, height: base.height });
    }
    progress(source.numPages, source.numPages);
  } finally {
    void source.loadingTask.destroy();
  }
  out.setProducer('Inkleaf');
  return out.save();
}

// --- the panel ---------------------------------------------------------------------------------

export interface PanelHooks {
  view: EnhancedView;
  /** Remembers the settings for the document that's open. */
  remember(settings: Enhance): void;
  saveCopy(settings: Enhance): void;
  close(): void;
}

/** The floating "Enhance pages" panel: changes show on the page straight away. */
export function enhancePanel(hooks: PanelHooks): HTMLElement {
  let s: Enhance = hooks.view.active ? { ...hooks.view.current } : { ...PRESETS[0].settings };
  const update = (next: Enhance) => {
    s = next;
    hooks.view.set(s);
    hooks.remember(s);
    sync();
  };

  const presetButtons = PRESETS.map((p) => {
    const b = h('button', { class: 'chip', type: 'button' }, t(p.label));
    b.addEventListener('click', () => update({ ...p.settings }));
    return { b, p };
  });

  const slider = (label: string, key: 'contrast' | 'brightness' | 'sharpness', min: number, max: number, unit = '') => {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: '1', 'aria-label': label }) as HTMLInputElement;
    const value = h('span', { class: 'enhance-value' });
    input.addEventListener('input', () => update({ ...s, [key]: Number(input.value) }));
    const row = h('label', { class: 'enhance-row' }, h('span', { class: 'enhance-label' }, label), input, value);
    return { row, sync: () => {
      input.value = String(s[key]);
      const v = s[key];
      value.textContent = unit ? `${v}${unit}` : v > 0 ? `+${v}` : String(v);
    } };
  };
  const toggle = (label: string, key: 'whiten' | 'greyscale' | 'night', hint?: string) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.addEventListener('change', () => update({ ...s, [key]: box.checked }));
    const row = h('label', { class: 'enhance-toggle', title: hint ?? '' }, box, h('span', {}, label));
    return { row, sync: () => (box.checked = s[key]) };
  };

  const controls = [
    slider(t('Contrast'), 'contrast', -50, 100),
    slider(t('Brightness'), 'brightness', -50, 50),
    slider(t('Sharpness'), 'sharpness', 0, 100, '%'),
  ];
  const toggles = [
    toggle(t('Whiten the paper'), 'whiten', t('Makes the background white and the ink darker, measured for each page.')),
    toggle(t('Greyscale'), 'greyscale'),
    toggle(t('Night reading'), 'night', t('Light text on a dark page. Only on screen.')),
  ];

  const reset = h('button', { class: 'btn small', type: 'button' }, t('Reset'));
  reset.addEventListener('click', () => update({ ...NEUTRAL }));
  const save = h('button', { class: 'btn small primary', type: 'button' }, icon('download'), h('span', {}, t('Save enhanced copy…')));
  save.addEventListener('click', () => hooks.saveCopy(s));
  const close = h('button', { class: 'enhance-close', type: 'button', title: t('Close'), 'aria-label': t('Close') }, icon('x'));
  close.addEventListener('click', () => hooks.close());

  const sync = () => {
    for (const { b, p } of presetButtons) b.setAttribute('aria-pressed', String(JSON.stringify(p.settings) === JSON.stringify(s)));
    for (const c of [...controls, ...toggles]) c.sync();
    save.toggleAttribute('disabled', isNeutral({ ...s, night: false }));
  };

  const panel = h('section', { class: 'enhance-panel', role: 'dialog', 'aria-label': t('Enhance pages') },
    h('header', { class: 'enhance-head' }, icon('sun'), h('h2', {}, t('Enhance pages')), close),
    h('div', { class: 'chip-row enhance-presets' }, ...presetButtons.map((x) => x.b)),
    ...controls.map((c) => c.row),
    h('div', { class: 'enhance-toggles' }, ...toggles.map((x) => x.row)),
    h('p', { class: 'field-hint' }, t('Only changes how pages look here. The file stays as it is.')),
    h('footer', { class: 'enhance-foot' }, reset, h('span', { class: 'spacer' }), save),
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hooks.close();
    }
  });
  // the phone's Back button arrives as an Escape for the whole page; it's
  // ours when the sheet is the topmost thing open
  const back = (e: KeyboardEvent) => {
    if (!panel.isConnected) return document.removeEventListener('keydown', back);
    const sheet = panel.closest('.enhance-sheet');
    if (e.key !== 'Escape' || !sheet || sheet !== sheet.parentElement?.lastElementChild) return;
    e.stopImmediatePropagation();
    hooks.close();
  };
  document.addEventListener('keydown', back);
  update(s);
  return panel;
}
