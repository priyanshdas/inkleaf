# Roadmap

What's being worked on for InkLeaf PDF, and what comes after. There are no
dates: a version ships when it's ready and the tests pass. Plans change, so
treat anything under **Later** as an idea rather than a promise.

Want to help with something here? Items marked **help wanted** are good
places to start. Open an issue first so we can talk it through, and see
[CONTRIBUTING.md](CONTRIBUTING.md). If something you need isn't listed,
[open an issue](https://github.com/priyanshdas/inkleaf/issues) and say what
you're trying to do.

## Now: 4.0, rebuilt as native apps

InkLeaf PDF moves from a web-based app (Electron) to apps made for each kind
of device, sharing one engine underneath. Until 4.0 is ready, 3.x keeps
getting fixes.

- [ ] **Desktop app for Windows and Linux** built with [Qt](https://www.qt.io):
      starts faster, uses less memory, and works like a real desktop program
- [ ] **A new Android app** made natively for phones (Kotlin)
- [ ] **One shared engine**: pages drawn by [PDFium](https://pdfium.googlesource.com/pdfium/),
      the PDF engine inside Chrome, and InkLeaf's own Rust engine (`core/`)
      for editing and saving
- [ ] Every tool from 3.x, on all three
- [ ] Your settings, saved signatures, language packs and AI keys carried over
      from 3.x, with nothing to set up again
- [x] A new website, with release notes, a features page and this roadmap

## Next

- [ ] **Flathub.** InkLeaf PDF has been submitted; the reviewers asked to look
      at it again once the app has been out a little longer. Until then the
      Flatpak on the website keeps itself up to date.
- [ ] **Signed Windows installers** through SignPath Foundation, so the
      installer from GitHub no longer shows a SmartScreen warning. The
      Microsoft Store version already installs without one.
- [ ] **Share securely on the phone**: lock, send and receive files with a
      pickup code, as the desktop app can.
- [ ] **Form fields on merged pages.** Pages merged in from another PDF keep
      their fields' look but can't be filled yet.

## Later

- [ ] **Mac**, signed and notarised, for Apple Silicon and Intel, then
      **iPhone and iPad**.
- [ ] **Change your edits after saving.** Today, text and objects you add can
      be moved and restyled until you save; after that they're part of the
      page. The idea is to keep them editable when the file is opened again in
      InkLeaf PDF, with an option to flatten them for sending.
- [ ] **Vertical Chinese, Japanese and Korean text**: editing it in place.
      Finding it already works.
- [ ] **InkLeaf Suite**: InkLeaf Docs, and later spreadsheets, slides and
      notes, as native apps on the same engine as InkLeaf PDF. Each one can be
      downloaded on its own, or all of them together as the Suite. All free,
      offline and open source.

## Always welcome

- **Translations** (help wanted). The interface comes in 30 languages, and not
  all of them have been checked by someone who speaks the language. Fixes are
  very welcome; see [Translating InkLeaf PDF](README.md#translating-inkleaf-pdf).
- **Bug reports with a sample file.** A PDF that shows the problem makes it
  much quicker to fix.

## Done

Everything that has shipped is in the
[release notes](https://github.com/priyanshdas/inkleaf-releases/releases).
