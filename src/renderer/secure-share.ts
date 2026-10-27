// SPDX-License-Identifier: GPL-3.0-or-later
// Share securely: lock a copy of the PDF so only the right person can open it.
//
//  - Anyone with the code: a strong generated code (and a QR code holding it)
//    becomes the PDF's AES-256 password, so it opens in any PDF app.
//  - Only one person's device: locked to their receive code (shared/lock.ts).
//    The file stays a normal PDF; other apps show a page explaining it, and
//    Inkleaf on their computer opens what's inside.

import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import { t } from '../shared/i18n';
import { asShareCode, cleanCode, groupCode, lockFor, newShareCode, publicKeyFrom } from '../shared/lock';
import { newPickup, openPickup, pickupLink, readPickup, sealForPickup } from '../shared/pickup';
import type { PickupEvent } from '../shared/api';
import { core } from './core';
import type { EditorDoc } from './document';
import { baseName } from './page-tools';
import { qrFromPicture, qrPicture, qrPng, scanQr } from './qr';
import { choices, type ToolHost } from './tools';
import { h, icon, modal, toast } from './ui';

const api = () => window.inkleaf;

async function exported(doc: EditorDoc): Promise<Uint8Array> {
  const { exportPdf } = await import('./exporter');
  return (await exportPdf(doc)).bytes;
}

function copyButton(text: string, done: string) {
  const button = h('button', { class: 'btn', type: 'button' }, icon('copy'), t('Copy code'));
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(text);
    toast(done, 'success', 2500);
  });
  return button;
}

function qrSaveButton(text: string, caption: string, fileName: string) {
  const button = h('button', { class: 'btn', type: 'button' }, icon('download'), t('Save QR picture…'));
  button.addEventListener('click', async () => {
    try {
      const path = await api().saveCopy(await qrPng(text, caption), fileName, 'png');
      if (path) toast(t('Saved the QR code picture.'), 'success', 3000);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
  return button;
}

/** The code, its QR code, and ways to pass them on. */
function codePanel(code: string, name: string) {
  return h('div', { class: 'share-code' },
    qrPicture(code, t('QR code for {code}', { code })),
    h('div', { class: 'share-code-side' },
      h('span', { class: 'field-label' }, t('Code')),
      h('output', { class: 'share-code-text' }, code),
      h('div', { class: 'share-code-actions' },
        copyButton(code, t('Code copied.')),
        qrSaveButton(code, code, `${baseName(name)} (code).png`))));
}

// --- the dialog ---------------------------------------------------------------------------------

export async function secureShareDialog(doc: EditorDoc, host: ToolHost) {
  const who = choices('share-who', [
    { value: 'code', title: t('Anyone with the code'), detail: t('Whoever has the code can open it, in Inkleaf or any PDF app.') },
    { value: 'device', title: t('Only one person’s device'), detail: t('Locked to their receive code, so it opens only in Inkleaf on their computer. Nothing to leak.') },
  ], 'code');
  const how = choices('share-how', [
    { value: 'pickup', title: t('Send with a pickup code'), detail: t('They type the code or scan its QR code, and the file comes to them: straight over your Wi-Fi, or through the internet for 7 days.') },
    { value: 'file', title: t('Save the locked file'), detail: t('You send the file yourself, by email or on a USB stick.') },
  ], 'pickup');
  const go = await modal({
    title: t('Share securely'),
    wide: true,
    body: h('div', { class: 'share' },
      h('h3', { class: 'share-heading' }, t('Who can open it')), who.el,
      h('h3', { class: 'share-heading' }, t('How they’ll get it')), how.el,
      h('p', { class: 'field-hint' }, icon('shield-check'), t('Inkleaf locks a copy. The document you have open isn’t changed.'))),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Continue'), value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;
  if (who.value === 'code') {
    if (how.value === 'pickup') await sendWithPickup(doc.name, await host.withBusy(t('Preparing…'), () => exported(doc)));
    else await shareWithCode(doc, host);
  } else {
    await shareWithDevice(doc, host, how.value === 'pickup');
  }
}

async function shareWithCode(doc: EditorDoc, host: ToolHost) {
  const code = newShareCode();
  const go = await modal({
    title: t('Lock with a code'),
    wide: true,
    body: h('div', { class: 'share' },
      codePanel(code, doc.name),
      h('p', { class: 'field-hint' }, icon('shield-check'),
        t('Send the PDF and the code by different routes, for example the file by email and the code by text message. Anyone who has both can open it.')),
      h('p', { class: 'field-hint warn' }, icon('info'), t('Inkleaf doesn’t keep the code. Copy it or save the QR picture before you close this.'))),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Save locked PDF…'), value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;
  const bytes = await host.withBusy(t('Locking…'), async () => core.protect(await exported(doc), {
    userPassword: code, ownerPassword: '', allowPrint: true, allowCopy: true, allowEdit: true,
  }));
  const path = await api().saveCopy(bytes, `${baseName(doc.name)} (locked).pdf`, 'pdf');
  if (!path) return;
  await modal({
    title: t('Locked PDF saved'),
    wide: true,
    body: h('div', { class: 'share' },
      h('p', { class: 'modal-text' }, t('Now send the PDF, and send this code separately.')),
      codePanel(code, doc.name)),
    buttons: [{ label: t('Done'), value: 'ok', primary: true }],
  });
}

async function shareWithDevice(doc: EditorDoc, host: ToolHost, pickup: boolean) {
  const input = h('input', {
    class: 'field-input share-receive-input', autocomplete: 'off', spellcheck: 'false',
    placeholder: t('Paste their receive code'),
  }) as HTMLInputElement;
  const status = h('p', { class: 'field-hint' });
  const error = h('p', { class: 'field-error' });
  let key: Uint8Array | null = null;
  const check = async () => {
    key = input.value.trim() ? await publicKeyFrom(input.value) : null;
    const clean = cleanCode(input.value);
    status.textContent = key ? t('That code looks right. It ends in {end}.', { end: clean.slice(-5) }) : '';
    error.textContent = '';
  };
  input.addEventListener('input', () => void check());

  const isReceiveCode = (text: string) => text.toLowerCase().startsWith('inkleaf-to:') || cleanCode(text).length === 55;
  const scan = h('button', { class: 'btn', type: 'button' }, icon('camera'), t('Scan their QR code'));
  scan.addEventListener('click', async () => {
    const text = await scanQr(t('Scan their receive code'), t('Point the camera at the QR code in their Inkleaf (Tools › My Receive Code).'), isReceiveCode);
    if (text) {
      input.value = groupCode(cleanCode(text));
      await check();
    }
  });
  const picture = h('button', { class: 'btn', type: 'button' }, icon('image-up'), t('Use a picture of it'));
  picture.addEventListener('click', async () => {
    const text = await qrFromPicture();
    if (text && isReceiveCode(text)) {
      input.value = groupCode(cleanCode(text));
      await check();
    } else {
      error.textContent = t('There’s no receive code in that picture.');
    }
  });

  const go = await modal({
    title: t('Lock to one person’s device'),
    wide: true,
    body: h('div', { class: 'share' },
      h('ol', { class: 'share-steps' },
        h('li', {}, t('Ask them to open Inkleaf and choose Tools › My Receive Code.')),
        h('li', {}, t('Scan the QR code it shows, or paste the code they send you.'))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Their receive code')), input),
      h('div', { class: 'share-code-actions' }, scan, picture),
      status, error,
      h('p', { class: 'field-hint' }, icon('shield-check'),
        t('Only Inkleaf on their computer can open the locked copy. Not even you can open it, so keep your original.'))),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: pickup ? t('Lock and send…') : t('Save locked PDF…'), value: 'ok', primary: true }],
    validate: async () => {
      await check();
      if (!key) error.textContent = input.value.trim()
        ? t('That isn’t a complete receive code. Check it, or scan their QR code instead.')
        : t('Add their receive code first.');
      return !!key;
    },
  });
  if (go !== 'ok' || !key) return;
  const recipient = key;
  const bytes = await host.withBusy(t('Locking…'), async () => wrapLocked(await lockFor(recipient, doc.name, await exported(doc))));
  if (pickup) {
    await sendWithPickup(`${baseName(doc.name)} (locked).pdf`, bytes);
    return;
  }
  const path = await api().saveCopy(bytes, `${baseName(doc.name)} (locked).pdf`, 'pdf');
  if (path) toast(t('Saved. Only the person with that receive code can open it, in Inkleaf.'), 'success', 6000);
}

// --- pickup codes -------------------------------------------------------------------------------

/** Sends a file with a pickup code: over this Wi-Fi straight away, and through the relay. */
async function sendWithPickup(name: string, file: Uint8Array) {
  const pickup = await newPickup();
  const sealed = await sealForPickup(pickup, name, file);
  const nearby = await api().sendPickup(pickup.id, pickup.check, sealed);
  const link = pickupLink(pickup, nearby);

  const wifi = h('li', { class: nearby.length ? 'ready' : 'off' },
    nearby.length ? t('On your Wi-Fi: ready while Inkleaf is open.') : t('On your Wi-Fi: not available (no network).'));
  const internet = h('li', {}, t('Anywhere: uploading…'));
  const stop = api().onPickupEvent((e: PickupEvent) => {
    if (e.id !== pickup.id) return;
    if (e.state === 'uploading') internet.textContent = t('Anywhere: uploading… {percent}%', { percent: e.percent });
    else if (e.state === 'uploaded') {
      internet.className = 'ready';
      internet.textContent = t('Anywhere: ready for 7 days, or until it’s picked up.');
    } else if (e.state === 'upload-failed') {
      internet.className = 'off';
      internet.textContent = t('Anywhere: couldn’t upload. {message}', { message: e.message });
    } else if (e.state === 'taken') {
      wifi.className = 'ready';
      wifi.textContent = t('Picked up over your Wi-Fi.');
    }
  });

  const copy = h('button', { class: 'btn', type: 'button' }, icon('copy'), t('Copy code'));
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(pickup.code);
    toast(t('Code copied.'), 'success', 2500);
  });
  const copyLink = h('button', { class: 'btn', type: 'button' }, icon('copy'), t('Copy link'));
  copyLink.addEventListener('click', () => {
    void navigator.clipboard.writeText(link);
    toast(t('Link copied. Opening it downloads the file, in Inkleaf or a web browser.'), 'success', 3500);
  });
  const choice = await modal({
    title: t('Pickup code'),
    wide: true,
    body: h('div', { class: 'share' },
      h('div', { class: 'share-code' },
        qrPicture(link, t('QR code for {code}', { code: pickup.code })),
        h('div', { class: 'share-code-side' },
          h('span', { class: 'field-label' }, t('Pickup code')),
          h('output', { class: 'share-code-text' }, pickup.code),
          h('div', { class: 'share-code-actions' }, copy, copyLink, qrSaveButton(link, pickup.code, `${baseName(name)} (pickup code).png`)))),
      h('ul', { class: 'share-status' }, wifi, internet),
      h('p', { class: 'field-hint' }, icon('shield-check'),
        t('They choose Receive a File in Inkleaf and type the code or scan the QR code. Without Inkleaf, scanning the QR code with a phone downloads it in the browser. The file is encrypted, and only this code can unlock it.'))),
    buttons: [{ label: t('Stop sharing'), value: 'stop' }, { label: t('Done'), value: 'ok', primary: true }],
  });
  stop();
  if (choice === 'stop') {
    api().stopPickup(pickup.id);
    await api().forgetPickup(pickup.id, pickup.deleteToken);
    toast(t('Stopped sharing. The code doesn’t work any more.'), 'info', 4000);
  }
}

/** Gets a file someone sent with a pickup code, then opens it with `open`. */
export async function receiveFileDialog(open: (data: Uint8Array, name: string) => Promise<void>, busy: ToolHost['withBusy']) {
  const input = h('input', { class: 'field-input share-receive-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXX' }) as HTMLInputElement;
  const error = h('p', { class: 'field-error' });
  let closeModal: (value: string) => void = () => {};
  const isPickup = (text: string) => /#[0-9A-Za-z]{24}/.test(text) || cleanCode(text).length === 24;
  const fill = (text: string | null) => {
    if (text && isPickup(text)) {
      input.value = text;
      closeModal('ok');
    } else if (text !== null) {
      error.textContent = t('There’s no pickup code in that.');
    }
  };
  const scan = h('button', { class: 'btn', type: 'button' }, icon('camera'), t('Scan QR code'));
  scan.addEventListener('click', async () => fill(await scanQr(t('Scan the pickup code'), t('Point the camera at the QR code you were sent.'), isPickup)));
  const picture = h('button', { class: 'btn', type: 'button' }, icon('image-up'), t('Use a picture of it'));
  picture.addEventListener('click', async () => fill(await qrFromPicture()));

  const choice = await modal({
    title: t('Receive a file'),
    body: h('div', { class: 'share' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Pickup code')), input),
      h('div', { class: 'share-code-actions' }, scan, picture),
      error),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Get the file'), value: 'ok', primary: true }],
    onOpen: (close) => { closeModal = close; },
    validate: async () => {
      const ok = !!(await readPickup(input.value));
      error.textContent = ok ? '' : t('That isn’t a complete pickup code. It has 24 letters and numbers.');
      return ok;
    },
  });
  if (choice !== 'ok') return;
  const read = await readPickup(input.value);
  if (!read) return;
  const { pickup, nearby } = read;
  const got = await busy(t('Getting the file…'), () => api().fetchPickup(pickup.id, pickup.check, nearby));
  if (!got.ok) {
    toast(got.reason === 'gone'
      ? t('There’s nothing to pick up with that code. It may have been picked up already, or it’s more than 7 days old.')
      : t('Couldn’t get it: this computer seems to be offline, and the file isn’t on this Wi-Fi.'), 'error', 8000);
    return;
  }
  const opened = await openPickup(pickup, got.data);
  if (!opened) {
    toast(t('That code doesn’t match the file it found, so it couldn’t be unlocked.'), 'error', 7000);
    return;
  }
  void api().forgetPickup(pickup.id, pickup.deleteToken);
  toast(got.via === 'wifi' ? t('Got “{name}” over your Wi-Fi.', { name: opened.name }) : t('Got “{name}”.', { name: opened.name }), 'success', 4000);
  await open(opened.file, opened.name);
}

// --- the locked file ----------------------------------------------------------------------------

const MARK = 'InkleafLocked';

/** A locked PDF that can't be opened here: shown as it is, never offered for repair. */
export class LockedError extends Error {}

/** A one-page PDF saying what this is, with the locked data stored inside it. */
async function wrapLocked(data: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Locked PDF');
  pdf.setProducer('Inkleaf');
  const page = pdf.addPage([595.28, 841.89]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.08, 0.13, 0.11), soft = rgb(0.35, 0.4, 0.37), green = rgb(0.07, 0.23, 0.18);
  page.drawRectangle({ x: 0, y: 841.89 - 120, width: 595.28, height: 120, color: green });
  page.drawText('Inkleaf', { x: 64, y: 841.89 - 74, size: 22, font: bold, color: rgb(0.96, 0.95, 0.92) });
  page.drawText('This PDF is locked', { x: 64, y: 620, size: 28, font: bold, color: ink });
  const lines = [
    'It was locked with Inkleaf so that only one person\'s device can open it.',
    'If it was sent to you, open it in Inkleaf on your computer and it will',
    'open normally. Other PDF apps can only show this page.',
    '',
    'Inkleaf is free and open source: priyanshdas.github.io/inkleaf',
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 64, y: 570 - i * 22, size: 13, font: regular, color: i === 4 ? soft : ink }));
  pdf.catalog.set(PDFName.of(MARK), pdf.context.register(pdf.context.stream(data)));
  return pdf.save({ useObjectStreams: false });
}

const MARK_BYTES = new TextEncoder().encode(`/${MARK}`);

/** Whether a file is a PDF locked to a device. */
export function isDeviceLocked(bytes: Uint8Array): boolean {
  outer: for (let i = bytes.indexOf(MARK_BYTES[0]); i >= 0 && i <= bytes.length - MARK_BYTES.length; i = bytes.indexOf(MARK_BYTES[0], i + 1)) {
    for (let j = 1; j < MARK_BYTES.length; j++) if (bytes[i + j] !== MARK_BYTES[j]) continue outer;
    return true;
  }
  return false;
}

/** The PDF inside a device-locked file, if it was locked for this computer. */
export async function openDeviceLocked(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  let data: Uint8Array;
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const stream = pdf.context.lookup(pdf.catalog.get(PDFName.of(MARK)));
    if (!(stream instanceof PDFRawStream)) throw new Error('no data');
    data = stream.contents;
  } catch {
    throw new Error(t('“{name}” is a locked PDF, but it’s damaged and can’t be opened.', { name }));
  }
  const result = await api().openLocked(data);
  if (result.ok) return result.pdf;
  if (result.reason === 'other-device') {
    throw new LockedError(t('“{name}” was locked for someone else’s device, so it can’t be opened here. If it’s meant for you, send the sender your receive code (Tools › My Receive Code) and ask them to lock it again.', { name }));
  }
  throw new Error(t('“{name}” is a locked PDF, but it’s damaged and can’t be opened.', { name }));
}

// --- my receive code ----------------------------------------------------------------------------

export async function receiveCodeDialog() {
  let code: string;
  try {
    code = await api().receiveCode();
  } catch (err) {
    toast((err as Error).message, 'error', 8000);
    return;
  }
  const shown = groupCode(code);
  const qrText = `inkleaf-to:${code}`;
  const copy = h('button', { class: 'btn', type: 'button' }, icon('copy'), t('Copy code'));
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(shown);
    toast(t('Code copied. Send it to the person who wants to share a PDF with you.'), 'success', 3500);
  });
  await modal({
    title: t('My receive code'),
    wide: true,
    body: h('div', { class: 'share' },
      h('p', { class: 'modal-text' }, t('Give this to someone who wants to send you a PDF only you can open. They scan the QR code or paste the code in Share Securely.')),
      h('div', { class: 'share-code' },
        qrPicture(qrText, t('Your receive code')),
        h('div', { class: 'share-code-side' },
          h('span', { class: 'field-label' }, t('Your receive code')),
          h('output', { class: 'share-code-text small' }, shown),
          h('div', { class: 'share-code-actions' }, copy, qrSaveButton(qrText, t('Inkleaf receive code'), 'Inkleaf receive code.png')))),
      h('p', { class: 'field-hint' }, icon('shield-check'), t('It’s safe to share: it can only lock files for you, never open them.')),
      h('p', { class: 'field-hint warn' }, icon('info'),
        t('Files locked to this code open only in Inkleaf on this computer, signed in as you. If you reset this computer or move to a new one, they can’t be opened there, so ask for a new copy.'))),
    buttons: [{ label: t('Done'), value: 'ok', primary: true }],
  });
}

/** For the password prompt: a typed share code, written the way it was when the file was locked. */
export { asShareCode };
