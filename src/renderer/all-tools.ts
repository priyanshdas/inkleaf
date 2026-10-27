// SPDX-License-Identifier: GPL-3.0-or-later
// "All tools": every tool in one place, grouped by what you're trying to do.

import { isMobile, supports } from '../shared/platform';
import { t, msg } from '../shared/i18n';
import { h, icon, modal } from './ui';

export interface HubTool {
  title: string;
  detail: string;
  icon: string;
  command: string;
  /** Works without a document open (it opens or makes one itself). */
  standalone?: boolean;
  /** A different name in the phone apps. */
  mobileTitle?: string;
  /** Uses the internet (shown with a small badge). */
  online?: boolean;
}

export const HUB: { group: string; tools: HubTool[] }[] = [
  {
    group: msg('Organize'),
    tools: [
      { title: msg('Merge PDF'), detail: msg('Add another PDF’s pages to this one.'), icon: 'file-plus', command: 'insert-pdf' },
      { title: msg('Split PDF'), detail: msg('Break it into several files.'), icon: 'scissors', command: 'split' },
      { title: msg('Remove pages'), detail: msg('Delete the pages you’ve selected.'), icon: 'file-minus', command: 'delete-pages' },
      { title: msg('Extract pages'), detail: msg('Save some pages as a new PDF.'), icon: 'file-output', command: 'extract' },
      { title: msg('Organize PDF'), detail: msg('Drag pages into a new order.'), icon: 'layout-grid', command: 'organize' },
      { title: msg('Send to phone'), mobileTitle: msg('Send to computer'), detail: msg('Over your Wi-Fi, encrypted. No cloud.'), icon: 'smartphone', command: 'link-send' },
      { title: msg('Scan to PDF'), detail: msg('Use your camera or phone photos.'), icon: 'scan-line', command: 'scan-to-pdf', standalone: true },
    ],
  },
  {
    group: msg('Optimize'),
    tools: [
      { title: msg('Compress PDF'), detail: msg('Make the file smaller.'), icon: 'file-archive', command: 'compress' },
      { title: msg('Repair PDF'), detail: msg('Rescue a damaged file.'), icon: 'wrench', command: 'repair', standalone: true },
      { title: msg('OCR PDF'), detail: msg('Make scanned text searchable.'), icon: 'scan-text', command: 'ocr' },
      { title: msg('Enhance PDF'), detail: msg('Sharper, clearer scans and faded pages.'), icon: 'contrast', command: 'enhance' },
    ],
  },
  {
    group: msg('Convert to PDF'),
    tools: [
      { title: msg('JPG to PDF'), detail: msg('Pictures, one per page.'), icon: 'file-image', command: 'images-to-pdf', standalone: true },
      { title: msg('Word to PDF'), detail: msg('.docx, .doc, .odt, .rtf'), icon: 'file-text', command: 'convert-to-pdf', standalone: true },
      { title: msg('PowerPoint to PDF'), detail: msg('.pptx, .ppt, .odp'), icon: 'presentation', command: 'convert-to-pdf', standalone: true },
      { title: msg('Excel to PDF'), detail: msg('.xlsx, .xls, .ods, .csv'), icon: 'sheet', command: 'convert-to-pdf', standalone: true },
      { title: msg('HTML to PDF'), detail: msg('A web address or an .html file.'), icon: 'globe', command: 'web-to-pdf', standalone: true, online: true },
    ],
  },
  {
    group: msg('Convert from PDF'),
    tools: [
      { title: msg('PDF to JPG'), detail: msg('Each page as a picture.'), icon: 'file-image', command: 'pdf-to-images' },
      { title: msg('PDF to Word'), detail: msg('Editable text and pictures.'), icon: 'file-text', command: 'pdf-to-word' },
      { title: msg('PDF to PowerPoint'), detail: msg('One slide per page.'), icon: 'presentation', command: 'pdf-to-pptx' },
      { title: msg('PDF to Excel'), detail: msg('Tables into rows and columns.'), icon: 'sheet', command: 'pdf-to-xlsx' },
      { title: msg('PDF to PDF/A'), detail: msg('For long-term archiving.'), icon: 'archive', command: 'pdf-to-pdfa' },
    ],
  },
  {
    group: msg('Edit'),
    tools: [
      { title: msg('Rotate PDF'), detail: msg('Turn the selected pages.'), icon: 'rotate-cw', command: 'rotate-right' },
      { title: msg('Add page numbers'), detail: msg('Numbers, headers and footers.'), icon: 'list-ordered', command: 'decor' },
      { title: msg('Add watermark'), detail: msg('Text across every page.'), icon: 'droplets', command: 'decor' },
      { title: msg('Crop PDF'), detail: msg('Trim the edges of pages.'), icon: 'crop', command: 'crop' },
      { title: msg('Edit PDF'), detail: msg('Change the text that’s already there.'), icon: 'square-pen', command: 'edit-text' },
      { title: msg('PDF forms'), detail: msg('Add fields people can fill in.'), icon: 'text-cursor', command: 'form-builder' },
    ],
  },
  {
    group: msg('Security'),
    tools: [
      { title: msg('Unlock PDF'), detail: msg('Remove a password you know.'), icon: 'lock-open', command: 'unlock', standalone: true },
      { title: msg('Protect PDF'), detail: msg('Add a password.'), icon: 'shield-check', command: 'protect' },
      { title: msg('Share securely'), detail: msg('Lock it with a code, or to one person’s device.'), icon: 'qr-code', command: 'secure-share' },
      { title: msg('My receive code'), detail: msg('Let people lock PDFs just for you.'), icon: 'key-round', command: 'receive-code', standalone: true },
      { title: msg('Receive a file'), detail: msg('Enter or scan a pickup code someone gave you.'), icon: 'download', command: 'receive-file', standalone: true },
      { title: msg('Sign PDF'), detail: msg('Draw, type or add your signature.'), icon: 'signature', command: 'sign' },
      { title: msg('Redact PDF'), detail: msg('Black out and remove private text.'), icon: 'eye-off', command: 'redact' },
      { title: msg('Compare PDF'), detail: msg('See what changed between two.'), icon: 'git-compare', command: 'compare' },
    ],
  },
  {
    group: msg('Intelligence'),
    tools: [
      { title: msg('AI Summarizer'), detail: msg('The key points, in seconds.'), icon: 'sparkles', command: 'ai-summarize', online: true },
      { title: msg('Translate PDF'), detail: msg('Into 56 languages, layout kept.'), icon: 'languages', command: 'ai-translate', online: true },
      { title: msg('PDF to Markdown'), detail: msg('Text with headings and lists.'), icon: 'hash', command: 'pdf-to-md' },
    ],
  },
];

/** Shows the hub. Resolves to the chosen tool, or null. */
export async function allTools(hasDoc: boolean): Promise<HubTool | null> {
  let chosen: HubTool | null = null;
  let close: () => void = () => {};
  const search = h('input', { class: 'field-input hub-search', type: 'search', placeholder: t('Find a tool…'), autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const groups = HUB.map(({ group, tools }) => {
    const cards = tools.filter((tool) => supports(tool.command)).map((tool) => {
      const needsDoc = !tool.standalone && !hasDoc;
      const title = t(isMobile() && tool.mobileTitle ? tool.mobileTitle : tool.title), detail = t(tool.detail);
      const card = h('button', { class: 'hub-tool', 'data-hub': tool.command, title: needsDoc ? t('{detail} (opens a PDF first)', { detail }) : detail },
        h('span', { class: 'hub-icon' }, icon(tool.icon)),
        h('span', { class: 'hub-text' }, h('strong', {}, title), h('span', {}, detail)),
        tool.online ? h('span', { class: 'hub-badge', title: t('Uses the internet') }, icon('globe')) : '');
      card.addEventListener('click', () => {
        chosen = tool;
        close();
      });
      // found by its name in either language
      return { words: `${title} ${detail} ${tool.title} ${tool.detail}`.toLowerCase(), card };
    });
    const section = h('section', { class: 'hub-group' }, h('h3', {}, t(group)), h('div', { class: 'hub-grid' }, ...cards.map((c) => c.card)));
    return { section, cards };
  });
  const empty = h('p', { class: 'hub-empty', hidden: true }, t('No tool matches that.'));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const g of groups) {
      let shown = 0;
      for (const { words, card } of g.cards) {
        const hit = !q || words.includes(q);
        card.hidden = !hit;
        if (hit) shown++;
      }
      g.section.hidden = !shown;
      any ||= !!shown;
    }
    empty.hidden = any;
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = groups.flatMap((g) => g.cards).find((c) => !c.card.hidden);
    if (first) first.card.click();
  });

  const body = h('div', { class: 'hub' }, search, ...groups.map((g) => g.section), empty);
  const shown = modal({ title: t('All tools'), wide: true, body, buttons: [{ label: t('Close'), value: 'cancel' }] });
  // a card click closes the dialog the same way Escape would
  close = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  requestAnimationFrame(() => search.focus());
  await shown;
  return chosen;
}
