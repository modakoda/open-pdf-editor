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
Shift for front/back). Double-clicking text in the Select tool switches to Edit content and starts
retyping it. Edits change the page itself: deleted or replaced content is removed from the file,
not covered up, and edited content keeps its place in the stacking order.

**Added content**: text (Unicode: bundled Noto fonts for Latin, Greek and Cyrillic; installed system
fonts for Chinese, Japanese, Korean, Thai and Devanagari, with CJK line breaking), images,
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

**Text recognition (OCR)**: make scanned pages searchable, copyable and editable, fully offline
(Tesseract via [tesseract.js](https://github.com/naptha/tesseract.js), with English and Lithuanian
bundled). Scanned pages (images without text) are detected when a file is opened and OCR is offered.
Document → Recognize Text… (or OCR in the toolbar) recognizes the current page, selected pages or all
pages, with progress and Cancel. Recognized text is searchable with Find right away and is saved as
an invisible text layer over the scan, so selecting, searching and copying work in any PDF viewer.
In Edit content, a recognized line can be turned into editable text ("Make editable" covers the line
in the scan and puts the recognized text in its place). Undo works for both.

**Digital signatures**: sign with a PKCS#12 certificate (.p12/.pfx, RSA or ECDSA) into an empty
signature field or a new box you draw, with a visible appearance (name, date, reason, optional
drawn/typed signature) and optional reason, location and contact. Signatures are PAdES baseline
B-B compatible (SubFilter ETSI.CAdES.detached, SHA-256) and are added as an incremental update, so
the signed bytes stay intact and earlier signatures stay valid. Opening a file verifies its
signatures (ETSI.CAdES.detached and adbe.pkcs7.detached): integrity, signer, time, reason, and
whether the file changed after signing, shown in the Signatures tab and a status-bar badge. The
certificate password is only used to unlock the key, which stays in memory in the app's main
process; it is never stored.

**Editor**: undo/redo for every change, zoom and fit modes, thumbnails, keyboard shortcuts,
drag and drop, "Open With" / file associations, recent files, unsaved-changes protection.

### Limitations

- "Whiteout" only covers content visually; use Redact (or delete it with Edit content) to remove
  sensitive content from the file, and check the result before sharing.
- Redaction removes whole characters that touch a marked area. Vector paths that are only partly
  under an area are clipped, so their coordinates stay in the file. Images in formats that cannot
  be decoded (JPEG 2000, JBIG2, CCITT fax) are removed completely when an area touches them.
- Text retyped with characters the original font lacks uses a similar bundled font (Inter
  text, common in invoices saved from web pages, keeps Inter at the closest weight).
- Signature verification checks integrity, not identity: certificates are not validated against
  trusted authorities or revocation lists ("Identity not verified"). Signing adds no timestamp
  (PAdES B-B) and password-protected documents cannot be signed.
- Saving changes to a signed file rewrites it, which removes its signatures (the app warns and
  offers to save a copy instead); signing an unchanged file keeps its existing signatures.
- Bundled Unicode fonts cover Latin, Greek and Cyrillic. Chinese, Japanese, Korean, Thai and
  Devanagari text uses fonts installed on the system (e.g. Hiragino, Songti, Apple SD Gothic Neo on
  macOS, Microsoft YaHei/Yu Gothic/Malgun Gothic on Windows, Noto Sans CJK on Linux), embedded as
  subsets when saving. Each text is drawn with a single font, so it must contain every character;
  characters no installed font contains are saved as "?" (the editor tells you which).
- Right-to-left scripts (Arabic, Hebrew) are not supported yet: they are saved as "?" and the
  editor shows a notice.
- When pages from several PDFs with forms are merged, forms of the inserted files are flattened,
  and links on inserted pages that jump within their original file are removed (web links are kept).
- Password-protected files keep their original encryption and permissions when saved, unless you
  change them under Security. A file opened with only its owner password (AES-256) keeps an
  unknown open password; set a new one if you change its security settings.
- PDF/A files lose their PDF/A claim if you add a password (PDF/A does not allow encryption).
- OCR quality depends on the scan (about 300 dpi, straight, clear print works best). Only English and
  Lithuanian recognition data are bundled; text in other languages is recognized less accurately.

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

## Updates

The app checks for new versions a few seconds after startup and every 6 hours, and on
**Help › Check for Updates…**. **Help › Check for Updates Automatically** turns the automatic checks
off (saved in `update-settings.json` in the app's user-data folder). Development builds and test
runs never check.

| Build | Update |
| --- | --- |
| Windows installer (NSIS), Linux AppImage, macOS app signed with a Developer ID | Downloads in the background, installs when you quit, or right away with **Restart to Update** |
| macOS app ad-hoc signed or unsigned (builds without certificates), app run from the disk image, Windows portable, Linux deb / tar.gz | Shows “A new version is available — download it”, linking to the release |

Unsaved work is never lost: **Restart to Update** quits the normal way, so every window with
unsaved changes asks to save first. Cancelling keeps the app open; the update then installs the
next time you quit.

### Publishing updates

- Updates use [electron-updater](https://www.electron.build/auto-update). The `publish` section of
  `electron-builder.yml` points at the GitHub Releases of `modakoda/open-pdf-editor`; electron-builder
  writes the update metadata (`latest.yml`, `latest-mac.yml`, `latest-linux*.yml`) and `.blockmap`
  files next to the installers, and `release.yml` uploads them to the release with the installers.
  Releases must be published (not drafts) and tagged `vX.Y.Z`.
- **The repository is private**, and electron-updater's GitHub provider only reads public releases
  (a token must never be shipped in the app). Before end users can update, either publish releases
  publicly (make the repository public, or point `owner` / `repo` at a public repository that gets
  the release files), or use a generic update URL: set the repository variable `UPDATE_FEED_URL`
  (e.g. `https://downloads.example.com/open-pdf-editor/`). `release.yml` then builds apps that read
  that URL (`scripts/generic-feed-config.mjs`); upload each release's installers, `latest*.yml` and
  `.blockmap` files to it.
- macOS installs updates in place only when the app is signed with a Developer ID (and notarized):
  set the signing secrets listed in `release.yml`.
- `OPE_UPDATE_FEED_URL=https://…` overrides the feed when starting an installed app (e.g. to try a
  staging feed).

## Tests

```bash
npm run typecheck
npm test              # unit tests (engine) + component tests (UI), Vitest
npm run test:e2e      # builds the app and runs Playwright end-to-end tests against Electron
npm run test:all      # everything
```

CI runs all of them on Windows, macOS and Linux (`.github/workflows/ci.yml`), then packages the
app, checks the update metadata (`scripts/check-update-metadata.mjs`) and smoke-tests the packaged
app. The update e2e tests use a scripted updater (`OPE_E2E_UPDATER=mock`) and never contact a server.

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
scripts/       asset copying (pdf.js resources, OCR engine and language data)
site/          landing page, published to GitHub Pages by .github/workflows/pages.yml
```

The site's screenshots come from the real app: `npm run build`, then
`node scripts/site-screenshots.ts` (or `node scripts/site-screenshots.ts <scene>` for one).

## License

MIT. Bundled Noto and Inter fonts: SIL Open Font License 1.1 (`resources/fonts/OFL.txt`,
`resources/fonts/Inter-OFL.txt`). Text recognition: tesseract.js and tesseract.js-core
(Tesseract OCR) under the Apache License 2.0, recognition data from
tesseract-ocr/tessdata_best (Apache License 2.0); the license texts ship with the app
(`ocr/NOTICE.txt` next to the renderer files).
