// SPDX-License-Identifier: GPL-3.0-or-later
// "Make Inkleaf my default PDF app".
//
// Windows doesn't let an app make itself the default (only the person can),
// so there we check whether Inkleaf already is, and if not, open the Default
// apps page in Settings, on Inkleaf's own entry where Windows supports that.
// The installer registers Inkleaf as a PDF app (build/installer.nsh); the
// Microsoft Store version is registered by its package.
//
// On Linux the desktop's own tool (xdg-mime) can set it straight away.
// The portable .exe, the AppImage and runs from source aren't installed, so
// there's nothing for the system to point PDFs at; those report "unsupported".

import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DefaultAppState = 'default' | 'not-default' | 'unsupported';
export type DefaultAppResult = 'done' | 'settings' | 'unsupported' | 'failed';

/** The Store package's name, from build.appx.identityName in package.json. */
const STORE_IDENTITY = 'PriyanshDas.InkLeaf';
/** The installer's own registration (build/installer.nsh). */
const REGISTERED_NAME = 'Inkleaf';

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** One value from `reg query`, or null when the key or value isn't there. */
async function regValue(key: string, name: string | null): Promise<string | null> {
  try {
    const out = await run('reg', ['query', key, ...(name === null ? ['/ve'] : ['/v', name])]);
    const line = out.split(/\r?\n/).find((l) => /\sREG_(?:EXPAND_)?SZ\s/.test(l));
    return line ? line.replace(/^.*?\sREG_(?:EXPAND_)?SZ\s+/, '').trim() : null;
  } catch {
    return null;
  }
}

// --- Windows ---------------------------------------------------------------------------------------

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

/** "PriyanshDas.InkLeaf_abc123xyz!Inkleaf", worked out from where the Store installed us. */
function storeAppId(): string | null {
  const m = /\\WindowsApps\\([^\\_]+\.[^\\_]+)_[^\\_]+_[^\\_]*_[^\\_]*_([a-z0-9]{10,16})\\/i.exec(process.execPath);
  return m ? `${m[1]}_${m[2]}!Inkleaf` : null;
}

/** The ProgID of the app the person chose for PDFs, wherever this Windows keeps it. */
async function chosenPdfProgId(): Promise<string | null> {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf';
  // Windows 11 since 2025 keeps the choice in UserChoiceLatest\ProgId (a key
  // holding a value of the same name) and stops updating UserChoice, which
  // then still names the app from before. So the newer place comes first.
  return (await regValue(`${base}\\UserChoiceLatest\\ProgId`, 'ProgId'))
    ?? (await regValue(`${base}\\UserChoiceLatest`, 'ProgId'))
    ?? (await regValue(`${base}\\UserChoice`, 'ProgId'));
}

async function windowsIsDefault(): Promise<boolean> {
  const progId = await chosenPdfProgId();
  if (!progId) return false;
  if (/^AppX/i.test(progId)) {
    const aumid = await regValue(`HKCU\\Software\\Classes\\${progId}\\Application`, 'AppUserModelID');
    return !!aumid && aumid.toLowerCase().startsWith(STORE_IDENTITY.toLowerCase());
  }
  if (progId === 'Inkleaf.pdf') return true;
  // picked with "Open with › Choose another app" instead: Applications\Inkleaf.exe
  const command = await regValue(`HKCR\\${progId}\\shell\\open\\command`, null);
  if (!command) return false;
  const exe = command.toLowerCase();
  return exe.includes(process.execPath.toLowerCase()) || exe.includes(`\\${path.basename(process.execPath).toLowerCase()}`);
}

// --- the preview pane and thumbnails in File Explorer ------------------------------------------------
//
// Explorer finds a file's previewer through the app that opens it. Edge (or
// Acrobat) registers one for PDFs on its own ProgID, so once Inkleaf is the
// default the preview pane goes blank. Inkleaf doesn't ship a previewer of
// its own, so it borrows whichever one is already on the computer, by
// pointing its ProgID at the same handler. Only for this user (HKCU), and
// checked each time Inkleaf starts, in case the other app moves its handler.

const PREVIEW = '{8895b1c6-b41f-4c1c-a562-0d564250836f}';
const THUMBNAIL = '{e357fccd-a995-4576-b01f-234630154e96}';
/** Edge's PDF previewer, used when no app has one registered on its ProgID. */
const EDGE_PDF_PREVIEW = '{3A84F9C2-6164-485C-A7D9-4B27F8AC009E}';

async function regValueNames(key: string): Promise<string[]> {
  try {
    const out = await run('reg', ['query', key]);
    return out.split(/\r?\n/).filter((l) => /\sREG_\w+/.test(l)).map((l) => l.trim().split(/\s{2,}|\t/)[0]).filter((n) => n && n !== '(Default)');
  } catch {
    return [];
  }
}

const clsidExists = async (clsid: string) => (await regValue(`HKCR\\CLSID\\${clsid}`, null)) !== null
  || (await regValueNames(`HKCR\\CLSID\\${clsid}`)).length > 0;

/** A handler of the given kind that another PDF app has registered, if any. */
async function borrowedHandler(kind: string): Promise<string | null> {
  const progIds = ['MSEdgePDF', ...(await regValueNames('HKCR\\.pdf\\OpenWithProgids'))].filter((p) => p !== 'Inkleaf.pdf');
  const places = ['HKCR\\.pdf', ...[...new Set(progIds)].map((p) => `HKCR\\${p}`)];
  for (const place of places) {
    const clsid = await regValue(`${place}\\ShellEx\\${kind}`, null);
    if (clsid && /^\{[0-9a-f-]{36}\}$/i.test(clsid) && (await clsidExists(clsid))) return clsid;
  }
  if (kind === PREVIEW && (await clsidExists(EDGE_PDF_PREVIEW))) return EDGE_PDF_PREVIEW;
  return null;
}

/** Makes sure File Explorer can still preview PDFs when Inkleaf opens them. */
export async function keepPdfPreviews(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged || isPortable() || process.windowsStore) return;
  for (const kind of [PREVIEW, THUMBNAIL]) {
    const key = `HKCU\\Software\\Classes\\Inkleaf.pdf\\ShellEx\\${kind}`;
    const current = await regValue(key, null);
    if (current && (await clsidExists(current))) continue;
    const clsid = await borrowedHandler(kind);
    if (!clsid) continue;
    await run('reg', ['add', key, '/ve', '/d', clsid, '/f']).catch(() => {});
  }
}

async function windowsSettingsLink(): Promise<string> {
  if (process.windowsStore) {
    const id = storeAppId();
    if (id) return `ms-settings:defaultapps?registeredAUMID=${encodeURIComponent(id)}`;
  } else if (await regValue('HKCU\\Software\\RegisteredApplications', REGISTERED_NAME)) {
    return `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(REGISTERED_NAME)}`;
  } else if (await regValue('HKLM\\Software\\RegisteredApplications', REGISTERED_NAME)) {
    return `ms-settings:defaultapps?registeredAppMachine=${encodeURIComponent(REGISTERED_NAME)}`;
  }
  // older Windows 10, or an install from before this was added: the general page
  return 'ms-settings:defaultapps';
}

// --- Linux -----------------------------------------------------------------------------------------

/** The installed .desktop file's name, or null when Inkleaf isn't installed as a package. */
function linuxDesktopFile(): string | null {
  const forTests = !app.isPackaged ? process.env.INKLEAF_TEST_DESKTOP_FILE : undefined;
  if (forTests) return forTests;
  if (!app.isPackaged || process.env.APPIMAGE) return null;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const dirs = [dataHome, ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')]
    .filter(Boolean).map((d) => path.join(d, 'applications'));
  for (const name of ['inkleaf.desktop', 'Inkleaf.desktop', 'io.github.priyanshdas.inkleaf.desktop']) {
    if (dirs.some((d) => existsSync(path.join(d, name)))) return name;
  }
  return null;
}

async function linuxDefault(): Promise<string | null> {
  try {
    return (await run('xdg-mime', ['query', 'default', 'application/pdf'])).trim() || null;
  } catch {
    return null;
  }
}

// --- the two things the window asks for --------------------------------------------------------

export async function defaultAppState(): Promise<DefaultAppState> {
  if (process.platform === 'win32') {
    if (!app.isPackaged || isPortable()) return 'unsupported';
    return (await windowsIsDefault()) ? 'default' : 'not-default';
  }
  if (process.platform === 'linux') {
    const desktop = linuxDesktopFile();
    if (!desktop) return 'unsupported';
    const current = await linuxDefault();
    if (current === null && !(await hasXdgMime())) return 'unsupported';
    return current === desktop ? 'default' : 'not-default';
  }
  return 'unsupported';
}

async function hasXdgMime(): Promise<boolean> {
  try {
    await run('xdg-mime', ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function makeDefaultApp(): Promise<DefaultAppResult> {
  if (process.platform === 'win32') {
    if (!app.isPackaged || isPortable()) return 'unsupported';
    try {
      await shell.openExternal(await windowsSettingsLink());
      return 'settings';
    } catch {
      return 'failed';
    }
  }
  if (process.platform === 'linux') {
    const desktop = linuxDesktopFile();
    if (!desktop) return 'unsupported';
    try {
      await run('xdg-mime', ['default', desktop, 'application/pdf']);
    } catch {
      return 'failed';
    }
    return (await linuxDefault()) === desktop ? 'done' : 'failed';
  }
  return 'unsupported';
}
