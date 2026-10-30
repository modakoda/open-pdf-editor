/**
 * Drawing of EditObjects, watermark and page numbers onto pdf-lib pages (internal).
 *
 * Coordinates: objects are in page space (top-left of the visible box, y down). Box objects
 * are drawn in a local frame whose origin is the box center (PDF user space, y up), rotated
 * by -rotation (page-space clockwise = PDF counter-clockwise negative).
 */
import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFHexString,
  PDFName,
  PDFString,
  closePath,
  concatTransformationMatrix,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFDocument,
  type PDFOperator,
  type PDFPage,
  type PDFPageLeaf,
  type RGB
} from '@cantoo/pdf-lib'
import {
  NOTE_ICON_SIZE,
  arrowHead,
  pageToPdf,
  viewToPage,
  type PdfBox
} from './geometry'
import type {
  EditObject,
  ImageObject,
  InkObject,
  LineObject,
  NoteObject,
  PageNumberSettings,
  Point,
  Rotation,
  ShapeObject,
  TextObject,
  WatermarkSettings
} from './model'
import { parseColor } from './pdf'
import { OBJECT_MARK, regenerateAppearance } from './annotations'
import { beginObjectMark, endObjectMark } from './persist'
import { fontMetrics, layoutText, prepareText } from './text'
import type { EmbedCache } from './exportFonts'

export interface DrawTarget {
  doc: PDFDocument
  page: PDFPage
  /** Visible box of the page in PDF user space. */
  box: PdfBox
  /** Rotation the output page is displayed with. */
  rotation: Rotation
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function opacityOf(o: number | undefined, fallback = 1): number {
  return typeof o === 'number' && Number.isFinite(o) ? clamp01(o) : fallback
}

/** Undefined for fully opaque, so pdf-lib does not create needless graphics states. */
const optOpacity = (o: number) => (o < 1 ? o : undefined)

/**
 * Make sure the page's existing content cannot leave a modified graphics state / CTM that
 * displaces what we draw: original content streams get wrapped in q … Q.
 */
export function isolateExistingContent(page: PDFPage): void {
  const leaf: PDFPageLeaf = page.node
  const flags = leaf as unknown as { normalized?: boolean; autoNormalizeCTM?: boolean }
  if (flags.normalized) return
  const autoWraps = flags.autoNormalizeCTM !== false
  leaf.normalize()
  if (!autoWraps) {
    const ctx = page.doc.context
    leaf.wrapContentStreams(ctx.getPushGraphicsStateContentStream(), ctx.getPopGraphicsStateContentStream())
  }
}

function toPdf(t: DrawTarget, p: Point): Point {
  return pageToPdf(p, t.box)
}

/** Run `draw` inside q / cm (origin at `origin` in PDF space, rotated `angleCcw` degrees) / Q. */
function inFrame(page: PDFPage, origin: Point, angleCcw: number, draw: () => void): void {
  const a = (angleCcw * Math.PI) / 180
  const cos = Math.abs(Math.cos(a)) < 1e-12 ? 0 : Math.cos(a)
  const sin = Math.abs(Math.sin(a)) < 1e-12 ? 0 : Math.sin(a)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, origin.x, origin.y))
  draw()
  page.pushOperators(popGraphicsState())
}

function boxFrame(t: DrawTarget, obj: { x: number; y: number; width: number; height: number; rotation?: number }, draw: () => void) {
  const center = toPdf(t, { x: obj.x + obj.width / 2, y: obj.y + obj.height / 2 })
  inFrame(t.page, center, -(obj.rotation ?? 0), draw)
}

function graphicsState(t: DrawTarget, opacity: number, blendMode?: BlendMode): PDFName | undefined {
  if (opacity >= 1 && !blendMode) return undefined
  const dict = t.doc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity })
  if (blendMode) dict.set(PDFName.of('BM'), PDFName.of(blendMode))
  return t.page.node.newExtGState('GS', dict)
}

const colorOps = (c: RGB, stroking: boolean): PDFOperator =>
  stroking ? setStrokingRgbColor(c.red, c.green, c.blue) : setFillingRgbColor(c.red, c.green, c.blue)

async function drawText(t: DrawTarget, obj: TextObject, cache: EmbedCache): Promise<void> {
  const style = { font: obj.font, bold: obj.bold, italic: obj.italic }
  const layout = layoutText(obj)
  const resolved = prepareText(obj.text ?? '', style).font
  const hasText = layout.lines.some((l) => l.text.trim())
  if (!hasText && !obj.background) return
  const font = hasText ? await cache.font(t.doc, resolved) : undefined
  const opacity = opacityOf(obj.opacity)
  const w = obj.width
  const h = obj.height
  boxFrame(t, obj, () => {
    if (obj.background) {
      t.page.drawRectangle({
        x: -w / 2,
        y: -h / 2,
        width: w,
        height: h,
        color: parseColor(obj.background),
        opacity: optOpacity(opacity)
      })
    }
    if (!font) return
    const color = parseColor(obj.color)
    for (const line of layout.lines) {
      if (!line.text.trim()) continue
      t.page.drawText(line.text, {
        x: -w / 2 + line.x,
        y: h / 2 - line.baseline,
        size: obj.fontSize,
        font,
        color,
        opacity: optOpacity(opacity)
      })
    }
  })
}

async function drawImage(t: DrawTarget, obj: ImageObject, cache: EmbedCache): Promise<void> {
  if (!(obj.width > 0) || !(obj.height > 0)) return
  const image = await cache.image(t.doc, obj.data, obj.mimeType)
  const opacity = opacityOf(obj.opacity)
  boxFrame(t, obj, () => {
    t.page.drawImage(image, {
      x: -obj.width / 2,
      y: -obj.height / 2,
      width: obj.width,
      height: obj.height,
      opacity: optOpacity(opacity)
    })
  })
}

function drawShape(t: DrawTarget, obj: ShapeObject): void {
  const opacity = opacityOf(obj.opacity)
  const fillColor = obj.fillColor ? parseColor(obj.fillColor) : undefined
  const strokeWidth = Number.isFinite(obj.strokeWidth) && obj.strokeWidth > 0 ? obj.strokeWidth : 0
  const strokeColor = obj.strokeColor && strokeWidth > 0 ? parseColor(obj.strokeColor) : undefined
  if (!fillColor && !strokeColor) return
  const options: Record<string, unknown> = {}
  if (fillColor) {
    options.color = fillColor
    if (opacity < 1) options.opacity = opacity
  }
  if (strokeColor) {
    options.borderColor = strokeColor
    options.borderWidth = strokeWidth
    if (opacity < 1) options.borderOpacity = opacity
  }
  boxFrame(t, obj, () => {
    if (obj.type === 'ellipse') {
      t.page.drawEllipse({ x: 0, y: 0, xScale: obj.width / 2, yScale: obj.height / 2, ...options })
    } else {
      t.page.drawRectangle({ x: -obj.width / 2, y: -obj.height / 2, width: obj.width, height: obj.height, ...options })
    }
  })
}

function drawFilledBox(
  t: DrawTarget,
  obj: { x: number; y: number; width: number; height: number },
  color: string,
  opacity: number,
  blendMode?: BlendMode
): void {
  boxFrame(t, obj, () => {
    t.page.drawRectangle({
      x: -obj.width / 2,
      y: -obj.height / 2,
      width: obj.width,
      height: obj.height,
      color: parseColor(color),
      opacity: optOpacity(opacity),
      blendMode
    })
  })
}

function drawLine(t: DrawTarget, obj: LineObject): void {
  const opacity = opacityOf(obj.opacity)
  const color = parseColor(obj.color)
  const width = Number.isFinite(obj.strokeWidth) && obj.strokeWidth > 0 ? obj.strokeWidth : 1
  const head = obj.arrowEnd ? arrowHead({ ...obj, strokeWidth: width }) : null
  const start = toPdf(t, { x: obj.x1, y: obj.y1 })
  const end = toPdf(t, head ? head.base : { x: obj.x2, y: obj.y2 })
  const gs = graphicsState(t, opacity)
  const ops: PDFOperator[] = [pushGraphicsState()]
  if (gs) ops.push(setGraphicsState(gs))
  ops.push(colorOps(color, true), colorOps(color, false), setLineWidth(width))
  if (!head || Math.hypot(end.x - start.x, end.y - start.y) > 1e-6) {
    ops.push(moveTo(start.x, start.y), lineTo(end.x, end.y), stroke())
  }
  if (head) {
    const tip = toPdf(t, head.tip)
    const left = toPdf(t, head.left)
    const right = toPdf(t, head.right)
    ops.push(moveTo(tip.x, tip.y), lineTo(left.x, left.y), lineTo(right.x, right.y), closePath(), fill())
  }
  ops.push(popGraphicsState())
  t.page.pushOperators(...ops)
}

function drawInk(t: DrawTarget, obj: InkObject): void {
  const paths = (obj.paths ?? []).filter((p) => p.length > 0)
  if (!paths.length) return
  const opacity = opacityOf(obj.opacity)
  const color = parseColor(obj.color)
  const width = Number.isFinite(obj.strokeWidth) && obj.strokeWidth > 0 ? obj.strokeWidth : 1
  const gs = graphicsState(t, opacity)
  const ops: PDFOperator[] = [pushGraphicsState()]
  if (gs) ops.push(setGraphicsState(gs))
  ops.push(
    colorOps(color, true),
    setLineWidth(width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round)
  )
  for (const path of paths) {
    const first = toPdf(t, path[0])
    ops.push(moveTo(first.x, first.y))
    if (path.length === 1) {
      // A zero-length segment with round caps renders as a dot.
      ops.push(lineTo(first.x, first.y))
    } else {
      for (let i = 1; i < path.length; i++) {
        const p = toPdf(t, path[i])
        ops.push(lineTo(p.x, p.y))
      }
    }
  }
  ops.push(stroke(), popGraphicsState())
  t.page.pushOperators(...ops)
}

async function addNote(t: DrawTarget, obj: NoteObject, cache: EmbedCache): Promise<void> {
  const { x, y } = toPdf(t, { x: obj.x, y: obj.y })
  const c = parseColor(obj.color || '#ffd400')
  const S = NOTE_ICON_SIZE
  const ctx = t.doc.context
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x, y - S, x + S, y],
    Contents: PDFHexString.fromText(obj.text ?? ''),
    C: [c.red, c.green, c.blue],
    Name: 'Comment',
    Open: false,
    // Print | NoZoom | NoRotate (text annotations behave like that anyway).
    F: 28,
    M: PDFString.fromDate(new Date()),
    NM: PDFHexString.fromText(obj.id),
    P: t.page.ref
  })
  if (obj.author) dict.set(PDFName.of('T'), PDFHexString.fromText(obj.author))
  dict.set(OBJECT_MARK, PDFString.of(obj.id))
  const opacity = opacityOf(obj.opacity)
  if (opacity < 1) dict.set(PDFName.of('CA'), ctx.obj(opacity))
  // Always give the note an appearance: viewers (pdf.js among them) skip annotations without one.
  await regenerateAppearance(t.doc, dict, cache)
  t.page.node.addAnnot(ctx.register(dict))
}

/** Draw one object. Failures of a single object (e.g. a corrupt image) do not abort the export. */
/**
 * Draw one object. Content drawings are wrapped in `/OPEObject <</Id (id)>> BDC … EMC` so a
 * later export of the saved file can find and remove them (see persist.ts). Fields are
 * created separately (fieldEdits.ts); notes become annotations marked with /OPEObjectId.
 */
export async function drawObject(t: DrawTarget, obj: EditObject, cache: EmbedCache): Promise<void> {
  if (obj.type === 'field') return
  if (obj.type === 'note') return addNote(t, obj, cache)
  t.page.pushOperators(beginObjectMark(obj.id))
  try {
    await drawObjectContent(t, obj, cache)
  } finally {
    t.page.pushOperators(endObjectMark())
  }
}

async function drawObjectContent(t: DrawTarget, obj: EditObject, cache: EmbedCache): Promise<void> {
  switch (obj.type) {
    case 'text':
      return drawText(t, obj, cache)
    case 'image':
      return drawImage(t, obj, cache)
    case 'rect':
    case 'ellipse':
      return drawShape(t, obj)
    case 'highlight':
      return drawFilledBox(t, obj, obj.color || '#ffeb3b', opacityOf(obj.opacity, 0.4), BlendMode.Multiply)
    case 'whiteout':
      return drawFilledBox(t, obj, obj.color || '#ffffff', opacityOf(obj.opacity))
    case 'line':
      return drawLine(t, obj)
    case 'ink':
      return drawInk(t, obj)
    default:
      return
  }
}

/** Geometry of the displayed (rotated) page, for placing things as the reader sees them. */
function viewGeometry(t: DrawTarget) {
  return { width: t.box.width, height: t.box.height, baseRotation: 0 as Rotation, rotation: t.rotation }
}

export async function drawWatermark(t: DrawTarget, wm: WatermarkSettings, cache: EmbedCache): Promise<void> {
  if (!wm.text || !wm.text.trim()) return
  const style = { font: 'sans' as const, bold: true, italic: false }
  const fontSize = wm.fontSize > 0 ? wm.fontSize : 48
  const layout = layoutText({ ...style, text: wm.text, fontSize, lineHeight: 1.2, width: 0, align: 'center' })
  const font = await cache.font(t.doc, prepareText(wm.text, style).font)
  const color = parseColor(wm.color)
  const opacity = opacityOf(wm.opacity, 0.3)
  const center = { x: t.box.x + t.box.width / 2, y: t.box.y + t.box.height / 2 }
  // Reader-relative angle: counter-clockwise as seen on the displayed page.
  inFrame(t.page, center, t.rotation + (wm.angle || 0), () => {
    for (const line of layout.lines) {
      if (!line.text.trim()) continue
      t.page.drawText(line.text, {
        x: -layout.maxLineWidth / 2 + line.x,
        y: layout.height / 2 - line.baseline,
        size: fontSize,
        font,
        color,
        opacity: optOpacity(opacity)
      })
    }
  })
}

export function formatPageNumber(format: string, n: number, total: number): string {
  return format.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total))
}

export async function drawPageNumber(
  t: DrawTarget,
  settings: PageNumberSettings,
  index: number,
  total: number,
  cache: EmbedCache
): Promise<void> {
  const startAt = Number.isFinite(settings.startAt) ? settings.startAt : 1
  const text = formatPageNumber(settings.format || '{n}', startAt + index, total).replace(/\s*\n\s*/g, ' ')
  if (!text.trim()) return
  const style = { font: 'sans' as const, bold: false, italic: false }
  const fontSize = settings.fontSize > 0 ? settings.fontSize : 10
  const prepared = prepareText(text, style)
  const layout = layoutText({ ...style, text, fontSize, lineHeight: 1, width: 0, align: 'left' })
  const line = layout.lines[0]
  const font = await cache.font(t.doc, prepared.font)
  const { ascent, descent } = fontMetrics(prepared.font)
  const margin = Number.isFinite(settings.margin) && settings.margin >= 0 ? settings.margin : 24
  const geom = viewGeometry(t)
  const rotated = t.rotation === 90 || t.rotation === 270
  const viewW = rotated ? t.box.height : t.box.width
  const viewH = rotated ? t.box.width : t.box.height
  const [vertical, horizontal] = settings.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right']
  const vx = horizontal === 'left' ? margin : horizontal === 'right' ? viewW - margin - line.width : (viewW - line.width) / 2
  const vy = vertical === 'top' ? margin + ascent * fontSize : viewH - margin - descent * fontSize
  const origin = toPdf(t, viewToPage({ x: vx, y: vy }, geom, 1))
  inFrame(t.page, origin, t.rotation, () => {
    t.page.drawText(line.text, { x: 0, y: 0, size: fontSize, font, color: parseColor(settings.color) })
  })
}
