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
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` then `b`, using PDF's row-vector convention.
fn mul(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
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

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct StreamReport {
    pub removed_glyphs: usize,
    pub skipped_fonts: Vec<String>,
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
}

impl<'a> Redactor<'a> {
    fn new(fonts: &'a HashMap<Vec<u8>, FontMetrics>, rects: &'a [Rect], ctm: Matrix) -> Self {
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
        let metrics = self.fonts.get(&name)?;
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

        // Without a usable font we can't place glyphs, so leave the text alone.
        let font = font.filter(|_| fs != 0.0 && th != 0.0)?;

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

    /// Returns replacement bytes for `op`, or None to keep it as-is.
    fn process(&mut self, op: &Op) -> Option<Vec<u8>> {
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
    let ops = parse_ops(data);
    let mut redactor = Redactor::new(fonts, rects, ctm);
    let mut out = Vec::with_capacity(data.len());
    let mut cursor = 0;

    for op in &ops {
        if let Some(replacement) = redactor.process(op) {
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
