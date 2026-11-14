// SPDX-License-Identifier: GPL-3.0-or-later
// Settings: the toolbar layout (ribbon or classic), and how Inkleaf fits in
// with the computer: starting when you sign in, staying in the tray, opening
// downloaded PDFs, reopening last time's files, and File Explorer's
// right-click menu. The computer's side is done in src/main/desktop.ts;
// each switch takes effect straight away.

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
      ? t('Starting at sign-in is switched off in Windows’ own Startup apps settings. Switch InkLeaf PDF on there.')
      : '';
  };

  const section = (title: string, ...rows: Node[]) => h('section', { class: 'desktop-section' }, h('h3', {}, title), ...rows);

  // the toolbar: the ribbon or the classic rail (app.ts switches it)
  const ribbonOn = document.getElementById('app')?.classList.contains('ribbon') ?? false;
  const layoutRow = (value: 'ribbon' | 'classic', label: string, hint: string) => {
    const radio = h('input', { type: 'radio', name: 'desktop-layout', value, class: `desktop-layout-${value}` }) as HTMLInputElement;
    radio.checked = (value === 'ribbon') === ribbonOn;
    radio.addEventListener('change', () => {
      if (radio.checked) window.dispatchEvent(new CustomEvent('inkleaf-layout', { detail: value === 'ribbon' }));
    });
    return h('label', { class: 'check desktop-row' }, radio, h('span', {}, h('strong', {}, label), h('span', { class: 'field-hint' }, hint)));
  };

  const body = h('div', { class: 'desktop-settings' },
    section(t('Toolbar'),
      layoutRow('ribbon', t('Ribbon'), t('Tabs of labelled buttons along the top, like Word. Ctrl+F1 folds it away.')),
      layoutRow('classic', t('Classic'), t('Tools down the left side and a slim bar along the top.')),
    ),
    section(t('Starting up'),
      row('startAtLogin',
        windows ? t('Start InkLeaf PDF when I sign in to Windows') : t('Start InkLeaf PDF when I sign in'),
        mac ? t('It waits in the menu bar, so PDFs open straight away.') : t('It waits in the tray, so PDFs open straight away.')),
      row('keepInTray',
        mac ? t('Keep InkLeaf PDF in the menu bar when I close its windows') : t('Keep InkLeaf PDF in the tray when I close its windows'),
        t('PDFs then open straight away, and downloads still open. Quit from its icon.')),
      row('reopenSession',
        t('Reopen the files I had open last time'),
        t('On the page you were reading, when InkLeaf PDF starts without a file to open.')),
    ),
    section(t('Downloads'),
      row('openDownloads',
        t('Open PDFs as soon as they’re downloaded'),
        t('While InkLeaf PDF is running, new PDFs in {folder} open in a new tab.', { folder: state.downloads })),
    ),
    ...(state.supports.explorerMenu ? [section(t('File Explorer'),
      row('explorerMenu',
        t('Add InkLeaf PDF to the right-click menu'),
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
