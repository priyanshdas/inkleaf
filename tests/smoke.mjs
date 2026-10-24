// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end check: drives the real app with mouse and keyboard, saves the
// result, then inspects the saved PDFs with poppler (pdftotext) and pypdf so
// we're testing the file on disk, not the app's opinion of itself.
//
//   npm test                 (on Linux without a display: xvfb-run -a npm test)
//
// Needs: python3 with pypdf, poppler-utils, qpdf. Fixtures come from
// tests/make_fixtures.py.

import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-test-'));
const shots = process.env.INKLEAF_SHOTS;

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${!ok && extra ? `\n      ${extra}` : ''}`);
  if (!ok) failures++;
}

const text = (file) => execFileSync('pdftotext', ['-layout', file, '-']).toString();
const pageCount = (file) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())[1]);

async function launch(file, options = {}) {
  const profile = options.profile ?? fs.mkdtempSync(path.join(out, 'profile-'));
  const app = await electron.launch({
    args: ['--no-sandbox', root, ...(file ? [file] : [])],
    cwd: root,
    env: {
      ...process.env,
      // a fresh profile per launch unless a test wants to reuse one
      INKLEAF_USER_DATA: profile,
      ...(options.env ?? {}),
    },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.setViewportSize({ width: 1280, height: 860 });
  // the fixtures must never be saved over, so tests run with auto-save off
  // (apart from the auto-save test, which works on copies)
  await win.waitForFunction(() => !!window.__inkleaf?.autosave);
  if (!options.autosave) await win.evaluate(() => window.__inkleaf.autosave.setEnabled(false));
  return { app, win, errors, profile };
}

async function waitForPages(win) {
  // the app settles on a zoom level after opening, so wait until the first
  // page has been drawn at *that* zoom before working out click positions
  await win.waitForFunction(() => {
    const doc = window.__inkleaf?.getDoc();
    const viewer = window.__inkleaf?.viewer;
    const first = doc && viewer.views.get(doc.pages[0].id);
    return !!first?.renderedKey && first.renderedKey.startsWith(viewer.scale.toFixed(4));
  }, null, { timeout: 15000 });
  await win.waitForTimeout(400);
  await win.waitForTimeout(300);
}

/** Client coordinates of a point given in PDF user space on page `index`. */
async function at(win, index, x, y) {
  return win.evaluate(([index, x, y]) => {
    const { viewer, getDoc } = window.__inkleaf;
    const view = viewer.views.get(getDoc().pages[index].id);
    const box = viewer.container.getBoundingClientRect();
    const [lx, ly] = viewer.toLocal(view, x, y);
    // scroll so the point itself sits in the middle of the viewport
    let r = view.el.getBoundingClientRect();
    viewer.container.scrollTop += r.top + ly - (box.top + box.height / 2);
    viewer.container.scrollLeft += r.left + lx - (box.left + box.width / 2);
    r = view.el.getBoundingClientRect();
    return { x: r.left + lx, y: r.top + ly };
  }, [index, x, y]);
}

/** Like at(), but without scrolling: for several points on screen at once. */
async function pos(win, index, x, y) {
  return win.evaluate(([index, x, y]) => {
    const { viewer, getDoc } = window.__inkleaf;
    const view = viewer.views.get(getDoc().pages[index].id);
    const [lx, ly] = viewer.toLocal(view, x, y);
    const r = view.el.getBoundingClientRect();
    return { x: r.left + lx, y: r.top + ly };
  }, [index, x, y]);
}

async function drag(win, from, to, steps = 12) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(to.x, to.y, { steps });
  await win.mouse.up();
}

async function save(win, file) {
  const bytes = await win.evaluate(async () => {
    const { exportPdf, getDoc } = window.__inkleaf;
    const { bytes, warnings } = await exportPdf(getDoc());
    return { data: Array.from(bytes), warnings };
  });
  fs.writeFileSync(file, Buffer.from(bytes.data));
  return bytes.warnings;
}

/** Closes the app without tripping the "save changes?" prompt. */
async function quit(app, win) {
  await win.evaluate(() => {
    for (const doc of window.__inkleaf.allDocs()) doc.markSaved(doc.name, doc.path);
  });
  // give the "no unsaved changes" message time to reach the main process
  await win.waitForTimeout(300);
  await app.close();
}

const annotCount = (win) => win.evaluate(() => {
  const doc = window.__inkleaf.getDoc();
  return doc.pages.reduce((n, p) => n + doc.annots(p.id).length, 0);
});

// --- 1. annotating and editing text ------------------------------------------

async function editingTest() {
  console.log('\nEditing sample.pdf');
  const { app, win, errors } = await launch(path.join(fixtures, 'sample.pdf'));
  await waitForPages(win);

  // every tool is free: Edit text switches straight away
  await win.click('[data-tool="edit-text"]');
  check('Edit text is available without a licence', (await win.evaluate(() => window.__inkleaf.editor.tool)) === 'edit-text' && !(await win.isVisible('.modal')));

  // edit existing text: click on "INV-2041" and retype it
  await win.click('[data-tool="edit-text"]');
  let p = await at(win, 0, 200, 762);
  await win.mouse.move(p.x, p.y);
  await win.waitForTimeout(150);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.text-editor');
  const original = await win.inputValue('.text-editor');
  check('edit-text picks up the clicked line', original.includes('INV-2041'), `got "${original}"`);
  await win.fill('.text-editor', original.replace('INV-2041', 'INV-2042'));
  if (shots) await win.screenshot({ path: path.join(shots, 'editing-text.png') });
  await win.keyboard.press('Escape');

  // add new text
  await win.keyboard.press('t');
  p = await at(win, 0, 380, 560);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.text-editor');
  await win.keyboard.type('Approved by front office');
  await win.keyboard.press('Escape');

  // pen stroke
  await win.keyboard.press('p');
  await drag(win, await at(win, 0, 80, 500), await at(win, 0, 260, 470), 20);

  // highlight the guest line
  await win.keyboard.press('m');
  await drag(win, await at(win, 0, 70, 731), await at(win, 0, 340, 716));

  // redact the amount
  await win.keyboard.press('b');
  await drag(win, await at(win, 0, 134, 712), await at(win, 0, 182, 695));

  // a rectangle, then move it with the select tool
  await win.keyboard.press('r');
  await drag(win, await at(win, 0, 380, 680), await at(win, 0, 520, 600));
  await win.keyboard.press('v');
  await drag(win, await at(win, 0, 380, 640), await at(win, 0, 400, 640));

  check('six marks on the page', (await annotCount(win)) === 6, `count ${await annotCount(win)}`);

  // undo and redo the move
  const before = await win.evaluate(() => JSON.stringify(window.__inkleaf.getDoc().annots(window.__inkleaf.getDoc().pages[0].id).at(-1)));
  await win.click('[data-command="undo"]');
  const undone = await win.evaluate(() => JSON.stringify(window.__inkleaf.getDoc().annots(window.__inkleaf.getDoc().pages[0].id).at(-1)));
  await win.click('[data-command="redo"]');
  const redone = await win.evaluate(() => JSON.stringify(window.__inkleaf.getDoc().annots(window.__inkleaf.getDoc().pages[0].id).at(-1)));
  check('undo reverts the move, redo restores it', before !== undone && before === redone);

  // the same through keyboard shortcuts, which travel via the app menu
  const lastMark = () => win.evaluate(() => JSON.stringify(window.__inkleaf.getDoc().annots(window.__inkleaf.getDoc().pages[0].id).at(-1)));
  const marks = await annotCount(win);
  await win.keyboard.press('Control+z');
  await win.waitForTimeout(150);
  const keyUndone = await lastMark();
  await win.keyboard.press('Control+y');
  await win.waitForTimeout(150);
  check('Ctrl+Z and Ctrl+Y work', keyUndone === undone && (await lastMark()) === before);

  // copy and paste the selected rectangle, then undo the paste
  await win.click(`[data-tool="select"]`);
  const rectPoint = await at(win, 0, 400, 640);
  await win.mouse.click(rectPoint.x, rectPoint.y);
  await win.keyboard.press('Control+c');
  await win.keyboard.press('Control+v');
  await win.waitForTimeout(200);
  check('Ctrl+C / Ctrl+V duplicates a mark', (await annotCount(win)) === marks + 1);
  await win.keyboard.press('Delete');
  await win.waitForTimeout(100);
  check('Delete removes the selected mark', (await annotCount(win)) === marks);

  // page tools: rotate page 3, delete page 2, add a blank page at the end
  await win.evaluate(() => {
    const { viewer, getDoc } = window.__inkleaf;
    viewer.scrollToPage(getDoc().pages[2].id, false);
  });
  await win.hover('.thumb:nth-child(3) .thumb-frame');
  await win.click('.thumb:nth-child(3) [title="Rotate right"]');
  await win.hover('.thumb:nth-child(2) .thumb-frame');
  await win.click('.thumb:nth-child(2) [title="Delete page"]');
  await win.click('#sidebar [data-command="insert-blank"]');
  await win.waitForTimeout(400);
  check('page list is now 3 pages', (await win.evaluate(() => window.__inkleaf.getDoc().pages.length)) === 3);

  // sign: draw a squiggle and drop it on page 1
  await win.click('[data-tool="sign"]');
  await win.click('.sign-menu .menu-item:has-text("New signature")');
  await win.waitForSelector('.sig-canvas');
  const pad = await win.locator('.sig-canvas').boundingBox();
  await win.mouse.move(pad.x + 60, pad.y + 120);
  await win.mouse.down();
  for (let i = 0; i <= 30; i++) {
    await win.mouse.move(pad.x + 60 + i * 12, pad.y + 110 + Math.sin(i / 2.5) * 35);
  }
  await win.mouse.up();
  if (shots) await win.screenshot({ path: path.join(shots, 'signature-dialog.png') });
  await win.click('.modal .btn-primary');
  await win.waitForFunction(() => !!window.__inkleaf.editor.placement);
  p = await at(win, 0, 430, 200);
  await win.mouse.move(p.x, p.y);
  await win.mouse.click(p.x, p.y);
  check('signature placed', (await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    return doc.annots(doc.pages[0].id).some((a) => a.type === 'image');
  })));
  // a saved signature goes on in one click from the Sign menu
  await win.click('[data-tool="sign"]');
  await win.click('.sign-menu .sign-tile');
  await win.waitForFunction(() => !!window.__inkleaf.editor.placement);
  p = await at(win, 0, 430, 120);
  await win.mouse.move(p.x, p.y);
  await win.mouse.click(p.x, p.y);
  const images = await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    return doc.annots(doc.pages[0].id).filter((a) => a.type === 'image').length;
  });
  check('saved signature places in one click', images === 2, `images ${images}`);
  await win.evaluate(() => {
    const { editor, getDoc } = window.__inkleaf;
    const doc = getDoc();
    const extra = doc.annots(doc.pages[0].id).filter((a) => a.type === 'image')[1];
    editor.select({ pageId: doc.pages[0].id, id: extra.id });
    editor.deleteSelected();
  });

  await win.evaluate(() => window.__inkleaf.viewer.scrollToPage(window.__inkleaf.getDoc().pages[0].id, false));
  await win.waitForTimeout(500);
  if (shots) await win.screenshot({ path: path.join(shots, 'editing.png') });

  const file = path.join(out, 'edited.pdf');
  const warnings = await save(win, file);
  check('saved without warnings', warnings.length === 0, warnings.join('; '));

  const t = text(file);
  check('replacement text is in the file', t.includes('INV-2042'));
  check('original text is gone from the file', !t.includes('INV-2041'));
  check('redacted amount is gone', !t.includes('18,450'), t.split('\n').find((l) => l.includes('Total')));
  check('rest of the redacted line survives', /Total due:\s+rupees/.test(t));
  check('added text is in the file', t.includes('Approved by front office'));
  check('deleted page is gone', !t.includes('Page two heading'));
  check('saved file has 3 pages', pageCount(file) === 3);
  const raw = execFileSync('qpdf', ['--qdf', '--object-streams=disable', file, '-']).toString('latin1');
  check('no copy of the old invoice number anywhere in the bytes', !raw.includes('INV-2041') && !raw.includes('18,450'));

  const rotation = execFileSync('python3', ['-c',
    `import pypdf,sys; r=pypdf.PdfReader(sys.argv[1]); print(r.pages[1].rotation)`, file]).toString().trim();
  check('third page (now second) is rotated 90°', rotation === '90', `rotation ${rotation}`);

  execFileSync('pdftoppm', ['-r', '70', '-png', '-f', '1', '-l', '2', file, path.join(out, 'edited')]);
  if (shots) {
    for (const f of fs.readdirSync(out).filter((f) => f.startsWith('edited-'))) fs.copyFileSync(path.join(out, f), path.join(shots, `saved-${f}`));
  }

  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}

// --- 2. filling a form ------------------------------------------------------------

async function formTest() {
  console.log('\nFilling form.pdf');
  const { app, win, errors } = await launch(path.join(fixtures, 'form.pdf'));
  await waitForPages(win);
  await win.waitForSelector('.form-field');

  // tabs: a second file opens alongside, Ctrl+Tab switches, Ctrl+W closes
  await app.evaluate(async ({ BrowserWindow }, file) => {
    const fs = process.mainModule.require('node:fs');
    const data = new Uint8Array(fs.readFileSync(file));
    BrowserWindow.getAllWindows()[0].webContents.send('open-file', { path: null, name: 'sample.pdf', data });
  }, path.join(fixtures, 'sample.pdf'));
  await win.waitForFunction(() => window.__inkleaf.tabCount() === 2);
  check('second file opens in a new tab', (await win.locator('.tab').count()) === 2);
  if (shots) await win.screenshot({ path: path.join(shots, 'tabs.png') });
  await win.keyboard.press('Control+w');
  await win.waitForFunction(() => window.__inkleaf.tabCount() === 1);
  check('Ctrl+W closes the tab', (await win.evaluate(() => window.__inkleaf.getDoc().name)) === 'form.pdf');
  await win.waitForTimeout(500);
  await win.waitForSelector('.form-field');

  await win.fill('.form-field[title="guest_name"]', 'Aarav Mehta');
  await win.fill('.form-field[title="nights"]', '3');
  await win.press('.form-field[title="nights"]', 'Tab');
  await win.check('.form-field[title="breakfast"]');
  await win.selectOption('.form-field[title="room_type"]', 'Deluxe');
  const radios = win.locator('.form-field[title="payment"]');
  await radios.nth(1).check();
  if (shots) await win.screenshot({ path: path.join(shots, 'form.png') });

  const file = path.join(out, 'form-filled.pdf');
  const warnings = await save(win, file);
  check('saved without warnings', warnings.length === 0, warnings.join('; '));

  const fields = JSON.parse(execFileSync('python3', ['-c', `
import json, pypdf, sys
r = pypdf.PdfReader(sys.argv[1])
print(json.dumps({k: str(v.get('/V')) for k, v in r.get_fields().items()}))`, file]).toString());
  check('text field saved', fields.guest_name === 'Aarav Mehta', JSON.stringify(fields));
  check('second text field saved', fields.nights === '3');
  check('checkbox saved', fields.breakfast !== 'None' && fields.breakfast !== '/Off', fields.breakfast);
  check('dropdown saved', fields.room_type === 'Deluxe', fields.room_type);
  check('radio group saved', fields.payment === '/cash', fields.payment);
  check('filled value is visible on the page', text(file).includes('Aarav Mehta'));
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}

// --- 3. protected files -------------------------------------------------------------

async function protectedTest() {
  console.log('\nOpening protected files');
  let { app, win } = await launch(path.join(fixtures, 'password.pdf'));
  await win.waitForSelector('.modal input[type="password"]');
  await win.fill('.modal input[type="password"]', 'wrong guess');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
  check('wrong password asks again', await win.isVisible('.modal input[type="password"]'));
  await win.fill('.modal input[type="password"]', 'open-sesame');
  await win.keyboard.press('Enter');
  await waitForPages(win);
  let file = path.join(out, 'unlocked.pdf');
  await save(win, file);
  check('password-protected file opens and saves', text(file).includes('Invoice number'));
  await quit(app, win);

  ({ app, win } = await launch(path.join(fixtures, 'owner-locked.pdf')));
  await waitForPages(win);
  // pages can be reordered by dragging, no questions asked
  await win.hover('.thumb:nth-child(1) .thumb-frame');
  const order = await win.evaluate(() => window.__inkleaf.getDoc().pages.map((p) => p.id).join());
  await win.dragAndDrop('.thumb:nth-child(1)', '.thumb:nth-child(3)', { targetPosition: { x: 60, y: 150 } });
  await win.waitForTimeout(300);
  check('pages reorder by dragging', !(await win.isVisible('.modal')) && order !== (await win.evaluate(() => window.__inkleaf.getDoc().pages.map((p) => p.id).join())));
  file = path.join(out, 'owner-unlocked.pdf');
  await save(win, file);
  const enc = execFileSync('qpdf', ['--show-encryption', file]).toString();
  check('edit-restricted file opens without a prompt and saves unlocked', enc.includes('not encrypted'));
  await quit(app, win);
}

// --- 4. fonts and the text toolbar --------------------------------------------------

const textAnnots = (win) => win.evaluate(() => {
  const doc = window.__inkleaf.getDoc();
  return doc.pages.flatMap((p) => doc.annots(p.id)).filter((a) => a.type === 'text' || a.type === 'replace')
    .map(({ id, type, x, y, text, family, underline, align, background }) => ({ id, type, x, y, text, family, underline, align, background }));
});

async function fontTest() {
  console.log('\nFonts and the text toolbar (chrome.pdf)');
  const { app, win, errors } = await launch(path.join(fixtures, 'chrome.pdf'));
  await waitForPages(win);

  // edit a line set in an embedded subset font; the edit should keep it
  await win.click('[data-tool="edit-text"]');
  let p = await at(win, 0, 100, 729);
  await win.mouse.move(p.x, p.y);
  await win.waitForTimeout(400); // hovering warms up the font
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.text-editor');
  const original = await win.inputValue('.text-editor');
  check('edit-text picks up the line', original.startsWith('Reservation 7741'), `got "${original}"`);
  await win.fill('.text-editor', original.replace('7741', '1477'));
  check('floating toolbar shows while editing', await win.isVisible('.text-toolbar'));
  const fontLabel = await win.textContent('.tt-font-name');
  check('toolbar names the original font', /DejaVu/.test(fontLabel), `got "${fontLabel}"`);
  await win.keyboard.press('Escape');
  let [edit] = await textAnnots(win);
  check('edited line uses the document font', edit?.family?.startsWith('doc:'), JSON.stringify(edit));
  check('Esc leaves the edited box selected',
    (await win.evaluate(() => window.__inkleaf.editor.selection?.id)) === edit?.id);

  // add a text box and format it from the floating toolbar
  await win.keyboard.press('t');
  p = await at(win, 0, 300, 500);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.text-editor');
  await win.keyboard.type('Checked in');
  await win.click('.text-toolbar button[title^="Underline"]');
  await win.click('.text-toolbar button[title="Align center"]');
  await win.click('.text-toolbar button[title="Background colour"]');
  await win.click('.tt-pop .tt-swatch[title="#fff3a3"]');
  check('typing survives toolbar clicks', await win.isVisible('.text-editor'));
  await win.keyboard.type('!');
  await win.keyboard.press('Escape');
  let added = (await textAnnots(win)).find((a) => a.type === 'text');
  check('toolbar applies underline, alignment and background',
    added?.text === 'Checked in!' && added.underline && added.align === 'center' && added.background === '#fff3a3', JSON.stringify(added));

  // with the text tool still on, dragging the box moves it instead of typing
  const before = added;
  const from = await at(win, 0, before.x + 20, before.y - 6);
  await drag(win, from, { x: from.x + 80, y: from.y + 40 });
  await win.waitForTimeout(150);
  added = (await textAnnots(win)).find((a) => a.id === before.id);
  check('text tool drags a text box', added.x > before.x + 20 && added.y < before.y - 10 && !(await win.isVisible('.text-editor')),
    `${before.x},${before.y} → ${added.x},${added.y}`);
  // and a plain click on it opens it for typing
  const again = await at(win, 0, added.x + 20, added.y - 6);
  await win.waitForTimeout(100); // let the toolbar catch up with the scroll
  await win.mouse.click(again.x, again.y);
  await win.waitForSelector('.text-editor');
  check('clicking a text box with the text tool edits it', (await win.inputValue('.text-editor')) === 'Checked in!');
  await win.keyboard.press('Escape');
  if (shots) await win.screenshot({ path: path.join(shots, 'text-toolbar.png') });

  // pick a font installed on this computer from the toolbar's font list
  await win.keyboard.press('t');
  p = await at(win, 0, 100, 400);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.text-editor');
  await win.keyboard.type('Installed font');
  await win.click('.tt-font');
  await win.waitForFunction(() => !document.querySelector('.tt-font-note')?.textContent.includes('Loading'));
  await win.fill('.tt-search', 'DejaVu Serif');
  await win.click('.tt-font-item:has-text("DejaVu Serif")');
  await win.waitForTimeout(500);
  check('choosing a font keeps the box open for typing', await win.isVisible('.text-editor'));
  await win.keyboard.type(' works');
  await win.keyboard.press('Escape');
  const installed = (await textAnnots(win)).find((a) => a.text?.startsWith('Installed font'));
  check('installed font applies to the box', installed?.text === 'Installed font works' && installed.family === 'sys:DejaVu Serif', JSON.stringify(installed));

  const file = path.join(out, 'chrome-edited.pdf');
  const warnings = await save(win, file);
  check('saved without warnings', warnings.length === 0, warnings.join('; '));
  const t = text(file);
  check('edit is in the file', t.includes('Reservation 1477') && !t.includes('7741'));
  const fonts = execFileSync('pdffonts', [file]).toString();
  // the original subset stays for the untouched lines; the edit brings its own copy
  const sans = fonts.split('\n').filter((l) => /^\S*DejaVuSans[-\s]/.test(l) && !/Mono/.test(l));
  check('edited text is set in the original font, not Helvetica', sans.length >= 2, fonts);
  check('installed font is embedded', fonts.split('\n').filter((l) => /DejaVuSerif/.test(l)).length >= 2, fonts);
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}

// --- 5. version 2 tools ---------------------------------------------------------------

const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args]).toString().trim();

/** Makes the next native Save / Open dialog answer with `answer`, without showing it. */
async function stubDialog(app, kind, answer) {
  await app.evaluate(({ dialog }, [kind, answer]) => {
    const original = dialog[kind];
    dialog[kind] = async () => {
      dialog[kind] = original;
      return kind === 'showSaveDialog' ? { canceled: false, filePath: answer } : { canceled: false, filePaths: answer };
    };
  }, [kind, answer]);
}

async function modalButton(win, label) {
  await win.click(`.modal button:has-text("${label}")`);
}

async function v2Test() {
  console.log('\nVersion 2 tools (sample.pdf)');
  const { app, win, errors } = await launch(path.join(fixtures, 'sample.pdf'));
  await waitForPages(win);

  // find
  await win.keyboard.press('Control+f');
  await win.fill('.find-input', 'rupees');
  await win.waitForFunction(() => /of/.test(document.querySelector('.find-count')?.textContent ?? ''));
  const findCount = await win.textContent('.find-count');
  check('Ctrl+F finds text', /^1 of \d+$/.test(findCount), findCount);
  check('matches are highlighted on the page', (await win.locator('.page .find-mark.current').count()) === 1);
  await win.keyboard.press('Escape');

  // free features first: comment, stamp, crop, reading mode, bookmarks
  await win.keyboard.press('n');
  let p = await at(win, 0, 480, 760);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.note-card:not([hidden]) .note-text');
  await win.keyboard.type('Please check the room number');
  await win.keyboard.press('Escape');
  await win.evaluate(() => { void window.__inkleaf.run('show-comments'); });
  check('comment shows in the comments panel', (await win.textContent('#comments')).includes('Please check the room number'));
  check('comment count badge', (await win.textContent('#comment-count')) === '1');

  await win.keyboard.press('k');
  await win.click('.stamp-chips .chip:has-text("PAID")');
  p = await at(win, 0, 450, 640);
  await win.mouse.click(p.x, p.y);
  const stamp = await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    return doc.annots(doc.pages[0].id).find((a) => a.type === 'stamp');
  });
  check('stamp placed with a date', stamp?.label === 'PAID' && !!stamp.date, JSON.stringify(stamp));

  await win.evaluate(() => { void window.__inkleaf.run('show-bookmarks'); });
  await win.click('#bookmarks button:has-text("Add bookmark")');
  await win.fill('.modal .field-input', 'Invoice');
  await modalButton(win, 'OK');
  await win.waitForTimeout(200);
  check('bookmark added', (await win.textContent('#bookmarks')).includes('Invoice'));

  await win.evaluate(() => { void window.__inkleaf.run('mode-spread'); });
  await win.waitForTimeout(300);
  const tops = await win.evaluate(() => [...document.querySelectorAll('.page')].slice(0, 2).map((e) => e.offsetTop));
  check('two-page view puts pages side by side', tops.length === 2 && tops[0] === tops[1], JSON.stringify(tops));
  await win.evaluate(() => { void window.__inkleaf.run('mode-single'); });
  await win.waitForTimeout(200);
  check('single-page view shows one page', (await win.locator('.page:not([hidden])').count()) === 1);
  await win.evaluate(() => { void window.__inkleaf.run('mode-continuous'); });
  await win.waitForTimeout(300);

  // crop page 3
  await win.evaluate(() => { void window.__inkleaf.run('crop'); });
  await at(win, 2, 230, 560);
  const c1 = await pos(win, 2, 60, 700), c2 = await pos(win, 2, 400, 420);
  await drag(win, c1, c2);
  await win.waitForSelector('.modal');
  await modalButton(win, 'This page');
  await win.waitForTimeout(300);
  const crop = await win.evaluate(() => window.__inkleaf.getDoc().pages[2].crop);
  check('crop applied to the page', !!crop && crop.w > 300 && crop.w < 360, JSON.stringify(crop));

  // the bigger tools

  await win.evaluate(() => { void window.__inkleaf.run('decor'); });
  await win.waitForSelector('.decor-dialog');
  await win.click('.decor-dialog .check.strong:has-text("Watermark") input');
  await win.click('.decor-dialog .check.strong:has-text("Page numbers") input');
  await modalButton(win, 'Apply');
  await win.waitForTimeout(400);
  if (shots) await win.screenshot({ path: path.join(shots, 'v2-page.png') });

  await win.evaluate(() => { void window.__inkleaf.run('form-builder'); });
  p = await at(win, 0, 300, 560);
  await drag(win, p, { x: p.x + 150, y: p.y + 24 });
  const field = await win.evaluate(() => window.__inkleaf.editor.selectedAnnot());
  check('form field drawn', field?.type === 'field' && field.name === 'Text 1', JSON.stringify(field));
  await win.fill('#inspector .field-input[aria-label="Field name"]', 'Guest signature name');
  await win.keyboard.press('Tab');
  await win.keyboard.press('Escape');

  // print: the system dialog is stubbed; check the pages were prepared
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.print = (_opts, done) => {
      wc.executeJavaScript('document.querySelectorAll("#print-root img").length').then((n) => {
        globalThis.__printedPages = n;
        done(false, 'cancelled');
      });
    };
  });
  await win.evaluate(() => { void window.__inkleaf.run('print'); });
  await win.waitForFunction(() => !document.querySelector('#print-root'), null, { timeout: 30000 }).catch(() => {});
  await win.waitForTimeout(500);
  const printed = await app.evaluate(() => globalThis.__printedPages);
  check('print prepares every page', printed === 3, `pages ${printed}`);

  const file = path.join(out, 'v2.pdf');
  const warnings = await save(win, file);
  check('saved without warnings', warnings.length === 0, warnings.join('; '));
  const t = text(file);
  check('page numbers are in the file', t.includes('Page 1 of 3') && t.includes('Page 3 of 3'));
  // diagonal text comes out letter by letter in a layout dump, so read it raw
  check('watermark is in the file', execFileSync('pdftotext', ['-raw', file, '-']).toString().includes('CONFIDENTIAL'));
  check('stamp is in the file', t.includes('PAID'));
  const info = JSON.parse(py(`
import pypdf, sys, json
r = pypdf.PdfReader(sys.argv[1])
notes = [a.get_object() for a in (r.pages[0].get('/Annots') or []) if a.get_object().get('/Subtype') == '/Text']
fields = list((r.get_fields() or {}).keys())
outline = [o.title for o in r.outline if not isinstance(o, list)]
crop = [float(v) for v in r.pages[2].cropbox]
print(json.dumps({"notes": [str(n.get('/Contents')) for n in notes], "fields": fields, "outline": outline, "crop": crop}))
`, file));
  check('comment saved as a PDF comment', info.notes.length === 1 && info.notes[0] === 'Please check the room number', JSON.stringify(info.notes));
  check('form field saved as a fillable field', info.fields.includes('Guest signature name'), JSON.stringify(info.fields));
  check('bookmark saved', info.outline.includes('Invoice'), JSON.stringify(info.outline));
  check('crop saved as the page’s crop box', info.crop[2] - info.crop[0] < 360, JSON.stringify(info.crop));

  // protect: answer the Save dialog, then check the copy needs the password
  const locked = path.join(out, 'v2-protected.pdf');
  await stubDialog(app, 'showSaveDialog', locked);
  await win.evaluate(() => { void window.__inkleaf.run('protect'); });
  await win.waitForSelector('.modal .protect');
  const pw = win.locator('.modal .protect input[type="password"]');
  await pw.nth(0).fill('hotel-2026');
  await pw.nth(1).fill('hotel-2026');
  await modalButton(win, 'Save protected copy');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('protected copy')), null, { timeout: 30000 });
  const enc = execFileSync('qpdf', ['--show-encryption', '--password=hotel-2026', locked]).toString();
  let opensWithout = true;
  try {
    execFileSync('qpdf', ['--check', locked], { stdio: 'pipe' });
  } catch {
    opensWithout = false;
  }
  check('protected copy is AES-256 and needs the password', /R = 6/.test(enc) && !opensWithout, enc.split('\n')[0]);

  // Word
  const docx = path.join(out, 'v2.docx');
  await stubDialog(app, 'showSaveDialog', docx);
  await win.evaluate(() => { void window.__inkleaf.run('pdf-to-word'); });
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Word')), null, { timeout: 60000 });
  const xml = execFileSync('unzip', ['-p', docx, 'word/document.xml']).toString();
  check('Word export has the text', xml.includes('Invoice number') && xml.includes('Priya Sharma'));

  // pictures out
  const folder = fs.mkdtempSync(path.join(out, 'pics-'));
  await stubDialog(app, 'showOpenDialog', [folder]);
  await win.evaluate(() => { void window.__inkleaf.run('pdf-to-images'); });
  await modalButton(win, 'Export');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('picture')), null, { timeout: 60000 });
  const pics = fs.readdirSync(folder).filter((f) => f.endsWith('.png'));
  check('pages exported as pictures', pics.length === 3, pics.join(', '));

  // pictures in
  await stubDialog(app, 'showOpenDialog', pics.slice(0, 2).map((f) => path.join(folder, f)));
  await win.evaluate(() => { void window.__inkleaf.run('images-to-pdf'); });
  await modalButton(win, 'Make PDF');
  await win.waitForFunction(() => window.__inkleaf.tabCount() === 2, null, { timeout: 30000 });
  check('pictures become a new PDF', (await win.evaluate(() => window.__inkleaf.getDoc().pages.length)) === 2);
  await win.keyboard.press('Control+w');
  await win.waitForTimeout(300);

  // compare the edited document with the original file
  await stubDialog(app, 'showOpenDialog', [path.join(fixtures, 'sample.pdf')]);
  await win.evaluate(() => { void window.__inkleaf.run('compare'); });
  await win.waitForSelector('.compare-view .cmp-item', { timeout: 60000 });
  const changeText = await win.textContent('.compare-view .cmp-list');
  check('compare lists the changes', changeText.includes('PAID') && changeText.includes('CONFIDENTIAL'), changeText.slice(0, 200));
  check('compare marks words on the pages', (await win.locator('.cmp-mark.new').count()) > 0);
  if (shots) await win.screenshot({ path: path.join(shots, 'v2-compare.png') });
  await win.keyboard.press('Escape');

  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);

  // reopening keeps exactly one copy of the comment, and it stays editable
  {
    const { app, win } = await launch(file);
    await waitForPages(win);
    await win.waitForTimeout(600);
    const notes = await win.evaluate(() => {
      const doc = window.__inkleaf.getDoc();
      return doc.annots(doc.pages[0].id).filter((a) => a.type === 'note').map((a) => a.text);
    });
    check('reopened file shows its comment as an editable note', notes.length === 1 && notes[0] === 'Please check the room number', JSON.stringify(notes));
    const again = path.join(out, 'v2-again.pdf');
    await save(win, again);
    const count = py(`
import pypdf, sys
r = pypdf.PdfReader(sys.argv[1])
print(sum(1 for a in (r.pages[0].get('/Annots') or []) if a.get_object().get('/Subtype') == '/Text'))
`, again);
    check('saving again doesn’t duplicate comments', count === '1', count);
    await quit(app, win);
  }
}

async function ocrAndCompressTest() {
  console.log('\nOCR and compression');
  let { app, win, errors } = await launch(path.join(fixtures, 'scan.pdf'));
  await waitForPages(win);
  await win.evaluate(() => { void window.__inkleaf.run('ocr'); });
  await win.waitForSelector('.modal .lang-chips');
  await modalButton(win, 'Recognise text');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('word')), null, { timeout: 180000 });
  await win.keyboard.press('Control+f');
  await win.fill('.find-input', 'Booking');
  await win.waitForFunction(() => /of/.test(document.querySelector('.find-count')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
  check('OCR text can be found', /^1 of 1$/.test(await win.textContent('.find-count')), await win.textContent('.find-count'));
  await win.keyboard.press('Escape');
  const file = path.join(out, 'scan-ocr.pdf');
  await save(win, file);
  const t = text(file);
  check('OCR text is saved in the file', /Booking reference 58213/.test(t) && /Rohan Verma/.test(t), t.trim().split('\n').slice(0, 4).join(' | '));
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);

  ({ app, win, errors } = await launch(path.join(fixtures, 'photo.pdf')));
  await waitForPages(win);
  await win.evaluate(() => { void window.__inkleaf.run('compress'); });
  await modalButton(win, 'Compress');
  await win.waitForSelector('.modal .result-sizes', { timeout: 60000 });
  await modalButton(win, 'Open in a new tab');
  await win.waitForFunction(() => window.__inkleaf.tabCount() === 2, null, { timeout: 30000 });
  const sizes = await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    return doc.sources.get(doc.mainSource).bytes.length;
  });
  const original = fs.statSync(path.join(fixtures, 'photo.pdf')).size;
  check('compress makes the photo PDF much smaller', sizes * 4 < original, `${original} → ${sizes}`);
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}

// --- 7. auto-save and crash recovery ----------------------------------------------------

async function autosaveTest() {
  console.log('\nAuto-save and recovery');
  const copy = path.join(out, 'autosave.pdf');
  fs.copyFileSync(path.join(fixtures, 'sample.pdf'), copy);
  const before = fs.readFileSync(copy);
  let { app, win, errors, profile } = await launch(copy, { autosave: true });
  await waitForPages(win);
  check('auto-save is on by default', await win.evaluate(() => window.__inkleaf.autosave.enabled));
  await win.keyboard.press('r');
  await drag(win, await at(win, 0, 380, 680), await at(win, 0, 520, 600));
  await win.waitForFunction(() => !window.__inkleaf.getDoc().dirty, null, { timeout: 15000 }).catch(() => {});
  const after = fs.readFileSync(copy);
  check('changes are saved to the file by themselves', !before.equals(after) && !(await win.evaluate(() => window.__inkleaf.getDoc().dirty)));
  check('the indicator says Saved', (await win.textContent('#save-state')).includes('Saved'));
  const backups = fs.existsSync(path.join(profile, 'Backups')) ? fs.readdirSync(path.join(profile, 'Backups')) : [];
  check('the original was backed up first', backups.length === 1 && fs.readFileSync(path.join(profile, 'Backups', backups[0])).equals(before), backups.join(', '));
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);

  // unsaved work in a new document survives the app being killed
  ({ app, win, profile } = await launch(null, { autosave: true }));
  await win.keyboard.press('Control+n');
  await win.waitForFunction(() => !!window.__inkleaf.getDoc());
  await waitForPages(win);
  await win.keyboard.press('t');
  const p = await at(win, 0, 100, 700);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.text-editor');
  await win.keyboard.type('Recovered words');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__inkleaf.autosave.copyForRecovery());
  app.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  ({ app, win } = await launch(null, { profile }));
  await win.waitForSelector('.modal:has-text("Restore unsaved work")', { timeout: 15000 });
  await win.click('.modal button:has-text("Restore")');
  await win.waitForFunction(() => window.__inkleaf.tabCount() === 1, null, { timeout: 15000 });
  await waitForPages(win);
  const restored = await win.evaluate(async () => {
    const doc = window.__inkleaf.getDoc();
    const src = doc.sources.get(doc.mainSource);
    const page = await src.pdf.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
    return { name: doc.name, text };
  });
  check('unsaved work is offered back after a crash', restored.text.includes('Recovered words') && /recovered/.test(restored.name), JSON.stringify(restored));
  await quit(app, win);
}

// --- 8. converting to and from PDF ---------------------------------------------------

/** Text of every page of the open document, as pdf.js reads it. */
const docText = (win) => win.evaluate(async () => {
  const doc = window.__inkleaf.getDoc();
  const src = doc.sources.get(doc.mainSource);
  const parts = [];
  for (let i = 1; i <= src.pdf.numPages; i++) {
    const page = await src.pdf.getPage(i);
    parts.push((await page.getTextContent()).items.map((it) => it.str).join(' '));
  }
  return { name: doc.name, pages: src.pdf.numPages, text: parts.join('\n') };
});

async function convertTest() {
  console.log('\nConverting to and from PDF');

  // built-in converters (as on a computer without LibreOffice)
  let { app, win, errors } = await launch(null, { env: { INKLEAF_NO_OFFICE: '1' } });
  const expect = {
    'letter.docx': ['Guest welcome letter', 'Kavya Rao', 'Grand Hotel Aurora', 'Suite'],
    'occupancy.xlsx': ['March', 'Rooms sold', '351000'],
    'review.pptx': ['Quarterly review', 'Front office team', 'Occupancy up to 81 percent', 'Prepared by Meera'],
    'rates.csv': ['Breakfast', '14,000'],
    'notes.md': ['Housekeeping notes', 'Change towels', 'daily'],
  };
  for (const [name, words] of Object.entries(expect)) {
    const before = await win.evaluate(() => window.__inkleaf.tabCount());
    await stubDialog(app, 'showOpenDialog', [path.join(fixtures, name)]);
    await win.evaluate(() => { void window.__inkleaf.run('open'); });
    await win.waitForFunction((n) => window.__inkleaf.tabCount() === n + 1, before, { timeout: 60000 });
    await waitForPages(win);
    const got = await docText(win);
    const missing = words.filter((w) => !got.text.replace(/\s+/g, ' ').includes(w));
    check(`${name} opens as a PDF (built-in converter)`, got.name === name.replace(/\.[^.]+$/, '.pdf') && !missing.length,
      `missing: ${missing.join(', ')} | ${got.text.slice(0, 160)}`);
    if (name === 'review.pptx') check('each slide becomes a page', got.pages === 2, `pages ${got.pages}`);
  }
  if (shots) await win.screenshot({ path: path.join(shots, 'converted-pptx.png') });
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);

  // with LibreOffice, office files keep their exact layout
  const office = (() => {
    try {
      execFileSync('soffice', ['--version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();
  if (office) {
    ({ app, win, errors } = await launch(null));
    await stubDialog(app, 'showOpenDialog', [path.join(fixtures, 'review.pptx')]);
    await win.evaluate(() => { void window.__inkleaf.run('convert-to-pdf'); });
    await win.waitForFunction(() => window.__inkleaf.tabCount() === 1, null, { timeout: 120000 });
    await waitForPages(win);
    const got = await docText(win);
    check('LibreOffice converts PowerPoint when it’s installed', got.pages === 2 && got.text.includes('Highlights'), got.text.slice(0, 120));
    await quit(app, win);
  } else {
    console.log('  – LibreOffice not installed here; skipped its check');
  }

  // from PDF to everything else
  ({ app, win, errors } = await launch(path.join(fixtures, 'table.pdf')));
  await waitForPages(win);
  const exportAs = async (title, file) => {
    await stubDialog(app, 'showSaveDialog', file);
    await win.evaluate(() => { void window.__inkleaf.run('convert-from-pdf'); });
    await win.click(`.format-card:has-text("${title}")`);
    await modalButton(win, 'Convert');
    await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Saved the')), null, { timeout: 60000 });
    await win.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  };
  const xlsx = path.join(out, 'table.xlsx');
  await exportAs('Excel', xlsx);
  const cells = JSON.parse(py(`
import openpyxl, sys, json
ws = openpyxl.load_workbook(sys.argv[1]).active
print(json.dumps([[c.value for c in row] for row in ws.iter_rows()]))
`, xlsx));
  check('PDF to Excel finds the table, with numbers as numbers',
    JSON.stringify(cells[0]) === '["Item","Qty","Amount"]' && cells[1][2] === 25500 && cells[3][0] === 'Laundry', JSON.stringify(cells));

  const pptxFile = path.join(out, 'table.pptx');
  await exportAs('PowerPoint', pptxFile);
  const slides = py(`
import pptx, sys
d = pptx.Presentation(sys.argv[1])
print(len(d.slides), d.slides[0].has_notes_slide and 'Laundry' in d.slides[0].notes_slide.notes_text_frame.text)
`, pptxFile);
  check('PDF to PowerPoint makes a slide per page with the text in the notes', slides === '1 True', slides);

  for (const [title, ext, word] of [['Plain text', 'txt', 'Room night'], ['Markdown', 'md', '**Item'], ['Web page', 'html', '<strong>Item']]) {
    const file = path.join(out, `table.${ext}`);
    await exportAs(title, file);
    const body = fs.readFileSync(file, 'utf8');
    check(`PDF to ${title.toLowerCase()}`, body.includes(word) && body.includes('Laundry'), body.slice(0, 160));
  }
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}


async function moreToolsTest() {
  console.log('\nScan, repair, PDF/A, web pages, unlock, AI and the tools page');
  const waitToast = (win, words, timeout = 60000) => win.waitForFunction((w) => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(w)), words, { timeout });
  const clearToasts = (win) => win.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const newTab = async (win, before, timeout = 60000) => {
    await win.waitForFunction((n) => window.__inkleaf.tabCount() === n + 1, before, { timeout });
    await waitForPages(win);
  };

  // PDF/A, checked with pikepdf's own validator
  let { app, win, errors } = await launch(path.join(fixtures, 'sample.pdf'), { env: { INKLEAF_AI_MOCK: '1' } });
  await waitForPages(win);

  // terms and privacy, from the Help menu
  await win.evaluate(() => { void window.__inkleaf.run('terms'); });
  await win.waitForSelector('.legal-doc');
  check('terms of use open from Help, with the no-liability section',
    (await win.textContent('.modal-title')).includes('Terms of Use') && (await win.textContent('.legal-doc')).includes('No liability'));
  await modalButton(win, 'Close');
  await win.waitForTimeout(250);
  await win.evaluate(() => { void window.__inkleaf.run('privacy'); });
  await win.waitForSelector('.modal-title:has-text("Privacy Policy")');
  check('privacy policy opens from Help', (await win.textContent('.legal-doc')).includes("doesn't collect anything"));
  await modalButton(win, 'Close');
  await win.waitForTimeout(250);

  const pdfa = path.join(out, 'sample-pdfa.pdf');
  await stubDialog(app, 'showSaveDialog', pdfa);
  await win.evaluate(() => { void window.__inkleaf.run('pdf-to-pdfa'); });
  await win.waitForFunction(() => document.querySelector('.modal-title')?.textContent.includes('PDF/A') || [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('PDF/A')), null, { timeout: 60000 });
  if (await win.isVisible('.modal')) await modalButton(win, 'OK');
  const verdict = py(`
import pikepdf.pdfa, sys
r = pikepdf.pdfa.validate_written(sys.argv[1], '2b')
bad = [f'{f.rule}: {f.message}' for f in r.findings if f.kind == 'violation']
print('passed' if r.passed and not bad else 'failed: ' + '; '.join(bad[:4] or [str(f) for f in r.findings][:4]))
`, pdfa);
  check('PDF/A copy passes the PDF/A-2b checks', verdict === 'passed', verdict);
  check('PDF/A keeps the text', text(pdfa).includes('Invoice number'));
  await clearToasts(win);

  // AI (with the test stand-in for Anthropic's API)
  await win.evaluate(() => { void window.__inkleaf.run('ai-summarize'); });
  await win.waitForSelector('.modal:has-text("AI Summarizer")');
  await modalButton(win, 'Summarize');
  await win.waitForSelector('.ai-summary li', { timeout: 30000 });
  check('AI summary shows up as formatted text', (await win.textContent('.ai-summary')).includes('First key point'));
  await modalButton(win, 'Add as a comment');
  await win.waitForTimeout(300);
  const noted = await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    return doc.annots(doc.pages[0].id).some((a) => a.type === 'note' && a.text.includes('AI summary'));
  });
  check('summary can be kept as a comment', noted);

  let before = await win.evaluate(() => window.__inkleaf.tabCount());
  await win.evaluate(() => { void window.__inkleaf.run('ai-translate'); });
  await win.waitForSelector('.modal:has-text("Translate PDF")');
  await win.selectOption('.modal select >> nth=0', 'French');
  await modalButton(win, 'Translate');
  await newTab(win, before);
  const translated = await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    return { name: doc.name, texts: doc.pages.flatMap((p) => doc.annots(p.id)).filter((a) => a.type === 'replace').map((a) => a.text) };
  });
  check('translation lays the new words over a copy of the pages',
    translated.name.includes('(French)') && translated.texts.some((t) => t.startsWith('[Français] Invoice number')), JSON.stringify(translated).slice(0, 200));
  const frenchFile = path.join(out, 'translated.pdf');
  await save(win, frenchFile);
  const frenchText = text(frenchFile);
  check('translated PDF has the translated text instead of the original', frenchText.includes('[Français] Invoice number') && !/^\s*Invoice number/m.test(frenchText), frenchText.slice(0, 200));

  const wordFile = path.join(out, 'translated.docx');
  await stubDialog(app, 'showSaveDialog', wordFile);
  await win.evaluate(() => { void window.__inkleaf.run('ai-translate'); });
  await win.waitForSelector('.modal:has-text("Translate PDF")');
  await win.selectOption('.modal select >> nth=0', 'Hindi');
  await win.selectOption('.modal select >> nth=1', 'word');
  await modalButton(win, 'Translate');
  await waitToast(win, 'Hindi translation');
  const docx = py(`
import docx, sys
print(' '.join(p.text for p in docx.Document(sys.argv[1]).paragraphs))
`, wordFile);
  check('translating into Hindi can make a Word document', docx.includes('[हिन्दी] '), docx.slice(0, 160));
  await clearToasts(win);

  // the tools page
  await win.evaluate(() => { void window.__inkleaf.run('all-tools'); });
  await win.waitForSelector('.hub-tool');
  const counts = await win.evaluate(() => ({ groups: document.querySelectorAll('.hub-group').length, tools: document.querySelectorAll('.hub-tool').length }));
  check('all tools page lists every tool in seven groups', counts.groups === 7 && counts.tools >= 33, JSON.stringify(counts));
  if (shots) await win.waitForTimeout(400), await win.screenshot({ path: path.join(shots, 'all-tools.png') });
  await win.fill('.hub-search', 'excel');
  const shown = await win.evaluate(() => [...document.querySelectorAll('.hub-tool')].filter((t) => !t.hidden).map((t) => t.querySelector('strong').textContent));
  check('searching narrows the tools', shown.length === 2 && shown.includes('PDF to Excel'), shown.join(', '));
  await win.click('.hub-tool:has-text("PDF to Excel")');
  await win.waitForSelector('.format-card:has(input:checked):has-text("Excel")');
  check('picking a tool opens it', true);
  await modalButton(win, 'Cancel');
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);

  // damaged files
  const sample = fs.readFileSync(path.join(fixtures, 'sample.pdf'));
  const badXref = path.join(out, 'bad-xref.pdf');
  const latin = sample.toString('latin1');
  fs.writeFileSync(badXref, Buffer.from(latin.replace(/startxref\s+\d+/, 'startxref\n999999'), 'latin1'));
  const truncated = path.join(out, 'truncated.pdf');
  // a download that stopped just before the end: every page is there, the index and trailer aren't
  fs.writeFileSync(truncated, sample.subarray(0, latin.lastIndexOf('xref') - 40));

  ({ app, win, errors } = await launch(null));
  for (const [file, label] of [[badXref, 'broken index'], [truncated, 'cut-off file']]) {
    before = await win.evaluate(() => window.__inkleaf.tabCount());
    await stubDialog(app, 'showOpenDialog', [file]);
    await win.evaluate(() => { void window.__inkleaf.run('repair'); });
    await newTab(win, before);
    const got = await docText(win);
    check(`repair rescues a PDF with a ${label}`, got.pages >= 1 && got.name.includes('(repaired)'), JSON.stringify(got).slice(0, 160));
    await waitToast(win, 'Repaired');
    await clearToasts(win);
  }

  // unlock
  const unlocked = path.join(out, 'password-unlocked.pdf');
  await stubDialog(app, 'showOpenDialog', [path.join(fixtures, 'password.pdf')]);
  await stubDialog(app, 'showSaveDialog', unlocked);
  await win.evaluate(() => { void window.__inkleaf.run('unlock'); });
  await win.waitForSelector('.modal input[type="password"]');
  await win.fill('.modal input[type="password"]', 'open-sesame');
  await win.keyboard.press('Enter');
  await waitToast(win, 'unlocked copy');
  check('unlock saves a copy without the password', execFileSync('qpdf', ['--show-encryption', unlocked]).toString().includes('not encrypted') && text(unlocked).includes('Invoice number'));
  await clearToasts(win);

  // web page to PDF, from a little local server
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Checkout rules</title><h1>Checkout rules</h1><p id="p">Late checkout until 2 pm</p><script>document.getElementById("p").textContent += " on request";</script>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  before = await win.evaluate(() => window.__inkleaf.tabCount());
  await win.evaluate(() => { void window.__inkleaf.run('web-to-pdf'); });
  await win.fill('.modal input[type="url"]', `http://127.0.0.1:${server.address().port}/`);
  await modalButton(win, 'Make PDF');
  await newTab(win, before);
  const web = await docText(win);
  server.close();
  check('web page to PDF prints the page, scripts and all', web.name === 'Checkout rules.pdf' && web.text.includes('Late checkout until 2 pm on request'), JSON.stringify(web).slice(0, 200));

  // scan to PDF from a photo of a page on a dark table
  const photo = path.join(out, 'photo-of-page.jpg');
  py(`
from PIL import Image, ImageDraw, ImageFont
import sys
img = Image.new('RGB', (1600, 1200), (52, 46, 40))
page = Image.new('RGB', (760, 1000), (236, 232, 222))
d = ImageDraw.Draw(page)
try:
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 44)
except Exception:
    f = ImageFont.load_default()
d.text((70, 90), 'Room 304 checklist', fill=(20, 20, 20), font=f)
page = page.rotate(8, expand=True, fillcolor=(52, 46, 40))
img.paste(page, (400, 40))
img.save(sys.argv[1], quality=90)
`, photo);
  before = await win.evaluate(() => window.__inkleaf.tabCount());
  await win.evaluate(() => { void window.__inkleaf.run('scan-to-pdf'); });
  await win.waitForSelector('.scan');
  await stubDialog(app, 'showOpenDialog', [photo]);
  await win.click('.scan button:has-text("Add photos")');
  await win.waitForSelector('.scan-thumb img');
  await modalButton(win, 'Make PDF');
  await newTab(win, before);
  const scanned = await win.evaluate(() => {
    const doc = window.__inkleaf.getDoc();
    const box = doc.viewBox(doc.pages[0]);
    return { pages: doc.pages.length, w: box.w, h: box.h, name: doc.name };
  });
  if (shots) await win.screenshot({ path: path.join(shots, 'scan.png') });
  check('scan to PDF makes a page from the photo, cropped to the paper',
    scanned.pages === 1 && Math.round(scanned.w) === 595 && scanned.h > 700 && scanned.name.startsWith('Scan'), JSON.stringify(scanned));
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}

async function languagesTest() {
  console.log('\nWriting every script, language packs, translation over the page');
  const { app, win, errors } = await launch(null, { env: { INKLEAF_AI_MOCK: '1' } });
  await win.evaluate(() => window.__inkleaf.run('new'));
  await win.waitForFunction(() => window.__inkleaf.tabCount() === 1);
  await waitForPages(win);

  // text in many scripts at once, including right to left and mixed lines
  const samples = {
    hindi: 'हिन्दी में नमस्ते', arabic: 'مرحبا بالعالم', mixed: 'Invoice नंबर 42 فاتورة done', hebrew: 'שלום עולם',
    cyrillic: 'Привет мир', greek: 'Καλημέρα', vietnamese: 'Tiếng Việt', bengali: 'বাংলা ভাষা', tamil: 'தமிழ்',
    thai: 'ภาษาไทย', georgian: 'ქართული', amharic: 'አማርኛ', punjabi: 'ਪੰਜਾਬੀ', chinese: '中文简体',
  };
  await win.evaluate((samples) => {
    const doc = window.__inkleaf.getDoc();
    const page = doc.pages[0];
    Object.values(samples).forEach((text, i) => doc.addAnnot(page.id, { id: `s${i}`, type: 'text', x: 50, y: 800 - i * 44, angle: 0, text, size: 16, font: 'sans', bold: false, italic: false, color: '#111111' }));
    doc.commit();
  }, samples);
  const file = path.join(out, 'scripts.pdf');
  await save(win, file);
  const got = execFileSync('pdftotext', ['-raw', file, '-']).toString().normalize('NFC');
  const missing = Object.entries(samples).filter(([key, t]) => !['arabic', 'mixed', 'hebrew', 'hindi'].includes(key) && !got.includes(t.normalize('NFC'))).map(([k]) => k);
  check('text in 14 scripts saves and reads back (Chinese font downloaded on first use)', !missing.length, `missing: ${missing.join(', ')}`);
  const fonts = execFileSync('pdffonts', [file]).toString();
  check('each script is written in its own embedded font', ['NotoSansDevanagari', 'NotoSansArabic', 'NotoSansThai', 'NotoSansSC', 'NotoSans-Regular'].every((f) => fonts.includes(f)), fonts);
  check('fonts are subset (the file stays small)', fs.statSync(file).size < 150_000, `${fs.statSync(file).size} bytes`);
  // every glyph has ink: render the page and compare with what's on screen
  const ink = py(`
import subprocess, sys
from PIL import Image
subprocess.run(['pdftoppm', '-r', '50', '-png', '-singlefile', sys.argv[1], sys.argv[1][:-4]], check=True)
im = Image.open(sys.argv[1][:-4] + '.png').convert('L')
w, h = im.size
rows = []
for i in range(14):
    y0 = int((842 - 800 + i * 44 + 1) / 842 * h); y1 = int((842 - 800 + i * 44 + 19) / 842 * h)
    rows.append(sum(1 for x in range(w) for y in range(y0, y1) if im.getpixel((x, y)) < 140))
print(min(rows))
`, file);
  check('no line comes out blank in the saved PDF', Number(ink) > 20, `least ink in a line: ${ink}`);

  // the mock translator answers in the target language's own script
  const before = await win.evaluate(() => window.__inkleaf.tabCount());
  await win.evaluate(() => { void window.__inkleaf.run('ai-translate'); });
  await win.waitForSelector('.modal:has-text("Translate PDF")');
  await win.selectOption('.modal select >> nth=0', 'Arabic');
  await modalButton(win, 'Translate');
  await win.waitForFunction((n) => window.__inkleaf.tabCount() === n + 1, before, { timeout: 60000 });
  await waitForPages(win);
  const arabicFile = path.join(out, 'translated-arabic.pdf');
  await save(win, arabicFile);
  check('translating into Arabic draws Arabic over the page', execFileSync('pdffonts', [arabicFile]).toString().includes('NotoSansArabic'));

  // language packs: status, and a real download checked against its hash
  const status = await win.evaluate(() => window.inkleaf.packStatus());
  check('language pack list covers OCR models and CJK fonts', Object.keys(status).length > 50 && status['fonts/NotoSansSC-Regular.ttf']?.installed);
  let downloaded = false;
  try {
    await win.evaluate(() => window.inkleaf.ensurePacks(['ocr/fra.traineddata.gz']));
    downloaded = (await win.evaluate(() => window.inkleaf.packStatus()))['ocr/fra.traineddata.gz'].installed;
  } catch (err) {
    console.log(`  – couldn't reach jsDelivr (${String(err).slice(0, 80)}); skipped the download check`);
    downloaded = null;
  }
  if (downloaded !== null) check('a French OCR model downloads and passes its hash check', downloaded);
  check('no errors in the renderer', errors.length === 0, errors.join('\n      '));
  await quit(app, win);
}

// ONLY=fonts (or editing, forms, protected, v2, ocr) runs just that part
const only = process.env.ONLY;
for (const [name, test] of Object.entries({
  editing: editingTest, forms: formTest, protected: protectedTest, fonts: fontTest, v2: v2Test, ocr: ocrAndCompressTest, autosave: autosaveTest, convert: convertTest, tools: moreToolsTest, languages: languagesTest,
})) {
  if (!only || only.split(',').includes(name)) await test();
}

console.log(failures ? `\n${failures} check(s) failed. Output kept in ${out}` : `\nAll good. Output in ${out}`);
process.exit(failures ? 1 : 0);
