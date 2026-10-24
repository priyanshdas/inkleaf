// SPDX-License-Identifier: GPL-3.0-or-later
// "All tools": every tool in one place, grouped by what you're trying to do.

import { h, icon, modal } from './ui';

export interface HubTool {
  title: string;
  detail: string;
  icon: string;
  command: string;
  /** Works without a document open (it opens or makes one itself). */
  standalone?: boolean;
  /** Uses the internet (shown with a small badge). */
  online?: boolean;
}

export const HUB: { group: string; tools: HubTool[] }[] = [
  {
    group: 'Organize',
    tools: [
      { title: 'Merge PDF', detail: 'Add another PDF’s pages to this one.', icon: 'file-plus', command: 'insert-pdf' },
      { title: 'Split PDF', detail: 'Break it into several files.', icon: 'scissors', command: 'split' },
      { title: 'Remove pages', detail: 'Delete the pages you’ve selected.', icon: 'file-minus', command: 'delete-pages' },
      { title: 'Extract pages', detail: 'Save some pages as a new PDF.', icon: 'file-output', command: 'extract' },
      { title: 'Organize PDF', detail: 'Drag pages into a new order.', icon: 'layout-grid', command: 'organize' },
      { title: 'Scan to PDF', detail: 'Use your camera or phone photos.', icon: 'scan-line', command: 'scan-to-pdf', standalone: true },
    ],
  },
  {
    group: 'Optimize',
    tools: [
      { title: 'Compress PDF', detail: 'Make the file smaller.', icon: 'file-archive', command: 'compress' },
      { title: 'Repair PDF', detail: 'Rescue a damaged file.', icon: 'wrench', command: 'repair', standalone: true },
      { title: 'OCR PDF', detail: 'Make scanned text searchable.', icon: 'scan-text', command: 'ocr' },
    ],
  },
  {
    group: 'Convert to PDF',
    tools: [
      { title: 'JPG to PDF', detail: 'Pictures, one per page.', icon: 'file-image', command: 'images-to-pdf', standalone: true },
      { title: 'Word to PDF', detail: '.docx, .doc, .odt, .rtf', icon: 'file-text', command: 'convert-to-pdf', standalone: true },
      { title: 'PowerPoint to PDF', detail: '.pptx, .ppt, .odp', icon: 'presentation', command: 'convert-to-pdf', standalone: true },
      { title: 'Excel to PDF', detail: '.xlsx, .xls, .ods, .csv', icon: 'sheet', command: 'convert-to-pdf', standalone: true },
      { title: 'HTML to PDF', detail: 'A web address or an .html file.', icon: 'globe', command: 'web-to-pdf', standalone: true, online: true },
    ],
  },
  {
    group: 'Convert from PDF',
    tools: [
      { title: 'PDF to JPG', detail: 'Each page as a picture.', icon: 'file-image', command: 'pdf-to-images' },
      { title: 'PDF to Word', detail: 'Editable text and pictures.', icon: 'file-text', command: 'pdf-to-word' },
      { title: 'PDF to PowerPoint', detail: 'One slide per page.', icon: 'presentation', command: 'pdf-to-pptx' },
      { title: 'PDF to Excel', detail: 'Tables into rows and columns.', icon: 'sheet', command: 'pdf-to-xlsx' },
      { title: 'PDF to PDF/A', detail: 'For long-term archiving.', icon: 'archive', command: 'pdf-to-pdfa' },
    ],
  },
  {
    group: 'Edit',
    tools: [
      { title: 'Rotate PDF', detail: 'Turn the selected pages.', icon: 'rotate-cw', command: 'rotate-right' },
      { title: 'Add page numbers', detail: 'Numbers, headers and footers.', icon: 'list-ordered', command: 'decor' },
      { title: 'Add watermark', detail: 'Text across every page.', icon: 'droplets', command: 'decor' },
      { title: 'Crop PDF', detail: 'Trim the edges of pages.', icon: 'crop', command: 'crop' },
      { title: 'Edit PDF', detail: 'Change the text that’s already there.', icon: 'square-pen', command: 'edit-text' },
      { title: 'PDF forms', detail: 'Add fields people can fill in.', icon: 'text-cursor', command: 'form-builder' },
    ],
  },
  {
    group: 'Security',
    tools: [
      { title: 'Unlock PDF', detail: 'Remove a password you know.', icon: 'lock-open', command: 'unlock', standalone: true },
      { title: 'Protect PDF', detail: 'Add a password.', icon: 'shield-check', command: 'protect' },
      { title: 'Sign PDF', detail: 'Draw, type or add your signature.', icon: 'signature', command: 'sign' },
      { title: 'Redact PDF', detail: 'Black out and remove private text.', icon: 'eye-off', command: 'redact' },
      { title: 'Compare PDF', detail: 'See what changed between two.', icon: 'git-compare', command: 'compare' },
    ],
  },
  {
    group: 'Intelligence',
    tools: [
      { title: 'AI Summarizer', detail: 'The key points, in seconds.', icon: 'sparkles', command: 'ai-summarize', online: true },
      { title: 'Translate PDF', detail: 'Into 16 languages, layout kept.', icon: 'languages', command: 'ai-translate', online: true },
      { title: 'PDF to Markdown', detail: 'Text with headings and lists.', icon: 'hash', command: 'pdf-to-md' },
    ],
  },
];

/** Shows the hub. Resolves to the chosen tool, or null. */
export async function allTools(hasDoc: boolean): Promise<HubTool | null> {
  let chosen: HubTool | null = null;
  let close: () => void = () => {};
  const search = h('input', { class: 'field-input hub-search', type: 'search', placeholder: 'Find a tool…', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const groups = HUB.map(({ group, tools }) => {
    const cards = tools.map((t) => {
      const needsDoc = !t.standalone && !hasDoc;
      const card = h('button', { class: 'hub-tool', 'data-hub': t.command, title: needsDoc ? `${t.detail} (opens a PDF first)` : t.detail },
        h('span', { class: 'hub-icon' }, icon(t.icon)),
        h('span', { class: 'hub-text' }, h('strong', {}, t.title), h('span', {}, t.detail)),
        t.online ? h('span', { class: 'hub-badge', title: 'Uses the internet' }, icon('globe')) : '');
      card.addEventListener('click', () => {
        chosen = t;
        close();
      });
      return { t, card };
    });
    const section = h('section', { class: 'hub-group' }, h('h3', {}, group), h('div', { class: 'hub-grid' }, ...cards.map((c) => c.card)));
    return { section, cards };
  });
  const empty = h('p', { class: 'hub-empty', hidden: true }, 'No tool matches that.');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const g of groups) {
      let shown = 0;
      for (const { t, card } of g.cards) {
        const hit = !q || `${t.title} ${t.detail}`.toLowerCase().includes(q);
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
  const shown = modal({ title: 'All tools', wide: true, body, buttons: [{ label: 'Close', value: 'cancel' }] });
  // a card click closes the dialog the same way Escape would
  close = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  requestAnimationFrame(() => search.focus());
  await shown;
  return chosen;
}
