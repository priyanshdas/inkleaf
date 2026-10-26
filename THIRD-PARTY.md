# Third-party software

Inkleaf is licensed under the GNU General Public License, version 3 or later
(see `LICENSE`). It's built on these open-source projects, each under its own
licence. All of them can be combined with GPL-3.0 software; their notices
must travel with any copy of Inkleaf you share.

| Component | Used for | Licence |
| --- | --- | --- |
| [Electron](https://www.electronjs.org) | The desktop app shell | MIT |
| [pdf.js](https://github.com/mozilla/pdf.js) | Drawing pages, reading text | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | Writing PDFs | MIT |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | Reading and embedding fonts | MIT |
| [lopdf](https://github.com/J-F-Liu/lopdf) | The Rust PDF core | MIT |
| [jpeg-decoder](https://github.com/image-rs/jpeg-decoder), [jpeg-encoder](https://github.com/vstroebel/jpeg-encoder) | Compressing photos | MIT / Apache-2.0 |
| [sha2](https://github.com/RustCrypto/hashes), [flate2](https://github.com/rust-lang/flate2-rs), [serde](https://serde.rs) | Rust core helpers | MIT / Apache-2.0 |
| [Tesseract](https://github.com/tesseract-ocr/tesseract) and [tesseract.js](https://github.com/naptha/tesseract.js) | Text recognition (OCR) | Apache-2.0 |
| [tessdata](https://github.com/tesseract-ocr/tessdata_best) language models | OCR in English, Hindi, Bengali, Italian | Apache-2.0 |
| [docx](https://github.com/dolanmiu/docx) | Exporting to Word | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | Reading Word files | BSD-2-Clause |
| [ExcelJS](https://github.com/exceljs/exceljs) | Reading and writing Excel files | MIT |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | Writing PowerPoint files | MIT |
| [JSZip](https://github.com/Stuk/jszip) | Reading PowerPoint files | MIT |
| [marked](https://github.com/markedjs/marked) | Reading Markdown | MIT |
| [LibreOffice](https://www.libreoffice.org) | Exact office conversion, when the user has it installed (not bundled) | MPL-2.0 |
| [electron-updater](https://github.com/electron-userland/electron-builder) | Automatic updates | MIT |
| [Lucide](https://lucide.dev) | Icons | ISC |
| [Instrument Sans](https://github.com/Instrument/instrument-sans) | Interface font | SIL Open Font License 1.1 |
| [DejaVu fonts](https://dejavu-fonts.github.io) | Fallback font in saved PDFs | Bitstream Vera licence |
| [Liberation fonts](https://github.com/liberationfonts/liberation-fonts) | Built-in fonts for PDF/A | SIL Open Font License 1.1 |
| sRGB colour profile by Graeme W. Gill (from ArgyllCMS) | Colour profile for PDF/A | Public domain |
| The AI service you pick in AI settings (Claude, ChatGPT, Gemini, Grok, Perplexity, a local model or any compatible service) | AI Summarizer and Translate (optional, your own key; not bundled) | That service's own terms |

The full licence texts ship inside each package (`node_modules/<name>/LICENSE`
when building from source) and next to the bundled files in the app.
