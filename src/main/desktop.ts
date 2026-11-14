// SPDX-License-Identifier: GPL-3.0-or-later
// The ways Inkleaf fits into the desktop around it:
//
// - starting when you sign in, quietly, with just an icon in the tray, so a
//   PDF you double-click opens straight away
// - staying in the tray when its last window is closed (if you want that)
// - opening PDFs as soon as a browser has finished downloading them
// - "Combine", "Print" and "Compress" on PDFs, and "Make a PDF" on pictures
//   and documents, in File Explorer's right-click menu (Windows installer)
// - recent files and "New window" on the taskbar button (Windows)
//
// Each is a setting (see desktopSettings below). The window shows them in
// Settings; this file does the work.

import { t } from '../shared/i18n';
import { app, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONVERTIBLE, type DesktopSettings, type DesktopSettingsState } from '../shared/api';

export const DESKTOP_DEFAULTS: DesktopSettings = {
  startAtLogin: false,
  keepInTray: false,
  openDownloads: true,
  reopenSession: true,
  explorerMenu: true,
};

/** What desktop.ts needs from the rest of the app. */
export interface DesktopHost {
  read(): Partial<DesktopSettings> & Record<string, unknown>;
  write(values: Record<string, unknown>): void;
  /** Shows a window: the one in use, or a new one (with last session's files, if that's on). */
  show(): void;
  openDialog(): void;
  newWindow(): void;
  openFiles(paths: string[]): void;
  recent(): { path: string; name: string }[];
  windowCount(): number;
}

let host: DesktopHost;

export function desktopSettings(): DesktopSettings {
  const saved = host.read();
  const out = { ...DESKTOP_DEFAULTS };
  for (const key of Object.keys(DESKTOP_DEFAULTS) as (keyof DesktopSettings)[]) {
    if (typeof saved[key] === 'boolean') out[key] = saved[key] as boolean;
  }
  return out;
}

const isWindows = process.platform === 'win32';
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
const isStore = () => !!process.windowsStore;

/** The program to start: the portable .exe itself (not its unpacked copy), or this one. */
const program = () => process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;

function run(file: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// --- what Inkleaf was started with ---------------------------------------------------------------

export type LaunchIntent = 'open' | 'merge' | 'combine' | 'print' | 'compress';

export interface Launch {
  /** Started at sign-in: no window, just the tray icon. */
  hidden: boolean;
  newWindow: boolean;
  openDialog: boolean;
  intent: LaunchIntent;
  files: string[];
}

const INTENTS: Record<string, LaunchIntent> = { '--merge': 'merge', '--combine': 'combine', '--print': 'print', '--compress': 'compress' };

/** Reads Inkleaf's own switches and the files to open; Chromium's own switches are ignored. */
export function parseLaunch(argv: string[], skip: number): Launch {
  const launch: Launch = { hidden: false, newWindow: false, openDialog: false, intent: 'open', files: [] };
  for (const arg of argv.slice(skip)) {
    if (arg === '--hidden') launch.hidden = true;
    else if (arg === '--new-window') launch.newWindow = true;
    else if (arg === '--open') launch.openDialog = true;
    else if (INTENTS[arg]) launch.intent = INTENTS[arg];
    else if (!arg.startsWith('-')) {
      const ext = path.extname(arg).toLowerCase().slice(1);
      if ((ext === 'pdf' || CONVERTIBLE.includes(ext)) && existsSync(arg)) launch.files.push(path.resolve(arg));
    }
  }
  return launch;
}

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
export const isImage = (file: string) => IMAGE.has(path.extname(file).toLowerCase().slice(1));

/**
 * File Explorer starts Inkleaf once for each file picked (for "Combine" with
 * five PDFs, five times in a row), so files that arrive close together are
 * gathered up and handled as one batch.
 */
export class Batcher {
  private files: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly wait: number, private readonly done: (files: string[]) => void) {}
  add(files: string[]) {
    for (const f of files) if (!this.files.includes(f)) this.files.push(f);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = this.files.splice(0);
      if (batch.length) this.done(batch);
    }, this.wait);
  }
}

/** In name order, with numbers counted properly (page 2 before page 10). */
export const byName = (files: string[]) =>
  [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' }));

// --- starting at sign-in ---------------------------------------------------------------------

const STORE_TASK = 'InkleafStartup';

/**
 * The Flatpak can't write to ~/.config/autostart, so it asks the desktop
 * through the Background portal instead, which writes the entry for it.
 * The answer comes back later and there's no way to read the entry, so
 * Inkleaf's own setting is taken as the state.
 */
const inFlatpak = () => process.platform === 'linux' && !!process.env.FLATPAK_ID;

async function flatpakAutostart(on: boolean): Promise<void> {
  const reason = t('Opens PDFs straight away. InkLeaf PDF waits in the tray.').replace(/'/g, '’').replace(/\\/g, ' ');
  const options = `{'reason': <'${reason}'>, 'autostart': <${on}>, 'commandline': <['inkleaf', '--hidden']>, 'dbus-activatable': <false>}`;
  await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop',
    '--method', 'org.freedesktop.portal.Background.RequestBackground', '', options]);
}

/** Linux: a desktop entry in ~/.config/autostart, the place every desktop looks. */
function autostartFile() {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'inkleaf.desktop');
}

function linuxCommand(): string {
  const quote = (s: string) => `"${s.replace(/(["\\`$])/g, '\\$1')}"`;
  // from source, Electron needs to be told where the app is
  return app.isPackaged ? `${quote(program())} --hidden` : `${quote(process.execPath)} ${quote(app.getAppPath())} --hidden`;
}

/** The Microsoft Store version's startup task, through Windows' own StartupTask API. */
async function storeStartupTask(action: 'get' | 'enable' | 'disable'): Promise<string> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Wait-Op($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$task.Wait(-1); $task.Result }
[void][Windows.ApplicationModel.StartupTask, Windows.ApplicationModel, ContentType = WindowsRuntime]
$task = Wait-Op ([Windows.ApplicationModel.StartupTask]::GetAsync('${STORE_TASK}')) ([Windows.ApplicationModel.StartupTask])
${action === 'enable' ? "[void](Wait-Op ($task.RequestEnableAsync()) ([Windows.ApplicationModel.StartupTaskState]))" : action === 'disable' ? '$task.Disable()' : ''}
"$($task.State)"
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded])).trim();
}

/** Whether the system will start Inkleaf at sign-in, and whether the person blocked it there. */
async function loginState(): Promise<{ on: boolean; blocked: boolean }> {
  if (isWindows && isStore()) {
    const state = await storeStartupTask('get').catch(() => 'Unknown');
    return { on: /^Enabled/.test(state), blocked: /DisabledBy(User|Policy)/.test(state) };
  }
  if (isWindows) {
    const s = app.getLoginItemSettings({ path: program(), args: ['--hidden'] });
    // switched off in Task Manager's Startup apps
    return { on: s.openAtLogin && s.executableWillLaunchAtLogin !== false, blocked: s.openAtLogin && s.executableWillLaunchAtLogin === false };
  }
  if (inFlatpak()) return { on: desktopSettings().startAtLogin, blocked: false };
  if (process.platform === 'linux') return { on: existsSync(autostartFile()), blocked: false };
  if (process.platform === 'darwin') return { on: app.getLoginItemSettings().openAtLogin, blocked: false };
  return { on: false, blocked: false };
}

async function setLogin(on: boolean): Promise<void> {
  if (isWindows && isStore()) {
    const state = await storeStartupTask(on ? 'enable' : 'disable');
    // turned off in Settings › Apps › Startup: only the person can turn it back on there
    if (on && /DisabledByUser/.test(state)) void shell.openExternal('ms-settings:startupapps');
    return;
  }
  if (isWindows) {
    app.setLoginItemSettings({ openAtLogin: on, path: program(), args: ['--hidden'] });
    return;
  }
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: on });
    return;
  }
  if (inFlatpak()) {
    await flatpakAutostart(on);
    return;
  }
  if (process.platform === 'linux') {
    const file = autostartFile();
    if (!on) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=InkLeaf PDF',
      `Comment=${t('Opens PDFs straight away. InkLeaf PDF waits in the tray.')}`,
      `Exec=${linuxCommand()}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  }
}

/** True when this start was the sign-in one (macOS doesn't pass --hidden, so it's asked). */
export function startedAtLogin(launch: Launch): boolean {
  if (launch.hidden) return true;
  if (process.platform === 'darwin') {
    try {
      return !!app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  }
  return false;
}

// --- the tray ----------------------------------------------------------------------------

let tray: Tray | null = null;

function trayIcon() {
  const file = path.join(__dirname, 'icon.png');
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return image;
  // a crisp 16 px icon, with a 32 px one for high-DPI screens
  const small = image.resize({ width: 16, height: 16, quality: 'best' });
  small.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: image.resize({ width: 32, height: 32, quality: 'best' }).toPNG() });
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18, quality: 'best' }) : small;
}

function trayMenu(): Menu {
  const s = desktopSettings();
  const recent = host.recent().slice(0, 8);
  return Menu.buildFromTemplate([
    { label: t('Open InkLeaf PDF'), click: () => host.show() },
    { label: t('Open a PDF…'), click: () => host.openDialog() },
    { label: t('New Window'), click: () => host.newWindow() },
    { type: 'separator' },
    {
      label: t('Recent Files'),
      enabled: recent.length > 0,
      submenu: recent.map((r) => ({ label: r.name.length > 48 ? `${r.name.slice(0, 45)}…` : r.name, click: () => host.openFiles([r.path]) })),
    },
    { type: 'separator' },
    { label: t('Open PDFs as soon as they’re downloaded'), type: 'checkbox', checked: s.openDownloads, click: (item) => void applyDesktopSettings({ openDownloads: item.checked }) },
    { label: t('Start InkLeaf PDF when I sign in'), type: 'checkbox', checked: s.startAtLogin, click: (item) => void applyDesktopSettings({ startAtLogin: item.checked }) },
    { type: 'separator' },
    { label: t('Quit InkLeaf PDF'), click: () => app.quit() },
  ]);
}

/** The tray icon shows while Inkleaf may run without a window. */
export function refreshTray(force = false) {
  const s = desktopSettings();
  const wanted = force || s.keepInTray || (host.windowCount() === 0 && app.isReady());
  if (!wanted) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('InkLeaf PDF');
    // a click opens Inkleaf; the menu is on right-click (and on every click on Linux)
    tray.on('click', () => host.show());
  }
  tray.setContextMenu(trayMenu());
}

/** Says once, the first time, where Inkleaf went when its last window closed. */
export function announceTray() {
  if (host.read().trayExplained) return;
  host.write({ trayExplained: true });
  const title = t('InkLeaf PDF is still running');
  const content = t('It’s in the tray, so PDFs open straight away. To quit, right-click its icon.');
  if (isWindows && tray) tray.displayBalloon({ title, content, iconType: 'info' });
  else if (Notification.isSupported()) new Notification({ title, body: content, silent: true }).show();
}

// --- downloads -----------------------------------------------------------------------------
//
// Browsers write a download under a temporary name (.crdownload, .part…)
// and rename it once it's complete, so a new .pdf appearing in Downloads is
// a finished download. Firefox leaves an empty placeholder first, so empty
// files are skipped; the size has to stay still for a moment; and the file
// must start like a PDF. Old files moved or copied in keep their old dates,
// so only ones made in the last couple of minutes count. Files Inkleaf saved
// there itself are left alone.

let watcher: FSWatcher | null = null;
const seen = new Map<string, number>();
const ownWrites = new Map<string, number>();

/** Inkleaf saved this file itself: it isn't a download. */
export function markOwnWrite(file: string) {
  ownWrites.set(path.resolve(file).toLowerCase(), Date.now());
}

export function downloadsFolder(): string {
  if (!app.isPackaged && process.env.INKLEAF_TEST_DOWNLOADS) return process.env.INKLEAF_TEST_DOWNLOADS;
  return app.getPath('downloads');
}

const FRESH_MS = 2 * 60_000;

async function settled(file: string): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      return false; // gone again (renamed or deleted)
    }
    if (size > 0 && size === last) return true;
    last = size;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function looksLikePdf(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const head = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return head.subarray(0, bytesRead).includes('%PDF-');
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Downloads being checked right now; the folder reports a change several times over. */
const checking = new Set<string>();

async function maybeDownloaded(file: string) {
  const key = file.toLowerCase();
  if (checking.has(key)) return;
  checking.add(key);
  try {
    await checkDownload(file, key);
  } finally {
    checking.delete(key);
  }
}

async function checkDownload(file: string, key: string) {
  const own = ownWrites.get(key);
  if (own && Date.now() - own < FRESH_MS) return;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return;
  }
  const now = Date.now();
  const fresh = (ms: number) => ms > 0 && now - ms < FRESH_MS;
  if (!stat.isFile() || !fresh(stat.mtimeMs) || (stat.birthtimeMs > 0 && !fresh(stat.birthtimeMs))) return;
  // each download once, however many times the folder says it changed
  if (seen.get(key) === stat.mtimeMs) return;
  seen.set(key, stat.mtimeMs);
  if (!(await settled(file)) || !(await looksLikePdf(file))) {
    seen.delete(key);
    return;
  }
  // the placeholder it started as may have been replaced by the real file meanwhile
  try {
    seen.set(key, statSync(file).mtimeMs);
  } catch {
    return;
  }
  if (!desktopSettings().openDownloads) return;
  host.openFiles([file]);
}

function watchDownloads() {
  stopWatchingDownloads();
  const folder = downloadsFolder();
  if (!existsSync(folder)) return;
  try {
    watcher = watch(folder, { persistent: false }, (_event, name) => {
      const file = name ? path.join(folder, name.toString()) : null;
      if (file && /\.pdf$/i.test(file)) void maybeDownloaded(file);
    });
    watcher.on('error', () => stopWatchingDownloads());
  } catch {
    watcher = null;
  }
}

function stopWatchingDownloads() {
  watcher?.close();
  watcher = null;
}

// --- File Explorer's right-click menu (Windows, installed copy) ------------------------------------
//
// Written for this user only, in their language, and removed again when
// switched off (and by the uninstaller). On Windows 11 these show under
// "Show more options"; the shorter menu only takes apps packaged differently.
// The Store version can't add to the menu: its registry is kept to itself.

const VERB_ROOT = 'HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations';
/** Kinds of file that "Make a PDF" appears on: pictures, and every document Inkleaf converts. */
const MAKE_PDF_ON = ['image', ...CONVERTIBLE.filter((e) => !IMAGE.has(e)).map((e) => `.${e}`)];

export const explorerMenuSupported = () => isWindows && app.isPackaged && !isPortable() && !isStore();

function regFile(lines: string[]): Buffer {
  // .reg files are UTF-16 with a byte-order mark
  return Buffer.from(`\ufeffWindows Registry Editor Version 5.00\r\n\r\n${lines.join('\r\n')}\r\n`, 'utf16le');
}

const regString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function verbLines(where: string, verb: string, label: string, flag: string): string[] {
  const exe = program();
  const key = `${VERB_ROOT}\\${where}\\shell\\Inkleaf.${verb}`;
  return [
    `[${key}]`,
    `"MUIVerb"=${regString(label)}`,
    `"Icon"=${regString(`"${exe}",0`)}`,
    // one start per file, gathered back up by Inkleaf (see Batcher)
    '"MultiSelectModel"="Player"',
    '',
    `[${key}\\command]`,
    `@=${regString(`"${exe}" ${flag} "%1"`)}`,
    '',
  ];
}

function explorerMenuReg(on: boolean): Buffer {
  const remove = [
    ...['Combine', 'Print', 'Compress'].map((v) => `[-${VERB_ROOT}\\.pdf\\shell\\Inkleaf.${v}]`),
    ...MAKE_PDF_ON.map((w) => `[-${VERB_ROOT}\\${w}\\shell\\Inkleaf.MakePdf]`),
    '',
  ];
  if (!on) return regFile(remove);
  return regFile([
    ...remove,
    ...verbLines('.pdf', 'Combine', t('Combine into one PDF with InkLeaf PDF'), '--merge'),
    ...verbLines('.pdf', 'Print', t('Print with InkLeaf PDF'), '--print'),
    ...verbLines('.pdf', 'Compress', t('Compress with InkLeaf PDF'), '--compress'),
    ...MAKE_PDF_ON.flatMap((w) => verbLines(w, 'MakePdf', t('Make a PDF with InkLeaf PDF'), '--combine')),
  ]);
}

/** Adds or removes the menu entries; only touches the registry when something changed. */
async function syncExplorerMenu(on: boolean) {
  if (!explorerMenuSupported()) return;
  const content = explorerMenuReg(on);
  const stamp = `${on ? 1 : 0}:${program()}:${content.length}:${content.toString('base64').slice(-64)}`;
  if (host.read().explorerMenuStamp === stamp) return;
  const file = path.join(os.tmpdir(), `inkleaf-menu-${process.pid}.reg`);
  try {
    writeFileSync(file, content);
    await run('reg', ['import', file]);
    host.write({ explorerMenuStamp: stamp });
  } catch {
    // tried again next start
  } finally {
    rmSync(file, { force: true });
  }
}

// --- the taskbar button's menu (Windows) ------------------------------------------------------

/** Recent files and "New window" when the taskbar button is right-clicked. */
export function refreshJumpList() {
  // the Store version is started through its package, not a path the list could hold
  if (!isWindows || !app.isPackaged || isStore()) return;
  const exe = program();
  const recent = host.recent().filter((r) => existsSync(r.path)).slice(0, 8);
  try {
    app.setJumpList([
      ...(recent.length ? [{
        type: 'custom' as const,
        name: t('Recent'),
        items: recent.map((r) => ({ type: 'task' as const, title: r.name, description: r.path, program: exe, args: `"${r.path}"`, iconPath: exe, iconIndex: 0 })),
      }] : []),
      {
        type: 'tasks',
        items: [
          { type: 'task', title: t('New Window'), description: t('Opens another InkLeaf PDF window'), program: exe, args: '--new-window', iconPath: exe, iconIndex: 0 },
          { type: 'task', title: t('Open a PDF…'), description: t('Pick a PDF to open'), program: exe, args: '--open', iconPath: exe, iconIndex: 0 },
        ],
      },
    ]);
  } catch {
    // an older Windows, or the list is turned off in taskbar settings
  }
}

// --- settings --------------------------------------------------------------------------------

export async function desktopState(): Promise<DesktopSettingsState> {
  const settings = desktopSettings();
  const login = await loginState().catch(() => ({ on: settings.startAtLogin, blocked: false }));
  return {
    ...settings,
    // what the system will actually do, which can differ after a change in Task Manager
    startAtLogin: login.on,
    startupBlocked: login.blocked,
    supports: {
      startAtLogin: true,
      tray: true,
      explorerMenu: explorerMenuSupported(),
    },
    platform: process.platform,
    downloads: downloadsFolder(),
  };
}

export async function applyDesktopSettings(change: Partial<DesktopSettings>): Promise<DesktopSettingsState> {
  const clean: Partial<DesktopSettings> = {};
  for (const key of Object.keys(DESKTOP_DEFAULTS) as (keyof DesktopSettings)[]) {
    if (typeof change[key] === 'boolean') clean[key] = change[key];
  }
  host.write(clean);
  if (clean.startAtLogin !== undefined) await setLogin(clean.startAtLogin).catch(() => {});
  if (clean.openDownloads !== undefined) {
    if (clean.openDownloads) watchDownloads();
    else stopWatchingDownloads();
  }
  if (clean.explorerMenu !== undefined) await syncExplorerMenu(clean.explorerMenu);
  refreshTray();
  return desktopState();
}

/** Starts everything that's switched on. */
export function startDesktop(h: DesktopHost) {
  host = h;
  const s = desktopSettings();
  if (s.openDownloads) watchDownloads();
  void syncExplorerMenu(s.explorerMenu);
  refreshJumpList();
}
