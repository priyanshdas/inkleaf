// SPDX-License-Identifier: GPL-3.0-or-later
// Everything a document edit can contain. All coordinates are in PDF user
// space for the page they sit on: points, origin bottom-left, y going up,
// measured against the page *before* any rotation is applied. That way an
// annotation stays glued to the content when someone rotates the page.

export type FontFamily = 'sans' | 'serif' | 'mono';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
}

export interface InkAnnot extends Base {
  type: 'ink';
  points: [number, number][];
  color: string;
  width: number;
  opacity: number;
}

export interface LineAnnot extends Base {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export interface ShapeAnnot extends Base, Box {
  type: 'rect' | 'ellipse';
  color: string;
  width: number;
  fill: string | null;
}

export interface HighlightAnnot extends Base, Box {
  type: 'highlight';
  color: string;
}

/** Paints over whatever is underneath. Doesn't remove anything from the file. */
export interface WhiteoutAnnot extends Base, Box {
  type: 'whiteout';
  color: string;
}

/** A filled box that also strips the text underneath out of the PDF on save. */
export interface RedactAnnot extends Base, Box {
  type: 'redact';
  color: string;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  text: string;
  size: number;
  /** Standard PDF font, and the fallback when a custom font can't be used. */
  font: FontFamily;
  /** A document or installed font (see custom-fonts.ts), if one is chosen. */
  family?: string;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  color: string;
  /** Fill behind the text, or none. */
  background?: string | null;
  align?: TextAlign;
  /** 0–1; 1 when missing. */
  opacity?: number;
}

/**
 * Free text. (x, y) is the top-left corner of the text as you read it, and
 * `angle` is how far the text is turned counter-clockwise in user space,
 * normally the page's rotation at the time it was placed so it reads upright.
 */
export interface TextAnnot extends Base, TextStyle {
  type: 'text';
  x: number;
  y: number;
  angle: number;
}

/**
 * An edit to text that was already in the PDF: the original words are removed
 * from the file on save (`cover` marks where), and new text goes in their place.
 */
export interface ReplaceAnnot extends Base, TextStyle {
  type: 'replace';
  x: number;
  y: number;
  angle: number;
  cover: Box & { color: string };
  original: string;
}

export interface ImageAnnot extends Base, Box {
  type: 'image';
  /** Rotation of the picture itself; the box is always axis-aligned. */
  angle: number;
  asset: string;
}

/** A sticky note: an icon on the page with a comment behind it. */
export interface NoteAnnot extends Base, Box {
  type: 'note';
  text: string;
  color: string;
  author: string;
  /** Milliseconds since 1970. */
  created: number;
}

/** A rubber stamp such as APPROVED or PAID, optionally with a date. */
export interface StampAnnot extends Base, Box {
  type: 'stamp';
  label: string;
  color: string;
  /** Already formatted, or null for no date line. */
  date: string | null;
  /** Turned to read upright on rotated pages, like images. */
  angle: number;
}

export type FieldKind = 'text' | 'multiline' | 'checkbox' | 'dropdown';

/** A fillable form field being added to the PDF. */
export interface FieldAnnot extends Base, Box {
  type: 'field';
  kind: FieldKind;
  name: string;
  /** Choices, for dropdowns. */
  options: string[];
  required: boolean;
  angle: number;
}

export type Annot =
  | InkAnnot
  | NoteAnnot
  | StampAnnot
  | FieldAnnot
  | LineAnnot
  | ShapeAnnot
  | HighlightAnnot
  | WhiteoutAnnot
  | RedactAnnot
  | TextAnnot
  | ReplaceAnnot
  | ImageAnnot;

export type AnnotType = Annot['type'];

export interface PageRef {
  /** Stable id for this page in this editing session. */
  id: string;
  /** Which loaded PDF it comes from. */
  src: string;
  /** Zero-based page index inside that PDF. */
  index: number;
  /** Extra clockwise rotation added in Inkleaf, on top of the page's own. */
  rotation: number;
  /** Visible area, in the page's user space, when cropped in Inkleaf. */
  crop?: Box;
}

export type FormValue = string | boolean;

// --- things drawn on every page --------------------------------------------------

export interface Watermark {
  text: string;
  size: number;
  color: string;
  /** 0–1 */
  opacity: number;
  diagonal: boolean;
}

export type NumberStyle = 'n' | 'n-of-total' | 'page-n' | 'page-n-of-total';

export interface PageNumbers {
  style: NumberStyle;
  vertical: 'top' | 'bottom';
  align: TextAlign;
  size: number;
  /** Number shown on the first numbered page. */
  start: number;
  /** Leave the first page (a cover) unnumbered. */
  skipFirst: boolean;
}

/** Text across the top or bottom margin. {page}, {total}, {date}, {file} are filled in. */
export interface Band {
  left: string;
  center: string;
  right: string;
  size: number;
}

export interface Decor {
  watermark: Watermark | null;
  numbers: PageNumbers | null;
  header: Band | null;
  footer: Band | null;
}

export interface OutlineItem {
  id: string;
  title: string;
  /** Page it opens, or null if that page is gone. */
  pageId: string | null;
  children: OutlineItem[];
}

/** The undoable part of a document. */
export interface Snapshot {
  pages: PageRef[];
  annots: Record<string, Annot[]>;
  forms: Record<string, FormValue>;
  decor: Decor;
  /** Bookmarks, once edited in Inkleaf; null keeps the file's own. */
  outline: OutlineItem[] | null;
}

export type Tool =
  | 'select' | 'hand' | 'text' | 'edit-text' | 'pen' | 'highlight'
  | 'rect' | 'ellipse' | 'line' | 'arrow' | 'whiteout' | 'redact'
  | 'image' | 'sign' | 'eraser' | 'note' | 'stamp' | 'field' | 'crop';
