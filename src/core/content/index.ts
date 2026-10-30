/**
 * Content-stream engine: finds the items drawn on a page (text runs, images, vector paths,
 * form XObjects, shadings) and rewrites the page's content to delete, move/transform,
 * re-color or re-type them. Operates on pdf-lib objects; used by export.ts and load.ts.
 *
 * Item ids must be stable for the same page content (e.g. derived from operator positions),
 * because ContentEdits saved in the editor's undo history refer to them.
 *
 * Ids: `t<n>` text, `p<n>` path, `i<n>` image (XObject or inline), `x<n>` form XObject,
 * `s<n>` shading, where n is the index of the item's (first) operator in the page content;
 * `t<n>.<k>` for the k-th further text item starting in the same operator (TJ arrays split at
 * column gaps); `x<n>/<id>` for items inside the form XObject drawn by operator n (listed when
 * that XObject is drawn once; up to 3 levels). Drawings of editor objects
 * (`/OPEObject <</Id (…)>> BDC … EMC`) do not take part in the numbering, so adding or
 * stripping them does not change other ids.
 *
 * Predefined CJK CMaps (90ms-RKSJ-H, GBK-EUC-H, UniJIS-UCS2-H, …) are loaded through a
 * synchronous loader: in Node the .bcmap files of pdfjs-dist are read by default; in the
 * renderer call setCMapLoader(name => bytes | null) (e.g. with preloaded /pdfjs/cmaps/<name>.bcmap
 * files). Text in fonts whose CMap is unavailable is listed with `readOnly: true` and edits of it
 * are ignored.
 *
 * Usage notes for callers:
 * - Call applyContentEdits() before drawing anything else on the page with pdf-lib (pdf-lib
 *   wraps existing content in an extra `q` stream when drawing, which shifts operator indices),
 *   and with the same `skipMarked` that was used for listing.
 * - stripMarkedContent() can be called before or after applyContentEdits().
 */
import type { PDFDocument, PDFFont, PDFPage } from '@cantoo/pdf-lib'
import type { PdfBox } from '../geometry'
import type { ContentEdit, ContentItem } from '../model'
import type { ResolvedTextFont } from '../text'
import { OPE_MARK as MARK, interpret } from './interpreter'
import { parseContent } from './lexer'
import { pageResources, readPageContent } from './page'
import { applyEdits, stripMarked } from './rewrite'

export { setCMapLoader, type CMapLoader } from './cmap'

/** Marked-content tag wrapping drawings of EditObjects: `/OPEObject <</Id (obj_id)>> BDC … EMC`. */
export const OPE_MARK = MARK

export interface ContentEditHelpers {
  /** Embed (or reuse) the fallback font for replacement text that the original font cannot encode. */
  embedFont(font: ResolvedTextFont): Promise<PDFFont>
}

/**
 * Parse the page's content (all /Contents streams, resolving resources and fonts) into items,
 * in page space given the page's visible box. Content inside OPE_MARK sections whose id is in
 * `skipMarked` is ignored.
 */
export function listContentItems(
  pdfDoc: PDFDocument,
  page: PDFPage,
  cropBox: PdfBox,
  skipMarked?: Set<string>
): ContentItem[] {
  const data = readPageContent(page)
  if (!data.length) return []
  const interp = interpret(pdfDoc.context, data, parseContent(data), pageResources(page), { cropBox, skipMarked })
  return interp.records.map((r) => r.item)
}

/**
 * Rewrite the page content so that `edits` (item ids from listContentItems with the same
 * arguments) take effect: deleted items are removed, transformed items are redrawn with the
 * extra page-space transform, text items get new text / color / size. Everything else must
 * render exactly as before.
 */
export async function applyContentEdits(
  pdfDoc: PDFDocument,
  page: PDFPage,
  cropBox: PdfBox,
  edits: ContentEdit[],
  helpers: ContentEditHelpers,
  skipMarked?: Set<string>
): Promise<void> {
  await applyEdits(pdfDoc, page, cropBox, edits, helpers, skipMarked)
}

/** Remove OPE_MARK marked-content sections (all of them, or only those whose id is in `ids`). */
export function stripMarkedContent(pdfDoc: PDFDocument, page: PDFPage, ids?: Set<string>): void {
  stripMarked(pdfDoc, page, ids)
}
