/**
 * Digital signing of a finished PDF as an incremental update (PAdES baseline B-B with SubFilter
 * ETSI.CAdES.detached, or adbe.pkcs7.detached).
 *
 * The input bytes are kept unchanged; the update appends the signature field (new, or an existing
 * empty one), its visible appearance, the signature dictionary and a cross-reference section of
 * the same kind as the file's last one (table or stream). /ByteRange covers the whole file except
 * the /Contents hex string, which receives the CMS SignedData.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFFont,
  type PDFImage,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'
import type { Box, Rotation } from '../model'
import { pageRotation, visibleBox } from '../pdf'
import { EmbedCache } from '../exportFonts'
import { asciiBytes, concatBytes, toHex } from './asn1'
import { createCmsSignature, digest, estimateCmsSize, type CmsSigner } from './cms'
import { acroFormOf, listFields, pageIndexOfWidget, type FieldNode } from './fields'
import { parseCertificate } from './x509'

export type SignatureSubFilter = 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached'

export interface SignatureImage {
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
}

export interface SignatureAppearanceOptions {
  /** Name shown in the appearance (default: the signer's name). */
  name?: string
  /** Show the signing date (default true). */
  showDate?: boolean
  /** Handwritten signature drawn on the left (or top) of the box. */
  image?: SignatureImage
}

/** Where the signature goes: an existing empty signature field, or a new field on a page. */
export type SignatureTarget =
  | { fieldName: string }
  /** `box` in page space of page `pageIndex` (0-based) of the PDF being signed. */
  | { pageIndex: number; box: Box; fieldName?: string }

export interface SignPdfOptions {
  signer: CmsSigner
  target: SignatureTarget
  reason?: string
  location?: string
  contactInfo?: string
  /** /Name of the signature dictionary (default: the certificate's subject name). */
  name?: string
  /** Claimed signing time (/M; default now). */
  signingTime?: Date
  subFilter?: SignatureSubFilter
  appearance?: SignatureAppearanceOptions
  /** Additional bytes to reserve in /Contents (e.g. for a later timestamp). */
  reserveBytes?: number
}

export type SigningErrorCode = 'encrypted' | 'field-not-found' | 'not-signature-field' | 'already-signed' | 'locked' | 'invalid-target' | 'damaged'

export class SigningError extends Error {
  override name = 'SigningError'
  constructor(
    readonly code: SigningErrorCode,
    message: string
  ) {
    super(message)
  }
}

const N = (s: string) => PDFName.of(s)
const BYTE_RANGE_PLACEHOLDER = '/ByteRange [0 0000000000 0000000000 0000000000]'

interface UpdatePlan {
  doc: PDFDocument
  /** Objects with numbers up to this existed before the update. */
  baseLargest: number
  /** Existing objects that the update rewrites. */
  modified: Map<number, PDFRef>
}

function markModified(plan: UpdatePlan, ref: PDFRef | undefined): void {
  if (ref && ref.objectNumber <= plan.baseLargest) plan.modified.set(ref.objectNumber, ref)
}

function rootRef(doc: PDFDocument): PDFRef {
  const root = doc.context.trailerInfo.Root
  if (!(root instanceof PDFRef)) throw new SigningError('damaged', 'The document has no catalog.')
  return root
}

/** The AcroForm dictionary (created if missing) and the indirect object that holds it. */
function ensureAcroForm(plan: UpdatePlan): { acro: PDFDict; owner: PDFRef } {
  const { doc } = plan
  const raw = doc.catalog.get(N('AcroForm'))
  if (raw instanceof PDFRef) {
    const acro = doc.context.lookup(raw)
    if (acro instanceof PDFDict) return { acro, owner: raw }
  } else if (raw instanceof PDFDict) {
    return { acro: raw, owner: rootRef(doc) }
  }
  const acro = doc.context.obj({ Fields: [] })
  const ref = doc.context.register(acro)
  doc.catalog.set(N('AcroForm'), ref)
  markModified(plan, rootRef(doc))
  return { acro, owner: ref }
}

/** Appends `item` to the array at `key` of `dict` (held by `owner`), creating it if needed. */
function appendToArray(plan: UpdatePlan, dict: PDFDict, owner: PDFRef | undefined, key: string, item: PDFObject): void {
  const raw = dict.get(N(key))
  if (raw instanceof PDFRef) {
    const arr = plan.doc.context.lookup(raw)
    if (arr instanceof PDFArray) {
      arr.push(item)
      markModified(plan, raw)
      return
    }
  } else if (raw instanceof PDFArray) {
    raw.push(item)
    markModified(plan, owner)
    return
  }
  dict.set(N(key), plan.doc.context.obj([item]))
  markModified(plan, owner)
}

function uniqueFieldName(fields: FieldNode[], wanted?: string): string {
  const names = new Set(fields.map((f) => f.name))
  if (wanted && !names.has(wanted) && !wanted.includes('.')) return wanted
  for (let i = 1; ; i++) if (!names.has(`Signature${i}`)) return `Signature${i}`
}

/** Refuses documents whose certification signature allows no changes (DocMDP P=1). */
function assertNotLocked(doc: PDFDocument): void {
  const perms = doc.catalog.lookup(N('Perms'))
  const docMdp = perms instanceof PDFDict ? perms.lookup(N('DocMDP')) : undefined
  const refs = docMdp instanceof PDFDict ? docMdp.lookup(N('Reference')) : undefined
  if (!(refs instanceof PDFArray)) return
  for (let i = 0; i < refs.size(); i++) {
    const r = refs.lookup(i)
    const params = r instanceof PDFDict ? r.lookup(N('TransformParams')) : undefined
    const p = params instanceof PDFDict ? params.lookup(N('P')) : undefined
    if (p instanceof PDFNumber && p.asNumber() === 1) {
      throw new SigningError('locked', 'The document is certified and its certification does not allow further signatures.')
    }
  }
}

interface Placement {
  widget: PDFDict
  widgetRef: PDFRef | undefined
  page: PDFPage
  /** Widget rectangle in PDF user space. */
  rect: { x: number; y: number; width: number; height: number }
  fieldName: string
}

function rectOf(dict: PDFDict): Placement['rect'] | undefined {
  const arr = dict.lookup(N('Rect'))
  if (!(arr instanceof PDFArray) || arr.size() < 4) return undefined
  const v = [0, 1, 2, 3].map((i) => {
    const n = arr.lookup(i)
    return n instanceof PDFNumber ? n.asNumber() : NaN
  })
  if (v.some((n) => !Number.isFinite(n))) return undefined
  return { x: Math.min(v[0], v[2]), y: Math.min(v[1], v[3]), width: Math.abs(v[2] - v[0]), height: Math.abs(v[3] - v[1]) }
}

function placeInExistingField(plan: UpdatePlan, pages: PDFPage[], fieldName: string, sigRef: PDFRef): Placement {
  const fields = listFields(plan.doc)
  const field = fields.find((f) => f.name === fieldName)
  if (!field) throw new SigningError('field-not-found', `There is no field named “${fieldName}”.`)
  if (field.type !== 'Sig') throw new SigningError('not-signature-field', `“${fieldName}” is not a signature field.`)
  if (field.dict.lookup(N('V')) instanceof PDFDict) throw new SigningError('already-signed', `“${fieldName}” is already signed.`)
  const widget = field.widgets[0]
  const pageIndex = widget ? pageIndexOfWidget(pages, widget) : undefined
  const rect = widget ? rectOf(widget.dict) : undefined
  if (!widget || pageIndex === undefined || !rect) throw new SigningError('invalid-target', `The field “${fieldName}” is not on a page.`)
  field.dict.set(N('V'), sigRef)
  markModified(plan, field.ownerRef)
  markModified(plan, widget.ref)
  return { widget: widget.dict, widgetRef: widget.ref, page: pages[pageIndex], rect, fieldName }
}

function placeInNewField(plan: UpdatePlan, pages: PDFPage[], pageIndex: number, box: Box, wanted: string | undefined, sigRef: PDFRef): Placement {
  const page = pages[pageIndex]
  if (!page) throw new SigningError('invalid-target', 'The signature page does not exist.')
  if (!(box.width > 0 && box.height > 0) || ![box.x, box.y].every(Number.isFinite)) {
    throw new SigningError('invalid-target', 'The signature box is empty.')
  }
  const view = visibleBox(page)
  const rect = { x: view.x + box.x, y: view.y + view.height - box.y - box.height, width: box.width, height: box.height }
  const fieldName = uniqueFieldName(listFields(plan.doc), wanted)
  const { context } = plan.doc
  const widget = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    F: 4,
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    P: page.ref,
    V: sigRef
  })
  widget.set(N('T'), PDFHexString.fromText(fieldName))
  const widgetRef = context.register(widget)
  appendToArray(plan, page.node, page.ref, 'Annots', widgetRef)
  const { acro, owner } = ensureAcroForm(plan)
  appendToArray(plan, acro, owner, 'Fields', widgetRef)
  return { widget, widgetRef, page, rect, fieldName }
}

// ---------------------------------------------------------------------------------------------
// Appearance

function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** Text lines of the visible signature. */
export function appearanceLines(options: {
  name: string
  date?: Date
  reason?: string
  location?: string
}): string[] {
  const lines = [`Digitally signed by ${options.name}`]
  if (options.date) lines.push(`Date: ${formatDate(options.date)}`)
  if (options.reason) lines.push(`Reason: ${options.reason}`)
  if (options.location) lines.push(`Location: ${options.location}`)
  return lines.map((l) => l.replace(/[\r\n\t]+/g, ' ').trim())
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString()

const MATRICES: Record<Rotation, number[] | null> = {
  0: null,
  90: [0, 1, -1, 0, 0, 0],
  180: [-1, 0, 0, -1, 0, 0],
  270: [0, -1, 1, 0, 0, 0]
}

/**
 * Form XObject for the widget: optional image on the left (or top), text lines beside (or below)
 * it, upright for the page's /Rotate.
 */
async function buildAppearance(
  doc: PDFDocument,
  rect: Placement['rect'],
  rotation: Rotation,
  lines: string[],
  image: SignatureImage | undefined,
  cache: EmbedCache
): Promise<PDFRef> {
  const sideways = rotation === 90 || rotation === 270
  const w = sideways ? rect.height : rect.width
  const h = sideways ? rect.width : rect.height
  const pad = Math.min(6, Math.max(1.5, Math.min(w, h) * 0.06))
  let textBox = { x: pad, y: pad, width: Math.max(1, w - 2 * pad), height: Math.max(1, h - 2 * pad) }
  const ops: string[] = []
  const resources: Record<string, Record<string, PDFRef>> = {}

  let pdfImage: PDFImage | undefined
  if (image) {
    try {
      pdfImage = await cache.image(doc, image.data, image.mimeType)
    } catch {
      pdfImage = undefined
    }
  }
  if (pdfImage) {
    const wide = w >= h * 1.5
    const area = wide
      ? { x: pad, y: pad, width: (w - 3 * pad) * 0.42, height: h - 2 * pad }
      : { x: pad, y: pad + (h - 2 * pad) * 0.45, width: w - 2 * pad, height: (h - 2 * pad) * 0.55 }
    textBox = wide
      ? { x: area.x + area.width + pad, y: pad, width: w - area.width - 3 * pad, height: h - 2 * pad }
      : { x: pad, y: pad, width: w - 2 * pad, height: (h - 2 * pad) * 0.45 - pad / 2 }
    const scale = Math.min(area.width / pdfImage.width, area.height / pdfImage.height)
    const iw = pdfImage.width * scale
    const ih = pdfImage.height * scale
    const ix = area.x + (area.width - iw) / 2
    const iy = area.y + (area.height - ih) / 2
    resources.XObject = { Im1: pdfImage.ref }
    ops.push(`q ${fmt(iw)} 0 0 ${fmt(ih)} ${fmt(ix)} ${fmt(iy)} cm /Im1 Do Q`)
  }

  const visible = lines.filter((l) => l.length > 0)
  if (visible.length && textBox.width > 0 && textBox.height > 0) {
    const font: PDFFont = await cache.fontForText(doc, visible.join(' '))
    const leading = 1.25
    const widest = Math.max(...visible.map((l) => font.widthOfTextAtSize(l, 1)), 0.001)
    const size = Math.max(2, Math.min(10, textBox.height / (visible.length * leading), textBox.width / widest))
    const blockHeight = size * leading * visible.length
    let y = textBox.y + Math.min(textBox.height, blockHeight) + (textBox.height - Math.min(textBox.height, blockHeight)) / 2 - size
    resources.Font = { F1: font.ref }
    ops.push(`BT /F1 ${fmt(size)} Tf 0.12 0.12 0.14 rg`)
    for (const line of visible) {
      ops.push(`1 0 0 1 ${fmt(textBox.x)} ${fmt(y)} Tm ${font.encodeText(line).toString()} Tj`)
      y -= size * leading
    }
    ops.push('ET')
  }

  const dict: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, w, h],
    Resources: resources
  }
  const matrix = MATRICES[rotation]
  if (matrix) dict.Matrix = matrix
  const stream = doc.context.stream(ops.join('\n'), dict as never)
  return doc.context.register(stream)
}

// ---------------------------------------------------------------------------------------------
// Serialization

function serializeObject(ref: PDFRef, obj: PDFObject): Uint8Array {
  const body = new Uint8Array(obj.sizeInBytes())
  obj.copyBytesInto(body, 0)
  return concatBytes([asciiBytes(`${ref.objectNumber} ${ref.generationNumber} obj\n`), body, asciiBytes('\nendobj\n')])
}

function lastStartXref(bytes: Uint8Array): number {
  const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 2048)))
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)]
  const last = matches[matches.length - 1]
  if (!last) throw new SigningError('damaged', 'The document has no cross-reference information.')
  return Number(last[1])
}

function xrefIsStream(bytes: Uint8Array, offset: number): boolean {
  let i = offset
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++
  const head = String.fromCharCode(...bytes.subarray(i, i + 4))
  return head !== 'xref'
}

function idArray(doc: PDFDocument): string {
  const random = new Uint8Array(16)
  globalThis.crypto.getRandomValues(random)
  const id = doc.context.lookup(doc.context.trailerInfo.ID)
  let first = toHex(random)
  if (id instanceof PDFArray && id.size() > 0) {
    const v = id.lookup(0)
    if (v instanceof PDFHexString || v instanceof PDFString) first = toHex(v.asBytes())
  }
  return `[<${first}> <${toHex(random)}>]`
}

function refString(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFRef ? `${obj.objectNumber} ${obj.generationNumber} R` : undefined
}

/** Groups sorted object numbers into xref subsections. */
function subsections(entries: { num: number }[]): { start: number; count: number }[] {
  const out: { start: number; count: number }[] = []
  for (const { num } of entries) {
    const last = out[out.length - 1]
    if (last && last.start + last.count === num) last.count++
    else out.push({ start: num, count: 1 })
  }
  return out
}

function textEntry(key: string, value: string | undefined): string {
  return value ? ` /${key} ${PDFHexString.fromText(value).toString()}` : ''
}

/**
 * Signs `pdf` and returns the signed file (the original bytes followed by an incremental update).
 * Throws SigningError for documents or targets that cannot be signed.
 */
export async function signPdf(pdf: Uint8Array, options: SignPdfOptions): Promise<Uint8Array> {
  const subFilter = options.subFilter ?? 'ETSI.CAdES.detached'
  const signingTime = options.signingTime ?? new Date()
  const certificate = parseCertificate(options.signer.certificate)
  const prevXref = lastStartXref(pdf)
  const asStream = xrefIsStream(pdf, prevXref)

  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(pdf.slice(), { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
  } catch (e) {
    throw new SigningError('damaged', `The document could not be read (${(e as Error).message}).`)
  }
  if (doc.context.trailerInfo.Encrypt) {
    throw new SigningError('encrypted', 'Password-protected documents cannot be signed. Remove the password first.')
  }
  assertNotLocked(doc)
  const size = doc.context.trailerInfo.Size
  const baseLargest = Math.max(doc.context.largestObjectNumber, size instanceof PDFNumber ? size.asNumber() - 1 : 0)
  doc.context.largestObjectNumber = baseLargest
  const plan: UpdatePlan = { doc, baseLargest, modified: new Map() }
  const pages = doc.getPages()

  // 1. Field and widget.
  const sigRef = doc.context.nextRef()
  const target = options.target
  const placement =
    'pageIndex' in target
      ? placeInNewField(plan, pages, target.pageIndex, target.box, target.fieldName, sigRef)
      : placeInExistingField(plan, pages, target.fieldName, sigRef)
  const { acro, owner: acroOwner } = ensureAcroForm(plan)
  acro.set(N('SigFlags'), PDFNumber.of(3))
  markModified(plan, acroOwner)

  // 2. Visible appearance (print flag on, so it prints like Acrobat's).
  const signerName = options.name?.trim() || certificate.summary.subjectName
  const appearance = options.appearance ?? {}
  const lines = appearanceLines({
    name: appearance.name?.trim() || signerName,
    date: appearance.showDate === false ? undefined : signingTime,
    reason: options.reason?.trim(),
    location: options.location?.trim()
  })
  const cache = new EmbedCache()
  const apRef = await buildAppearance(doc, placement.rect, pageRotation(placement.page), lines, appearance.image, cache)
  placement.widget.set(N('AP'), doc.context.obj({ N: apRef }))
  const flags = placement.widget.lookup(N('F'))
  const f = flags instanceof PDFNumber ? flags.asNumber() : 0
  placement.widget.set(N('F'), PDFNumber.of((f | 4) & ~(1 | 2 | 32)))
  if (!placement.widget.has(N('P'))) placement.widget.set(N('P'), placement.page.ref)
  await doc.flush()

  // 3. The objects of the update.
  const objects: { num: number; gen: number; bytes: Uint8Array | null }[] = []
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (ref.objectNumber === sigRef.objectNumber) continue
    if (ref.objectNumber > baseLargest || plan.modified.has(ref.objectNumber)) {
      objects.push({ num: ref.objectNumber, gen: ref.generationNumber, bytes: serializeObject(ref, obj) })
    }
  }
  objects.push({ num: sigRef.objectNumber, gen: 0, bytes: null })
  objects.sort((a, b) => a.num - b.num)

  // 4. Signature dictionary with placeholders.
  const contentsSize = (await estimateCmsSize(options.signer, { cades: subFilter === 'ETSI.CAdES.detached' })) + 64 + Math.max(0, options.reserveBytes ?? 0)
  const sigHead = asciiBytes(
    `${sigRef.objectNumber} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} ${BYTE_RANGE_PLACEHOLDER} /Contents <`
  )
  const sigTail = asciiBytes(
    `> /M ${PDFString.fromDate(signingTime).toString()}` +
      textEntry('Name', signerName) +
      textEntry('Reason', options.reason?.trim()) +
      textEntry('Location', options.location?.trim()) +
      textEntry('ContactInfo', options.contactInfo?.trim()) +
      ' /Prop_Build << /App << /Name /Open#20PDF#20Editor >> >> >>\nendobj\n'
  )
  const contentsHex = new Uint8Array(contentsSize * 2).fill(0x30)

  // 5. Lay out the update.
  const parts: Uint8Array[] = []
  let offset = pdf.length
  const push = (b: Uint8Array) => {
    parts.push(b)
    offset += b.length
  }
  const last = pdf[pdf.length - 1]
  if (last !== 0x0a && last !== 0x0d) push(asciiBytes('\n'))
  const offsets = new Map<number, number>()
  let contentsStart = -1
  for (const o of objects) {
    offsets.set(o.num, offset)
    if (o.bytes) push(o.bytes)
    else {
      push(sigHead)
      contentsStart = offset - 1 // the "<"
      push(contentsHex)
      push(sigTail)
    }
  }
  const contentsEnd = contentsStart + 1 + contentsHex.length + 1 // after the ">"

  const root = refString(doc.context.trailerInfo.Root)!
  const info = refString(doc.context.trailerInfo.Info)
  const ids = idArray(doc)
  const xrefOffset = offset
  if (asStream) {
    const xrefNum = Math.max(...objects.map((o) => o.num)) + 1
    offsets.set(xrefNum, xrefOffset)
    const entries = [...objects.map((o) => ({ num: o.num, gen: o.gen })), { num: xrefNum, gen: 0 }]
    const data = new Uint8Array(entries.length * 7)
    entries.forEach((e, i) => {
      const off = offsets.get(e.num)!
      data.set([1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, (e.gen >> 8) & 255, e.gen & 255], i * 7)
    })
    const index = subsections(entries)
      .map((s) => `${s.start} ${s.count}`)
      .join(' ')
    push(
      asciiBytes(
        `${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Index [${index}] /Root ${root}` +
          `${info ? ` /Info ${info}` : ''} /ID ${ids} /Prev ${prevXref} /Length ${data.length} >>\nstream\n`
      )
    )
    push(data)
    push(asciiBytes(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`))
  } else {
    const xref = ['xref']
    let i = 0
    for (const s of subsections(objects)) {
      xref.push(`${s.start} ${s.count}`)
      for (let k = 0; k < s.count; k++, i++) {
        const o = objects[i]
        xref.push(`${String(offsets.get(o.num)).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n\r`)
      }
    }
    const sizeAfter = Math.max(baseLargest, ...objects.map((o) => o.num)) + 1
    xref.push('trailer', `<< /Size ${sizeAfter} /Root ${root}${info ? ` /Info ${info}` : ''} /ID ${ids} /Prev ${prevXref} >>`)
    xref.push('startxref', String(xrefOffset), '%%EOF', '')
    push(asciiBytes(xref.join('\n')))
  }

  // 6. Byte range, digest and CMS.
  const out = new Uint8Array(offset)
  out.set(pdf, 0)
  let pos = pdf.length
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  const byteRange = [0, contentsStart, contentsEnd, out.length - contentsEnd]
  const brText = `/ByteRange [${byteRange.join(' ')}]`.padEnd(BYTE_RANGE_PLACEHOLDER.length, ' ')
  const brAt = indexOf(out, asciiBytes(BYTE_RANGE_PLACEHOLDER), offsets.get(sigRef.objectNumber)!)
  if (brAt < 0 || brText.length !== BYTE_RANGE_PLACEHOLDER.length) throw new Error('Internal error: byte range placeholder')
  out.set(asciiBytes(brText), brAt)

  const contentDigest = await digest('SHA-256', [out.subarray(0, contentsStart), out.subarray(contentsEnd)])
  const cms = await createCmsSignature(contentDigest, options.signer, {
    cades: subFilter === 'ETSI.CAdES.detached',
    signingTime
  })
  if (cms.length > contentsSize) throw new Error('Internal error: the signature is larger than the space reserved for it')
  out.set(asciiBytes(toHex(cms)), contentsStart + 1)
  return out
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer
    return i
  }
  return -1
}

/** Names of the signature fields of a PDF that are not signed yet. */
export async function emptySignatureFields(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf.slice(), { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
  if (!acroFormOf(doc)) return []
  return listFields(doc)
    .filter((f) => f.type === 'Sig' && !(f.dict.lookup(N('V')) instanceof PDFDict))
    .map((f) => f.name)
}

