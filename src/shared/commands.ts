// SPDX-License-Identifier: GPL-3.0-or-later
// The app menu, described once. macOS builds its native menu bar from this;
// on Windows and Linux the same entries appear in the in-app menu, and the
// page itself handles the shortcuts (there's no native menu bar there).

import { msg } from './i18n';
import { isMobile } from './platform';
import type { MenuCommand } from './api';

export type WindowCommand = 'new-window' | 'quit' | 'fullscreen' | 'devtools';
export type AppCommand = MenuCommand | WindowCommand;

export interface MenuItemSpec {
  label: string;
  /** A different label in the phone apps. */
  mobileLabel?: string;
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
    label: msg('File'),
    items: [
      { label: msg('New Blank PDF'), command: 'new', key: 'Mod+N' },
      { label: msg('New Window'), command: 'new-window', key: 'Mod+Shift+N' },
      { label: msg('Open…'), command: 'open', key: 'Mod+O' },
      'separator',
      { label: msg('Save'), command: 'save', key: 'Mod+S' },
      { label: msg('Save As…'), command: 'save-as', key: 'Mod+Shift+S' },
      { label: msg('Print…'), command: 'print', key: 'Mod+P' },
      { label: msg('Share…'), command: 'share' },
      'separator',
      { label: msg('Send to Phone…'), mobileLabel: msg('Send to Computer…'), command: 'link-send' },
      { label: msg('Connect a Phone…'), mobileLabel: msg('Connect to a Computer…'), command: 'link-pair' },
      'separator',
      { label: msg('Auto Save'), command: 'toggle-autosave' },
      { label: msg('Open Backups Folder'), command: 'open-backups' },
      'separator',
      { label: msg('Extract Pages…'), command: 'extract' },
      { label: msg('Split Document…'), command: 'split' },
      'separator',
      { label: msg('Close Tab'), command: 'close-tab', key: 'Mod+W' },
    ],
  },
  {
    label: msg('Edit'),
    items: [
      { label: msg('Undo'), command: 'undo', key: 'Mod+Z' },
      { label: msg('Redo'), command: 'redo', key: 'Mod+Y', macKey: 'Mod+Shift+Z' },
      'separator',
      { label: msg('Cut'), command: 'cut', key: 'Mod+X' },
      { label: msg('Copy'), command: 'copy', key: 'Mod+C' },
      { label: msg('Paste'), command: 'paste', key: 'Mod+V' },
      { label: msg('Duplicate'), command: 'duplicate', key: 'Mod+D' },
      { label: msg('Delete'), command: 'delete' },
      'separator',
      { label: msg('Find…'), command: 'find', key: 'Mod+F' },
    ],
  },
  {
    label: msg('View'),
    items: [
      { label: msg('Zoom In'), command: 'zoom-in', key: 'Mod+=' },
      { label: msg('Zoom Out'), command: 'zoom-out', key: 'Mod+-' },
      { label: msg('Actual Size'), command: 'zoom-reset', key: 'Mod+0' },
      { label: msg('Fit Width'), command: 'zoom-fit-width', key: 'Mod+1' },
      { label: msg('Fit Page'), command: 'zoom-fit-page', key: 'Mod+2' },
      'separator',
      { label: msg('Continuous Scroll'), command: 'mode-continuous' },
      { label: msg('Two Pages Side by Side'), command: 'mode-spread' },
      { label: msg('One Page at a Time'), command: 'mode-single' },
      'separator',
      { label: msg('Enhance Pages…'), command: 'enhance', key: 'Mod+Shift+E' },
      'separator',
      { label: msg('Show or Hide Pages'), command: 'toggle-sidebar', key: 'Mod+B' },
      { label: msg('Show Bookmarks'), command: 'show-bookmarks' },
      { label: msg('Show Comments'), command: 'show-comments' },
      { label: msg('Show or Hide Properties'), command: 'toggle-inspector', key: 'Mod+I' },
      { label: msg('Next Tab'), command: 'next-tab', key: 'Ctrl+Tab' },
      { label: msg('Previous Tab'), command: 'prev-tab', key: 'Ctrl+Shift+Tab' },
      'separator',
      { label: msg('Match System Theme'), command: 'theme-system' },
      { label: msg('Light Theme'), command: 'theme-light' },
      { label: msg('Dark Theme'), command: 'theme-dark' },
      { label: msg('Language…'), command: 'language' },
      'separator',
      { label: msg('Full Screen'), command: 'fullscreen', key: 'F11', macKey: 'Ctrl+Mod+F' },
      { label: msg('Developer Tools'), command: 'devtools', key: 'Mod+Shift+I', devOnly: true },
    ],
  },
  {
    label: msg('Pages'),
    items: [
      { label: msg('Insert PDF…'), command: 'insert-pdf' },
      { label: msg('Insert Blank Page'), command: 'insert-blank' },
      'separator',
      { label: msg('Rotate Left'), command: 'rotate-left', key: 'Mod+Shift+L' },
      { label: msg('Rotate Right'), command: 'rotate-right', key: 'Mod+Shift+R' },
      { label: msg('Delete Selected Pages'), command: 'delete-pages' },
      { label: msg('Select All Pages'), command: 'select-all-pages' },
      'separator',
      { label: msg('Crop Pages'), command: 'crop' },
      { label: msg('Remove Crop From All Pages'), command: 'uncrop-all' },
    ],
  },
  {
    label: msg('Tools'),
    items: [
      { label: msg('Recognise Text (OCR)…'), command: 'ocr' },
      { label: msg('Compress…'), command: 'compress' },
      { label: msg('Password Protect…'), command: 'protect' },
      { label: msg('Share Securely…'), command: 'secure-share' },
      { label: msg('My Receive Code…'), command: 'receive-code' },
      { label: msg('Receive a File…'), command: 'receive-file' },
      { label: msg('Remove a Password…'), command: 'unlock' },
      { label: msg('Watermark, Page Numbers & Headers…'), command: 'decor' },
      { label: msg('Add Form Fields'), command: 'form-builder' },
      { label: msg('Compare With Another PDF…'), command: 'compare' },
      'separator',
      { label: msg('Convert to PDF…'), command: 'convert-to-pdf' },
      { label: msg('Convert PDF To…'), command: 'convert-from-pdf' },
      { label: msg('Web Page to PDF…'), command: 'web-to-pdf' },
      { label: msg('Scan to PDF…'), command: 'scan-to-pdf' },
      { label: msg('Combine Pictures Into One PDF…'), command: 'images-to-pdf' },
      { label: msg('Save as PDF/A (for archiving)…'), command: 'pdf-to-pdfa' },
      { label: msg('Repair a Damaged PDF…'), command: 'repair' },
      'separator',
      { label: msg('AI Summarizer…'), command: 'ai-summarize' },
      { label: msg('Translate PDF…'), command: 'ai-translate' },
      { label: msg('Ask This PDF…'), command: 'ai-ask', key: 'Mod+Shift+A' },
      { label: msg('AI Settings…'), command: 'ai-settings' },
      'separator',
      { label: msg('All Tools'), command: 'all-tools', key: 'Mod+K' },
    ],
  },
  {
    label: msg('Help'),
    items: [
      { label: msg('Keyboard Shortcuts'), command: 'shortcuts', key: 'Mod+/' },
      { label: msg('Check for Updates…'), command: 'check-updates' },
      { label: msg('Make Inkleaf the Default PDF App…'), command: 'default-app' },
      'separator',
      { label: msg('Report a Problem…'), command: 'report-problem' },
      { label: msg('Inkleaf on GitHub'), command: 'open-github' },
      { label: msg('Buy Me a Coffee…'), command: 'donate' },
      'separator',
      { label: msg('Terms of Use'), command: 'terms' },
      { label: msg('Privacy Policy'), command: 'privacy' },
      { label: msg('About Inkleaf'), command: 'about' },
    ],
  },
];

export function shortcutFor(item: MenuItemSpec, mac: boolean): string | undefined {
  return mac ? item.macKey ?? item.key : item.key;
}

/** "Mod+Shift+S" → "Ctrl+Shift+S" or "⌘⇧S", for showing in menus. */
export function displayShortcut(key: string, mac: boolean): string {
  // phones have no keyboard shortcuts to show
  if (isMobile()) return '';
  if (!mac) return key.replace(/Mod/g, 'Ctrl');
  const symbols: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Tab: '⇥' };
  return key.split('+').map((part) => symbols[part] ?? part).join('');
}
