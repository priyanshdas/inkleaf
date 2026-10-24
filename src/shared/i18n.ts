// SPDX-License-Identifier: GPL-3.0-or-later
// The app's own words in other languages.
//
// Text is written in English in the code and passed through t():
//
//   t('Saved the Word document.')
//   t('Deleted page {n}. Press Ctrl+Z to undo.', { n: 3 })
//   t('{count, plural, one {# page} other {# pages}}', { count })
//
// Translations live in src/renderer/i18n/<language>.json, keyed by a short
// fingerprint of the English text (see key()), so the files stay small and
// a changed English sentence simply shows in English until it's translated
// again. `node scripts/i18n.mjs` lists every string and what's missing.

/** Languages the interface is available in (codes from shared/languages.ts). */
export const UI_LANGUAGES = [
  'en', 'hi', 'bn', 'es', 'fr', 'ar', 'zh-CN', 'zh-TW', 'pt', 'ru', 'ja', 'de', 'id', 'it', 'ko', 'tr', 'vi',
  'ur', 'fa', 'mr', 'ta', 'te', 'gu', 'pl', 'uk', 'nl', 'th', 'he', 'ms', 'sw',
] as const;

export const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

/** FNV-1a, as 7 base-36 characters. */
export function key(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

let strings: Record<string, string> = {};
let locale = 'en';
let plurals = new Intl.PluralRules('en');
let numbers = new Intl.NumberFormat('en');

/** Switches language. `catalog` is the language file's "strings". */
export function setLocale(code: string, catalog: Record<string, string>) {
  locale = code;
  strings = catalog;
  try {
    plurals = new Intl.PluralRules(code);
    numbers = new Intl.NumberFormat(code);
  } catch {
    plurals = new Intl.PluralRules('en');
    numbers = new Intl.NumberFormat('en');
  }
}

export const currentLocale = () => locale;
export const isRtl = () => RTL_LANGUAGES.has(locale);

type Vars = Record<string, string | number>;

/** Finds the end of a {...} block, allowing nested braces. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Fills in {name} and {n, plural, one {...} other {...}} (a small part of ICU MessageFormat). */
export function format(message: string, vars: Vars = {}): string {
  let out = '';
  for (let i = 0; i < message.length; ) {
    if (message[i] !== '{') {
      out += message[i++];
      continue;
    }
    const end = closing(message, i);
    if (end < 0) {
      out += message.slice(i);
      break;
    }
    const inner = message.slice(i + 1, end);
    const comma = inner.indexOf(',');
    if (comma < 0) {
      const v = vars[inner.trim()];
      out += v === undefined ? `{${inner}}` : typeof v === 'number' ? numbers.format(v) : v;
    } else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const kind = rest.slice(0, rest.indexOf(',')).trim();
      const body = rest.slice(rest.indexOf(',') + 1);
      const options = new Map<string, string>();
      for (let j = 0; j < body.length; ) {
        const brace = body.indexOf('{', j);
        if (brace < 0) break;
        const label = body.slice(j, brace).trim();
        const stop = closing(body, brace);
        options.set(label, body.slice(brace + 1, stop));
        j = stop + 1;
      }
      const value = vars[name];
      let chosen: string | undefined;
      if (kind === 'plural') {
        const n = Number(value);
        chosen = options.get(`=${n}`) ?? options.get(plurals.select(n)) ?? options.get('other');
        chosen = chosen?.replace(/#/g, numbers.format(n));
      } else {
        chosen = options.get(String(value)) ?? options.get('other');
      }
      out += format(chosen ?? '', vars);
    }
    i = end + 1;
  }
  return out;
}

/** The interface text in the current language. */
export function t(english: string, vars?: Vars): string {
  return format(strings[key(english)] ?? english, vars);
}

/** Marks text for translation where it's defined; t() translates it where it's shown. */
export const msg = (english: string) => english;

// In a window, the preload script has already fetched this run's language,
// so text is translated from the very first t() call.
{
  const preset = (globalThis as { inkleaf?: { i18n?: { locale: string; strings: Record<string, string> } } }).inkleaf?.i18n;
  if (preset && preset.locale !== 'en') setLocale(preset.locale, preset.strings);
}
