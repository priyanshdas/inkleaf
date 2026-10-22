// SPDX-License-Identifier: GPL-3.0-or-later
//! Making PDFs smaller.
//!
//! Three things usually make a PDF bigger than it needs to be, and this
//! handles each:
//!
//! 1. Photos stored at far more pixels (or far higher JPEG quality) than
//!    anyone will see. They're scaled down and re-encoded.
//! 2. The same font or image stored several times over, typically after
//!    merging files. Identical streams are folded into one.
//! 3. Streams saved with no compression at all, and objects nothing refers
//!    to any more. The first are deflated, the second dropped.
//!
//! Every change is only kept if it actually makes that object smaller.

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Keeps images almost as they are; mainly removes waste.
    Light,
    /// Good for email: images capped at about 150 dpi on a typical page.
    Balanced,
    /// As small as is still readable.
    Strong,
}

struct Settings {
    /// Longest side an image may keep, in pixels.
    max_side: u32,
    jpeg_quality: u8,
    /// Re-encode JPEGs that are already small enough, at the lower quality.
    requality_jpegs: bool,
    /// Turn big losslessly stored photos into JPEGs.
    flate_photos_to_jpeg: bool,
}

impl Level {
    fn settings(self) -> Settings {
        match self {
            Level::Light => Settings { max_side: 3000, jpeg_quality: 85, requality_jpegs: false, flate_photos_to_jpeg: false },
            Level::Balanced => Settings { max_side: 1800, jpeg_quality: 72, requality_jpegs: true, flate_photos_to_jpeg: true },
            Level::Strong => Settings { max_side: 1200, jpeg_quality: 55, requality_jpegs: true, flate_photos_to_jpeg: true },
        }
    }
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompressReport {
    pub before: usize,
    pub after: usize,
    pub images_shrunk: usize,
    pub duplicates_merged: usize,
    pub streams_deflated: usize,
}

fn name_is(dict: &Dictionary, key: &[u8], value: &[u8]) -> bool {
    matches!(dict.get(key), Ok(Object::Name(n)) if n == value)
}

/// The filters on a stream, in order, as names.
fn filters(dict: &Dictionary) -> Vec<Vec<u8>> {
    match dict.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec)).collect(),
        _ => Vec::new(),
    }
}

fn int(dict: &Dictionary, key: &[u8]) -> Option<i64> {
    dict.get(key).ok().and_then(|o| o.as_i64().ok())
}

/// Colour channels for the simple colour spaces we know how to re-encode.
fn channels(doc: &Document, dict: &Dictionary) -> Option<usize> {
    let space = match dict.get(b"ColorSpace").ok()? {
        Object::Reference(id) => doc.get_object(*id).ok()?.clone(),
        other => other.clone(),
    };
    match space {
        Object::Name(n) if n == b"DeviceRGB" || n == b"CalRGB" => Some(3),
        Object::Name(n) if n == b"DeviceGray" || n == b"CalGray" => Some(1),
        // ICC-based spaces say how many components they have
        Object::Array(a) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
            let stream = match a.get(1)? {
                Object::Reference(id) => doc.get_object(*id).ok()?.as_stream().ok()?.clone(),
                _ => return None,
            };
            match int(&stream.dict, b"N")? {
                1 => Some(1),
                3 => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Area-averaging downscale: every source pixel contributes to exactly the
/// output pixels it overlaps, which keeps photos smooth and text readable.
fn downscale(pixels: &[u8], w: usize, h: usize, ch: usize, nw: usize, nh: usize) -> Vec<u8> {
    let mut out = vec![0u8; nw * nh * ch];
    let sx = w as f64 / nw as f64;
    let sy = h as f64 / nh as f64;
    let mut acc = vec![0f64; ch];
    for oy in 0..nh {
        let y0 = oy as f64 * sy;
        let y1 = y0 + sy;
        for ox in 0..nw {
            let x0 = ox as f64 * sx;
            let x1 = x0 + sx;
            acc.iter_mut().for_each(|a| *a = 0.0);
            let mut total = 0.0;
            let mut y = y0.floor() as usize;
            while (y as f64) < y1 && y < h {
                let wy = (y1.min(y as f64 + 1.0) - y0.max(y as f64)).max(0.0);
                let mut x = x0.floor() as usize;
                while (x as f64) < x1 && x < w {
                    let wx = (x1.min(x as f64 + 1.0) - x0.max(x as f64)).max(0.0);
                    let weight = wx * wy;
                    let i = (y * w + x) * ch;
                    for c in 0..ch {
                        acc[c] += pixels[i + c] as f64 * weight;
                    }
                    total += weight;
                    x += 1;
                }
                y += 1;
            }
            let o = (oy * nw + ox) * ch;
            for c in 0..ch {
                out[o + c] = (acc[c] / total.max(1e-9)).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

fn encode_jpeg(pixels: &[u8], w: usize, h: usize, ch: usize, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let colour = if ch == 1 { jpeg_encoder::ColorType::Luma } else { jpeg_encoder::ColorType::Rgb };
    jpeg_encoder::Encoder::new(&mut out, quality).encode(pixels, w as u16, h as u16, colour).ok()?;
    Some(out)
}

/// A rough test for "photo" rather than flat artwork: photos have lots of
/// distinct colours, diagrams and screenshots don't. JPEG suits only photos.
fn looks_like_photo(pixels: &[u8], ch: usize) -> bool {
    let mut seen = std::collections::HashSet::new();
    let step = (pixels.len() / ch / 4000).max(1);
    for px in pixels.chunks_exact(ch).step_by(step) {
        // ignore the lowest bits so noise doesn't count as new colours
        let key: Vec<u8> = px.iter().map(|v| v >> 3).collect();
        seen.insert(key);
        if seen.len() > 600 {
            return true;
        }
    }
    false
}

/// Undoes the text-safe and zip wrappers some writers put around image data
/// (ReportLab, for one, stores JPEGs as ASCII85 text).
fn unwrap_layers(mut data: Vec<u8>, layers: &[Vec<u8>]) -> Option<Vec<u8>> {
    for layer in layers {
        data = match layer.as_slice() {
            b"ASCII85Decode" | b"A85" => ascii85(&data)?,
            b"ASCIIHexDecode" | b"AHx" => ascii_hex(&data)?,
            b"FlateDecode" | b"Fl" => {
                use std::io::Read;
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(data.as_slice()).read_to_end(&mut out).ok()?;
                out
            }
            _ => return None,
        };
    }
    Some(data)
}

fn ascii85(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 4 / 5);
    let mut group = [0u8; 5];
    let mut n = 0;
    let body = input.strip_prefix(b"<~").unwrap_or(input);
    for &c in body {
        match c {
            b'~' => break,
            b'z' if n == 0 => out.extend_from_slice(&[0; 4]),
            b'!'..=b'u' => {
                group[n] = c - b'!';
                n += 1;
                if n == 5 {
                    let v = group.iter().fold(0u64, |acc, &d| acc * 85 + d as u64);
                    if v > u32::MAX as u64 {
                        return None;
                    }
                    out.extend_from_slice(&(v as u32).to_be_bytes());
                    n = 0;
                }
            }
            c if c.is_ascii_whitespace() => {}
            _ => return None,
        }
    }
    if n > 0 {
        // a short final group is padded with 'u' and then trimmed
        for slot in group.iter_mut().skip(n) {
            *slot = 84;
        }
        let v = group.iter().fold(0u64, |acc, &d| acc * 85 + d as u64);
        out.extend_from_slice(&(v as u32).to_be_bytes()[..n - 1]);
    }
    Some(out)
}

fn ascii_hex(input: &[u8]) -> Option<Vec<u8>> {
    let digits: Vec<u8> = input
        .iter()
        .take_while(|&&c| c != b'>')
        .filter(|c| !c.is_ascii_whitespace())
        .map(|&c| (c as char).to_digit(16).map(|d| d as u8))
        .collect::<Option<_>>()?;
    Some(digits.chunks(2).map(|p| (p[0] << 4) | p.get(1).copied().unwrap_or(0)).collect())
}

/// Tries to make one image stream smaller. Returns the replacement if it is.
fn shrink_image(doc: &Document, stream: &Stream, s: &Settings) -> Option<Stream> {
    let dict = &stream.dict;
    if !name_is(dict, b"Subtype", b"Image") {
        return None;
    }
    // masks, unusual bit depths and inverted decodes are left exactly alone
    if dict.has(b"ImageMask") || dict.has(b"Decode") || dict.has(b"Mask") && !matches!(dict.get(b"Mask"), Ok(Object::Reference(_))) {
        return None;
    }
    if int(dict, b"BitsPerComponent").unwrap_or(8) != 8 {
        return None;
    }
    let w = int(dict, b"Width")? as usize;
    let h = int(dict, b"Height")? as usize;
    if w < 16 || h < 16 || w > 20000 || h > 20000 {
        return None;
    }
    let ch = channels(doc, dict)?;
    let fl = filters(dict);

    let (pixels, was_jpeg) = match fl.as_slice() {
        [wrappers @ .., f] if f == b"DCTDecode" => {
            let jpeg = unwrap_layers(stream.content.clone(), wrappers)?;
            let mut decoder = jpeg_decoder::Decoder::new(jpeg.as_slice());
            let pixels = decoder.decode().ok()?;
            let info = decoder.info()?;
            let got = match info.pixel_format {
                jpeg_decoder::PixelFormat::L8 => 1,
                jpeg_decoder::PixelFormat::RGB24 => 3,
                _ => return None,
            };
            if got != ch || info.width as usize != w || info.height as usize != h {
                return None;
            }
            (pixels, true)
        }
        [] | [_] if fl.is_empty() || fl[0] == b"FlateDecode" => {
            if !s.flate_photos_to_jpeg {
                return None;
            }
            let pixels = if fl.is_empty() { stream.content.clone() } else { stream.decompressed_content().ok()? };
            if pixels.len() != w * h * ch {
                return None;
            }
            // small or flat-colour images compress better losslessly
            if w * h < 200 * 200 || !looks_like_photo(&pixels, ch) {
                return None;
            }
            (pixels, false)
        }
        _ => return None,
    };

    let longest = w.max(h) as u32;
    let too_big = longest > s.max_side;
    if was_jpeg && !too_big && !s.requality_jpegs {
        return None;
    }
    let (nw, nh, pixels) = if too_big {
        let scale = s.max_side as f64 / longest as f64;
        let nw = ((w as f64 * scale).round() as usize).max(1);
        let nh = ((h as f64 * scale).round() as usize).max(1);
        (nw, nh, downscale(&pixels, w, h, ch, nw, nh))
    } else {
        (w, h, pixels)
    };

    let jpeg = encode_jpeg(&pixels, nw, nh, ch, s.jpeg_quality)?;
    // a re-encode that comes out bigger isn't worth the quality loss
    if jpeg.len() as f64 > stream.content.len() as f64 * 0.9 {
        return None;
    }

    let mut out = dict.clone();
    out.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    out.remove(b"DecodeParms");
    out.set("Width", Object::Integer(nw as i64));
    out.set("Height", Object::Integer(nh as i64));
    out.set("BitsPerComponent", Object::Integer(8));
    let mut result = Stream::new(out, jpeg);
    result.allows_compression = false;
    Some(result)
}

/// Rewrites every reference in `obj` according to `map`.
fn remap(obj: &mut Object, map: &HashMap<ObjectId, ObjectId>) {
    match obj {
        Object::Reference(id) => {
            if let Some(to) = map.get(id) {
                *id = *to;
            }
        }
        Object::Array(items) => items.iter_mut().for_each(|o| remap(o, map)),
        Object::Dictionary(dict) => dict.iter_mut().for_each(|(_, o)| remap(o, map)),
        Object::Stream(stream) => stream.dict.iter_mut().for_each(|(_, o)| remap(o, map)),
        _ => {}
    }
}

/// Folds byte-identical streams (same dictionary, same data) into one copy.
fn merge_duplicates(doc: &mut Document) -> usize {
    let mut seen: HashMap<[u8; 32], ObjectId> = HashMap::new();
    let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
    for (&id, obj) in doc.objects.iter() {
        let Object::Stream(stream) = obj else { continue };
        // page content is unique per page almost always; skipping tiny
        // streams keeps the hashing cheap
        if stream.content.len() < 256 {
            continue;
        }
        let mut hasher = Sha256::new();
        let mut keys: Vec<_> = stream.dict.iter().filter(|(k, _)| k.as_slice() != b"Length").collect();
        keys.sort_by(|a, b| a.0.cmp(b.0));
        hasher.update(format!("{keys:?}").as_bytes());
        hasher.update(&stream.content);
        let digest: [u8; 32] = hasher.finalize().into();
        match seen.get(&digest) {
            Some(&first) => {
                map.insert(id, first);
            }
            None => {
                seen.insert(digest, id);
            }
        }
    }
    if map.is_empty() {
        return 0;
    }
    for obj in doc.objects.values_mut() {
        remap(obj, &map);
    }
    let mut trailer = Object::Dictionary(std::mem::take(&mut doc.trailer));
    remap(&mut trailer, &map);
    if let Object::Dictionary(d) = trailer {
        doc.trailer = d;
    }
    let count = map.len();
    for id in map.keys() {
        doc.objects.remove(id);
    }
    count
}

pub fn compress(doc: &mut Document, level: Level) -> CompressReport {
    let s = level.settings();
    let mut report = CompressReport::default();

    // 1. images
    let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    let mut replacements: BTreeMap<ObjectId, Stream> = BTreeMap::new();
    for id in &ids {
        if let Ok(Object::Stream(stream)) = doc.get_object(*id) {
            if let Some(smaller) = shrink_image(doc, stream, &s) {
                replacements.insert(*id, smaller);
            }
        }
    }
    report.images_shrunk = replacements.len();
    // A soft mask must match its image's size, so when an image is scaled
    // its mask is scaled to match.
    let mut masks: Vec<(ObjectId, usize, usize)> = Vec::new();
    for stream in replacements.values() {
        if let Ok(Object::Reference(mask)) = stream.dict.get(b"SMask") {
            let w = int(&stream.dict, b"Width").unwrap_or(0) as usize;
            let h = int(&stream.dict, b"Height").unwrap_or(0) as usize;
            masks.push((*mask, w, h));
        }
    }
    for (id, stream) in replacements {
        doc.objects.insert(id, Object::Stream(stream));
    }
    for (mask_id, nw, nh) in masks {
        let Ok(Object::Stream(mask)) = doc.get_object(mask_id) else { continue };
        let (Some(w), Some(h)) = (int(&mask.dict, b"Width"), int(&mask.dict, b"Height")) else { continue };
        let (w, h) = (w as usize, h as usize);
        if (w, h) == (nw, nh) || int(&mask.dict, b"BitsPerComponent").unwrap_or(8) != 8 {
            continue;
        }
        let Ok(pixels) = mask.decompressed_content() else { continue };
        if pixels.len() != w * h {
            continue;
        }
        let small = downscale(&pixels, w, h, 1, nw, nh);
        let mut dict = mask.dict.clone();
        dict.remove(b"DecodeParms");
        dict.remove(b"Filter");
        dict.set("Width", Object::Integer(nw as i64));
        dict.set("Height", Object::Integer(nh as i64));
        let mut stream = Stream::new(dict, small);
        let _ = stream.compress();
        doc.objects.insert(mask_id, Object::Stream(stream));
    }

    // 2. duplicates
    report.duplicates_merged = merge_duplicates(doc);

    // 3. uncompressed streams and leftovers
    for obj in doc.objects.values_mut() {
        if let Object::Stream(stream) = obj {
            if !stream.dict.has(b"Filter") && stream.content.len() > 64 && stream.allows_compression {
                let before = stream.content.len();
                if stream.compress().is_ok() && stream.content.len() < before {
                    report.streams_deflated += 1;
                }
            }
        }
    }
    doc.prune_objects();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_averages() {
        // a 2x2 checkerboard averaged to one grey pixel
        let px = [0, 255, 255, 0];
        assert_eq!(downscale(&px, 2, 2, 1, 1, 1), vec![128]);
    }

    #[test]
    fn ascii85_round_trip() {
        assert_eq!(ascii85(b"87cURD]j7BEbo80~>").unwrap(), b"Hello world!");
        assert_eq!(ascii_hex(b"48 65 6C6C6F>").unwrap(), b"Hello");
    }

    #[test]
    fn photo_detection() {
        let flat = vec![200u8; 300 * 300 * 3];
        assert!(!looks_like_photo(&flat, 3));
        let mut x: u32 = 2463534242;
        let noisy: Vec<u8> = (0..300 * 300 * 3)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 24) as u8
            })
            .collect();
        assert!(looks_like_photo(&noisy, 3));
    }
}
