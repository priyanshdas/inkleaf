// SPDX-License-Identifier: GPL-3.0-or-later
//! Redaction across a whole page, not just its text.
//!
//! redact.rs takes glyphs out of one content stream. A page holds more than
//! that, and every part of it can carry what's under a black box:
//!
//! - Form XObjects: pieces of content drawn with `Do`, each a stream of its
//!   own, often nested. They're redacted the same way, through their own
//!   fonts and placement.
//! - Pictures: the pixels under the box are painted over in the picture
//!   itself, so a scanned page keeps the rest of its image.
//! - Comments, links and form fields whose box touches a redaction box are
//!   removed, with their pop-ups and replies.
//! - Tags: text that was cut also loses its "actual text" and alt text, which
//!   screen readers and copy-paste would otherwise still hand out.
//! - The page thumbnail, a small picture of the page as it was, is dropped.
//!
//! When something under a box can't be cleaned (a font we can't measure, a
//! picture stored in a way we can't edit), the whole redaction fails. A file
//! that looks redacted but isn't is worse than no file.

use crate::compress::{channels, encode_jpeg, filters, int, unwrap_layers};
use crate::fonts::{self, FontMetrics};
use crate::redact::{self, apply, bounds, mul, Matrix, Rect, IDENTITY};
use crate::stray_pages::unlink;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::{HashMap, HashSet};

/// How deep Form XObjects may nest before we give up (real files rarely pass 3).
const MAX_DEPTH: usize = 16;

#[derive(Default)]
pub struct PageOutcome {
    pub removed_glyphs: usize,
    pub cleaned_images: usize,
    pub removed_annots: usize,
    pub skipped_fonts: Vec<String>,
    /// Reasons the page can't be redacted safely. Any of these stops the save.
    pub problems: Vec<String>,
    pub touched_mcids: Vec<i64>,
}

impl PageOutcome {
    pub fn changed(&self) -> bool {
        self.removed_glyphs + self.cleaned_images + self.removed_annots > 0
    }
}

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    match object {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(object),
        other => other,
    }
}

fn dict_at(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Dictionary> {
    match resolve(doc, dict.get(key).ok()?) {
        Object::Dictionary(d) => Some(d.clone()),
        _ => None,
    }
}

fn numbers(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Vec<f64>> {
    let items = resolve(doc, dict.get(key).ok()?).as_array().ok()?;
    items.iter().map(|o| resolve(doc, o).as_float().ok().map(f64::from)).collect()
}

fn name_of<'a>(dict: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dict.get(key).ok().and_then(|o| o.as_name().ok())
}

/// The resources a page uses, following inheritance up the page tree.
fn page_resources(doc: &Document, page: ObjectId) -> Dictionary {
    let mut at = Some(page);
    let mut seen = HashSet::new();
    while let Some(id) = at.filter(|id| seen.insert(*id)) {
        let Ok(node) = doc.get_dictionary(id) else { break };
        if let Some(res) = dict_at(doc, node, b"Resources") {
            return res;
        }
        at = node.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
    }
    Dictionary::new()
}

fn fonts_of(doc: &Document, resources: &Dictionary) -> HashMap<Vec<u8>, FontMetrics> {
    let Some(fonts) = dict_at(doc, resources, b"Font") else { return HashMap::new() };
    fonts
        .iter()
        .filter_map(|(name, value)| match resolve(doc, value) {
            Object::Dictionary(d) => Some((name.clone(), fonts::load(doc, d))),
            _ => None,
        })
        .collect()
}

fn decoded(stream: &Stream) -> Option<Vec<u8>> {
    if filters(&stream.dict).is_empty() {
        Some(stream.content.clone())
    } else {
        stream.decompressed_content().ok()
    }
}

/// Redacts one content stream and whatever it draws. Gives back the new
/// stream (when its own text changed) and new resources (when something it
/// draws had to be replaced).
fn redact_content(
    doc: &mut Document,
    data: &[u8],
    resources: &Dictionary,
    rects: &[Rect],
    ctm: Matrix,
    depth: usize,
    out: &mut PageOutcome,
) -> (Option<Vec<u8>>, Option<Dictionary>) {
    let fonts = fonts_of(doc, resources);
    let (rewritten, report) = redact::redact_stream(data, &fonts, rects, ctm);
    out.removed_glyphs += report.removed_glyphs;
    out.cleaned_images += report.removed_inline_images;
    for f in report.skipped_fonts {
        if !out.skipped_fonts.contains(&f) {
            out.skipped_fonts.push(f);
        }
    }
    for f in report.unsure_fonts {
        out.problems.push(format!("it has text in font {f} that InkLeaf can't take out"));
    }
    if depth == 0 {
        out.touched_mcids.extend(report.touched_mcids);
    }
    let own_changed = report.removed_glyphs + report.removed_inline_images > 0;

    // Each drawing that touches a box gets a cleaned copy under a new name,
    // used only by that one `Do`: the same picture may be drawn again
    // elsewhere on the page, away from any box, and must stay whole there.
    let original = dict_at(doc, resources, b"XObject");
    let mut xobjects = original.clone().unwrap_or_default();
    let mut renames: HashMap<usize, Vec<u8>> = HashMap::new();
    for (nth, (name, at)) in report.drawn.iter().enumerate() {
        let Some(Object::Reference(id)) = original.as_ref().and_then(|d| d.get(name).ok()).cloned() else { continue };
        let Ok(stream) = doc.get_object(id).and_then(Object::as_stream).cloned() else { continue };
        let replacement = match name_of(&stream.dict, b"Subtype") {
            Some(b"Form") => redact_form(doc, &stream, resources, rects, *at, depth, out),
            Some(b"Image") => clean_image(doc, &stream, rects, *at, out, true),
            _ => None,
        };
        if let Some(new_stream) = replacement {
            let mut fresh = name.clone();
            fresh.extend_from_slice(b"_r");
            let mut n = nth;
            while xobjects.has(&[fresh.as_slice(), n.to_string().as_bytes()].concat()) {
                n += 1000;
            }
            fresh.extend_from_slice(n.to_string().as_bytes());
            xobjects.set(fresh.clone(), Object::Reference(doc.add_object(new_stream)));
            renames.insert(nth, fresh);
        }
    }
    if renames.is_empty() {
        return (own_changed.then_some(rewritten), None);
    }
    // a name no longer drawn anywhere here comes off the list, or the
    // uncleaned original would stay in the file through it
    for (name, _) in &report.drawn {
        let still_used = report.drawn.iter().enumerate().any(|(nth, (n, _))| n == name && !renames.contains_key(&nth));
        if !still_used {
            xobjects.remove(name);
        }
    }
    let (rewritten, _) = redact::redact_stream_with(data, &fonts, rects, ctm, &renames);
    let mut new_resources = resources.clone();
    new_resources.set("XObject", xobjects);
    (Some(rewritten), Some(new_resources))
}
/// A Form XObject drawn at `at`: redacted into a fresh copy, since the same
/// form may also be drawn on pages that aren't being redacted.
fn redact_form(
    doc: &mut Document,
    stream: &Stream,
    parent_resources: &Dictionary,
    rects: &[Rect],
    at: Matrix,
    depth: usize,
    out: &mut PageOutcome,
) -> Option<Stream> {
    let matrix = numbers(doc, &stream.dict, b"Matrix")
        .filter(|m| m.len() == 6)
        .map(|m| [m[0], m[1], m[2], m[3], m[4], m[5]])
        .unwrap_or(IDENTITY);
    let ctm = mul(&matrix, &at);
    // a form that can't reach any box can be left alone
    if let Some(b) = numbers(doc, &stream.dict, b"BBox").filter(|b| b.len() == 4) {
        let area = bounds(&ctm, b[0], b[1], b[2], b[3]);
        if !rects.iter().any(|r| r.overlaps(area)) {
            return None;
        }
    }
    if depth >= MAX_DEPTH {
        out.problems.push("its content is nested too deeply to check".into());
        return None;
    }
    let Some(data) = decoded(stream) else {
        out.problems.push("part of its content is stored in a way InkLeaf can't read".into());
        return None;
    };
    let resources = dict_at(doc, &stream.dict, b"Resources").unwrap_or_else(|| parent_resources.clone());
    let (content, new_resources) = redact_content(doc, &data, &resources, rects, ctm, depth + 1, out);
    if content.is_none() && new_resources.is_none() {
        return None;
    }
    let mut dict = stream.dict.clone();
    dict.remove(b"Filter");
    dict.remove(b"DecodeParms");
    dict.remove(b"Length");
    if let Some(r) = new_resources {
        dict.set("Resources", r);
    }
    let mut fresh = Stream::new(dict, content.unwrap_or(data));
    let _ = fresh.compress();
    Some(fresh)
}

/// Colour components per pixel, for the colour spaces a picture can use.
fn components(doc: &Document, dict: &Dictionary) -> Option<usize> {
    if matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true))) {
        return Some(1);
    }
    if let Some(n) = channels(doc, dict) {
        return Some(n);
    }
    match resolve(doc, dict.get(b"ColorSpace").ok()?) {
        Object::Name(n) if n == b"DeviceCMYK" || n == b"CMYK" => Some(4),
        Object::Name(n) if n == b"DeviceRGB" || n == b"RGB" => Some(3),
        Object::Name(n) if n == b"DeviceGray" || n == b"G" => Some(1),
        Object::Array(a) => match a.first().and_then(|o| o.as_name().ok())? {
            b"Indexed" | b"I" | b"Separation" => Some(1),
            b"Lab" | b"CalRGB" => Some(3),
            b"CalGray" => Some(1),
            b"DeviceN" => Some(resolve(doc, a.get(1)?).as_array().ok()?.len()),
            b"ICCBased" => {
                let profile = resolve(doc, a.get(1)?).as_stream().ok()?;
                int(&profile.dict, b"N").map(|n| n as usize)
            }
            _ => None,
        },
        _ => None,
    }
}

fn invert(m: &Matrix) -> Option<Matrix> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return None;
    }
    Some([
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
    ])
}

/// Sets every pixel whose centre is under a box to zero. Which colour zero
/// is doesn't matter: the box is painted on top, and what was there is gone.
/// Returns how many pixels changed.
fn blank_pixels(pixels: &mut [u8], w: usize, h: usize, bits_per_pixel: usize, at: &Matrix, rects: &[Rect]) -> usize {
    let Some(back) = invert(at) else { return 0 };
    let row = (w * bits_per_pixel).div_ceil(8);
    let mut changed = 0;
    for r in rects {
        // the box in picture space, to only look at pixels near it
        let b = bounds(&back, r.x0, r.y0, r.x1, r.y1);
        let i0 = ((b[0] * w as f64).floor().max(0.0) as usize).min(w);
        let i1 = ((b[2] * w as f64).ceil().max(0.0) as usize).min(w);
        let j0 = (((1.0 - b[3]) * h as f64).floor().max(0.0) as usize).min(h);
        let j1 = (((1.0 - b[1]) * h as f64).ceil().max(0.0) as usize).min(h);
        for j in j0..j1 {
            let v = 1.0 - (j as f64 + 0.5) / h as f64;
            for i in i0..i1 {
                let (x, y) = apply(at, (i as f64 + 0.5) / w as f64, v);
                if !r.contains_point(x, y) {
                    continue;
                }
                let start = j * row * 8 + i * bits_per_pixel;
                for bit in start..start + bits_per_pixel {
                    pixels[bit / 8] &= !(0x80 >> (bit % 8));
                }
                changed += 1;
            }
        }
    }
    changed
}

/// A picture drawn at `at` that touches a box: a copy with the covered pixels
/// blanked. Its soft mask (transparency) is blanked too, as it holds the same
/// shapes.
fn clean_image(doc: &mut Document, stream: &Stream, rects: &[Rect], at: Matrix, out: &mut PageOutcome, with_mask: bool) -> Option<Stream> {
    let area = bounds(&at, 0.0, 0.0, 1.0, 1.0);
    if !rects.iter().any(|r| r.overlaps(area)) {
        return None;
    }
    let dict = &stream.dict;
    let fail = |out: &mut PageOutcome, why: &str| {
        out.problems.push(format!("a picture under a redaction box {why}"));
        None
    };
    let (Some(w), Some(h)) = (int(dict, b"Width"), int(dict, b"Height")) else {
        return fail(out, "has no size");
    };
    let (w, h) = (w.max(0) as usize, h.max(0) as usize);
    if w == 0 || h == 0 || w > 30000 || h > 30000 {
        return fail(out, "has a size InkLeaf can't handle");
    }
    let is_mask = matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true)));
    let bpc = if is_mask { 1 } else { int(dict, b"BitsPerComponent").unwrap_or(8) as usize };
    let Some(comps) = components(doc, dict) else {
        return fail(out, "uses colours InkLeaf can't edit");
    };
    if ![1, 2, 4, 8, 16].contains(&bpc) {
        return fail(out, "uses colours InkLeaf can't edit");
    }

    let fl = filters(dict);
    let (mut pixels, was_jpeg) = match fl.last().map(Vec::as_slice) {
        Some(b"DCTDecode") | Some(b"DCT") => {
            let Some(jpeg) = unwrap_layers(stream.content.clone(), &fl[..fl.len() - 1]) else {
                return fail(out, "couldn't be read");
            };
            let mut decoder = jpeg_decoder::Decoder::new(jpeg.as_slice());
            let Ok(pixels) = decoder.decode() else { return fail(out, "couldn't be read") };
            let Some(info) = decoder.info() else { return fail(out, "couldn't be read") };
            let got = match info.pixel_format {
                jpeg_decoder::PixelFormat::L8 => 1,
                jpeg_decoder::PixelFormat::RGB24 => 3,
                _ => return fail(out, "is a kind of JPEG InkLeaf can't edit"),
            };
            if got != comps || info.width as usize != w || info.height as usize != h {
                return fail(out, "is a kind of JPEG InkLeaf can't edit");
            }
            (pixels, true)
        }
        Some(b"CCITTFaxDecode") | Some(b"CCF") | Some(b"JBIG2Decode") | Some(b"JPXDecode") => {
            return fail(out, "is stored as fax, JBIG2 or JPEG 2000, which InkLeaf can't edit yet");
        }
        _ => match decoded(stream) {
            Some(p) => (p, false),
            None => return fail(out, "couldn't be read"),
        },
    };
    let bits_per_pixel = comps * bpc;
    if pixels.len() < (w * bits_per_pixel).div_ceil(8) * h {
        return fail(out, "is damaged");
    }
    let changed = blank_pixels(&mut pixels, w, h, bits_per_pixel, &at, rects);

    let mut new_dict = dict.clone();
    let mut mask_changed = false;
    if with_mask {
        if let Ok(Object::Reference(mask_id)) = dict.get(b"SMask") {
            let mask = doc.get_object(*mask_id).and_then(Object::as_stream).ok().cloned();
            if let Some(mask) = mask.and_then(|m| clean_image(doc, &m, rects, at, out, false)) {
                new_dict.set("SMask", Object::Reference(doc.add_object(mask)));
                mask_changed = true;
            }
        }
    }
    if changed == 0 && !mask_changed {
        return None;
    }
    if changed > 0 {
        out.cleaned_images += 1;
    }

    new_dict.remove(b"Length");
    new_dict.remove(b"DecodeParms");
    if was_jpeg {
        if let Some(jpeg) = encode_jpeg(&pixels, w, h, comps, 92) {
            new_dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            let mut fresh = Stream::new(new_dict, jpeg);
            fresh.allows_compression = false;
            return Some(fresh);
        }
    }
    new_dict.remove(b"Filter");
    let mut fresh = Stream::new(new_dict, pixels);
    let _ = fresh.compress();
    Some(fresh)
}

fn annot_rect(doc: &Document, annot: &Dictionary) -> Option<[f64; 4]> {
    let r = numbers(doc, annot, b"Rect").filter(|r| r.len() == 4)?;
    Some([r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])])
}

/// Removes comments, links and form fields that touch a box, with their
/// pop-ups and replies. A form field goes from the form as well, along with
/// any parent field left with no boxes.
fn remove_annotations(doc: &mut Document, page: ObjectId, rects: &[Rect], out: &mut PageOutcome) {
    let Some(annots) = doc.get_dictionary(page).ok().and_then(|p| p.get(b"Annots").ok()).cloned() else { return };
    let list = resolve(doc, &annots).as_array().cloned().unwrap_or_default();
    let mut gone: HashSet<ObjectId> = HashSet::new();
    let mut direct_hits = 0;
    let mut kept = Vec::new();
    for entry in &list {
        let hit = match resolve(doc, entry) {
            Object::Dictionary(d) => annot_rect(doc, d).is_some_and(|area| rects.iter().any(|r| r.overlaps(area))),
            _ => false,
        };
        match (entry, hit) {
            (Object::Reference(id), true) => {
                gone.insert(*id);
            }
            (_, true) => direct_hits += 1,
            (_, false) => kept.push(entry.clone()),
        }
    }
    if direct_hits > 0 || !gone.is_empty() {
        // the page keeps only what's clear of the boxes; written in place, as
        // the list itself may be shared
        if let Ok(p) = doc.get_object_mut(page).and_then(Object::as_dict_mut) {
            p.set("Annots", Object::Array(kept));
        }
    }
    out.removed_annots += direct_hits;
    if gone.is_empty() {
        return;
    }
    out.removed_annots += gone.len();

    // pop-ups and replies of what's going
    loop {
        let more: Vec<ObjectId> = doc
            .objects
            .iter()
            .filter(|(id, _)| !gone.contains(id))
            .filter_map(|(id, o)| {
                let d = o.as_dict().ok()?;
                let parent = d.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
                let reply_to = d.get(b"IRT").ok().and_then(|p| p.as_reference().ok());
                let popup_of_gone = name_of(d, b"Subtype") == Some(b"Popup") && parent.is_some_and(|p| gone.contains(&p));
                (popup_of_gone || reply_to.is_some_and(|r| gone.contains(&r))).then_some(*id)
            })
            .collect();
        if more.is_empty() {
            break;
        }
        gone.extend(more);
    }

    // cut them loose, then any form field left with no boxes, and so on up
    loop {
        for object in doc.objects.values_mut() {
            unlink(object, &gone, false);
        }
        let empty_fields: Vec<ObjectId> = doc
            .objects
            .iter()
            .filter(|(id, _)| !gone.contains(id))
            .filter_map(|(id, o)| {
                let d = o.as_dict().ok()?;
                let kids = d.get(b"Kids").ok()?.as_array().ok()?;
                (kids.is_empty() && (d.has(b"FT") || d.has(b"T"))).then_some(*id)
            })
            .collect();
        if empty_fields.is_empty() {
            break;
        }
        gone.extend(empty_fields);
    }
}

/// Tags around text that was cut lose their alt text and actual text.
fn strip_tag_text(doc: &mut Document, page: ObjectId, mcids: &[i64]) {
    if mcids.is_empty() {
        return;
    }
    let wanted: HashSet<i64> = mcids.iter().copied().collect();
    let holds = |k: &Object| -> bool {
        match k {
            Object::Integer(n) => wanted.contains(n),
            Object::Dictionary(d) => {
                d.get(b"MCID").ok().and_then(|m| m.as_i64().ok()).is_some_and(|n| wanted.contains(&n))
                    && d.get(b"Pg").ok().and_then(|p| p.as_reference().ok()).is_none_or(|p| p == page)
            }
            _ => false,
        }
    };
    let hits: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| {
            let d = o.as_dict().ok()?;
            if d.get(b"Pg").ok().and_then(|p| p.as_reference().ok()).is_some_and(|p| p != page) {
                return None;
            }
            let k = d.get(b"K").ok()?;
            let found = match k {
                Object::Array(items) => items.iter().any(holds),
                other => holds(other),
            };
            found.then_some(*id)
        })
        .collect();
    for id in hits {
        if let Ok(d) = doc.get_object_mut(id).and_then(Object::as_dict_mut) {
            d.remove(b"Alt");
            d.remove(b"ActualText");
            d.remove(b"E");
        }
    }
}

/// Redacts everything on one page under `rects`.
pub fn redact_page(doc: &mut Document, page: ObjectId, rects: &[Rect]) -> PageOutcome {
    let mut out = PageOutcome::default();
    let resources = page_resources(doc, page);
    let content = doc.get_page_content(page);
    let (new_content, new_resources) = redact_content(doc, &content, &resources, rects, IDENTITY, 0, &mut out);

    if let Some(bytes) = new_content {
        let mut stream = Stream::new(Dictionary::new(), bytes);
        let _ = stream.compress();
        let id = doc.add_object(stream);
        if let Ok(p) = doc.get_object_mut(page).and_then(Object::as_dict_mut) {
            p.set("Contents", Object::Reference(id));
        }
    }
    if let Some(res) = new_resources {
        // set on the page itself, so pages sharing the old resources keep them
        if let Ok(p) = doc.get_object_mut(page).and_then(Object::as_dict_mut) {
            p.set("Resources", res);
        }
    }
    remove_annotations(doc, page, rects, &mut out);
    let mcids = std::mem::take(&mut out.touched_mcids);
    strip_tag_text(doc, page, &mcids);
    if out.changed() {
        if let Ok(p) = doc.get_object_mut(page).and_then(Object::as_dict_mut) {
            // a little picture of the page as it was
            p.remove(b"Thumb");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// One page drawing the same form twice, once under the box and once
    /// below it, and a 10x10 grey picture half under the box.
    fn sample() -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
        let form = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 300.into(), 50.into()],
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } } },
            b"BT /F1 12 Tf 10 10 Td (SECRET) Tj ET".to_vec(),
        ));
        let image = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 10, "Height" => 10,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
            vec![200u8; 100],
        ));
        let content = doc.add_object(Stream::new(
            dictionary! {},
            b"q 1 0 0 1 0 700 cm /Fm Do Q q 1 0 0 1 0 100 cm /Fm Do Q q 100 0 0 100 250 400 cm /Im Do Q".to_vec(),
        ));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content,
            "Resources" => dictionary! { "XObject" => dictionary! { "Fm" => form, "Im" => image } },
        });
        doc.objects.insert(pages_id, dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }.into());
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        (doc, page)
    }

    fn texts(doc: &Document) -> String {
        let mut all = String::new();
        for o in doc.objects.values() {
            if let Ok(s) = o.as_stream() {
                all.push_str(&String::from_utf8_lossy(&decoded(s).unwrap_or_default()));
            }
        }
        all
    }

    #[test]
    fn a_form_is_cleaned_only_where_it_sits_under_the_box() {
        let (mut doc, page) = sample();
        let boxes = [Rect { x0: 0.0, y0: 690.0, x1: 400.0, y1: 760.0 }];
        let out = redact_page(&mut doc, page, &boxes);
        assert_eq!(out.removed_glyphs, 6);
        assert!(out.problems.is_empty());
        doc.prune_objects();
        // the copy below the box still says it, once; the one under the box doesn't
        assert_eq!(texts(&doc).matches("(SECRET)").count(), 1);
        let content = String::from_utf8(doc.get_page_content(page)).unwrap();
        assert!(content.contains("/Fm_r0 Do") && content.contains("/Fm Do"), "{content}");
    }

    #[test]
    fn a_picture_loses_only_the_pixels_under_the_box() {
        let (mut doc, page) = sample();
        // the picture spans x 250-350; the box takes its left half
        let boxes = [Rect { x0: 200.0, y0: 380.0, x1: 300.0, y1: 520.0 }];
        let out = redact_page(&mut doc, page, &boxes);
        assert_eq!(out.cleaned_images, 1);
        let res = page_resources(&doc, page);
        let xobjects = dict_at(&doc, &res, b"XObject").unwrap();
        assert!(!xobjects.has(b"Im"), "the uncleaned picture is off the page");
        let cleaned = doc.get_object(xobjects.get(b"Im_r2").unwrap().as_reference().unwrap()).unwrap().as_stream().unwrap();
        let pixels = decoded(cleaned).unwrap();
        for row in pixels.chunks(10) {
            assert_eq!(row, &[0, 0, 0, 0, 0, 200, 200, 200, 200, 200]);
        }
    }

    #[test]
    fn text_in_a_font_that_cant_be_measured_stops_the_redaction() {
        let (mut doc, page) = sample();
        let content = doc.add_object(Stream::new(dictionary! {}, b"BT /Missing 12 Tf 50 720 Td (SECRET) Tj ET".to_vec()));
        doc.get_object_mut(page).unwrap().as_dict_mut().unwrap().set("Contents", content);
        let near = redact_page(&mut doc, page, &[Rect { x0: 0.0, y0: 700.0, x1: 200.0, y1: 740.0 }]);
        assert_eq!(near.problems.len(), 1);
        let far = redact_page(&mut doc, page, &[Rect { x0: 0.0, y0: 0.0, x1: 200.0, y1: 40.0 }]);
        assert!(far.problems.is_empty());
    }
}
