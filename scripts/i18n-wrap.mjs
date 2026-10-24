// SPDX-License-Identifier: GPL-3.0-or-later
// One-off codemod: wraps interface text in t() (or msg() for module-level
// constants that are translated where they're shown). Kept for reference and
// for wrapping new files: `node scripts/i18n-wrap.mjs src/renderer/new-file.ts`.
// Review the diff afterwards; plurals need a hand-written {n, plural, …}.

import fs from 'node:fs';
import path from 'node:path';
// needs the TypeScript 5 compiler API (TypeScript 7 has none yet): INKLEAF_TS=path/to/typescript
const ts = (await import(process.env.INKLEAF_TS ?? 'typescript')).default;

const CALLS_FIRST = new Set(['toast', 'liveStatus', 'showError', 'progress', 'withBusy', 'tool', 'Error', 'Option', 'confirmDialog', 'step']);
const CALLS_ALL = new Set(['confirmDialog']);
const PROPS = new Set(['title', 'body', 'label', 'hint', 'detail', 'group', 'placeholder', 'aria-label', 'message', 'subtitle', 'heading']);
const ASSIGN_PROPS = new Set(['textContent', 'title', 'placeholder', 'innerText']);
const ATTRS = new Set(['title', 'aria-label', 'placeholder']);

const report = [];

function looksLikeText(s) {
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (/^[a-z][\w-]*$/.test(s)) return false; // identifiers, class names, commands
  if (/^[.#]?[a-z-]+( [.#a-z-]+)*$/.test(s) && !/ /.test(s)) return false;
  if (/^(\.\/|https?:|data:|app:|M\s|[a-z]+\/[a-z])/.test(s)) return false;
  if (/^\s*$/.test(s)) return false;
  return true;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return '';
}

function topLevel(node) {
  // inside a function body → evaluated when shown; otherwise at import time
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return false;
  }
  return true;
}

function varName(expr, used) {
  let name = 'value';
  if (ts.isIdentifier(expr)) name = expr.text;
  else if (ts.isPropertyAccessExpression(expr)) name = expr.name.text;
  else if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) name = expr.expression.name.text;
  else if (ts.isElementAccessExpression(expr)) name = 'item';
  name = name.replace(/^(get|to)([A-Z])/, (_, __, c) => c.toLowerCase());
  let unique = name;
  for (let i = 2; used.has(unique); i++) unique = `${name}${i}`;
  used.add(unique);
  return unique;
}

function wrapFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  let usedT = false, usedMsg = false;

  const inWrapper = (node) => {
    const p = node.parent;
    return p && ts.isCallExpression(p) && ['t', 'msg', 'format'].includes(calleeName(p.expression));
  };

  const wrap = (node) => {
    if (inWrapper(node)) return;
    const fn = topLevel(node) ? 'msg' : 't';
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!looksLikeText(node.text)) return;
      edits.push([node.getStart(sf), node.getEnd(), `${fn}(${node.getText(sf)})`]);
      fn === 't' ? (usedT = true) : (usedMsg = true);
    } else if (ts.isTemplateExpression(node)) {
      if (fn === 'msg') { report.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} template at top level`); return; }
      const used = new Set();
      let text = node.head.text;
      const vars = [];
      let tricky = false;
      for (const span of node.templateSpans) {
        const e = span.expression;
        if (ts.isConditionalExpression(e) || ts.isTemplateExpression(e) || ts.isBinaryExpression(e)) tricky = true;
        const name = varName(e, used);
        vars.push(`${name}: ${e.getText(sf)}`);
        text += `{${name}}` + span.literal.text;
      }
      if (!looksLikeText(text.replace(/\{\w+\}/g, ''))) return;
      if (tricky) report.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} check: ${node.getText(sf).slice(0, 90)}`);
      const literal = `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
      const shorthand = vars.map((v) => { const [k, ...rest] = v.split(': '); return rest.join(': ') === k ? k : v; });
      edits.push([node.getStart(sf), node.getEnd(), `t(${literal}, { ${shorthand.join(', ')} })`]);
      usedT = true;
    }
  };

  const isText = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const args = node.arguments ?? [];
      if (CALLS_FIRST.has(name) && args[0] && isText(args[0])) wrap(args[0]);
      if (CALLS_ALL.has(name)) args.forEach((a) => isText(a) && wrap(a));
      if (name === 'h') args.slice(2).forEach((a) => isText(a) && wrap(a));
      if (name === 'setAttribute' && args[0] && ts.isStringLiteral(args[0]) && ATTRS.has(args[0].text) && args[1] && isText(args[1])) wrap(args[1]);
    }
    if (ts.isPropertyAssignment(node) && isText(node.initializer)) {
      const key = ts.isIdentifier(node.name) ? node.name.text : ts.isStringLiteral(node.name) ? node.name.text : '';
      if (PROPS.has(key)) wrap(node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isText(node.right)
      && ts.isPropertyAccessExpression(node.left) && ASSIGN_PROPS.has(node.left.name.text)) wrap(node.right);
    if (ts.isConditionalExpression(node) && node.parent && !ts.isTemplateSpan(node.parent)) {
      // `cond ? 'A' : 'B'` passed where text goes: handled if the parent wrap applies
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) return 0;

  edits.sort((a, b) => b[0] - a[0]);
  // drop edits nested inside another (outer wins)
  const kept = [];
  for (const e of edits) if (!kept.some((k) => e[0] >= k[0] && e[1] <= k[1])) kept.push(e);
  let out = source;
  for (const [start, end, text] of kept) out = out.slice(0, start) + text + out.slice(end);

  const names = [usedT && 't', usedMsg && 'msg'].filter(Boolean);
  const rel = path.relative(path.dirname(file), path.resolve('src/shared/i18n')).replace(/\\/g, '/');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  if (!/from '[^']*shared\/i18n'/.test(out) && !file.endsWith('i18n.ts')) {
    const firstImport = out.search(/^import /m);
    const line = `import { ${names.join(', ')} } from '${spec}';\n`;
    out = firstImport >= 0 ? out.slice(0, firstImport) + line + out.slice(firstImport) : line + out;
  }
  fs.writeFileSync(file, out);
  return kept.length;
}

const files = process.argv.slice(2);
let total = 0;
for (const f of files) {
  const n = wrapFile(f);
  if (n) console.log(`${n}\t${f}`);
  total += n;
}
console.log(`${total} strings wrapped`);
if (report.length) console.log(`\nTo check by hand:\n${report.join('\n')}`);
