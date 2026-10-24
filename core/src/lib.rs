// SPDX-License-Identifier: GPL-3.0-or-later
//! Inkleaf's PDF core. Compiled to WebAssembly and driven from the app's
//! TypeScript side, but every function here is plain Rust and testable natively.
//!
//! The wasm interface is intentionally tiny: the host copies bytes into memory
//! we allocate, calls one of the `ik_*` entry points, then reads the result
//! (and a JSON side-channel for reports and errors) back out.

mod base14;
pub mod compress;
pub mod fonts;
pub mod lexer;
pub mod redact;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, LoadOptions, Object, ObjectId, Permissions, SaveOptions, Stream};
use std::sync::Arc;
use redact::Rect;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::{BTreeMap, HashMap};

pub type CoreResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub encrypted: bool,
    /// True when the file opens with an empty user password (owner-only
    /// protection, the common "you can view but not edit" kind).
    pub opens_without_password: bool,
    pub page_count: usize,
}

fn load(bytes: &[u8], password: Option<&str>) -> CoreResult<Document> {
    let options = LoadOptions { password: password.map(str::to_string), ..Default::default() };
    Document::load_mem_with_options(bytes, options).map_err(|e| format!("Couldn't read this PDF: {e}"))
}

fn save(doc: &mut Document) -> CoreResult<Vec<u8>> {
    let mut out = Vec::new();
    let options = SaveOptions::builder().use_object_streams(true).use_xref_streams(true).build();
    doc.save_with_options(&mut out, options)
        .map_err(|e| format!("Couldn't write the PDF: {e}"))?;
    Ok(out)
}

fn looks_encrypted(bytes: &[u8]) -> bool {
    // lopdf strips /Encrypt from the trailer as it decrypts, so to tell a
    // protected file apart we peek at the raw bytes for the trailer key.
    bytes.windows(8).any(|w| w == b"/Encrypt")
}

pub fn inspect(bytes: &[u8]) -> CoreResult<Inspection> {
    let encrypted = looks_encrypted(bytes);
    match load(bytes, None) {
        Ok(doc) => {
            let still_locked = doc.is_encrypted();
            Ok(Inspection {
                encrypted: encrypted || doc.was_encrypted(),
                opens_without_password: !still_locked && !doc.get_pages().is_empty(),
                page_count: doc.get_pages().len(),
            })
        }
        Err(_) if encrypted => Ok(Inspection { encrypted: true, opens_without_password: false, page_count: 0 }),
        Err(e) => Err(e),
    }
}

/// Returns an unprotected copy of the document. Works for owner-password
/// files with an empty password, or with the user's password when given.
pub fn decrypt(bytes: &[u8], password: &str) -> CoreResult<Vec<u8>> {
    let pw = if password.is_empty() { None } else { Some(password) };
    let mut doc = load(bytes, pw)?;
    if doc.is_encrypted() {
        // older lopdf paths leave the dict in place; try the explicit route
        doc.decrypt(password).map_err(|_| "That password didn't unlock the file.".to_string())?;
    }
    if doc.get_pages().is_empty() {
        return Err("That password didn't unlock the file.".into());
    }
    doc.encryption_state = None;
    doc.trailer.remove(b"Encrypt");
    save(&mut doc)
}

#[derive(Deserialize)]
pub struct RedactJob {
    /// Zero-based page index.
    pub page: usize,
    pub rects: Vec<Rect>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RedactReport {
    pub removed_glyphs: usize,
    pub pages_changed: Vec<usize>,
    pub warnings: Vec<String>,
}

pub fn redact(bytes: &[u8], jobs: &[RedactJob]) -> CoreResult<(Vec<u8>, RedactReport)> {
    let mut doc = load(bytes, None)?;
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let mut report = RedactReport::default();

    // Merge jobs per page so each content stream is rewritten once.
    let mut by_page: BTreeMap<usize, Vec<Rect>> = BTreeMap::new();
    for job in jobs {
        by_page.entry(job.page).or_default().extend(job.rects.iter().copied());
    }

    for (page_index, rects) in by_page {
        let Some(&page_id) = pages.get(page_index) else {
            report.warnings.push(format!("Page {} doesn't exist", page_index + 1));
            continue;
        };

        let fonts: HashMap<Vec<u8>, fonts::FontMetrics> = doc
            .get_page_fonts(page_id)
            .map(|map| map.into_iter().map(|(name, dict)| (name, fonts::load(&doc, dict))).collect())
            .unwrap_or_default();

        let content = doc.get_page_content(page_id);
        let (rewritten, stream_report) = redact::redact_stream(&content, &fonts, &rects, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

        for font in stream_report.skipped_fonts {
            report.warnings.push(format!(
                "Page {}: text in font {} couldn't be removed, only covered",
                page_index + 1,
                font
            ));
        }
        if stream_report.removed_glyphs == 0 {
            continue;
        }

        report.removed_glyphs += stream_report.removed_glyphs;
        report.pages_changed.push(page_index);

        let mut stream = Stream::new(lopdf::Dictionary::new(), rewritten);
        let _ = stream.compress();
        let stream_id = doc.add_object(stream);
        if let Ok(page) = doc.get_object_mut(page_id).and_then(Object::as_dict_mut) {
            page.set("Contents", Object::Reference(stream_id));
        }
    }

    // The old content streams are now orphaned. Dropping them is the whole
    // point: otherwise the removed text would still be sitting in the file.
    doc.prune_objects();
    let bytes = save(&mut doc)?;
    Ok((bytes, report))
}

/// Rebuilds a damaged file: reads whatever objects can be found (lopdf
/// rebuilds a broken cross-reference table by scanning the file), drops
/// anything unreachable, numbers the rest afresh and writes a clean copy.
pub fn repair(bytes: &[u8]) -> CoreResult<(Vec<u8>, usize)> {
    let mut doc = load(bytes, None)?;
    let pages = doc.get_pages().len();
    if pages == 0 {
        return Err("No pages could be recovered from this file.".into());
    }
    doc.prune_objects();
    doc.renumber_objects();
    Ok((save(&mut doc)?, pages))
}

/// Last pass before writing to disk: throw away anything no longer reachable
/// from the document (deleted pages, replaced streams, old revisions).
pub fn finalize(bytes: &[u8]) -> CoreResult<Vec<u8>> {
    let mut doc = load(bytes, None)?;
    doc.prune_objects();
    save(&mut doc)
}

// --- compress & protect ---------------------------------------------------------

pub fn compress_pdf(bytes: &[u8], level: compress::Level) -> CoreResult<(Vec<u8>, compress::CompressReport)> {
    let mut doc = load(bytes, None)?;
    if doc.is_encrypted() {
        return Err("Unlock this PDF before compressing it.".into());
    }
    let mut report = compress::compress(&mut doc, level);
    let out = save(&mut doc)?;
    report.before = bytes.len();
    // never hand back something bigger than what came in
    if out.len() >= bytes.len() {
        report.after = bytes.len();
        return Ok((bytes.to_vec(), report));
    }
    report.after = out.len();
    Ok((out, report))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectRequest {
    /// Needed to open the file. May be empty for "restrict editing only".
    pub user_password: String,
    /// Needed to change the restrictions. Random when empty.
    pub owner_password: String,
    pub allow_print: bool,
    pub allow_copy: bool,
    pub allow_edit: bool,
}

/// Encrypts with AES-256 (PDF 2.0, the strongest standard PDF encryption).
/// `seed` is 32 random bytes from the host: the file key comes from it.
pub fn protect(bytes: &[u8], request: &ProtectRequest, seed: &[u8; 32]) -> CoreResult<Vec<u8>> {
    let mut doc = load(bytes, None)?;
    if doc.is_encrypted() {
        return Err("This PDF is still locked. Open it with its password first.".into());
    }
    doc.encryption_state = None;
    doc.trailer.remove(b"Encrypt");

    let mut permissions = Permissions::COPYABLE_FOR_ACCESSIBILITY;
    if request.allow_print {
        permissions |= Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY;
    }
    if request.allow_copy {
        permissions |= Permissions::COPYABLE;
    }
    if request.allow_edit {
        permissions |= Permissions::MODIFIABLE | Permissions::ANNOTABLE | Permissions::FILLABLE | Permissions::ASSEMBLABLE;
    }

    // derive the file key and a fallback owner password from the seed
    let file_key: [u8; 32] = sha2::Sha256::digest([seed.as_slice(), b"file-key"].concat()).into();
    let owner = if request.owner_password.is_empty() {
        sha2::Sha256::digest([seed.as_slice(), b"owner"].concat()).iter().map(|b| format!("{b:02x}")).collect::<String>()
    } else {
        request.owner_password.clone()
    };

    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &file_key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner,
        user_password: &request.user_password,
        permissions,
    };
    let state = EncryptionState::try_from(version).map_err(|e| format!("Couldn't set up encryption: {e}"))?;
    doc.encrypt(&state).map_err(|e| format!("Couldn't encrypt the PDF: {e}"))?;

    // classic cross-reference table: object streams would hide objects from
    // the per-object encryption some readers expect
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("Couldn't write the PDF: {e}"))?;
    Ok(out)
}

// --- randomness for wasm ------------------------------------------------------------
// lopdf draws random IVs while encrypting. The wasm build has no system
// randomness, so the host seeds us with bytes from crypto.getRandomValues
// and we stretch them with SHA-256 in counter mode.

#[cfg(target_arch = "wasm32")]
mod wasm_random {
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;

    thread_local! {
        static STATE: RefCell<([u8; 32], u64)> = const { RefCell::new(([0; 32], 0)) };
    }

    pub fn seed(bytes: &[u8]) {
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        STATE.with(|s| *s.borrow_mut() = (digest, 0));
    }

    #[no_mangle]
    unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), getrandom::Error> {
        let out = std::slice::from_raw_parts_mut(dest, len);
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            for chunk in out.chunks_mut(32) {
                let mut h = Sha256::new();
                h.update(s.0);
                h.update(s.1.to_le_bytes());
                s.1 += 1;
                let block: [u8; 32] = h.finalize().into();
                chunk.copy_from_slice(&block[..chunk.len()]);
            }
        });
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct FontRequest {
    /// Zero-based page index.
    pub page: usize,
    /// The font's PostScript name as pdf.js reports it, with or without the
    /// six-letter subset prefix ("ABCDEF+Calibri").
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    /// "truetype" (FontFile2) or "opentype" (FontFile3 /OpenType).
    pub kind: String,
    pub base_font: String,
}

fn strip_subset(name: &str) -> &str {
    match name.split_once('+') {
        Some((prefix, rest)) if prefix.len() == 6 && prefix.bytes().all(|b| b.is_ascii_uppercase()) => rest,
        _ => name,
    }
}

/// Finds the font file embedded for a font used on a page, so edited text can
/// be written in the document's own typeface. Only TrueType and OpenType
/// programs are returned; bare CFF and Type 1 can't be re-embedded as they are.
pub fn font_file(bytes: &[u8], request: &FontRequest) -> CoreResult<(Vec<u8>, FontInfo)> {
    let doc = load(bytes, None)?;
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let page_id = *pages.get(request.page).ok_or("No such page")?;
    let wanted = strip_subset(&request.name).to_string();

    let deref = |o: &Object| -> Option<Object> {
        match o {
            Object::Reference(id) => doc.get_object(*id).ok().cloned(),
            other => Some(other.clone()),
        }
    };

    let fonts = doc.get_page_fonts(page_id).map_err(|e| format!("Couldn't read the page's fonts: {e}"))?;
    for font in fonts.values() {
        let base = font
            .get(b"BaseFont")
            .ok()
            .and_then(|o| o.as_name().ok())
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .unwrap_or_default();
        if strip_subset(&base) != wanted {
            continue;
        }

        // simple fonts carry the descriptor; Type0 fonts keep it on the descendant
        let mut descriptor = font.get(b"FontDescriptor").ok().and_then(&deref);
        if descriptor.is_none() {
            if let Some(Object::Array(kids)) = font.get(b"DescendantFonts").ok().and_then(&deref) {
                if let Some(Object::Dictionary(cid)) = kids.first().and_then(&deref) {
                    descriptor = cid.get(b"FontDescriptor").ok().and_then(&deref);
                }
            }
        }
        let Some(Object::Dictionary(descriptor)) = descriptor else { continue };

        let (stream, kind) = if let Ok(Object::Reference(id)) = descriptor.get(b"FontFile2") {
            (doc.get_object(*id).ok().and_then(|o| o.as_stream().ok()), "truetype")
        } else if let Ok(Object::Reference(id)) = descriptor.get(b"FontFile3") {
            let stream = doc.get_object(*id).ok().and_then(|o| o.as_stream().ok());
            let subtype = stream
                .and_then(|s| s.dict.get(b"Subtype").ok())
                .and_then(|o| o.as_name().ok())
                .map(|n| n.to_vec())
                .unwrap_or_default();
            if subtype != b"OpenType" {
                continue;
            }
            (stream, "opentype")
        } else {
            continue;
        };
        let Some(stream) = stream else { continue };
        let data = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
        return Ok((data, FontInfo { kind: kind.into(), base_font: base }));
    }
    Err("The font isn't embedded in a form Inkleaf can reuse".into())
}

// ---------------------------------------------------------------------------
// WebAssembly interface
// ---------------------------------------------------------------------------

use std::cell::RefCell;

thread_local! {
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static INFO: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_output(bytes: Vec<u8>) {
    OUTPUT.with(|o| *o.borrow_mut() = bytes);
}

fn set_info(json: String) {
    INFO.with(|i| *i.borrow_mut() = json.into_bytes());
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Reserves `len` bytes for the host to write into.
#[no_mangle]
pub extern "C" fn ik_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `ik_alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn ik_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn ik_output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn ik_output_len() -> usize {
    OUTPUT.with(|o| o.borrow().len())
}

#[no_mangle]
pub extern "C" fn ik_info_ptr() -> *const u8 {
    INFO.with(|i| i.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn ik_info_len() -> usize {
    INFO.with(|i| i.borrow().len())
}

/// Frees the last result once the host has copied it out.
#[no_mangle]
pub extern "C" fn ik_clear() {
    set_output(Vec::new());
    set_info(String::new());
}

fn finish(result: CoreResult<(Vec<u8>, String)>) -> i32 {
    match result {
        Ok((bytes, info)) => {
            set_output(bytes);
            set_info(info);
            0
        }
        Err(message) => {
            set_output(Vec::new());
            set_info(serde_json::json!({ "error": message }).to_string());
            1
        }
    }
}

/// # Safety
/// The pointer/length pair must describe a readable region of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_inspect(pdf: *const u8, pdf_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    finish(inspect(bytes).map(|i| (Vec::new(), serde_json::to_string(&i).unwrap())))
}

/// # Safety
/// Both pointer/length pairs must describe readable regions of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_decrypt(pdf: *const u8, pdf_len: usize, pw: *const u8, pw_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    let password = String::from_utf8_lossy(slice(pw, pw_len)).into_owned();
    finish(decrypt(bytes, &password).map(|out| (out, "{}".into())))
}

/// `jobs` is JSON: `[{"page": 0, "rects": [{"x0":..,"y0":..,"x1":..,"y1":..}]}]`
///
/// # Safety
/// Both pointer/length pairs must describe readable regions of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_redact(pdf: *const u8, pdf_len: usize, jobs: *const u8, jobs_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    let result = serde_json::from_slice::<Vec<RedactJob>>(slice(jobs, jobs_len))
        .map_err(|e| format!("Bad redaction request: {e}"))
        .and_then(|jobs| redact(bytes, &jobs))
        .map(|(out, report)| (out, serde_json::to_string(&report).unwrap()));
    finish(result)
}

/// # Safety
/// The pointer/length pair must describe a readable region of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_finalize(pdf: *const u8, pdf_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    finish(finalize(bytes).map(|out| (out, "{}".into())))
}

/// `request` is JSON: `{"page": 0, "name": "ABCDEF+Calibri"}`
///
/// # Safety
/// Both pointer/length pairs must describe readable regions of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_font_file(pdf: *const u8, pdf_len: usize, req: *const u8, req_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    let result = serde_json::from_slice::<FontRequest>(slice(req, req_len))
        .map_err(|e| format!("Bad font request: {e}"))
        .and_then(|r| font_file(bytes, &r))
        .map(|(data, info)| (data, serde_json::to_string(&info).unwrap()));
    finish(result)
}

/// `level` is "light", "balanced" or "strong".
///
/// # Safety
/// Both pointer/length pairs must describe readable regions of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_compress(pdf: *const u8, pdf_len: usize, level: *const u8, level_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    let result = serde_json::from_slice::<compress::Level>(slice(level, level_len))
        .map_err(|e| format!("Bad compression level: {e}"))
        .and_then(|level| compress_pdf(bytes, level))
        .map(|(out, report)| (out, serde_json::to_string(&report).unwrap()));
    finish(result)
}

/// `request` is JSON (see ProtectRequest) plus a 64-character hex "seed".
///
/// # Safety
/// Both pointer/length pairs must describe readable regions of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_protect(pdf: *const u8, pdf_len: usize, req: *const u8, req_len: usize) -> i32 {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(flatten)]
        request: ProtectRequest,
        seed: String,
    }
    let bytes = slice(pdf, pdf_len);
    let result = serde_json::from_slice::<Wire>(slice(req, req_len))
        .map_err(|e| format!("Bad protect request: {e}"))
        .and_then(|wire| {
            let raw: Vec<u8> = (0..wire.seed.len() / 2)
                .filter_map(|i| u8::from_str_radix(&wire.seed[i * 2..i * 2 + 2], 16).ok())
                .collect();
            let seed: [u8; 32] = raw.try_into().map_err(|_| "The random seed must be 32 bytes".to_string())?;
            #[cfg(target_arch = "wasm32")]
            wasm_random::seed(&seed);
            protect(bytes, &wire.request, &seed)
        })
        .map(|out| (out, "{}".into()));
    finish(result)
}

/// # Safety
/// The pointer/length pair must describe a readable region of wasm memory.
#[no_mangle]
pub unsafe extern "C" fn ik_repair(pdf: *const u8, pdf_len: usize) -> i32 {
    let bytes = slice(pdf, pdf_len);
    finish(repair(bytes).map(|(out, pages)| (out, format!("{{\"pages\":{pages}}}"))))
}
