// SPDX-License-Identifier: GPL-3.0-or-later
import type { FieldKind, FontFamily, TextAlign } from './types';

// The "current pen" for each kind of tool. Changing a colour while something
// is selected restyles that thing *and* becomes the default for the next one.

export interface ToolStyles {
  pen: { color: string; width: number; opacity: number };
  highlight: { color: string };
  shape: { color: string; width: number; fill: string | null };
  line: { color: string; width: number };
  text: {
    font: FontFamily;
    family?: string;
    size: number;
    color: string;
    bold: boolean;
    italic: boolean;
    underline?: boolean;
    background?: string | null;
    align?: TextAlign;
    opacity?: number;
  };
  whiteout: { color: string };
  redact: { color: string };
  note: { color: string };
  stamp: { label: string; color: string; date: boolean };
  field: { kind: FieldKind };
}

export const DEFAULT_STYLES: ToolStyles = {
  pen: { color: '#1d3f91', width: 2, opacity: 1 },
  highlight: { color: '#ffe169' },
  shape: { color: '#d1345b', width: 2, fill: null },
  line: { color: '#d1345b', width: 2 },
  text: { font: 'sans', size: 14, color: '#1a1a1a', bold: false, italic: false, underline: false, background: null, align: 'left', opacity: 1 },
  whiteout: { color: '#ffffff' },
  redact: { color: '#000000' },
  note: { color: '#ffd166' },
  stamp: { label: 'APPROVED', color: '#1f8a5b', date: true },
  field: { kind: 'text' },
};

export const NOTE_COLORS = ['#ffd166', '#9be38a', '#8fd3ff', '#ffadc8', '#c9b6ff'];
export const STAMP_COLORS = ['#1f8a5b', '#1d3f91', '#c4314b', '#b9620f', '#555555'];
export const STAMPS = ['APPROVED', 'PAID', 'RECEIVED', 'REVIEWED', 'REJECTED', 'CONFIDENTIAL', 'DRAFT', 'VOID'];

export const INK_COLORS = ['#1a1a1a', '#1d3f91', '#2b7bd6', '#1f8a5b', '#d1345b', '#e8590c', '#7c3aed', '#ffffff'];
export const HIGHLIGHT_COLORS = ['#ffe169', '#b8f28b', '#9fe3ff', '#ffb3d1', '#ffc37a'];

const KEY = 'inkleaf.styles.v1';

export function loadStyles(): ToolStyles {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const merged = structuredClone(DEFAULT_STYLES) as unknown as Record<string, Record<string, unknown>>;
    for (const group of Object.keys(merged)) Object.assign(merged[group], saved[group] ?? {});
    return merged as unknown as ToolStyles;
  } catch {
    return structuredClone(DEFAULT_STYLES);
  }
}

export function saveStyles(styles: ToolStyles) {
  try {
    localStorage.setItem(KEY, JSON.stringify(styles));
  } catch {
    // storage can be unavailable; defaults are fine then
  }
}
