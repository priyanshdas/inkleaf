// SPDX-License-Identifier: GPL-3.0-or-later
// Scan to PDF: take pictures of paper with a webcam (or pick photos from a
// phone), straighten each page from its four corners, clean it up so it
// looks scanned rather than photographed, and make a PDF.

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

async function finished(page: ScanPage, maxSide?: number): Promise<OffscreenCanvas> {
  return rotated(enhance(straighten(page, maxSide), page.mode), page.turns);
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
  out.setProducer('Inkleaf');
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

/** The scanning dialog. Resolves to the pages taken, or null if cancelled. */
export async function scanDialog(): Promise<Scanned | null> {
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
    ctx.drawImage(src, fit.ox, fit.oy, src.width * scale, src.height * scale);
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

  const addBitmap = async (bitmap: ImageBitmap) => {
    const p: ScanPage = { id: nextId++, source: bitmap, corners: findPage(bitmap), mode: (mode.value as Mode) || 'document', turns: 0, thumb: '' };
    pages.push(p);
    await updateThumb(p);
    return p;
  };

  cameraBtn.addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 }, facingMode: 'environment' }, audio: false });
    } catch (err) {
      const name = (err as DOMException).name;
      toast(name === 'NotFoundError' || name === 'OverconstrainedError' ? t('No camera was found. You can add photos instead.') : t('Inkleaf couldn’t use the camera. Check that no other app is using it, and that camera access is allowed in your system settings.'), 'error', 7000);
      return;
    }
    current = null;
    pageTools.hidden = true;
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
    h('div', { class: 'scan-bar' }, cameraBtn, captureBtn, photosBtn, h('span', { class: 'spacer' }), count),
    stage,
    pageTools,
    strip,
    h('label', { class: 'check' }, ocr, h('span', {}, t('Recognise the text afterwards, so it can be searched and copied'))),
  );
  const choice = await modal({
    title: t('Scan to PDF'),
    wide: true,
    body,
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Make PDF'), value: 'ok', primary: true }],
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
