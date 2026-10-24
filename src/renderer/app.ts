// SPDX-License-Identifier: GPL-3.0-or-later
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
import { confirmDialog, h, hydrateIcons, icon, isModalOpen, modal, pickImage, toast } from './ui';
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

let busyTimer = 0;
function busy(message: string | false) {
  clearTimeout(busyTimer);
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
  saved: ['check', 'Saved'],
  saving: ['refresh-cw', 'Saving…'],
  unsaved: ['circle', 'Not saved'],
  off: ['circle', 'Not saved'],
  new: ['circle', 'Not saved yet'],
  error: ['info', 'Couldn’t auto-save'],
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
  el.title = state === 'error' ? `Auto-save failed: ${autosave.error(doc)}`
    : state === 'new' ? 'Save this document once (Ctrl+S) and Inkleaf will keep saving it for you'
      : doc.wasProtected && autosave.enabled ? 'Auto-save is paused for protected PDFs: saving would remove the protection'
        : autosave.enabled ? 'Changes are saved automatically' : 'Auto-save is off';
  el.replaceChildren(icon(iconName), h('span', {}, label));
}

/** Offers back unsaved work from a session that didn't close normally. */
async function offerRecovery() {
  const found = await api.recoveries().catch(() => []);
  if (!found.length) return;
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const choice = await modal({
    title: 'Restore unsaved work?',
    body: h('div', {},
      h('p', { class: 'modal-text' }, 'Inkleaf didn’t close properly last time. These documents had changes that weren’t saved:'),
      h('ul', { class: 'recover-list' }, ...found.map((r) => h('li', {}, h('strong', {}, r.name), h('span', {}, ` · ${when(r.savedAt)}`)))),
    ),
    buttons: [{ label: 'Discard', value: 'discard', danger: true }, { label: 'Restore', value: 'restore', primary: true }],
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
        toast(`Couldn’t restore “${r.name}”: ${(err as Error).message}`, 'error', 7000);
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
}

function updatePager() {
  const input = $<HTMLInputElement>('#page-input');
  const total = doc?.pages.length ?? 0;
  const index = doc && viewer.currentPageId ? doc.pageIndex(viewer.currentPageId) : -1;
  if (document.activeElement !== input) input.value = index >= 0 ? String(index + 1) : '';
  $('#page-count').textContent = `of ${total}`;
}

// --- tab management -------------------------------------------------------------

function renderTabs() {
  const strip = $('#tabs');
  strip.replaceChildren(...tabs.map((tab) => {
    const close = h('button', { class: 'tab-close', title: 'Close tab', 'aria-label': `Close ${tab.doc.name}` }, icon('x'));
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
      title: `Save changes to “${tab.doc.name}”?`,
      body: 'Your changes will be lost if you don’t save them.',
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Don’t save', value: 'discard' },
        { label: 'Save', value: 'save', primary: true },
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
    const opened = await withBusy('Opening…', async () => {
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
      toast('This PDF was protected. Inkleaf will save it without the protection.', 'info', 8000);
    }
    if (await forms.hasFields()) toast('This PDF has form fields. Click a field to fill it in.', 'info');
  } catch (err) {
    console.error(err);
    const choice = await modal({
      title: 'Couldn’t open this PDF',
      body: `“${file.name}” looks damaged. Inkleaf can try to repair it into a new copy; the original isn’t touched.`,
      buttons: [{ label: 'Close', value: 'cancel' }, { label: 'Try to repair', value: 'repair', primary: true }],
    });
    if (choice === 'repair') await tool('Couldn’t repair the PDF', () => repairFile(file));
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
    const { bytes, warnings } = await withBusy('Saving…', () => exportPdf(current));
    let path = current.path;
    if (!saveAs && path) {
      await withBusy('Saving…', () => api.save(path!, bytes));
    } else {
      path = await api.saveAs(bytes, current.name);
      if (!path) return false;
    }
    current.markSaved(fileName(path), path, at);
    autosave.forget(current);
    rememberThumbnail(current);
    toast(`Saved “${current.name}”`, 'success', 2600);
    await showWarnings(warnings);
    return true;
  } catch (err) {
    showError('Couldn’t save', err);
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

async function startSign() {
  editor.setTool('select');
  const picked = await signMenu($('#rail [data-tool="sign"]'));
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
    toast('A PDF needs at least one page.', 'error');
    return;
  }
  if (ids.length > 1 && !(await confirmDialog(`Delete ${ids.length} pages?`, 'You can undo this with Ctrl+Z.', 'Delete', true))) return;
  const first = doc.pageIndex(ids[0]) + 1;
  doc.deletePages(ids);
  thumbs.selected.clear();
  toast(ids.length === 1 ? `Deleted page ${first}. Press Ctrl+Z to undo.` : `Deleted ${ids.length} pages.`);
}

thumbs.addEventListener('delete', (e) => deletePages((e as CustomEvent<string[]>).detail));
thumbs.addEventListener('insert-files', async (e) => {
  const { files, index } = (e as CustomEvent<{ files: File[]; index: number }>).detail;
  if (!doc) return;
  const picked = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  await withBusy('Inserting pages…', () => insertPdfFiles(doc!, picked, index));
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
  'web-to-pdf', 'scan-to-pdf', 'repair', 'unlock', 'ai-settings', 'all-tools',
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
  if (isModalOpen() && !['undo', 'redo', 'copy', 'cut', 'paste'].includes(command)) return;
  if (!NO_DOC_NEEDED.has(command) && !doc) return;

  switch (command) {
    case 'new': return newBlank();
    case 'open': {
      const file = await api.openDialog().catch((err) => (showError('Couldn’t open this file', err), null));
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
      try { localStorage.setItem(`inkleaf.${cls}`, hidden ? '1' : ''); } catch { /* fine */ }
      updatePanelButtons();
      viewer.layout();
      return;
    }

    case 'insert-pdf': {
      const files = await api.pickPdfs();
      if (files.length) await withBusy('Inserting pages…', () => insertPdfFiles(doc!, files, afterCurrentIndex()));
      return;
    }
    case 'insert-blank': {
      const page = await insertBlankPage(doc!, viewer.currentPageId);
      viewer.scrollToPage(page.id);
      return;
    }
    case 'extract':
      return extractPages(doc!, thumbs.chosenPages()).catch((err) => showError('Couldn’t extract pages', err));
    case 'split':
      return splitDocument(doc!).catch((err) => showError('Couldn’t split the document', err));
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
        await withBusy('Preparing to print…', () => printDocument(doc!, (done, total) => progress(`Preparing page ${Math.min(done + 1, total)} of ${total} for printing…`)));
      } catch (err) {
        showError('Couldn’t print', err);
      }
      return;
    }
    case 'compress': return tool('Couldn’t compress this PDF', () => compressDialog(doc!, toolHost));
    case 'protect': return tool('Couldn’t protect this PDF', () => protectDialog(doc!, toolHost));
    case 'decor': return tool('Couldn’t add that', () => decorDialog(doc!));
    case 'remove-decor': return doc!.setDecor(NO_DECOR);
    case 'images-to-pdf': return tool('Couldn’t make a PDF from those pictures', () => imagesToPdf(toolHost));
    case 'convert-to-pdf': {
      const files = await api.pickConvertible();
      if (files.length) await convertFiles(files);
      return;
    }
    case 'convert-from-pdf': return tool('Couldn’t convert this PDF', () => convertFromPdf(doc!));
    case 'web-to-pdf': return tool('Couldn’t make a PDF of that page', webToPdf);
    case 'scan-to-pdf': return tool('Couldn’t make the scan', scanToPdf);
    case 'repair': return tool('Couldn’t repair the PDF', () => repairFile());
    case 'unlock': return tool('Couldn’t unlock the PDF', unlockFile);
    case 'pdf-to-pdfa': return tool('Couldn’t make a PDF/A', () => saveAsPdfA(doc!));
    case 'ai-settings': return tool('Couldn’t change the AI settings', async () => void (await aiTools()).aiSettings());
    case 'ai-summarize': return tool('Couldn’t summarize this PDF', async () => (await aiTools()).summarize(doc!, aiHost));
    case 'ai-translate': return tool('Couldn’t translate this PDF', async () => (await aiTools()).translate(doc!, aiHost));
    case 'all-tools': return tool('Something went wrong', openAllTools);
    case 'pdf-to-images': return tool('Couldn’t export the pages', () => pdfToImages(doc!, toolHost));
    case 'pdf-to-word': return tool('Couldn’t export to Word', () => exportWord(doc!));
    case 'ocr': return tool('Text recognition didn’t work', () => runOcr(doc!));
    case 'compare': return tool('Couldn’t compare', () => compareWith(doc!));
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
      toast(autosave.enabled ? 'Auto-save is on. Documents you’ve saved before are kept saved as you work.' : 'Auto-save is off. Save with Ctrl+S.', 'info', 4500);
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
      const result = await withBusy(`Converting “${file.name}”…`, () => convertToPdf(file, progress));
      result.notes.forEach((n) => notes.add(n));
      const opened = await EditorDoc.open(result.bytes, file.name.replace(/\.[^.]+$/, '.pdf'), null);
      // it only exists in Inkleaf so far: closing should offer to save it
      opened.markUnsaved();
      addTab(opened);
    } catch (err) {
      showError(`Couldn’t convert “${file.name}”`, err);
    }
  }
  if (notes.size) toast([...notes].join(' '), 'info', 9000);
}

type ExportFormat = 'docx' | 'xlsx' | 'pptx' | 'images' | 'pdfa' | 'txt' | 'md' | 'html';

/** "Convert PDF to…": pick a format, then convert the open document (with its edits). */
async function convertFromPdf(target: EditorDoc, initial: ExportFormat = 'docx') {
  const formats: { value: ExportFormat; title: string; detail: string; icon: string }[] = [
    { value: 'docx', title: 'Word', detail: 'Editable text with headings, paragraphs and pictures.', icon: 'file-text' },
    { value: 'xlsx', title: 'Excel', detail: 'Tables become rows and columns, one sheet per page. Numbers stay numbers.', icon: 'table' },
    { value: 'pptx', title: 'PowerPoint', detail: 'One slide per page, exactly as it looks. Page text goes in the notes.', icon: 'presentation' },
    { value: 'images', title: 'Pictures', detail: 'Each page as a PNG or JPEG.', icon: 'file-image' },
    { value: 'pdfa', title: 'PDF/A', detail: 'The archiving standard: fonts built in, nothing that can stop it opening in years to come.', icon: 'archive' },
    { value: 'txt', title: 'Plain text', detail: 'Just the words, for pasting anywhere.', icon: 'type' },
    { value: 'md', title: 'Markdown', detail: 'Text with headings, bold and italic, for notes apps and websites.', icon: 'hash' },
    { value: 'html', title: 'Web page', detail: 'A single HTML file that opens in any browser.', icon: 'globe' },
  ];
  let chosen = initial;
  const list = h('div', { class: 'format-grid', role: 'radiogroup' }, ...formats.map((f) => {
    const input = h('input', { type: 'radio', name: 'format', value: f.value, checked: f.value === chosen });
    input.addEventListener('change', () => (chosen = f.value));
    return h('label', { class: 'format-card' }, input, icon(f.icon), h('span', {}, h('strong', {}, f.title), h('span', {}, f.detail)));
  }));
  const go = await modal({
    title: 'Convert PDF to…',
    wide: true,
    body: h('div', {}, h('p', { class: 'modal-text' }, 'Makes a new file from this document, including your edits. The PDF itself isn’t changed.'), list),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Convert…', value: 'ok', primary: true }],
  });
  if (go !== 'ok') return;
  if (chosen === 'images') return pdfToImages(target, toolHost);
  if (chosen === 'docx') return exportWord(target);
  if (chosen === 'pdfa') return saveAsPdfA(target);

  const base = target.name.replace(/\.pdf$/i, '');
  const labels: Record<string, string> = { xlsx: 'Excel workbook', pptx: 'PowerPoint presentation', txt: 'text file', md: 'Markdown file', html: 'web page' };
  const bytes = await withBusy('Reading the document…', async () => {
    const [formats, { exportPdf }, { loadPdf }] = await Promise.all([import('./export-formats'), import('./exporter'), import('./pdf')]);
    const pdf = await loadPdf((await exportPdf(target)).bytes);
    const step = (n: number, total: number) => progress(`Converting page ${n} of ${total}…`);
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
  if (path) toast(`Saved the ${labels[chosen]}.`, 'success');
}

/** The PDF/A-2b archiving format. */
async function saveAsPdfA(target: EditorDoc) {
  const result = await withBusy('Making a PDF/A…', async () => {
    const [{ toPdfA }] = await Promise.all([import('./pdfa')]);
    const { bytes } = await exportPdf(target);
    return toPdfA(bytes, target.name.replace(/\.pdf$/i, ''));
  });
  const path = await api.saveCopy(result.bytes, `${target.name.replace(/\.pdf$/i, '')} (PDF-A).pdf`, 'pdf');
  if (!path) return;
  if (result.warnings.length) {
    await modal({
      title: 'Saved as PDF/A, with notes',
      body: h('div', {}, h('p', { class: 'modal-text' }, 'The file was saved. A few things in it may not meet the standard strictly:'),
        h('ul', { class: 'modal-list' }, ...result.warnings.map((w) => h('li', {}, w)))),
    });
  } else {
    toast(`Saved as PDF/A${result.fontsEmbedded ? `, with ${result.fontsEmbedded} font${result.fontsEmbedded === 1 ? '' : 's'} built in` : ''}.`, 'success');
  }
}

async function webToPdf() {
  const address = h('input', { class: 'field-input', type: 'url', placeholder: 'https://example.com/page', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const error = h('p', { class: 'field-error' });
  const choice = await modal({
    title: 'Web page to PDF',
    body: h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Web address'), address,
        h('span', { class: 'field-hint' }, 'The page loads privately, without your logins or cookies, and is printed onto A4 pages.')),
      error,
      h('p', { class: 'field-hint' }, 'Have an .html file instead? Use Convert to PDF.')),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Make PDF', value: 'ok', primary: true }],
    validate: (value) => {
      if (value !== 'ok') return true;
      if (!address.value.trim()) {
        error.textContent = 'Type or paste a web address.';
        return false;
      }
      return true;
    },
  });
  if (choice !== 'ok') return;
  const { pdf, title } = await withBusy('Loading the page…', () => api.urlToPdf(address.value.trim()));
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Web page';
  const opened = await EditorDoc.open(pdf, `${safe}.pdf`, null);
  opened.markUnsaved();
  addTab(opened);
}

async function scanToPdf() {
  const { scanDialog } = await import('./scan');
  const scanned = await scanDialog();
  if (!scanned) return;
  const bytes = await withBusy('Making the PDF…', () => scanned.make(progress));
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  const opened = await EditorDoc.open(bytes, `Scan ${stamp}.pdf`, null);
  opened.markUnsaved();
  addTab(opened);
  if (scanned.ocr) await tool('Text recognition didn’t work', () => runOcr(opened));
}

const REPAIR_NOTES: Record<'rebuilt' | 'reread' | 'redrawn', string> = {
  rebuilt: 'Repaired. The file’s index was rebuilt, and everything in it was kept.',
  reread: 'Repaired. Inkleaf read back everything it could; give the pages a quick check.',
  redrawn: 'Repaired by redrawing each page. The text can’t be selected any more: run Recognise Text (OCR) to bring that back.',
};

/** Repairs a damaged PDF (picked now, or one that just failed to open) into a new tab. */
async function repairFile(file?: { name: string; data: Uint8Array }) {
  if (!file) {
    [file] = await api.pickPdfs('Choose a damaged PDF to repair');
    if (!file) return;
  }
  const { repairPdf } = await import('./repair');
  const result = await withBusy('Repairing…', () => repairPdf(file!.data, progress));
  const opened = await EditorDoc.open(result.bytes, file.name.replace(/(\.pdf)?$/i, ' (repaired).pdf'), null);
  opened.markUnsaved();
  addTab(opened);
  toast(`${REPAIR_NOTES[result.method]} ${result.pages} page${result.pages === 1 ? '' : 's'} recovered.`, 'success', 9000);
}

/** Saves a copy of a password-protected PDF without its password. */
async function unlockFile() {
  const [file] = await api.pickPdfs('Choose a protected PDF to unlock');
  if (!file) return;
  const done = await withUnlocked(file.data, file.name, async (bytes, wasProtected) => {
    if (!wasProtected) {
      await modal({ title: 'Nothing to unlock', body: `“${file.name}” doesn’t have a password or any restrictions.` });
      return 'none' as const;
    }
    const opened = await EditorDoc.open(bytes, file.name, null);
    const { bytes: plain } = await withBusy('Unlocking…', () => exportPdf(opened));
    opened.destroy();
    const path = await api.saveCopy(plain, file.name.replace(/(\.pdf)?$/i, ' (unlocked).pdf'), 'pdf');
    return path ? ('saved' as const) : ('none' as const);
  });
  if (done === 'saved') toast('Saved an unlocked copy. The original still has its password.', 'success');
}

let aiModule: Promise<typeof import('./ai-tools')> | null = null;
const aiTools = () => (aiModule ??= import('./ai-tools'));
const aiHost = {
  withBusy,
  progress,
  openDoc: (opened: EditorDoc) => addTab(opened),
  currentPageId: () => viewer.currentPageId,
};

async function openAllTools() {
  const { allTools } = await import('./all-tools');
  const picked = await allTools(!!doc);
  if (!picked) return;
  if (!picked.standalone && !doc) {
    await run('open');
    if (!doc) return;
  }
  switch (picked.command) {
    case 'organize':
      showSide('pages');
      thumbs.selectAll();
      return toast('Drag the pages in the sidebar to put them in a new order.', 'info');
    case 'pdf-to-pptx': return tool('Couldn’t convert this PDF', () => convertFromPdf(doc!, 'pptx'));
    case 'pdf-to-xlsx': return tool('Couldn’t convert this PDF', () => convertFromPdf(doc!, 'xlsx'));
    case 'pdf-to-md': return tool('Couldn’t convert this PDF', () => convertFromPdf(doc!, 'md'));
    case 'edit-text':
      editor.setTool('edit-text');
      return toast('Click any text on the page to change it.', 'info');
    case 'redact':
      editor.setTool('redact');
      return toast('Drag over anything private. It’s removed for good when you save.', 'info');
    case 'sign': return startSign();
    default: return run(picked.command as Command);
  }
}

async function exportWord(target: EditorDoc) {
  const bytes = await withBusy('Reading the document…', async () => {
    const [{ pdfToWord }, { exportPdf }, { loadPdf }] = await Promise.all([import('./word'), import('./exporter'), import('./pdf')]);
    const pdf = await loadPdf((await exportPdf(target)).bytes);
    try {
      return await pdfToWord(pdf, (n, total) => progress(`Converting page ${n} of ${total}…`));
    } finally {
      pdf.loadingTask.destroy();
    }
  });
  const path = await api.saveCopy(bytes, `${target.name.replace(/\.pdf$/i, '')}.docx`, 'docx');
  if (path) toast('Saved the Word document.', 'success');
}

async function runOcr(target: EditorDoc) {
  const { recognise } = await import('./ocr');
  const result = await recognise(target, viewer.currentPageId, progress, withBusy);
  if (!result) return;
  viewer.invalidate();
  thumbs.sync();
  findBar.reset();
  if (!result.pages) {
    await modal({ title: 'No text found', body: 'Inkleaf couldn’t find any words on those pages. Check the language, or try a clearer scan.' });
    return;
  }
  toast(`Found ${result.words} word${result.words === 1 ? '' : 's'} on ${result.pages} page${result.pages === 1 ? '' : 's'}. You can now search, copy and edit them.`, 'success', 7000);
}

async function compareWith(target: EditorDoc) {
  const files = await api.pickPdfs();
  const other = files[0];
  if (!other) return;
  const { showComparison } = await import('./compare');
  const { exportPdf } = await import('./exporter');
  let comparison: Promise<void> | null = null;
  let settled = false;
  await withBusy('Comparing…', async () => {
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
    title: 'Crop pages',
    body: 'Keep just the area you marked. Nothing is deleted: you can remove the crop again from the Organize menu.',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'All pages', value: 'all' },
      { label: 'This page', value: 'one', primary: true },
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
      toast('Checking for updates…', 'info', 2500);
      break;
    case 'none':
      toast('Inkleaf is up to date.', 'success');
      break;
    case 'downloading':
      if (state.version) {
        updateVersion = state.version;
        toast(`Downloading Inkleaf ${state.version}…`, 'info', 4000);
      }
      break;
    case 'ready':
      modal({
        title: 'Update ready',
        body: `Inkleaf ${state.version || updateVersion} has been downloaded. Restart now to use it, or it’ll be installed next time you quit.`,
        buttons: [{ label: 'Later', value: 'later' }, { label: 'Restart now', value: 'restart', primary: true }],
      }).then(async (choice) => {
        if (choice !== 'restart') return;
        if (await saveAllBeforeClose()) api.installUpdate();
      });
      break;
    case 'error':
      modal({ title: 'Couldn’t check for updates', body: `${state.message} Check your internet connection and try again.` });
      break;
    case 'unavailable':
      modal({ title: 'Updates', body: state.reason });
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

function buildMenu(items: (MenuItem | 'separator')[], level: number): HTMLElement {
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
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
      const left = r.right + 4 + sub.offsetWidth > window.innerWidth ? r.left - sub.offsetWidth - 4 : r.right + 4;
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
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
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
        label: entry.label,
        icon: THEME_ICONS[entry.command],
        hint: key ? displayShortcut(key, isMac) : undefined,
        checked: entry.command.startsWith('theme-') ? entry.command === `theme-${currentTheme}`
          : entry.command === 'toggle-autosave' ? autosave.enabled : undefined,
        disabled: !doc && !NO_DOC_NEEDED.has(entry.command),
        action: () => run(entry.command),
      };
    });
}

const menus: Record<string, () => (MenuItem | 'separator')[]> = {
  autosave: () => [
    { label: 'Auto-save', icon: 'refresh-cw', checked: autosave.enabled, action: () => run('toggle-autosave') },
    { label: 'Save now', icon: 'save', hint: displayShortcut('Mod+S', isMac), action: () => run('save') },
    'separator',
    { label: 'Open backups folder', icon: 'folder-open', action: () => run('open-backups') },
  ],
  app: () => MENU.map((section) => ({ label: section.label, submenu: () => menuFromTable(section.items) })),
  tools: () => [
    { label: 'Recognise text (OCR)…', icon: 'scan-text', action: () => run('ocr') },
    { label: 'Compress…', icon: 'file-archive', action: () => run('compress') },
    { label: 'Password protect…', icon: 'shield-check', action: () => run('protect') },
    { label: 'Watermark, page numbers & headers…', icon: 'droplets', action: () => run('decor') },
    { label: 'Add form fields', icon: 'text-cursor', action: () => run('form-builder') },
    { label: 'Compare with another PDF…', icon: 'git-compare', action: () => run('compare') },
    'separator',
    { label: 'Convert to PDF…', icon: 'file-input', hint: 'Word, Excel, PowerPoint…', action: () => run('convert-to-pdf') },
    { label: 'Convert PDF to…', icon: 'file-output', hint: 'Word, Excel, PowerPoint…', action: () => run('convert-from-pdf') },
    { label: 'Web page to PDF…', icon: 'globe', action: () => run('web-to-pdf') },
    { label: 'Scan to PDF…', icon: 'scan-line', action: () => run('scan-to-pdf') },
    { label: 'Combine pictures into one PDF…', icon: 'images', action: () => run('images-to-pdf') },
    { label: 'Save as PDF/A…', icon: 'archive', hint: 'For archiving', action: () => run('pdf-to-pdfa') },
    { label: 'Repair a damaged PDF…', icon: 'wrench', action: () => run('repair') },
    'separator',
    { label: 'AI Summarizer…', icon: 'sparkles', action: () => run('ai-summarize') },
    { label: 'Translate PDF…', icon: 'languages', action: () => run('ai-translate') },
    { label: 'AI settings…', icon: 'wrench', action: () => run('ai-settings') },
    'separator',
    { label: 'All tools', icon: 'layout-grid', hint: displayShortcut('Mod+K', isMac), action: () => run('all-tools') },
  ],
  pages: () => {
    const count = thumbs.chosenPages().length;
    const which = thumbs.selected.size > 1 ? `${count} selected pages` : 'current page';
    return [
      { label: 'Merge another PDF…', icon: 'file-plus', action: () => run('insert-pdf') },
      { label: 'Insert blank page', icon: 'file-plus-2', action: () => run('insert-blank') },
      'separator',
      { label: `Rotate ${which} left`, icon: 'rotate-ccw', action: () => run('rotate-left') },
      { label: `Rotate ${which} right`, icon: 'rotate-cw', action: () => run('rotate-right') },
      { label: `Delete ${which}`, icon: 'trash-2', action: () => run('delete-pages') },
      'separator',
      { label: 'Extract pages…', icon: 'file-output', action: () => run('extract') },
      { label: 'Split document…', icon: 'scissors', action: () => run('split') },
      'separator',
      { label: 'Crop pages', icon: 'crop', action: () => run('crop') },
      { label: 'Remove crop from all pages', icon: 'maximize-2', disabled: !doc?.pages.some((p) => p.crop), action: () => run('uncrop-all') },
    ];
  },
  zoom: () => [
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => ({
      label: `${z * 100}%`, checked: Math.abs(viewer.scale - z) < 0.005, action: () => viewer.setScale(z),
    })),
    'separator' as const,
    { label: 'Fit width', icon: 'maximize-2', hint: displayShortcut('Mod+1', isMac), action: () => viewer.fitWidth() },
    { label: 'Fit page', icon: 'file-text', hint: displayShortcut('Mod+2', isMac), action: () => viewer.fitPage() },
    'separator' as const,
    { label: 'Continuous scroll', icon: 'rectangle-vertical', checked: viewer.mode === 'continuous', action: () => run('mode-continuous') },
    { label: 'Two pages side by side', icon: 'columns-2', checked: viewer.mode === 'spread', action: () => run('mode-spread') },
    { label: 'One page at a time', icon: 'book-open', checked: viewer.mode === 'single', action: () => run('mode-single') },
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
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
    const remove = h('span', { class: 'recent-remove', role: 'button', title: 'Remove from this list' }, icon('x'));
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
        showError('Couldn’t open this file', err);
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

  root.replaceChildren(
    h('div', { class: 'home' },
      h('div', { class: 'home-intro' },
        h('h1', {}, 'Open a PDF to get started'),
        h('p', {}, 'Edit, sign, fill and organise PDFs. Everything stays on this computer.'),
      ),
      h('div', { class: 'start-actions' },
        action('folder-open', 'Open file', displayShortcut('Mod+O', isMac), 'open', true),
        action('file-text', 'New blank PDF', displayShortcut('Mod+N', isMac), 'new'),
        action('file-input', 'Convert to PDF', 'Word, Excel, PowerPoint, pictures…', 'convert-to-pdf'),
        action('layout-grid', 'All tools', 'Merge, scan, compress, translate…', 'all-tools'),
      ),
      h('section', { class: 'recent' },
        h('h2', {}, 'Recent files'),
        recent.length
          ? h('div', { class: 'recent-grid' }, ...recent.map(card))
          : h('div', { class: 'recent-empty' },
              icon('clock'),
              h('p', {}, 'Files you open will show up here. You can also drop a PDF (or a Word file, spreadsheet, slides or picture to convert) anywhere in this window.')),
      ),
      h('footer', { class: 'home-foot' },
        h('span', {}, 'Built by ', h('strong', {}, 'EPD'), ' · Free and open source'),
        h('button', { class: 'coffee-link', 'data-command': 'donate' }, icon('coffee'), 'Buy me a coffee'),
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
  $('#drop-overlay-text').textContent = doc ? 'Drop to open or insert' : 'Drop to open';
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
    toast('Inkleaf can’t open that kind of file.', 'error');
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
      title: files.length === 1 ? `What should happen with “${files[0].name}”?` : `What should happen with these ${files.length} files?`,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: files.length === 1 ? 'Open in a new tab' : 'Open each in a tab', value: 'open' },
        { label: 'Insert pages here', value: 'insert', primary: true },
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
          picked.push(/\.pdf$/i.test(f.name) ? { name: f.name, data } : { name: f.name, data: (await withBusy(`Converting “${f.name}”…`, () => convertToPdf({ name: f.name, data }, progress))).bytes });
        } catch (err) {
          showError(`Couldn’t convert “${f.name}”`, err);
        }
      }
      if (picked.length) await withBusy('Inserting pages…', () => insertPdfFiles(target, picked, afterCurrentIndex()));
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
      h('p', {}, `Version ${info.version}`),
      h('p', {}, 'A free, open-source PDF editor. Everything happens on this computer; no files are uploaded anywhere.'),
      h('p', { class: 'muted' }, 'Built by EPD (Priyansh Das). Licensed under the GNU GPL, version 3 or later: you’re free to use, study, share and change it.'),
      h('p', { class: 'muted small' },
        'Built with pdf.js (Apache 2.0), pdf-lib (MIT), lopdf (MIT), Tesseract OCR (Apache 2.0), docx (MIT), Instrument Sans and DejaVu fonts (OFL / Bitstream Vera), Lucide icons (ISC). ',
        `Electron ${info.electron}.`),
    ),
    buttons: [
      { label: 'Source code', value: 'code' },
      { label: DONATE_URL ? 'Buy me a coffee' : 'Star on GitHub', value: 'support' },
      { label: 'Close', value: 'close', primary: true },
    ],
  }).then((choice) => {
    if (choice === 'code') api.openExternal(REPO_URL);
    if (choice === 'support') api.openExternal(DONATE_URL || REPO_URL);
  });
}

function showShortcuts() {
  const mod = isMac ? '⌘' : 'Ctrl';
  const rows: [string, string][] = [
    ['V', 'Select'], ['H or hold Space', 'Pan'], ['E', 'Edit existing text'], ['T', 'Add text'],
    ['P', 'Draw'], ['M', 'Highlight'], ['R / O / L / A', 'Rectangle, ellipse, line, arrow'],
    ['W', 'White-out'], ['B', 'Redact'], ['X', 'Eraser'], ['N', 'Comment'], ['K', 'Stamp'],
    [`${mod}+F`, 'Find'], [`${mod}+P`, 'Print'],
    [`${mod}+Z / ${mod}+Y`, 'Undo / redo'], [`${mod}+C / ${mod}+V`, 'Copy / paste a mark'], [`${mod}+D`, 'Duplicate'],
    ['Delete', 'Delete the selected mark'], ['Arrow keys', 'Nudge (Shift for 10×)'], ['Shift while drawing', 'Square, circle, 45° lines'],
    [`${mod}+wheel`, 'Zoom'], [`${mod}+1 / ${mod}+2`, 'Fit width / fit page'], ['Page Up / Down', 'Previous / next page'],
    [`${mod}+S`, 'Save'], [`${mod}+W`, 'Close tab'], ['Ctrl+Tab', 'Next tab'], [`${mod}+B`, 'Show or hide pages'],
  ];
  modal({
    title: 'Keyboard shortcuts',
    wide: true,
    body: h('dl', { class: 'shortcuts' }, ...rows.flatMap(([k, v]) => [h('dt', {}, ...k.split(' / ').flatMap((part, i) => [i ? ' / ' : '', h('kbd', {}, part)])), h('dd', {}, v)])),
  });
}

// --- start up ------------------------------------------------------------------------------------

async function start() {
  hydrateIcons();
  try {
    if (localStorage.getItem('inkleaf.sidebar-hidden')) $('#app').classList.add('sidebar-hidden');
    if (localStorage.getItem('inkleaf.inspector-hidden')) $('#app').classList.add('inspector-hidden');
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
  updateToolButtons();
  updatePanelButtons();
  updateChrome();
  renderWelcome();

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

  // for automated tests only: exposes internals without touching the UI
  (window as unknown as { __inkleaf: unknown }).__inkleaf = {
    getDoc, viewer, editor, exportPdf, autosave, tabCount: () => tabs.length, run: (c: Command) => run(c),
    allDocs: () => tabs.map((t) => t.doc),
    exportBatch: async (d: EditorDoc, groups: string[][]) => (await import('./exporter')).exportBatch(d, groups),
  };
}

start();
