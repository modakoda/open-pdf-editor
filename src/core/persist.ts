/**
 * Keeping EditObjects editable across save + reopen (internal).
 *
 * On export every page with EditObjects gets
 *   /PieceInfo << /OpenPDFEditor << /LastModified (D:…) /Private << … >> >> >>
 * and the same /LastModified on the page. /Private holds the objects as JSON (images
 * replaced by references to streams with the original file bytes) and a fingerprint of the
 * page's final content. Drawings of the objects are wrapped in marked content
 * (`/OPEObject <</Id (id)>> BDC … EMC`, see exportDraw.ts) and notes / fields carry
 * /OPEObjectId, so a later export can remove them before drawing the objects again.
 *
 * On load the objects are restored only if the data is intact and the page has not been
 * modified since (dates match, fingerprint matches, JSON valid, ids unique).
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'
import type { Box, EditObject, OcrLine, OcrPageResult, OcrWord, Point } from './model'

const N = (s: string) => PDFName.of(s)
const APP = N('OpenPDFEditor')

/** Marked-content tag wrapping drawings of EditObjects (same as content/OPE_MARK). */
const OBJECT_TAG = 'OPEObject'

/** `/OPEObject << /Id (id) >> BDC` for drawings that belong to an EditObject. */
export function beginObjectMark(id: string): PDFOperator {
  // Inline property list, written verbatim (pdf-lib's operator args do not include dicts).
  const props = `<< /Id (${id.replace(/[\\()]/g, (c) => `\\${c}`)}) >>`
  return PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(OBJECT_TAG), props])
}

export function endObjectMark(): PDFOperator {
  return PDFOperator.of(PDFOperatorNames.EndMarkedContent)
}
const FORMAT_VERSION = 1

// ---------------------------------------------------------------------------------------
// Content fingerprint
// ---------------------------------------------------------------------------------------

function streamBytes(ctx: PDFContext, obj: PDFObject | undefined): Uint8Array | undefined {
  const s = ctx.lookup(obj)
  if (!(s instanceof PDFStream)) return undefined
  const withUnencoded = s as unknown as { getUnencodedContents?: () => Uint8Array }
  if (typeof withUnencoded.getUnencodedContents === 'function') return withUnencoded.getUnencodedContents()
  if (s instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(s).decode()
    } catch {
      return s.getContents()
    }
  }
  return undefined
}

/** FNV-1a (two seeds) over the page's decoded content streams, plus total length. */
export function contentFingerprint(ctx: PDFContext, page: PDFPage): string {
  const contents = page.node.get(N('Contents'))
  const resolved = ctx.lookup(contents)
  const parts: (Uint8Array | undefined)[] = []
  if (resolved instanceof PDFArray) for (let i = 0; i < resolved.size(); i++) parts.push(streamBytes(ctx, resolved.get(i)))
  else if (contents) parts.push(streamBytes(ctx, contents))
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  let length = 0
  for (const p of parts) {
    const bytes = p ?? new Uint8Array()
    for (let i = 0; i <= bytes.length; i++) {
      const b = i < bytes.length ? bytes[i] : 0x0a // separator between streams
      h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ b, 0x01000193 + 0x2) >>> 0
    }
    length += bytes.length + 1
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}-${length}`
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

type StoredObject = Omit<EditObject, 'pageId'> & { data?: unknown }

/** Remove our page-piece data (stale after the page changed). */
export function clearPageObjects(page: PDFPage): void {
  const piece = page.node.lookup(N('PieceInfo'))
  if (!(piece instanceof PDFDict) || !piece.get(APP)) return
  // A copy: duplicated pages may share the same /PieceInfo dictionary.
  const copy = piece.clone()
  copy.delete(APP)
  if (copy.keys().length) page.node.set(N('PieceInfo'), copy)
  else page.node.delete(N('PieceInfo'))
}

/**
 * Store `objects` (the page's EditObjects, in z-order) and the page's OCR result in the page's
 * /PieceInfo. Call after all drawing.
 */
export function writePageObjects(
  pdf: PDFDocument,
  page: PDFPage,
  objects: EditObject[],
  lastModified: PDFString,
  ocr?: OcrPageResult
): void {
  const ctx = pdf.context
  const images = new Map<Uint8Array, string>()
  const imageDict = ctx.obj({})
  const stored: StoredObject[] = objects.map((o) => {
    const { pageId: _pageId, ...rest } = o
    if (o.type !== 'image') return rest
    let key = images.get(o.data)
    if (!key) {
      key = `Im${images.size}`
      images.set(o.data, key)
      imageDict.set(N(key), ctx.register(ctx.stream(o.data, { MimeType: PDFString.of(o.mimeType) } as never)))
    }
    return { ...rest, data: { $image: key } }
  })
  const json = JSON.stringify({ version: FORMAT_VERSION, objects: stored, ...(ocr ? { ocr } : {}) })
  const objectsStream = ctx.register(ctx.flateStream(new TextEncoder().encode(json)))
  const priv = ctx.obj({
    Version: FORMAT_VERSION,
    Objects: objectsStream,
    Images: imageDict,
    ContentFingerprint: PDFString.of(contentFingerprint(ctx, page))
  })
  // Always a fresh copy: duplicated pages may share the same /PieceInfo dictionary.
  const existing = page.node.lookup(N('PieceInfo'))
  const piece = existing instanceof PDFDict ? existing.clone() : ctx.obj({})
  piece.set(APP, ctx.obj({ LastModified: lastModified, Private: priv }))
  page.node.set(N('PieceInfo'), piece)
  page.node.set(N('LastModified'), lastModified)
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isColor = (v: unknown) => isStr(v)
const isPoint = (p: unknown): p is Point => !!p && typeof p === 'object' && isNum((p as Point).x) && isNum((p as Point).y)
const isBox = (o: Record<string, unknown>) => isNum(o.x) && isNum(o.y) && isNum(o.width) && isNum(o.height)

function validObject(o: Record<string, unknown>): boolean {
  if (!isStr(o.id) || !o.id || !isStr(o.type)) return false
  if (o.opacity !== undefined && !isNum(o.opacity)) return false
  switch (o.type) {
    case 'text':
      return isBox(o) && isStr(o.text) && ['sans', 'serif', 'mono'].includes(o.font as string) && isNum(o.fontSize) && isColor(o.color)
    case 'image':
      return isBox(o) && (o.mimeType === 'image/png' || o.mimeType === 'image/jpeg') && o.data instanceof Uint8Array
    case 'rect':
    case 'ellipse':
      return isBox(o) && isNum(o.strokeWidth)
    case 'highlight':
    case 'whiteout':
      return isBox(o) && isColor(o.color)
    case 'line':
      return isNum(o.x1) && isNum(o.y1) && isNum(o.x2) && isNum(o.y2) && isColor(o.color) && isNum(o.strokeWidth)
    case 'ink':
      return Array.isArray(o.paths) && o.paths.every((p) => Array.isArray(p) && p.every(isPoint)) && isColor(o.color)
    case 'note':
      return isNum(o.x) && isNum(o.y) && isStr(o.text) && isColor(o.color)
    case 'field':
      return (
        isBox(o) &&
        isStr(o.name) &&
        !!o.name &&
        ['text', 'checkbox', 'radio', 'dropdown', 'optionlist', 'signature'].includes(o.fieldType as string)
      )
    default:
      return false
  }
}

function dateText(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined
}

function decodeStream(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | undefined {
  const s = ctx.lookup(o)
  if (!(s instanceof PDFRawStream)) return undefined
  try {
    return decodePDFRawStream(s).decode()
  } catch {
    return undefined
  }
}

function validOcr(o: unknown): o is OcrPageResult {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  const isBoxValue = (b: unknown): b is Box => !!b && typeof b === 'object' && isBox(b as Record<string, unknown>)
  const validWord = (w: unknown) => {
    const word = w as OcrWord | null
    return !!word && isStr(word.text) && isBoxValue(word.box) && isNum(word.confidence)
  }
  const ids = new Set<string>()
  const validLine = (l: unknown) => {
    const line = l as OcrLine | null
    if (!line || !isStr(line.id) || ids.has(line.id) || !isBoxValue(line.box) || !isNum(line.baseline)) return false
    if (line.background !== undefined && !isColor(line.background)) return false
    if (line.color !== undefined && !isColor(line.color)) return false
    ids.add(line.id)
    return Array.isArray(line.words) && line.words.every(validWord)
  }
  return (
    Array.isArray(r.languages) &&
    r.languages.every(isStr) &&
    [0, 90, 180, 270].includes(r.rotation as number) &&
    Array.isArray(r.lines) &&
    r.lines.every(validLine)
  )
}

/**
 * Objects stored on the page by an earlier export, with pageId '' (the caller assigns it).
 * Undefined when there is no data or it cannot be trusted.
 */
export function readPageObjects(pdf: PDFDocument, page: PDFPage): EditObject[] | undefined {
  return readPageData(pdf, page)?.objects
}

/**
 * Everything stored on the page by an earlier export: its EditObjects (pageId '') and its OCR
 * result. Undefined when there is no data or it cannot be trusted.
 */
export function readPageData(pdf: PDFDocument, page: PDFPage): { objects: EditObject[]; ocr?: OcrPageResult } | undefined {
  const ctx = pdf.context
  try {
    const piece = page.node.lookup(N('PieceInfo'))
    if (!(piece instanceof PDFDict)) return undefined
    const data = piece.lookup(APP)
    if (!(data instanceof PDFDict)) return undefined
    const lm = dateText(data.lookup(N('LastModified')))
    const pageLm = dateText(page.node.lookup(N('LastModified')))
    if (!lm || lm !== pageLm) return undefined
    const priv = data.lookup(N('Private'))
    if (!(priv instanceof PDFDict)) return undefined
    const version = priv.lookup(N('Version'))
    if (!(version instanceof PDFNumber) || version.asNumber() !== FORMAT_VERSION) return undefined
    if (dateText(priv.lookup(N('ContentFingerprint'))) !== contentFingerprint(ctx, page)) return undefined
    const json = decodeStream(ctx, priv.get(N('Objects')))
    if (!json) return undefined
    const parsed = JSON.parse(new TextDecoder().decode(json)) as { version?: unknown; objects?: unknown; ocr?: unknown }
    if (parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.objects)) return undefined
    if (parsed.ocr !== undefined && !validOcr(parsed.ocr)) return undefined
    const images = priv.lookup(N('Images'))
    const ids = new Set<string>()
    const objects: EditObject[] = []
    for (const raw of parsed.objects as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object') return undefined
      const o: Record<string, unknown> = { ...raw, pageId: '' }
      if (o.type === 'image') {
        const key = (raw.data as { $image?: unknown } | undefined)?.$image
        if (!isStr(key) || !(images instanceof PDFDict)) return undefined
        const bytes = decodeStream(ctx, images.get(N(key)))
        if (!bytes) return undefined
        o.data = bytes
      }
      if (!validObject(o) || ids.has(o.id as string)) return undefined
      ids.add(o.id as string)
      objects.push(o as unknown as EditObject)
    }
    return parsed.ocr ? { objects, ocr: parsed.ocr as OcrPageResult } : { objects }
  } catch {
    return undefined
  }
}
