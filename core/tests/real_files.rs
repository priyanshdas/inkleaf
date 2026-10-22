// SPDX-License-Identifier: GPL-3.0-or-later
//! Runs the core against the PDFs in tests/fixtures (made by
//! tests/make_fixtures.py). Skips quietly if they haven't been generated.

use inkleaf_core::compress::Level;
use inkleaf_core::{compress_pdf, decrypt, finalize, font_file, inspect, protect, redact, FontRequest, ProtectRequest, RedactJob};
use std::path::PathBuf;

fn fixture(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
    std::fs::read(path).ok()
}

/// Rough check for a string in a PDF: decompress every stream and search,
/// both as plain text and as the hex form the redactor writes kept glyphs in.
fn contains_text(pdf: &[u8], needle: &str) -> bool {
    let hex: String = needle.bytes().map(|b| format!("{b:02X}")).collect();
    let doc = lopdf::Document::load_mem(pdf).unwrap();
    doc.objects.values().any(|obj| match obj {
        lopdf::Object::Stream(s) => {
            let data = s.decompressed_content().unwrap_or_else(|_| s.content.clone());
            let text = String::from_utf8_lossy(&data);
            text.contains(needle) || text.contains(&hex)
        }
        lopdf::Object::String(bytes, _) => String::from_utf8_lossy(bytes).contains(needle),
        _ => false,
    })
}

#[test]
fn redacts_standard_font_text_and_keeps_the_rest() {
    let Some(pdf) = fixture("sample.pdf") else { return };
    // "INV-2041" on the first line, Helvetica 14 at y = 760
    let jobs: Vec<RedactJob> = serde_json::from_str(
        r#"[{"page":0,"rects":[{"x0":175,"y0":757,"x1":235,"y1":770}]}]"#,
    )
    .unwrap();
    let (out, report) = redact(&pdf, &jobs).unwrap();
    assert_eq!(report.removed_glyphs, 8, "{:?}", report.warnings);
    assert!(contains_text(&pdf, "INV-2041"));
    assert!(!contains_text(&out, "INV-2041"));
    // neighbouring words survive
    assert!(contains_text(&out, "Hotel Aurora"));
}

#[test]
fn unlocks_owner_and_user_passwords() {
    let (Some(owner), Some(user)) = (fixture("owner-locked.pdf"), fixture("password.pdf")) else { return };

    let info = inspect(&owner).unwrap();
    assert!(info.encrypted && info.opens_without_password);
    let unlocked = decrypt(&owner, "").unwrap();
    assert!(!inspect(&unlocked).unwrap().encrypted);

    let info = inspect(&user).unwrap();
    assert!(info.encrypted && !info.opens_without_password);
    assert!(decrypt(&user, "nope").is_err());
    let unlocked = decrypt(&user, "open-sesame").unwrap();
    assert_eq!(inspect(&unlocked).unwrap().page_count, 3);
}

#[test]
fn finalize_keeps_a_valid_document() {
    let Some(pdf) = fixture("form.pdf") else { return };
    let out = finalize(&pdf).unwrap();
    assert_eq!(inspect(&out).unwrap().page_count, 1);
}

#[test]
fn finds_embedded_truetype_fonts() {
    let Some(pdf) = fixture("sample.pdf") else { return };
    // the "Guest:" line is set in an embedded DejaVu subset
    let fonts = lopdf::Document::load_mem(&pdf).unwrap();
    let page = *fonts.get_pages().values().next().unwrap();
    let name = fonts
        .get_page_fonts(page)
        .unwrap()
        .values()
        .filter_map(|f| f.get(b"BaseFont").ok()?.as_name().ok().map(|n| String::from_utf8_lossy(n).into_owned()))
        .find(|n| n.contains("DejaVu"))
        .expect("fixture should embed DejaVu");
    let (data, info) = font_file(&pdf, &FontRequest { page: 0, name }).unwrap();
    assert_eq!(info.kind, "truetype");
    assert!(data.len() > 1000);
    // a standard font isn't embedded, so there's nothing to hand back
    assert!(font_file(&pdf, &FontRequest { page: 0, name: "Helvetica".into() }).is_err());
}

#[test]
fn compress_shrinks_photos_and_merges_copies() {
    let Some(pdf) = fixture("photo.pdf") else { return };
    let (out, report) = compress_pdf(&pdf, Level::Balanced).unwrap();
    assert!(report.images_shrunk >= 1, "{report:?}");
    assert!(report.duplicates_merged >= 1, "{report:?}");
    assert!(out.len() * 4 < pdf.len(), "only went from {} to {}", pdf.len(), out.len());
    let doc = lopdf::Document::load_mem(&out).unwrap();
    assert_eq!(doc.get_pages().len(), 2);
    assert!(contains_text(&out, "Holiday photo"));
    // and it never grows a file that's already tight
    let Some(small) = fixture("sample.pdf") else { return };
    let (out, _) = compress_pdf(&small, Level::Strong).unwrap();
    assert!(out.len() <= small.len());
}

#[test]
fn protect_needs_the_password_to_open() {
    let Some(pdf) = fixture("sample.pdf") else { return };
    let request = ProtectRequest {
        user_password: "s3cret pass".into(),
        owner_password: String::new(),
        allow_print: true,
        allow_copy: false,
        allow_edit: false,
    };
    let out = protect(&pdf, &request, &[9u8; 32]).unwrap();
    let info = inspect(&out).unwrap();
    assert!(info.encrypted && !info.opens_without_password);
    assert!(decrypt(&out, "wrong").is_err());
    let plain = decrypt(&out, "s3cret pass").unwrap();
    assert!(contains_text(&plain, "Invoice number"));
}
