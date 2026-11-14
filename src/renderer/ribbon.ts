// SPDX-License-Identifier: GPL-3.0-or-later
// The ribbon: tabs of labelled groups along the top, like Word's, in place
// of the tool rail and the command bar. Everyone can switch between it and
// the classic layout (View › Ribbon); it's the starting layout for people
// new to Inkleaf, while those who already know the classic one keep it.
//
// The buttons carry the same data-command, data-menu and data-tool marks as
// the rest of the window, so app.ts handles their clicks as it handles any
// other button's. What this file owns is the ribbon's shape: the tabs, the
// groups, collapsing it to just the tab names (Ctrl+F1, or double-click a
// tab) and peeking at a tab while it's collapsed.

import { msg, t } from '../shared/i18n';
import { h, icon } from './ui';
import { TIPS } from './rail';

interface Button {
  label: string;
  icon: string;
  command?: string;
  menu?: string;
  tool?: string;
  /** Shortcut shown in the tooltip, e.g. "Ctrl+S". */
  key?: string;
  /** Longer explanation for the tooltip. */
  tip?: string;
}

interface Group {
  label: string;
  /** Big buttons, icon above the label. */
  large?: Button[];
  /** Small buttons, stacked three to a column. */
  small?: Button[];
  /** Something built elsewhere (the font controls). */
  slot?: string;
}

interface Tab {
  id: string;
  label: string;
  groups: Group[];
}

const TABS: Tab[] = [
  {
    id: 'home',
    label: msg('Home'),
    groups: [
      {
        label: msg('File'),
        large: [{ label: msg('Open'), icon: 'folder-open', menu: 'open', tip: msg('Open a PDF, a recent file, or make a new one.') }],
        small: [
          { label: msg('Save'), icon: 'save', command: 'save', key: 'Ctrl+S' },
          { label: msg('Save as'), icon: 'file-down', command: 'save-as', key: 'Ctrl+Shift+S' },
          { label: msg('Print'), icon: 'printer', command: 'print', key: 'Ctrl+P' },
        ],
      },
      {
        label: msg('Clipboard'),
        large: [{ label: msg('Paste'), icon: 'clipboard-paste', command: 'paste', key: 'Ctrl+V' }],
        small: [
          { label: msg('Cut'), icon: 'scissors', command: 'cut', key: 'Ctrl+X' },
          { label: msg('Copy'), icon: 'copy', command: 'copy', key: 'Ctrl+C' },
          { label: msg('Duplicate'), icon: 'layers', command: 'duplicate', key: 'Ctrl+D' },
        ],
      },
      { label: msg('Font'), slot: 'font' },
      {
        label: msg('Tools'),
        large: [
          { label: msg('Select'), icon: 'mouse-pointer-2', tool: 'select', key: 'V' },
          { label: msg('Edit text'), icon: 'text-cursor-input', tool: 'edit-text', key: 'E' },
          { label: msg('Add text'), icon: 'type', tool: 'text', key: 'T' },
        ],
        small: [{ label: msg('Pan'), icon: 'hand', tool: 'hand', key: 'H' }],
      },
      {
        label: msg('Editing'),
        small: [
          { label: msg('Find'), icon: 'search', command: 'find', key: 'Ctrl+F' },
          { label: msg('Undo'), icon: 'undo-2', command: 'undo', key: 'Ctrl+Z' },
          { label: msg('Redo'), icon: 'redo-2', command: 'redo', key: 'Ctrl+Y' },
        ],
      },
    ],
  },
  {
    id: 'insert',
    label: msg('Insert'),
    groups: [
      {
        label: msg('Text'),
        large: [{ label: msg('Add text'), icon: 'type', tool: 'text', key: 'T' }],
        small: [
          { label: msg('Comment'), icon: 'message-square', tool: 'note', key: 'N' },
          { label: msg('Stamp'), icon: 'stamp', tool: 'stamp', key: 'K' },
          { label: msg('Form fields'), icon: 'text-cursor', command: 'form-builder' },
        ],
      },
      {
        label: msg('Pictures'),
        large: [
          { label: msg('Image'), icon: 'image', tool: 'image' },
          { label: msg('Signature'), icon: 'signature', tool: 'sign' },
        ],
      },
      {
        label: msg('Shapes'),
        small: [
          { label: msg('Rectangle'), icon: 'square', tool: 'rect', key: 'R' },
          { label: msg('Ellipse'), icon: 'circle', tool: 'ellipse' },
          { label: msg('Line'), icon: 'minus', tool: 'line' },
          { label: msg('Arrow'), icon: 'move-up-right', tool: 'arrow' },
        ],
      },
      {
        label: msg('Pages'),
        large: [{ label: msg('Blank page'), icon: 'file-plus-2', command: 'insert-blank' }],
        small: [
          { label: msg('Another PDF'), icon: 'file-plus', command: 'insert-pdf' },
          { label: msg('From scanner'), icon: 'printer', command: 'insert-scan' },
        ],
      },
      {
        label: msg('Header & footer'),
        large: [{ label: msg('Watermark & numbers'), icon: 'droplets', command: 'decor', tip: msg('Watermarks, page numbers, headers and footers.') }],
      },
    ],
  },
  {
    id: 'pages',
    label: msg('Pages'),
    groups: [
      {
        label: msg('Combine'),
        large: [{ label: msg('Merge PDF'), icon: 'file-plus', command: 'insert-pdf' }],
        small: [
          { label: msg('Blank page'), icon: 'file-plus-2', command: 'insert-blank' },
          { label: msg('From scanner'), icon: 'printer', command: 'insert-scan' },
        ],
      },
      {
        label: msg('Arrange'),
        small: [
          { label: msg('Rotate left'), icon: 'rotate-ccw', command: 'rotate-left' },
          { label: msg('Rotate right'), icon: 'rotate-cw', command: 'rotate-right' },
          { label: msg('Delete pages'), icon: 'trash-2', command: 'delete-pages' },
        ],
      },
      {
        label: msg('Split'),
        large: [
          { label: msg('Extract pages'), icon: 'file-output', command: 'extract' },
          { label: msg('Split document'), icon: 'scissors', command: 'split' },
        ],
      },
      {
        label: msg('Crop'),
        large: [{ label: msg('Crop pages'), icon: 'crop', command: 'crop' }],
        small: [{ label: msg('Remove crop'), icon: 'maximize-2', command: 'uncrop-all' }],
      },
      {
        label: msg('Scans'),
        large: [{ label: msg('Enhance pages'), icon: 'contrast', command: 'enhance', key: 'Ctrl+Shift+E' }],
      },
    ],
  },
  {
    id: 'review',
    label: msg('Review'),
    groups: [
      {
        label: msg('Mark up'),
        large: [
          { label: msg('Highlight'), icon: 'highlighter', tool: 'highlight', key: 'M' },
          { label: msg('Draw'), icon: 'pen-line', tool: 'pen', key: 'P' },
        ],
        small: [{ label: msg('Erase'), icon: 'eraser', tool: 'eraser', key: 'X' }],
      },
      {
        label: msg('Comments'),
        large: [{ label: msg('Comment'), icon: 'message-square', tool: 'note', key: 'N' }],
        small: [{ label: msg('Show comments'), icon: 'message-square', command: 'show-comments' }],
      },
      {
        label: msg('Hide'),
        large: [
          { label: msg('Redact'), icon: 'eye-off', tool: 'redact', key: 'B' },
          { label: msg('White-out'), icon: 'rectangle-horizontal', tool: 'whiteout', key: 'W' },
        ],
      },
      {
        label: msg('Compare'),
        large: [{ label: msg('Compare'), icon: 'git-compare', command: 'compare' }],
      },
      {
        label: msg('Protect'),
        large: [{ label: msg('Password'), icon: 'shield-check', command: 'protect' }],
        small: [
          { label: msg('Share securely'), icon: 'qr-code', command: 'secure-share' },
          { label: msg('Send to phone'), icon: 'smartphone', command: 'link-send' },
        ],
      },
    ],
  },
  {
    id: 'convert',
    label: msg('Convert'),
    groups: [
      {
        label: msg('To PDF'),
        large: [{ label: msg('Convert to PDF'), icon: 'file-input', command: 'convert-to-pdf', tip: msg('Word, Excel, PowerPoint, pictures and more.') }],
        small: [
          { label: msg('Pictures'), icon: 'images', command: 'images-to-pdf' },
          { label: msg('Web page'), icon: 'globe', command: 'web-to-pdf' },
          { label: msg('Scan'), icon: 'scan-line', command: 'scan-to-pdf' },
        ],
      },
      {
        label: msg('From PDF'),
        large: [{ label: msg('Convert PDF to…'), icon: 'file-output', command: 'convert-from-pdf', tip: msg('Word, Excel, PowerPoint, pictures and more.') }],
      },
      {
        label: msg('Text'),
        large: [{ label: msg('Recognise text'), icon: 'scan-text', command: 'ocr', tip: msg('Makes scans searchable and copyable (OCR).') }],
      },
      {
        label: msg('Size'),
        large: [{ label: msg('Compress'), icon: 'file-archive', command: 'compress' }],
      },
      {
        label: msg('Archive'),
        small: [
          { label: msg('PDF/A'), icon: 'archive', command: 'pdf-to-pdfa' },
          { label: msg('Repair'), icon: 'wrench', command: 'repair' },
        ],
      },
    ],
  },
  {
    id: 'ai',
    label: msg('AI'),
    groups: [
      {
        label: msg('Built-in AI'),
        large: [
          { label: msg('Summarize'), icon: 'sparkles', command: 'ai-summarize' },
          { label: msg('Translate'), icon: 'languages', command: 'ai-translate' },
          { label: msg('Ask this PDF'), icon: 'message-circle-question', command: 'ai-ask' },
        ],
      },
      {
        label: msg('Settings'),
        large: [{ label: msg('AI settings'), icon: 'settings-2', command: 'ai-settings' }],
      },
    ],
  },
  {
    id: 'view',
    label: msg('View'),
    groups: [
      {
        label: msg('Zoom'),
        large: [
          { label: msg('Fit width'), icon: 'maximize-2', command: 'zoom-fit-width', key: 'Ctrl+1' },
          { label: msg('Fit page'), icon: 'file-text', command: 'zoom-fit-page', key: 'Ctrl+2' },
        ],
        small: [
          { label: msg('Zoom in'), icon: 'zoom-in', command: 'zoom-in', key: 'Ctrl+=' },
          { label: msg('Zoom out'), icon: 'zoom-out', command: 'zoom-out', key: 'Ctrl+-' },
          { label: msg('Actual size'), icon: 'ratio', command: 'zoom-reset', key: 'Ctrl+0' },
        ],
      },
      {
        label: msg('Page layout'),
        small: [
          { label: msg('Continuous scroll'), icon: 'rectangle-vertical', command: 'mode-continuous' },
          { label: msg('Two pages side by side'), icon: 'columns-2', command: 'mode-spread' },
          { label: msg('One page at a time'), icon: 'book-open', command: 'mode-single' },
        ],
        large: [{ label: msg('Read right to left'), icon: 'arrow-right-left', command: 'reading-rtl' }],
      },
      {
        label: msg('Show'),
        small: [
          { label: msg('Pages'), icon: 'panel-left', command: 'toggle-sidebar', key: 'Ctrl+B' },
          { label: msg('Bookmarks'), icon: 'bookmark', command: 'show-bookmarks' },
          { label: msg('Properties'), icon: 'panel-right', command: 'toggle-inspector', key: 'Ctrl+I' },
        ],
      },
      {
        label: msg('Theme'),
        small: [
          { label: msg('Match system'), icon: 'monitor', command: 'theme-system' },
          { label: msg('Light'), icon: 'sun', command: 'theme-light' },
          { label: msg('Dark'), icon: 'moon', command: 'theme-dark' },
        ],
      },
      {
        label: msg('Window'),
        small: [
          { label: msg('New window'), icon: 'app-window', command: 'new-window', key: 'Ctrl+Shift+N' },
          { label: msg('Full screen'), icon: 'fullscreen', command: 'fullscreen', key: 'F11' },
          { label: msg('Language'), icon: 'languages', command: 'language' },
        ],
        large: [{ label: msg('Classic toolbar'), icon: 'panel-left', command: 'toggle-ribbon', tip: msg('Go back to the tool rail and toolbar InkLeaf PDF had before.') }],
      },
    ],
  },
];

const TAB_KEY = 'inkleaf.ribbon-tab';
const COLLAPSED_KEY = 'inkleaf.ribbon-collapsed';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only a convenience: it's just not remembered
  }
};

function tooltip(b: Button): string {
  const tip = b.tip ?? (b.tool ? TIPS[b.tool]?.text : undefined);
  const head = b.key ? `${t(b.label)} (${b.key})` : t(b.label);
  return tip ? `${head}\n${t(tip)}` : head;
}

function button(b: Button, size: 'large' | 'small'): HTMLElement {
  const el = h('button', {
    class: `rb-btn rb-${size}`,
    type: 'button',
    title: tooltip(b),
    'data-command': b.command,
    'data-menu': b.menu,
    'data-tool': b.tool,
    'aria-haspopup': b.menu ? 'menu' : undefined,
  }, icon(b.icon), h('span', { class: 'rb-label' }, t(b.label)), b.menu ? icon('chevron-down') : null);
  return el;
}

export interface Ribbon {
  el: HTMLElement;
  /** Where the font controls go. */
  fontSlot: HTMLElement;
  /** The buttons that go at the end of the tab row (sidebar toggles and the like). */
  tabEnd: HTMLElement;
  setCollapsed(collapsed: boolean): void;
  collapsed(): boolean;
  /** Rebuilds the labels in the current language. */
  relabel(): void;
}

/**
 * Builds the ribbon. `supported` leaves out what this device can't do;
 * `onChange` is called when the ribbon opens, closes or changes size, so
 * the page can lay itself out again.
 */
export function createRibbon(supported: (command: string) => boolean, onChange: () => void): Ribbon {
  const tabRow = h('div', { class: 'rb-tabs', role: 'tablist', 'aria-label': t('Ribbon') });
  const panel = h('div', { class: 'rb-panel', role: 'tabpanel' });
  const fontSlot = h('div', { class: 'rb-font' });
  const tabEnd = h('div', { class: 'rb-tab-end' });
  const fold = h('button', { class: 'rb-fold', type: 'button' });
  const el = h('div', { id: 'ribbon', class: 'ribbon' }, tabRow, panel);

  let current = read(TAB_KEY) ?? 'home';
  if (!TABS.some((tab) => tab.id === current)) current = 'home';
  let isCollapsed = read(COLLAPSED_KEY) === '1';
  let peeking = false;

  const keep = (b: Button) => (!b.command || supported(b.command));

  const drawPanel = () => {
    const tab = TABS.find((x) => x.id === current)!;
    panel.replaceChildren(...tab.groups.map((g) => {
      const body = h('div', { class: 'rb-group-body' });
      if (g.slot === 'font') body.append(fontSlot);
      for (const b of (g.large ?? []).filter(keep)) body.append(button(b, 'large'));
      const small = (g.small ?? []).filter(keep);
      for (let i = 0; i < small.length; i += 3) {
        body.append(h('div', { class: 'rb-stack' }, ...small.slice(i, i + 3).map((b) => button(b, 'small'))));
      }
      if (!body.childElementCount) return null;
      return h('section', { class: 'rb-group', 'aria-label': t(g.label) }, body, h('div', { class: 'rb-group-label' }, t(g.label)));
    }).filter((g): g is HTMLElement => !!g));
    panel.setAttribute('aria-label', t(tab.label));
  };

  const drawTabs = () => {
    const tabs = TABS.map((tab) => {
      const b = h('button', {
        class: 'rb-tab', type: 'button', role: 'tab', 'data-tab': tab.id,
        'aria-selected': String(tab.id === current && (!isCollapsed || peeking)),
      }, t(tab.label));
      b.addEventListener('click', () => choose(tab.id));
      b.addEventListener('dblclick', () => setCollapsed(!isCollapsed));
      return b;
    });
    fold.replaceChildren(icon(isCollapsed ? 'chevron-down' : 'chevron-up'));
    fold.title = isCollapsed ? `${t('Show the ribbon')} (Ctrl+F1)` : `${t('Collapse the ribbon')} (Ctrl+F1)`;
    fold.setAttribute('aria-label', fold.title);
    tabRow.replaceChildren(...tabs, h('span', { class: 'rb-spacer' }), tabEnd, fold);
  };

  const draw = () => {
    el.classList.toggle('collapsed', isCollapsed);
    el.classList.toggle('peek', isCollapsed && peeking);
    drawTabs();
    drawPanel();
  };

  function choose(id: string) {
    if (isCollapsed) {
      // a collapsed ribbon opens over the page for a moment, Word-style
      peeking = !(peeking && id === current);
    }
    current = id;
    write(TAB_KEY, id);
    draw();
  }

  function setCollapsed(collapsed: boolean) {
    isCollapsed = collapsed;
    peeking = false;
    write(COLLAPSED_KEY, collapsed ? '1' : '');
    draw();
    onChange();
  }

  fold.addEventListener('click', () => setCollapsed(!isCollapsed));
  // while peeking, using a button or clicking elsewhere closes the panel again
  const endPeek = () => {
    if (!peeking) return;
    peeking = false;
    draw();
  };
  panel.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.rb-btn:not([data-menu])')) setTimeout(endPeek, 0);
  });
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    if (peeking && !target.closest('#ribbon') && !target.closest('.menu') && !target.closest('.tt-pop')) endPeek();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1' && e.ctrlKey && !e.altKey && !e.metaKey && document.body.contains(el) && el.offsetParent !== null) {
      e.preventDefault();
      setCollapsed(!isCollapsed);
    } else if (e.key === 'Escape' && peeking) {
      endPeek();
    }
  });

  draw();
  return {
    el,
    fontSlot,
    tabEnd,
    setCollapsed,
    collapsed: () => isCollapsed,
    relabel: draw,
  };
}
