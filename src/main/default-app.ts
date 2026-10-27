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

async function windowsIsDefault(): Promise<boolean> {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf';
  // newer Windows 11 builds keep the choice in UserChoiceLatest
  const progId = (await regValue(`${base}\\UserChoiceLatest`, 'ProgId')) ?? (await regValue(`${base}\\UserChoice`, 'ProgId'));
  if (!progId) return false;
  if (/^AppX/i.test(progId)) {
    const aumid = await regValue(`HKCU\\Software\\Classes\\${progId}\\Application`, 'AppUserModelID');
    return !!aumid && aumid.toLowerCase().startsWith(STORE_IDENTITY.toLowerCase());
  }
  const command = await regValue(`HKCR\\${progId}\\shell\\open\\command`, null);
  return !!command && command.toLowerCase().includes(process.execPath.toLowerCase());
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
