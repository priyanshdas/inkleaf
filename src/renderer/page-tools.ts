// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../shared/i18n';
import { core } from './core';
import { mightBeEncrypted } from './pdf';
import type { EditorDoc } from './document';
import type { ExportResult } from './exporter';

// The PDF writer is loaded the first time it's needed, not at start-up.
async function exportPdf(doc: EditorDoc, pageIds?: string[]): Promise<ExportResult> {
  const { exportPdf } = await import('./exporter');
  return exportPdf(doc, pageIds);
}
import { h, modal, promptDialog, toast } from './ui';

/**
 * Parses "1-3, 5, 8-" into zero-based page indices (in the order written).
 * Returns an error message instead when the text doesn't make sense.
 */
export function parseRanges(text: string, pageCount: number): number[][] | string {
  const groups: number[][] = [];
  for (const raw of text.split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*(?:(-|–|to)\s*(\d+)?)?$/i);
    if (!m || (!m[1] && !m[3])) return t('“{part}” isn’t a page or range.', { part });
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : pageCount) : start;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      return t('{count, plural, one {This document has # page.} other {This document has # pages.}}', { count: pageCount });
    }
    const step = start <= end ? 1 : -1;
    const group: number[] = [];
    for (let p = start; p !== end + step; p += step) group.push(p - 1);
    groups.push(group);
  }
  return groups.length ? groups : t('Enter at least one page.');
}

/** Turns [0,1,2,4] into "1-3, 5". */
export function describePages(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j;
  }
  return parts.join(', ');
}

export function baseName(name: string) {
  return name.replace(/\.pdf$/i, '');
}

/** Builds a one-page blank PDF at the given size (points). */
export async function blankPdf(width: number, height: number, pages = 1): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width, height]);
  return doc.save();
}

/**
 * Makes a PDF safe to edit: unlocks owner-protected files silently and asks
 * for the password when one is needed. Resolves to null if the user gives up.
 */
export async function unlock(bytes: Uint8Array, name: string, force = false): Promise<{ bytes: Uint8Array; wasProtected: boolean } | null> {
  // most PDFs aren't encrypted: skip the full parse for those
  if (!force && !mightBeEncrypted(bytes)) return { bytes, wasProtected: false };
  let info;
  try {
    info = await core.inspect(bytes);
  } catch (err) {
    throw new Error(t('“{name}” doesn’t look like a PDF Inkleaf can read. {message}', { name, message: (err as Error).message }));
  }
  if (!info.encrypted) return { bytes, wasProtected: false };

  if (info.opensWithoutPassword) {
    return { bytes: await core.decrypt(bytes, ''), wasProtected: true };
  }

  let wrong = false;
  for (;;) {
    const password = await promptDialog(t('Password required'), t('“{name}” is protected. Enter its password to open it.', { name }), {
      type: 'password',
      hint: wrong ? t('That password didn’t work. Try again.') : t('Saved copies won’t be password-protected.'),
    });
    if (password === null) return null;
    try {
      return { bytes: await core.decrypt(bytes, password), wasProtected: true };
    } catch {
      wrong = true;
    }
  }
}

/**
 * Unlocks a PDF if it needs it and hands the readable bytes to `use`. If the
 * quick encryption check missed and pdf.js asks for a password after all, it
 * goes round again the thorough way.
 */
export async function withUnlocked<T>(
  bytes: Uint8Array,
  name: string,
  use: (bytes: Uint8Array, wasProtected: boolean) => Promise<T>,
): Promise<T | null> {
  const first = await unlock(bytes, name);
  if (!first) return null;
  try {
    return await use(first.bytes, first.wasProtected);
  } catch (err) {
    if ((err as Error)?.name !== 'PasswordException' || first.wasProtected) throw err;
    const second = await unlock(bytes, name, true);
    return second ? use(second.bytes, second.wasProtected) : null;
  }
}

export async function insertPdfFiles(doc: EditorDoc, files: { name: string; data: Uint8Array }[], at: number) {
  let index = at;
  let added = 0;
  for (const file of files) {
    try {
      const source = await withUnlocked(file.data, file.name, (bytes) => doc.addSource(bytes, file.name));
      if (!source) continue;
      // comments already in that file come along as editable notes
      const notes = await doc.notesIn(source.id);
      doc.insertPages(index, source.pages.map((_, i) => ({ src: source.id, index: i, rotation: 0 })), notes);
      index += source.pages.length;
      added += source.pages.length;
    } catch (err) {
      toast(t('Couldn’t insert “{name}”: {message}', { name: file.name, message: (err as Error).message }), 'error', 7000);
    }
  }
  if (added) toast(t('{count, plural, one {Inserted # page.} other {Inserted # pages.}}', { count: added }), 'success');
}

export async function insertBlankPage(doc: EditorDoc, afterPageId: string | null) {
  const ref = afterPageId ? doc.page(afterPageId) : doc.pages[doc.pages.length - 1];
  const size = ref ? doc.displaySize(ref) : { width: 595.28, height: 841.89 };
  const source = await doc.addSource(await blankPdf(size.width, size.height), 'Blank page');
  const at = ref ? doc.pageIndex(ref.id) + 1 : doc.pages.length;
  const [created] = doc.insertPages(at, [{ src: source.id, index: 0, rotation: 0 }]);
  return created;
}

async function showWarnings(warnings: string[]) {
  if (!warnings.length) return;
  await modal({
    title: t('Saved, with a few notes'),
    body: h('ul', { class: 'warning-list' }, ...[...new Set(warnings)].map((w) => h('li', {}, w))),
  });
}

export async function extractPages(doc: EditorDoc, chosen: string[]) {
  const total = doc.pages.length;
  const suggestion = describePages(chosen.map((id) => doc.pageIndex(id)));
  const text = await promptDialog(t('Extract pages'), t('Pages to copy into a new PDF'), {
    value: suggestion,
    placeholder: t('e.g. 1-3, 6'),
    hint: t('Your edits on those pages come along. This document has {total} pages.', { total }),
    validate: (v) => {
      const r = parseRanges(v, total);
      return typeof r === 'string' ? r : null;
    },
  });
  if (text === null) return;
  const groups = parseRanges(text, total) as number[][];
  const indices = [...new Set(groups.flat())].sort((a, b) => a - b);
  const ids = indices.map((i) => doc.pages[i].id);
  const { bytes, warnings } = await exportPdf(doc, ids);
  const saved = await window.inkleaf.saveAs(bytes, `${baseName(doc.name)} (pages ${describePages(indices)}).pdf`);
  if (saved) {
    toast(t('{count, plural, one {Saved # page to a new file.} other {Saved # pages to a new file.}}', { count: indices.length }), 'success');
    await showWarnings(warnings);
  }
}

export async function splitDocument(doc: EditorDoc) {
  const total = doc.pages.length;
  if (total < 2) {
    toast(t('There’s only one page, so there’s nothing to split.'));
    return;
  }

  const mode = h('select', { class: 'select field-input' },
    new Option(t('Every page into its own file'), 'each'),
    new Option(t('Every few pages'), 'chunks'),
    new Option(t('Custom ranges'), 'ranges'),
  );
  const chunk = h('input', { class: 'field-input', type: 'number', min: '1', max: String(total), value: '2' });
  const ranges = h('input', { class: 'field-input', placeholder: `e.g. 1-3, 4-${total}` });
  const chunkRow = h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Pages per file')), chunk);
  const rangeRow = h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('One file per range')), ranges,
    h('span', { class: 'field-hint' }, t('Separate ranges with commas.')));
  const error = h('p', { class: 'field-error' });
  const update = () => {
    chunkRow.hidden = mode.value !== 'chunks';
    rangeRow.hidden = mode.value !== 'ranges';
  };
  mode.addEventListener('change', update);
  update();

  let groups: number[][] = [];
  const result = await modal({
    title: t('Split into several PDFs'),
    body: h('div', { class: 'form-stack' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('How to split')), mode), chunkRow, rangeRow, error),
    buttons: [
      { label: t('Cancel'), value: 'cancel' },
      { label: t('Choose folder…'), value: 'ok', primary: true },
    ],
    validate: () => {
      if (mode.value === 'each') groups = doc.pages.map((_, i) => [i]);
      else if (mode.value === 'chunks') {
        const n = Math.max(1, Math.floor(Number(chunk.value) || 1));
        groups = [];
        for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
      } else {
        const parsed = parseRanges(ranges.value, total);
        if (typeof parsed === 'string') {
          error.textContent = parsed;
          return false;
        }
        groups = parsed;
      }
      return true;
    },
  });
  if (result !== 'ok') return;

  const { exportBatch } = await import('./exporter');
  const outputs = await exportBatch(doc, groups.map((group) => group.map((i) => doc.pages[i].id)));
  const files = outputs.map((out, i) => ({ name: `${baseName(doc.name)} - ${describePages(groups[i])}`, data: out.bytes }));
  const warnings = outputs.flatMap((out) => out.warnings);
  const folder = await window.inkleaf.saveMany(files);
  if (folder) {
    toast(t('{count, plural, one {Saved # file.} other {Saved # files.}}', { count: files.length }), 'success');
    await showWarnings(warnings);
  }
}

export { showWarnings };
