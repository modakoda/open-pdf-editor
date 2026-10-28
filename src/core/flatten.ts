/**
 * Burning widget appearances into page content (internal). Replaces pdf-lib's flatten,
 * which ignores the appearance stream's /Matrix and /BBox origin and also draws hidden
 * widgets.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'
import { isHiddenWidget } from './formFields'
import { rectFromArray } from './pdf'

type Matrix = [number, number, number, number, number, number]

function numbers(arr: PDFObject | undefined, n: number): number[] | undefined {
  if (!(arr instanceof PDFArray) || arr.size() < n) return undefined
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const v = arr.lookup(i)
    if (!(v instanceof PDFNumber)) return undefined
    out.push(v.asNumber())
  }
  return out.every(Number.isFinite) ? out : undefined
}

function inheritedValue(dict: PDFDict, key: PDFName): PDFObject | undefined {
  let node: PDFDict | undefined = dict
  for (let depth = 0; node && depth < 32; depth++) {
    const v = node.lookup(key)
    if (v !== undefined) return v
    const parent: PDFObject | undefined = node.lookup(PDFName.of('Parent'))
    node = parent instanceof PDFDict ? parent : undefined
  }
  return undefined
}

/** Ref of the normal appearance stream a viewer would show for this widget. */
export function normalAppearanceRef(ctx: PDFContext, widget: PDFDict): PDFRef | undefined {
  const ap = widget.lookup(PDFName.of('AP'))
  if (!(ap instanceof PDFDict)) return undefined
  const n = ap.get(PDFName.of('N'))
  const resolved = ctx.lookup(n)
  if (resolved instanceof PDFStream) return n instanceof PDFRef ? n : undefined
  if (!(resolved instanceof PDFDict)) return undefined
  let state = widget.lookup(PDFName.of('AS'))
  if (!(state instanceof PDFName)) {
    const v = inheritedValue(widget, PDFName.of('V'))
    state = v instanceof PDFName ? v : PDFName.of('Off')
  }
  const ref = resolved.get(state as PDFName) ?? resolved.get(PDFName.of('Off'))
  return ref instanceof PDFRef && ctx.lookup(ref) instanceof PDFStream ? ref : undefined
}

/** Matrix mapping the appearance's (transformed) BBox onto the widget Rect (Algorithm 8.1). */
export function appearanceToRectMatrix(ctx: PDFContext, widget: PDFDict, apRef: PDFRef): Matrix | undefined {
  const rect = rectFromArray(widget.lookup(PDFName.of('Rect')))
  const stream = ctx.lookup(apRef)
  if (!rect || !(stream instanceof PDFStream) || rect.width <= 0 || rect.height <= 0) return undefined
  const bbox = numbers(stream.dict.lookup(PDFName.of('BBox')), 4)
  if (!bbox) return undefined
  const m = (numbers(stream.dict.lookup(PDFName.of('Matrix')), 6) ?? [1, 0, 0, 1, 0, 0]) as Matrix
  const corners = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]]
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const w = Math.max(...xs) - minX
  const h = Math.max(...ys) - minY
  if (!(w > 0) || !(h > 0)) return undefined
  const sx = rect.width / w
  const sy = rect.height / h
  return [sx, 0, 0, sy, rect.x - minX * sx, rect.y - minY * sy]
}

/** Draw a widget's current appearance onto `page` (which may be another page than its own). */
export function burnWidget(doc: PDFDocument, page: PDFPage, widget: PDFDict): boolean {
  if (isHiddenWidget(widget)) return false
  const apRef = normalAppearanceRef(doc.context, widget)
  if (!apRef) return false
  const m = appearanceToRectMatrix(doc.context, widget, apRef)
  if (!m) return false
  const name = page.node.newXObject('FlatWidget', apRef)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(name), popGraphicsState())
  return true
}

const isWidget = (d: PDFObject | undefined): d is PDFDict =>
  d instanceof PDFDict && d.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')

/** Widget annotation dicts on a page, in /Annots order. */
export function pageWidgets(doc: PDFDocument, page: PDFPage): PDFDict[] {
  const annots = page.node.Annots()
  if (!annots) return []
  const out: PDFDict[] = []
  for (let i = 0; i < annots.size(); i++) {
    const a = doc.context.lookup(annots.get(i))
    if (isWidget(a)) out.push(a)
  }
  return out
}

/**
 * Burn every widget (form fields and orphan widgets) into the content of its page, remove
 * the widget annotations and the AcroForm. Hidden / NoView widgets are dropped unseen.
 */
export function flattenAllWidgets(doc: PDFDocument, pages: PDFPage[]): void {
  for (const page of pages) {
    const annots = page.node.Annots()
    if (!annots) continue
    const kept: PDFObject[] = []
    let changed = false
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i)
      const a = doc.context.lookup(entry)
      if (!isWidget(a)) {
        kept.push(entry)
        continue
      }
      changed = true
      burnWidget(doc, page, a)
    }
    if (changed) page.node.set(PDFName.of('Annots'), doc.context.obj(kept))
  }
  doc.catalog.delete(PDFName.of('AcroForm'))
}
