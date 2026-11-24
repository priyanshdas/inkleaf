// SPDX-License-Identifier: GPL-3.0-or-later
//! Making sure a saved PDF holds only the pages it shows.
//!
//! When pages are deleted, extracted or split off, the pages left out are
//! dropped from the page tree. But other parts of the file can still point
//! at them: a link on a kept page, a bookmark, a form field with a box on a
//! dropped page, a comment that names its page, the accessibility tags. Any
//! of those keeps the dropped page, and its text, inside the file, where a
//! viewer won't show it but anyone can dig it out.
//!
//! So every page outside the page tree, and everything that belongs to one
//! (its comments, form boxes and tags), is cut loose: references to them are
//! removed (in a link or a bookmark, the destination is blanked instead, so
//! the rest stays valid), unreachable objects are deleted, and finally the
//! file is checked. If a page outside the tree is still there, the clean-up
//! fails rather than hand back a file that might leak.

use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::HashSet;

fn type_of(dict: &Dictionary) -> Option<&[u8]> {
    dict.get(b"Type").ok().and_then(|t| t.as_name().ok())
}

fn dict_of(object: &Object) -> Option<&Dictionary> {
    match object {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

fn reference(object: Option<&Object>) -> Option<ObjectId> {
    match object {
        Some(Object::Reference(id)) => Some(*id),
        _ => None,
    }
}

/// The page tree's nodes and its pages, walked from the catalog.
fn page_tree(doc: &Document) -> (HashSet<ObjectId>, HashSet<ObjectId>) {
    let mut nodes = HashSet::new();
    let pages: HashSet<ObjectId> = doc.get_pages().values().copied().collect();
    let root = doc.catalog().ok().and_then(|c| reference(c.get(b"Pages").ok()));
    let mut todo: Vec<ObjectId> = root.into_iter().collect();
    while let Some(id) = todo.pop() {
        if !nodes.insert(id) {
            continue;
        }
        if let Some(kids) = doc.get_object(id).ok().and_then(dict_of).and_then(|d| d.get(b"Kids").ok()).and_then(|k| k.as_array().ok()) {
            todo.extend(kids.iter().filter_map(|k| reference(Some(k))));
        }
    }
    (nodes, pages)
}

/// Fit types that can follow a page in a destination array.
const FITS: &[&[u8]] = &[b"XYZ", b"Fit", b"FitH", b"FitV", b"FitR", b"FitB", b"FitBH", b"FitBV"];

/// Removes references to `gone` from inside one object. `keep_places` is set
/// for arrays where position carries meaning (number and name trees), where a
/// reference is blanked rather than removed.
pub(crate) fn unlink(object: &mut Object, gone: &HashSet<ObjectId>, keep_places: bool) {
    match object {
        Object::Dictionary(dict) => unlink_dict(dict, gone),
        Object::Stream(stream) => unlink_dict(&mut stream.dict, gone),
        Object::Array(items) => {
            let is_destination = items.len() >= 2 && items[1].as_name().is_ok_and(|n| FITS.contains(&n));
            let mut i = 0;
            while i < items.len() {
                let hit = matches!(&items[i], Object::Reference(id) if gone.contains(id));
                if hit {
                    if keep_places || (is_destination && i == 0) {
                        items[i] = Object::Null;
                    } else {
                        items.remove(i);
                        continue;
                    }
                } else {
                    unlink(&mut items[i], gone, false);
                }
                i += 1;
            }
        }
        _ => {}
    }
}

fn unlink_dict(dict: &mut Dictionary, gone: &HashSet<ObjectId>) {
    let dead: Vec<Vec<u8>> = dict
        .iter()
        .filter(|(_, v)| matches!(v, Object::Reference(id) if gone.contains(id)))
        .map(|(k, _)| k.clone())
        .collect();
    for key in dead {
        dict.remove(&key);
    }
    for (key, value) in dict.iter_mut() {
        let keep_places = key.as_slice() == b"Nums" || key.as_slice() == b"Names";
        unlink(value, gone, keep_places);
    }
}

/// Cuts every page outside the page tree loose and deletes it, with whatever belonged to it.
pub fn remove_stray_pages(doc: &mut Document) -> Result<(), String> {
    let (nodes, kept) = page_tree(doc);
    if kept.is_empty() {
        return Err("The PDF has no pages.".into());
    }

    // what must stay: the tree itself, and the comments and boxes on its pages
    let mut protected: HashSet<ObjectId> = nodes.iter().chain(kept.iter()).copied().collect();
    for page in &kept {
        if let Some(annots) = doc.get_object(*page).ok().and_then(dict_of).and_then(|d| d.get(b"Annots").ok()) {
            let list = match annots {
                Object::Array(a) => a.clone(),
                Object::Reference(id) => {
                    protected.insert(*id);
                    doc.get_object(*id).ok().and_then(|o| o.as_array().ok()).cloned().unwrap_or_default()
                }
                _ => Vec::new(),
            };
            protected.extend(list.iter().filter_map(|a| reference(Some(a))));
        }
    }

    // the pages and page-tree nodes that aren't in the tree
    let mut gone: HashSet<ObjectId> = doc
        .objects
        .iter()
        .filter(|(id, o)| !protected.contains(id) && dict_of(o).and_then(type_of).is_some_and(|t| t == b"Page" || t == b"Pages"))
        .map(|(id, _)| *id)
        .collect();
    if gone.is_empty() {
        return Ok(());
    }

    // and what belongs to them: their comments and form boxes, and tags that
    // name them as their page (repeated, as tags hang off other tags)
    loop {
        let mut more = Vec::new();
        for (id, object) in &doc.objects {
            if gone.contains(id) || protected.contains(id) {
                continue;
            }
            let Some(dict) = dict_of(object) else { continue };
            let owner = reference(dict.get(b"P").ok()).or_else(|| reference(dict.get(b"Pg").ok()));
            if owner.is_some_and(|o| gone.contains(&o)) {
                more.push(*id);
            }
        }
        for page in gone.clone() {
            if let Some(Object::Array(annots)) = doc.get_object(page).ok().and_then(dict_of).and_then(|d| d.get(b"Annots").ok()) {
                more.extend(annots.iter().filter_map(|a| reference(Some(a))).filter(|a| !protected.contains(a) && !gone.contains(a)));
            }
        }
        if more.is_empty() {
            break;
        }
        gone.extend(more);
    }

    // cut every link to them, then let go of everything no longer reachable
    for object in doc.objects.values_mut() {
        unlink(object, &gone, false);
    }
    unlink_dict(&mut doc.trailer, &gone);
    doc.prune_objects();

    // check: nothing that's a page may be left outside the tree
    let (_, kept_after) = page_tree(doc);
    let stray = doc
        .objects
        .iter()
        .any(|(id, o)| !kept_after.contains(id) && dict_of(o).and_then(type_of).is_some_and(|t| t == b"Page"));
    if stray {
        return Err("Some content from removed pages couldn't be taken out of the file.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    /// Three pages; page three is dropped from the tree but a link on page one
    /// and a bookmark still point at it, and a link to page two must survive.
    fn sample() -> (Document, ObjectId, ObjectId, ObjectId) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page = |doc: &mut Document, text: &str| {
            let content = doc.add_object(Stream::new(dictionary! {}, format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET").into_bytes()));
            doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => content })
        };
        let p1 = page(&mut doc, "public one");
        let p2 = page(&mut doc, "public two");
        let p3 = page(&mut doc, "TOP SECRET");
        let to_p2 = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Link", "Dest" => vec![p2.into(), "Fit".into()] });
        let to_p3 = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Link", "Dest" => vec![p3.into(), "Fit".into()] });
        doc.get_object_mut(p1).unwrap().as_dict_mut().unwrap().set("Annots", vec![to_p2.into(), to_p3.into()]);
        // page three is no longer in the tree
        doc.objects.insert(pages_id, dictionary! { "Type" => "Pages", "Kids" => vec![p1.into(), p2.into()], "Count" => 2 }.into());
        let outline = doc.add_object(dictionary! { "Title" => Object::string_literal("Secret"), "Dest" => vec![p3.into(), "Fit".into()] });
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "Outlines" => outline });
        doc.trailer.set("Root", catalog);
        (doc, p1, p2, p3)
    }

    #[test]
    fn dropped_pages_leave_nothing_behind() {
        let (mut doc, p1, p2, p3) = sample();
        remove_stray_pages(&mut doc).unwrap();
        assert!(doc.get_object(p3).is_err(), "page three is gone");
        let mut saved = Vec::new();
        doc.save_to(&mut saved).unwrap();
        assert!(!String::from_utf8_lossy(&saved).contains("SECRET"));
        // the link to page two still works
        let annots = doc.get_object(p1).unwrap().as_dict().unwrap().get(b"Annots").unwrap().as_array().unwrap().clone();
        let dests: Vec<Object> = annots
            .iter()
            .map(|a| doc.get_object(a.as_reference().unwrap()).unwrap().as_dict().unwrap().get(b"Dest").unwrap().as_array().unwrap()[0].clone())
            .collect();
        assert!(dests.contains(&Object::Reference(p2)));
        assert!(dests.contains(&Object::Null));
    }

    #[test]
    fn nothing_to_do_when_every_page_is_kept() {
        let (mut doc, _, _, p3) = sample();
        let pages_id = doc.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        let kids = doc.get_object_mut(pages_id).unwrap().as_dict_mut().unwrap();
        kids.get_mut(b"Kids").unwrap().as_array_mut().unwrap().push(p3.into());
        kids.set("Count", 3);
        remove_stray_pages(&mut doc).unwrap();
        assert!(doc.get_object(p3).is_ok());
    }
}
