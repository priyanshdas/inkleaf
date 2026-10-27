// SPDX-License-Identifier: GPL-3.0-or-later
// The world's major languages, in one list used by text recognition,
// translation, typing and the app's own menus.
//
// Each language names its writing system ("script"), which decides the font
// text in it is written with. Most scripts' fonts are small and ship with
// Inkleaf; Chinese, Japanese and Korean fonts are large, so they download
// the first time they're needed, as do text-recognition models (except
// the four that always shipped: English, Hindi, Bengali and Italian).

import { currentLocale } from './i18n';

export type Script =
  | 'latin' | 'arabic' | 'hebrew' | 'devanagari' | 'bengali' | 'gujarati' | 'gurmukhi'
  | 'tamil' | 'telugu' | 'kannada' | 'malayalam' | 'oriya' | 'sinhala' | 'thai' | 'lao'
  | 'khmer' | 'myanmar' | 'ethiopic' | 'georgian' | 'armenian'
  | 'sc' | 'tc' | 'jp' | 'kr';

export interface Language {
  /** BCP 47 code, e.g. "hi", "zh-CN". */
  code: string;
  /** Name in English. */
  name: string;
  /** Name in the language itself. */
  native: string;
  /** Tesseract model for text recognition, if there is one. */
  ocr?: string;
  script: Script;
  /** Written right to left. */
  rtl?: boolean;
}

// Roughly by number of speakers, then grouped so similar ones sit together.
export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', native: 'English', ocr: 'eng', script: 'latin' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文', ocr: 'chi_sim', script: 'sc' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文', ocr: 'chi_tra', script: 'tc' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', ocr: 'hin', script: 'devanagari' },
  { code: 'es', name: 'Spanish', native: 'Español', ocr: 'spa', script: 'latin' },
  { code: 'fr', name: 'French', native: 'Français', ocr: 'fra', script: 'latin' },
  { code: 'ar', name: 'Arabic', native: 'العربية', ocr: 'ara', script: 'arabic', rtl: true },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', ocr: 'ben', script: 'bengali' },
  { code: 'pt', name: 'Portuguese', native: 'Português', ocr: 'por', script: 'latin' },
  { code: 'ru', name: 'Russian', native: 'Русский', ocr: 'rus', script: 'latin' },
  { code: 'ur', name: 'Urdu', native: 'اردو', ocr: 'urd', script: 'arabic', rtl: true },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', ocr: 'ind', script: 'latin' },
  { code: 'de', name: 'German', native: 'Deutsch', ocr: 'deu', script: 'latin' },
  { code: 'ja', name: 'Japanese', native: '日本語', ocr: 'jpn', script: 'jp' },
  { code: 'mr', name: 'Marathi', native: 'मराठी', ocr: 'mar', script: 'devanagari' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', ocr: 'tel', script: 'telugu' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', ocr: 'tur', script: 'latin' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', ocr: 'tam', script: 'tamil' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', ocr: 'vie', script: 'latin' },
  { code: 'ko', name: 'Korean', native: '한국어', ocr: 'kor', script: 'kr' },
  { code: 'it', name: 'Italian', native: 'Italiano', ocr: 'ita', script: 'latin' },
  { code: 'fa', name: 'Persian', native: 'فارسی', ocr: 'fas', script: 'arabic', rtl: true },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', ocr: 'guj', script: 'gujarati' },
  { code: 'pl', name: 'Polish', native: 'Polski', ocr: 'pol', script: 'latin' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', ocr: 'ukr', script: 'latin' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', ocr: 'kan', script: 'kannada' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', ocr: 'mal', script: 'malayalam' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ', ocr: 'ori', script: 'oriya' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', ocr: 'pan', script: 'gurmukhi' },
  { code: 'th', name: 'Thai', native: 'ไทย', ocr: 'tha', script: 'thai' },
  { code: 'my', name: 'Burmese', native: 'မြန်မာ', ocr: 'mya', script: 'myanmar' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', ocr: 'nld', script: 'latin' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', ocr: 'msa', script: 'latin' },
  { code: 'fil', name: 'Filipino', native: 'Filipino', ocr: 'tgl', script: 'latin' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili', ocr: 'swa', script: 'latin' },
  { code: 'am', name: 'Amharic', native: 'አማርኛ', ocr: 'amh', script: 'ethiopic' },
  { code: 'ne', name: 'Nepali', native: 'नेपाली', ocr: 'nep', script: 'devanagari' },
  { code: 'si', name: 'Sinhala', native: 'සිංහල', ocr: 'sin', script: 'sinhala' },
  { code: 'as', name: 'Assamese', native: 'অসমীয়া', ocr: 'asm', script: 'bengali' },
  { code: 'km', name: 'Khmer', native: 'ខ្មែរ', ocr: 'khm', script: 'khmer' },
  { code: 'lo', name: 'Lao', native: 'ລາວ', ocr: 'lao', script: 'lao' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά', ocr: 'ell', script: 'latin' },
  { code: 'he', name: 'Hebrew', native: 'עברית', ocr: 'heb', script: 'hebrew', rtl: true },
  { code: 'ro', name: 'Romanian', native: 'Română', ocr: 'ron', script: 'latin' },
  { code: 'cs', name: 'Czech', native: 'Čeština', ocr: 'ces', script: 'latin' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar', ocr: 'hun', script: 'latin' },
  { code: 'sv', name: 'Swedish', native: 'Svenska', ocr: 'swe', script: 'latin' },
  { code: 'da', name: 'Danish', native: 'Dansk', ocr: 'dan', script: 'latin' },
  { code: 'fi', name: 'Finnish', native: 'Suomi', ocr: 'fin', script: 'latin' },
  { code: 'no', name: 'Norwegian', native: 'Norsk', ocr: 'nor', script: 'latin' },
  { code: 'bg', name: 'Bulgarian', native: 'Български', ocr: 'bul', script: 'latin' },
  { code: 'sr', name: 'Serbian', native: 'Српски', ocr: 'srp', script: 'latin' },
  { code: 'hr', name: 'Croatian', native: 'Hrvatski', ocr: 'hrv', script: 'latin' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina', ocr: 'slk', script: 'latin' },
  { code: 'ka', name: 'Georgian', native: 'ქართული', ocr: 'kat', script: 'georgian' },
  { code: 'hy', name: 'Armenian', native: 'Հայերեն', ocr: 'hye', script: 'armenian' },
];

export const languageByCode = (code: string) => LANGUAGES.find((l) => l.code === code);

/** A language's name in the interface language ("Hindi" in English, "Hindi" → "हिन्दी" in Hindi…). */
export function languageName(nameOrCode: string): string {
  const lang = LANGUAGES.find((l) => l.name === nameOrCode || l.code === nameOrCode);
  if (!lang) return nameOrCode;
  try {
    return new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(lang.code) ?? lang.name;
  } catch {
    return lang.name;
  }
}

/** "Hindi (हिन्दी)" (or just the name when the two are the same), for lists. */
export function languageLabel(lang: Language): string {
  const shown = languageName(lang.code);
  return shown === lang.native ? shown : `${shown} (${lang.native})`;
}
export const languageByOcr = (ocr: string) => LANGUAGES.find((l) => l.ocr === ocr);

/** Scripts whose fonts download on first use rather than shipping with the app. */
export const DOWNLOADED_SCRIPTS = new Set<Script>(['sc', 'tc', 'jp', 'kr']);

/** Text-recognition models that ship with the app. */
export const BUILT_IN_OCR = new Set(['eng', 'hin', 'ben', 'ita']);
