// SPDX-License-Identifier: GPL-3.0-or-later
// A small PowerPoint (.pptx) reader that lays each slide out as HTML, for
// turning slides into a PDF when LibreOffice isn't installed.
//
// It covers what most decks are made of: text boxes and placeholders (with
// their sizes, colours, bold/italic, alignment and bullets), pictures, solid
// shape fills and outlines, tables, groups, and slide backgrounds, with
// positions taken from the slide or inherited from its layout and master.
// Charts, SmartArt, animations and fancy effects are left out.

import { t } from '../shared/i18n';
import JSZip from 'jszip';

const EMU_PER_PT = 12700;

const pt = (emu: number) => `${(emu / EMU_PER_PT).toFixed(2)}pt`;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Direct children with this local name, ignoring XML namespaces. */
const kids = (el: Element | null | undefined, name: string): Element[] =>
  el ? [...el.children].filter((c) => c.localName === name) : [];
const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
/** First descendant with this local name. */
const find = (el: Element | null | undefined, name: string): Element | null =>
  el ? (el.getElementsByTagNameNS('*', name)[0] ?? null) : null;
const num = (el: Element | null, attr: string, fallback = 0) => {
  const v = el?.getAttribute(attr);
  return v == null ? fallback : Number(v);
};

interface Box { x: number; y: number; w: number; h: number }

/** The parts of a slide's ancestry we look things up in. */
interface Context {
  zip: JSZip;
  theme: Record<string, string>;
  /** Folder of the XML part, for resolving relative links. */
  dir: string;
  rels: Record<string, string>;
  layout: Document | null;
  master: Document | null;
}

const parser = new DOMParser();
const xml = async (zip: JSZip, file: string): Promise<Document | null> => {
  const text = await zip.file(file)?.async('string');
  return text ? parser.parseFromString(text, 'application/xml') : null;
};

function resolve(dir: string, target: string): string {
  const parts = `${dir}/${target}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

async function relsOf(zip: JSZip, file: string): Promise<Record<string, string>> {
  const dir = file.slice(0, file.lastIndexOf('/'));
  const name = file.slice(file.lastIndexOf('/') + 1);
  const doc = await xml(zip, `${dir}/_rels/${name}.rels`);
  const out: Record<string, string> = {};
  for (const r of doc ? [...doc.getElementsByTagNameNS('*', 'Relationship')] : []) {
    out[r.getAttribute('Id')!] = r.getAttribute('TargetMode') === 'External' ? '' : resolve(dir, r.getAttribute('Target')!);
  }
  return out;
}

/** A colour from <a:solidFill> or similar, as CSS, honouring theme colours. */
function colour(el: Element | null, theme: Record<string, string>): string | null {
  if (!el) return null;
  const srgb = kid(el, 'srgbClr');
  const scheme = kid(el, 'schemeClr');
  const sys = kid(el, 'sysClr');
  let hex: string | null = null;
  let mod: Element | null = null;
  if (srgb) [hex, mod] = [srgb.getAttribute('val'), srgb];
  else if (scheme) {
    const key = ({ tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' } as Record<string, string>)[scheme.getAttribute('val')!] ?? scheme.getAttribute('val')!;
    [hex, mod] = [theme[key] ?? null, scheme];
  } else if (sys) [hex, mod] = [sys.getAttribute('lastClr'), sys];
  if (!hex) return null;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16));
  // lumMod / lumOff: the "lighter 40%" style variants Office uses
  const lumMod = num(kid(mod, 'lumMod'), 'val', 100000) / 100000;
  const lumOff = num(kid(mod, 'lumOff'), 'val', 0) / 100000;
  if (lumMod !== 1 || lumOff) [r, g, b] = [r, g, b].map((v) => Math.round(Math.min(255, v * lumMod + 255 * lumOff)));
  const alpha = num(kid(mod, 'alpha'), 'val', 100000) / 100000;
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha.toFixed(2)})` : `rgb(${r},${g},${b})`;
}

function readTheme(doc: Document | null): Record<string, string> {
  const out: Record<string, string> = { dk1: '000000', lt1: 'FFFFFF', dk2: '1F2937', lt2: 'E5E7EB' };
  const scheme = find(doc?.documentElement, 'clrScheme');
  for (const c of scheme ? [...scheme.children] : []) {
    const v = kid(c, 'srgbClr')?.getAttribute('val') ?? kid(c, 'sysClr')?.getAttribute('lastClr');
    if (v) out[c.localName] = v;
  }
  return out;
}

function xfrmBox(x: Element | null): Box | null {
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return { x: num(off, 'x'), y: num(off, 'y'), w: num(ext, 'cx'), h: num(ext, 'cy') };
}

/** A placeholder's position, from the layout or master when the slide doesn't say. */
function inheritedBox(ph: Element | null, ctx: Context): Box | null {
  if (!ph) return null;
  const type = ph.getAttribute('type') ?? 'body';
  const idx = ph.getAttribute('idx');
  for (const doc of [ctx.layout, ctx.master]) {
    if (!doc) continue;
    for (const sp of [...doc.getElementsByTagNameNS('*', 'sp')]) {
      const other = find(kid(sp, 'nvSpPr'), 'ph');
      if (!other) continue;
      const sameIdx = idx != null && other.getAttribute('idx') === idx;
      const sameType = (other.getAttribute('type') ?? 'body') === type;
      if (sameIdx || (sameType && doc === ctx.master) || (sameType && idx == null)) {
        const box = xfrmBox(find(kid(sp, 'spPr'), 'xfrm'));
        if (box) return box;
      }
    }
  }
  return null;
}

/** Default text size for a placeholder kind, in points. */
const defaultSize = (type: string | null) => (type === 'title' || type === 'ctrTitle' ? 40 : type === 'subTitle' ? 24 : type === 'body' || type === 'obj' ? 22 : 18);

function textHtml(body: Element | null, phType: string | null, ctx: Context): string {
  if (!body) return '';
  const anchor = kid(body, 'bodyPr')?.getAttribute('anchor');
  const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : (phType === 'title' || phType === 'ctrTitle') ? 'center' : 'flex-start';
  const bulleted = phType === 'body' || phType === 'obj';
  const paragraphs = kids(body, 'p').map((p) => {
    const pPr = kid(p, 'pPr');
    const algn = pPr?.getAttribute('algn');
    const level = num(pPr, 'lvl', 0);
    // title slides centre their title and subtitle unless told otherwise
    const centredKind = phType === 'ctrTitle' || phType === 'subTitle';
    const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : algn === 'l' ? 'left' : centredKind ? 'center' : 'left';
    const noBullet = !!kid(pPr, 'buNone');
    const char = kid(pPr, 'buChar')?.getAttribute('char');
    const html = [...p.children].map((r) => {
      if (r.localName === 'br') return '<br>';
      if (r.localName !== 'r' && r.localName !== 'fld') return '';
      const rPr = kid(r, 'rPr');
      const size = num(rPr, 'sz', defaultSize(phType) * 100) / 100;
      const css = [`font-size:${size}pt`];
      if (rPr?.getAttribute('b') === '1') css.push('font-weight:700');
      if (rPr?.getAttribute('i') === '1') css.push('font-style:italic');
      if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') css.push('text-decoration:underline');
      const c = colour(kid(rPr, 'solidFill'), ctx.theme);
      if (c) css.push(`color:${c}`);
      return `<span style="${css.join(';')}">${escapeHtml(kid(r, 't')?.textContent ?? '')}</span>`;
    }).join('');
    const showBullet = (bulleted || char) && !noBullet && html.trim();
    const bullet = showBullet ? `<span class="bu">${escapeHtml(char ?? '•')}</span>` : '';
    const empty = !html.trim();
    return `<p style="text-align:${align};margin-left:${level * 24}pt">${bullet}${empty ? '&nbsp;' : html}</p>`;
  }).join('');
  return `<div class="tx" style="justify-content:${justify}">${paragraphs}</div>`;
}

async function pictureUrl(embed: string | null, ctx: Context): Promise<string | null> {
  const target = embed ? ctx.rels[embed] : '';
  if (!target) return null;
  const ext = target.split('.').pop()!.toLowerCase();
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' } as Record<string, string>)[ext];
  if (!mime) return null; // EMF/WMF and friends can't be shown in a browser
  const b64 = await ctx.zip.file(target)?.async('base64');
  return b64 ? `data:${mime};base64,${b64}` : null;
}

type Map2 = (b: Box) => Box;

async function shapes(tree: Element, ctx: Context, map: Map2): Promise<string> {
  const out: string[] = [];
  for (const el of [...tree.children]) {
    if (el.localName === 'grpSp') {
      const g = find(kid(el, 'grpSpPr'), 'xfrm');
      const box = xfrmBox(g);
      const chOff = kid(g, 'chOff'), chExt = kid(g, 'chExt');
      if (box && chOff && chExt) {
        const sx = box.w / (num(chExt, 'cx') || box.w || 1), sy = box.h / (num(chExt, 'cy') || box.h || 1);
        const inner: Map2 = (b) => map({ x: box.x + (b.x - num(chOff, 'x')) * sx, y: box.y + (b.y - num(chOff, 'y')) * sy, w: b.w * sx, h: b.h * sy });
        out.push(await shapes(el, ctx, inner));
      } else {
        out.push(await shapes(el, ctx, map));
      }
      continue;
    }
    if (el.localName === 'sp' || el.localName === 'cxnSp') {
      const spPr = kid(el, 'spPr');
      const ph = find(kid(el, 'nvSpPr'), 'ph');
      const raw = xfrmBox(kid(spPr, 'xfrm')) ?? inheritedBox(ph, ctx);
      if (!raw) continue;
      const b = map(raw);
      const css = [`left:${pt(b.x)}`, `top:${pt(b.y)}`, `width:${pt(b.w)}`, `height:${pt(b.h)}`];
      const rot = num(kid(spPr, 'xfrm'), 'rot', 0) / 60000;
      if (rot) css.push(`transform:rotate(${rot}deg)`);
      const fill = colour(kid(spPr, 'solidFill'), ctx.theme);
      if (fill) css.push(`background:${fill}`);
      const ln = kid(spPr, 'ln');
      const lineColour = colour(kid(ln, 'solidFill'), ctx.theme);
      if (lineColour && !kid(ln, 'noFill')) css.push(`border:${Math.max(0.75, num(ln, 'w', 12700) / EMU_PER_PT)}pt solid ${lineColour}`);
      const geom = kid(spPr, 'prstGeom')?.getAttribute('prst');
      if (geom === 'ellipse') css.push('border-radius:50%');
      else if (geom === 'roundRect') css.push('border-radius:8pt');
      out.push(`<div class="sp" style="${css.join(';')}">${textHtml(kid(el, 'txBody'), ph ? ph.getAttribute('type') ?? 'body' : null, ctx)}</div>`);
      continue;
    }
    if (el.localName === 'pic') {
      const raw = xfrmBox(find(kid(el, 'spPr'), 'xfrm'));
      const url = await pictureUrl(find(kid(el, 'blipFill'), 'blip')?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? null, ctx);
      if (!raw || !url) continue;
      const b = map(raw);
      out.push(`<img class="sp" src="${url}" style="left:${pt(b.x)};top:${pt(b.y)};width:${pt(b.w)};height:${pt(b.h)}">`);
      continue;
    }
    if (el.localName === 'graphicFrame') {
      const raw = xfrmBox(kid(el, 'xfrm'));
      const tbl = find(el, 'tbl');
      if (!raw || !tbl) continue;
      const b = map(raw);
      const rows = kids(tbl, 'tr').map((tr) => `<tr>${kids(tr, 'tc').map((tc) => `<td>${textHtml(kid(tc, 'txBody'), null, ctx)}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="sp" style="left:${pt(b.x)};top:${pt(b.y)};width:${pt(b.w)}">${rows}</table>`);
    }
  }
  return out.join('\n');
}

async function background(docs: (Document | null)[], ctx: Context): Promise<string> {
  for (const doc of docs) {
    const bgPr = find(find(doc?.documentElement, 'bg'), 'bgPr');
    if (!bgPr) continue;
    const solid = colour(kid(bgPr, 'solidFill'), ctx.theme);
    if (solid) return `background:${solid}`;
    const blip = find(kid(bgPr, 'blipFill'), 'blip');
    if (blip) {
      const url = await pictureUrl(blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'), ctx);
      if (url) return `background:url("${url}") center / cover`;
    }
  }
  return 'background:#fff';
}

/** The deck as one HTML page, one slide per printed page, and the slide size in inches. */
export async function pptxToHtml(data: Uint8Array): Promise<{ html: string; width: number; height: number; slides: number }> {
  const zip = await JSZip.loadAsync(data);
  const pres = await xml(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error(t('This doesn’t look like a PowerPoint file.'));
  const size = find(pres.documentElement, 'sldSz');
  const cx = num(size, 'cx', 12192000), cy = num(size, 'cy', 6858000);
  const presRels = await relsOf(zip, 'ppt/presentation.xml');
  const ids = [...pres.getElementsByTagNameNS('*', 'sldId')].map((s) => s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')!);
  const theme = readTheme(await xml(zip, Object.values(presRels).find((t) => /theme\/theme\d+\.xml$/.test(t)) ?? 'ppt/theme/theme1.xml'));

  const slides: string[] = [];
  for (const id of ids) {
    const file = presRels[id];
    const slide = file ? await xml(zip, file) : null;
    if (!slide) continue;
    const rels = await relsOf(zip, file);
    const layoutFile = Object.values(rels).find((t) => /slideLayouts\//.test(t));
    const layout = layoutFile ? await xml(zip, layoutFile) : null;
    const masterFile = layoutFile ? Object.values(await relsOf(zip, layoutFile)).find((t) => /slideMasters\//.test(t)) : undefined;
    const master = masterFile ? await xml(zip, masterFile) : null;
    const ctx: Context = { zip, theme, dir: file.slice(0, file.lastIndexOf('/')), rels, layout, master };
    const tree = find(slide.documentElement, 'spTree');
    const bg = await background([slide, layout, master], ctx);
    slides.push(`<section class="slide" style="${bg}">${tree ? await shapes(tree, ctx, (b) => b) : ''}</section>`);
  }
  if (!slides.length) throw new Error(t('This presentation has no slides.'));

  const w = cx / EMU_PER_PT, h = cy / EMU_PER_PT;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${w}pt ${h}pt; margin: 0; }
html, body { margin: 0; padding: 0; }
* { font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0; }
body { font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #${theme.dk1}; -webkit-print-color-adjust: exact; }
.slide { position: relative; width: ${w}pt; height: ${h}pt; overflow: hidden; break-after: page; }
.slide:last-child { break-after: auto; }
.sp { position: absolute; box-sizing: border-box; }
.tx { display: flex; flex-direction: column; height: 100%; padding: 3.6pt 7.2pt; box-sizing: border-box; overflow: hidden; }
.tx p { margin: 0 0 4pt; line-height: 1.15; }
.bu { display: inline-block; width: 1.1em; }
table.sp { border-collapse: collapse; }
table.sp td { border: 0.75pt solid #9ca3af; vertical-align: top; padding: 0; }
table.sp .tx { height: auto; }
img.sp { object-fit: fill; }
</style></head><body>${slides.join('\n')}</body></html>`;
  return { html, width: w / 72, height: h / 72, slides: slides.length };
}
