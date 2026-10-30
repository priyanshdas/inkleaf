// SPDX-License-Identifier: GPL-3.0-or-later
// Collects every piece of interface text passed to t() or msg(), writes the
// English list to src/renderer/i18n/strings.json, and reports how complete
// each language is.
//
//   node scripts/i18n.mjs           list counts
//   node scripts/i18n.mjs --missing hi    print the strings Hindi still needs, as JSON

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src', 'renderer', 'i18n');

/** Same fingerprint as shared/i18n.ts. */
function key(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

function sources(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(folder, e.name);
    if (e.isDirectory()) return e.name === 'generated' ? [] : sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Every string literal passed straight to t(, msg( or (on phones) inkleafT( or relayT( in a source file. */
function calls(src, kotlin = false) {
  const found = [];
  // the Android screens (Kotlin) translate with tr("…") and mark list labels with msg("…")
  const pattern = kotlin ? /(?<![\w$.])(?:tr|msg)\(\s*(")/g : /(?:(?<![\w$.])(?:t|msg)|\b(?:inkleafT|relayT))\(\s*(['"`])/g;
  for (const m of src.matchAll(pattern)) {
    // usage examples in comments aren't real calls
    const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index).trimStart();
    if (line.startsWith('//') || line.startsWith('*')) continue;
    const quote = m[1];
    let out = '';
    let j = m.index + m[0].length;
    for (; j < src.length && src[j] !== quote; j++) {
      if (src[j] !== '\\') { out += src[j]; continue; }
      const n = src[++j];
      if (n === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16)); j += 4; }
      else out += { n: '\n', t: '\t', r: '\r' }[n] ?? n;
    }
    // a template with ${…} in it is built at run time, so it can't be looked up
    if (!(quote === '`' && out.includes('${'))) found.push(out);
  }
  return found;
}

const strings = new Map();
for (const file of sources(path.join(root, 'src'))) {
  for (const text of calls(fs.readFileSync(file, 'utf8'))) strings.set(key(text), text);
}
const androidScreens = path.join(root, 'mobile', 'android', 'ui', 'src', 'main', 'java');
if (fs.existsSync(androidScreens)) {
  for (const file of fs.readdirSync(androidScreens, { recursive: true }).filter((f) => f.endsWith('.kt'))) {
    for (const text of calls(fs.readFileSync(path.join(androidScreens, file), 'utf8'), true)) strings.set(key(text), text);
  }
}

// the window's static text (translated at start-up by localizeStatic() in ui.ts)
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8')
  .replace(/<(script|style|title)[\s\S]*?<\/\1>/g, '');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&hellip;/g, '…');
const body = html.slice(html.indexOf('<body'));
for (const m of body.matchAll(/\b(?:title|aria-label|placeholder)="([^"]*[A-Za-z][^"]*)"/g)) strings.set(key(decode(m[1])), decode(m[1]));
for (const m of body.matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)) {
  const text = decode(m[1].trim());
  if (text && text !== 'Inkleaf') strings.set(key(text), text);
}

fs.mkdirSync(dir, { recursive: true });
const sorted = Object.fromEntries([...strings].sort((a, b) => a[1].localeCompare(b[1])));
fs.writeFileSync(path.join(dir, 'strings.json'), JSON.stringify(sorted, null, 1) + '\n');

const missingFor = process.argv.indexOf('--missing');
if (missingFor > 0) {
  const code = process.argv[missingFor + 1];
  const file = path.join(dir, `${code}.json`);
  const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).strings ?? {} : {};
  const need = Object.fromEntries(Object.entries(sorted).filter(([k]) => !have[k]));
  process.stdout.write(JSON.stringify(need, null, 1) + '\n');
} else {
  console.log(`${strings.size} strings`);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'strings.json').sort()) {
    const have = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).strings ?? {};
    const done = Object.keys(sorted).filter((k) => have[k]).length;
    const stale = Object.keys(have).filter((k) => !sorted[k]).length;
    console.log(`${f.replace('.json', '').padEnd(6)} ${String(done).padStart(5)} / ${strings.size}${stale ? `  (${stale} no longer used)` : ''}`);
  }
}
