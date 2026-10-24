// SPDX-License-Identifier: GPL-3.0-or-later
import { t, msg } from '../shared/i18n';
import { tracePath } from './render';
import { h, icon, imageFileToDataUrl, modal } from './ui';

export type SignKind = 'signature' | 'initials';

const SAVED_KEYS: Record<SignKind, string> = { signature: 'inkleaf.signatures.v1', initials: 'inkleaf.initials.v1' };
const MAX_SAVED = 4;

const SCRIPT_FONTS = [
  { label: msg('Flowing'), css: '"Segoe Script", "Snell Roundhand", "URW Chancery L", "Apple Chancery", cursive' },
  { label: msg('Brush'), css: '"Brush Script MT", "Brush Script Std", "Lucida Handwriting", cursive' },
  { label: msg('Neat'), css: '"Lucida Handwriting", "Bradley Hand", "Comic Neue", "Segoe Print", cursive' },
];

const INKS = ['#14213d', '#1d3f91', '#1a1a1a'];

export function savedSignatures(kind: SignKind = 'signature'): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEYS[kind]) ?? '[]');
  } catch {
    return [];
  }
}

function remember(dataUrl: string, kind: SignKind) {
  const list = [dataUrl, ...savedSignatures(kind).filter((s) => s !== dataUrl)].slice(0, MAX_SAVED);
  try {
    localStorage.setItem(SAVED_KEYS[kind], JSON.stringify(list));
  } catch {
    // too big for storage; still usable this time
  }
}

export function forgetSignature(dataUrl: string, kind: SignKind) {
  try {
    localStorage.setItem(SAVED_KEYS[kind], JSON.stringify(savedSignatures(kind).filter((s) => s !== dataUrl)));
  } catch {
    // nothing to do
  }
}

/** Crops a canvas to its non-transparent pixels, with a little breathing room. */
function trim(canvas: HTMLCanvasElement, pad = 8): string | null {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Makes near-white pixels transparent, for photographed or scanned signatures. */
async function knockOutWhite(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const lightness = (d[i] + d[i + 1] + d[i + 2]) / 3;
    // fade gently between 190 and 235 so edges don't go jagged
    if (lightness > 235) d[i + 3] = 0;
    else if (lightness > 190) d[i + 3] = Math.round(d[i + 3] * (235 - lightness) / 45);
  }
  ctx.putImageData(pixels, 0, 0);
  return trim(canvas, 2) ?? dataUrl;
}

function drawPad(): { el: HTMLElement; result: () => string | null } {
  const canvas = h('canvas', { class: 'sig-canvas' });
  const ratio = window.devicePixelRatio || 1;
  const W = 560, H = 190;
  canvas.width = W * ratio;
  canvas.height = H * ratio;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio, ratio);

  let ink = INKS[0];
  const strokes: { color: string; points: [number, number][] }[] = [];
  let current: { color: string; points: [number, number][] } | null = null;

  const redraw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    for (const s of strokes) {
      ctx.strokeStyle = s.color;
      tracePath(ctx, s.points);
      ctx.stroke();
    }
    hint.hidden = strokes.length > 0;
  };

  const point = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    current = { color: ink, points: [point(e)] };
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) current.points.push(point(ev));
    redraw();
  });
  const end = () => (current = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const hint = h('span', { class: 'sig-hint' }, t('Sign here with your mouse, trackpad or pen'));
  const swatches = INKS.map((color) => {
    const b = h('button', { class: 'swatch', style: `--swatch:${color}`, title: t('Ink colour'), 'aria-pressed': String(color === ink) });
    b.addEventListener('click', () => {
      ink = color;
      swatches.forEach((s) => s.setAttribute('aria-pressed', String(s === b)));
      strokes.forEach((s) => (s.color = color));
      redraw();
    });
    return b;
  });
  const undo = h('button', { class: 'btn btn-ghost', onclick: () => { strokes.pop(); redraw(); } }, t('Undo stroke'));
  const clear = h('button', { class: 'btn btn-ghost', onclick: () => { strokes.length = 0; redraw(); } }, t('Clear'));

  const el = h('div', { class: 'sig-pane' },
    h('div', { class: 'sig-surface' }, canvas, hint, h('div', { class: 'sig-line' })),
    h('div', { class: 'sig-tools' }, h('div', { class: 'swatches' }, ...swatches), h('span', { class: 'spacer' }), undo, clear),
  );
  return { el, result: () => trim(canvas) };
}

function typePad(): { el: HTMLElement; result: () => string | null } {
  const input = h('input', { class: 'field-input sig-name', placeholder: t('Type your name'), autocomplete: 'name', spellcheck: 'false' });
  let font = SCRIPT_FONTS[0].css;
  let ink = INKS[0];
  const preview = h('div', { class: 'sig-type-preview' });

  const render = () => {
    preview.textContent = input.value || t('Your name');
    preview.style.fontFamily = font;
    preview.style.color = ink;
    preview.classList.toggle('placeholder', !input.value);
  };
  input.addEventListener('input', render);

  const fonts = SCRIPT_FONTS.map((f, i) => {
    const b = h('button', { class: 'chip', style: `font-family:${f.css}`, 'aria-pressed': String(i === 0) }, t(f.label));
    b.addEventListener('click', () => {
      font = f.css;
      fonts.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
    return b;
  });
  render();

  const result = () => {
    if (!input.value.trim()) return null;
    const canvas = document.createElement('canvas');
    const size = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${size}px ${font}`;
    const width = Math.ceil(ctx.measureText(input.value).width) + 40;
    canvas.width = width;
    canvas.height = size * 1.6;
    ctx.font = `${size}px ${font}`;
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(input.value, 20, canvas.height / 2);
    return trim(canvas);
  };

  const el = h('div', { class: 'sig-pane' }, input, h('div', { class: 'chips' }, ...fonts), preview);
  return { el, result };
}

function uploadPad(): { el: HTMLElement; result: () => Promise<string | null> } {
  let dataUrl: string | null = null;
  const preview = h('img', { class: 'sig-upload-preview', alt: '' });
  preview.hidden = true;
  const knockout = h('input', { type: 'checkbox', checked: true });
  const choose = h('button', { class: 'btn' }, icon('upload'), t('Choose image…'));
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  input.hidden = true;
  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    dataUrl = await imageFileToDataUrl(file, 1600);
    preview.src = dataUrl;
    preview.hidden = false;
  });

  const el = h('div', { class: 'sig-pane' },
    h('div', { class: 'sig-upload' }, choose, input, preview),
    h('label', { class: 'check' }, knockout, t(' Remove white background')),
  );
  return {
    el,
    result: async () => (dataUrl ? (knockout.checked ? await knockOutWhite(dataUrl) : dataUrl) : null),
  };
}

/** Shows the signature dialog. Resolves with a transparent PNG data URL. */
export async function chooseSignature(kind: SignKind = 'signature'): Promise<string | null> {
  const saved = savedSignatures(kind);
  let picked: string | null = null;

  const panes = { draw: drawPad(), type: typePad(), upload: uploadPad() };
  type Tab = keyof typeof panes;
  let tab: Tab = 'draw';

  const tabs = h('div', { class: 'sig-tabs', role: 'tablist' });
  const body = h('div', { class: 'sig-body' });
  const showTab = (next: Tab) => {
    tab = next;
    for (const b of tabs.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === next));
    body.replaceChildren(panes[next].el);
    body.querySelector<HTMLInputElement>('input.sig-name')?.focus();
  };
  for (const [key, label] of [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']] as const) {
    const b = h('button', { class: 'sig-tab', role: 'tab', 'data-tab': key }, label);
    b.addEventListener('click', () => showTab(key));
    tabs.append(b);
  }
  showTab('draw');

  const keepIt = h('input', { type: 'checkbox', checked: true });
  const savedRow = saved.length
    ? h('div', { class: 'sig-saved' },
        h('span', { class: 'field-label' }, t('Use a saved signature')),
        h('div', { class: 'sig-saved-list' },
          ...saved.map((s) => {
            const tile = h('button', { class: 'sig-saved-item', title: t('Use this signature') }, h('img', { src: s, alt: t('Saved signature') }));
            tile.addEventListener('click', () => {
              picked = s;
              (document.querySelector('.modal .btn-primary') as HTMLButtonElement)?.click();
            });
            const remove = h('button', { class: 'sig-forget', title: t('Forget this signature') }, icon('x'));
            remove.addEventListener('click', (e) => {
              e.stopPropagation();
              forgetSignature(s, kind);
              remove.parentElement?.remove();
            });
            return h('div', { class: 'sig-saved-wrap' }, tile, remove);
          }),
        ),
      )
    : null;

  let result: string | null = null;
  const choice = await modal({
    title: kind === 'initials' ? t('Add your initials') : t('Add your signature'),
    wide: true,
    body: h('div', { class: 'sig-dialog' },
      savedRow,
      tabs,
      body,
      h('label', { class: 'check' }, keepIt, kind === 'initials' ? t(' Remember these initials on this computer') : t(' Remember this signature on this computer')),
    ),
    buttons: [
      { label: t('Cancel'), value: 'cancel' },
      { label: kind === 'initials' ? t('Place initials') : t('Place signature'), value: 'ok', primary: true },
    ],
    validate: async () => {
      result = picked ?? (await panes[tab].result());
      if (!result) {
        body.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], { duration: 180 });
      }
      return !!result;
    },
  });

  if (choice !== 'ok' || !result) return null;
  if (keepIt.checked && !picked) remember(result, kind);
  return result;
}

/**
 * The menu under the Sign button: saved signatures and initials go on in
 * one click, or make a new one. Resolves with what to place, or null.
 */
export function signMenu(anchor: HTMLElement): Promise<{ dataUrl: string; kind: SignKind } | null> {
  return new Promise((resolve) => {
    const menu = h('div', { class: 'menu sign-menu', role: 'menu' });
    let settled = false;
    const finish = (value: { dataUrl: string; kind: SignKind } | null) => {
      if (settled) return;
      settled = true;
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const outside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) finish(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };
    const group = (kind: SignKind, title: string) => {
      const saved = savedSignatures(kind);
      const tiles = saved.map((s) => {
        const b = h('button', { class: 'sign-tile', title: kind === 'initials' ? t('Place these initials') : t('Place this signature') }, h('img', { src: s, alt: '' }));
        b.addEventListener('click', () => finish({ dataUrl: s, kind }));
        return b;
      });
      const create = h('button', { class: 'menu-item' }, icon('pen-tool'), h('span', { class: 'menu-label' }, kind === 'initials' ? t('New initials…') : t('New signature…')));
      create.addEventListener('click', async () => {
        // the dialog takes over: clicks in it mustn't count as "outside"
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', onKey, true);
        const dataUrl = await chooseSignature(kind);
        finish(dataUrl ? { dataUrl, kind } : null);
      });
      return [h('div', { class: 'menu-heading' }, title), tiles.length ? h('div', { class: 'sign-tiles' }, ...tiles) : null, create];
    };
    menu.append(...group('signature', t('Signatures')).filter(Boolean) as HTMLElement[], h('div', { class: 'menu-separator' }), ...group('initials', t('Initials')).filter(Boolean) as HTMLElement[]);
    document.getElementById('menus')!.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.right + 8}px`;
    menu.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - menu.offsetHeight - 8))}px`;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
}
