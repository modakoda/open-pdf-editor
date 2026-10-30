/**
 * Applying redaction areas on export (internal; called by exportDocument after everything
 * else has been drawn on the pages, so EditObjects, watermarks and page numbers under an area
 * are removed as well).
 *
 * Per page with areas:
 * 1. page content is redacted (content/redact.ts): glyphs, paths, image pixels and form
 *    XObject content under the areas are removed;
 * 2. annotations whose rectangle overlaps an area are deleted (with their popups); form
 *    widgets too, and fields left without widgets are removed from the form;
 * 3. replacement texts (/ActualText, /Alt, /E) of structure elements that lost content, the
 *    page thumbnail and private application data (/PieceInfo) are removed;
 * 4. the areas are filled (optional overlay text).
 * EditObjects that overlap an area are not stored for re-editing (persist.ts): their drawings
 * stay in the page as plain, redacted content.
 *
 * With `sanitize`, content in optional-content layers hidden by default is removed from every
 * page, along with hidden annotations (the rest of sanitizing is in sanitize.ts).
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'
import { boundsOf, boxCorners, displayRotation, NOTE_ICON_SIZE, pageToPdf, type PdfBox } from './geometry'
import type { Box, EditObject, EditorDocument, PageEntry, RedactionArea, ShapeObject, TextObject } from './model'
import { redactContent, type RedactWarningCode } from './content/redact'
import { Interpreter } from './content/interpreter'
import type { Rect } from './content/matrix'
import { ResourceEditor, readPageContent, writePageContent } from './content/page'
import { drawObjectContent, isolateExistingContent, type DrawTarget } from './exportDraw'
import type { EmbedCache } from './exportFonts'
import { parseColor, rectFromArray, visibleBox } from './pdf'
import { activeRedactions, DEFAULT_REDACTION_FILL } from './redactions'
import { measureText } from './text'

const N = (s: string) => PDFName.of(s)
const REPLACEMENT_TEXT_KEYS = ['ActualText', 'Alt', 'E']

export interface RedactionPage {
  entry: PageEntry
  page: PDFPage
}

export interface RedactionOutcome {
  /** EditObjects drawn under an area: they must not be stored as editable objects. */
  burnedObjectIds: Set<string>
}

/** Area in page space → axis-aligned rectangle in PDF user space. */
function toUser(area: Box, box: PdfBox): Rect {
  const a = pageToPdf({ x: area.x, y: area.y }, box)
  const b = pageToPdf({ x: area.x + area.width, y: area.y + area.height }, box)
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
}

const overlaps = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0)

/** Whether an annotation rectangle (possibly degenerate) lies at least partly under an area. */
function rectHits(r: Rect, areas: Rect[]): boolean {
  if (r.x1 - r.x0 < 1e-6 || r.y1 - r.y0 < 1e-6) {
    return areas.some((a) => Math.max(r.x0, a.x0) <= Math.min(r.x1, a.x1) && Math.max(r.y0, a.y0) <= Math.min(r.y1, a.y1))
  }
  return areas.some((a) => overlaps(a, r))
}

/** Page-space bounds of an EditObject (including stroke width). */
export function objectBounds(obj: EditObject): Box {
  switch (obj.type) {
    case 'line': {
      const w = (obj.strokeWidth || 1) * 2
      const b = boundsOf([
        { x: obj.x1, y: obj.y1 },
        { x: obj.x2, y: obj.y2 }
      ])
      return { x: b.x - w, y: b.y - w, width: b.width + 2 * w, height: b.height + 2 * w }
    }
    case 'ink': {
      const w = (obj.strokeWidth || 1) / 2
      const b = boundsOf(obj.paths.flat())
      return { x: b.x - w, y: b.y - w, width: b.width + 2 * w, height: b.height + 2 * w }
    }
    case 'note':
      return { x: obj.x, y: obj.y, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE }
    case 'field':
      return { x: obj.x, y: obj.y, width: obj.width, height: obj.height }
    default: {
      const rotation = 'rotation' in obj ? obj.rotation : 0
      const b = boundsOf(boxCorners(obj, rotation ?? 0))
      const w = obj.type === 'rect' || obj.type === 'ellipse' ? (obj.strokeWidth || 0) / 2 : 0
      return { x: b.x - w, y: b.y - w, width: b.width + 2 * w, height: b.height + 2 * w }
    }
  }
}

function boxesOverlap(a: Box, b: Box): boolean {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
}

/**
 * Redact the exported pages (see the module comment). `warn` receives problems the user should
 * know about (e.g. an image that could not be decoded and was removed completely).
 */
export async function applyRedactions(
  out: PDFDocument,
  pages: RedactionPage[],
  doc: EditorDocument,
  objects: Map<string, EditObject[]>,
  cache: EmbedCache,
  options: { sanitize?: boolean; onWarning?: (code: RedactWarningCode, message: string) => void }
): Promise<RedactionOutcome> {
  const burnedObjectIds = new Set<string>()
  const areasByPage = new Map<string, RedactionArea[]>()
  for (const area of activeRedactions(doc, pages.map((p) => p.entry.id))) {
    const list = areasByPage.get(area.pageId) ?? []
    list.push(area)
    areasByPage.set(area.pageId, list)
  }
  if (!areasByPage.size && !options.sanitize) return { burnedObjectIds }
  // Images and fonts drawn by pdf-lib are only written into the file on flush.
  await out.flush()
  const oc = options.sanitize ? new Interpreter(out.context, { cropBox: { x: 0, y: 0, width: 0, height: 0 } }) : undefined
  for (const { entry, page } of pages) {
    const areas = areasByPage.get(entry.id) ?? []
    if (!areas.length && !options.sanitize) continue
    // A repeated page (clone) gets its own /Contents and copy-on-write resources here, so the
    // page it shares them with is not affected.
    const box = visibleBox(page)
    const userAreas = areas.map((a) => toUser(a, box))
    // Image pixels under the areas get the fill of the (first) box drawn over them.
    const fills = areas.map((a) => (a.fillColor === undefined ? DEFAULT_REDACTION_FILL : a.fillColor))
    const fill = parseColor(fills.find((f) => f) ?? '#ffffff')
    const data = readPageContent(page)
    if (data.length) {
      const res = ResourceEditor.forPage(out, page)
      const result = await redactContent(out.context, data, res, {
        areas: userAreas,
        removeHiddenLayers: options.sanitize,
        imageFill: [fill.red, fill.green, fill.blue],
        cropBox: box,
        onWarning: options.onWarning
      })
      if (result.data) {
        writePageContent(out, page, result.data)
        ;(page.node as unknown as { normalized?: boolean }).normalized = false
      }
      if (result.touchedMcids.length) stripStructReplacementText(out, page, result.touchedMcids)
    }
    removeAnnotations(out, page, userAreas, oc)
    if (!areas.length) continue
    page.node.delete(N('Thumb'))
    page.node.delete(N('PieceInfo'))
    for (const obj of objects.get(entry.id) ?? []) {
      if (areas.some((a) => boxesOverlap(objectBounds(obj), a))) burnedObjectIds.add(obj.id)
    }
    await drawAreas({ doc: out, page, box, rotation: displayRotation(entry) }, areas, cache)
  }
  return { burnedObjectIds }
}

// ---------------------------------------------------------------------------------------
// Fill boxes

async function drawAreas(t: DrawTarget, areas: RedactionArea[], cache: EmbedCache): Promise<void> {
  const visible = areas.filter((a) => a.fillColor !== null || a.overlayText?.trim())
  if (!visible.length) return
  isolateExistingContent(t.page)
  for (const area of visible) {
    const fillColor = area.fillColor === undefined ? DEFAULT_REDACTION_FILL : area.fillColor
    if (fillColor) {
      const rect: ShapeObject = {
        id: area.id,
        pageId: area.pageId,
        type: 'rect',
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        rotation: 0,
        fillColor,
        strokeColor: null,
        strokeWidth: 0
      }
      await drawObjectContent(t, rect, cache)
    }
    const text = area.overlayText?.trim()
    if (text) {
      const label = overlayLabel(area, text, fillColor, t.rotation)
      if (label) await drawObjectContent(t, label, cache)
    }
  }
}

/** Overlay text centered in the area, upright for the reader, as large as fits (4–24 pt). */
function overlayLabel(area: RedactionArea, text: string, fill: string | null, pageRotation: number): TextObject | null {
  const sideways = pageRotation === 90 || pageRotation === 270
  const boxW = sideways ? area.height : area.width
  const boxH = sideways ? area.width : area.height
  const pad = Math.min(2, boxW / 10)
  const style = { font: 'sans' as const, bold: true, italic: false }
  let size = Math.min(24, (boxH / 1.2) * 0.9)
  while (size >= 4 && measureText(text, { ...style, fontSize: size }) > boxW - 2 * pad) size *= 0.92
  if (size < 4) return null
  const rgb = fill ? parseColor(fill) : undefined
  const dark = rgb ? 0.299 * rgb.red + 0.587 * rgb.green + 0.114 * rgb.blue < 0.5 : false
  const height = size * 1.2
  const width = boxW - 2 * pad
  const cx = area.x + area.width / 2
  const cy = area.y + area.height / 2
  return {
    id: `${area.id}-text`,
    pageId: area.pageId,
    type: 'text',
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    text,
    ...style,
    fontSize: size,
    color: dark ? '#ffffff' : '#000000',
    align: 'center',
    lineHeight: 1.2,
    rotation: (360 - pageRotation) % 360,
    background: null
  }
}

// ---------------------------------------------------------------------------------------
// Annotations and form fields

function lookupDict(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o
  return v instanceof PDFDict ? v : undefined
}

/** Delete annotations under the areas (and, with `oc`, annotations in hidden layers). */
function removeAnnotations(out: PDFDocument, page: PDFPage, areas: Rect[], oc?: Interpreter): void {
  const ctx = out.context
  const annots = lookupArray(ctx, page.node.get(N('Annots')))
  if (!annots) return
  const removed = new Set<PDFDict>()
  const entries: { dict: PDFDict }[] = []
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    const dict = lookupDict(ctx, ref)
    if (!dict) continue
    entries.push({ dict })
    const rect = rectFromArray(dict.lookup(N('Rect')))
    const r: Rect | null = rect ? { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height } : null
    if ((r && areas.length && rectHits(r, areas)) || (oc && oc.ocHidden(dict.get(N('OC'))))) removed.add(dict)
  }
  if (!removed.size) return
  // Popups go with their parent annotation (and parents with a removed popup keep theirs gone).
  for (const { dict } of entries) {
    const parent = lookupDict(ctx, dict.get(N('Parent')))
    if (dict.lookup(N('Subtype')) === N('Popup') && parent && removed.has(parent)) removed.add(dict)
    const popup = lookupDict(ctx, dict.get(N('Popup')))
    if (removed.has(dict) && popup) removed.add(popup)
  }
  for (let i = annots.size() - 1; i >= 0; i--) {
    const dict = lookupDict(ctx, annots.get(i))
    if (dict && removed.has(dict)) annots.remove(i)
  }
  for (const dict of removed) {
    if (dict.lookup(N('Subtype')) === N('Widget')) detachWidget(out, dict)
  }
}

function lookupArray(ctx: PDFContext, o: PDFObject | undefined): PDFArray | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o
  return v instanceof PDFArray ? v : undefined
}

/** Remove entries of `arr` that are `dict` (directly or by reference); returns the indexes removed. */
function removeFrom(ctx: PDFContext, arr: PDFArray, dict: PDFDict): number[] {
  const removed: number[] = []
  for (let i = arr.size() - 1; i >= 0; i--) {
    const v = arr.get(i)
    if (v === dict || (v instanceof PDFRef && ctx.lookup(v) === dict)) {
      arr.remove(i)
      removed.push(i)
    }
  }
  return removed
}

/**
 * Take a widget out of the form: out of its field's /Kids (the field goes when it has no
 * widgets left), or — for a merged field/widget — the field itself; empty parents follow.
 */
function detachWidget(out: PDFDocument, widget: PDFDict): void {
  const ctx = out.context
  const acroForm = lookupDict(ctx, out.catalog.get(N('AcroForm')))
  let node: PDFDict | undefined = widget
  const isField = widget.get(N('T')) !== undefined || widget.get(N('FT')) !== undefined
  if (!isField) {
    const field = lookupDict(ctx, widget.get(N('Parent')))
    if (!field) return
    const kids = lookupArray(ctx, field.get(N('Kids')))
    if (kids) {
      const indexes = removeFrom(ctx, kids, widget)
      // Radio buttons / checkboxes: /Opt is aligned with /Kids.
      const opt = lookupArray(ctx, field.get(N('Opt')))
      if (opt && opt.size() === kids.size() + indexes.length) for (const i of indexes) opt.remove(i)
      if (kids.size() > 0) return
    }
    node = field
  }
  // Remove the (now widgetless) field and empty ancestors.
  while (node) {
    const parent = lookupDict(ctx, node.get(N('Parent')))
    if (acroForm) {
      const co = lookupArray(ctx, acroForm.get(N('CO')))
      if (co) removeFrom(ctx, co, node)
    }
    if (parent) {
      const kids = lookupArray(ctx, parent.get(N('Kids')))
      if (kids) removeFrom(ctx, kids, node)
      if (kids && kids.size() > 0) return
      node = parent
      continue
    }
    const fields = acroForm ? lookupArray(ctx, acroForm.get(N('Fields'))) : undefined
    if (fields) removeFrom(ctx, fields, node)
    return
  }
}

// ---------------------------------------------------------------------------------------
// Structure tree

/** Values of a number tree (/Nums, /Kids) by key. */
function numberTreeGet(ctx: PDFContext, node: PDFDict | undefined, key: number, depth = 0): PDFObject | undefined {
  if (!node || depth > 32) return undefined
  const nums = lookupArray(ctx, node.get(N('Nums')))
  if (nums) {
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const k = nums.lookup(i)
      if (k instanceof PDFNumber && k.asNumber() === key) return nums.get(i + 1)
    }
  }
  const kids = lookupArray(ctx, node.get(N('Kids')))
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = lookupDict(ctx, kids.get(i))
      const limits = lookupArray(ctx, kid?.get(N('Limits')))
      if (limits && limits.size() === 2) {
        const lo = limits.lookup(0)
        const hi = limits.lookup(1)
        if (lo instanceof PDFNumber && hi instanceof PDFNumber && (key < lo.asNumber() || key > hi.asNumber())) continue
      }
      const found = numberTreeGet(ctx, kid, key, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Drop /ActualText, /Alt and /E of the structure elements (and their ancestors) owning `mcids` on the page. */
function stripStructReplacementText(out: PDFDocument, page: PDFPage, mcids: number[]): void {
  const ctx = out.context
  const sp = page.node.lookup(N('StructParents'))
  if (!(sp instanceof PDFNumber)) return
  const root = lookupDict(ctx, out.catalog.get(N('StructTreeRoot')))
  const parentTree = lookupDict(ctx, root?.get(N('ParentTree')))
  const owners = lookupArray(ctx, numberTreeGet(ctx, parentTree, sp.asNumber()))
  if (!owners) return
  for (const mcid of mcids) {
    let elem = lookupDict(ctx, owners.get(mcid))
    for (let depth = 0; elem && elem !== root && depth < 64; depth++) {
      for (const key of REPLACEMENT_TEXT_KEYS) elem.delete(N(key))
      elem = lookupDict(ctx, elem.get(N('P')))
    }
  }
}
