# Open PDF Editor

A free, open-source desktop PDF editor for **Windows, macOS and Linux**.

Built with Electron, React and TypeScript. PDFs are rendered with [pdf.js](https://mozilla.github.io/pdf.js/)
and written with [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (the maintained `@cantoo/pdf-lib` fork,
which adds encryption support). Everything runs locally; files never leave your computer.

## Features

**Pages**: reorder by drag and drop, rotate, delete, duplicate, insert blank pages, insert pages from
other PDFs (merge), extract pages to a new file, split into several files.

**Content**: add text (Unicode, with bundled Noto fonts for characters outside WinAnsi), replace
existing text, images, signatures (drawn or typed), rectangles, ellipses, lines, arrows, freehand
ink, highlights, whiteout, and sticky-note comments. Every object stays movable, resizable and
editable until you save.

**Forms**: fill text fields, checkboxes, radio buttons, dropdowns and list boxes; optionally
flatten them on save.

**Document**: title/author/subject/keywords, watermark, page numbers, password protection (AES-256),
removing a password from a file you can open, printing.

**Editor**: undo/redo for every change, zoom and fit modes, thumbnails, keyboard shortcuts,
drag and drop, "Open With" / file associations, recent files, unsaved-changes protection.

### Limitations

- "Whiteout" and "replace text" cover the original content visually; the original text is still
  in the file. Use them for corrections, not for redacting sensitive data.
- Visible signatures are images; cryptographic digital signatures are not created.
- Bundled Unicode fonts cover Latin, Greek and Cyrillic. CJK text needs a CJK font (not bundled).
- When pages from several PDFs with forms are merged, forms of the inserted files are flattened,
  and links on inserted pages that jump within their original file are removed (web links are kept).
- Password-protected files keep their original encryption and permissions when saved, unless you
  change them under Security. A file opened with only its owner password (AES-256) keeps an
  unknown open password; set a new one if you change its security settings.
- PDF/A files lose their PDF/A claim if you add a password (PDF/A does not allow encryption).

## Download / build

Requires Node.js 22.12+ (24 recommended).

```bash
npm install
node node_modules/electron/install.js   # downloads the Electron binary (npm 12 blocks install scripts)
npm run dev                             # start the app with hot reload
```

Build installers for the current OS (output in `release/`):

```bash
npm run dist
```

Platform specific: `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux`.

## Tests

```bash
npm run typecheck
npm test              # unit tests (engine) + component tests (UI), Vitest
npm run test:e2e      # builds the app and runs Playwright end-to-end tests against Electron
npm run test:all      # everything
```

CI runs all of them on Windows, macOS and Linux (`.github/workflows/ci.yml`).

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/core       PDF engine: document model, edit operations, text layout, export
src/renderer   React UI (viewer, thumbnails, tools, dialogs)
src/main       Electron main process (windows, menus, file access)
src/preload    Secure bridge between UI and main process
src/shared     IPC contract
tests/         core, renderer and e2e tests, fixture PDFs
resources/     bundled fonts
```

## License

MIT. Bundled Noto fonts: SIL Open Font License 1.1.
