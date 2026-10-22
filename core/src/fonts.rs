// SPDX-License-Identifier: GPL-3.0-or-later
//! Just enough font knowledge to walk a text string glyph by glyph:
//! how many bytes each character code takes, and how wide each glyph is.

use crate::base14;
use lopdf::{Dictionary, Document, Object};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct FontMetrics {
    /// 1 for simple fonts, 2 for Type0 fonts using a two-byte CMap.
    pub code_bytes: usize,
    /// Glyph widths in glyph-space units, keyed by character code.
    pub widths: HashMap<u32, f64>,
    pub default_width: f64,
    /// Converts glyph-space units to text-space (1/1000 for everything except Type3).
    pub scale: f64,
    /// Set when we can't confidently decode this font. Text in it is left alone.
    pub unsupported: Option<String>,
}

impl FontMetrics {
    pub fn width_of(&self, code: u32) -> f64 {
        self.widths.get(&code).copied().unwrap_or(self.default_width)
    }

    /// Splits a string operand into character codes.
    pub fn codes(&self, bytes: &[u8]) -> Vec<(u32, Vec<u8>)> {
        bytes
            .chunks(self.code_bytes)
            .map(|chunk| {
                let code = chunk.iter().fold(0u32, |acc, b| (acc << 8) | *b as u32);
                (code, chunk.to_vec())
            })
            .collect()
    }

    fn unknown(reason: &str) -> Self {
        FontMetrics {
            code_bytes: 1,
            widths: HashMap::new(),
            default_width: 500.0,
            scale: 0.001,
            unsupported: Some(reason.to_string()),
        }
    }
}

fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    match obj {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(obj),
        other => other,
    }
}

fn as_number(doc: &Document, obj: &Object) -> Option<f64> {
    match resolve(doc, obj) {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn dict_number(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<f64> {
    dict.get(key).ok().and_then(|o| as_number(doc, o))
}

fn dict_array<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Vec<Object>> {
    dict.get(key).ok().and_then(|o| resolve(doc, o).as_array().ok())
}

fn dict_dict<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    dict.get(key).ok().and_then(|o| resolve(doc, o).as_dict().ok())
}

fn dict_name(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<String> {
    dict.get(key)
        .ok()
        .and_then(|o| resolve(doc, o).as_name().ok())
        .map(|n| String::from_utf8_lossy(n).into_owned())
}

/// Which built-in metrics table to use for a BaseFont name. Handles subset
/// prefixes ("ABCDEF+Helvetica") and the usual Windows aliases for the trio.
fn base14_table(base_font: &str) -> Option<(&'static [(&'static str, u16)], bool)> {
    let name = base_font.split_once('+').map_or(base_font, |(_, rest)| rest);
    let lower = name.to_ascii_lowercase().replace([' ', '-', ',', '_'], "");
    let bold = lower.contains("bold");
    let italic = lower.contains("italic") || lower.contains("oblique");

    if lower.starts_with("symbol") {
        return Some((base14::SYMBOL, true));
    }
    if lower.starts_with("zapfdingbats") || lower.starts_with("dingbats") {
        return Some((base14::ZAPF_DINGBATS, true));
    }
    if lower.starts_with("courier") {
        return None; // monospaced, handled by the 600 default
    }
    if lower.starts_with("times") {
        let table = match (bold, italic) {
            (true, true) => base14::TIMES_BOLD_ITALIC,
            (true, false) => base14::TIMES_BOLD,
            (false, true) => base14::TIMES_ITALIC,
            (false, false) => base14::TIMES_ROMAN,
        };
        return Some((table, false));
    }
    if lower.starts_with("helvetica") || lower.starts_with("arial") {
        return Some((if bold { base14::HELVETICA_BOLD } else { base14::HELVETICA }, false));
    }
    None
}

fn glyph_width(table: &[(&str, u16)], glyph: &str) -> Option<f64> {
    table
        .binary_search_by(|(g, _)| (*g).cmp(glyph))
        .ok()
        .map(|i| table[i].1 as f64)
}

/// Builds a code → width map for a standard font from its encoding: the
/// base encoding named in the font, patched by any /Differences array.
fn base14_widths(doc: &Document, font: &Dictionary, base_font: &str) -> HashMap<u32, f64> {
    let Some((table, symbolic)) = base14_table(base_font) else {
        return HashMap::new();
    };

    let lower = base_font.to_ascii_lowercase();
    let builtin: &[&str; 256] = if lower.contains("symbol") {
        &base14::SYMBOL_ENC
    } else if lower.contains("dingbats") {
        &base14::ZAPF_ENC
    } else {
        &base14::STANDARD
    };

    let pick = |name: &str| -> &[&str; 256] {
        match name {
            "WinAnsiEncoding" => &base14::WIN_ANSI,
            "MacRomanEncoding" => &base14::MAC_ROMAN,
            "StandardEncoding" => &base14::STANDARD,
            _ => builtin,
        }
    };

    let mut names: Vec<String> = builtin.iter().map(|s| s.to_string()).collect();
    match font.get(b"Encoding").map(|o| resolve(doc, o)) {
        Ok(Object::Name(n)) if !symbolic => {
            names = pick(&String::from_utf8_lossy(n)).iter().map(|s| s.to_string()).collect();
        }
        Ok(Object::Dictionary(enc)) => {
            if let (false, Some(base)) = (symbolic, dict_name(doc, enc, b"BaseEncoding")) {
                names = pick(&base).iter().map(|s| s.to_string()).collect();
            }
            if let Some(diffs) = dict_array(doc, enc, b"Differences") {
                let mut code = 0usize;
                for item in diffs {
                    match resolve(doc, item) {
                        Object::Integer(i) => code = (*i).clamp(0, 255) as usize,
                        Object::Name(glyph) => {
                            if code < 256 {
                                names[code] = String::from_utf8_lossy(glyph).into_owned();
                            }
                            code += 1;
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }

    names
        .iter()
        .enumerate()
        .filter_map(|(code, glyph)| {
            if glyph.is_empty() {
                None
            } else {
                glyph_width(table, glyph).map(|w| (code as u32, w))
            }
        })
        .collect()
}

/// Fallback advance when we know nothing better (Courier, or an unknown
/// non-embedded font without a Widths array).
fn base14_default(base_font: &str) -> f64 {
    let lower = base_font.to_ascii_lowercase();
    if lower.contains("courier") {
        600.0
    } else if lower.contains("times") {
        480.0
    } else {
        540.0
    }
}

pub fn load(doc: &Document, font: &Dictionary) -> FontMetrics {
    let subtype = dict_name(doc, font, b"Subtype").unwrap_or_default();
    match subtype.as_str() {
        "Type0" => load_type0(doc, font),
        "Type3" => load_simple(doc, font, true),
        _ => load_simple(doc, font, false),
    }
}

fn load_simple(doc: &Document, font: &Dictionary, type3: bool) -> FontMetrics {
    let base_font = dict_name(doc, font, b"BaseFont").unwrap_or_default();
    let first_char = dict_number(doc, font, b"FirstChar").unwrap_or(0.0) as u32;

    let mut widths = HashMap::new();
    if let Some(arr) = dict_array(doc, font, b"Widths") {
        for (i, w) in arr.iter().enumerate() {
            if let Some(w) = as_number(doc, w) {
                widths.insert(first_char + i as u32, w);
            }
        }
    }

    if widths.is_empty() && !type3 {
        widths = base14_widths(doc, font, &base_font);
    }

    let missing = dict_dict(doc, font, b"FontDescriptor")
        .and_then(|fd| dict_number(doc, fd, b"MissingWidth"))
        .filter(|w| *w > 0.0);
    let default_width = if widths.is_empty() {
        base14_default(&base_font)
    } else {
        missing.unwrap_or_else(|| average(&widths))
    };

    let scale = if type3 {
        dict_array(doc, font, b"FontMatrix")
            .and_then(|m| m.first())
            .and_then(|a| as_number(doc, a))
            .unwrap_or(0.001)
    } else {
        0.001
    };

    FontMetrics { code_bytes: 1, widths, default_width, scale, unsupported: None }
}

fn load_type0(doc: &Document, font: &Dictionary) -> FontMetrics {
    // Encoding is either a predefined CMap name or an embedded CMap stream.
    let encoding = match font.get(b"Encoding").map(|o| resolve(doc, o)) {
        Ok(Object::Name(n)) => String::from_utf8_lossy(n).into_owned(),
        Ok(Object::Stream(s)) => s
            .dict
            .get(b"CMapName")
            .ok()
            .and_then(|o| o.as_name().ok())
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .unwrap_or_else(|| "Embedded".into()),
        _ => String::new(),
    };

    if encoding.ends_with("-V") {
        return FontMetrics::unknown("vertical writing");
    }
    // Identity-H and the UCS-2 / UTF-16 CMaps are fixed two-byte. Embedded
    // CMaps produced by real-world tools are almost always two-byte as well.
    let two_byte = encoding == "Identity-H"
        || encoding.contains("UCS2")
        || encoding.contains("UTF16")
        || encoding == "Embedded"
        || encoding.starts_with("Adobe-Identity");
    if !two_byte {
        return FontMetrics::unknown("variable-width CMap");
    }

    let descendant = dict_array(doc, font, b"DescendantFonts")
        .and_then(|arr| arr.first())
        .and_then(|o| resolve(doc, o).as_dict().ok());
    let Some(cid_font) = descendant else {
        return FontMetrics::unknown("missing descendant font");
    };

    let default_width = dict_number(doc, cid_font, b"DW").unwrap_or(1000.0);
    let mut widths = HashMap::new();
    if let Some(w) = dict_array(doc, cid_font, b"W") {
        // Two forms, mixed freely:  c [w1 w2 ...]   or   c_first c_last w
        let mut i = 0;
        while i < w.len() {
            let Some(first) = as_number(doc, &w[i]) else { break };
            let first = first as u32;
            match w.get(i + 1).map(|o| resolve(doc, o)) {
                Some(Object::Array(list)) => {
                    for (k, item) in list.iter().enumerate() {
                        if let Some(width) = as_number(doc, item) {
                            widths.insert(first + k as u32, width);
                        }
                    }
                    i += 2;
                }
                Some(last) => {
                    let last = as_number(doc, last).unwrap_or(first as f64) as u32;
                    let width = w.get(i + 2).and_then(|o| as_number(doc, o)).unwrap_or(default_width);
                    // guard against absurd ranges in broken files
                    for code in first..=last.min(first + 0xffff) {
                        widths.insert(code, width);
                    }
                    i += 3;
                }
                None => break,
            }
        }
    }

    FontMetrics { code_bytes: 2, widths, default_width, scale: 0.001, unsupported: None }
}

fn average(widths: &HashMap<u32, f64>) -> f64 {
    let positive: Vec<f64> = widths.values().copied().filter(|w| *w > 0.0).collect();
    if positive.is_empty() {
        500.0
    } else {
        positive.iter().sum::<f64>() / positive.len() as f64
    }
}
