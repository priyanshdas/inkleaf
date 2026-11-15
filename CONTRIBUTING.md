# Contributing to Inkleaf

Thanks for wanting to help. Inkleaf is a small project, so every bug report,
translation and pull request genuinely makes a difference.

## Reporting a bug

Open an issue and include:

- what you did, step by step,
- what you expected, and what happened instead,
- your operating system and Inkleaf version (Help › About),
- the PDF, if you can share it. If it's private, a description of where it
  came from (scanner, Word, a website) often helps just as much.

Security problems are different: please follow `SECURITY.md` instead of opening
a public issue.

## Suggesting a feature

Open an issue that starts with the problem rather than the solution: "I need
to do X and can't" is more useful than "add button Y". It helps decide whether
the feature belongs in Inkleaf and what shape it should take.

## Working on the code

You'll need Node.js 22 or newer. Rust is only needed if you change the PDF core
in `core/` (a compiled copy is checked in).

```bash
npm install
npm start            # build and run
npm run typecheck
xvfb-run -a npm test # end-to-end tests (on Windows or macOS, just: npm test)
cd core && cargo test
```

The end-to-end tests need `python3` with `pypdf`, plus `poppler-utils` and
`qpdf`. `README.md` explains how the app is put together.

### Pull requests

- Keep each pull request to one change. Small ones get reviewed quickly.
- Add or update a check in `tests/smoke.mjs` when you change behaviour.
- Run the typecheck and tests before you open it.
- Match the style around you: plain names, comments that say *why*, and
  messages in the app written the way you'd say them to a person.
- By sending a pull request you agree your contribution is licensed under
  GPL-3.0-or-later, like the rest of Inkleaf.

### Good first issues

Issues labelled **good first issue** are small and self-contained. Comment on
one before you start so two people don't do the same work.

## Translations

Inkleaf's interface is available in 30 languages (English plus 29 translations),
and fixes and new languages are welcome. Every message is written in English and
wrapped in `t('…')`; the translations live in `src/renderer/i18n/<code>.json`.

`README.md` ("Translating InkLeaf PDF") explains the workflow: `npm run i18n` shows
what each language is missing, and it also explains how to add a language. For
a new language, open an issue first so we can agree on the code and who is
working on it. Native speakers correcting an existing translation can go
straight to a pull request. Please don't edit `strings.json`: `npm run i18n`
regenerates it.
