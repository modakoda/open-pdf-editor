# Open PDF Editor

A free, open-source desktop PDF editor for **Windows, macOS and Linux**.

Built with Electron, React and TypeScript. PDFs are rendered with [pdf.js](https://mozilla.github.io/pdf.js/)
and written with [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (the maintained `@cantoo/pdf-lib` fork,
which adds encryption support). Everything runs locally; files never leave your computer.

## Features

**Pages**: reorder by drag and drop, rotate, delete, duplicate, insert blank pages, insert pages from
other PDFs (merge), extract pages to a new file, split into several files.

**Existing content** (Edit content tool): select any text line, image, vector graphic or embedded
graphic already in the page, then move, resize, rotate, recolor or delete it, or retype text in
place; bring it forward or to the front, send it backward or to the back (Ctrl/Cmd+] and [, with
Shift for front/back). Edits change the page itself: deleted or replaced content is removed from
the file, not covered up, and edited content keeps its place in the stacking order.

**Added content**: text (Unicode, with bundled Noto fonts for characters outside WinAnsi), images,
signatures (drawn or typed), rectangles, ellipses, lines, arrows, freehand ink, highlights,
whiteout, and sticky-note comments. Everything you add stays movable and editable, also after
saving and reopening the file in Open PDF Editor.

**Redaction**: mark areas with the Redact tool (or mark every match of a search with "Redact all"
in Find), review them (move, resize, remove, undo), and on save everything under them is removed
from the file: text (the remaining characters keep their exact positions), vector graphics, image
pixels, content inside embedded graphics, comments, links and form fields. The areas are then
filled (any color, or none) with optional overlay text. Optionally "Sanitize document" also removes
document properties and XMP metadata, attachments, JavaScript and hidden layers.

**Comments and annotations**: move, resize, delete and edit existing notes, highlights, shapes,
free text and links.

**Forms**: fill every field type; in Prepare form mode move, resize, rename, delete and configure
existing fields (required, read-only, multiline, length, font size, options) and add new text,
checkbox, radio, dropdown, list and signature fields; optionally flatten forms on save.

**Document**: title/author/subject/keywords, watermark, page numbers, password protection (AES-256),
removing a password from a file you can open, printing.

**Editor**: undo/redo for every change, zoom and fit modes, thumbnails, keyboard shortcuts,
drag and drop, "Open With" / file associations, recent files, unsaved-changes protection.

### Limitations

- "Whiteout" only covers content visually; use Redact (or delete it with Edit content) to remove
  sensitive content from the file, and check the result before sharing.
- Redaction removes whole characters that touch a marked area. Vector paths that are only partly
  under an area are clipped, so their coordinates stay in the file. Images in formats that cannot
  be decoded (JPEG 2000, JBIG2, CCITT fax) are removed completely when an area touches them.
- Text retyped with characters the original font lacks uses a similar bundled font.
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
