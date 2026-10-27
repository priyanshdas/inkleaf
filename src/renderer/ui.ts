// SPDX-License-Identifier: GPL-3.0-or-later
import { currentLocale, isRtl, t } from '../shared/i18n';
import { icons } from './generated/icons';

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | EventListener | undefined> & {
  class?: string;
  style?: string;
};

/** Tiny element builder: h('button', { class: 'x', onclick }, 'Label') */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function icon(name: string): SVGElement {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = icons[name] ?? icons['x'];
  const svg = wrapper.firstElementChild as SVGElement;
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** Replaces <i data-icon="name"> placeholders in static HTML with real icons. */
/**
 * Translates the window's built-in text (button labels and tooltips written
 * in index.html) and sets the page's language and direction.
 */
export function localizeStatic(root: HTMLElement = document.body) {
  document.documentElement.lang = currentLocale();
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
  if (currentLocale() === 'en') return;
  for (const el of root.querySelectorAll<HTMLElement>('[title], [aria-label], [placeholder]')) {
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value && /[A-Za-z]/.test(value)) el.setAttribute(attr, t(value));
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.trim();
    if (text && /[A-Za-z]/.test(text) && text !== 'Inkleaf' && !node.parentElement?.closest('script, style')) {
      node.nodeValue = node.nodeValue!.replace(text, t(text));
    }
  }
}

export function hydrateIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    el.replaceWith(icon(el.dataset.icon!));
  }
}

// --- toasts ----------------------------------------------------------------

/** Set in engine mode, where the phone app shows messages itself. */
export const toastHook: { send: ((message: string, kind: string) => void) | null } = { send: null };

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 4200) {
  if (toastHook.send) return toastHook.send(message, kind);
  const root = document.getElementById('toasts')!;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, ms);
}

/**
 * A translated sentence with elements (links, bold names) in it: the
 * sentence keeps {name} placeholders so translators can move them freely.
 */
export function richText(sentence: string, parts: Record<string, Node>): (Node | string)[] {
  return sentence.split(/(\{\w+\})/).filter(Boolean).map((piece) => {
    const m = /^\{(\w+)\}$/.exec(piece);
    return m && parts[m[1]] ? parts[m[1]] : piece;
  });
}

/** One toast that stays up and can be updated, for things like downloads. */
let liveToast: HTMLElement | null = null;
let liveTimer = 0;
export function liveStatus(message: string | null) {
  clearTimeout(liveTimer);
  if (message === null) {
    const el = liveToast;
    liveToast = null;
    el?.classList.remove('show');
    setTimeout(() => el?.remove(), 400);
    return;
  }
  if (!liveToast) {
    liveToast = h('div', { class: 'toast toast-info', role: 'status' });
    document.getElementById('toasts')!.append(liveToast);
    const el = liveToast;
    requestAnimationFrame(() => el.classList.add('show'));
  }
  liveToast.textContent = message;
  // never left hanging if the last update doesn't arrive
  liveTimer = window.setTimeout(() => liveStatus(null), 60_000);
}

// --- modals ------------------------------------------------------------------

export interface ModalButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface ModalOptions {
  title: string;
  body?: Node | string;
  buttons?: ModalButton[];
  /** Value returned when the user presses Escape or clicks outside. */
  dismissValue?: string;
  wide?: boolean;
  /** Runs before closing with a non-dismiss value; return false to stay open. */
  validate?: (value: string) => boolean | Promise<boolean>;
  /** Called once the dialog is showing, with a way to close it from code. */
  onOpen?: (close: (value: string) => void) => void;
}

let openModals = 0;
/** Open dialogs, newest last: only the top one answers the keyboard. */
const modalStack: object[] = [];

export function isModalOpen() {
  return openModals > 0;
}

export function modal(options: ModalOptions): Promise<string> {
  return new Promise((resolve) => {
    const dismiss = options.dismissValue ?? 'cancel';
    const buttons = options.buttons ?? [{ label: t('OK'), value: 'ok', primary: true }];
    const previousFocus = document.activeElement as HTMLElement | null;

    const self = {};
    const close = async (value: string) => {
      if (value !== dismiss && options.validate && !(await options.validate(value))) return;
      modalStack.splice(modalStack.indexOf(self), 1);
      backdrop.classList.remove('show');
      // let clicks through while it fades out
      backdrop.style.pointerEvents = 'none';
      openModals--;
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => backdrop.remove(), 160);
      previousFocus?.focus?.();
      resolve(value);
    };

    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== self) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(dismiss);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(primary.value);
        }
      }
    };

    const footer = h('footer', { class: 'modal-actions' },
      ...buttons.map((b) =>
        h('button', {
          class: `btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`,
          onclick: () => close(b.value),
        }, b.label),
      ),
    );

    const dialog = h('div', { class: `modal${options.wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('h2', { class: 'modal-title' }, options.title),
      typeof options.body === 'string' ? h('p', { class: 'modal-text' }, options.body) : options.body ?? null,
      footer,
    );
    const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(dismiss);
    });

    document.getElementById('modal-root')!.append(backdrop);
    openModals++;
    modalStack.push(self);
    document.addEventListener('keydown', onKey, true);
    options.onOpen?.((value) => void close(value));
    requestAnimationFrame(() => {
      backdrop.classList.add('show');
      const focusable = dialog.querySelector<HTMLElement>('input, select, textarea') ??
        footer.querySelector<HTMLElement>('.btn-primary');
      focusable?.focus();
    });
  });
}

export async function confirmDialog(title: string, body: string, confirmLabel = 'OK', danger = false) {
  const result = await modal({
    title,
    body,
    buttons: [
      { label: t('Cancel'), value: 'cancel' },
      { label: confirmLabel, value: 'ok', primary: true, danger },
    ],
  });
  return result === 'ok';
}

export async function promptDialog(
  title: string,
  label: string,
  options: { value?: string; type?: string; placeholder?: string; hint?: string; validate?: (v: string) => string | null } = {},
): Promise<string | null> {
  const input = h('input', {
    class: 'field-input',
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const error = h('p', { class: 'field-error' });
  const body = h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    input,
    options.hint ? h('span', { class: 'field-hint' }, options.hint) : null,
    error,
  );
  const result = await modal({
    title,
    body,
    buttons: [
      { label: t('Cancel'), value: 'cancel' },
      { label: t('OK'), value: 'ok', primary: true },
    ],
    validate: () => {
      const message = options.validate?.(input.value) ?? null;
      error.textContent = message ?? '';
      if (message) input.focus();
      return !message;
    },
  });
  return result === 'ok' ? input.value : null;
}

/** Opens the system file chooser for images and resolves with a data URL. */
export function pickImage(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      resolve(file ? await imageFileToDataUrl(file) : null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * PDFs can only hold PNG and JPEG, so anything else is redrawn to a PNG.
 * Very large photos are scaled down too; nobody needs a 6000px signature.
 */
export async function imageFileToDataUrl(file: Blob, maxSide = 2400): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = original;
  await img.decode();
  const isPdfFriendly = /^data:image\/(png|jpeg)/.test(original);
  const tooBig = Math.max(img.naturalWidth, img.naturalHeight) > maxSide;
  if (isPdfFriendly && !tooBig) return original;

  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = h('canvas', { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = /^data:image\/jpeg/.test(original);
  return canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.9);
}
