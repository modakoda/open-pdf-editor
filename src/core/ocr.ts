/**
 * Text recognition (OCR) results in the document model: building them from a recognized page
 * image, pure operations on EditorDocument.ocr, scanned-page detection and turning a recognized
 * line into an editable TextObject. The recognition itself runs in the renderer (tesseract.js);
 * the exporter writes the words as invisible text (exportOcr.ts).
 */
import { createId } from './ids'
import { clamp, displayRotation, viewToPage, boundsOf } from './geometry'
import type {
  Box,
  Color,
  ContentItem,
  EditorDocument,
  FontFamily,
  OcrLine,
  OcrPageResult,
  OcrWord,
  PageEntry,
  Point,
  Rotation,
  TextObject,
  WhiteoutObject
} from './model'
import { firstBaselineOffset, measureText, prepareText } from './text'

/**
 * Id of the marked-content section (`/OPEObject <</Id (…)>> BDC … EMC`) holding the invisible
 * text layer written for OCR results. Restored like an EditObject's drawing (see
 * SourcePageInfo.restoredOcr), so a later save replaces the layer instead of adding another.
 */
export const OCR_LAYER_ID = 'ope-ocr-layer'

/** Languages whose recognition data is bundled with the app. */
export const OCR_LANGUAGES = [
  { code: 'eng', label: 'English' },
  { code: 'lit', label: 'Lithuanian' }
] as const

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]['code']

// ---------------------------------------------------------------------------------------------
// Reading orientation

/** Unit vectors (page space) of the reading x axis (`u`, along the text) and y axis (`v`, down). */
export function readingAxes(rotation: Rotation): { u: Point; v: Point } {
  switch (rotation) {
    case 0:
      return { u: { x: 1, y: 0 }, v: { x: 0, y: 1 } }
    case 90:
      return { u: { x: 0, y: -1 }, v: { x: 1, y: 0 } }
    case 180:
      return { u: { x: -1, y: 0 }, v: { x: 0, y: -1 } }
    case 270:
      return { u: { x: 0, y: 1 }, v: { x: -1, y: 0 } }
  }
}

/** A page-space box seen in reading orientation. */
export interface ReadingFrame {
  /** Reading top-left corner, in page space. */
  origin: Point
  u: Point
  v: Point
  /** Extent along u and v. */
  width: number
  height: number
}

export function readingFrame(box: Box, rotation: Rotation): ReadingFrame {
  const { u, v } = readingAxes(rotation)
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ]
  const score = (p: Point) => p.x * (u.x + v.x) + p.y * (u.y + v.y)
  const origin = corners.reduce((best, p) => (score(p) < score(best) ? p : best))
  const sideways = rotation === 90 || rotation === 270
  return { origin, u, v, width: sideways ? box.height : box.width, height: sideways ? box.width : box.height }
}

/** Point at reading coordinates (x along the text, y down) of a frame, in page space. */
export function readingPoint(frame: Pick<ReadingFrame, 'origin' | 'u' | 'v'>, x: number, y: number): Point {
  return {
    x: frame.origin.x + frame.u.x * x + frame.v.x * y,
    y: frame.origin.y + frame.u.y * x + frame.v.y * y
  }
}

/** Reading coordinates of a page-space point in a frame. */
export function toReading(frame: Pick<ReadingFrame, 'origin' | 'u' | 'v'>, p: Point): Point {
  const dx = p.x - frame.origin.x
  const dy = p.y - frame.origin.y
  return { x: dx * frame.u.x + dy * frame.u.y, y: dx * frame.v.x + dy * frame.v.y }
}

// ---------------------------------------------------------------------------------------------
// Building results from a recognized image

export interface PixelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A line as reported by the recognizer, in pixels of the page image (upright for reading). */
export interface RecognizedLine {
  bbox: PixelBox
  /** Baseline from (x0, y0) to (x1, y1), when known. */
  baseline?: PixelBox | null
  words: { text: string; confidence: number; bbox: PixelBox }[]
  background?: Color
  color?: Color
}

/**
 * Convert recognized lines to an OcrPageResult. The image is the page rendered at `scale`
 * pixels per point with its displayed rotation (displayRotation(page)), as pdf.js renders it.
 */
export function ocrResultFromRecognition(
  page: Pick<PageEntry, 'width' | 'height' | 'baseRotation' | 'rotation'>,
  scale: number,
  languages: string[],
  recognized: RecognizedLine[]
): OcrPageResult {
  const rotation = displayRotation(page)
  const toPageBox = (b: PixelBox): Box => {
    const pts = [
      viewToPage({ x: b.x0, y: b.y0 }, page, scale),
      viewToPage({ x: b.x1, y: b.y1 }, page, scale)
    ]
    const r = boundsOf(pts)
    return roundBox({
      x: clamp(r.x, 0, page.width),
      y: clamp(r.y, 0, page.height),
      width: Math.min(r.width, page.width),
      height: Math.min(r.height, page.height)
    })
  }
  const lines: OcrLine[] = []
  for (const line of recognized) {
    const words: OcrWord[] = []
    for (const w of line.words) {
      const text = w.text.replace(/\s+/g, ' ').trim()
      if (!text || !(w.bbox.x1 > w.bbox.x0) || !(w.bbox.y1 > w.bbox.y0)) continue
      words.push({ text, box: toPageBox(w.bbox), confidence: round2(clamp(w.confidence, 0, 100)) })
    }
    if (!words.length) continue
    const height = line.bbox.y1 - line.bbox.y0
    if (!(height > 0)) continue
    let baselinePx = height * 0.8
    const b = line.baseline
    if (b && Number.isFinite(b.y0) && Number.isFinite(b.y1) && (b.x0 !== 0 || b.x1 !== 0 || b.y0 !== 0 || b.y1 !== 0)) {
      const mid = (b.y0 + b.y1) / 2 - line.bbox.y0
      if (mid > height * 0.3 && mid <= height * 1.05) baselinePx = Math.min(mid, height)
    }
    const out: OcrLine = { id: `l${lines.length}`, words, box: toPageBox(line.bbox), baseline: round2(baselinePx / scale) }
    if (line.background) out.background = line.background
    if (line.color) out.color = line.color
    lines.push(out)
  }
  return { languages: [...languages], rotation, lines }
}

// ---------------------------------------------------------------------------------------------
// Queries and operations

export function getPageOcr(doc: EditorDocument, pageId: string): OcrPageResult | undefined {
  return doc.ocr?.[pageId]
}

export function ocrLineText(line: OcrLine): string {
  return line.words.map((w) => w.text).join(' ')
}

/** Recognized text of a page, one line per recognized line. */
export function ocrPageText(result: OcrPageResult): string {
  return result.lines.map(ocrLineText).join('\n')
}

/** Store (or with null remove) the OCR results of pages. Pages that are not in the document are ignored. */
export function setOcrResults(doc: EditorDocument, results: Record<string, OcrPageResult | null>): EditorDocument {
  const pageIds = new Set(doc.pages.map((p) => p.id))
  const ocr = { ...doc.ocr }
  let changed = false
  for (const [pageId, result] of Object.entries(results)) {
    if (!pageIds.has(pageId)) continue
    if (result) ocr[pageId] = result
    else if (pageId in ocr) delete ocr[pageId]
    else continue
    changed = true
  }
  return changed ? { ...doc, ocr } : doc
}

export function setPageOcr(doc: EditorDocument, pageId: string, result: OcrPageResult | null): EditorDocument {
  return setOcrResults(doc, { [pageId]: result })
}

/** Remove one recognized line (e.g. after it was turned into a TextObject). */
export function removeOcrLine(doc: EditorDocument, pageId: string, lineId: string): EditorDocument {
  const result = doc.ocr?.[pageId]
  if (!result || !result.lines.some((l) => l.id === lineId)) return doc
  return setPageOcr(doc, pageId, { ...result, lines: result.lines.filter((l) => l.id !== lineId) })
}

// ---------------------------------------------------------------------------------------------
// Scanned pages

/**
 * Whether a page looks scanned: it has no text and one image covers most of it.
 * `items` are the page's content items (getContentItems).
 */
export function looksScanned(items: ContentItem[], page: Pick<PageEntry, 'width' | 'height'>): boolean {
  if (items.some((i) => i.kind === 'text' && !!i.text?.trim())) return false
  const area = page.width * page.height
  if (!(area > 0)) return false
  return items.some((i) => {
    if (i.kind !== 'image') return false
    const x0 = Math.max(0, i.bounds.x)
    const y0 = Math.max(0, i.bounds.y)
    const x1 = Math.min(page.width, i.bounds.x + i.bounds.width)
    const y1 = Math.min(page.height, i.bounds.y + i.bounds.height)
    return x1 > x0 && y1 > y0 && ((x1 - x0) * (y1 - y0)) / area >= 0.5
  })
}

/** Whether the page has text of its own (not recognized by OCR). */
export function hasText(items: ContentItem[]): boolean {
  return items.some((i) => i.kind === 'text' && !!i.text?.trim())
}

// ---------------------------------------------------------------------------------------------
// Make editable

/** Typical cap height of the bundled / standard sans fonts, as a fraction of the font size. */
const CAP_HEIGHT = 0.72

export interface MakeEditableOptions {
  font?: FontFamily
  /** Override the colors sampled from the scan. */
  color?: Color
  background?: Color
}

/**
 * Turn a recognized line into editable content: a whiteout covering the line in the scan and a
 * TextObject with the recognized text on the line's baseline, upright in reading orientation.
 * The line is removed from the OCR result (its text now lives in the TextObject). Returns null
 * when the line does not exist.
 */
export function makeOcrLineEditable(
  doc: EditorDocument,
  pageId: string,
  lineId: string,
  options: MakeEditableOptions = {}
): { doc: EditorDocument; text: TextObject; cover: WhiteoutObject } | null {
  const page = doc.pages.find((p) => p.id === pageId)
  const result = doc.ocr?.[pageId]
  const line = result?.lines.find((l) => l.id === lineId)
  if (!page || !result || !line) return null
  const font = options.font ?? 'sans'
  const style = { font, bold: false, italic: false }
  const text = ocrLineText(line)
  const frame = readingFrame(line.box, result.rotation)
  const baseline = clamp(line.baseline, frame.height * 0.3, frame.height)

  // Size: the text above the baseline is about a cap height; never much larger than the line.
  let fontSize = clamp(baseline / CAP_HEIGHT, frame.height * 0.6, frame.height * 1.4)
  const natural = measureText(text, { ...style, fontSize })
  if (natural > frame.width && natural > 0) fontSize *= frame.width / natural
  fontSize = Math.max(1, round2(fontSize))
  const lineHeight = 1.2
  const width = Math.max(frame.width, measureText(text, { ...style, fontSize })) + 1
  const height = lineHeight * fontSize
  const resolved = prepareText(text, style).font
  const top = baseline - firstBaselineOffset(resolved, fontSize, lineHeight)
  const center = readingPoint(frame, width / 2, top + height / 2)

  const pad = Math.max(1, frame.height * 0.12)
  const coverBox = {
    x: clamp(line.box.x - pad, 0, page.width),
    y: clamp(line.box.y - pad, 0, page.height),
    width: 0,
    height: 0
  }
  coverBox.width = Math.min(page.width, line.box.x + line.box.width + pad) - coverBox.x
  coverBox.height = Math.min(page.height, line.box.y + line.box.height + pad) - coverBox.y
  const cover: WhiteoutObject = {
    id: createId('obj'),
    pageId,
    type: 'whiteout',
    ...roundBox(coverBox),
    color: options.background ?? line.background ?? '#ffffff'
  }
  const textObj: TextObject = {
    id: createId('obj'),
    pageId,
    type: 'text',
    ...roundBox({ x: center.x - width / 2, y: center.y - height / 2, width, height }),
    text,
    font,
    bold: false,
    italic: false,
    fontSize,
    color: options.color ?? line.color ?? '#000000',
    align: 'left',
    lineHeight,
    rotation: (360 - result.rotation) % 360,
    background: null
  }
  const next = removeOcrLine({ ...doc, objects: [...doc.objects, cover, textObj] }, pageId, lineId)
  return { doc: next, text: textObj, cover }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function roundBox(b: Box): Box {
  return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) }
}
