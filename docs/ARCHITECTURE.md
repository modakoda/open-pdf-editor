# Architecture

Open PDF Editor is an Electron desktop app (Windows, macOS, Linux) written in TypeScript + React.

| Layer | Path | Runs in | Responsibility |
| --- | --- | --- | --- |
| Engine | `src/core` | Node and browser (no DOM, no Electron) | Document model, pure edit operations, text layout, PDF export (pdf-lib fork `@cantoo/pdf-lib`) |
| Renderer | `src/renderer` | Electron renderer (also plain browser via `npm run dev:web`) | UI: viewer (pdf.js), thumbnails, tools, dialogs |
| Shell | `src/main`, `src/preload` | Electron main / preload | Windows, menus, file dialogs, file I/O, OS integration |
| Contract | `src/shared/ipc.ts` | both | `DesktopApi` exposed by preload as `window.desktop` |

## Editing model

`src/core/model.ts` is the single source of truth. Original PDF bytes are never modified. An
`EditorDocument` describes the output: ordered `PageEntry`s (from one or more `SourceDocument`s,
or blank), `EditObject`s drawn on pages, form values, and settings (metadata, watermark, page
numbers, form flattening, encryption). Every change is a pure function in
`src/core/operations.ts`; undo/redo stores snapshots (`src/renderer/src/state/store.ts`).

Redaction areas (`EditorDocument.redactions`, edited with `src/core/redactions.ts`) are applied by
`exportDocument()` after everything else has been drawn: `src/core/redaction.ts` (pages,
annotations, form fields, fill boxes) uses `src/core/content/redact.ts` (content streams: glyphs,
paths, form XObject copies) and `src/core/content/images.ts` (image pixels). The optional sanitize
step is `src/core/sanitize.ts`. On screen the areas are an overlay (`editing/RedactionsLayer.tsx`);
after a save that applied redactions the saved file is opened again.

The viewer renders source pages with pdf.js (rotation via the viewport, so no re-export is needed
to display edits) and draws `EditObject`s as an interactive HTML/SVG overlay. `exportDocument()`
(`src/core/export.ts`) produces the real PDF on save.

### Coordinates

"Page space": PDF points, origin at the top-left of the page's visible box **before rotation**,
y down. Helpers in `src/core/geometry.ts`:

- `pageToView` / `viewToPage` convert between page space and the rotated, scaled on-screen page.
- `overlayTransform(page, scale)` is the CSS transform for an overlay laid out in unrotated page
  space (`transform-origin: 0 0`).
- `pageToPdf` / `pdfToPage` convert to/from PDF user space (bottom-left origin) given the crop box.
- On-screen scale (CSS px per point) = `zoom * CSS_PX_PER_PT`.
- The page's visible box is the crop box intersected with the media box (same as pdf.js `page.view`).
- pdf.js: `page.getViewport({ scale: 1, rotation: 0 })` maps PDF user space to page space.

### Text recognition (OCR)

`EditorDocument.ocr` holds recognized text per page (`OcrPageResult`: lines of words with page-space
boxes, confidence, the baseline, and the reading orientation `rotation`). `src/core/ocr.ts` has the
pure operations (`setOcrResults`, `makeOcrLineEditable`, `looksScanned`, `ocrResultFromRecognition`).
The renderer recognizes pages with tesseract.js in a Web Worker (`src/renderer/src/ocr/engine.ts`):
the page is rendered with pdf.js at 300 dpi with its displayed rotation (`ocr/render.ts`) and the
pixel boxes are mapped back to page space. Worker, WebAssembly core (LSTM-only, SIMD and plain) and
the eng/lit language data are copied into `public/ocr` by `scripts/copy-ocr-assets.mjs` and loaded
from the app's own origin (`app://bundle/ocr/…`); the worker is started from its URL (not `blob:`),
so it can compile WebAssembly without relaxing the page's CSP. `exportOcr.ts` writes the words as
invisible text (render mode 3, embedded Noto Sans subset, `Tz` to fit each word's width) inside
`/OPEObject <</Id (ope-ocr-layer)>> BDC … EMC`; the result is also stored in the page's /PieceInfo
(persist.ts), so on reopening it is restored (`SourcePageInfo.restoredOcr`) and a later save
replaces the layer instead of adding another. Find searches `doc.ocr` next to the pages' own text.

### Fonts

Text objects use `font: 'sans' | 'serif' | 'mono'`. Text encodable in WinAnsi is exported with the
standard PDF fonts (Helvetica/Times/Courier families, not embedded). Other text (e.g. Lithuanian,
Greek, Cyrillic) is exported with the bundled Noto fonts (`resources/fonts`, embedded as subsets).
`layoutText()` in `src/core/text.ts` computes line breaks for both the overlay and the exporter,
so wrapping on screen matches the saved file (at spaces, and between CJK characters with simple
punctuation rules: `splitAtCjkBreaks` in `src/core/scripts.ts`). The renderer registers the font
bytes at startup (`src/renderer/src/fonts/fonts.ts`) and declares them for CSS as `OPE Noto Sans`,
`OPE Noto Serif`, `OPE Noto Sans Mono` (`fonts.css`).

Text the bundled fonts cannot draw (CJK, Thai, Devanagari) uses system fonts, which are too large
to bundle:

- `src/main/systemFonts.ts` finds suitable font files per platform (known files in the macOS and
  Windows font folders, fontconfig `fc-list` on Linux, or a scan of the Linux font folders) and
  serves them by catalog id over IPC (`listSystemFonts` / `readSystemFont`); nothing else is read.
- `src/renderer/src/fonts/systemFonts.ts` watches the document's texts (`documentTexts.ts`), loads
  the best font for each script, CJK language (kana → Japanese, Hangul → Korean, otherwise the UI
  locale), family and weight on demand, registers it with the engine (`registerFallbackFonts`) and
  declares the same face for CSS as `OPE Fallback <id>` (`extractCollectionFace` turns a face of a
  .ttc into a standalone font for the browser). Layouts re-run when `useFallbackFonts().version`
  changes; saving, printing, extracting and splitting wait for `fontsReadyFor(doc)`.
- The engine's fallback chain (`prepareText`) keeps one font per text: the bundled face if it has
  every character, otherwise the registered font that does (collections by PostScript name),
  preferring language, family, weight, then registration order. Characters no font has, and
  right-to-left text (not supported yet), become "?" and are reported in `PreparedText.missing`;
  the renderer shows a notice. `layoutText()` returns the `fontKey` the overlay passes to
  `cssFontFamily()`.
- E2E tests replace the system fonts with the OFL test fonts in `tests/fixtures/fonts` via
  `OPE_E2E_SYSTEM_FONTS` (only with `OPE_E2E=1`).

### Digital signatures

`src/core/signatures/`: `signPdf()` appends an incremental update to finished PDF bytes (the
signature field and widget appearance, the signature dictionary with /ByteRange and a /Contents
placeholder sized for the CMS, and an xref section of the same kind as the file's last one), then
hashes the byte ranges and embeds a CMS SignedData (`cms.ts`; CAdES signed attributes, SHA-256,
RSA or ECDSA). `verify.ts` finds signed fields and checks the byte ranges, message digest and
CMS signature with WebCrypto; `loadSource()` stores the results in `SourceDocument.signatures`.
`exportDocument()` removes signatures (`strip.ts`): a rewritten file would break them.
`pkcs12.ts` (node-forge for PKCS#12 decryption) turns a .p12/.pfx into a non-extractable
WebCrypto key; it is used by the main process (`src/main/certificates.ts`), which keeps keys per
window in memory and only signs CMS signed attributes for the renderer (`DesktopApi`
`openCertificateDialog` / `unlockCertificate` / `signWithCertificate` / `releaseCertificate`).
The renderer flow is `actions/signActions.ts` (Sign dialog, placement layer, export → sign →
Save As → reopen).

## Renderer structure

- `state/store.ts`: zustand store (document, history, view state, tool, selection).
- `pdf/pdfjs.ts`: pdf.js document cache per source (`getPdfDocument`, `getPdfPage`).
- `platform/index.ts`: `platform`, which is `window.desktop` or a browser fallback.
- `fonts/`: bundled font registration.
- Workspace (layout, viewer, thumbnails, dialogs, file actions): `App.tsx`, `components/`, `actions/`, `dialogs/`.
- Editing layer (overlay, tools, properties, forms, signature): `editing/`.

The viewer renders each page as:

```
<div data-testid="page" data-page-id data-page-index data-rotation style="position:relative">
  <canvas/>                               ← pdf.js, annotationMode ENABLE_FORMS
  <PageOverlay page pageIndex scale/>     ← editing layer, absolutely positioned on top
</div>
```

## Test ids (used by tests/e2e)

| Element | Test id / attributes |
| --- | --- |
| Welcome screen | `welcome`; buttons `welcome-open`, `welcome-new` |
| Toolbar buttons | `btn-open`, `btn-save`, `btn-save-as`, `btn-undo`, `btn-redo`, `btn-zoom-in`, `btn-zoom-out`, `btn-fit-width`, `btn-rotate-cw`, `btn-rotate-ccw`, `btn-delete-pages`, `btn-insert-blank`, `btn-insert-pages`, `btn-extract`, `btn-split`, `btn-properties`, `btn-watermark`, `btn-page-numbers`, `btn-ocr`, `btn-security`, `btn-sign`, `btn-print`, `btn-find` |
| Zoom label | `zoom-level` (text like `100%`) |
| Tool buttons | `tool-<ToolId>` e.g. `tool-text`, `tool-rect`, `tool-ink`, `tool-redact` |
| Redaction | `redactions-layer`; areas `redaction` with `data-redaction-id`, `data-selected`; `redaction-frame`; options `redact-fill-enabled`, `redact-fill`, `redact-overlay-text`, `redact-count`, `redact-apply`; Find `find-redact-all`; dialog checkbox `redact-sanitize` |
| Sidebar | `sidebar`; each thumbnail `thumbnail` with `data-page-id`, `data-page-index`, `data-selected="true|false"` |
| Viewer | `viewer` (scroll container); pages as above |
| Overlay | `page-overlay` (one per page) |
| Objects | `object` with `data-object-id`, `data-object-type`, `data-selected` |
| Inline text editor | `text-object-editor` (textarea) |
| Properties panel | `properties-panel` |
| Form fields | `form-field` with `data-field-name` (the input element itself) |
| Status bar | `page-count` (text: number of pages), `current-page` (1-based) |
| Dialogs | root `dialog` with `data-dialog="password|properties|watermark|page-numbers|security|extract|split|insert|signature|sign|find|ocr|redact"`; buttons `dialog-confirm`, `dialog-cancel`; password field `password-input` |
| Sign dialog | `sign-choose-certificate`, `sign-certificate-file`, `sign-password`, `sign-certificate`, `sign-field` (value `__new__` = draw a new box), `sign-reason`, `sign-location`, `sign-contact`, `sign-display-name`, `sign-show-date`, `sign-add-image` |
| Signatures | badge `signature-badge` (`data-status="valid|modified|invalid|unknown"`); tab `sidebar-tab-signatures`, panel `signatures-panel`, items `signature-item` (`data-status`, `data-field`); placement layer `signature-placement` |
| Notices | `notice` with `data-kind="info|error"`; optional button `notice-action` |
| Text recognition | toolbar `btn-ocr`; dialog `data-dialog="ocr"` with `ocr-scope-current|all|selected`, `ocr-skip-text`, `ocr-lang-<code>`, `ocr-progress`, `ocr-progress-bar`; Edit content: `ocr-line` (`data-ocr-line-id`), panel `ocr-line-text`, `ocr-make-editable`, `ocr-copy` |
| Update banner | `update-banner` with `data-status="checking|up-to-date|available|downloading|ready|error"`; `update-progress`, `update-restart`, `update-download`, `update-dismiss` |

## In-app updates

`src/main/updates`: `controller.ts` is the state machine (check → download → ready, or "available"
with a download link for builds that cannot update themselves), `installMode.ts` decides which
builds update in place (NSIS, AppImage, Developer ID signed macOS app), `index.ts` wires it to
electron-updater (loaded lazily, bundled into the main process), IPC (`UpdateState` in
`src/shared/ipc.ts`) and the Help menu. "Restart to Update" quits through the window manager's
quit sequence, so unsaved documents are saved first; it installs only on `will-quit`. The renderer
shows `components/update/UpdateBanner.tsx`. Main-process unit tests live in `tests/main`.

## Commands

```bash
npm run dev          # Electron app with hot reload
npm run dev:web      # renderer only, in a browser
npm run typecheck
npm test             # unit + component tests (Vitest)
npm run test:e2e     # builds, then runs Playwright against the Electron app
npm run dist         # installers for the current OS (electron-builder)
```
