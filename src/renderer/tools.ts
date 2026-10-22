// SPDX-License-Identifier: GPL-3.0-or-later
// The Tools menu: compress, password-protect, watermark and page numbers,
// and converting between PDFs, pictures and Word.

import { core, CompressLevel } from './core';
import { NO_DECOR, type EditorDoc } from './document';
import { baseName } from './page-tools';
import { loadPdf } from './pdf';
import type { Band, Decor, NumberStyle, PageNumbers, TextAlign, Watermark } from './types';
import { h, icon, modal, toast } from './ui';

/** What the tools need from the app around them. */
export interface ToolHost {
  withBusy<T>(message: string, work: () => Promise<T>): Promise<T>;
  /** Shows progress in the busy indicator while it's up. */
  progress(message: string): void;
  /** Opens bytes as a new, unsaved tab. */
  openBytes(bytes: Uint8Array, name: string): Promise<void>;
  currentPageId(): string | null;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function exported(doc: EditorDoc): Promise<Uint8Array> {
  const { exportPdf } = await import('./exporter');
  return (await exportPdf(doc)).bytes;
}

/** A list of radio "cards", each with a title and a line of explanation. */
function choices<T extends string>(name: string, options: { value: T; title: string; detail: string }[], initial: T) {
  let value = initial;
  const el = h('div', { class: 'choice-list', role: 'radiogroup' }, ...options.map((o) => {
    const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === initial });
    input.addEventListener('change', () => (value = o.value));
    return h('label', { class: 'choice' }, input, h('span', {}, h('strong', {}, o.title), h('span', {}, o.detail)));
  }));
  return { el, get value() { return value; } };
}

// --- compress -------------------------------------------------------------------

export async function compressDialog(doc: EditorDoc, host: ToolHost) {
  const level = choices<CompressLevel>('level', [
    { value: 'light', title: 'Light', detail: 'Removes waste, keeps pictures as they are. Best quality.' },
    { value: 'balanced', title: 'Balanced', detail: 'Resizes large photos. Good for email; looks the same on screen.' },
    { value: 'strong', title: 'Smallest file', detail: 'Lower-quality photos. Text stays perfectly sharp.' },
  ], 'balanced');
  const go = await modal({
    title: 'Compress PDF',
    body: h('div', {}, h('p', { class: 'modal-text' }, 'Makes a smaller copy. Your document stays as it is.'), level.el),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Compress', value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;

  const { pdf, report } = await host.withBusy('Compressing…', async () => core.compress(await exported(doc), level.value));
  const saved = report.before - report.after;
  if (saved < 1024) {
    await modal({ title: 'Already compact', body: 'This PDF is already about as small as it can get without losing quality.' });
    return;
  }
  const details = [
    report.imagesShrunk ? `${report.imagesShrunk} picture${report.imagesShrunk === 1 ? '' : 's'} resized` : '',
    report.duplicatesMerged ? `${report.duplicatesMerged} duplicate${report.duplicatesMerged === 1 ? '' : 's'} removed` : '',
  ].filter(Boolean).join(', ');
  const choice = await modal({
    title: 'Compressed',
    body: h('div', { class: 'result-card' },
      h('div', { class: 'result-sizes' },
        h('span', {}, formatBytes(report.before)), icon('chevron-right'), h('strong', {}, formatBytes(report.after))),
      h('p', { class: 'modal-text' }, `${Math.round((saved / report.before) * 100)}% smaller${details ? ` · ${details}` : ''}.`)),
    buttons: [
      { label: 'Close', value: 'cancel' },
      { label: 'Open in a new tab', value: 'open' },
      { label: 'Save copy…', value: 'save', primary: true },
    ],
  });
  if (choice === 'open') await host.openBytes(pdf, `${baseName(doc.name)} (compressed).pdf`);
  if (choice === 'save') {
    const path = await window.inkleaf.saveCopy(pdf, `${baseName(doc.name)} (compressed).pdf`, 'pdf');
    if (path) toast('Saved the compressed copy.', 'success');
  }
}

// --- password protection ------------------------------------------------------------

export async function protectDialog(doc: EditorDoc, host: ToolHost) {
  const needPassword = h('input', { type: 'checkbox', checked: true });
  const password = h('input', { class: 'field-input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 6 characters' });
  const confirm = h('input', { class: 'field-input', type: 'password', autocomplete: 'new-password' });
  const restrict = h('input', { type: 'checkbox' });
  const allowPrint = h('input', { type: 'checkbox', checked: true });
  const allowCopy = h('input', { type: 'checkbox', checked: true });
  const allowEdit = h('input', { type: 'checkbox' });
  const ownerPassword = h('input', { class: 'field-input', type: 'password', autocomplete: 'new-password', placeholder: 'Needed to lift the restrictions later' });
  const error = h('p', { class: 'field-error' });

  const openSection = h('div', { class: 'indent' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), password),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type it again'), confirm));
  const restrictSection = h('div', { class: 'indent' },
    h('label', { class: 'check' }, allowPrint, ' Allow printing'),
    h('label', { class: 'check' }, allowCopy, ' Allow copying text'),
    h('label', { class: 'check' }, allowEdit, ' Allow changes, comments and form filling'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Permissions password'), ownerPassword));
  const sync = () => {
    openSection.hidden = !needPassword.checked;
    restrictSection.hidden = !restrict.checked;
  };
  needPassword.addEventListener('change', sync);
  restrict.addEventListener('change', sync);
  sync();

  const go = await modal({
    title: 'Password protect',
    wide: true,
    body: h('div', { class: 'protect' },
      h('label', { class: 'check strong' }, needPassword, ' Require a password to open'),
      openSection,
      h('label', { class: 'check strong' }, restrict, ' Restrict what people can do'),
      restrictSection,
      h('p', { class: 'field-hint warn' }, icon('info'), 'Inkleaf can’t recover a forgotten password. Keep it somewhere safe.'),
      error),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save protected copy…', value: 'ok', primary: true }],
    validate: () => {
      let message = '';
      if (!needPassword.checked && !restrict.checked) message = 'Choose a password, restrictions, or both.';
      else if (needPassword.checked && password.value.length < 6) message = 'Use a password of at least 6 characters.';
      else if (needPassword.checked && password.value !== confirm.value) message = 'The two passwords don’t match.';
      else if (restrict.checked && ownerPassword.value.length < 6) message = 'Choose a permissions password of at least 6 characters.';
      else if (restrict.checked && needPassword.checked && ownerPassword.value === password.value) message = 'Use a different permissions password, or the restrictions won’t hold.';
      error.textContent = message;
      return !message;
    },
  });
  if (go !== 'ok') return;

  const options = {
    userPassword: needPassword.checked ? password.value : '',
    // without restrictions, the owner password unlocks nothing extra; a
    // random one keeps it from being guessed
    ownerPassword: restrict.checked ? ownerPassword.value : '',
    allowPrint: !restrict.checked || allowPrint.checked,
    allowCopy: !restrict.checked || allowCopy.checked,
    allowEdit: !restrict.checked || allowEdit.checked,
  };
  const bytes = await host.withBusy('Encrypting…', async () => core.protect(await exported(doc), options));
  const path = await window.inkleaf.saveCopy(bytes, `${baseName(doc.name)} (protected).pdf`, 'pdf');
  if (path) toast('Saved the protected copy. Your open document isn’t locked.', 'success', 5000);
}

// --- watermark, page numbers, header and footer ---------------------------------------

const WATERMARK_COLOURS = ['#c4314b', '#888888', '#1d3f91', '#1f8a5b'];

export async function decorDialog(doc: EditorDoc) {
  const d = doc.decor;
  const field = (label: string, input: HTMLElement, hint?: string) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
  const select = <T extends string>(options: [T, string][], value: T) => {
    const el = h('select', { class: 'field-input' }, ...options.map(([v, label]) => new Option(label, v)));
    el.value = value;
    return el;
  };
  const number = (value: number, min: number, max: number) => h('input', { class: 'field-input', type: 'number', min: String(min), max: String(max), value: String(value) });
  const toggle = (on: boolean, label: string, section: HTMLElement) => {
    const box = h('input', { type: 'checkbox', checked: on });
    const sync = () => (section.hidden = !box.checked);
    box.addEventListener('change', sync);
    sync();
    return { box, row: h('label', { class: 'check strong' }, box, ` ${label}`) };
  };

  // watermark
  const wm: Watermark = d.watermark ?? { text: 'CONFIDENTIAL', size: 72, color: '#c4314b', opacity: 0.18, diagonal: true };
  const wmText = h('input', { class: 'field-input', value: wm.text, maxlength: '60' });
  const wmSize = number(wm.size, 12, 200);
  let wmColour = wm.color;
  const wmSwatches = h('div', { class: 'swatch-grid' }, ...WATERMARK_COLOURS.map((c) => {
    const b = h('button', { class: 'swatch', style: `--swatch:${c}`, 'aria-pressed': String(c === wmColour), type: 'button' });
    b.addEventListener('click', () => {
      wmColour = c;
      wmSwatches.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    return b;
  }));
  const wmOpacity = h('input', { type: 'range', min: '5', max: '60', step: '1', value: String(Math.round(wm.opacity * 100)) });
  const wmDiagonal = h('input', { type: 'checkbox', checked: wm.diagonal });
  const wmSection = h('div', { class: 'indent grid-2' },
    field('Text', wmText), field('Size (pt)', wmSize),
    field('Colour', wmSwatches), field('Strength', wmOpacity),
    h('label', { class: 'check' }, wmDiagonal, ' Diagonal'));
  const wmToggle = toggle(!!d.watermark, 'Watermark', wmSection);

  // page numbers
  const pn: PageNumbers = d.numbers ?? { style: 'page-n-of-total', vertical: 'bottom', align: 'center', size: 10, start: 1, skipFirst: false };
  const pnStyle = select<NumberStyle>([['n', '3'], ['n-of-total', '3 of 10'], ['page-n', 'Page 3'], ['page-n-of-total', 'Page 3 of 10']], pn.style);
  const pnWhere = select<string>([
    ['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'],
    ['top-center', 'Top centre'], ['top-right', 'Top right'], ['top-left', 'Top left'],
  ], `${pn.vertical}-${pn.align}`);
  const pnStart = number(pn.start, 0, 9999);
  const pnSize = number(pn.size, 6, 36);
  const pnSkip = h('input', { type: 'checkbox', checked: pn.skipFirst });
  const pnSection = h('div', { class: 'indent grid-2' },
    field('Style', pnStyle), field('Position', pnWhere), field('Start at', pnStart), field('Size (pt)', pnSize),
    h('label', { class: 'check' }, pnSkip, ' Don’t number the first page (a cover)'));
  const pnToggle = toggle(!!d.numbers, 'Page numbers', pnSection);

  // header and footer
  const bandInputs = (b: Band | null, fallback: Band) => {
    const v = b ?? fallback;
    return {
      left: h('input', { class: 'field-input', value: v.left, placeholder: 'Left' }),
      center: h('input', { class: 'field-input', value: v.center, placeholder: 'Centre' }),
      right: h('input', { class: 'field-input', value: v.right, placeholder: 'Right' }),
      size: number(v.size, 6, 24),
    };
  };
  const head = bandInputs(d.header, { left: '{file}', center: '', right: '{date}', size: 9 });
  const foot = bandInputs(d.footer, { left: '', center: '', right: '', size: 9 });
  const bandSection = (b: ReturnType<typeof bandInputs>) =>
    h('div', { class: 'indent' }, h('div', { class: 'band-row' }, b.left, b.center, b.right), field('Size (pt)', b.size));
  const headSection = bandSection(head);
  const footSection = bandSection(foot);
  const headToggle = toggle(!!d.header, 'Header', headSection);
  const footToggle = toggle(!!d.footer, 'Footer', footSection);

  const choice = await modal({
    title: 'Watermark, page numbers & headers',
    wide: true,
    body: h('div', { class: 'decor-dialog' },
      wmToggle.row, wmSection,
      pnToggle.row, pnSection,
      headToggle.row, headSection,
      footToggle.row, footSection,
      h('p', { class: 'field-hint' }, 'In headers and footers, {page}, {total}, {date} and {file} are filled in for each page. Everything here is applied to every page and saved into the file.')),
    buttons: [
      { label: 'Remove all', value: 'clear', danger: true },
      { label: 'Cancel', value: 'cancel' },
      { label: 'Apply', value: 'ok', primary: true },
    ],
  });
  if (choice === 'clear') {
    doc.setDecor(NO_DECOR);
    return;
  }
  if (choice !== 'ok') return;

  const num = (el: HTMLInputElement, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, Number(el.value) || fallback));
  const band = (b: ReturnType<typeof bandInputs>): Band | null => {
    const out = { left: b.left.value, center: b.center.value, right: b.right.value, size: num(b.size, 9, 6, 24) };
    return out.left.trim() || out.center.trim() || out.right.trim() ? out : null;
  };
  const [vertical, align] = pnWhere.value.split('-') as ['top' | 'bottom', TextAlign];
  const next: Decor = {
    watermark: wmToggle.box.checked && wmText.value.trim()
      ? { text: wmText.value.trim(), size: num(wmSize, 72, 12, 200), color: wmColour, opacity: Number(wmOpacity.value) / 100, diagonal: wmDiagonal.checked }
      : null,
    numbers: pnToggle.box.checked
      ? { style: pnStyle.value as NumberStyle, vertical, align, size: num(pnSize, 10, 6, 36), start: num(pnStart, 1, 0, 9999), skipFirst: pnSkip.checked }
      : null,
    header: headToggle.box.checked ? band(head) : null,
    footer: footToggle.box.checked ? band(foot) : null,
  };
  doc.setDecor(next);
}

// --- converting --------------------------------------------------------------------------

/** Turns a picture file into bytes pdf-lib can embed (PNG or JPEG). */
async function embeddable(file: { name: string; data: Uint8Array }): Promise<{ bytes: Uint8Array; jpeg: boolean; width: number; height: number }> {
  const isJpeg = file.data[0] === 0xff && file.data[1] === 0xd8;
  const isPng = file.data[0] === 0x89 && file.data[1] === 0x50;
  const bitmap = await createImageBitmap(new Blob([file.data as BlobPart]));
  const { width, height } = bitmap;
  if (isJpeg || isPng) {
    bitmap.close();
    return { bytes: file.data, jpeg: isJpeg, width, height };
  }
  // WebP, GIF and BMP are redrawn as PNG, the closest lossless format a PDF can hold
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), jpeg: false, width, height };
}

export async function imagesToPdf(host: ToolHost) {
  const files = await window.inkleaf.pickImages();
  if (!files.length) return;
  const fit = choices<'a4' | 'natural'>('fit', [
    { value: 'a4', title: 'A4 pages', detail: 'Each picture centred on an A4 page, turned to suit its shape.' },
    { value: 'natural', title: 'Same size as the picture', detail: 'Each page is exactly the picture, with no margins.' },
  ], 'a4');
  const go = await modal({
    title: files.length === 1 ? 'Make a PDF from 1 picture' : `Make a PDF from ${files.length} pictures`,
    body: h('div', {}, h('p', { class: 'modal-text' }, 'Pages follow the order the pictures were chosen in. You can reorder them afterwards.'), fit.el),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Make PDF', value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;

  const bytes = await host.withBusy('Making PDF…', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      host.progress(`Adding picture ${i + 1} of ${files.length}…`);
      const img = await embeddable(files[i]);
      const embedded = img.jpeg ? await out.embedJpg(img.bytes) : await out.embedPng(img.bytes);
      // pictures are taken as 96 dpi when they set the page size
      const w = (img.width * 72) / 96, hgt = (img.height * 72) / 96;
      if (fit.value === 'natural') {
        out.addPage([w, hgt]).drawImage(embedded, { x: 0, y: 0, width: w, height: hgt });
      } else {
        const landscape = img.width > img.height;
        const [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89];
        const margin = 28;
        const scale = Math.min((pw - margin * 2) / w, (ph - margin * 2) / hgt, 1.5);
        const dw = w * scale, dh = hgt * scale;
        out.addPage([pw, ph]).drawImage(embedded, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      }
    }
    out.setProducer('Inkleaf');
    return out.save();
  });
  await host.openBytes(bytes, files.length === 1 ? `${files[0].name.replace(/\.[^.]+$/, '')}.pdf` : 'Pictures.pdf');
}

export async function pdfToImages(doc: EditorDoc, host: ToolHost) {
  const format = choices<'png' | 'jpeg'>('format', [
    { value: 'png', title: 'PNG', detail: 'Sharpest. Best for text, diagrams and screenshots.' },
    { value: 'jpeg', title: 'JPEG', detail: 'Smaller files. Best for photos.' },
  ], 'png');
  const dpi = h('select', { class: 'field-input' }, new Option('Screen (96 dpi)', '96'), new Option('Standard (150 dpi)', '150'), new Option('Print quality (300 dpi)', '300'));
  dpi.value = '150';
  const which = h('select', { class: 'field-input' }, new Option('Every page', 'all'), new Option('Only the current page', 'current'));
  const go = await modal({
    title: 'Export pages as pictures',
    body: h('div', {}, format.el,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Resolution'), dpi),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Pages'), which)),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Export…', value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;

  const files = await host.withBusy('Drawing pages…', async () => {
    const { exportPdf } = await import('./exporter');
    const current = host.currentPageId();
    const { bytes } = await exportPdf(doc, which.value === 'current' && current ? [current] : undefined);
    const pdf = await loadPdf(bytes);
    const out: { name: string; data: Uint8Array }[] = [];
    const scale = Number(dpi.value) / 72;
    const ext = format.value === 'png' ? 'png' : 'jpg';
    const firstNumber = which.value === 'current' && current ? doc.pageIndex(current) + 1 : 1;
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        host.progress(`Drawing page ${i} of ${pdf.numPages}…`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext('2d', { alpha: false })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
        const blob = await canvas.convertToBlob({ type: `image/${format.value}`, quality: 0.9 });
        out.push({ name: `${baseName(doc.name)} - page ${firstNumber + i - 1}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
    } finally {
      pdf.loadingTask.destroy();
    }
    return out;
  });
  const folder = await window.inkleaf.saveMany(files);
  if (folder) toast(`Saved ${files.length} picture${files.length === 1 ? '' : 's'}.`, 'success');
}
