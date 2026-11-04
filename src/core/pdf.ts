/**
 * Internal pdf-lib helpers shared by load.ts and export.ts (not part of the public API).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  rgb,
  type PDFObject,
  type PDFPage,
  type PDFWidgetAnnotation,
  type RGB
} from '@cantoo/pdf-lib'
import { InvalidPasswordError, PasswordRequiredError, PdfLoadError } from './errors'
import { intersectBoxes, normalizeRotation, type PdfBox } from './geometry'
import type { DocumentPermissions, Rotation } from './model'
import { identifyPassword, type StandardSecurityInfo } from './pdfCrypto'
import { permissionsFromFlags, readSecurityInfo } from './security'

/** pdf-lib yields to the event loop every N parsed objects; keeps the UI responsive on big files. */
const PARSE_SPEED = 1500

export interface OpenedPdf {
  doc: PDFDocument
  isEncrypted: boolean
  /** Password that decrypted the file ('' for owner-password-only files). */
  password?: string
  /** Whether `password` is the user or the owner password (when determinable). */
  passwordKind?: 'user' | 'owner'
  /** The user password, when known. */
  userPassword?: string
  /** Permissions for user-password holders (from /P). */
  permissions?: DocumentPermissions
  /** Standard security handler parameters of the encrypted file. */
  security?: StandardSecurityInfo
}

export interface OpenPdfOptions {
  /** Skip password identification (export only needs the decrypted document). */
  identify?: boolean
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Load a PDF with pdf-lib, decrypting it if needed.
 * - not encrypted: `password` is ignored.
 * - encrypted, `password` undefined: the empty password is tried (owner-password-only files),
 *   otherwise PasswordRequiredError.
 * - encrypted, wrong `password`: InvalidPasswordError.
 * - unparseable: PdfLoadError.
 * The input bytes are copied, so pdf-lib can never alias or modify them.
 */
export async function openPdfLib(bytes: Uint8Array, password?: string, options: OpenPdfOptions = {}): Promise<OpenedPdf> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new PdfLoadError('The file is empty.')
  const data = bytes.slice()
  let raw: PDFDocument
  try {
    raw = await PDFDocument.load(data, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
      parseSpeed: PARSE_SPEED
    })
    // Touch the page tree so structurally broken files fail here, not later.
    raw.getPageCount()
  } catch (e) {
    throw new PdfLoadError(`The file could not be read as a PDF (${errorMessage(e)}).`, { cause: e })
  }
  if (!raw.isEncrypted) return { doc: raw, isEncrypted: false }

  const pw = password ?? ''
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(data, {
      password: pw,
      updateMetadata: false,
      throwOnInvalidObject: false,
      parseSpeed: PARSE_SPEED
    })
    doc.getPageCount()
  } catch (e) {
    const msg = errorMessage(e)
    if (/needs password|password incorrect/i.test(msg)) {
      throw password === undefined ? new PasswordRequiredError() : new InvalidPasswordError()
    }
    throw new PdfLoadError(`The encrypted file could not be decrypted (${msg}).`, { cause: e })
  }
  // pdf-lib's decrypting parser can lose /Info and /ID from cross-reference-stream trailers;
  // restore them from the raw (undecrypted) parse. Info is an indirect object, so the
  // decrypted context holds the decrypted dictionary under the same ref.
  const trailer = doc.context.trailerInfo
  const rawTrailer = raw.context.trailerInfo
  if (!trailer.Info && rawTrailer.Info instanceof PDFRef && doc.context.lookup(rawTrailer.Info) instanceof PDFDict) {
    trailer.Info = rawTrailer.Info
  }
  if (!trailer.ID && rawTrailer.ID) {
    const id = raw.context.lookup(rawTrailer.ID)
    if (id instanceof PDFArray) trailer.ID = id.clone(doc.context)
  }
  const info = readSecurityInfo(raw)
  if (info && !info.encryptMetadata) restorePlainMetadataStreams(raw, doc)
  const opened: OpenedPdf = { doc, isEncrypted: true, password: pw }
  if (info) {
    opened.security = info
    opened.permissions = permissionsFromFlags(info.permissions, info.revision)
    if (options.identify !== false) {
      const identity = await identifyPassword(info, pw)
      if (identity) {
        opened.passwordKind = identity.kind
        if (identity.userPassword !== undefined) opened.userPassword = identity.userPassword
      }
    }
  }
  return opened
}

/**
 * With /EncryptMetadata false, metadata streams are stored unencrypted, but pdf-lib
 * "decrypts" them anyway (garbage). Put the raw bytes back.
 */
function restorePlainMetadataStreams(raw: PDFDocument, doc: PDFDocument): void {
  const metadata = PDFName.of('Metadata')
  for (const [ref, obj] of raw.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(PDFName.of('Type')) !== metadata) continue
    const decrypted = doc.context.lookup(ref)
    if (decrypted instanceof PDFRawStream) doc.context.assign(ref, PDFRawStream.of(decrypted.dict, obj.getContents()))
  }
}

function boxFromArray(arr: PDFObject | undefined): PdfBox | undefined {
  if (!(arr instanceof PDFArray) || arr.size() < 4) return undefined
  const nums: number[] = []
  for (let i = 0; i < 4; i++) {
    const n = arr.lookup(i)
    if (!(n instanceof PDFNumber)) return undefined
    nums.push(n.asNumber())
  }
  if (nums.some((n) => !Number.isFinite(n))) return undefined
  const [x1, y1, x2, y2] = nums
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/** A PDF rectangle array ([x1 y1 x2 y2], any corner order) as a normalized box. */
export function rectFromArray(arr: PDFObject | undefined): PdfBox | undefined {
  return boxFromArray(arr)
}

const LETTER_BOX: PdfBox = { x: 0, y: 0, width: 612, height: 792 }

/** Visible box of a page in PDF user space: crop box ∩ media box (like pdf.js `page.view`). */
export function visibleBox(page: PDFPage): PdfBox {
  let media: PdfBox | undefined
  let crop: PdfBox | undefined
  try {
    media = boxFromArray(page.node.MediaBox())
  } catch {
    media = undefined
  }
  if (!media || media.width <= 0 || media.height <= 0) media = LETTER_BOX
  try {
    crop = boxFromArray(page.node.CropBox())
  } catch {
    crop = undefined
  }
  if (!crop) return media
  return intersectBoxes(crop, media) ?? media
}

/** The page's /Rotate normalized like pdf.js (non-multiples of 90 count as 0). */
export function pageRotation(page: PDFPage): Rotation {
  let r = 0
  try {
    const n = page.node.Rotate()
    r = n ? n.asNumber() : 0
  } catch {
    r = 0
  }
  if (!Number.isFinite(r) || r % 90 !== 0) return 0
  return normalizeRotation(r)
}

/** "#rrggbb" (or "#rgb") → pdf-lib color; invalid input → black. */
export function parseColor(color: string | null | undefined): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color ?? '').trim())
  if (!m) return rgb(0, 0, 0)
  let hex = m[1]
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c)
  const n = parseInt(hex, 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/**
 * Delete every indirect object that cannot be reached from the trailer (Root / Info).
 * Removes content of deleted pages, objects dragged in by page copies, stale object/xref
 * streams and the old /Encrypt dictionary of decrypted files.
 */
export function collectGarbage(doc: PDFDocument): void {
  const ctx = doc.context
  const reachable = new Set<PDFRef>()
  const stack: PDFObject[] = []
  const t = ctx.trailerInfo
  for (const root of [t.Root, t.Info, t.Encrypt, t.ID]) if (root) stack.push(root)
  const seenDirect = new Set<PDFObject>()
  while (stack.length) {
    const obj = stack.pop()!
    if (obj instanceof PDFRef) {
      if (reachable.has(obj)) continue
      reachable.add(obj)
      const value = ctx.lookup(obj)
      if (value) stack.push(value)
    } else if (obj instanceof PDFDict) {
      if (seenDirect.has(obj)) continue
      seenDirect.add(obj)
      for (const [, v] of obj.entries()) stack.push(v)
    } else if (obj instanceof PDFArray) {
      if (seenDirect.has(obj)) continue
      seenDirect.add(obj)
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i))
    } else if (obj instanceof PDFStream) {
      if (seenDirect.has(obj)) continue
      seenDirect.add(obj)
      stack.push(obj.dict)
    } else if (obj instanceof PDFInvalidObject) {
      // pdf-lib keeps objects it could not parse as raw bytes; follow the "N G R"
      // references inside them so e.g. fonts of a slightly malformed resource dict survive.
      for (const ref of refsInRawBytes(obj)) stack.push(ref)
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) ctx.delete(ref)
  }
  // pdf-lib caches the refs of its shared "q" / "Q" content streams; forget them if deleted
  // so later page normalization recreates them instead of pointing at missing objects.
  const internals = ctx as unknown as Record<string, PDFRef | undefined>
  for (const key of ['pushGraphicsStateContentStreamRef', 'popGraphicsStateContentStreamRef']) {
    const ref = internals[key]
    if (ref && !reachable.has(ref)) internals[key] = undefined
  }
}

function refsInRawBytes(obj: PDFInvalidObject): PDFRef[] {
  const bytes = new Uint8Array(obj.sizeInBytes())
  obj.copyBytesInto(bytes, 0)
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
  const refs: PDFRef[] = []
  for (const m of text.matchAll(/(?<![\d.])(\d+)\s+(\d+)\s+R(?![A-Za-z0-9_])/g)) {
    refs.push(PDFRef.of(Number(m[1]), Number(m[2])))
  }
  return refs
}

/** Map from every indirect object to its ref (pdf-lib's getObjectRef is O(objects) per call). */
export function indirectRefMap(doc: PDFDocument): Map<PDFObject, PDFRef> {
  const map = new Map<PDFObject, PDFRef>()
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) map.set(obj, ref)
  return map
}

/**
 * Finds the page index of a widget: via the pages' /Annots arrays, else via the widget's
 * /P entry. Pass the widget's ref when known (see widgetRefs); otherwise it is looked up in
 * a ref map built once per finder.
 */
export function createWidgetPageFinder(
  doc: PDFDocument,
  pages: PDFPage[]
): (widget: PDFWidgetAnnotation, ref?: PDFRef) => number | undefined {
  const byPageRef = new Map<PDFRef, number>()
  pages.forEach((p, i) => byPageRef.set(p.ref, i))
  let byAnnotRef: Map<PDFRef, number> | undefined
  let refs: Map<PDFObject, PDFRef> | undefined
  const annotIndex = () => {
    if (byAnnotRef) return byAnnotRef
    byAnnotRef = new Map()
    pages.forEach((p, i) => {
      let annots: PDFArray | undefined
      try {
        annots = p.node.Annots()
      } catch {
        annots = undefined
      }
      if (!(annots instanceof PDFArray)) return
      for (let k = 0; k < annots.size(); k++) {
        const ref = annots.get(k)
        if (ref instanceof PDFRef && !byAnnotRef!.has(ref)) byAnnotRef!.set(ref, i)
      }
    })
    return byAnnotRef
  }
  return (widget, knownRef) => {
    let ref = knownRef
    if (!ref) {
      refs ??= indirectRefMap(doc)
      ref = refs.get(widget.dict)
    }
    // /Annots is authoritative (a stale /P is common in merged files).
    if (ref) {
      const viaAnnots = annotIndex().get(ref)
      if (viaAnnots !== undefined) return viaAnnots
    }
    let p: PDFObject | undefined
    try {
      p = widget.P()
    } catch {
      p = undefined
    }
    if (p instanceof PDFRef && byPageRef.has(p)) return byPageRef.get(p)
    return undefined
  }
}

/** Text of a name whose bytes are UTF-8 (as written by nameFromText), else Latin-1. */
export function nameText(name: PDFName): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(name.asBytes())
  } catch {
    return name.decodeText()
  }
}

/** A name holding `text` as UTF-8 bytes (pdf-lib would mangle characters above U+00FF). */
export function nameFromText(text: string): PDFName {
  const bytes = new TextEncoder().encode(text)
  // PDFName.of decodes #XX escapes in its input: keep a literal '#'.
  return PDFName.of(String.fromCharCode(...bytes).replace(/#/g, '#23'))
}
