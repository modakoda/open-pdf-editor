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

### Fonts

Text objects use `font: 'sans' | 'serif' | 'mono'`. Text encodable in WinAnsi is exported with the
standard PDF fonts (Helvetica/Times/Courier families, not embedded). Other text (e.g. Lithuanian,
Greek, Cyrillic) is exported with the bundled Noto fonts (`resources/fonts`, embedded as subsets).
`layoutText()` in `src/core/text.ts` computes line breaks for both the overlay and the exporter,
so wrapping on screen matches the saved file. The renderer registers the font bytes at startup
(`src/renderer/src/fonts/fonts.ts`) and declares them for CSS as `OPE Noto Sans`,
`OPE Noto Serif`, `OPE Noto Sans Mono` (`fonts.css`).

## Renderer structure

- `state/store.ts` — zustand store (document, history, view state, tool, selection).
- `pdf/pdfjs.ts` — pdf.js document cache per source (`getPdfDocument`, `getPdfPage`).
- `platform/index.ts` — `platform`: `window.desktop` or a browser fallback.
- `fonts/` — bundled font registration.
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
| Toolbar buttons | `btn-open`, `btn-save`, `btn-save-as`, `btn-undo`, `btn-redo`, `btn-zoom-in`, `btn-zoom-out`, `btn-fit-width`, `btn-rotate-cw`, `btn-rotate-ccw`, `btn-delete-pages`, `btn-insert-blank`, `btn-insert-pages`, `btn-extract`, `btn-split`, `btn-properties`, `btn-watermark`, `btn-page-numbers`, `btn-security`, `btn-print`, `btn-find` |
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
| Dialogs | root `dialog` with `data-dialog="password|properties|watermark|page-numbers|security|extract|split|insert|signature|find|redact"`; buttons `dialog-confirm`, `dialog-cancel`; password field `password-input` |
| Notices | `notice` with `data-kind="info|error"` |

## Commands

```bash
npm run dev          # Electron app with hot reload
npm run dev:web      # renderer only, in a browser
npm run typecheck
npm test             # unit + component tests (Vitest)
npm run test:e2e     # builds, then runs Playwright against the Electron app
npm run dist         # installers for the current OS (electron-builder)
```
