// SPDX-License-Identifier: GPL-3.0-or-later
// Screens for the phone ↔ computer link: "Connect a phone" (a computer shows
// a QR code), "Connect to a computer" (a phone scans it) and "Send to…".

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { t } from '../shared/i18n';
import type { LinkDevice, LinkStatus } from '../shared/link-protocol';
import { isMobile } from '../shared/platform';
import { h, icon, modal, toast } from './ui';

const api = () => window.inkleaf;

const cleanError = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function deviceRow(device: LinkDevice, onForget: () => void): HTMLElement {
  const forget = h('button', { class: 'btn small', type: 'button' }, t('Remove'));
  forget.addEventListener('click', onForget);
  return h('div', { class: 'link-device' },
    icon(isMobile() ? 'monitor' : 'smartphone'),
    h('span', { class: 'link-device-name' }, h('strong', {}, device.name),
      h('span', { class: `link-state${device.online ? ' online' : ''}` }, device.online ? t('Connected') : t('Not connected right now'))),
    forget);
}

function deviceList(status: LinkStatus, refresh: () => void): HTMLElement {
  if (!status.devices.length) return h('div');
  return h('div', { class: 'link-devices' },
    h('span', { class: 'field-label' }, isMobile() ? t('Connected computer') : t('Connected phones')),
    ...status.devices.map((d) => deviceRow(d, async () => {
      await api().linkForget(d.id);
      refresh();
    })));
}

// --- on a computer: show the QR code -------------------------------------------------------------

async function computerDialog() {
  let pairing: { code: string; addresses: string[] };
  try {
    pairing = await api().linkPair();
  } catch (err) {
    toast(cleanError(err), 'error');
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(pairing.code);
  qr.make();
  const picture = h('div', { class: 'link-qr', role: 'img', 'aria-label': t('Pairing code') });
  picture.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });

  const list = h('div');
  const refresh = async () => list.replaceChildren(deviceList(await api().linkStatus(), refresh));
  await refresh();
  api().onLinkEvent((event) => {
    if (event.type === 'paired') toast(t('{name} is connected. You can now send PDFs between them.', { name: event.name }), 'success', 5000);
    void refresh();
  });
  const copy = h('button', { class: 'link-button', type: 'button' }, t('Copy the code instead'));
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(pairing.code);
    toast(t('Code copied. Paste it in Inkleaf on your phone.'), 'success', 3000);
  });

  await modal({
    title: t('Connect a phone'),
    body: h('div', { class: 'link-pair' },
      h('div', { class: 'link-qr-wrap' }, picture, copy),
      h('ol', { class: 'link-steps' },
        h('li', {}, t('Install Inkleaf on your phone.')),
        h('li', {}, t('Connect the phone to the same Wi-Fi as this computer.')),
        h('li', {}, t('In Inkleaf on the phone, open the menu › Connect to a computer, and scan this code.'))),
      h('p', { class: 'field-hint' }, icon('shield-check'), t('Files go straight between your devices over your Wi-Fi, encrypted. Nothing goes through the internet.')),
      list),
    buttons: [{ label: t('Done'), value: 'ok', primary: true }],
  });
}

// --- on a phone: scan it -----------------------------------------------------------------------

/** Reads a QR code with the camera. Resolves to its text, or null if the person gives up. */
async function scanCode(): Promise<string | null> {
  const video = h('video', { class: 'link-camera', playsinline: true, muted: true }) as HTMLVideoElement;
  const hint = h('p', { class: 'field-hint' }, t('Point the camera at the code on your computer’s screen.'));
  const pasted = h('input', { class: 'field-input', placeholder: t('Or paste the code here'), autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  let stream: MediaStream | null = null;
  let found: string | null = null;
  let closeModal: (value: string) => void = () => {};

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let running = true;
  const tick = () => {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 800 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      if (code?.data.startsWith('inkleaf-link:')) {
        found = code.data;
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
    hint.textContent = t('The camera isn’t available. Paste the code instead: on the computer, choose “Copy the code instead”.');
  }

  const choice = await modal({
    title: t('Connect to a computer'),
    body: h('div', { class: 'link-scan' }, video, hint, pasted),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Connect'), value: 'ok', primary: true }],
    onOpen: (close: (value: string) => void) => {
      closeModal = close;
    },
  });
  running = false;
  stream?.getTracks().forEach((track) => track.stop());
  if (choice !== 'ok') return null;
  return found ?? (pasted.value.trim() || null);
}

async function phoneDialog() {
  const status = await api().linkStatus();
  if (status.devices.length) {
    // already connected: show it, with a way to forget it or connect another
    const choice = await modal({
      title: t('Your computer'),
      body: h('div', {}, deviceList(status, () => {}),
        h('p', { class: 'field-hint' }, t('Files you send arrive on the computer straight away. Files sent from the computer open here while Inkleaf is open.'))),
      buttons: [{ label: t('Connect a different computer'), value: 'again' }, { label: t('Done'), value: 'ok', primary: true }],
    });
    if (choice !== 'again') return;
  }
  const code = await scanCode();
  if (!code) return;
  try {
    const { name } = await api().linkJoin(code);
    toast(t('Connected to {name}.', { name }), 'success', 4000);
  } catch (err) {
    toast(cleanError(err), 'error', 6000);
  }
}

/** "Connect a phone" on a computer, "Connect to a computer" on a phone. */
export async function linkDialog() {
  return isMobile() ? phoneDialog() : computerDialog();
}

/** Sends the open document to the paired phone (or computer). */
export async function sendToDevice(name: string, bytes: () => Promise<Uint8Array>) {
  const status = await api().linkStatus();
  if (!status.devices.length) return linkDialog();
  let target = status.devices[0];
  if (status.devices.length > 1) {
    const select = h('select', { class: 'field-input' }, ...status.devices.map((d) => new Option(`${d.name}${d.online ? '' : ` (${t('Not connected right now')})`}`, d.id)));
    const choice = await modal({
      title: t('Send to phone'),
      body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Send to')), select),
      buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Send'), value: 'ok', primary: true }],
    });
    if (choice !== 'ok') return;
    target = status.devices.find((d) => d.id === (select as HTMLSelectElement).value) ?? target;
  }
  await api().linkSend(target.id, name, await bytes());
  toast(isMobile() || target.online
    ? t('Sent “{name}” to {device}.', { name, device: target.name })
    : t('“{name}” will arrive on {device} next time Inkleaf is open there.', { name, device: target.name }), 'success', 4000);
}

/** Toasts for files that arrive from the other device. */
export function watchLink() {
  api().onLinkEvent((event) => {
    if (event.type === 'received') toast(t('Received “{name}” from {device}.', { name: event.name, device: event.from }), 'success', 4000);
    if (event.type === 'paired' && isMobile()) toast(t('Connected to {name}.', { name: event.name }), 'success', 4000);
  });
}
