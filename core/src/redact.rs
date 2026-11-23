// SPDX-License-Identifier: GPL-3.0-or-later
//! Removes glyphs that fall inside given rectangles from a page's content
//! stream, without disturbing anything else on the page.
//!
//! The idea is the same one Acrobat's redaction uses: replay the content
//! stream with a minimal graphics/text state machine, work out where each
//! glyph lands in user space, and when a glyph's centre lies inside a
//! redaction box, drop it from the string and put a positioning adjustment in
//! its place so the glyphs after it don't shift.

use crate::fonts::FontMetrics;
use crate::lexer::{parse_ops, Op, Operand};
use std::collections::{HashMap, HashSet};

/// A box in PDF user space (y up). Corners can come in any order.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        let (lx, hx) = if self.x0 < self.x1 { (self.x0, self.x1) } else { (self.x1, self.x0) };
        let (ly, hy) = if self.y0 < self.y1 { (self.y0, self.y1) } else { (self.y1, self.y0) };
        x >= lx && x <= hx && y >= ly && y <= hy
    }

    /// True when the box touches the given area (edges included).
    pub fn overlaps(&self, area: [f64; 4]) -> bool {
        let (lx, hx) = (self.x0.min(self.x1), self.x0.max(self.x1));
        let (ly, hy) = (self.y0.min(self.y1), self.y0.max(self.y1));
        area[0] <= hx && area[2] >= lx && area[1] <= hy && area[3] >= ly
    }

    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        self.contains(x, y)
    }
}

pub type Matrix = [f64; 6];
pub const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` then `b`, using PDF's row-vector convention.
pub fn mul(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

pub fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}

#[derive(Clone)]
struct GraphicsState {
    ctm: Matrix,
    char_spacing: f64,
    word_spacing: f64,
    h_scale: f64,
    leading: f64,
    font: Option<Vec<u8>>,
    font_size: f64,
    rise: f64,
}

impl Default for GraphicsState {
    fn default() -> Self {
        GraphicsState {
            ctm: IDENTITY,
            char_spacing: 0.0,
            word_spacing: 0.0,
            h_scale: 1.0,
            leading: 0.0,
            font: None,
            font_size: 0.0,
            rise: 0.0,
        }
    }
}

/// The area a matrix maps the given box onto, as [left, bottom, right, top].
pub fn bounds(m: &Matrix, x0: f64, y0: f64, x1: f64, y1: f64) -> [f64; 4] {
    let corners = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (x, y) in corners {
        b[0] = b[0].min(x);
        b[1] = b[1].min(y);
        b[2] = b[2].max(x);
        b[3] = b[3].max(y);
    }
    b
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct StreamReport {
    pub removed_glyphs: usize,
    pub skipped_fonts: Vec<String>,
    /// Inline pictures (BI ... EI) that sat under a box and were taken out.
    pub removed_inline_images: usize,
    /// Fonts we can't measure that have text which may sit under a box.
    /// That text can't be removed safely, so the caller has to stop.
    pub unsure_fonts: Vec<String>,
    /// Every `Do` in the stream: the resource name and the matrix it was drawn with.
    #[serde(skip)]
    pub drawn: Vec<(Vec<u8>, Matrix)>,
    /// Marked-content ids whose text lost glyphs, so their tags' alt text can go too.
    #[serde(skip)]
    pub touched_mcids: Vec<i64>,
}

/// One open marked-content section (BMC/BDC ... EMC).
struct Marked {
    op: usize,
    tag: Vec<u8>,
    mcid: Option<i64>,
    /// It carries a spoken or copied version of its text (ActualText, Alt, E).
    has_text_copy: bool,
    touched: bool,
}

enum Piece {
    Glyphs(Vec<u8>),
    Shift(f64),
}

struct Redactor<'a> {
    fonts: &'a HashMap<Vec<u8>, FontMetrics>,
    rects: &'a [Rect],
    gs: GraphicsState,
    stack: Vec<GraphicsState>,
    tm: Matrix,
    tlm: Matrix,
    report: StreamReport,
    warned: HashSet<Vec<u8>>,
    marked: Vec<Marked>,
    /// `Do` calls (by their order in the stream) that should draw something else.
    renames: &'a HashMap<usize, Vec<u8>>,
    /// BDC ops whose copy of the text has to be dropped, with what to write instead.
    rewrite_marks: Vec<(usize, Vec<u8>)>,
}

impl<'a> Redactor<'a> {
    fn new(fonts: &'a HashMap<Vec<u8>, FontMetrics>, rects: &'a [Rect], ctm: Matrix, renames: &'a HashMap<usize, Vec<u8>>) -> Self {
        let gs = GraphicsState { ctm, ..Default::default() };
        Redactor {
            fonts,
            rects,
            gs,
            stack: Vec::new(),
            tm: IDENTITY,
            tlm: IDENTITY,
            report: StreamReport::default(),
            warned: HashSet::new(),
            marked: Vec::new(),
            renames,
            rewrite_marks: Vec::new(),
        }
    }

    fn move_line(&mut self, tx: f64, ty: f64) {
        self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, tx, ty], &self.tlm);
        self.tm = self.tlm;
    }

    fn advance(&mut self, tx: f64) {
        self.tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], &self.tm);
    }

    fn current_font(&mut self) -> Option<&'a FontMetrics> {
        let name = self.gs.font.clone()?;
        let Some(metrics) = self.fonts.get(&name) else {
            if self.warned.insert(name.clone()) {
                self.report.skipped_fonts.push(format!("{} (not found)", String::from_utf8_lossy(&name)));
            }
            return None;
        };
        if let Some(reason) = &metrics.unsupported {
            if self.warned.insert(name.clone()) {
                self.report
                    .skipped_fonts
                    .push(format!("{} ({})", String::from_utf8_lossy(&name), reason));
            }
            return None;
        }
        Some(metrics)
    }

    /// Walks one string or TJ array, advancing the text matrix as a viewer
    /// would. Returns the rewritten pieces, or None when nothing was removed
    /// (so the caller can leave the original bytes alone).
    fn show(&mut self, items: &[Operand]) -> Option<Vec<Piece>> {
        let fs = self.gs.font_size;
        let th = self.gs.h_scale;
        let font = self.current_font();

        // Without a usable font we can't place glyphs, so the text has to stay.
        // That's only all right when it's clearly nowhere near a box.
        let Some(font) = font.filter(|_| fs != 0.0 && th != 0.0) else {
            self.check_unplaceable(items);
            return None;
        };

        let mut pieces: Vec<Piece> = Vec::new();
        let mut removed_any = false;

        for item in items {
            match item {
                Operand::Number(n) => {
                    self.advance(-n / 1000.0 * fs * th);
                    push_shift(&mut pieces, *n);
                }
                Operand::Str(bytes) => {
                    for (code, raw) in font.codes(bytes) {
                        let w0 = font.width_of(code) * font.scale;
                        let word = if font.code_bytes == 1 && code == 32 { self.gs.word_spacing } else { 0.0 };
                        let tx = (w0 * fs + self.gs.char_spacing + word) * th;

                        let trm = mul(
                            &[fs * th, 0.0, 0.0, fs, 0.0, self.gs.rise],
                            &mul(&self.tm, &self.gs.ctm),
                        );
                        // a third of the way up the em box is a fair "centre" for
                        // Latin text, sitting above the baseline but below caps
                        let (cx, cy) = apply(&trm, w0 * 0.5, 0.33);
                        let hit = self.rects.iter().any(|r| r.contains(cx, cy));

                        if hit {
                            removed_any = true;
                            for m in &mut self.marked {
                                m.touched = true;
                            }
                            self.report.removed_glyphs += 1;
                            push_shift(&mut pieces, -tx * 1000.0 / (fs * th));
                        } else {
                            match pieces.last_mut() {
                                Some(Piece::Glyphs(g)) => g.extend_from_slice(&raw),
                                _ => pieces.push(Piece::Glyphs(raw)),
                            }
                        }
                        self.advance(tx);
                    }
                }
                _ => {}
            }
        }

        removed_any.then_some(pieces)
    }

    /// Text we can't place glyph by glyph. Each code takes at most about an
    /// em in any direction (vertical writing goes down, not across), so the
    /// area around the start point, one em per byte each way, is sure to hold
    /// it. If that area touches a box, the text might be under it.
    fn check_unplaceable(&mut self, items: &[Operand]) {
        let bytes: usize = items.iter().map(|i| if let Operand::Str(s) = i { s.len() } else { 0 }).sum();
        if bytes == 0 {
            return;
        }
        let reach = bytes as f64 + 1.0;
        let trm = mul(
            &[self.gs.font_size * self.gs.h_scale, 0.0, 0.0, self.gs.font_size, 0.0, self.gs.rise],
            &mul(&self.tm, &self.gs.ctm),
        );
        let area = bounds(&trm, -reach, -reach, reach, reach);
        if self.rects.iter().any(|r| r.overlaps(area)) {
            let name = self.gs.font.clone().unwrap_or_default();
            let label = String::from_utf8_lossy(&name).into_owned();
            let reason = self.fonts.get(&name).and_then(|f| f.unsupported.clone()).unwrap_or_else(|| "not found".into());
            let entry = format!("{label} ({reason})");
            if !self.report.unsure_fonts.contains(&entry) {
                self.report.unsure_fonts.push(entry);
            }
        }
    }

    /// Returns replacement bytes for `op`, or None to keep it as-is.
    fn process(&mut self, index: usize, op: &Op, data: &[u8]) -> Option<Vec<u8>> {
        let nums: Vec<f64> = op.operands.iter().filter_map(Operand::num).collect();
        let n = |i: usize| nums.get(i).copied().unwrap_or(0.0);

        match op.operator.as_str() {
            "q" => self.stack.push(self.gs.clone()),
            "Q" => {
                if let Some(gs) = self.stack.pop() {
                    self.gs = gs;
                }
            }
            "cm" if nums.len() == 6 => {
                let m = [n(0), n(1), n(2), n(3), n(4), n(5)];
                self.gs.ctm = mul(&m, &self.gs.ctm);
            }
            "BT" => {
                self.tm = IDENTITY;
                self.tlm = IDENTITY;
            }
            "Tc" => self.gs.char_spacing = n(0),
            "Tw" => self.gs.word_spacing = n(0),
            "Tz" => self.gs.h_scale = n(0) / 100.0,
            "TL" => self.gs.leading = n(0),
            "Ts" => self.gs.rise = n(0),
            "Tf" => {
                if let Some(Operand::Name(name)) = op.operands.first() {
                    self.gs.font = Some(name.clone());
                }
                self.gs.font_size = nums.last().copied().unwrap_or(0.0);
            }
            "Td" => self.move_line(n(0), n(1)),
            "TD" => {
                self.gs.leading = -n(1);
                self.move_line(n(0), n(1));
            }
            "Tm" if nums.len() == 6 => {
                self.tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
                self.tm = self.tlm;
            }
            "T*" => self.move_line(0.0, -self.gs.leading),
            "Do" => {
                if let Some(Operand::Name(name)) = op.operands.first() {
                    let nth = self.report.drawn.len();
                    self.report.drawn.push((name.clone(), self.gs.ctm));
                    if let Some(other) = self.renames.get(&nth) {
                        let mut out = vec![b'/'];
                        out.extend(other.iter().flat_map(|&c| name_byte(c)));
                        out.extend_from_slice(b" Do");
                        return Some(out);
                    }
                }
            }
            "BI" => {
                // an inline picture fills the unit square of the current matrix
                let area = bounds(&self.gs.ctm, 0.0, 0.0, 1.0, 1.0);
                if self.rects.iter().any(|r| r.overlaps(area)) {
                    self.report.removed_inline_images += 1;
                    return Some(Vec::new());
                }
            }
            "BMC" | "BDC" => {
                let tag = match op.operands.first() {
                    Some(Operand::Name(n)) => n.clone(),
                    _ => b"Span".to_vec(),
                };
                let raw = &data[op.start..op.end];
                self.marked.push(Marked {
                    op: index,
                    tag,
                    mcid: find_mcid(raw),
                    has_text_copy: op.operator == "BDC" && has_text_copy(raw),
                    touched: false,
                });
            }
            "EMC" => {
                if let Some(m) = self.marked.pop() {
                    if m.touched {
                        if let Some(id) = m.mcid {
                            self.report.touched_mcids.push(id);
                        }
                        if m.has_text_copy {
                            // keep the tag and its id, lose the words
                            let mut out = Vec::new();
                            out.push(b'/');
                            out.extend(m.tag.iter().flat_map(|&c| name_byte(c)));
                            match m.mcid {
                                Some(id) => out.extend_from_slice(format!(" <</MCID {id}>> BDC").as_bytes()),
                                None => out.extend_from_slice(b" BMC"),
                            }
                            self.rewrite_marks.push((m.op, out));
                        }
                    }
                }
            }
            "Tj" => {
                let s = op.operands.first()?.clone();
                let pieces = self.show(&[s])?;
                return Some(encode_tj(&pieces, ""));
            }
            "TJ" => {
                let Some(Operand::Array(items)) = op.operands.first() else { return None };
                let items = items.clone();
                let pieces = self.show(&items)?;
                return Some(encode_tj(&pieces, ""));
            }
            "'" => {
                self.move_line(0.0, -self.gs.leading);
                let s = op.operands.first()?.clone();
                let pieces = self.show(&[s])?;
                return Some(encode_tj(&pieces, "T* "));
            }
            "\"" => {
                // aw ac string "
                self.gs.word_spacing = n(0);
                self.gs.char_spacing = n(1);
                self.move_line(0.0, -self.gs.leading);
                let s = op.operands.last()?.clone();
                let pieces = self.show(&[s])?;
                let prefix = format!("{} Tw {} Tc T* ", fmt_num(n(0)), fmt_num(n(1)));
                return Some(encode_tj(&pieces, &prefix));
            }
            _ => {}
        }
        None
    }
}

/// The MCID in a BDC's property list, if it has one written inline.
fn find_mcid(raw: &[u8]) -> Option<i64> {
    let at = raw.windows(5).position(|w| w == b"/MCID")? + 5;
    let digits: String = raw[at..]
        .iter()
        .skip_while(|c| c.is_ascii_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .map(|&c| c as char)
        .collect();
    digits.parse().ok()
}

/// Whether a BDC's property list holds a copy of its text.
fn has_text_copy(raw: &[u8]) -> bool {
    [&b"/ActualText"[..], b"/Alt", b"/E"].iter().any(|key| {
        raw.windows(key.len()).enumerate().any(|(i, w)| {
            w == *key && raw.get(i + key.len()).is_some_and(|c| c.is_ascii_whitespace() || *c == b'(' || *c == b'<')
        })
    })
}

/// One byte of a name, escaped if it needs to be.
fn name_byte(c: u8) -> Vec<u8> {
    if c.is_ascii_alphanumeric() || b"-_.".contains(&c) {
        vec![c]
    } else {
        format!("#{c:02X}").into_bytes()
    }
}

fn push_shift(pieces: &mut Vec<Piece>, amount: f64) {
    if let Some(Piece::Shift(prev)) = pieces.last_mut() {
        *prev += amount;
    } else {
        pieces.push(Piece::Shift(amount));
    }
}

fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e9 {
        format!("{}", n as i64)
    } else {
        let s = format!("{:.4}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn encode_tj(pieces: &[Piece], prefix: &str) -> Vec<u8> {
    let mut out = String::from(prefix);
    out.push('[');
    for piece in pieces {
        match piece {
            Piece::Glyphs(bytes) => {
                out.push('<');
                for b in bytes {
                    out.push_str(&format!("{:02X}", b));
                }
                out.push('>');
            }
            Piece::Shift(amount) => {
                if amount.abs() > 1e-6 {
                    out.push(' ');
                    out.push_str(&fmt_num(*amount));
                    out.push(' ');
                }
            }
        }
    }
    out.push_str("] TJ");
    out.into_bytes()
}

/// Rewrites a decoded content stream, dropping glyphs inside `rects`.
/// `ctm` is the matrix the stream starts with (identity for page content).
pub fn redact_stream(
    data: &[u8],
    fonts: &HashMap<Vec<u8>, FontMetrics>,
    rects: &[Rect],
    ctm: Matrix,
) -> (Vec<u8>, StreamReport) {
    redact_stream_with(data, fonts, rects, ctm, &HashMap::new())
}

/// Like `redact_stream`, and also points the n-th `Do` at another resource
/// name, for drawings that got a cleaned copy of their own.
pub fn redact_stream_with(
    data: &[u8],
    fonts: &HashMap<Vec<u8>, FontMetrics>,
    rects: &[Rect],
    ctm: Matrix,
    renames: &HashMap<usize, Vec<u8>>,
) -> (Vec<u8>, StreamReport) {
    let ops = parse_ops(data);
    let mut redactor = Redactor::new(fonts, rects, ctm, renames);
    let mut replacements: Vec<Option<Vec<u8>>> = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        replacements.push(redactor.process(i, op, data));
    }
    // a section left open at the end still counts
    while !redactor.marked.is_empty() {
        redactor.process(ops.len(), &Op { operator: "EMC".into(), operands: Vec::new(), start: 0, end: 0 }, data);
    }
    for (i, bytes) in std::mem::take(&mut redactor.rewrite_marks) {
        replacements[i] = Some(bytes);
    }

    let mut out = Vec::with_capacity(data.len());
    let mut cursor = 0;
    for (op, replacement) in ops.iter().zip(replacements) {
        if let Some(replacement) = replacement {
            out.extend_from_slice(&data[cursor..op.start]);
            out.extend_from_slice(&replacement);
            cursor = op.end;
        }
    }
    out.extend_from_slice(&data[cursor..]);
    (out, redactor.report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monospace(name: &str) -> HashMap<Vec<u8>, FontMetrics> {
        let mut fonts = HashMap::new();
        fonts.insert(
            name.as_bytes().to_vec(),
            FontMetrics {
                code_bytes: 1,
                widths: HashMap::new(),
                default_width: 600.0,
                scale: 0.001,
                unsupported: None,
            },
        );
        fonts
    }

    #[test]
    fn removes_only_glyphs_inside_the_box() {
        let fonts = monospace("F1");
        // 10pt Courier-like font: every glyph is 6pt wide, starting at x=100
        let content = b"BT /F1 10 Tf 100 700 Td (ABCDEF) Tj ET";
        // cover C and D (x 112..124)
        let rect = Rect { x0: 112.0, y0: 695.0, x1: 124.0, y1: 712.0 };
        let (out, report) = redact_stream(content, &fonts, &[rect], IDENTITY);
        assert_eq!(report.removed_glyphs, 2);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("[<4142> -1200 <4546>] TJ"), "{text}");
    }

    #[test]
    fn leaves_untouched_streams_byte_identical() {
        let fonts = monospace("F1");
        let content = b"q 1 0 0 1 0 0 cm BT /F1 10 Tf 100 700 Td (Hello) Tj ET Q";
        let rect = Rect { x0: 0.0, y0: 0.0, x1: 50.0, y1: 50.0 };
        let (out, report) = redact_stream(content, &fonts, &[rect], IDENTITY);
        assert_eq!(report.removed_glyphs, 0);
        assert_eq!(out, content);
    }

    #[test]
    fn respects_the_ctm() {
        let fonts = monospace("F1");
        // text drawn at 0,0 but translated to 300,300
        let content = b"1 0 0 1 300 300 cm BT /F1 10 Tf (AB) Tj ET";
        let rect = Rect { x0: 299.0, y0: 299.0, x1: 305.0, y1: 310.0 };
        let (out, report) = redact_stream(content, &fonts, &[rect], IDENTITY);
        assert_eq!(report.removed_glyphs, 1);
        assert!(String::from_utf8(out).unwrap().contains("[ -600 <42>] TJ"));
    }
}
