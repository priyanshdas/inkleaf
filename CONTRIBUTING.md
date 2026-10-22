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

The interface is English only for now. If you'd like to translate it, open an
issue first: the text needs gathering into one place before translation can
start, and that's a good first project in itself.
