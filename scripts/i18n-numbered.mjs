// SPDX-License-Identifier: GPL-3.0-or-later
// Helpers for translators working in plain text instead of JSON:
//
//   node scripts/i18n-numbered.mjs list              numbered English list (n|text)
//   node scripts/i18n-numbered.mjs import hi file    reads "n|translation" lines into hi.json
//
// Each imported line is checked: same {placeholders}, a valid plural with
// an "other" case, the same leading/trailing spaces, and shortcuts such as
// Ctrl+S or (V) kept. Lines that fail are reported and left out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src', 'renderer', 'i18n');
const english = JSON.parse(fs.readFileSync(path.join(dir, 'strings.json'), 'utf8'));
const keys = Object.keys(english);

function placeholders(s) {
  // top-level {name} and {name, plural, ...} argument names
  const names = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (depth === 0) names.push(/^\{\s*(\w+)/.exec(s.slice(i))?.[1] ?? '?');
      depth++;
    } else if (s[i] === '}') depth--;
    if (depth < 0) return null;
  }
  return depth === 0 ? names.sort().join(',') : null;
}

const shortcuts = (s) => [...new Set(s.match(/Ctrl\+(?:[A-Za-z0-9]+|[=\-\/])|Shift\+\w+|\((?:[A-Z]|Esc|Enter)\)|Page (?:Up|Down)|sk-ant-|console\.anthropic\.com|jsDelivr|LibreOffice|libreoffice\.org|PDF\/A|Ko-fi|GitHub/g) ?? [])].sort().join(' ');

function problems(en, tr) {
  const out = [];
  if (placeholders(tr) === null) out.push('unbalanced braces');
  else if (placeholders(en) !== placeholders(tr)) out.push(`placeholders ${placeholders(en)} vs ${placeholders(tr)}`);
  if (/plural,/.test(en) && !/plural,[\s\S]*other\s*\{/.test(tr)) out.push('plural without "other"');
  if (/plural,/.test(en) && !/plural,/.test(tr)) out.push('plural missing');
  if (shortcuts(en) !== shortcuts(tr)) out.push(`kept words ${shortcuts(en)} vs ${shortcuts(tr)}`);
  return out;
}

const [cmd, code, file] = process.argv.slice(2);
if (cmd === 'list') {
  const from = Number(code ?? 1), to = Number(file ?? keys.length);
  keys.forEach((k, i) => i + 1 >= from && i + 1 <= to && console.log(`${i + 1}|${english[k]}`));
} else if (cmd === 'import') {
  const target = path.join(dir, `${code}.json`);
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { language: code, strings: {} };
  let ok = 0;
  const bad = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\d+)\|(.*)$/.exec(line);
    if (!m) continue;
    const k = keys[Number(m[1]) - 1];
    if (!k) { bad.push(`${m[1]}: no such line`); continue; }
    // the spaces at either end belong to the layout, so they come from the English
    const en = english[k];
    const tr = en.match(/^\s*/)[0] + m[2].replace(/\\n/g, '\n').trim() + en.match(/\s*$/)[0];
    const p = problems(english[k], tr);
    if (p.length) { bad.push(`${m[1]}: ${p.join('; ')}\n    en: ${english[k]}\n    ${code}: ${tr}`); continue; }
    existing.strings[k] = tr;
    ok++;
  }
  // keep the file in the English list's order
  existing.strings = Object.fromEntries(keys.filter((k) => existing.strings[k]).map((k) => [k, existing.strings[k]]));
  fs.writeFileSync(target, JSON.stringify(existing, null, 1) + '\n');
  console.log(`${code}: imported ${ok}, ${Object.keys(existing.strings).length}/${keys.length} done${bad.length ? `, ${bad.length} rejected:` : ''}`);
  for (const b of bad) console.log('  ' + b);
}
