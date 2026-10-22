// SPDX-License-Identifier: GPL-3.0-or-later
// The app menu, described once. macOS builds its native menu bar from this;
// on Windows and Linux the same entries appear in the in-app menu, and the
// page itself handles the shortcuts (there's no native menu bar there).

import type { MenuCommand } from './api';

export type WindowCommand = 'new-window' | 'quit' | 'fullscreen' | 'devtools';
export type AppCommand = MenuCommand | WindowCommand;

export interface MenuItemSpec {
  label: string;
  command: AppCommand;
  /** Shortcut, written with Mod for Cmd on macOS and Ctrl elsewhere. */
  key?: string;
  /** Separate shortcut for macOS when it differs. */
  macKey?: string;
  /** Only shown when running from source. */
  devOnly?: boolean;
}

export type MenuEntry = MenuItemSpec | 'separator';

export interface MenuSection {
  label: string;
  items: MenuEntry[];
}

export const MENU: MenuSection[] = [
  {
    label: 'File',
    items: [
      { label: 'New Blank PDF', command: 'new', key: 'Mod+N' },
      { label: 'New Window', command: 'new-window', key: 'Mod+Shift+N' },
      { label: 'Open…', command: 'open', key: 'Mod+O' },
      'separator',
      { label: 'Save', command: 'save', key: 'Mod+S' },
      { label: 'Save As…', command: 'save-as', key: 'Mod+Shift+S' },
      { label: 'Print…', command: 'print', key: 'Mod+P' },
      'separator',
      { label: 'Auto Save', command: 'toggle-autosave' },
      { label: 'Open Backups Folder', command: 'open-backups' },
      'separator',
      { label: 'Extract Pages…', command: 'extract' },
      { label: 'Split Document…', command: 'split' },
      'separator',
      { label: 'Close Tab', command: 'close-tab', key: 'Mod+W' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', command: 'undo', key: 'Mod+Z' },
      { label: 'Redo', command: 'redo', key: 'Mod+Y', macKey: 'Mod+Shift+Z' },
      'separator',
      { label: 'Cut', command: 'cut', key: 'Mod+X' },
      { label: 'Copy', command: 'copy', key: 'Mod+C' },
      { label: 'Paste', command: 'paste', key: 'Mod+V' },
      { label: 'Duplicate', command: 'duplicate', key: 'Mod+D' },
      { label: 'Delete', command: 'delete' },
      'separator',
      { label: 'Find…', command: 'find', key: 'Mod+F' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Zoom In', command: 'zoom-in', key: 'Mod+=' },
      { label: 'Zoom Out', command: 'zoom-out', key: 'Mod+-' },
      { label: 'Actual Size', command: 'zoom-reset', key: 'Mod+0' },
      { label: 'Fit Width', command: 'zoom-fit-width', key: 'Mod+1' },
      { label: 'Fit Page', command: 'zoom-fit-page', key: 'Mod+2' },
      'separator',
      { label: 'Continuous Scroll', command: 'mode-continuous' },
      { label: 'Two Pages Side by Side', command: 'mode-spread' },
      { label: 'One Page at a Time', command: 'mode-single' },
      'separator',
      { label: 'Show or Hide Pages', command: 'toggle-sidebar', key: 'Mod+B' },
      { label: 'Show Bookmarks', command: 'show-bookmarks' },
      { label: 'Show Comments', command: 'show-comments' },
      { label: 'Show or Hide Properties', command: 'toggle-inspector', key: 'Mod+I' },
      { label: 'Next Tab', command: 'next-tab', key: 'Ctrl+Tab' },
      { label: 'Previous Tab', command: 'prev-tab', key: 'Ctrl+Shift+Tab' },
      'separator',
      { label: 'Match System Theme', command: 'theme-system' },
      { label: 'Light Theme', command: 'theme-light' },
      { label: 'Dark Theme', command: 'theme-dark' },
      'separator',
      { label: 'Full Screen', command: 'fullscreen', key: 'F11', macKey: 'Ctrl+Mod+F' },
      { label: 'Developer Tools', command: 'devtools', key: 'Mod+Shift+I', devOnly: true },
    ],
  },
  {
    label: 'Pages',
    items: [
      { label: 'Insert PDF…', command: 'insert-pdf' },
      { label: 'Insert Blank Page', command: 'insert-blank' },
      'separator',
      { label: 'Rotate Left', command: 'rotate-left', key: 'Mod+Shift+L' },
      { label: 'Rotate Right', command: 'rotate-right', key: 'Mod+Shift+R' },
      { label: 'Delete Selected Pages', command: 'delete-pages' },
      { label: 'Select All Pages', command: 'select-all-pages' },
      'separator',
      { label: 'Crop Pages', command: 'crop' },
      { label: 'Remove Crop From All Pages', command: 'uncrop-all' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { label: 'Recognise Text (OCR)…', command: 'ocr' },
      { label: 'Compress…', command: 'compress' },
      { label: 'Password Protect…', command: 'protect' },
      { label: 'Watermark, Page Numbers & Headers…', command: 'decor' },
      { label: 'Add Form Fields', command: 'form-builder' },
      { label: 'Compare With Another PDF…', command: 'compare' },
      'separator',
      { label: 'Pictures to PDF…', command: 'images-to-pdf' },
      { label: 'Export Pages as Pictures…', command: 'pdf-to-images' },
      { label: 'Export to Word…', command: 'pdf-to-word' },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Keyboard Shortcuts', command: 'shortcuts', key: 'Mod+/' },
      { label: 'Check for Updates…', command: 'check-updates' },
      'separator',
      { label: 'Report a Problem…', command: 'report-problem' },
      { label: 'Inkleaf on GitHub', command: 'open-github' },
      { label: 'Buy Me a Coffee…', command: 'donate' },
      { label: 'About Inkleaf', command: 'about' },
    ],
  },
];

export function shortcutFor(item: MenuItemSpec, mac: boolean): string | undefined {
  return mac ? item.macKey ?? item.key : item.key;
}

/** "Mod+Shift+S" → "Ctrl+Shift+S" or "⌘⇧S", for showing in menus. */
export function displayShortcut(key: string, mac: boolean): string {
  if (!mac) return key.replace(/Mod/g, 'Ctrl');
  const symbols: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Tab: '⇥' };
  return key.split('+').map((part) => symbols[part] ?? part).join('');
}
