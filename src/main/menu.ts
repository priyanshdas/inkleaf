// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../shared/i18n';
import { app, BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { MENU, MenuItemSpec, shortcutFor, WindowCommand } from '../shared/commands';

/**
 * macOS gets a native menu bar built from the shared menu table. Windows and
 * Linux have no menu bar (the title bar is ours), so there the app shows the
 * same table in its own menu and handles the shortcuts in the page.
 */
export function buildMenu(runWindowCommand: (command: WindowCommand, win: BrowserWindow | null) => void) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const windowCommands = new Set<string>(['new-window', 'quit', 'fullscreen', 'devtools']);
  const item = (spec: MenuItemSpec): MenuItemConstructorOptions => ({
    label: t(spec.label),
    accelerator: shortcutFor(spec, true)?.replace(/Mod/g, 'Cmd'),
    click: () => {
      const win = BrowserWindow.getFocusedWindow();
      if (windowCommands.has(spec.command)) runWindowCommand(spec.command as WindowCommand, win);
      else win?.webContents.send('menu', spec.command);
    },
  });

  const sections: MenuItemConstructorOptions[] = MENU.map((section) => {
    const submenu: MenuItemConstructorOptions[] = section.items
      .filter((entry) => entry === 'separator' || !(entry.devOnly && app.isPackaged))
      .filter((entry) => entry === 'separator' || !['about', 'quit'].includes(entry.command))
      .map((entry) => (entry === 'separator' ? { type: 'separator' as const } : item(entry)));
    // Cmd+A only works in text boxes on macOS when the menu has Select All
    if (section.label === 'Edit') submenu.push({ type: 'separator' }, { role: 'selectAll' });
    return { label: t(section.label), role: section.label === 'Help' ? 'help' : undefined, submenu };
  });

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { label: t('About {name}', { name: app.name }), click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', 'about') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate([appMenu, ...sections, { role: 'windowMenu' }]));
}
