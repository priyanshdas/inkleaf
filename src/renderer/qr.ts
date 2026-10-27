// SPDX-License-Identifier: GPL-3.0-or-later
// QR codes: drawing them, saving one as a picture, and reading one, either
// with the camera or from a screenshot someone sent.

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { t } from '../shared/i18n';
import { h, modal } from './ui';

function make(text: string) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

/** A QR code as an element that scales to its box. */
export function qrPicture(text: string, label: string): HTMLElement {
  const el = h('div', { class: 'qr-picture', role: 'img', 'aria-label': label });
  el.innerHTML = make(text).createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  return el;
}

/** A PNG of the QR code with `caption` written under it, for sending as a picture. */
export async function qrPng(text: string, caption: string): Promise<Uint8Array> {
  const qr = make(text);
  const count = qr.getModuleCount();
  const cell = 12, margin = 4 * cell, size = count * cell + margin * 2, captionHeight = caption ? 64 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size + captionHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
  }
  if (caption) {
    ctx.font = '600 26px "Instrument Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(caption, size / 2, size + 20, size - 24);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(t('Couldn’t make the picture.'));
  return new Uint8Array(await blob.arrayBuffer());
}

function decode(source: CanvasImageSource, width: number, height: number): string | null {
  const scale = Math.min(1, 1200 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/** Asks for a picture (a screenshot or photo of a QR code) and reads it. */
export function qrFromPicture(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const bitmap = await createImageBitmap(file);
        resolve(decode(bitmap, bitmap.width, bitmap.height));
      } catch {
        resolve(null);
      }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Reads a QR code with the camera. `accept` says whether a code is the kind
 * we're after (others are ignored). Resolves to its text, or null.
 */
export async function scanQr(title: string, hint: string, accept: (text: string) => boolean): Promise<string | null> {
  const video = h('video', { class: 'qr-camera', playsinline: true, muted: true }) as HTMLVideoElement;
  const note = h('p', { class: 'field-hint' }, hint);
  let stream: MediaStream | null = null;
  let found: string | null = null;
  let running = true;
  let closeModal: (value: string) => void = () => {};

  const tick = () => {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const text = decode(video, video.videoWidth, video.videoHeight);
      if (text && accept(text)) {
        found = text;
        closeModal('ok');
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    void video.play();
    requestAnimationFrame(tick);
  } catch {
    note.textContent = t('The camera isn’t available. Use a picture of the code, or type it instead.');
  }
  const choice = await modal({
    title,
    body: h('div', { class: 'qr-scan' }, video, note),
    buttons: [{ label: t('Cancel'), value: 'cancel' }],
    onOpen: (close) => { closeModal = close; },
  });
  running = false;
  stream?.getTracks().forEach((track) => track.stop());
  return choice === 'ok' ? found : null;
}
