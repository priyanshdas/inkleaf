// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps Inkleaf up to date. New versions are published as GitHub releases
// (see "Publishing an update" in the README); the installed app checks for
// one a little after start-up, downloads it quietly, and offers a restart.
//
// Only the installed Windows/macOS/Linux builds can update themselves. The
// portable .exe and runs from source just report that updates aren't
// available, so "Check for updates" can say something useful.

import { t } from '../shared/i18n';
import { app } from 'electron';
import type { UpdateState } from '../shared/api';

type Updater = typeof import('electron-updater').autoUpdater;

let updater: Updater | null = null;
let report: (state: UpdateState) => void = () => {};
let manual = false;
let ready = false;

function why(): string | null {
  if (!app.isPackaged) return t('Updates only work in the installed app.');
  if (process.windowsStore) return t('Updates for the Microsoft Store version are handled by Microsoft Store.');
  if (process.env.FLATPAK_ID) return t('Updates for the Flatpak version are handled by Flatpak.');
  if (process.env.PORTABLE_EXECUTABLE_DIR) return t('The portable version can’t update itself. Download the new version from the releases page instead.');
  return null;
}

export function startUpdates(onState: (state: UpdateState) => void) {
  report = onState;
  if (why()) return;
  // loaded lazily so a missing or broken updater can never stop the app starting
  try {
    updater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
  } catch (err) {
    console.warn('updater unavailable', err);
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => manual && report({ state: 'checking' }));
  updater.on('update-not-available', () => {
    if (manual) report({ state: 'none' });
    manual = false;
  });
  updater.on('update-available', (info) => report({ state: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => report({ state: 'downloading', version: '', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => {
    ready = true;
    report({ state: 'ready', version: info.version });
  });
  updater.on('error', (err) => {
    // an offline computer is normal: only mention it when asked
    if (manual) report({ state: 'error', message: String(err?.message ?? err).split('\n')[0] });
    manual = false;
  });
  setTimeout(() => checkForUpdates(false), 15_000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}

export function checkForUpdates(byUser: boolean) {
  const reason = why();
  if (reason) {
    if (byUser) report({ state: 'unavailable', reason });
    return;
  }
  if (!updater) return;
  if (ready) {
    if (byUser) report({ state: 'ready', version: '' });
    return;
  }
  manual = byUser;
  updater.checkForUpdates().catch(() => {});
}

export function installUpdate() {
  if (ready && updater) updater.quitAndInstall();
}
