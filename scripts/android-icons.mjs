// SPDX-License-Identifier: GPL-3.0-or-later
// Turns the Lucide icons the desktop app uses into Android vector drawables, so
// the phone app's native screens share the same icons:
//
//   node scripts/android-icons.mjs
//
// Writes mobile/android/ui/src/main/res/drawable/lc_<name>.xml. Lucide icons are
// 24x24 outlines, 2 units wide with round ends; Android can draw those directly,
// once circles, rectangles and lines are written out as paths.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'lucide-static', 'icons');
const out = path.join(root, 'mobile', 'android', 'ui', 'src', 'main', 'res', 'drawable');

// the icons the native screens use
const ICONS = [
  'arrow-left', 'undo-2', 'redo-2', 'ellipsis-vertical', 'settings', 'search', 'plus', 'x', 'check',
  'files', 'wrench', 'monitor-smartphone', 'monitor', 'smartphone', 'folder-open', 'file-text', 'file-plus',
  'file-input', 'file-output', 'scan-line', 'images', 'pen-line', 'pencil', 'highlighter', 'square', 'circle',
  'minus', 'move-up-right', 'eraser', 'type', 'text-cursor-input', 'signature', 'stamp', 'message-square',
  'image', 'rectangle-horizontal', 'eye-off', 'mouse-pointer-2', 'hand', 'rotate-ccw', 'rotate-cw', 'trash-2',
  'copy', 'scissors', 'crop', 'layers', 'shrink', 'lock', 'lock-open', 'scan-text', 'git-compare', 'sparkles',
  'languages', 'share-2', 'download', 'printer', 'send', 'save', 'refresh-cw', 'wifi', 'qr-code', 'unlink',
  'sun', 'moon', 'sun-moon', 'globe', 'shield-check', 'info', 'heart', 'chevron-right', 'chevron-left',
  'check-circle-2', 'alert-circle', 'bold', 'italic', 'underline', 'a-large-small', 'paint-bucket', 'droplets',
  'archive', 'wrench', 'merge', 'split', 'file-stack', 'list-ordered', 'bookmark', 'star', 'clock', 'cloud-off',
  'file-minus', 'layout-grid', 'file-archive', 'file-image', 'presentation', 'sheet', 'square-pen', 'text-cursor', 'hash', 'arrow-right',
  'zoom-in', 'maximize-2', 'text-select', 'pen-tool', 'form-input', 'file-search', 'arrow-right-left', 'book-open',
];

const num = (v, d = 0) => (v === undefined ? d : Number(v));
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const f = (n) => +n.toFixed(3);

function circle(cx, cy, rx, ry = rx) {
  return `M${f(cx - rx)},${f(cy)}a${f(rx)},${f(ry)} 0 1,0 ${f(rx * 2)},0a${f(rx)},${f(ry)} 0 1,0 ${f(-rx * 2)},0`;
}

function rect(a) {
  const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
  let rx = num(a.rx, num(a.ry)), ry = num(a.ry, rx);
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (!rx) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${f(x + rx)},${y}h${f(w - 2 * rx)}a${rx},${ry} 0 0 1 ${rx},${ry}v${f(h - 2 * ry)}a${rx},${ry} 0 0 1 ${-rx},${ry}`
    + `h${f(-(w - 2 * rx))}a${rx},${ry} 0 0 1 ${-rx},${-ry}v${f(-(h - 2 * ry))}a${rx},${ry} 0 0 1 ${rx},${-ry}z`;
}

function toPaths(svg) {
  const paths = [];
  for (const m of svg.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)\/?>/g)) {
    const [, kind] = m;
    const a = attrs(m[2]);
    switch (kind) {
      case 'path': paths.push(a.d); break;
      case 'circle': paths.push(circle(num(a.cx), num(a.cy), num(a.r))); break;
      case 'ellipse': paths.push(circle(num(a.cx), num(a.cy), num(a.rx), num(a.ry))); break;
      case 'rect': paths.push(rect(a)); break;
      case 'line': paths.push(`M${a.x1},${a.y1}L${a.x2},${a.y2}`); break;
      case 'polyline':
      case 'polygon': {
        const pts = a.points.trim().split(/[\s,]+/).map(Number);
        let d = `M${pts[0]},${pts[1]}`;
        for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
        paths.push(kind === 'polygon' ? `${d}z` : d);
        break;
      }
    }
  }
  return paths;
}

fs.mkdirSync(out, { recursive: true });
for (const old of fs.readdirSync(out)) if (old.startsWith('lc_')) fs.rmSync(path.join(out, old));
let written = 0;
for (const name of [...new Set(ICONS)]) {
  const file = path.join(source, `${name}.svg`);
  if (!fs.existsSync(file)) {
    console.warn(`no Lucide icon called ${name}`);
    continue;
  }
  const body = toPaths(fs.readFileSync(file, 'utf8')).map((d) => `    <path
        android:pathData="${d}"
        android:strokeColor="#FF000000"
        android:strokeWidth="2"
        android:strokeLineCap="round"
        android:strokeLineJoin="round" />`).join('\n');
  fs.writeFileSync(path.join(out, `lc_${name.replace(/-/g, '_')}.xml`), `<?xml version="1.0" encoding="utf-8"?>
<!-- Lucide icon "${name}" (ISC licence), made by scripts/android-icons.mjs -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
${body}
</vector>
`);
  written++;
}
console.log(`${written} icons written to ${path.relative(root, out)}`);
