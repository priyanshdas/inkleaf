# Inkleaf

A free, open-source PDF editor for Windows, macOS and Linux that works
entirely offline. Open a PDF, change it, save it. Nothing is uploaded
anywhere, there are no accounts, and every tool is free. Built by EPD.

[![CI](https://github.com/priyanshdas/inkleaf/actions/workflows/ci.yml/badge.svg)](https://github.com/priyanshdas/inkleaf/actions/workflows/ci.yml)
[![Licence: GPL-3.0-or-later](https://img.shields.io/badge/licence-GPL--3.0--or--later-2b7356)](LICENSE)
[![Support on Ko-fi](https://img.shields.io/badge/support-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/inkleaf)

**Download:** the latest installers are on the
[releases page](https://github.com/priyanshdas/inkleaf/releases).

## What it does

- **Edit existing text.** Click a line in the PDF, retype it. When you save, the
  original words are actually removed from the file, not just hidden under a
  white box, so nobody can copy them back out.
- **Redact.** Draw a box over anything sensitive; the text underneath is deleted
  from the file on save.
- **Annotate.** Pen, highlighter, rectangles, ellipses, lines, arrows, text
  boxes, white-out and images. Everything can be selected, moved, resized,
  restyled, copied and deleted.
- **Sign.** Draw, type or upload a signature (with optional white-background
  removal for photos of paper signatures). Saved signatures can be reused.
  Signature fields in a PDF are clickable.
- **Fill forms.** Text fields, checkboxes, radio buttons and dropdowns are
  filled in place and saved back into the form, so they stay fillable.
- **Pages.** Reorder by dragging thumbnails, rotate, delete, insert blank pages,
  merge in other PDFs, extract pages to a new file, or split a document.
- **Protected files.** Opens password-protected PDFs (after asking for the
  password) and "view only" PDFs. Saved copies are unprotected; the app tells
  you when that happens.
- **Comments.** Sticky notes saved as standard PDF comments, so Acrobat,
  Chrome and phone viewers show them too. Comments already in a file open as
  editable notes, and the sidebar lists every one.
- **Stamps.** Approved, Paid, Received, Rejected, Confidential and others (or
  your own words), with today's date if you like.
- **Find (Ctrl+F)**, **Print (Ctrl+P)**, **bookmarks** (read, add, rename,
  delete; saved with the file), **crop pages**, and continuous, two-page and
  one-page reading modes.
- **Text recognition (OCR).** Makes scans searchable and editable in 56
  languages, from English, Spanish and Arabic to Hindi, Chinese, Japanese,
  Swahili and Amharic. English and Hindi come built in; any other language
  is downloaded once (a few MB, checked against a known hash) and then works
  offline. The scan looks exactly the same afterwards.
- **Type in any major script.** New and edited text is shaped properly for
  Devanagari, Bengali, Tamil, Arabic, Hebrew, Thai and the rest, right-to-left
  lines included, and saved with the matching Noto font built into the file.
  Chinese, Japanese and Korean fonts are larger, so they're fetched the first
  time you need them.
- **In your language.** Menus, dialogs and messages are available in 30
  languages: English, Hindi, Bengali, Marathi, Tamil, Telugu, Gujarati, Urdu,
  Spanish, French, German, Italian, Portuguese, Dutch, Polish, Ukrainian,
  Russian, Turkish, Arabic, Persian, Hebrew, Chinese (Simplified and
  Traditional), Japanese, Korean, Vietnamese, Thai, Indonesian, Malay and
  Swahili. Inkleaf follows your computer's language, or pick one under
  View › Language. Arabic, Persian, Urdu and Hebrew mirror the whole window,
  while the PDF itself stays the right way round.
- **Compress**, **password-protect** (AES-256, with optional print, copy and
  edit restrictions), **watermarks, page numbers, headers and footers**,
  **form builder** (text boxes, paragraphs, checkboxes, dropdowns), and
  **compare two PDFs** word by word.
- **Convert to PDF:** Word, Excel, PowerPoint, OpenDocument, CSV, text,
  Markdown, web pages and pictures. Just open or drop the file. If
  [LibreOffice](https://www.libreoffice.org) is installed, office files go
  through it and keep their exact layout; otherwise Inkleaf's built-in
  converters keep the text, headings, lists, tables, pictures and slide
  layout. (Old .doc/.xls/.ppt and OpenDocument files need LibreOffice.)
- **Convert PDF to:** Word, Excel (tables become real rows, columns and
  numbers), PowerPoint (a slide per page, text in the notes), PNG or JPEG
  pictures, plain text, Markdown, HTML and **PDF/A** (the archiving
  standard: fonts built in, colour profile, XMP metadata).
- **Web page to PDF:** type an address and the page is printed onto A4,
  loaded privately without your logins or cookies.
- **Scan to PDF:** take pictures of paper with your webcam, or add photos
  from your phone. Inkleaf finds the page, lets you drag its corners,
  straightens it, and whitens the paper (or makes it black and white).
  Text recognition can run straight after.
- **Repair PDF:** rebuilds a broken index, reads back what it can from
  cut-off files, and as a last resort redraws the pages. Offered
  automatically when a file won't open.
- **Unlock PDF:** saves a copy of a protected file (with the password you
  know) without its password.
- **AI Summarizer and Translate PDF** (optional). They use Claude, from
  Anthropic, with your own API key (Tools › AI settings), and they're the
  only tools that send anything off your computer: the document's text,
  and only when you run them. Translation goes into any of 56 languages
  and either lays the new words over a copy of the pages, keeping the
  layout, or makes a Word document. The key is stored encrypted.
- **All tools** (Ctrl+K or ⌘K): every tool on one searchable page, grouped
  as Organize, Optimize, Convert, Edit, Security and Intelligence.
- Several PDFs open at once in tabs, a recent-files home screen, and a
  View menu switch between light, dark and match-system themes.
- **Auto-save.** Documents you've opened or saved before are saved a few
  seconds after each change (switch it off from the "Saved" indicator or the
  File menu). Before a file is auto-saved over for the first time in a
  session, the original is copied to a Backups folder (the newest 40 are
  kept). Protected PDFs are never auto-saved, since that would remove their
  protection without asking.
- **Crash recovery.** Unsaved work, including brand-new documents, is copied
  somewhere safe every minute and offered back if Inkleaf closes unexpectedly.
- Updates itself (installed version) when a new release is published.
- Unlimited undo, light and dark mode, keyboard shortcuts for every tool
  (press Ctrl+/ or ⌘/ to see them).

## Free and open source

Every tool is included for everyone: no paid tiers, licence keys or trial
limits. The code is licensed under the GNU GPL, version 3 or later, so you can
use, study, share and change it. If you share a changed version, it has to
stay open source under the same licence.

If Inkleaf saves you time, you can buy me a coffee on
[Ko-fi](https://ko-fi.com/inkleaf). The app links there too, from
Help › Buy Me a Coffee, the coffee button in the title bar and the About box. (The link lives in
`src/shared/config.ts`; `.github/FUNDING.yml` adds the Sponsor button on
GitHub.)

## Contributing

Bug reports, ideas, translations and pull requests are all welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for how we treat each other. Please
report security problems privately, as described in [SECURITY.md](SECURITY.md).

### Translating Inkleaf

Every message in the app is written in English and wrapped in `t('…')`.
Translations live in `src/renderer/i18n/<code>.json`, one file per language.

```bash
npm run i18n                          # refresh the English list and show what each language is missing
node scripts/i18n.mjs --missing fr    # list the French strings still to do
```

Keep `{placeholders}` exactly as they are, keep both halves of
`{count, plural, one {…} other {…}}`, and leave shortcuts such as `Ctrl+S`
untouched. To add a language, add its code to `UI_LANGUAGES` in
`src/shared/i18n.ts` (and to `RTL_LANGUAGES` if it's written right to left),
then create its JSON file.

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

That's it. The Rust core ships precompiled as `core/prebuilt/inkleaf_core.wasm`,
so you don't need Rust unless you change it.

## Building installers

Each platform's installer is best built on that platform:

```bash
npm run dist:win     # on Windows: NSIS installer + portable .exe
npm run dist:mac     # on macOS:   .dmg + .zip
npm run dist:linux   # on Linux:   AppImage + .deb
```

Output lands in `dist/`. `dist:win` makes an installer (`Inkleaf Setup 2.3.0.exe`)
and a portable `.exe` that runs without installing. It can also be built on
Linux if Wine is installed.

Unsigned Windows builds trigger SmartScreen ("Windows protected your PC";
people click **More info → Run anyway**). Signing with a code-signing
certificate removes that warning and is worth doing before a public release.
For a public macOS release you'll want to sign and
notarise the app (set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID` and friends as
described in the electron-builder docs); unsigned builds run but macOS will
warn on first launch. Windows builds can be signed the same way.

## Publishing an update

The installed app checks GitHub Releases for a newer version 15 seconds after
starting (and every six hours), downloads it in the background and offers a
restart. The portable `.exe` can't update itself; it says so if asked.

Updates come from the public repository `priyanshdas/inkleaf-releases` (see
`build.publish` in `package.json`), which holds only installers and update
files. GitHub Actions builds and publishes them for you:

1. Create the empty public repository `inkleaf-releases` on GitHub (once).
2. Make a fine-grained GitHub token with **Contents: read and write** on that
   repository, and add it to this repository's secrets as `RELEASES_TOKEN`
   (once).
3. For each release, raise `version` in `package.json` (for example to
   `2.1.1`), commit, then tag and push:

   ```bash
   git tag v2.1.1
   git push origin main v2.1.1
   ```

   `.github/workflows/release.yml` builds Windows, macOS and Linux installers
   and publishes them. Everyone on the installed version gets the update
   within a few hours.

To publish from your own computer instead, set `GH_TOKEN` and run
`npm run release:win` (or `npm run release` on each platform).

## How it's put together

```
src/main/        Electron main process: windows, menus, file access
src/renderer/    the editor UI (TypeScript, no framework)
core/            Rust PDF core, compiled to WebAssembly
tests/           fixtures and the end-to-end test
scripts/         build script and icon generator
```

The renderer never touches the file system. It asks the main process to open
and save files through a small API (`src/shared/api.ts`), and the main process
only lets a window overwrite files that window opened or picked in Save As.

Rendering uses [pdf.js](https://mozilla.github.io/pdf.js/). Saving uses
[pdf-lib](https://pdf-lib.js.org) to draw annotations, fill forms and rearrange
pages. The Rust core (built on [lopdf](https://github.com/J-F-Liu/lopdf)) does
the parts pdf-lib can't:

- **Redaction**, used by both Redact and Edit text. It replays each page's
  content stream, works out where every glyph lands, and drops the ones inside
  a redaction box while inserting spacing so the surviving glyphs don't move.
  Everything else in the stream is copied through byte for byte.
- **Unlocking** encrypted PDFs so they can be edited.
- **Clean-up** before writing: anything no longer reachable (deleted pages,
  replaced text) is dropped so it doesn't linger in the saved file.

Edits are kept as a list of changes on top of the original file until you save.
That's what makes undo cheap, and why an edited line stays editable after
saving for as long as the document is open.

### Changing the Rust core

Install Rust from [rustup.rs](https://rustup.rs), then:

```bash
rustup target add wasm32-unknown-unknown
npm run build:core     # rebuilds core/prebuilt/inkleaf_core.wasm
npm run test:core      # Rust unit and integration tests
```

`core/examples/ikcli.rs` is a small command-line wrapper that's handy for trying
the core on real files:
`cargo run --example ikcli -- redact in.pdf out.pdf '[{"page":0,"rects":[{"x0":100,"y0":700,"x1":200,"y1":720}]}]'`

## Tests

```bash
python3 tests/make_fixtures.py   # needs reportlab and qpdf
npm test                         # on a headless Linux box: xvfb-run -a npm test
```

The end-to-end test drives the real app with the mouse and keyboard (edits
text, draws, redacts, signs, fills a form, rearranges pages, opens protected
files), saves, and then checks the saved files with poppler and pypdf rather
than trusting the app's own state. Set `INKLEAF_SHOTS=/some/folder` to keep
screenshots.

## Performance

`tests/bench/` has two benchmarks that drive the real app on a 300-page PDF
(`python3 tests/bench/make_big.py` makes it):

- `bench.mjs` times start-up, opening, page jumps, zoom, undo, saving, extract and split.
- `frames.mjs` measures frame times while drawing, dragging, scrolling and typing.
  Run it with `DPR=2` to simulate a high-DPI laptop screen, where slowdowns show first.

Things that keep it fast, worth preserving when changing the viewer:

- Only pages near the viewport keep full-resolution canvases; others keep a small preview.
- While scrolling, pages get a quick low-resolution render first and sharpen once you pause.
- Highlights are painted into the page render, not a blended layer (blending is costly every frame).
- The mark being drawn or dragged lives on its own temporary layer, so a frame repaints one mark, not the page.
- Undo snapshots share unchanged data instead of copying the document.
- The PDF writer loads after start-up, and split parses the document once for all output files.

## Known limits

- **Scanned PDFs** are pictures of text. Run Tools › Recognise text (OCR)
  first; after that Find, copy and Edit text work on them. Edited words on a
  scan are covered and retyped; the picture underneath isn't changed, and
  Redact on a scan covers the area rather than removing pixels.
- **Compare** works on the words. Pictures, colours and layout changes aren't
  reported.
- **PDF to Word, Markdown and HTML** rebuild paragraphs and headings from
  where the text sits. Columns come out as plain paragraphs; scanned pages
  are copied in as pictures. **PDF to Excel** finds tables by how the text
  lines up, which works well for invoices and statements but not for tables
  drawn as pictures (run OCR first).
- **Translating over the page** replaces each line where it was. Longer
  translations are shrunk to fit the original line, so check the result;
  for long documents the Word option often reads better.
- **Language packs** (OCR models and the Chinese, Japanese and Korean fonts)
  need an internet connection the first time each one is used. They come
  from jsDelivr; your pages are never sent anywhere.
- **Interface translations** were written for this release and haven't all
  been checked by native speakers yet. If something reads oddly in your
  language, please open an issue or a pull request.
- **Scan to PDF** finds the page by looking for the bright sheet on a darker
  background. On a white desk, drag the corners into place yourself.
- **PDF/A** output is PDF/A-2b. Files with transparency groups or unusual
  fonts may still need a dedicated tool to pass a strict validator; Inkleaf
  lists anything it couldn't fix.
- **Without LibreOffice**, converted Word files lose page headers, footers and
  exact fonts, and slides drop charts, SmartArt and effects.
- **Print** sends the pages as 200 dpi pictures, which keeps every mark and
  form value exactly as on screen but makes large print jobs slower than
  printing from a dedicated PDF reader.
- Edited text keeps the document's own font when that font is embedded with
  a proper Unicode character map (PDFs saved from browsers and Office usually
  are). Embedded fonts are often subsets holding only the letters the
  document used, so typing a letter the subset lacks switches that line to
  the closest standard font (Helvetica, Times or Courier). Fonts that map
  their own private codes, or whose licence forbids embedding, are never
  reused. Lines in scripts that need shaping (Devanagari, Arabic, Thai and
  so on) are always written in the matching Noto font.
- Installed fonts in the text toolbar's font list come from the system font
  list. Fonts stored in collection files (.ttc) can't be embedded in a PDF
  and are refused with a message.
- Text drawn inside embedded form objects (some PDF generators wrap whole pages
  in one) is covered but not removed. Text in vertical CJK fonts or unusual
  multi-byte encodings is also left in place; the app warns about those when
  you save.
- Form fields are fillable on the original document's pages. Pages merged in
  from another PDF keep their fields' appearance but not their fillability.
- XFA forms (an old Adobe-only format) aren't supported.

## Terms and privacy

Using Inkleaf means agreeing to the [Terms of Use](TERMS.md) and
[Privacy Policy](PRIVACY.md). The installer shows both before installing,
the portable and Linux builds ask once on first start, and both are under
Help in the app. In short: Inkleaf is provided as is, with no warranty and
no liability for how it's used, and it collects nothing about you.

## Licence

Copyright © 2026 Priyansh Das.

Inkleaf is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

Inkleaf is built on other open-source projects under their own licences, all
compatible with the GPL; [THIRD-PARTY.md](THIRD-PARTY.md) lists them.
