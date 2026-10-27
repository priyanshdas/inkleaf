// SPDX-License-Identifier: GPL-3.0-or-later
import { currentLocale, isRtl, msg, t } from '../shared/i18n';
import { TextToolbar } from './text-toolbar';
import { onFontsChanged } from './custom-fonts';
import { CONVERTIBLE, type MenuCommand, type OpenedFile, type RecentFile, type UpdateState } from '../shared/api';
import { FindBar } from './find';
import { CommentsPanel, NotePopup } from './notes';
import { OutlinePanel } from './outline';
import { printDocument } from './print';
import { compressDialog, decorDialog, imagesToPdf, pdfToImages, protectDialog, ToolHost } from './tools';
import { NO_DECOR } from './document';
import { DONATE_URL, ISSUES_URL, REPO_URL } from '../shared/config';
import { isMobile, supports } from '../shared/platform';
import { AutoSave, SaveState } from './autosave';
import type { Box } from './types';
import type { ReadingMode } from './viewer';
import { AppCommand, displayShortcut, MENU, MenuEntry, shortcutFor } from '../shared/commands';
import { ChangeDetail, EditorDoc } from './document';
import { Editor } from './editor';
import type { ExportResult } from './exporter';
import { loadFontMetrics } from './fonts';
import { FormLayer, SignFieldRequest } from './forms';
import { newId } from './geometry';
import { Inspector } from './inspector';
import {
  blankPdf, extractPages, insertBlankPage, insertPdfFiles, showWarnings, splitDocument, withUnlocked,
} from './page-tools';
import { chooseSignature, signMenu } from './signature';
import { Thumbnails } from './thumbnails';
import type { ImageAnnot, Tool } from './types';
import { confirmDialog, h, hydrateIcons, icon, localizeStatic, isModalOpen, liveStatus, modal, pickImage, richText, toast, toastHook } from './ui';
import { EnhancedView, NEUTRAL, enhancePanel, enhancedCopy, isNeutral, type Enhance } from './enhance';
import { Viewer } from './viewer';

const api = window.inkleaf;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const isMac = navigator.platform.toLowerCase().startsWith('mac');
document.documentElement.classList.add(isMac ? 'is-mac' : 'is-win');
let packaged = true;

/** Loads the PDF writer on first use, so it isn't part of start-up. */
async function exportPdf(target: EditorDoc, pageIds?: string[]): Promise<ExportResult> {
  const { exportPdf } = await import('./exporter');
  return exportPdf(target, pageIds);
}

// --- tabs -------------------------------------------------------------------
// Each tab is one open document. Only the active one is on screen; the others
// keep their edits, undo history and scroll position until you come back.

interface Tab {
  id: string;
  doc: EditorDoc;
  scale: number | null;
  scrollTop: number;
  scrollLeft: number;
}

const tabs: Tab[] = [];
let activeTab: Tab | null = null;
let doc: EditorDoc | null = null;
const getDoc = () => doc;

// --- core objects -----------------------------------------------------------

const viewer: Viewer = new Viewer($('#viewport'), $('#pages'), {
  hidden: () => editor.hidden(),
  coverOnly: () => editor.coverOnly(),
  selected: () => editor.selectedId(),
  afterRender: (view) => {
    forms.layout(view);
    findBar.layout(view);
    if (editor.text.active) editor.text.layout();
  },
});
const editor = new Editor(viewer, getDoc);
const forms = new FormLayer(viewer, getDoc);
const thumbs = new Thumbnails($('#thumbs'), viewer, getDoc);
const inspector = new Inspector($('#inspector'), editor, getDoc, (command) => run(command as Command));
const textToolbar = new TextToolbar(editor, viewer, getDoc);
const findBar = new FindBar(viewer, getDoc);
let userName = '';
const comments = new CommentsPanel($('#comments'), editor, viewer, getDoc, () => userName);
const bookmarks = new OutlinePanel($('#bookmarks'), viewer, getDoc);
new NotePopup(editor, viewer, getDoc);

// a font finishing loading changes how text measures and looks
onFontsChanged(() => {
  viewer.redraw();
  if (editor.text.active) editor.text.layout();
});

// --- busy indicator -------------------------------------------------------------

/** Engine mode (Android): told about changes so the native screens can follow. */
let engine: typeof import('./engine') | null = null;

let busyTimer = 0;
function busy(message: string | false) {
  clearTimeout(busyTimer);
  engine?.setBusy(message || null);
  const el = $('#busy');
  if (message === false) {
    el.hidden = true;
    return;
  }
  $('#busy-text').textContent = message;
  // only show it if the work takes long enough to notice
  busyTimer = window.setTimeout(() => (el.hidden = false), 250);
}

async function withBusy<T>(message: string, work: () => Promise<T>): Promise<T> {
  busy(message);
  try {
    return await work();
  } finally {
    busy(false);
  }
}

/** Updates the busy indicator's message while long work runs. */
function progress(message: string) {
  $('#busy-text').textContent = message;
  engine?.setBusy(message);
}

// --- auto-save ------------------------------------------------------------------

const autosave = new AutoSave({
  docs: () => tabs.map((t) => t.doc),
  busy: () => editor.text.active || editor.gesturing || isModalOpen(),
  write: async (target) => {
    const at = target.version();
    const { exportPdf } = await import('./exporter');
    const { bytes } = await exportPdf(target);
    await api.save(target.path!, bytes);
    target.markSaved(target.name, target.path, at);
  },
  changed: () => updateSaveState(),
});

const SAVE_LABELS: Record<SaveState, [string, string]> = {
  saved: ['check', msg('Saved')],
  saving: ['refresh-cw', msg('Saving…')],
  unsaved: ['circle', msg('Not saved')],
  off: ['circle', msg('Not saved')],
  new: ['circle', msg('Not saved yet')],
  error: ['info', msg('Couldn’t auto-save')],
};

function updateSaveState() {
  const el = $('#save-state');
  if (!doc) {
    el.replaceChildren();
    return;
  }
  const state = autosave.state(doc);
  const [iconName, label] = SAVE_LABELS[state];
  el.dataset.state = state;
  el.title = state === 'error' ? t('Auto-save failed: {message}', { message: autosave.error(doc) ?? '' })
    : state === 'new' ? (isMobile() ? t('Save this document once and Inkleaf will keep saving it for you') : t('Save this document once (Ctrl+S) and Inkleaf will keep saving it for you'))
      : doc.wasProtected && autosave.enabled ? t('Auto-save is paused for protected PDFs: saving would remove the protection')
        : autosave.enabled ? t('Changes are saved automatically') : t('Auto-save is off');
  el.replaceChildren(icon(iconName), h('span', {}, t(label)));
}

/** Offers back unsaved work from a session that didn't close normally. */
async function offerRecovery() {
  const found = await api.recoveries().catch(() => []);
  if (!found.length) return;
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const choice = await modal({
    title: t('Restore unsaved work?'),
    body: h('div', {},
      h('p', { class: 'modal-text' }, t('Inkleaf didn’t close properly last time. These documents had changes that weren’t saved:')),
      h('ul', { class: 'recover-list' }, ...found.map((r) => h('li', {}, h('strong', {}, r.name), h('span', {}, ` · ${when(r.savedAt)}`)))),
    ),
    buttons: [{ label: t('Discard'), value: 'discard', danger: true }, { label: t('Restore'), value: 'restore', primary: true }],
    dismissValue: 'later',
  });
  if (choice === 'later') return;
  for (const r of found) {
    if (choice === 'restore') {
      try {
        const bytes = await api.readRecovery(r.id);
        // reopened as a new document, so nothing overwrites the original
        // until you choose where to save it
        const restored = await EditorDoc.open(bytes, r.name.replace(/(\.pdf)?$/i, ' (recovered).pdf'), null);
        addTab(restored);
      } catch (err) {
        toast(t('Couldn’t restore “{name}”: {message}', { name: r.name, message: (err as Error).message }), 'error', 7000);
        continue;
      }
    }
    api.clearRecovery(r.id);
  }
}

const toolHost: ToolHost = {
  withBusy,
  progress,
  openBytes: async (bytes, name) => {
    addTab(await EditorDoc.open(bytes, name, null));
  },
  currentPageId: () => viewer.currentPageId,
};

function showError(title: string, err: unknown) {
  console.error(err);
  modal({ title, body: (err as Error)?.message ?? String(err) });
}

// --- reacting to edits -------------------------------------------------------------

let redrawQueued = new Set<string>();
let redrawFrame = 0;

function onDocChange(event: Event) {
  if (event.target !== doc) return; // a background tab
  const { kind, pageIds } = (event as CustomEvent<ChangeDetail>).detail;
  if (kind === 'pages' || kind === 'all') {
    viewer.syncPages();
    thumbs.sync();
    viewer.redraw();
    inspector.render();
  }
  if (kind === 'annots' || kind === 'all') {
    for (const id of pageIds ?? []) redrawQueued.add(id);
    cancelAnimationFrame(redrawFrame);
    redrawFrame = requestAnimationFrame(() => {
      viewer.redraw([...redrawQueued]);
      redrawQueued = new Set();
    });
    thumbs.schedule();
  }
  if (kind === 'forms' || kind === 'all') forms.sync();
  if (kind === 'decor' || kind === 'all') {
    viewer.redraw();
    thumbs.schedule();
  }
  if (kind === 'outline' || kind === 'pages' || kind === 'all') {
    if (sidePane === 'bookmarks') bookmarks.render();
  }
  if (kind === 'annots' || kind === 'pages' || kind === 'all') sideBadges();

  // undo can remove the thing that was selected
  if (editor.selection && !editor.selectedAnnot()) editor.select(null);
}

function updateChrome() {
  $('#app').classList.toggle('no-doc', !doc);
  $<HTMLButtonElement>('[data-command="undo"]').disabled = !doc?.canUndo;
  $<HTMLButtonElement>('[data-command="redo"]').disabled = !doc?.canRedo;
  $('#zoom-label').textContent = `${Math.round(viewer.scale * 100)}%`;
  $('#sidebar-count').textContent = doc ? String(doc.pages.length) : '';
  updateSaveState();
  updatePager();
  renderTabs();
  const dirtyTabs = tabs.filter((t) => t.doc.dirty);
  api.setDocumentState({
    title: doc?.name ?? '',
    dirty: !!doc?.dirty,
    path: doc?.path ?? null,
    dirtyCount: dirtyTabs.length,
    dirtyName: dirtyTabs[0]?.doc.name ?? '',
  });
  engine?.notify();
}

function updatePager() {
  const input = $<HTMLInputElement>('#page-input');
  const total = doc?.pages.length ?? 0;
  const index = doc && viewer.currentPageId ? doc.pageIndex(viewer.currentPageId) : -1;
  if (document.activeElement !== input) input.value = index >= 0 ? String(index + 1) : '';
  $('#page-count').textContent = t('of {total}', { total });
}

// --- tab management -------------------------------------------------------------

function renderTabs() {
  const strip = $('#tabs');
  strip.replaceChildren(...tabs.map((tab) => {
    const close = h('button', { class: 'tab-close', title: t('Close tab'), 'aria-label': t('Close {name}', { name: tab.doc.name }) }, icon('x'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    const el = h('div', {
      class: `tab${tab === activeTab ? ' active' : ''}${tab.doc.dirty ? ' dirty' : ''}`,
      role: 'tab',
      tabindex: '0',
      title: tab.doc.path ?? tab.doc.name,
      'aria-selected': String(tab === activeTab),
    },
    icon('file-text'),
    h('span', { class: 'tab-name' }, tab.doc.name.replace(/\.pdf$/i, '')),
    h('span', { class: 'tab-dot', 'aria-hidden': 'true' }),
    close);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab);
      }
    });
    el.addEventListener('click', () => activate(tab));
    el.addEventListener('keydown', (e) => e.key === 'Enter' && activate(tab));
    return el;
  }));
}

function activate(tab: Tab | null) {
  if (tab === activeTab && tab) return;
  if (editor.text.active) editor.text.finish();
  editor.select(null);
  editor.cancelPlacement();

  // remember where we were in the tab we're leaving
  if (activeTab) {
    activeTab.scale = viewer.scale;
    activeTab.scrollTop = viewer.container.scrollTop;
    activeTab.scrollLeft = viewer.container.scrollLeft;
  }

  activeTab = tab;
  doc = tab?.doc ?? null;
  // each document has its own enhancement (or none)
  closeEnhance();
  enhanced.reset((doc && enhanceFor.get(doc)) ?? NEUTRAL);
  updateEnhanceButton();
  // show the viewer before laying pages out, so positions can be measured
  $('#app').classList.toggle('no-doc', !doc);
  forms.reset();
  thumbs.selected.clear();
  viewer.setDoc(doc);
  thumbs.sync();

  if (tab) {
    editor.setTool('select');
    if (tab.scale === null) {
      // first visit: fit the width, but don't blow small pages up to poster size
      requestAnimationFrame(() => {
        viewer.fitWidth();
        if (viewer.scale > 1.25) viewer.setScale(1.25);
        viewer.container.scrollTop = 0;
        viewer.updateCurrentPage();
        updateChrome();
      });
    } else {
      viewer.scale = tab.scale;
      viewer.layout();
      viewer.container.scrollTop = tab.scrollTop;
      viewer.container.scrollLeft = tab.scrollLeft;
      viewer.updateCurrentPage();
    }
  } else {
    renderWelcome();
  }
  inspector.render();
  textToolbar.update();
  findBar.reset();
  renderSide();
  updateChrome();
}

function addTab(next: EditorDoc) {
  next.addEventListener('change', onDocChange);
  next.addEventListener('history', () => {
    autosave.schedule(next);
    updateChrome();
    if (next === doc) {
      inspector.render();
      textToolbar.update(); // undo can bring back or take away a text box
    }
  });
  const tab: Tab = { id: newId('t'), doc: next, scale: null, scrollTop: 0, scrollLeft: 0 };
  const at = activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length;
  tabs.splice(at, 0, tab);
  activate(tab);
  return tab;
}

async function closeTab(tab: Tab): Promise<boolean> {
  if (tab.doc.dirty) {
    if (tab !== activeTab) activate(tab);
    const choice = await modal({
      title: t('Save changes to “{name}”?', { name: tab.doc.name }),
      body: t('Your changes will be lost if you don’t save them.'),
      buttons: [
        { label: t('Cancel'), value: 'cancel' },
        { label: t('Don’t save'), value: 'discard' },
        { label: t('Save'), value: 'save', primary: true },
      ],
    });
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await save())) return false;
  }
  const index = tabs.indexOf(tab);
  if (index < 0) return true;
  tabs.splice(index, 1);
  autosave.forget(tab.doc);
  if (tab === activeTab) {
    activeTab = null;
    activate(tabs[Math.min(index, tabs.length - 1)] ?? null);
  } else {
    updateChrome();
  }
  tab.doc.destroy();
  return true;
}

function cycleTab(step: 1 | -1) {
  if (tabs.length < 2 || !activeTab) return;
  const i = tabs.indexOf(activeTab);
  activate(tabs[(i + step + tabs.length) % tabs.length]);
}

// --- opening & saving ------------------------------------------------------------

/** Stores a small picture of page one for the welcome screen. */
async function rememberThumbnail(opened: EditorDoc) {
  if (!opened.path) return;
  try {
    const page = await opened.sources.get(opened.mainSource)!.pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 220 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    api.setRecentThumb(opened.path, canvas.toDataURL('image/jpeg', 0.72));
  } catch {
    // a missing thumbnail just shows a plain card
  }
}

async function openFile(file: OpenedFile) {
  const existing = file.path ? tabs.find((t) => t.doc.path === file.path) : null;
  if (existing) {
    activate(existing);
    return;
  }
  if (!/\.pdf$/i.test(file.name)) {
    // a Word file, spreadsheet, picture…: turn it into a PDF first
    await convertFiles([file]);
    return;
  }
  try {
    const opened = await withBusy(t('Opening…'), async () => {
      return withUnlocked(file.data, file.name, async (bytes, wasProtected) => {
        const next = await EditorDoc.open(bytes, file.name, file.path);
        next.wasProtected = wasProtected;
        return next;
      });
    });
    if (!opened) return;
    addTab(opened);
    rememberThumbnail(opened);
    // comments already in the file become editable notes
    opened.adoptExistingNotes().then(() => {
      if (opened === doc) renderSide();
    }).catch(() => {});
    if (opened.wasProtected) {
      toast(t('This PDF was protected. Inkleaf will save it without the protection.'), 'info', 8000);
    }
    if (await forms.hasFields()) toast(t('This PDF has form fields. Click a field to fill it in.'), 'info');
  } catch (err) {
    console.error(err);
    const choice = await modal({
      title: t('Couldn’t open this PDF'),
      body: t('“{name}” looks damaged. Inkleaf can try to repair it into a new copy; the original isn’t touched.', { name: file.name }),
      buttons: [{ label: t('Close'), value: 'cancel' }, { label: t('Try to repair'), value: 'repair', primary: true }],
    });
    if (choice === 'repair') await tool(t('Couldn’t repair the PDF'), () => repairFile(file));
  }
}

async function newBlank() {
  const bytes = await blankPdf(595.28, 841.89);
  const untitled = tabs.filter((t) => /^Untitled( \d+)?\.pdf$/.test(t.doc.name)).length;
  addTab(await EditorDoc.open(bytes, untitled ? `Untitled ${untitled + 1}.pdf` : 'Untitled.pdf', null));
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Saves the active document. Resolves true if it ended up on disk. */
async function save(saveAs = false): Promise<boolean> {
  if (!doc) return false;
  if (editor.text.active) editor.text.finish();
  const current = doc;
  const at = current.version();
  try {
    const { bytes, warnings } = await withBusy(t('Saving…'), () => exportPdf(current));
    let path = current.path;
    if (!saveAs && path) {
      await withBusy(t('Saving…'), () => api.save(path!, bytes));
    } else {
      path = await api.saveAs(bytes, current.name);
      if (!path) return false;
    }
    current.markSaved(fileName(path), path, at);
    autosave.forget(current);
    rememberThumbnail(current);
    toast(t('Saved “{name}”', { name: current.name }), 'success', 2600);
    await showWarnings(warnings);
    return true;
  } catch (err) {
    showError(t('Couldn’t save'), err);
    return false;
  }
}

/** Closing the window: save every tab with changes, one by one. */
async function saveAllBeforeClose(): Promise<boolean> {
  await autosave.flush();
  for (const tab of tabs.filter((t) => t.doc.dirty)) {
    activate(tab);
    if (!(await save())) return false;
  }
  return true;
}

// --- signatures & images ---------------------------------------------------------

// --- enhancing pages ---------------------------------------------------------------------------

const enhanced = new EnhancedView(viewer);
/** Each open document keeps its own enhancement. */
const enhanceFor = new WeakMap<EditorDoc, Enhance>();
let enhanceOpen: HTMLElement | null = null;

function updateEnhanceButton() {
  const button = document.getElementById('enhance-toggle');
  button?.setAttribute('aria-pressed', String(enhanced.active || !!enhanceOpen));
}

function closeEnhance() {
  enhanceOpen?.remove();
  enhanceOpen = null;
  updateEnhanceButton();
}

function toggleEnhance() {
  if (enhanceOpen) return closeEnhance();
  const target = doc!;
  enhanceOpen = enhancePanel({
    view: enhanced,
    remember: (s) => {
      if (isNeutral(s)) enhanceFor.delete(target);
      else enhanceFor.set(target, s);
      updateEnhanceButton();
    },
    saveCopy: (s) => void saveEnhancedCopy(target, s),
    close: closeEnhance,
  });
  $('#workspace').append(enhanceOpen);
  updateEnhanceButton();
  enhanceOpen.querySelector<HTMLElement>('.chip')?.focus();
}

/** Bakes the enhancement into a new PDF, in a new tab; the original stays as it was. */
async function saveEnhancedCopy(source: EditorDoc, s: Enhance) {
  await tool(t('Couldn’t enhance this PDF'), async () => {
    const bytes = await withBusy(t('Enhancing pages…'), async () => {
      const { bytes: current } = await exportPdf(source);
      return enhancedCopy(current, s, (done, total) => progress(t('Enhancing page {page} of {total}…', { page: Math.min(done + 1, total), total })));
    });
    const name = `${source.name.replace(/\.pdf$/i, '')} (enhanced).pdf`;
    const opened = await EditorDoc.open(bytes, name, null);
    opened.markUnsaved();
    closeEnhance();
    addTab(opened);
    const ocr = await confirmDialog(
      t('Enhanced copy ready'),
      t('Its pages are now pictures, so their text can’t be searched or copied yet. Recognise the text now?'),
      t('Recognise text'),
    );
    if (ocr) await tool(t('Text recognition didn’t work'), () => runOcr(opened));
  });
}

async function startSign() {
  editor.setTool('select');
  const picked = await signMenu(api.engine ? engineAnchor() : $('#rail [data-tool="sign"]'));
  if (!picked || !doc) return;
  const asset = await doc.addAsset(picked.dataUrl);
  editor.startPlacement({ assetId: asset.id, width: picked.kind === 'initials' ? 60 : 150, then: 'sign' });
}

async function startImage() {
  editor.setTool('select');
  const dataUrl = await pickImage();
  if (!dataUrl || !doc) return;
  const asset = await doc.addAsset(dataUrl);
  const page = viewer.currentPageId ? doc.page(viewer.currentPageId) : doc.pages[0];
  const pageWidth = page ? doc.displaySize(page).width : 595;
  // treat the image as 96 dpi, but never wider than half the page
  const width = Math.min((asset.width * 72) / 96, pageWidth * 0.5);
  editor.startPlacement({ assetId: asset.id, width, then: 'image' });
}

forms.addEventListener('sign-field', async (event) => {
  const { pageId, rect } = (event as CustomEvent<SignFieldRequest>).detail;
  const dataUrl = await chooseSignature();
  if (!dataUrl || !doc) return;
  const asset = await doc.addAsset(dataUrl);
  const page = doc.page(pageId)!;
  const angle = doc.displayRotation(page);
  const sideways = angle % 180 !== 0;
  // fit the signature inside the field, keeping its proportions
  const ratio = asset.width / asset.height;
  const fieldW = sideways ? rect.h : rect.w, fieldH = sideways ? rect.w : rect.h;
  let lw = fieldW * 0.95, lh = lw / ratio;
  if (lh > fieldH * 0.9) {
    lh = fieldH * 0.9;
    lw = lh * ratio;
  }
  const w = sideways ? lh : lw, h = sideways ? lw : lh;
  const annot: ImageAnnot = {
    id: newId('img'), type: 'image', angle, asset: asset.id,
    x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h,
  };
  doc.addAnnot(pageId, annot);
  doc.commit();
  editor.setTool('select');
  editor.select({ pageId, id: annot.id });
});

// --- page commands -----------------------------------------------------------------

async function deletePages(ids: string[]) {
  if (!doc || !ids.length) return;
  if (ids.length >= doc.pages.length) {
    toast(t('A PDF needs at least one page.'), 'error');
    return;
  }
  if (ids.length > 1 && !(await confirmDialog(t('{count, plural, one {Delete # page?} other {Delete # pages?}}', { count: ids.length }), isMobile() ? t('You can undo this.') : t('You can undo this with Ctrl+Z.'), t('Delete'), true))) return;
  const first = doc.pageIndex(ids[0]) + 1;
  doc.deletePages(ids);
  thumbs.selected.clear();
  toast(ids.length === 1 ? (isMobile() ? t('Deleted page {page}. Tap Undo to bring it back.', { page: first }) : t('Deleted page {page}. Press Ctrl+Z to undo.', { page: first })) : t('{count, plural, one {Deleted # page.} other {Deleted # pages.}}', { count: ids.length }));
}

thumbs.addEventListener('delete', (e) => deletePages((e as CustomEvent<string[]>).detail));
thumbs.addEventListener('insert-files', async (e) => {
  const { files, index } = (e as CustomEvent<{ files: File[]; index: number }>).detail;
  if (!doc) return;
  const picked = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  await withBusy(t('Inserting pages…'), () => insertPdfFiles(doc!, picked, index));
});
thumbs.addEventListener('move', async (e) => {
  const { ids, index } = (e as CustomEvent<{ ids: string[]; index: number }>).detail;
  doc?.movePages(ids, index);
});

function afterCurrentIndex() {
  if (!doc) return 0;
  const id = viewer.currentPageId;
  return id ? doc.pageIndex(id) + 1 : doc.pages.length;
}

// --- commands ------------------------------------------------------------------------

function isTyping() {
  const el = document.activeElement;
  return !!el?.closest('input, textarea, select, [contenteditable="true"]');
}

type Command = AppCommand | 'prev-page' | 'next-page';

const NO_DOC_NEEDED = new Set<Command>([
  'new', 'open', 'about', 'shortcuts', 'close', 'close-tab', 'new-window', 'quit', 'fullscreen', 'devtools',
  'theme-system', 'theme-light', 'theme-dark', 'images-to-pdf', 'convert-to-pdf', 'check-updates', 'toggle-autosave', 'open-backups', 'open-github', 'report-problem', 'donate',
  'web-to-pdf', 'scan-to-pdf', 'repair', 'unlock', 'ai-settings', 'all-tools', 'language', 'terms', 'privacy', 'link-pair',
]);

/** Runs one of the bigger tools, turning failures into a readable dialog. */
async function tool(title: string, work: () => Promise<unknown>) {
  if (editor.text.active) editor.text.finish();
  try {
    await work();
  } catch (err) {
    showError(title, err);
  }
}

async function run(command: Command) {
  closeMenu();
  if (!supports(command)) return;
  if (isModalOpen() && !['undo', 'redo', 'copy', 'cut', 'paste'].includes(command)) return;
  if (!NO_DOC_NEEDED.has(command) && !doc) return;

  switch (command) {
    case 'new': return newBlank();
    case 'open': {
      const file = await api.openDialog().catch((err) => (showError(t('Couldn’t open this file'), err), null));
      if (file) await openFile(file);
      return;
    }
    case 'save': return void save();
    case 'save-as': return void save(true);
    case 'close':
    case 'close-tab':
      if (activeTab) await closeTab(activeTab);
      else window.close();
      return;
    case 'next-tab': return cycleTab(1);
    case 'prev-tab': return cycleTab(-1);

    case 'new-window':
    case 'quit':
    case 'fullscreen':
    case 'devtools':
      return api.windowCommand(command);
    case 'theme-system':
    case 'theme-light':
    case 'theme-dark':
      currentTheme = command.slice(6) as 'system' | 'light' | 'dark';
      api.setTheme(currentTheme);
      return;

    case 'undo':
    case 'redo':
      if (isTyping()) return api.nativeEdit(command);
      if (editor.text.active) editor.text.finish();
      return command === 'undo' ? doc!.undo() : doc!.redo();
    case 'copy':
    case 'cut':
    case 'paste':
      if (isTyping() || isModalOpen()) return api.nativeEdit(command);
      if (command === 'paste') editor.paste();
      else editor.copySelected(command === 'cut');
      return;
    case 'delete':
      if (isTyping()) return;
      if (!editor.deleteSelected() && thumbs.selected.size) deletePages(thumbs.chosenPages());
      return;
    case 'duplicate': return void editor.duplicateSelected();
    case 'select-all-pages': return thumbs.selectAll();

    case 'zoom-in': return viewer.setScale(nextZoom(1));
    case 'zoom-out': return viewer.setScale(nextZoom(-1));
    case 'zoom-reset': return viewer.setScale(1);
    case 'zoom-fit-width': return viewer.fitWidth();
    case 'zoom-fit-page': return viewer.fitPage();
    case 'toggle-sidebar':
    case 'toggle-inspector': {
      const cls = command === 'toggle-sidebar' ? 'sidebar-hidden' : 'inspector-hidden';
      const hidden = $('#app').classList.toggle(cls);
      if (isMobile()) {
        // on a phone the panels are drawers over the page: one at a time
        if (!hidden) $('#app').classList.add(cls === 'sidebar-hidden' ? 'inspector-hidden' : 'sidebar-hidden');
      } else {
        try { localStorage.setItem(`inkleaf.${cls}`, hidden ? '1' : ''); } catch { /* fine */ }
      }
      updatePanelButtons();
      viewer.layout();
      return;
    }

    case 'insert-pdf': {
      const files = await api.pickPdfs();
      if (files.length) await withBusy(t('Inserting pages…'), () => insertPdfFiles(doc!, files, afterCurrentIndex()));
      return;
    }
    case 'insert-blank': {
      const page = await insertBlankPage(doc!, viewer.currentPageId);
      viewer.scrollToPage(page.id);
      return;
    }
    case 'extract':
      return extractPages(doc!, thumbs.chosenPages()).catch((err) => showError(t('Couldn’t extract pages'), err));
    case 'split':
      return splitDocument(doc!).catch((err) => showError(t('Couldn’t split the document'), err));
    case 'rotate-left': return doc!.rotatePages(thumbs.chosenPages(), -90);
    case 'rotate-right': return doc!.rotatePages(thumbs.chosenPages(), 90);
    case 'delete-pages': return deletePages(thumbs.chosenPages());

    case 'prev-page':
    case 'next-page': {
      const index = viewer.currentPageId ? doc!.pageIndex(viewer.currentPageId) : 0;
      const target = doc!.pages[index + (command === 'next-page' ? 1 : -1)];
      if (target) viewer.scrollToPage(target.id);
      return;
    }

    case 'find': return findBar.open(window.getSelection()?.toString().trim() || undefined);
    case 'print': {
      if (editor.text.active) editor.text.finish();
      try {
        await withBusy(t('Preparing to print…'), () => printDocument(doc!, (done, total) => progress(t('Preparing page {page} of {total} for printing…', { page: Math.min(done + 1, total), total }))));
      } catch (err) {
        showError(t('Couldn’t print'), err);
      }
      return;
    }
    case 'enhance': return toggleEnhance();
    case 'compress': return tool(t('Couldn’t compress this PDF'), () => compressDialog(doc!, toolHost));
    case 'protect': return tool(t('Couldn’t protect this PDF'), () => protectDialog(doc!, toolHost));
    case 'decor': return tool(t('Couldn’t add that'), () => decorDialog(doc!));
    case 'remove-decor': return doc!.setDecor(NO_DECOR);
    case 'images-to-pdf': return tool(t('Couldn’t make a PDF from those pictures'), () => imagesToPdf(toolHost));
    case 'convert-to-pdf': {
      const files = await api.pickConvertible();
      if (files.length) await convertFiles(files);
      return;
    }
    case 'convert-from-pdf': return tool(t('Couldn’t convert this PDF'), () => convertFromPdf(doc!));
    case 'web-to-pdf': return tool(t('Couldn’t make a PDF of that page'), webToPdf);
    case 'scan-to-pdf': return tool(t('Couldn’t make the scan'), scanToPdf);
    case 'repair': return tool(t('Couldn’t repair the PDF'), () => repairFile());
    case 'unlock': return tool(t('Couldn’t unlock the PDF'), unlockFile);
    case 'pdf-to-pdfa': return tool(t('Couldn’t make a PDF/A'), () => saveAsPdfA(doc!));
    case 'ai-settings': return tool(t('Couldn’t change the AI settings'), async () => void (await aiTools()).aiSettings());
    case 'ai-summarize': return tool(t('Couldn’t summarize this PDF'), async () => (await aiTools()).summarize(doc!, aiHost));
    case 'ai-translate': return tool(t('Couldn’t translate this PDF'), async () => (await aiTools()).translate(doc!, aiHost));
    case 'all-tools': return tool(t('Something went wrong'), openAllTools);
    case 'link-pair': return tool(t('Couldn’t connect'), async () => (await import('./link-ui')).linkDialog());
    case 'link-send': {
      const current = doc!;
      if (editor.text.active) editor.text.finish();
      return tool(isMobile() ? t('Couldn’t send it to the computer') : t('Couldn’t send it to the phone'), async () =>
        (await import('./link-ui')).sendToDevice(current.name, async () => (await withBusy(t('Making PDF…'), () => exportPdf(current))).bytes));
    }
    case 'share': {
      const current = doc!;
      if (editor.text.active) editor.text.finish();
      return tool(t('Couldn’t share it'), async () => {
        const { bytes } = await withBusy(t('Making PDF…'), () => exportPdf(current));
        await api.shareFile?.(bytes, current.name);
      });
    }
    case 'language': return tool(t('Couldn’t change the language'), chooseLanguage);
    case 'terms': return tool(t('Couldn’t show the terms'), () => showLegal('terms'));
    case 'privacy': return tool(t('Couldn’t show the privacy policy'), () => showLegal('privacy'));
    case 'pdf-to-images': return tool(t('Couldn’t export the pages'), () => pdfToImages(doc!, toolHost));
    case 'pdf-to-word': return tool(t('Couldn’t export to Word'), () => exportWord(doc!));
    case 'ocr': return tool(t('Text recognition didn’t work'), () => runOcr(doc!));
    case 'compare': return tool(t('Couldn’t compare'), () => compareWith(doc!));
    case 'form-builder': return editor.setTool('field');
    case 'crop': return editor.setTool('crop');
    case 'uncrop-page':
      if (viewer.currentPageId) doc!.setCrop([viewer.currentPageId], null);
      return;
    case 'uncrop-all': return doc!.setCrop(doc!.pages.map((p) => p.id), null);
    case 'mode-continuous':
    case 'mode-spread':
    case 'mode-single': {
      const mode = command.slice(5) as ReadingMode;
      viewer.setMode(mode);
      try { localStorage.setItem('inkleaf.mode', mode); } catch { /* fine */ }
      return;
    }
    case 'toggle-autosave':
      autosave.setEnabled(!autosave.enabled);
      toast(autosave.enabled ? t('Auto-save is on. Documents you’ve saved before are kept saved as you work.') : (isMobile() ? t('Auto-save is off. Save with the save button.') : t('Auto-save is off. Save with Ctrl+S.')), 'info', 4500);
      return;
    case 'open-backups': return api.openBackups();
    case 'open-github': return api.openExternal(REPO_URL);
    case 'report-problem': return api.openExternal(ISSUES_URL);
    case 'donate': return api.openExternal(DONATE_URL || REPO_URL);
    case 'show-comments': return showSide('comments');
    case 'show-bookmarks': return showSide('bookmarks');
    case 'check-updates': return api.checkForUpdates();

    case 'shortcuts': return showShortcuts();
    case 'about': return showAbout();
  }
}

// --- the bigger tools --------------------------------------------------------------------

/** Converts files to PDF and opens each as a new tab. */
async function convertFiles(files: { name: string; data: Uint8Array }[]) {
  const { convertToPdf } = await import('./to-pdf');
  const notes = new Set<string>();
  for (const file of files) {
    try {
      const result = await withBusy(t('Converting “{name}”…', { name: file.name }), () => convertToPdf(file, progress));
      result.notes.forEach((n) => notes.add(n));
      const opened = await EditorDoc.open(result.bytes, file.name.replace(/\.[^.]+$/, '.pdf'), null);
      // it only exists in Inkleaf so far: closing should offer to save it
      opened.markUnsaved();
      addTab(opened);
    } catch (err) {
      showError(t('Couldn’t convert “{name}”', { name: file.name }), err);
    }
  }
  if (notes.size) toast([...notes].join(' '), 'info', 9000);
}

type ExportFormat = 'docx' | 'xlsx' | 'pptx' | 'images' | 'pdfa' | 'txt' | 'md' | 'html';

/** "Convert PDF to…": pick a format, then convert the open document (with its edits). */
async function convertFromPdf(target: EditorDoc, initial: ExportFormat = 'docx') {
  const formats: { value: ExportFormat; title: string; detail: string; icon: string }[] = [
    { value: 'docx', title: t('Word'), detail: t('Editable text with headings, paragraphs and pictures.'), icon: 'file-text' },
    { value: 'xlsx', title: t('Excel'), detail: t('Tables become rows and columns, one sheet per page. Numbers stay numbers.'), icon: 'table' },
    { value: 'pptx', title: t('PowerPoint'), detail: t('One slide per page, exactly as it looks. Page text goes in the notes.'), icon: 'presentation' },
    { value: 'images', title: t('Pictures'), detail: t('Each page as a PNG or JPEG.'), icon: 'file-image' },
    { value: 'pdfa', title: t('PDF/A'), detail: t('The archiving standard: fonts built in, nothing that can stop it opening in years to come.'), icon: 'archive' },
    { value: 'txt', title: t('Plain text'), detail: t('Just the words, for pasting anywhere.'), icon: 'type' },
    { value: 'md', title: t('Markdown'), detail: t('Text with headings, bold and italic, for notes apps and websites.'), icon: 'hash' },
    { value: 'html', title: t('Web page'), detail: t('A single HTML file that opens in any browser.'), icon: 'globe' },
  ];
  let chosen = initial;
  const list = h('div', { class: 'format-grid', role: 'radiogroup' }, ...formats.map((f) => {
    const input = h('input', { type: 'radio', name: 'format', value: f.value, checked: f.value === chosen });
    input.addEventListener('change', () => (chosen = f.value));
    return h('label', { class: 'format-card' }, input, icon(f.icon), h('span', {}, h('strong', {}, f.title), h('span', {}, f.detail)));
  }));
  const go = await modal({
    title: t('Convert PDF to…'),
    wide: true,
    body: h('div', {}, h('p', { class: 'modal-text' }, t('Makes a new file from this document, including your edits. The PDF itself isn’t changed.')), list),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Convert…'), value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;
  if (chosen === 'images') return pdfToImages(target, toolHost);
  if (chosen === 'docx') return exportWord(target);
  if (chosen === 'pdfa') return saveAsPdfA(target);

  const base = target.name.replace(/\.pdf$/i, '');
  const saved: Record<string, string> = {
    xlsx: t('Saved the Excel workbook.'), pptx: t('Saved the PowerPoint presentation.'), txt: t('Saved the text file.'),
    md: t('Saved the Markdown file.'), html: t('Saved the web page.'),
  };
  const bytes = await withBusy(t('Reading the document…'), async () => {
    const [formats, { exportPdf }, { loadPdf }] = await Promise.all([import('./export-formats'), import('./exporter'), import('./pdf')]);
    const pdf = await loadPdf((await exportPdf(target)).bytes);
    const step = (n: number, total: number) => progress(t('Converting page {n} of {total}…', { n, total }));
    try {
      const text = (s: string) => new TextEncoder().encode(s);
      switch (chosen) {
        // awaited here, so the PDF isn't closed (below) while still being read
        case 'xlsx': return await formats.pdfToExcel(pdf, step);
        case 'pptx': return await formats.pdfToPowerPoint(pdf, base, step);
        case 'txt': return text(await formats.pdfToText(pdf, step));
        case 'md': return text(await formats.pdfToMarkdown(pdf, step));
        default: return text(await formats.pdfToHtml(pdf, base, step));
      }
    } finally {
      pdf.loadingTask.destroy();
    }
  });
  const path = await api.saveCopy(bytes, `${base}.${chosen}`, chosen as Exclude<ExportFormat, 'images' | 'pdfa'>);
  if (path) toast(saved[chosen], 'success');
}

/** The PDF/A-2b archiving format. */
async function saveAsPdfA(target: EditorDoc) {
  const result = await withBusy(t('Making a PDF/A…'), async () => {
    const [{ toPdfA }] = await Promise.all([import('./pdfa')]);
    const { bytes } = await exportPdf(target);
    return toPdfA(bytes, target.name.replace(/\.pdf$/i, ''));
  });
  const path = await api.saveCopy(result.bytes, `${target.name.replace(/\.pdf$/i, '')} (PDF-A).pdf`, 'pdf');
  if (!path) return;
  if (result.warnings.length) {
    await modal({
      title: t('Saved as PDF/A, with notes'),
      body: h('div', {}, h('p', { class: 'modal-text' }, t('The file was saved. A few things in it may not meet the standard strictly:')),
        h('ul', { class: 'modal-list' }, ...result.warnings.map((w) => h('li', {}, w)))),
    });
  } else {
    toast(result.fontsEmbedded
      ? t('{count, plural, one {Saved as PDF/A, with # font built in.} other {Saved as PDF/A, with # fonts built in.}}', { count: result.fontsEmbedded })
      : t('Saved as PDF/A.'), 'success');
  }
}

async function webToPdf() {
  const address = h('input', { class: 'field-input', type: 'url', placeholder: 'https://example.com/page', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const error = h('p', { class: 'field-error' });
  const choice = await modal({
    title: t('Web page to PDF'),
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Web address')), address,
        h('span', { class: 'field-hint' }, t('The page loads privately, without your logins or cookies, and is printed onto A4 pages.'))),
      error,
      h('p', { class: 'field-hint' }, t('Have an .html file instead? Use Convert to PDF.'))),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Make PDF'), value: 'ok', primary: true }],
    validate: (value) => {
      if (value !== 'ok') return true;
      if (!address.value.trim()) {
        error.textContent = t('Type or paste a web address.');
        return false;
      }
      return true;
    },
  });
  if (choice !== 'ok') return;
  const { pdf, title } = await withBusy(t('Loading the page…'), () => api.urlToPdf(address.value.trim()));
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || t('Web page');
  const opened = await EditorDoc.open(pdf, `${safe}.pdf`, null);
  opened.markUnsaved();
  addTab(opened);
}

async function scanToPdf() {
  const { scanDialog } = await import('./scan');
  const scanned = await scanDialog();
  if (!scanned) return;
  const bytes = await withBusy(t('Making the PDF…'), () => scanned.make(progress));
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  const opened = await EditorDoc.open(bytes, `Scan ${stamp}.pdf`, null);
  opened.markUnsaved();
  addTab(opened);
  if (scanned.ocr) await tool(t('Text recognition didn’t work'), () => runOcr(opened));
}

const REPAIR_NOTES: Record<'rebuilt' | 'reread' | 'redrawn', string> = {
  rebuilt: msg('Repaired. The file’s index was rebuilt, and everything in it was kept.'),
  reread: msg('Repaired. Inkleaf read back everything it could; give the pages a quick check.'),
  redrawn: msg('Repaired by redrawing each page. The text can’t be selected any more: run Recognise Text (OCR) to bring that back.'),
};

/** Repairs a damaged PDF (picked now, or one that just failed to open) into a new tab. */
async function repairFile(file?: { name: string; data: Uint8Array }) {
  if (!file) {
    [file] = await api.pickPdfs(t('Choose a damaged PDF to repair'));
    if (!file) return;
  }
  const { repairPdf } = await import('./repair');
  const result = await withBusy(t('Repairing…'), () => repairPdf(file!.data, progress));
  const opened = await EditorDoc.open(result.bytes, file.name.replace(/(\.pdf)?$/i, ' (repaired).pdf'), null);
  opened.markUnsaved();
  addTab(opened);
  toast(`${t(REPAIR_NOTES[result.method])} ${t('{count, plural, one {# page recovered.} other {# pages recovered.}}', { count: result.pages })}`, 'success', 9000);
}

/** Saves a copy of a password-protected PDF without its password. */
async function unlockFile() {
  const [file] = await api.pickPdfs(t('Choose a protected PDF to unlock'));
  if (!file) return;
  const done = await withUnlocked(file.data, file.name, async (bytes, wasProtected) => {
    if (!wasProtected) {
      await modal({ title: t('Nothing to unlock'), body: t('“{name}” doesn’t have a password or any restrictions.', { name: file.name }) });
      return 'none' as const;
    }
    const opened = await EditorDoc.open(bytes, file.name, null);
    const { bytes: plain } = await withBusy(t('Unlocking…'), () => exportPdf(opened));
    opened.destroy();
    const path = await api.saveCopy(plain, file.name.replace(/(\.pdf)?$/i, ' (unlocked).pdf'), 'pdf');
    return path ? ('saved' as const) : ('none' as const);
  });
  if (done === 'saved') toast(t('Saved an unlocked copy. The original still has its password.'), 'success');
}

let aiModule: Promise<typeof import('./ai-tools')> | null = null;
const aiTools = () => (aiModule ??= import('./ai-tools'));
const aiHost = {
  withBusy,
  progress,
  openDoc: (opened: EditorDoc) => addTab(opened),
  currentPageId: () => viewer.currentPageId,
};

// --- terms and privacy ---------------------------------------------------------------------

/** The interface language: the computer's, or one picked from the list. */
async function chooseLanguage() {
  const [{ UI_LANGUAGES }, { LANGUAGES }] = await Promise.all([import('../shared/i18n'), import('../shared/languages')]);
  const current = await api.languageChoice();
  let chosen = current;
  const option = (value: string, title: string, sub?: string, lang?: string) => {
    const input = h('input', { type: 'radio', name: 'ui-language', value, checked: value === current });
    input.addEventListener('change', () => (chosen = value));
    return h('label', { class: 'lang-option' }, input,
      h('span', {}, h('strong', { lang: lang ?? '' }, title), sub ? h('span', {}, sub) : ''));
  };
  const english = (code: string) => {
    try {
      return new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const list = h('div', { class: 'lang-grid', role: 'radiogroup' },
    option('system', t('Match my computer'), t('Uses your system’s language when Inkleaf has it')),
    ...UI_LANGUAGES.map((code) => {
      const lang = LANGUAGES.find((l) => l.code === code);
      const native = lang?.native ?? code;
      const local = english(code);
      return option(code, native, local !== native ? local : undefined, code);
    }));
  const go = await modal({
    title: t('Language'),
    wide: true,
    body: h('div', {}, h('p', { class: 'modal-text' }, t('The language for Inkleaf’s menus and messages. Inkleaf restarts to switch; you’ll be asked to save any changes first.')), list),
    buttons: [{ label: t('Cancel'), value: 'cancel' }, { label: t('Restart in this language'), value: 'ok', primary: true }],
  });
  if (go !== 'ok' || chosen === current) return;
  await api.setLanguage(chosen);
}

async function legalHtml(kind: 'terms' | 'privacy') {
  const [{ marked }, text] = await Promise.all([import('marked'), fetch(`./legal/${kind}.md`).then((r) => r.text())]);
  const body = h('div', { class: 'legal-doc' });
  // our own file, but treated like any Markdown: no raw HTML
  body.innerHTML = await marked.parse(text.replace(/</g, '&lt;'), { gfm: true });
  body.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (/^https:\/\//.test(a.href)) api.openExternal(a.href);
    });
  });
  // the document's own heading becomes the dialog title
  const title = body.querySelector('h1');
  title?.remove();
  return { body, title: title?.textContent ?? '' };
}

async function showLegal(kind: 'terms' | 'privacy') {
  const { body, title } = await legalHtml(kind);
  await modal({ title, wide: true, body, buttons: [{ label: t('Close'), value: 'ok', primary: true }] });
}

/** First start of a build without an installer page: agree to the terms or quit. */
async function askForAgreement() {
  const read = (kind: 'terms' | 'privacy', label: string) => {
    const link = h('button', { class: 'link-button' }, label);
    link.addEventListener('click', () => void showLegal(kind));
    return link;
  };
  const choice = await modal({
    title: t('Welcome to Inkleaf'),
    body: h('div', {},
      h('p', { class: 'modal-text' }, t('Inkleaf is free and open source, and it never collects your files or anything about you.')),
      h('p', { class: 'modal-text' }, ...richText(t('Before you start, please read and agree to the {terms} and {privacy}. Inkleaf is provided as is, without any warranty, and you use it at your own risk.'), {
        terms: read('terms', t('Terms of Use')), privacy: read('privacy', t('Privacy Policy')),
      }))),
    buttons: [{ label: t('Quit'), value: 'quit' }, { label: t('I agree'), value: 'agree', primary: true }],
    dismissValue: 'quit',
  });
  if (choice === 'agree') return api.agreeToTerms();
  api.windowCommand('quit');
}

async function openAllTools() {
  const { allTools } = await import('./all-tools');
  const picked = await allTools(!!doc);
  if (!picked) return;
  if (!picked.standalone && !doc) {
    await run('open');
    if (!doc) return;
  }
  return runHubTool(picked.command);
}

/** Runs one tool from the All tools list (also used by the phone app's Tools tab). */
async function runHubTool(command: string) {
  switch (command) {
    case 'organize':
      showSide('pages');
      thumbs.selectAll();
      return toast(t('Drag the pages in the sidebar to put them in a new order.'), 'info');
    case 'pdf-to-pptx': return tool(t('Couldn’t convert this PDF'), () => convertFromPdf(doc!, 'pptx'));
    case 'pdf-to-xlsx': return tool(t('Couldn’t convert this PDF'), () => convertFromPdf(doc!, 'xlsx'));
    case 'pdf-to-md': return tool(t('Couldn’t convert this PDF'), () => convertFromPdf(doc!, 'md'));
    case 'edit-text':
      editor.setTool('edit-text');
      return toast(t('Click any text on the page to change it.'), 'info');
    case 'redact':
      editor.setTool('redact');
      return toast(t('Drag over anything private. It’s removed for good when you save.'), 'info');
    case 'sign': return startSign();
    default: return run(command as Command);
  }
}

async function exportWord(target: EditorDoc) {
  const bytes = await withBusy(t('Reading the document…'), async () => {
    const [{ pdfToWord }, { exportPdf }, { loadPdf }] = await Promise.all([import('./word'), import('./exporter'), import('./pdf')]);
    const pdf = await loadPdf((await exportPdf(target)).bytes);
    try {
      return await pdfToWord(pdf, (n, total) => progress(t('Converting page {n} of {total}…', { n, total })));
    } finally {
      pdf.loadingTask.destroy();
    }
  });
  const path = await api.saveCopy(bytes, `${target.name.replace(/\.pdf$/i, '')}.docx`, 'docx');
  if (path) toast(t('Saved the Word document.'), 'success');
}

async function runOcr(target: EditorDoc) {
  const { recognise } = await import('./ocr');
  const result = await recognise(target, viewer.currentPageId, progress, withBusy);
  if (!result) return;
  viewer.invalidate();
  thumbs.sync();
  findBar.reset();
  if (!result.pages) {
    await modal({ title: t('No text found'), body: t('Inkleaf couldn’t find any words on those pages. Check the language, or try a clearer scan.') });
    return;
  }
  toast(t('Found {words, plural, one {# word} other {# words}} on {pages, plural, one {# page} other {# pages}}. You can now search, copy and edit them.', { words: result.words, pages: result.pages }), 'success', 7000);
}

async function compareWith(target: EditorDoc) {
  const files = await api.pickPdfs();
  const other = files[0];
  if (!other) return;
  const { showComparison } = await import('./compare');
  const { exportPdf } = await import('./exporter');
  let comparison: Promise<void> | null = null;
  let settled = false;
  await withBusy(t('Comparing…'), async () => {
    const mine = (await exportPdf(target)).bytes;
    const unlocked = await withUnlocked(other.data, other.name, async (bytes) => bytes);
    if (!unlocked) return;
    comparison = showComparison({ name: other.name, bytes: unlocked }, { name: target.name, bytes: mine }, progress);
    comparison.then(() => (settled = true), () => (settled = true));
    // the busy indicator stays until the comparison is on screen
    await waitFor(() => settled || !!document.querySelector('.compare-view .cmp-page'), 120_000);
  });
  if (comparison) await comparison;
}

function waitFor(test: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => (test() || performance.now() - started > ms ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

// --- crop ------------------------------------------------------------------------------------

editor.addEventListener('crop', async (event) => {
  const { pageId, box, el } = (event as CustomEvent<{ pageId: string; box: Box; el: HTMLElement }>).detail;
  const choice = await modal({
    title: t('Crop pages'),
    body: t('Keep just the area you marked. Nothing is deleted: you can remove the crop again from the Organize menu.'),
    buttons: [
      { label: t('Cancel'), value: 'cancel' },
      { label: t('All pages'), value: 'all' },
      { label: t('This page'), value: 'one', primary: true },
    ],
  });
  el.remove();
  if (!doc || choice === 'cancel') return;
  doc.setCrop(choice === 'all' ? doc.pages.map((p) => p.id) : [pageId], box);
  editor.setTool('select');
  requestAnimationFrame(() => viewer.scrollToPage(pageId, false));
});

// --- sidebar: pages, bookmarks, comments ---------------------------------------------------------

type SidePane = 'pages' | 'bookmarks' | 'comments';
let sidePane: SidePane = 'pages';

function showSide(pane: SidePane) {
  sidePane = pane;
  const app = $('#app');
  if (app.classList.contains('sidebar-hidden')) {
    app.classList.remove('sidebar-hidden');
    if (isMobile()) app.classList.add('inspector-hidden');
    updatePanelButtons();
    viewer.layout();
  }
  renderSide();
}

function renderSide() {
  $('#sidebar').dataset.pane = sidePane;
  document.querySelectorAll<HTMLElement>('.side-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.side === sidePane)));
  if (sidePane === 'bookmarks') bookmarks.render();
  if (sidePane === 'comments') comments.render();
  sideBadges();
}

function sideBadges() {
  const n = comments.count();
  $('#comment-count').textContent = n ? String(n) : '';
  if (sidePane === 'comments') comments.render();
}

document.querySelectorAll<HTMLElement>('.side-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    sidePane = tab.dataset.side as SidePane;
    renderSide();
  });
});
editor.addEventListener('selectionchange', () => sidePane === 'comments' && comments.render());

// --- updates -----------------------------------------------------------------------------------

let updateVersion = '';
function onUpdate(state: UpdateState) {
  switch (state.state) {
    case 'checking':
      toast(t('Checking for updates…'), 'info', 2500);
      break;
    case 'none':
      toast(t('Inkleaf is up to date.'), 'success');
      break;
    case 'downloading':
      if (state.version) {
        updateVersion = state.version;
        toast(t('Downloading Inkleaf {version}…', { version: state.version }), 'info', 4000);
      }
      break;
    case 'ready':
      modal({
        title: t('Update ready'),
        body: t('Inkleaf {version} has been downloaded. Restart now to use it, or it’ll be installed next time you quit.', { version: state.version || updateVersion }),
        buttons: [{ label: t('Later'), value: 'later' }, { label: t('Restart now'), value: 'restart', primary: true }],
      }).then(async (choice) => {
        if (choice !== 'restart') return;
        if (await saveAllBeforeClose()) api.installUpdate();
      });
      break;
    case 'error':
      modal({ title: t('Couldn’t check for updates'), body: t('{message} Check your internet connection and try again.', { message: state.message }) });
      break;
    case 'unavailable':
      modal({ title: t('Updates'), body: state.reason });
      break;
  }
}

let currentTheme: 'system' | 'light' | 'dark' = 'system';

function updatePanelButtons() {
  const app = $('#app');
  $('#toggle-pages').setAttribute('aria-pressed', String(!app.classList.contains('sidebar-hidden')));
  $('#toggle-inspector').setAttribute('aria-pressed', String(!app.classList.contains('inspector-hidden')));
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function nextZoom(direction: 1 | -1) {
  const s = viewer.scale;
  if (direction > 0) return ZOOM_STEPS.find((z) => z > s + 0.001) ?? 5;
  return [...ZOOM_STEPS].reverse().find((z) => z < s - 0.001) ?? 0.25;
}

// --- popover menus ----------------------------------------------------------------------

interface MenuItem {
  label: string;
  /** The command it runs, so menus can leave out what this device can't do. */
  command?: string;
  icon?: string;
  hint?: string;
  action?: () => void;
  checked?: boolean;
  disabled?: boolean;
  submenu?: () => (MenuItem | 'separator')[];
}

const openMenus: HTMLElement[] = [];

function closeMenu(level = 0) {
  while (openMenus.length > level) openMenus.pop()!.remove();
  if (level === 0) {
    document.querySelectorAll('[data-menu][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
}

/** Leaves out what this device can't do, and the separators that leaves dangling. */
function available(items: (MenuItem | 'separator')[]): (MenuItem | 'separator')[] {
  const kept = items.filter((item) => item === 'separator' || !item.command || supports(item.command));
  return kept.filter((item, i) => item !== 'separator' || (i > 0 && i < kept.length - 1 && kept[i - 1] !== 'separator'));
}

function buildMenu(items: (MenuItem | 'separator')[], level: number): HTMLElement {
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of available(items)) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-separator' }));
      continue;
    }
    const trailing = item.submenu ? icon('chevron-right')
      : item.checked ? icon('check')
          : item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null;
    const b = h('button', { class: `menu-item${item.submenu ? ' has-sub' : ''}`, role: 'menuitem', disabled: !!item.disabled },
      item.icon ? icon(item.icon) : h('span', { class: 'icon' }),
      h('span', { class: 'menu-label' }, item.label),
      trailing,
    );
    const openSub = () => {
      closeMenu(level + 1);
      menu.querySelectorAll('.menu-item.open').forEach((x) => x.classList.remove('open'));
      if (!item.submenu) return;
      b.classList.add('open');
      const sub = buildMenu(item.submenu(), level + 1);
      $('#menus').append(sub);
      openMenus.push(sub);
      const r = b.getBoundingClientRect();
      // submenus open towards the end of the line: right, or left in Arabic and Hebrew
      const towardsLeft = isRtl() ? r.left - sub.offsetWidth - 4 >= 8 : r.right + 4 + sub.offsetWidth > window.innerWidth;
      const left = towardsLeft ? r.left - sub.offsetWidth - 4 : r.right + 4;
      sub.style.left = `${Math.max(8, left)}px`;
      sub.style.top = `${Math.max(8, Math.min(r.top - 5, window.innerHeight - sub.offsetHeight - 8))}px`;
    };
    b.addEventListener('pointerenter', openSub);
    b.addEventListener('click', () => {
      if (item.submenu) return openSub();
      closeMenu();
      item.action?.();
    });
    menu.append(b);
  }
  return menu;
}

function showMenu(anchor: HTMLElement, items: (MenuItem | 'separator')[]) {
  const wasOpen = anchor.getAttribute('aria-expanded') === 'true';
  closeMenu();
  if (wasOpen) return;
  const menu = buildMenu(items, 0);
  $('#menus').append(menu);
  openMenus.push(menu);
  const r = anchor.getBoundingClientRect();
  // lines up with the button's starting edge
  const left = isRtl() ? r.right - menu.offsetWidth : Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('.menu-item')?.focus();
}

document.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  if (openMenus.length && !target.closest('.menu') && !target.closest('[data-menu]')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenus.length) {
    e.stopPropagation();
    closeMenu();
  }
}, true);

const THEME_ICONS: Record<string, string> = { 'theme-system': 'monitor', 'theme-light': 'sun', 'theme-dark': 'moon' };

function menuFromTable(entries: MenuEntry[]): (MenuItem | 'separator')[] {
  return entries
    .filter((entry) => entry === 'separator' || !(entry.devOnly && packaged))
    .map((entry) => {
      if (entry === 'separator') return 'separator' as const;
      const key = shortcutFor(entry, isMac);
      return {
        label: t(isMobile() && entry.mobileLabel ? entry.mobileLabel : entry.label),
        icon: THEME_ICONS[entry.command],
        hint: key ? displayShortcut(key, isMac) : undefined,
        checked: entry.command.startsWith('theme-') ? entry.command === `theme-${currentTheme}`
          : entry.command === 'toggle-autosave' ? autosave.enabled : undefined,
        disabled: !doc && !NO_DOC_NEEDED.has(entry.command),
        command: entry.command,
        action: () => run(entry.command),
      };
    });
}

const menus: Record<string, () => (MenuItem | 'separator')[]> = {
  autosave: () => [
    { label: t('Auto-save'), icon: 'refresh-cw', checked: autosave.enabled, command: 'toggle-autosave', action: () => run('toggle-autosave') },
    { label: t('Save now'), icon: 'save', hint: displayShortcut('Mod+S', isMac), command: 'save', action: () => run('save') },
    'separator',
    { label: t('Open backups folder'), icon: 'folder-open', command: 'open-backups', action: () => run('open-backups') },
  ],
  app: () => MENU.map((section) => ({ label: section.label, submenu: () => menuFromTable(section.items) })),
  tools: () => [
    { label: t('Recognise text (OCR)…'), icon: 'scan-text', command: 'ocr', action: () => run('ocr') },
    { label: t('Compress…'), icon: 'file-archive', command: 'compress', action: () => run('compress') },
    { label: t('Password protect…'), icon: 'shield-check', command: 'protect', action: () => run('protect') },
    { label: t('Watermark, page numbers & headers…'), icon: 'droplets', command: 'decor', action: () => run('decor') },
    { label: t('Add form fields'), icon: 'text-cursor', command: 'form-builder', action: () => run('form-builder') },
    { label: t('Compare with another PDF…'), icon: 'git-compare', command: 'compare', action: () => run('compare') },
    'separator',
    { label: t('Convert to PDF…'), icon: 'file-input', hint: t('Word, Excel, PowerPoint…'), command: 'convert-to-pdf', action: () => run('convert-to-pdf') },
    { label: t('Convert PDF to…'), icon: 'file-output', hint: t('Word, Excel, PowerPoint…'), command: 'convert-from-pdf', action: () => run('convert-from-pdf') },
    { label: t('Web page to PDF…'), icon: 'globe', command: 'web-to-pdf', action: () => run('web-to-pdf') },
    { label: t('Scan to PDF…'), icon: 'scan-line', command: 'scan-to-pdf', action: () => run('scan-to-pdf') },
    { label: t('Combine pictures into one PDF…'), icon: 'images', command: 'images-to-pdf', action: () => run('images-to-pdf') },
    { label: t('Save as PDF/A…'), icon: 'archive', hint: t('For archiving'), command: 'pdf-to-pdfa', action: () => run('pdf-to-pdfa') },
    { label: t('Repair a damaged PDF…'), icon: 'wrench', command: 'repair', action: () => run('repair') },
    'separator',
    { label: t('AI Summarizer…'), icon: 'sparkles', command: 'ai-summarize', action: () => run('ai-summarize') },
    { label: t('Translate PDF…'), icon: 'languages', command: 'ai-translate', action: () => run('ai-translate') },
    { label: t('AI settings…'), icon: 'wrench', command: 'ai-settings', action: () => run('ai-settings') },
    'separator',
    { label: isMobile() ? t('Send to Computer…') : t('Send to Phone…'), icon: isMobile() ? 'monitor' : 'smartphone', command: 'link-send', action: () => run('link-send') },
    { label: isMobile() ? t('Connect to a Computer…') : t('Connect a Phone…'), icon: 'qr-code', command: 'link-pair', action: () => run('link-pair') },
    'separator',
    { label: t('All tools'), icon: 'layout-grid', hint: displayShortcut('Mod+K', isMac), command: 'all-tools', action: () => run('all-tools') },
  ],
  pages: () => {
    const count = thumbs.chosenPages().length;
    const several = thumbs.selected.size > 1;
    return [
      { label: t('Merge another PDF…'), icon: 'file-plus', command: 'insert-pdf', action: () => run('insert-pdf') },
      { label: t('Insert blank page'), icon: 'file-plus-2', command: 'insert-blank', action: () => run('insert-blank') },
      'separator',
      { label: several ? t('Rotate {count} selected pages left', { count }) : t('Rotate current page left'), icon: 'rotate-ccw', command: 'rotate-left', action: () => run('rotate-left') },
      { label: several ? t('Rotate {count} selected pages right', { count }) : t('Rotate current page right'), icon: 'rotate-cw', command: 'rotate-right', action: () => run('rotate-right') },
      { label: several ? t('Delete {count} selected pages', { count }) : t('Delete current page'), icon: 'trash-2', command: 'delete-pages', action: () => run('delete-pages') },
      'separator',
      { label: t('Extract pages…'), icon: 'file-output', command: 'extract', action: () => run('extract') },
      { label: t('Split document…'), icon: 'scissors', command: 'split', action: () => run('split') },
      'separator',
      { label: t('Crop pages'), icon: 'crop', command: 'crop', action: () => run('crop') },
      { label: t('Remove crop from all pages'), icon: 'maximize-2', disabled: !doc?.pages.some((p) => p.crop), command: 'uncrop-all', action: () => run('uncrop-all') },
    ];
  },
  zoom: () => [
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => ({
      label: `${z * 100}%`, checked: Math.abs(viewer.scale - z) < 0.005, action: () => viewer.setScale(z),
    })),
    'separator' as const,
    { label: t('Fit width'), icon: 'maximize-2', hint: displayShortcut('Mod+1', isMac), action: () => viewer.fitWidth() },
    { label: t('Fit page'), icon: 'file-text', hint: displayShortcut('Mod+2', isMac), action: () => viewer.fitPage() },
    'separator' as const,
    { label: t('Continuous scroll'), icon: 'rectangle-vertical', checked: viewer.mode === 'continuous', command: 'mode-continuous', action: () => run('mode-continuous') },
    { label: t('Two pages side by side'), icon: 'columns-2', checked: viewer.mode === 'spread', command: 'mode-spread', action: () => run('mode-spread') },
    { label: t('One page at a time'), icon: 'book-open', checked: viewer.mode === 'single', command: 'mode-single', action: () => run('mode-single') },
  ],
};

// --- toolbar wiring -------------------------------------------------------------------------

const SHAPE_TOOLS = new Set<Tool>(['rect', 'ellipse', 'line', 'arrow']);

function updateToolButtons() {
  const tool = editor.tool;
  const shapes = $('[data-shapes]');
  if (SHAPE_TOOLS.has(tool)) shapes.dataset.tool = tool; // remembers the last shape
  document.querySelectorAll<HTMLElement>('#rail [data-tool]').forEach((b) => {
    const pressed = b.hasAttribute('data-shapes') ? SHAPE_TOOLS.has(tool) : b.dataset.tool === tool;
    b.setAttribute('aria-pressed', String(pressed));
  });
}

editor.addEventListener('toolchange', updateToolButtons);

$('#rail').addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]');
  if (!button) return;
  const tool = button.dataset.tool as Tool;
  if (tool === 'sign') startSign();
  else if (tool === 'image') startImage();
  else editor.setTool(tool);
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('.menu')) return;
  const menuButton = target.closest<HTMLElement>('[data-menu]');
  if (menuButton) {
    showMenu(menuButton, menus[menuButton.dataset.menu!]());
    return;
  }
  const button = target.closest<HTMLElement>('[data-command]');
  if (button && !(button as HTMLButtonElement).disabled) run(button.dataset.command as Command);
});

const pageInput = $<HTMLInputElement>('#page-input');
pageInput.addEventListener('change', () => {
  const n = Number(pageInput.value);
  const target = doc?.pages[n - 1];
  if (target) viewer.scrollToPage(target.id);
  else updatePager();
  pageInput.blur();
});
pageInput.addEventListener('keydown', (e) => e.key === 'Enter' && pageInput.blur());

viewer.addEventListener('pagechange', updatePager);
viewer.addEventListener('zoom', () => {
  $('#zoom-label').textContent = `${Math.round(viewer.scale * 100)}%`;
  if (editor.text.active) editor.text.layout();
});

// --- keyboard shortcuts on Windows and Linux ---------------------------------------------
// macOS routes these through its native menu bar. Elsewhere there is no menu
// bar, so we read the same table and match keys here.

const TEXT_COMMANDS = new Set<Command>(['undo', 'redo', 'cut', 'copy', 'paste', 'duplicate', 'delete']);
const keymap = new Map<string, Command>();
if (!isMac) {
  for (const section of MENU) {
    for (const entry of section.items) {
      if (entry === 'separator' || !entry.key) continue;
      keymap.set(entry.key.replace(/Mod/g, 'Ctrl').toLowerCase(), entry.command);
    }
  }
  keymap.set('ctrl+shift+z', 'redo');
  keymap.set('ctrl++', 'zoom-in');
  keymap.set('ctrl+shift++', 'zoom-in');

  window.addEventListener('keydown', (e) => {
    if (e.metaKey) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(e.key.toLowerCase());
    const command = keymap.get(parts.join('+'));
    if (!command) return;
    if (isModalOpen()) return;
    if (TEXT_COMMANDS.has(command) && isTyping()) return;
    e.preventDefault();
    run(command);
  });
}

// Keys that aren't menu items.
window.addEventListener('keydown', (e) => {
  if (isModalOpen() || isTyping() || !doc) return;
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    run(e.key === 'PageDown' ? 'next-page' : 'prev-page');
  }
});

// --- welcome screen -----------------------------------------------------------------------------

function timeAgo(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return t('Just now');
  // the browser knows how to say "5 minutes ago" in every language
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto', style: 'short' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 7) return rtf.format(-days, 'day');
  return new Date(ms).toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

function folderOf(path: string) {
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(sep);
  parts.pop();
  return parts.slice(-2).join(sep) || path;
}

async function renderWelcome() {
  if (doc) return;
  const recent: RecentFile[] = await api.recentFiles().catch(() => []);
  const root = $('#welcome');

  const card = (r: RecentFile) => {
    const remove = h('span', { class: 'recent-remove', role: 'button', title: t('Remove from this list') }, icon('x'));
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.forgetRecent(r.path);
      renderWelcome();
    });
    const el = h('button', { class: 'recent-card', title: r.path },
      h('div', { class: 'recent-thumb' }, r.thumb ? h('img', { src: r.thumb, alt: '' }) : icon('file-text')),
      h('div', { class: 'recent-meta' },
        h('span', { class: 'recent-name' }, r.name.replace(/\.pdf$/i, '')),
        h('span', { class: 'recent-sub' }, timeAgo(r.openedAt)),
        h('span', { class: 'recent-sub' }, folderOf(r.path)),
      ),
      remove,
    );
    el.addEventListener('click', async () => {
      try {
        await openFile(await api.openRecent(r.path));
      } catch (err) {
        showError(t('Couldn’t open this file'), err);
        renderWelcome();
      }
    });
    return el;
  };

  const action = (iconName: string, title: string, sub: string, command: Command, primary = false) =>
    h('button', { class: `start-action${primary ? ' primary' : ''}`, 'data-command': command },
      h('span', { class: 'start-icon' }, icon(iconName)),
      h('span', { class: 'start-text' }, h('strong', {}, title), h('span', {}, sub)),
    );

  const phone = isMobile();
  root.replaceChildren(
    h('div', { class: 'home' },
      h('div', { class: 'home-intro' },
        h('h1', {}, t('Open a PDF to get started')),
        h('p', {}, phone
          ? t('Edit, sign, fill and organise PDFs. Everything stays on this phone.')
          : t('Edit, sign, fill and organise PDFs. Everything stays on this computer.')),
      ),
      h('div', { class: 'start-actions' },
        action('folder-open', t('Open file'), phone ? t('From your phone or cloud storage') : displayShortcut('Mod+O', isMac), 'open', true),
        action('file-text', t('New blank PDF'), phone ? t('Start from an empty page') : displayShortcut('Mod+N', isMac), 'new'),
        action('file-input', t('Convert to PDF'), t('Word, Excel, PowerPoint, pictures…'), 'convert-to-pdf'),
        action('layout-grid', t('All tools'), t('Merge, scan, compress, translate…'), 'all-tools'),
        phone ? action('monitor', t('Connect to a computer'), t('Send PDFs back and forth over your Wi-Fi'), 'link-pair') : null,
      ),
      h('section', { class: 'recent' },
        h('h2', {}, t('Recent files')),
        recent.length
          ? h('div', { class: 'recent-grid' }, ...recent.map(card))
          : h('div', { class: 'recent-empty' },
              icon('clock'),
              h('p', {}, phone
                ? t('Files you open will show up here, along with PDFs you share to Inkleaf from other apps or send from your computer.')
                : t('Files you open will show up here. You can also drop a PDF (or a Word file, spreadsheet, slides or picture to convert) anywhere in this window.'))),
      ),
      h('footer', { class: 'home-foot' },
        h('span', {}, ...richText(t('Built by {name} · Free and open source'), { name: h('strong', {}, 'EPD') })),
        h('button', { class: 'coffee-link', 'data-command': 'donate' }, icon('coffee'), t('Buy me a coffee')),
      ),
    ),
  );
}

// --- drag and drop files onto the window -------------------------------------------------------

let dragDepth = 0;
const overlay = $('#drop-overlay');

function hasFiles(e: DragEvent) {
  return e.dataTransfer?.types.includes('Files') && !e.dataTransfer.types.includes('application/x-inkleaf-pages');
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('#drop-overlay-text').textContent = doc ? t('Drop to open or insert') : t('Drop to open');
  if (!(e.target as HTMLElement).closest('#sidebar')) overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  overlay.hidden = !!(e.target as HTMLElement).closest('#sidebar');
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;

  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => {
    const ext = f.name.toLowerCase().split('.').pop() ?? '';
    return ext === 'pdf' || CONVERTIBLE.includes(ext);
  });
  if (!files.length) {
    toast(t('Inkleaf can’t open that kind of file.'), 'error');
    return;
  }

  const readDropped = async (file: File): Promise<OpenedFile> => {
    const path = api.pathForFile(file);
    if (path) {
      try {
        return await api.openPath(path);
      } catch {
        // fall through and read it ourselves
      }
    }
    return { path: null, name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
  };

  if (doc) {
    const choice = await modal({
      title: files.length === 1 ? t('What should happen with “{name}”?', { name: files[0].name }) : t('What should happen with these {count} files?', { count: files.length }),
      buttons: [
        { label: t('Cancel'), value: 'cancel' },
        { label: files.length === 1 ? t('Open in a new tab') : t('Open each in a tab'), value: 'open' },
        { label: t('Insert pages here'), value: 'insert', primary: true },
      ],
    });
    if (choice === 'insert') {
      const target = doc!;
      const { convertToPdf } = await import('./to-pdf');
      const picked: { name: string; data: Uint8Array }[] = [];
      for (const f of files) {
        const data = new Uint8Array(await f.arrayBuffer());
        try {
          // other kinds of file are turned into PDF pages first
          picked.push(/\.pdf$/i.test(f.name) ? { name: f.name, data } : { name: f.name, data: (await withBusy(t('Converting “{name}”…', { name: f.name }), () => convertToPdf({ name: f.name, data }, progress))).bytes });
        } catch (err) {
          showError(t('Couldn’t convert “{name}”', { name: f.name }), err);
        }
      }
      if (picked.length) await withBusy(t('Inserting pages…'), () => insertPdfFiles(target, picked, afterCurrentIndex()));
      return;
    }
    if (choice !== 'open') return;
  }

  for (const file of files) await openFile(await readDropped(file));
});

// --- about & shortcuts -----------------------------------------------------------------------------

async function showAbout() {
  const info = await api.info();
  modal({
    title: 'Inkleaf',
    body: h('div', { class: 'about' },
      h('p', {}, t('Version {version}', { version: info.version })),
      h('p', {}, isMobile()
        ? t('A free, open-source PDF editor. Everything happens on this phone; no files are uploaded anywhere.')
        : t('A free, open-source PDF editor. Everything happens on this computer; no files are uploaded anywhere.')),
      h('p', { class: 'muted' }, t('Built by EPD (Priyansh Das). Licensed under the GNU GPL, version 3 or later: you’re free to use, study, share and change it.')),
      h('p', { class: 'muted small' },
        t('Built with pdf.js (Apache 2.0), pdf-lib (MIT), lopdf (MIT), Tesseract OCR (Apache 2.0), docx (MIT), Instrument Sans and DejaVu fonts (OFL / Bitstream Vera), Lucide icons (ISC). '),
        t('Electron {electron}.', { electron: info.electron })),
    ),
    buttons: [
      { label: t('Source code'), value: 'code' },
      { label: DONATE_URL ? t('Buy me a coffee') : t('Star on GitHub'), value: 'support' },
      { label: t('Close'), value: 'close', primary: true },
    ],
  }).then((choice) => {
    if (choice === 'code') api.openExternal(REPO_URL);
    if (choice === 'support') api.openExternal(DONATE_URL || REPO_URL);
  });
}

function showShortcuts() {
  const mod = isMac ? '⌘' : 'Ctrl';
  const rows: [string, string][] = [
    ['V', t('Select')], [t('H or hold Space'), t('Pan')], ['E', t('Edit existing text')], ['T', t('Add text')],
    ['P', t('Draw')], ['M', t('Highlight')], ['R / O / L / A', t('Rectangle, ellipse, line, arrow')],
    ['W', t('White-out')], ['B', t('Redact')], ['X', t('Eraser')], ['N', t('Comment')], ['K', t('Stamp')],
    [`${mod}+F`, t('Find')], [`${mod}+P`, t('Print')],
    [`${mod}+Z / ${mod}+Y`, t('Undo / redo')], [`${mod}+C / ${mod}+V`, t('Copy / paste a mark')], [`${mod}+D`, t('Duplicate')],
    [t('Delete'), t('Delete the selected mark')], [t('Arrow keys'), t('Nudge (Shift for 10×)')], [t('Shift while drawing'), t('Square, circle, 45° lines')],
    [`${mod}+${t('wheel')}`, t('Zoom')], [`${mod}+1 / ${mod}+2`, t('Fit width / fit page')], [t('Page Up / Down'), t('Previous / next page')],
    [`${mod}+S`, t('Save')], [`${mod}+W`, t('Close tab')], ['Ctrl+Tab', t('Next tab')], [`${mod}+B`, t('Show or hide pages')],
  ];
  modal({
    title: t('Keyboard shortcuts'),
    wide: true,
    body: h('dl', { class: 'shortcuts' }, ...rows.flatMap(([k, v]) => [h('dt', {}, ...k.split(' / ').flatMap((part, i) => [i ? ' / ' : '', h('kbd', {}, part)])), h('dd', {}, v)])),
  });
}

// --- start up ------------------------------------------------------------------------------------

/** On a phone the page list and properties are drawers that start closed. */
function setUpPhoneLayout() {
  document.documentElement.classList.add('mobile');
  const app = $('#app');
  app.classList.add('sidebar-hidden', 'inspector-hidden');
  const closeDrawers = () => {
    if (app.classList.contains('sidebar-hidden') && app.classList.contains('inspector-hidden')) return;
    app.classList.add('sidebar-hidden', 'inspector-hidden');
    updatePanelButtons();
  };
  const scrim = h('div', { class: 'scrim', 'aria-hidden': 'true' });
  scrim.addEventListener('click', closeDrawers);
  $('#workspace').append(scrim);
  // picking a page, bookmark or comment takes you there, so get the drawer out of the way
  $('#sidebar').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.thumb, .bm-title, .comment-item')) {
      setTimeout(closeDrawers, 120);
    }
  });
  // the phone's back button closes a drawer before anything else
  window.addEventListener('inkleaf-back', (e) => {
    if (!app.classList.contains('sidebar-hidden') || !app.classList.contains('inspector-hidden')) {
      closeDrawers();
      e.preventDefault();
    }
  });
}

async function start() {
  localizeStatic();
  // buttons for things this device can't do (on a phone: new windows, updates…)
  document.querySelectorAll<HTMLElement>('[data-command]').forEach((el) => {
    if (!supports(el.dataset.command!)) el.hidden = true;
  });
  if (isMobile()) setUpPhoneLayout();
  if (isMobile()) {
    // on a phone, the paired device is a computer
    const send = $('#send-to-device');
    send.title = t('Send to computer');
    send.querySelector('[data-icon]')?.setAttribute('data-icon', 'monitor');
  }
  hydrateIcons();
  try {
    if (!isMobile() && localStorage.getItem('inkleaf.sidebar-hidden')) $('#app').classList.add('sidebar-hidden');
    if (!isMobile() && localStorage.getItem('inkleaf.inspector-hidden')) $('#app').classList.add('inspector-hidden');
  } catch {
    // ignore
  }
  const [theme, info] = await Promise.all([api.theme(), api.info()]);
  currentTheme = theme;
  packaged = info.packaged;
  userName = info.userName;
  try {
    // comments are signed with the computer's account name until you change it
    if (localStorage.getItem('inkleaf.author') === null && userName) localStorage.setItem('inkleaf.author', userName);
    const mode = localStorage.getItem('inkleaf.mode') as ReadingMode | null;
    if (mode === 'spread' || mode === 'single') viewer.setMode(mode);
  } catch {
    // storage unavailable: defaults are fine
  }
  api.onUpdate(onUpdate);
  void import('./link-ui').then((m) => m.watchLink());
  // language packs download in the background the first time they're needed
  api.onPackProgress(({ received, total }) => {
    if (!total) return;
    const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
    liveStatus(received >= total ? null : t('Downloading a language pack… {done} of {total} MB', { done: mb(received), total: mb(total) }));
    if (received >= total) toast(t('Language pack downloaded. It works offline from now on.'), 'success');
  });
  updateToolButtons();
  updatePanelButtons();
  updateChrome();
  renderWelcome();
  // in engine mode the phone app asks itself, on its own welcome screen
  if (info.needsAgreement && !api.engine) await askForAgreement();

  // exact font widths and the PDF writer aren't needed until you edit, so
  // fetch them once the window is showing
  const warmUp = () => {
    loadFontMetrics().then(() => viewer.redraw());
    import('./exporter').catch(() => {}); // so the first save doesn't wait for it
  };
  if ('requestIdleCallback' in window) requestIdleCallback(warmUp, { timeout: 1500 });
  else setTimeout(warmUp, 300);

  api.onMenu((command: MenuCommand) => run(command));
  api.onSaveBeforeClose(() => saveAllBeforeClose());
  api.onOpenFile((file) => openFile(file));
  offerRecovery();

  if (api.engine) await startEngineMode();

  // for automated tests only: exposes internals without touching the UI
  (window as unknown as { __inkleaf: unknown }).__inkleaf = {
    getDoc, viewer, editor, exportPdf, autosave, t, tabCount: () => tabs.length, run: (c: Command) => run(c),
    allDocs: () => tabs.map((t) => t.doc),
    exportBatch: async (d: EditorDoc, groups: string[][]) => (await import('./exporter')).exportBatch(d, groups),
  };
}

/** In engine mode there's no rail button to open menus from: they open from the bottom middle. */
function engineAnchor(): HTMLElement {
  let el = document.getElementById('engine-anchor');
  if (!el) {
    el = h('div', { id: 'engine-anchor', style: 'position:fixed;left:50%;bottom:12px;width:1px;height:1px' });
    document.body.append(el);
  }
  return el;
}

/** Hands the editor to the native Android screens (see engine.ts). */
async function startEngineMode() {
  engine = await import('./engine');
  toastHook.send = engine.sendToast;
  engine.startEngine({
    docs: () => tabs.map((tab) => ({ id: tab.id, doc: tab.doc })),
    active: () => (activeTab ? { id: activeTab.id, doc: activeTab.doc } : null),
    activate: (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) activate(tab);
    },
    close: async (id, discard) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return true;
      // the app has already asked about unsaved changes
      if (discard) tab.doc.markSaved(tab.doc.name, tab.doc.path);
      return closeTab(tab);
    },
    openPath: async (path) => openFile(await api.openRecent(path)),
    run: (command) => run(command as Command),
    startSign: () => startSign(),
    hubTool: (command) => runHubTool(command),
    startImage: () => startImage(),
    save: () => save(),
    autosave,
    editor,
    viewer,
  });
}

start();
