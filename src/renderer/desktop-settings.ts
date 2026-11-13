// SPDX-License-Identifier: GPL-3.0-or-later
// Settings: how Inkleaf fits in with the computer. Starting when you sign
// in, staying in the tray, opening downloaded PDFs, reopening last time's
// files, and File Explorer's right-click menu. The work is done in
// src/main/desktop.ts; each switch takes effect straight away.

import { t } from '../shared/i18n';
import type { DesktopSettings, DesktopSettingsState } from '../shared/api';
import { h, modal, toast } from './ui';

export async function desktopSettingsDialog(): Promise<void> {
  const api = window.inkleaf;
  if (!api.getDesktopSettings || !api.setDesktopSettings) return;
  let state: DesktopSettingsState = await api.getDesktopSettings();
  const windows = state.platform === 'win32';
  const mac = state.platform === 'darwin';

  const boxes = new Map<keyof DesktopSettings, HTMLInputElement>();
  const notes = new Map<keyof DesktopSettings, HTMLElement>();
  const row = (key: keyof DesktopSettings, label: string, hint: string) => {
    const box = h('input', { type: 'checkbox', class: `desktop-${key}` }) as HTMLInputElement;
    const note = h('span', { class: 'field-hint desktop-note' });
    boxes.set(key, box);
    notes.set(key, note);
    return h('label', { class: 'check desktop-row' }, box, h('span', {}, h('strong', {}, label), h('span', { class: 'field-hint' }, hint), note));
  };
  const show = () => {
    for (const [key, box] of boxes) box.checked = state[key];
    notes.get('startAtLogin')!.textContent = state.startupBlocked
      ? t('Starting at sign-in is switched off in Windows’ own Startup apps settings. Switch Inkleaf on there.')
      : '';
  };

  const section = (title: string, ...rows: Node[]) => h('section', { class: 'desktop-section' }, h('h3', {}, title), ...rows);
  const body = h('div', { class: 'desktop-settings' },
    section(t('Starting up'),
      row('startAtLogin',
        windows ? t('Start Inkleaf when I sign in to Windows') : t('Start Inkleaf when I sign in'),
        mac ? t('It waits in the menu bar, so PDFs open straight away.') : t('It waits in the tray, so PDFs open straight away.')),
      row('keepInTray',
        mac ? t('Keep Inkleaf in the menu bar when I close its windows') : t('Keep Inkleaf in the tray when I close its windows'),
        t('PDFs then open straight away, and downloads still open. Quit from its icon.')),
      row('reopenSession',
        t('Reopen the files I had open last time'),
        t('On the page you were reading, when Inkleaf starts without a file to open.')),
    ),
    section(t('Downloads'),
      row('openDownloads',
        t('Open PDFs as soon as they’re downloaded'),
        t('While Inkleaf is running, new PDFs in {folder} open in a new tab.', { folder: state.downloads })),
    ),
    ...(state.supports.explorerMenu ? [section(t('File Explorer'),
      row('explorerMenu',
        t('Add Inkleaf to the right-click menu'),
        t('Combine, print or compress PDFs, and make a PDF from pictures and documents. On Windows 11 it’s under “Show more options”.')),
    )] : []),
  );
  show();

  for (const [key, box] of boxes) {
    box.addEventListener('change', async () => {
      const change: Partial<DesktopSettings> = { [key]: box.checked };
      // waiting in the tray at sign-in only helps if it stays there afterwards too
      if (key === 'startAtLogin' && box.checked && !state.keepInTray) change.keepInTray = true;
      boxes.forEach((b) => (b.disabled = true));
      try {
        state = await api.setDesktopSettings!(change);
      } catch {
        toast(t('Couldn’t change that setting.'), 'error');
      } finally {
        boxes.forEach((b) => (b.disabled = false));
        show();
      }
    });
  }

  await modal({ title: t('Settings'), wide: true, body, buttons: [{ label: t('Done'), value: 'ok', primary: true }] });
}
