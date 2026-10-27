// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../shared/i18n';
import { app, safeStorage, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, screen, session, shell } from 'electron';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OpenedFile, RecentFile, ThemeSetting } from '../shared/api';
import type { WindowCommand } from '../shared/commands';
import { buildMenu } from './menu';
import { catalog, loadLocale } from './locale';
import { CONVERTIBLE } from '../shared/api';
import { findOffice, htmlToPdf, officeToPdf, urlToPdf } from './convert';
import { ensurePacks, packPath, packStatus, removePacks } from './packs';
import { aiStatus, ask, listModels, removeKey, saveConfig } from './ai';
import { forget as forgetDevice, linkStatus, sendToDevice, startLink, startPairing } from './link';
import { checkForUpdates, installUpdate, startUpdates } from './updates';
import { defaultAppState, makeDefaultApp } from './default-app';
import { openForThisDevice, receiveCode } from './device-key';
import { fetchPickup, forgetPickup, startSending, stopSending } from './pickup';

// Lets tests run with a clean profile. Ignored in packaged builds.
if (!app.isPackaged && process.env.INKLEAF_USER_DATA) app.setPath('userData', process.env.INKLEAF_USER_DATA);

// The renderer is served from app://inkleaf/ rather than file://, which gives
// it a proper origin (so CSP 'self' means something) and keeps it from
// reading arbitrary files off disk.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const rendererDir = path.join(__dirname, 'renderer');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.gz': 'application/gzip',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

async function serveAppFile(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== 'inkleaf') return new Response('Not found', { status: 404 });

  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.normalize(path.join(rendererDir, relative));
  if (relative.startsWith('packs/')) {
    // language packs: the text-recognition models that ship with the app,
    // then whatever has been downloaded
    const name = relative.slice('packs/'.length);
    const bundled = name.startsWith('ocr/') ? path.join(rendererDir, 'vendor', 'tesseract', 'lang', path.basename(name)) : null;
    const found = bundled && existsSync(bundled) ? bundled : packPath(name);
    if (!found) return new Response('Not found', { status: 404 });
    file = found;
  } else if (!file.startsWith(rendererDir + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const body = await fs.readFile(file);
    const headers: Record<string, string> = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
    return new Response(body, { headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// --- windows ---------------------------------------------------------------

interface WindowContext {
  win: BrowserWindow;
  /** Paths this window may overwrite: ones the user opened or picked in Save As. */
  allowedPaths: Set<string>;
  hasDocument: boolean;
  dirty: boolean;
  dirtyCount: number;
  dirtyName: string;
  title: string;
  closeConfirmed: boolean;
  ready: boolean;
  pendingFiles: OpenedFile[];
}

const windows = new Map<number, WindowContext>();

function contextFor(sender: Electron.WebContents): WindowContext {
  const ctx = windows.get(sender.id);
  if (!ctx) throw new Error(t('Unknown window'));
  return ctx;
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// --- small settings & recent files --------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  try {
    writeFileSync(file, JSON.stringify(value));
  } catch {
    // losing a setting isn't worth an error dialog
  }
}

// The window frame is the same deep green in both themes, so the native
// window buttons drawn over it need light symbols either way.
const FRAME = { light: '#123b2f', dark: '#0d241d' };
const FRAME_SYMBOLS = '#d9e8e1';
const TITLEBAR_HEIGHT = 40;

function frameColour() {
  return nativeTheme.shouldUseDarkColors ? FRAME.dark : FRAME.light;
}

function applyTheme(setting: ThemeSetting) {
  nativeTheme.themeSource = setting;
  for (const ctx of windows.values()) {
    if (process.platform !== 'darwin' && !ctx.win.isDestroyed()) {
      ctx.win.setTitleBarOverlay({ color: frameColour(), symbolColor: FRAME_SYMBOLS, height: TITLEBAR_HEIGHT });
    }
  }
}

const MAX_RECENT = 12;

function recentList(): RecentFile[] {
  return readJson<RecentFile[]>(recentFile(), []).filter((r) => r && typeof r.path === 'string');
}

function rememberRecent(filePath: string) {
  const previous = recentList();
  const old = previous.find((r) => r.path === filePath);
  const entry: RecentFile = { path: filePath, name: path.basename(filePath), openedAt: Date.now(), thumb: old?.thumb ?? null };
  writeJson(recentFile(), [entry, ...previous.filter((r) => r.path !== filePath)].slice(0, MAX_RECENT));
  app.addRecentDocument(filePath);
}

function loadBounds(): Electron.Rectangle | null {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8'));
    // only reuse it if it still fits on a connected display
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x >= a.x - 50 && saved.y >= a.y - 50 && saved.x < a.x + a.width && saved.y < a.y + a.height;
    });
    return visible ? saved : null;
  } catch {
    return null;
  }
}

function saveBounds(win: BrowserWindow) {
  if (win.isMinimized() || win.isFullScreen()) return;
  try {
    writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()));
  } catch {
    // not worth bothering anyone about
  }
}

function createWindow(fileToOpen?: OpenedFile): BrowserWindow {
  const saved = loadBounds();
  // cascade new windows slightly so they don't stack perfectly
  const offset = windows.size * 28;
  const win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 840,
    x: saved ? saved.x + offset : undefined,
    y: saved ? saved.y + offset : undefined,
    minWidth: 760,
    minHeight: 520,
    title: 'Inkleaf',
    backgroundColor: frameColour(),
    show: false,
    // our own title bar: the app draws the tabs, the OS draws the window buttons
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: frameColour(), symbolColor: FRAME_SYMBOLS, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  const ctx: WindowContext = {
    win,
    allowedPaths: new Set(),
    hasDocument: false,
    dirty: false,
    dirtyCount: 0,
    dirtyName: '',
    title: 'Inkleaf',
    closeConfirmed: false,
    ready: false,
    pendingFiles: fileToOpen ? [fileToOpen] : [],
  };
  const id = win.webContents.id;
  windows.set(id, ctx);
  if (fileToOpen?.path) ctx.allowedPaths.add(fileToOpen.path);

  win.once('ready-to-show', () => win.show());
  win.loadURL('app://inkleaf/index.html');

  // Links inside PDFs open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://inkleaf/')) event.preventDefault();
  });

  win.on('close', (event) => {
    saveBounds(win);
    if (!ctx.dirty || ctx.closeConfirmed) return;
    event.preventDefault();

    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [t('Save'), t('Don’t save'), t('Cancel')],
      defaultId: 0,
      cancelId: 2,
      message: ctx.dirtyCount > 1
        ? t('You have unsaved changes in {count} documents. Save them?', { count: ctx.dirtyCount })
        : t('Do you want to save the changes you made to “{name}”?', { name: ctx.dirtyName || ctx.title }),
      detail: t('Your changes will be lost if you don’t save them.'),
    });
    if (choice === 1) {
      ctx.closeConfirmed = true;
      win.close();
    } else if (choice === 0) {
      win.webContents.send('save-before-close');
    }
  });

  win.on('closed', () => windows.delete(id));
  return win;
}

async function readPdf(filePath: string): Promise<OpenedFile> {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase().slice(1);
  if (ext !== 'pdf' && !CONVERTIBLE.includes(ext)) {
    throw new Error(t('Inkleaf opens PDFs, and documents, spreadsheets, slides, text and pictures it can turn into PDFs.'));
  }
  const data = await fs.readFile(resolved);
  if (ext !== 'pdf') {
    // converted files open as new, unsaved PDFs: the original is never
    // written to, so it doesn't get a path or a place in recent files
    return { path: null, name: path.basename(resolved), data: new Uint8Array(data) };
  }
  rememberRecent(resolved);
  return { path: resolved, name: path.basename(resolved), data: new Uint8Array(data) };
}

/** A file sent from a paired phone: opens as a new, unsaved tab in the last window used. */
function openFromPhone(file: OpenedFile) {
  const focused = BrowserWindow.getFocusedWindow();
  const target = (focused && windows.get(focused.webContents.id)) ?? [...windows.values()].find((c) => !c.win.isDestroyed());
  if (target) {
    deliver(target, file);
    target.win.flashFrame(!target.win.isFocused());
  } else {
    createWindow(file);
  }
}

/** Opens a file from the OS (double-click, command line, dock). */
async function openFromSystem(filePath: string) {
  let file: OpenedFile;
  try {
    file = await readPdf(filePath);
  } catch (err) {
    dialog.showErrorBox(t('Couldn’t open file'), `${filePath}\n\n${(err as Error).message}`);
    return;
  }
  // Open it as a new tab in the window you were last using.
  const focused = BrowserWindow.getFocusedWindow();
  const target = (focused && windows.get(focused.webContents.id)) ?? [...windows.values()].find((c) => !c.win.isDestroyed());
  if (target) {
    if (file.path) target.allowedPaths.add(file.path);
    deliver(target, file);
    if (target.win.isMinimized()) target.win.restore();
    target.win.focus();
  } else {
    createWindow(file);
  }
}

function deliver(ctx: WindowContext, file: OpenedFile) {
  if (ctx.ready) ctx.win.webContents.send('open-file', file);
  else ctx.pendingFiles.push(file);
}

function pdfArgs(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((arg) => {
      const ext = path.extname(arg).toLowerCase().slice(1);
      return !arg.startsWith('-') && (ext === 'pdf' || CONVERTIBLE.includes(ext)) && existsSync(arg);
    });
}

async function writeFileSafely(target: string, data: Uint8Array) {
  // Write next to the target first so a crash or full disk never leaves the
  // user with half a PDF where their document used to be.
  const temp = `${target}.inkleaf-${process.pid}.tmp`;
  await fs.writeFile(temp, data);
  try {
    await fs.rename(temp, target);
  } catch {
    await fs.writeFile(target, data);
    await fs.rm(temp, { force: true });
  }
}

const backupsDir = () => path.join(app.getPath('userData'), 'Backups');
const recoveryDir = () => path.join(app.getPath('userData'), 'Recovery');
const backedUp = new Set<string>();
let recoveryListed = false;
const MAX_BACKUPS = 40;

/** Recovery ids come from the renderer: keep them to safe file names. */
function recoveryId(id: string): string | null {
  const s = String(id);
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

/** Keeps the newest backups only, so the folder can't grow forever. */
async function pruneBackups(dir: string) {
  const files = await Promise.all((await fs.readdir(dir)).filter((n) => n.endsWith('.pdf')).map(async (n) => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })));
  files.sort((a, b) => b.t - a.t);
  for (const f of files.slice(MAX_BACKUPS)) await fs.rm(path.join(dir, f.n), { force: true });
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 180);
  return cleaned || 'document.pdf';
}

function runWindowCommand(command: WindowCommand, win: BrowserWindow | null) {
  if (command === 'new-window') createWindow();
  else if (command === 'quit') app.quit();
  else if (!win) return;
  else if (command === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  else if (command === 'devtools' && !app.isPackaged) win.webContents.toggleDevTools();
}

// --- IPC -------------------------------------------------------------------

// --- terms ------------------------------------------------------------------
// The Windows installer and the macOS disk image show the terms before
// installing. The portable and Linux builds have no such page, so the app
// asks once on first start instead. Bump this when the terms change.
const TERMS_VERSION = '2026-10-26';
const legalFile = () => path.join(app.getPath('userData'), 'legal.json');

function needsAgreement(): boolean {
  if (!app.isPackaged) return false;
  const installed = (process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE) || process.platform === 'darwin';
  if (installed) return false;
  try {
    return JSON.parse(readFileSync(legalFile(), 'utf8')).agreed !== TERMS_VERSION;
  } catch {
    return true;
  }
}

function registerIpc() {
  ipcMain.handle('packs:status', () => packStatus());
  ipcMain.handle('packs:ensure', (event, names: unknown) => {
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) throw new Error(t('Bad request.'));
    return ensurePacks(names, event.sender);
  });
  ipcMain.handle('packs:remove', (_event, prefix: unknown) => removePacks(typeof prefix === 'string' ? prefix : ''));
  ipcMain.handle('app:agree-terms', async () => {
    await fs.writeFile(legalFile(), JSON.stringify({ agreed: TERMS_VERSION, at: new Date().toISOString() }));
  });
  ipcMain.handle('app:info', () => ({
    needsAgreement: needsAgreement(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    userName: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })(),
  }));

  ipcMain.handle('file:open-dialog', async (event) => {
    const ctx = contextFor(event.sender);
    const result = await dialog.showOpenDialog(ctx.win, {
      title: t('Open'),
      properties: ['openFile'],
      filters: [
        { name: t('PDFs and files Inkleaf can convert'), extensions: ['pdf', ...CONVERTIBLE] },
        { name: t('PDF documents'), extensions: ['pdf'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = await readPdf(result.filePaths[0]);
    if (file.path) ctx.allowedPaths.add(file.path);
    return file;
  });

  ipcMain.handle('file:open-path', async (event, filePath: string) => {
    const ctx = contextFor(event.sender);
    const file = await readPdf(String(filePath));
    if (file.path) ctx.allowedPaths.add(file.path);
    return file;
  });

  ipcMain.handle('file:pick-convertible', async (event) => {
    const ctx = contextFor(event.sender);
    const result = await dialog.showOpenDialog(ctx.win, {
      title: t('Choose files to convert to PDF'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('Documents, spreadsheets, slides, text and pictures'), extensions: CONVERTIBLE },
        { name: 'Word', extensions: ['docx', 'doc', 'odt', 'rtf'] },
        { name: 'Excel', extensions: ['xlsx', 'xls', 'ods', 'csv'] },
        { name: 'PowerPoint', extensions: ['pptx', 'ppt', 'odp'] },
        { name: t('Text and web pages'), extensions: ['txt', 'md', 'markdown', 'html', 'htm'] },
        { name: t('Pictures'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
      ],
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(async (p) => ({ name: path.basename(p), data: new Uint8Array(await fs.readFile(p)) })));
  });

  ipcMain.handle('convert:office-available', () => !!findOffice());
  ipcMain.handle('convert:office', (_event, name: string, data: Uint8Array) => officeToPdf(String(name), data));
  ipcMain.handle('convert:html', (_event, html: string, page) => htmlToPdf(String(html), page ?? {}));
  ipcMain.handle('convert:url', (_event, address: string) => urlToPdf(String(address)));

  ipcMain.handle('link:status', () => linkStatus());
  ipcMain.handle('link:pair', () => startPairing());
  ipcMain.handle('link:send', (_event, id: unknown, name: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string' || !(data instanceof Uint8Array)) throw new Error(t('Bad request.'));
    sendToDevice(id, name, data);
  });
  ipcMain.handle('link:forget', (_event, id: unknown) => forgetDevice(String(id)));
  ipcMain.handle('ai:status', () => aiStatus());
  ipcMain.handle('ai:save', (_event, config) => saveConfig(config ?? {}));
  ipcMain.handle('ai:models', (_event, config) => listModels(config ?? {}));
  ipcMain.handle('ai:remove-key', (_event, provider) => removeKey(provider));
  ipcMain.handle('ai:ask', (_event, request) => ask(request));

  ipcMain.handle('file:pick-pdfs', async (event, title?: unknown) => {
    const ctx = contextFor(event.sender);
    const result = await dialog.showOpenDialog(ctx.win, {
      title: typeof title === 'string' && title.length < 120 ? title : t('Choose PDFs to insert'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('PDF documents'), extensions: ['pdf'] }],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (p) => ({ name: path.basename(p), data: new Uint8Array(await fs.readFile(p)) })),
    );
  });

  ipcMain.handle('file:save', async (event, target: string, data: Uint8Array) => {
    const ctx = contextFor(event.sender);
    const resolved = path.resolve(String(target));
    if (!ctx.allowedPaths.has(resolved)) {
      throw new Error(t('This window isn’t allowed to write to that location. Use Save As instead.'));
    }
    await writeFileSafely(resolved, data);
    rememberRecent(resolved);
  });

  ipcMain.handle('file:save-as', async (event, data: Uint8Array, suggestedName: string) => {
    const ctx = contextFor(event.sender);
    const result = await dialog.showSaveDialog(ctx.win, {
      title: t('Save PDF'),
      defaultPath: safeFileName(suggestedName),
      filters: [{ name: t('PDF document'), extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    let target = result.filePath;
    if (!target.toLowerCase().endsWith('.pdf')) target += '.pdf';
    await writeFileSafely(target, data);
    ctx.allowedPaths.add(target);
    rememberRecent(target);
    return target;
  });

  ipcMain.handle('file:save-many', async (event, files: { name: string; data: Uint8Array }[]) => {
    const ctx = contextFor(event.sender);
    const result = await dialog.showOpenDialog(ctx.win, {
      title: t('Choose a folder for the new files'),
      buttonLabel: 'Save Here',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];

    for (const file of files) {
      // pictures from "PDF to images" keep their type; anything else is a PDF
      const ext = /\.(png|jpe?g)$/i.exec(file.name)?.[0].toLowerCase() ?? '.pdf';
      const base = safeFileName(file.name).replace(/\.(pdf|png|jpe?g)$/i, '');
      let target = path.join(folder, `${base}${ext}`);
      for (let n = 2; existsSync(target); n++) target = path.join(folder, `${base} (${n})${ext}`);
      await writeFileSafely(target, file.data);
    }
    return folder;
  });

  ipcMain.handle('file:save-copy', async (event, data: Uint8Array, suggestedName: string, kind: string) => {
    const ctx = contextFor(event.sender);
    const kinds: Record<string, [string, string, string]> = {
      pdf: [t('PDF document'), 'pdf', t('Save a copy')], docx: [t('Word document'), 'docx', t('Save Word document')],
      xlsx: [t('Excel workbook'), 'xlsx', t('Save Excel workbook')], pptx: [t('PowerPoint presentation'), 'pptx', t('Save PowerPoint presentation')],
      txt: [t('Plain text'), 'txt', t('Save text file')], png: [t('PNG picture'), 'png', t('Save picture')], md: [t('Markdown'), 'md', t('Save Markdown file')], html: [t('Web page'), 'html', t('Save web page')],
    };
    const [label, ext, title] = kinds[kind] ?? kinds.pdf;
    const result = await dialog.showSaveDialog(ctx.win, {
      title,
      defaultPath: safeFileName(suggestedName),
      filters: [{ name: label, extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return null;
    let target = result.filePath;
    if (!target.toLowerCase().endsWith(`.${ext}`)) target += `.${ext}`;
    // refuse to overwrite the document that's open in this window: a copy
    // should never silently replace the original
    if (ctx.allowedPaths.has(path.resolve(target)) && ext === 'pdf') {
      throw new Error(t('That’s the file you’re editing. Choose a different name for the copy.'));
    }
    await writeFileSafely(target, data);
    if (ext === 'pdf') rememberRecent(target);
    return target;
  });

  ipcMain.handle('file:pick-images', async (event) => {
    const ctx = contextFor(event.sender);
    const result = await dialog.showOpenDialog(ctx.win, {
      title: t('Choose pictures'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('Pictures'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (p) => ({ name: path.basename(p), data: new Uint8Array(await fs.readFile(p)) })),
    );
  });

  ipcMain.handle('window:print', (event) => new Promise((resolve) => {
    event.sender.print({ printBackground: true, margins: { marginType: 'none' } }, (ok, reason) => resolve({ ok, reason }));
  }));

  // --- auto-save safety nets ---------------------------------------------------
  // Backups: the first time a file is auto-saved over in a session, the
  // original is copied here, so trying something out never costs the file.
  ipcMain.handle('backup:original', async (event, target: string) => {
    const ctx = contextFor(event.sender);
    const resolved = path.resolve(String(target));
    if (!ctx.allowedPaths.has(resolved) || backedUp.has(resolved) || !existsSync(resolved)) return;
    backedUp.add(resolved);
    const dir = backupsDir();
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    await fs.copyFile(resolved, path.join(dir, `${path.basename(resolved, '.pdf')} (${stamp}).pdf`));
    await pruneBackups(dir);
  });
  ipcMain.on('backup:open', async () => {
    await fs.mkdir(backupsDir(), { recursive: true });
    shell.openPath(backupsDir());
  });

  // Recovery: copies of unsaved work, written every minute or so, deleted
  // once the work is saved or the tab is closed. Anything left at start-up
  // means the app didn't close normally.
  ipcMain.handle('recovery:write', async (_event, id: string, name: string, filePath: string | null, data: Uint8Array) => {
    const safe = recoveryId(id);
    if (!safe) return;
    const dir = recoveryDir();
    await fs.mkdir(dir, { recursive: true });
    await writeFileSafely(path.join(dir, `${safe}.pdf`), data);
    await fs.writeFile(path.join(dir, `${safe}.json`), JSON.stringify({ id: safe, name: String(name), path: filePath ? String(filePath) : null, savedAt: Date.now() }));
  });
  ipcMain.on('recovery:clear', (_event, id: string) => {
    const safe = recoveryId(id);
    if (!safe) return;
    for (const ext of ['.pdf', '.json']) fs.rm(path.join(recoveryDir(), `${safe}${ext}`), { force: true }).catch(() => {});
  });
  ipcMain.handle('recovery:list', async () => {
    // only once per run: files written by this session aren't "left behind"
    if (recoveryListed) return [];
    recoveryListed = true;
    try {
      const names = (await fs.readdir(recoveryDir())).filter((n) => n.endsWith('.json'));
      const list = await Promise.all(names.map(async (n) => {
        try {
          return JSON.parse(await fs.readFile(path.join(recoveryDir(), n), 'utf8'));
        } catch {
          return null;
        }
      }));
      return list.filter((r) => r && existsSync(path.join(recoveryDir(), `${r.id}.pdf`)));
    } catch {
      return [];
    }
  });
  ipcMain.handle('recovery:read', async (_event, id: string) => {
    const safe = recoveryId(id);
    if (!safe) throw new Error(t('Unknown recovered file'));
    const data = new Uint8Array(await fs.readFile(path.join(recoveryDir(), `${safe}.pdf`)));
    return data;
  });

  ipcMain.on('update:check', () => checkForUpdates(true));
  ipcMain.on('update:install', () => installUpdate());

  ipcMain.on('file:show-in-folder', (event, target: string) => {
    const ctx = contextFor(event.sender);
    const resolved = path.resolve(String(target));
    if (ctx.allowedPaths.has(resolved) || existsSync(resolved)) shell.showItemInFolder(resolved);
  });

  ipcMain.on('window:document-state', (event, state: { title: string; dirty: boolean; path: string | null; dirtyCount?: number; dirtyName?: string }) => {
    const ctx = contextFor(event.sender);
    ctx.dirtyCount = state.dirtyCount ?? (state.dirty ? 1 : 0);
    ctx.dirtyName = state.dirtyName ?? '';
    ctx.dirty = ctx.dirtyCount > 0;
    ctx.hasDocument = !!state.title;
    ctx.title = state.title || 'Inkleaf';
    ctx.win.setTitle(state.title ? `${state.title}${state.dirty ? ' •' : ''} — Inkleaf` : 'Inkleaf');
    ctx.win.setDocumentEdited(!!state.dirty);
    if (process.platform === 'darwin') ctx.win.setRepresentedFilename(state.path ?? '');
  });

  ipcMain.handle('recent:list', () => recentList().filter((r) => existsSync(r.path)));
  ipcMain.handle('recent:open', async (event, filePath: string) => {
    const ctx = contextFor(event.sender);
    const known = recentList().some((r) => r.path === filePath);
    if (!known) throw new Error(t('That file isn’t in your recent list.'));
    const file = await readPdf(filePath);
    ctx.allowedPaths.add(file.path!);
    return file;
  });
  ipcMain.on('recent:thumb', (_event, filePath: string, thumb: string) => {
    if (typeof thumb !== 'string' || !thumb.startsWith('data:image/') || thumb.length > 200_000) return;
    const list = recentList();
    const entry = list.find((r) => r.path === filePath);
    if (!entry) return;
    entry.thumb = thumb;
    writeJson(recentFile(), list);
  });
  ipcMain.handle('recent:forget', (_event, filePath: string) => {
    writeJson(recentFile(), recentList().filter((r) => r.path !== filePath));
  });

  // the renderer needs its words before any of its code runs, hence sync
  ipcMain.on('i18n:catalog', (event) => {
    event.returnValue = catalog();
  });
  ipcMain.handle('i18n:choice', () => readJson<{ language?: string }>(settingsFile(), {}).language ?? 'system');
  ipcMain.handle('i18n:set', (_event, choice: unknown) => {
    if (typeof choice !== 'string' || !/^(system|[a-z]{2}(-[A-Z]{2})?)$/.test(choice)) return false;
    writeJson(settingsFile(), { ...readJson(settingsFile(), {}), language: choice });
    // a clean restart, so every window and the menu switch together; the
    // usual "save your changes?" questions still come first
    app.relaunch();
    app.quit();
    return true;
  });
  // "Make Inkleaf my default PDF app": whether it is, and whether the start
  // screen should still offer it (not once someone has said "Not now")
  ipcMain.handle('default-app:state', async () => ({
    state: await defaultAppState(),
    dismissed: !!readJson<{ defaultAppDismissed?: boolean }>(settingsFile(), {}).defaultAppDismissed,
  }));
  ipcMain.handle('default-app:make', () => makeDefaultApp());
  // PDFs locked to this computer (shared/lock.ts)
  ipcMain.handle('lock:receive-code', () => receiveCode());
  // files sent with a pickup code (already encrypted by the window)
  ipcMain.handle('pickup:send', (event, id: unknown, check: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof check !== 'string' || !(data instanceof Uint8Array)) throw new Error(t('Nothing to send.'));
    const sender = event.sender;
    return startSending(id, check, data, (e) => { if (!sender.isDestroyed()) sender.send('pickup:event', e); });
  });
  ipcMain.on('pickup:stop', (_event, id: unknown) => stopSending(String(id)));
  ipcMain.handle('pickup:fetch', (_event, id: unknown, check: unknown, nearby: unknown) =>
    fetchPickup(String(id), String(check), Array.isArray(nearby) ? nearby.map(String) : []));
  ipcMain.handle('pickup:forget', (_event, id: unknown, token: unknown) => forgetPickup(String(id), String(token)));
  ipcMain.handle('lock:open', (_event, data: unknown) => {
    if (!(data instanceof Uint8Array)) throw new Error(t('That isn’t a locked PDF.'));
    return openForThisDevice(data);
  });
  ipcMain.on('default-app:dismiss', () => {
    writeJson(settingsFile(), { ...readJson(settingsFile(), {}), defaultAppDismissed: true });
  });
  ipcMain.handle('theme:get', () => readJson<{ theme?: ThemeSetting }>(settingsFile(), {}).theme ?? 'system');
  ipcMain.on('theme:set', (_event, theme: ThemeSetting) => {
    if (!['system', 'light', 'dark'].includes(theme)) return;
    writeJson(settingsFile(), { ...readJson(settingsFile(), {}), theme });
    applyTheme(theme);
  });
  ipcMain.on('window:command', (event, command: WindowCommand) => {
    runWindowCommand(command, contextFor(event.sender).win);
  });

  ipcMain.on('app:open-external', (_event, url: string) => {
    if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url));
  });

  ipcMain.on('edit:native', (event, command: string) => {
    const wc = event.sender;
    if (command === 'undo') wc.undo();
    else if (command === 'redo') wc.redo();
    else if (command === 'copy') wc.copy();
    else if (command === 'cut') wc.cut();
    else if (command === 'paste') wc.paste();
  });

  ipcMain.on('window:ready', (event) => {
    const ctx = contextFor(event.sender);
    ctx.ready = true;
    for (const file of ctx.pendingFiles.splice(0)) ctx.win.webContents.send('open-file', file);
  });

  ipcMain.on('window:save-before-close-done', (event, saved: boolean) => {
    const ctx = contextFor(event.sender);
    if (saved) {
      ctx.closeConfirmed = true;
      ctx.win.close();
    }
  });
}

// --- app lifecycle ---------------------------------------------------------

const openQueue: string[] = [];

// macOS delivers double-clicked files through this event, possibly before ready
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) openFromSystem(filePath);
  else openQueue.push(filePath);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const files = pdfArgs(argv);
    if (files.length) files.forEach(openFromSystem);
    else {
      const first = [...windows.values()][0]?.win;
      if (first) {
        if (first.isMinimized()) first.restore();
        first.focus();
      } else createWindow();
    }
  });

  app.whenReady().then(async () => {
    // tests on a Linux box without a keychain still need to store AI keys
    if (!app.isPackaged && process.env.INKLEAF_TEST_PLAIN_KEYS && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
    protocol.handle('app', serveAppFile);
    // Our own pages may list the fonts installed on this computer (for the
    // font picker); nothing else gets a browser permission.
    // camera only, for Scan to PDF; it asks the system the first time
    const allowed = new Set(['local-fonts', 'clipboard-sanitized-write', 'media']);
    const ours = (url: string) => url.startsWith('app://');
    session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
      const audio = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.includes('audio');
      done(allowed.has(permission) && !audio && ours(wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && ours(origin || wc?.getURL() || ''));
    applyTheme(readJson<{ theme?: ThemeSetting }>(settingsFile(), {}).theme ?? 'system');
    loadLocale(readJson<{ language?: string }>(settingsFile(), {}).language);
    nativeTheme.on('updated', () => applyTheme(nativeTheme.themeSource as ThemeSetting));
    registerIpc();
    buildMenu((command, win) => runWindowCommand(command, win));

    startLink({
      onEvent: (event) => {
        for (const ctx of windows.values()) if (!ctx.win.isDestroyed()) ctx.win.webContents.send('link:event', event);
      },
      onFile: (file) => openFromPhone({ path: null, name: file.name, data: file.data }),
    });

    startUpdates((state) => {
      for (const ctx of windows.values()) if (!ctx.win.isDestroyed()) ctx.win.webContents.send('update', state);
    });

    const files = [...openQueue.splice(0), ...pdfArgs(process.argv)];
    if (files.length === 0) createWindow();
    for (const file of files) {
      try {
        createWindow(await readPdf(file));
      } catch (err) {
        dialog.showErrorBox(t('Couldn’t open file'), `${file}\n\n${(err as Error).message}`);
      }
    }
    if (windows.size === 0) createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
