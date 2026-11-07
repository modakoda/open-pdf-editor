/**
 * Finding and verifying the digital signatures of a PDF.
 *
 * For each signed signature field: the /ByteRange must exclude exactly the /Contents hex string,
 * the CMS message digest must match the hash of the signed bytes, and the CMS signature must
 * verify with the signer certificate (RSA, RSA-PSS or ECDSA via WebCrypto). Bytes appended after
 * the signed revision are reported as later modifications. Certificate trust is not evaluated.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib'
import type { PdfBox } from '../geometry'
import { openPdfLib, visibleBox } from '../pdf'
import { contentBytes, equalBytes, fromHex, parseAsn1, readOid, readTime } from './asn1'
import { digest, digestFromOid, verifyCms, type CmsVerification, type DigestName } from './cms'
import { listFields, pageIndexOfWidget, textOf } from './fields'
import type { PdfSignatureInfo, SignatureStatus } from './types'
import { OID } from './x509'

const N = (s: string) => PDFName.of(s)

/** What the file says about one signature (before any cryptography). */
export interface SignatureRecord {
  fieldName: string
  kind: 'signature' | 'timestamp'
  subFilter?: string
  byteRange?: number[]
  name?: string
  /** /M as an ISO time. */
  time?: string
  reason?: string
  location?: string
  contactInfo?: string
  pageIndex?: number
  box?: PdfSignatureInfo['box']
  invisible: boolean
}

/** PDF date string "D:YYYYMMDDHHmmSSOHH'mm'" → Date. */
export function parsePdfDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(value.trim())
  if (!m) return undefined
  const num = (s: string | undefined, d: number) => (s === undefined ? d : Number(s))
  let ms = Date.UTC(Number(m[1]), num(m[2], 1) - 1, num(m[3], 1), num(m[4], 0), num(m[5], 0), num(m[6], 0))
  if (m[7] === '+' || m[7] === '-') {
    const sign = m[7] === '-' ? -1 : 1
    ms -= sign * (num(m[8], 0) * 60 + num(m[9], 0)) * 60_000
  }
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function widgetBox(dict: PDFDict, view: PdfBox): { box: PdfSignatureInfo['box']; invisible: boolean } {
  const rect = dict.lookup(N('Rect'))
  if (!(rect instanceof PDFArray) || rect.size() < 4) return { box: undefined, invisible: true }
  const v = [0, 1, 2, 3].map((i) => {
    const n = rect.lookup(i)
    return n instanceof PDFNumber ? n.asNumber() : 0
  })
  const x = Math.min(v[0], v[2])
  const y = Math.max(v[1], v[3])
  const width = Math.abs(v[2] - v[0])
  const height = Math.abs(v[3] - v[1])
  return { box: { x: x - view.x, y: view.y + view.height - y, width, height }, invisible: width < 1 || height < 1 }
}

/** Signed signature fields of a loaded document (no cryptography). */
export function readSignatureRecords(doc: PDFDocument, pages: PDFPage[]): SignatureRecord[] {
  const out: SignatureRecord[] = []
  for (const field of listFields(doc)) {
    if (field.type !== 'Sig') continue
    const v = field.dict.lookup(N('V'))
    if (!(v instanceof PDFDict)) continue
    const type = v.lookup(N('Type'))
    const subFilter = v.lookup(N('SubFilter'))
    const br = v.lookup(N('ByteRange'))
    const record: SignatureRecord = {
      fieldName: field.name,
      kind: type === N('DocTimeStamp') ? 'timestamp' : 'signature',
      subFilter: subFilter instanceof PDFName ? subFilter.decodeText() : undefined,
      name: textOf(v.lookup(N('Name'))),
      time: parsePdfDate(textOf(v.lookup(N('M'))))?.toISOString(),
      reason: textOf(v.lookup(N('Reason'))),
      location: textOf(v.lookup(N('Location'))),
      contactInfo: textOf(v.lookup(N('ContactInfo'))),
      invisible: true
    }
    if (br instanceof PDFArray) {
      const nums: number[] = []
      for (let i = 0; i < br.size(); i++) {
        const n = br.lookup(i)
        nums.push(n instanceof PDFNumber ? n.asNumber() : NaN)
      }
      record.byteRange = nums
    }
    const widget = field.widgets[0]
    if (widget) {
      const pageIndex = pageIndexOfWidget(pages, widget)
      if (pageIndex !== undefined) {
        record.pageIndex = pageIndex
        Object.assign(record, widgetBox(widget.dict, visibleBox(pages[pageIndex])))
      }
    }
    out.push(record)
  }
  return out
}

/** Offsets just after each "%%EOF" marker (revision ends). */
function revisionEnds(bytes: Uint8Array): number[] {
  const ends: number[] = []
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x25 && bytes[i + 2] === 0x45 && bytes[i + 3] === 0x4f && bytes[i + 4] === 0x46) {
      ends.push(i + 5)
      i += 4
    }
  }
  return ends
}

const isSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00

const isHexDigit = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)

/** The /Contents hex string between the two signed ranges, or an error. */
function signatureContents(bytes: Uint8Array, br: number[]): { cms?: Uint8Array; problem?: string } {
  const [a, b, c, d] = br
  if (
    br.length !== 4 ||
    br.some((n) => !Number.isInteger(n) || n < 0) ||
    a !== 0 ||
    c <= b ||
    c + d > bytes.length
  ) {
    return { problem: 'The signature’s byte range is invalid.' }
  }
  if (bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e) return { problem: 'The signature’s byte range does not match its contents.' }
  let hex = ''
  for (let i = b + 1; i < c - 1; i++) {
    const ch = bytes[i]
    if (isSpace(ch)) continue
    if (!isHexDigit(ch)) return { problem: 'The signature’s byte range does not match its contents.' }
    hex += String.fromCharCode(ch)
  }
  try {
    const raw = fromHex(hex)
    // Trailing zero padding after the DER structure is normal.
    const der = parseAsn1(raw)
    return { cms: raw.subarray(0, der.end) }
  } catch {
    return { problem: 'The signature data is damaged.' }
  }
}

function tstInfoOf(cms: CmsVerification): { time?: Date; imprintAlg?: DigestName; imprint?: Uint8Array } {
  if (cms.encapsulatedContentType !== OID.tstInfo || !cms.encapsulatedContent) return {}
  try {
    const tst = parseAsn1(cms.encapsulatedContent)
    const imprint = tst.children[2]
    const genTime = tst.children[4]
    return {
      time: readTime(genTime),
      imprintAlg: digestFromOid(readOid(imprint.children[0].children[0])),
      imprint: contentBytes(imprint.children[1])
    }
  } catch {
    return {}
  }
}

/** Verifies an RFC 3161 timestamp token whose message imprint should be `imprintOf(alg)`. */
async function verifyTimestamp(
  token: Uint8Array,
  imprintOf: (alg: DigestName) => Promise<Uint8Array>
): Promise<{ time?: Date; imprintValid: boolean | null; valid: boolean; authority?: string; cms: CmsVerification }> {
  const cms = await verifyCms(token, async () => new Uint8Array())
  const tst = tstInfoOf(cms)
  const imprintValid = tst.imprintAlg && tst.imprint ? equalBytes(await imprintOf(tst.imprintAlg), tst.imprint) : null
  return {
    time: tst.time,
    imprintValid,
    valid: imprintValid === true && cms.digestValid === true && cms.signatureValid === true,
    authority: cms.signer?.summary.subjectName,
    cms
  }
}

function statusOf(info: Pick<PdfSignatureInfo, 'digestValid' | 'signatureValid' | 'coversWholeDocument'>, broken: boolean): SignatureStatus {
  if (broken || info.digestValid === false || info.signatureValid === false) return 'invalid'
  if (info.digestValid !== true || info.signatureValid !== true) return 'unknown'
  return info.coversWholeDocument ? 'valid' : 'modified'
}

/** Verifies one signature record against the complete file bytes. */
export async function verifySignatureRecord(bytes: Uint8Array, record: SignatureRecord): Promise<PdfSignatureInfo> {
  const br = record.byteRange ?? []
  const info: PdfSignatureInfo = {
    kind: record.kind,
    fieldName: record.fieldName,
    pageIndex: record.pageIndex,
    box: record.box,
    invisible: record.invisible,
    subFilter: record.subFilter,
    signerName: record.name || 'Unknown signer',
    certificateCount: 0,
    reason: record.reason,
    location: record.location,
    contactInfo: record.contactInfo,
    byteRange: br,
    signedLength: 0,
    coversWholeDocument: false,
    laterRevisions: 0,
    digestValid: null,
    signatureValid: null,
    status: 'unknown',
    problems: [],
    warnings: []
  }
  if (record.time) {
    info.signingTime = record.time
    info.signingTimeSource = 'pdf'
  }
  const { cms, problem } = signatureContents(bytes, br)
  if (!cms) {
    info.problems.push(problem!)
    info.status = 'invalid'
    return info
  }
  const [, b, c, d] = br
  info.signedLength = c + d
  let tail = info.signedLength
  while (tail < bytes.length && isSpace(bytes[tail])) tail++
  info.coversWholeDocument = tail === bytes.length
  info.laterRevisions = revisionEnds(bytes).filter((end) => end > info.signedLength).length
  if (!info.coversWholeDocument && info.laterRevisions === 0) info.laterRevisions = 1
  const ranges = [bytes.subarray(0, b), bytes.subarray(c, c + d)]
  const digests = new Map<DigestName, Promise<Uint8Array>>()
  const rangeDigest = (alg: DigestName) => {
    let p = digests.get(alg)
    if (!p) {
      p = digest(alg, ranges)
      digests.set(alg, p)
    }
    return p
  }
  let broken = false

  if (record.kind === 'timestamp' || record.subFilter === 'ETSI.RFC3161') {
    // Document timestamp: the token's message imprint is the hash of the signed bytes.
    info.kind = 'timestamp'
    const ts = await verifyTimestamp(cms, rangeDigest)
    applyCms(info, ts.cms)
    const checks = [ts.cms.digestValid, ts.imprintValid]
    info.digestValid = checks.includes(false) ? false : checks.every((v) => v === true) ? true : null
    if (ts.time) {
      info.timestamp = { time: ts.time.toISOString(), valid: ts.valid, authority: ts.authority }
      info.signingTime = ts.time.toISOString()
      info.signingTimeSource = 'timestamp'
    }
  } else if (record.subFilter === 'adbe.x509.rsa_sha1') {
    info.problems.push('Signatures of type adbe.x509.rsa_sha1 cannot be checked.')
  } else {
    const result = await verifyCms(cms, rangeDigest)
    applyCms(info, result)
    if (result.certificateBindingValid === false) {
      info.problems.push('The signature names a different signing certificate than the one it was made with.')
      broken = true
    }
    // adbe.pkcs7.sha1: the encapsulated content is the SHA-1 hash of the signed bytes.
    if (result.encapsulatedContent && result.encapsulatedContentType === OID.data) {
      const sha1 = await rangeDigest('SHA-1')
      if (!equalBytes(sha1, result.encapsulatedContent)) info.digestValid = false
    }
    if (result.signingTime) {
      info.signingTime = result.signingTime.toISOString()
      info.signingTimeSource = 'signature'
    }
    const tokenAttr = result.unsignedAttributes.get(OID.timeStampToken)?.[0]
    if (tokenAttr && result.signatureValue) {
      const signatureValue = result.signatureValue
      try {
        const ts = await verifyTimestamp(tokenAttr.data.subarray(tokenAttr.start, tokenAttr.end), (alg) => digest(alg, signatureValue))
        if (ts.time) {
          info.timestamp = { time: ts.time.toISOString(), valid: ts.valid, authority: ts.authority }
          if (ts.valid) {
            info.signingTime = ts.time.toISOString()
            info.signingTimeSource = 'timestamp'
          } else info.warnings.push('The signature’s timestamp could not be verified.')
        }
      } catch {
        info.warnings.push('The signature’s timestamp could not be read.')
      }
    }
  }

  if (info.digestValid === false) info.problems.unshift('The document has been altered since it was signed (the signed content does not match).')
  if (info.signatureValid === false) info.problems.unshift('The signature does not match the signer’s certificate.')
  if (info.certificate && info.signingTime) {
    const t = Date.parse(info.signingTime)
    info.certificateValidAtSigningTime = t >= Date.parse(info.certificate.notBefore) && t <= Date.parse(info.certificate.notAfter)
    if (!info.certificateValidAtSigningTime) info.warnings.push('The signer’s certificate was not valid at the time of signing.')
  }
  if (!info.coversWholeDocument) {
    info.warnings.push(
      `The document was changed after this signature was applied (${info.laterRevisions} later revision${info.laterRevisions === 1 ? '' : 's'}).`
    )
  }
  info.status = statusOf(info, broken)
  return info
}

function applyCms(info: PdfSignatureInfo, cms: CmsVerification): void {
  info.digestValid = cms.digestValid
  info.signatureValid = cms.signatureValid
  info.certificateCount = cms.certificates.length
  info.digestAlgorithm = cms.digestAlgorithm
  info.signatureAlgorithm = cms.signatureAlgorithm
  if (cms.signer) {
    info.certificate = cms.signer.summary
    info.signerName = cms.signer.summary.subjectName
  }
  info.problems.push(...cms.problems)
}

/** Reads and verifies the signatures of an already loaded document. Never throws. */
export async function verifyLoadedSignatures(doc: PDFDocument, pages: PDFPage[], bytes: Uint8Array): Promise<PdfSignatureInfo[]> {
  let records: SignatureRecord[]
  try {
    records = readSignatureRecords(doc, pages)
  } catch {
    return []
  }
  const out: PdfSignatureInfo[] = []
  for (const record of records) {
    try {
      out.push(await verifySignatureRecord(bytes, record))
    } catch (e) {
      out.push({
        kind: record.kind,
        fieldName: record.fieldName,
        pageIndex: record.pageIndex,
        box: record.box,
        invisible: record.invisible,
        subFilter: record.subFilter,
        signerName: record.name || 'Unknown signer',
        certificateCount: 0,
        byteRange: record.byteRange ?? [],
        signedLength: 0,
        coversWholeDocument: false,
        laterRevisions: 0,
        digestValid: null,
        signatureValid: null,
        status: 'unknown',
        problems: [`The signature could not be checked (${(e as Error).message}).`],
        warnings: []
      })
    }
  }
  // Oldest first (by signed length), the order they were applied in.
  return out.sort((x, y) => x.signedLength - y.signedLength)
}

export async function verifyPdfSignatures(bytes: Uint8Array, password?: string): Promise<PdfSignatureInfo[]> {
  const { doc } = await openPdfLib(bytes, password, { identify: false })
  return verifyLoadedSignatures(doc, doc.getPages(), bytes)
}

/** Whether a document has signed signature fields (cheap check before verifying). */
export function hasSignedFields(doc: PDFDocument): boolean {
  try {
    return listFields(doc).some((f) => f.type === 'Sig' && f.dict.lookup(N('V')) instanceof PDFDict)
  } catch {
    return false
  }
}
