// SPDX-License-Identifier: GPL-3.0-or-later
// Font subsetting with HarfBuzz (compiled to WebAssembly).
//
// A saved PDF only needs the glyphs its text uses, which matters most for
// Chinese, Japanese and Korean fonts (10 MB each). pdf-lib's own subsetter
// loses composite glyphs (accented, Cyrillic and many CJK characters are
// built from parts), so HarfBuzz's subsetter, the one browsers and Google
// Fonts use, does it instead. Glyph IDs are kept as they were, so text
// shaped against the full font lines up with the subset exactly.

interface Hb {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lengthPtr: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_glyph_set(input: number): number;
  hb_subset_input_set(input: number, which: number): number;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

let hb: Promise<Hb> | null = null;
const harfbuzz = () => (hb ??= fetch('./vendor/harfbuzz/harfbuzz-subset.wasm')
  .then((r) => r.arrayBuffer())
  .then((bytes) => WebAssembly.instantiate(bytes, {}))
  .then(({ instance }) => instance.exports as unknown as Hb));

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 3;
const HB_SUBSET_FLAGS_NO_HINTING = 0x1;
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x2;
const tag = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

/**
 * A copy of the font holding only these glyphs (plus the empty glyph 0), at
 * their original IDs. Shaping tables are left out: the text is already
 * shaped. Falls back to the whole font if HarfBuzz can't subset it.
 */
export async function subsetFont(font: Uint8Array, glyphIds: Iterable<number>): Promise<Uint8Array> {
  const h = await harfbuzz();
  const ptr = h.malloc(font.length);
  new Uint8Array(h.memory.buffer, ptr, font.length).set(font);
  const blob = h.hb_blob_create(ptr, font.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = h.hb_face_create(blob, 0);
  h.hb_blob_destroy(blob);
  const input = h.hb_subset_input_create_or_fail();
  try {
    if (!input) return font;
    const glyphs = h.hb_subset_input_glyph_set(input);
    h.hb_set_add(glyphs, 0);
    for (const id of glyphIds) h.hb_set_add(glyphs, id);
    const drop = h.hb_subset_input_set(input, HB_SUBSET_SETS_DROP_TABLE_TAG);
    for (const t of ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'MATH', 'morx', 'kerx', 'kern', 'DSIG']) h.hb_set_add(drop, tag(t));
    h.hb_subset_input_set_flags(input, h.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_RETAIN_GIDS | HB_SUBSET_FLAGS_NO_HINTING);
    const result = h.hb_subset_or_fail(face, input);
    if (!result) return font;
    const out = h.hb_face_reference_blob(result);
    const length = h.hb_blob_get_length(out);
    const data = h.hb_blob_get_data(out, 0);
    const bytes = new Uint8Array(h.memory.buffer, data, length).slice();
    h.hb_blob_destroy(out);
    h.hb_face_destroy(result);
    return bytes.length ? bytes : font;
  } finally {
    if (input) h.hb_subset_input_destroy(input);
    h.hb_face_destroy(face);
    h.free(ptr);
  }
}
