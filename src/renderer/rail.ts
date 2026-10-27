// SPDX-License-Identifier: GPL-3.0-or-later
// The tool rail on the left: a button that widens it to show each tool's
// name, and a card that appears when you rest the pointer on a tool, with its
// name, its shortcut and what it does.

import { msg, t } from '../shared/i18n';
import { isMobile } from '../shared/platform';
import { h, icon } from './ui';

/** What each tool does, and its key, for the cards. */
const TIPS: Record<string, { key?: string; text: string }> = {
  select: { key: 'V', text: msg('Pick, move and resize anything you’ve added. Drag across the PDF’s own words to copy them.') },
  hand: { key: 'H', text: msg('Drag the page around. Hold Space to do this with any tool.') },
  'edit-text': { key: 'E', text: msg('Click a line in the PDF and retype it. The old words are removed from the file when you save.') },
  text: { key: 'T', text: msg('Click anywhere on the page and type.') },
  pen: { key: 'P', text: msg('Draw freehand, like with a pen.') },
  highlight: { key: 'M', text: msg('Drag across text to highlight it.') },
  rect: { key: 'R', text: msg('Rectangles, ellipses, lines and arrows.') },
  whiteout: { key: 'W', text: msg('Cover part of the page with white, to hide it or write over it.') },
  redact: { key: 'B', text: msg('Black out private text. It’s deleted from the file when you save.') },
  eraser: { key: 'X', text: msg('Click things you’ve added to remove them.') },
  note: { key: 'N', text: msg('Pin a comment to the page. Other PDF apps show it too.') },
  stamp: { key: 'K', text: msg('Approved, Paid, Confidential and more, with the date if you like.') },
  sign: { text: msg('Draw, type or upload your signature.') },
  image: { text: msg('Place a picture on the page.') },
};

const STORE = 'inkleaf.rail-wide';
const SHOW_DELAY = 450;
/** After one card, moving to the next tool shows its card straight away. */
const QUICK_FOR = 700;

export function setupRail() {
  const rail = document.getElementById('rail');
  const app = document.getElementById('app');
  if (!rail || !app || isMobile()) return;

  // --- names on or off -------------------------------------------------------
  const toggle = h('button', { class: 'rail-expand', type: 'button' });
  const label = h('span');
  toggle.append(icon('panel-left-open'), label);
  const setWide = (wide: boolean, remember = true) => {
    app.classList.toggle('rail-wide', wide);
    toggle.setAttribute('aria-pressed', String(wide));
    toggle.replaceChildren(icon(wide ? 'panel-left-close' : 'panel-left-open'), label);
    label.textContent = wide ? t('Hide names') : t('Show names');
    toggle.setAttribute('aria-label', wide ? t('Hide tool names') : t('Show tool names'));
    if (remember) {
      try { localStorage.setItem(STORE, wide ? '1' : ''); } catch { /* fine */ }
    }
  };
  toggle.addEventListener('click', () => {
    hide();
    setWide(!app.classList.contains('rail-wide'));
  });
  rail.append(h('span', { class: 'rail-fill' }), toggle);
  let saved = false;
  try { saved = localStorage.getItem(STORE) === '1'; } catch { /* fine */ }
  setWide(saved, false);

  // --- the hover card ---------------------------------------------------------
  const name = h('strong', { class: 'tool-tip-name' });
  const key = h('kbd', { class: 'tool-tip-key' });
  const text = h('p', { class: 'tool-tip-text' });
  const card = h('div', { class: 'tool-tip', id: 'tool-tip', role: 'tooltip', hidden: true },
    h('div', { class: 'tool-tip-head' }, name, key), text);
  document.body.append(card);

  let timer = 0;
  let lastHidden = 0;
  let current: HTMLElement | null = null;

  const tools = [...rail.querySelectorAll<HTMLElement>('.rail-tool[data-tool]')];
  for (const button of tools) {
    // the card replaces the browser's own tooltip
    const title = button.getAttribute('title');
    if (title) button.removeAttribute('title');
    const shown = button.querySelector('span')?.textContent?.trim() ?? title ?? '';
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', shown);
    button.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      schedule(button);
    });
    button.addEventListener('pointerleave', hide);
    button.addEventListener('pointerdown', hide);
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) show(button);
    });
    button.addEventListener('blur', hide);
  }
  toggle.addEventListener('pointerenter', hide);
  rail.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  function schedule(button: HTMLElement) {
    window.clearTimeout(timer);
    const quick = !card.hidden || performance.now() - lastHidden < QUICK_FOR;
    timer = window.setTimeout(() => show(button), quick ? 0 : SHOW_DELAY);
  }

  function show(button: HTMLElement) {
    const tool = button.hasAttribute('data-shapes') ? 'rect' : button.dataset.tool ?? '';
    const tip = TIPS[tool];
    if (!tip) return;
    current = button;
    name.textContent = button.getAttribute('aria-label') ?? '';
    key.textContent = tip.key ?? '';
    key.hidden = !tip.key;
    text.textContent = t(tip.text);
    card.hidden = false;
    button.setAttribute('aria-describedby', 'tool-tip');

    // beside the rail, lined up with the button, kept on screen
    const r = button.getBoundingClientRect();
    const railBox = rail!.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    const w = card.offsetWidth, ch = card.offsetHeight;
    const x = rtl ? railBox.left - w - 8 : railBox.right + 8;
    const y = Math.min(Math.max(8, r.top + r.height / 2 - ch / 2), window.innerHeight - ch - 8);
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
    card.style.setProperty('--arrow-y', `${Math.round(r.top + r.height / 2 - y)}px`);
    card.classList.toggle('from-right', rtl);
  }

  function hide() {
    window.clearTimeout(timer);
    if (!card.hidden) lastHidden = performance.now();
    card.hidden = true;
    current?.removeAttribute('aria-describedby');
    current = null;
  }
}
