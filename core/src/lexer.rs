// SPDX-License-Identifier: GPL-3.0-or-later
//! A small, lossless tokenizer for PDF content streams.
//!
//! We deliberately don't build a full object tree here. Every token remembers
//! the byte range it came from, so the redactor can copy untouched operations
//! straight through and only rewrite the text-showing ones. That keeps inline
//! images, odd whitespace and anything we don't understand byte-for-byte intact.

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Number(f64),
    Name(Vec<u8>),
    /// Decoded bytes of a literal `( )` or hex `< >` string.
    Str(Vec<u8>),
    ArrayStart,
    ArrayEnd,
    DictStart,
    DictEnd,
    Bool(bool),
    Null,
    Operator(String),
}

#[derive(Debug, Clone)]
pub struct Spanned {
    pub token: Token,
    pub start: usize,
    pub end: usize,
}

pub struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
}

fn is_whitespace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0c | 0x00)
}

fn is_delimiter(b: u8) -> bool {
    matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

fn is_regular(b: u8) -> bool {
    !is_whitespace(b) && !is_delimiter(b)
}

impl<'a> Lexer<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Lexer { data, pos: 0 }
    }

    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    fn skip_whitespace_and_comments(&mut self) {
        while let Some(b) = self.peek() {
            if is_whitespace(b) {
                self.pos += 1;
            } else if b == b'%' {
                while let Some(c) = self.peek() {
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// After an `ID` operator the next bytes are raw image data, terminated by
    /// `EI` surrounded by whitespace. We hop over it and hand back the span so
    /// the caller can copy it verbatim.
    pub fn skip_inline_image_data(&mut self) -> usize {
        // exactly one whitespace byte separates ID from the data
        if self.peek().is_some_and(is_whitespace) {
            self.pos += 1;
        }
        let d = self.data;
        let mut i = self.pos;
        while i + 1 < d.len() {
            if d[i] == b'E'
                && d[i + 1] == b'I'
                && (i == 0 || is_whitespace(d[i - 1]))
                && (i + 2 >= d.len() || is_whitespace(d[i + 2]) || is_delimiter(d[i + 2]))
            {
                self.pos = i + 2;
                return self.pos;
            }
            i += 1;
        }
        self.pos = d.len();
        self.pos
    }

    fn read_literal_string(&mut self) -> Vec<u8> {
        // we're sitting on the opening '('
        self.pos += 1;
        let mut out = Vec::new();
        let mut depth = 1;
        while let Some(b) = self.peek() {
            self.pos += 1;
            match b {
                b'\\' => {
                    let Some(e) = self.peek() else { break };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0c),
                        b'\r' => {
                            if self.peek() == Some(b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        b'0'..=b'7' => {
                            let mut value = (e - b'0') as u32;
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(c @ b'0'..=b'7') => {
                                        value = value * 8 + (c - b'0') as u32;
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push((value & 0xff) as u8);
                        }
                        other => out.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(b);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(b);
                }
                _ => out.push(b),
            }
        }
        out
    }

    fn read_hex_string(&mut self) -> Vec<u8> {
        self.pos += 1; // '<'
        let mut digits = Vec::new();
        while let Some(b) = self.peek() {
            self.pos += 1;
            if b == b'>' {
                break;
            }
            if b.is_ascii_hexdigit() {
                digits.push(b);
            }
        }
        if digits.len() % 2 == 1 {
            digits.push(b'0');
        }
        digits
            .chunks(2)
            .map(|pair| {
                let s = std::str::from_utf8(pair).unwrap_or("00");
                u8::from_str_radix(s, 16).unwrap_or(0)
            })
            .collect()
    }

    fn read_name(&mut self) -> Vec<u8> {
        self.pos += 1; // '/'
        let mut out = Vec::new();
        while let Some(b) = self.peek() {
            if !is_regular(b) {
                break;
            }
            self.pos += 1;
            if b == b'#' {
                let hi = self.data.get(self.pos).copied();
                let lo = self.data.get(self.pos + 1).copied();
                if let (Some(h), Some(l)) = (hi, lo) {
                    if h.is_ascii_hexdigit() && l.is_ascii_hexdigit() {
                        let s = [h, l];
                        let v = u8::from_str_radix(std::str::from_utf8(&s).unwrap(), 16).unwrap();
                        out.push(v);
                        self.pos += 2;
                        continue;
                    }
                }
            }
            out.push(b);
        }
        out
    }

    fn read_regular(&mut self) -> &'a [u8] {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if !is_regular(b) {
                break;
            }
            self.pos += 1;
        }
        &self.data[start..self.pos]
    }

    pub fn next_token(&mut self) -> Option<Spanned> {
        self.skip_whitespace_and_comments();
        let start = self.pos;
        let b = self.peek()?;
        let token = match b {
            b'(' => Token::Str(self.read_literal_string()),
            b'<' => {
                if self.data.get(self.pos + 1) == Some(&b'<') {
                    self.pos += 2;
                    Token::DictStart
                } else {
                    Token::Str(self.read_hex_string())
                }
            }
            b'>' => {
                // a stray '>' is malformed, but don't loop forever on it
                if self.data.get(self.pos + 1) == Some(&b'>') {
                    self.pos += 2;
                } else {
                    self.pos += 1;
                }
                Token::DictEnd
            }
            b'[' => {
                self.pos += 1;
                Token::ArrayStart
            }
            b']' => {
                self.pos += 1;
                Token::ArrayEnd
            }
            b'{' | b'}' | b')' => {
                // only valid inside PostScript calculator functions; treat as noise
                self.pos += 1;
                Token::Operator(String::from_utf8_lossy(&[b]).into_owned())
            }
            b'/' => Token::Name(self.read_name()),
            _ => {
                let word = self.read_regular();
                if word.is_empty() {
                    // shouldn't happen, but make progress regardless
                    self.pos += 1;
                    return self.next_token();
                }
                parse_word(word)
            }
        };
        Some(Spanned { token, start, end: self.pos })
    }
}

fn parse_word(word: &[u8]) -> Token {
    let text = String::from_utf8_lossy(word);
    let first = word[0];
    if first.is_ascii_digit() || first == b'-' || first == b'+' || first == b'.' {
        if let Ok(n) = text.parse::<f64>() {
            return Token::Number(n);
        }
        // things like "--5" or "1.2.3" show up in the wild; be forgiving
        let cleaned: String = text
            .chars()
            .enumerate()
            .filter(|(i, c)| c.is_ascii_digit() || *c == '.' || (*i == 0 && *c == '-'))
            .map(|(_, c)| c)
            .collect();
        if let Ok(n) = cleaned.parse::<f64>() {
            return Token::Number(n);
        }
    }
    match &*text {
        "true" => Token::Bool(true),
        "false" => Token::Bool(false),
        "null" => Token::Null,
        _ => Token::Operator(text.into_owned()),
    }
}

/// One content-stream operation: its operands, operator, and the byte range
/// covering the whole thing (first operand through the operator).
#[derive(Debug, Clone)]
pub struct Op {
    pub operator: String,
    pub operands: Vec<Operand>,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    Number(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    Array(Vec<Operand>),
    Other,
}

impl Operand {
    pub fn num(&self) -> Option<f64> {
        match self {
            Operand::Number(n) => Some(*n),
            _ => None,
        }
    }
}

/// Splits a content stream into operations. Inline images come back as a
/// single `BI` op spanning BI through EI.
pub fn parse_ops(data: &[u8]) -> Vec<Op> {
    let mut lexer = Lexer::new(data);
    let mut ops = Vec::new();
    let mut operands: Vec<Operand> = Vec::new();
    let mut op_start: Option<usize> = None;
    // stack of arrays being built, so nested arrays work
    let mut arrays: Vec<Vec<Operand>> = Vec::new();
    let mut dict_depth = 0usize;

    while let Some(sp) = lexer.next_token() {
        if op_start.is_none() {
            op_start = Some(sp.start);
        }
        let value = match sp.token {
            Token::Number(n) => Some(Operand::Number(n)),
            Token::Name(n) => Some(Operand::Name(n)),
            Token::Str(s) => Some(Operand::Str(s)),
            Token::Bool(_) | Token::Null => Some(Operand::Other),
            Token::ArrayStart => {
                arrays.push(Vec::new());
                None
            }
            Token::ArrayEnd => arrays.pop().map(Operand::Array),
            Token::DictStart => {
                dict_depth += 1;
                None
            }
            Token::DictEnd => {
                dict_depth = dict_depth.saturating_sub(1);
                if dict_depth == 0 {
                    Some(Operand::Other)
                } else {
                    None
                }
            }
            Token::Operator(name) => {
                if dict_depth > 0 || !arrays.is_empty() {
                    // an operator-looking word inside a dict or array, e.g. an
                    // unquoted keyword in a BDC property list; just keep going
                    continue;
                }
                let start = op_start.take().unwrap_or(sp.start);
                if name == "BI" {
                    // read the image dictionary up to ID, then the raw data
                    loop {
                        match lexer.next_token() {
                            Some(Spanned { token: Token::Operator(o), .. }) if o == "ID" => break,
                            Some(_) => continue,
                            None => break,
                        }
                    }
                    let end = lexer.skip_inline_image_data();
                    ops.push(Op { operator: "BI".into(), operands: Vec::new(), start, end });
                } else {
                    ops.push(Op {
                        operator: name,
                        operands: std::mem::take(&mut operands),
                        start,
                        end: sp.end,
                    });
                }
                operands.clear();
                continue;
            }
        };
        if let Some(v) = value {
            if dict_depth > 0 {
                continue;
            }
            match arrays.last_mut() {
                Some(arr) => arr.push(v),
                None => operands.push(v),
            }
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_simple_text_ops() {
        let ops = parse_ops(b"BT /F1 12 Tf 72 700 Td (Hello \\(world\\)) Tj ET");
        let names: Vec<_> = ops.iter().map(|o| o.operator.as_str()).collect();
        assert_eq!(names, ["BT", "Tf", "Td", "Tj", "ET"]);
        assert_eq!(ops[3].operands[0], Operand::Str(b"Hello (world)".to_vec()));
    }

    #[test]
    fn keeps_inline_images_whole() {
        let data = b"q BI /W 2 /H 1 /CS /G /BPC 8 ID \x00\xffEI\x01 EI Q";
        let ops = parse_ops(data);
        let names: Vec<_> = ops.iter().map(|o| o.operator.as_str()).collect();
        assert_eq!(names, ["q", "BI", "Q"]);
        let bi = &ops[1];
        assert!(data[bi.start..bi.end].ends_with(b"EI"));
    }

    #[test]
    fn handles_tj_arrays_and_hex() {
        let ops = parse_ops(b"[<0041> -250 (B)] TJ");
        assert_eq!(ops.len(), 1);
        assert_eq!(
            ops[0].operands[0],
            Operand::Array(vec![
                Operand::Str(vec![0x00, 0x41]),
                Operand::Number(-250.0),
                Operand::Str(b"B".to_vec())
            ])
        );
    }

    #[test]
    fn ignores_marked_content_dicts() {
        let ops = parse_ops(b"/Span <</ActualText (x) /MCID 3>> BDC (a) Tj EMC");
        let names: Vec<_> = ops.iter().map(|o| o.operator.as_str()).collect();
        assert_eq!(names, ["BDC", "Tj", "EMC"]);
    }
}
