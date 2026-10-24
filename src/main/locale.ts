// SPDX-License-Identifier: GPL-3.0-or-later
// Which language the app speaks, and loading its translations.
//
// The choice is "system" (follow the computer's language when Inkleaf has
// it, English otherwise) or a language code. It's read once at start-up;
// changing it restarts the app, so every window and menu agrees.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { setLocale, UI_LANGUAGES } from '../shared/i18n';

export interface Catalog {
  locale: string;
  strings: Record<string, string>;
}

let current: Catalog = { locale: 'en', strings: {} };

/** Matches the computer's languages ("pt-BR", "zh-Hant-TW", "hi-IN") to one Inkleaf has. */
export function systemLanguage(): string {
  const wanted = [...app.getPreferredSystemLanguages(), app.getLocale()].filter(Boolean);
  const have = UI_LANGUAGES as readonly string[];
  for (const tag of wanted) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) {
      // Taiwan, Hong Kong, Macau and anything marked Hant use Traditional
      return /hant|-tw|-hk|-mo/.test(lower) ? 'zh-TW' : 'zh-CN';
    }
    const base = lower.split(/[-_]/)[0];
    const hit = have.find((code) => code.toLowerCase() === lower) ?? have.find((code) => code.toLowerCase() === base);
    if (hit) return hit;
  }
  return 'en';
}

/** Loads the language for this run. `choice` is "system" or a language code. */
export function loadLocale(choice: string | undefined): Catalog {
  const code = !choice || choice === 'system' ? systemLanguage() : (UI_LANGUAGES as readonly string[]).includes(choice) ? choice : 'en';
  let strings: Record<string, string> = {};
  if (code !== 'en') {
    try {
      const file = path.join(__dirname, 'renderer', 'i18n', `${code}.json`);
      strings = (JSON.parse(fs.readFileSync(file, 'utf8')) as { strings?: Record<string, string> }).strings ?? {};
    } catch {
      // a missing or broken file just means English
    }
  }
  current = { locale: code, strings };
  setLocale(code, strings);
  return current;
}

export const catalog = () => current;
