/**
 * Encryption-related helpers for load and export (internal).
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFDocument,
  type PDFObject
} from '@cantoo/pdf-lib'
import type { DocumentPermissions, EncryptionSettings } from './model'
import type { StandardSecurityInfo } from './pdfCrypto'

export const ALL_PERMISSIONS: DocumentPermissions = {
  printing: 'highResolution',
  modifying: true,
  copying: true,
  annotating: true,
  fillingForms: true,
  contentAccessibility: true,
  documentAssembly: true
}

export function allPermissionsGranted(p: DocumentPermissions): boolean {
  return (
    p.printing === 'highResolution' &&
    p.modifying &&
    p.copying &&
    p.annotating &&
    p.fillingForms &&
    p.contentAccessibility &&
    p.documentAssembly
  )
}

/** /P flags → permissions (ISO 32000-1, Table 22). */
export function permissionsFromFlags(p: number, revision: number): DocumentPermissions {
  const bit = (n: number) => (p & (1 << (n - 1))) !== 0
  if (revision <= 2) {
    return {
      printing: bit(3) ? 'highResolution' : 'none',
      modifying: bit(4),
      copying: bit(5),
      annotating: bit(6),
      fillingForms: bit(6),
      contentAccessibility: bit(5),
      documentAssembly: bit(4)
    }
  }
  return {
    printing: bit(3) ? (bit(12) ? 'highResolution' : 'lowResolution') : 'none',
    modifying: bit(4),
    copying: bit(5),
    annotating: bit(6),
    fillingForms: bit(9),
    contentAccessibility: bit(10),
    documentAssembly: bit(11)
  }
}

function asBytes(o: PDFObject | undefined): Uint8Array | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : undefined
}

/** Standard security handler parameters of a raw (undecrypted) parse. */
export function readSecurityInfo(raw: PDFDocument): StandardSecurityInfo | undefined {
  const ctx = raw.context
  const dict = ctx.lookup(ctx.trailerInfo.Encrypt)
  if (!(dict instanceof PDFDict)) return undefined
  const num = (k: string) => {
    const v = dict.lookup(PDFName.of(k))
    return v instanceof PDFNumber ? v.asNumber() : undefined
  }
  const owner = asBytes(dict.lookup(PDFName.of('O')))
  const user = asBytes(dict.lookup(PDFName.of('U')))
  const revision = num('R')
  const permissions = num('P')
  if (!owner || !user || revision === undefined || permissions === undefined) return undefined
  const id = ctx.lookup(ctx.trailerInfo.ID)
  const fileId = id instanceof PDFArray ? (asBytes(ctx.lookup(id.get(0))) ?? new Uint8Array()) : new Uint8Array()
  const em = dict.lookup(PDFName.of('EncryptMetadata'))
  const version = num('V') ?? 0
  let cryptFilterMethod: string | undefined
  const cf = dict.lookup(PDFName.of('CF'))
  const stmf = dict.lookup(PDFName.of('StmF'))
  if (cf instanceof PDFDict && stmf instanceof PDFName) {
    const filter = cf.lookup(stmf)
    const cfm = filter instanceof PDFDict ? filter.lookup(PDFName.of('CFM')) : undefined
    if (cfm instanceof PDFName) cryptFilterMethod = cfm.decodeText()
  }
  let keyLength = num('Length') ?? 40
  if (version === 4 && cryptFilterMethod === 'AESV2') keyLength = 128
  return {
    revision,
    keyLength,
    owner,
    user,
    permissions,
    encryptMetadata: !(em instanceof PDFBool && !em.asBoolean()),
    fileId,
    version,
    ownerEncryption: asBytes(dict.lookup(PDFName.of('OE'))),
    userEncryption: asBytes(dict.lookup(PDFName.of('UE'))),
    perms: asBytes(dict.lookup(PDFName.of('Perms'))),
    cryptFilterMethod
  }
}

function samePermissions(a: DocumentPermissions | undefined, b: DocumentPermissions | undefined): boolean {
  const x = a ?? ALL_PERMISSIONS
  const y = b ?? ALL_PERMISSIONS
  return (Object.keys(ALL_PERMISSIONS) as (keyof DocumentPermissions)[]).every((k) => x[k] === y[k])
}

/** Whether two encryption settings describe the same protection. */
export function sameEncryption(a: EncryptionSettings | null | undefined, b: EncryptionSettings | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return (
    (a.userPassword ?? '') === (b.userPassword ?? '') &&
    (a.ownerPassword ?? '') === (b.ownerPassword ?? '') &&
    samePermissions(a.permissions, b.permissions)
  )
}

/**
 * Re-encrypt with the original file key and encryption dictionary, so both original
 * passwords (even an AES-256 user password we never saw) and the permissions keep working.
 * Returns false (nothing done) when the original encryption cannot be reproduced.
 */
export function applyOriginalEncryption(out: PDFDocument, info: StandardSecurityInfo, key: Uint8Array): boolean {
  let algorithm: 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40'
  if (info.version === 5 && (info.revision === 5 || info.revision === 6)) {
    if (!info.encryptMetadata || !info.ownerEncryption || !info.userEncryption || !info.perms) return false
    algorithm = 'AES-256'
  } else if (info.version === 4 && info.cryptFilterMethod === 'AESV2' && info.revision === 4) {
    if (!info.encryptMetadata) return false
    algorithm = 'AES-128'
  } else if ((info.version === 1 || info.version === 2) && info.revision >= 2 && info.revision <= 3) {
    algorithm = info.revision === 2 ? 'RC4-40' : 'RC4-128'
  } else {
    return false
  }
  const ctx = out.context
  const originalId = ctx.trailerInfo.ID
  out.encrypt({ userPassword: 'x', ownerPassword: 'y', algorithm, allowWeakCryptography: true })
  const security = ctx.security as unknown as { encryptionKey: Uint8Array; keyBits: number }
  const dict = ctx.lookup(ctx.trailerInfo.Encrypt)
  if (!(dict instanceof PDFDict)) return false
  security.encryptionKey = key
  const hex = (b: Uint8Array) => PDFHexString.fromBytes(b)
  dict.set(PDFName.of('O'), hex(info.owner))
  dict.set(PDFName.of('U'), hex(info.user))
  dict.set(PDFName.of('P'), PDFNumber.of(info.permissions))
  dict.set(PDFName.of('R'), PDFNumber.of(info.revision))
  if (info.version === 5) {
    dict.set(PDFName.of('OE'), hex(info.ownerEncryption!))
    dict.set(PDFName.of('UE'), hex(info.userEncryption!))
    dict.set(PDFName.of('Perms'), hex(info.perms!))
  } else {
    // Revision 2-4 keys depend on the file identifier.
    if (originalId) ctx.trailerInfo.ID = originalId
    if (info.version !== 4) {
      security.keyBits = info.keyLength
      dict.set(PDFName.of('V'), PDFNumber.of(info.version))
      if (info.version === 2) dict.set(PDFName.of('Length'), PDFNumber.of(info.keyLength))
      else dict.delete(PDFName.of('Length'))
    }
  }
  return true
}

function randomPassword(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Encrypt `out` according to the settings (AES-256). Returns whether it was encrypted. */
export function applyEncryption(out: PDFDocument, enc: EncryptionSettings | null | undefined): boolean {
  if (!enc) return false
  const userPassword = enc.userPassword ?? ''
  const permissions = enc.permissions ?? ALL_PERMISSIONS
  const restricted = !allPermissionsGranted(permissions)
  let ownerPassword = enc.ownerPassword || ''
  if (!ownerPassword) ownerPassword = restricted ? randomPassword() : userPassword
  if (!userPassword && !ownerPassword) return false
  out.encrypt({
    userPassword,
    ownerPassword,
    permissions: {
      printing: permissions.printing === 'none' ? false : permissions.printing,
      modifying: permissions.modifying,
      copying: permissions.copying,
      annotating: permissions.annotating,
      fillingForms: permissions.fillingForms,
      contentAccessibility: permissions.contentAccessibility,
      documentAssembly: permissions.documentAssembly
    }
  })
  return true
}

type StringEncryptor = (s: PDFString | PDFHexString) => PDFHexString

const SIGNATURE_TYPES = new Set(['Sig', 'DocTimeStamp'])

/** Copy-on-write transform of a direct object: strings encrypted, everything else shared. */
function encryptDirect(value: PDFObject, enc: StringEncryptor): PDFObject {
  if (value instanceof PDFString || value instanceof PDFHexString) return enc(value)
  if (value instanceof PDFDict) {
    let copy: PDFDict | undefined
    const skipContents = isSignatureDict(value)
    for (const [key, v] of value.entries()) {
      if (skipContents && key === PDFName.of('Contents')) continue
      const t = encryptDirect(v, enc)
      if (t !== v) {
        copy ??= value.clone()
        copy.set(key, t)
      }
    }
    return copy ?? value
  }
  if (value instanceof PDFArray) {
    let copy: PDFArray | undefined
    for (let i = 0; i < value.size(); i++) {
      const v = value.get(i)
      const t = encryptDirect(v, enc)
      if (t !== v) {
        copy ??= value.clone()
        copy.set(i, t)
      }
    }
    return copy ?? value
  }
  return value
}

function isSignatureDict(dict: PDFDict): boolean {
  const type = dict.get(PDFName.of('Type'))
  return type instanceof PDFName && SIGNATURE_TYPES.has(type.decodeText())
}

function encryptEntriesInPlace(dict: PDFDict, enc: StringEncryptor): void {
  const skipContents = isSignatureDict(dict)
  for (const [key, v] of dict.entries()) {
    if (skipContents && key === PDFName.of('Contents')) continue
    const t = encryptDirect(v, enc)
    if (t !== v) dict.set(key, t)
  }
}

/**
 * pdf-lib's writer only encrypts stream bodies; strings in objects that are written
 * uncompressed would stay in plain text and readers would "decrypt" them to garbage. Call
 * this right before saving an encrypted document with `useObjectStreams: false` (so every
 * object is written uncompressed): it encrypts every string of every indirect object with
 * that object's key. Embedded fonts/images must be flushed first.
 */
export function encryptStringsForSave(doc: PDFDocument): void {
  const ctx = doc.context
  const security = ctx.security
  if (!security) return
  const encryptRef = ctx.trailerInfo.Encrypt
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encryptRef) continue
    const fn = security.getEncryptFn(ref.objectNumber, ref.generationNumber)
    const enc: StringEncryptor = (s) => PDFHexString.fromBytes(fn(s.asBytes()))
    if (obj instanceof PDFString || obj instanceof PDFHexString) ctx.assign(ref, enc(obj))
    else if (obj instanceof PDFStream) encryptEntriesInPlace(obj.dict, enc)
    else if (obj instanceof PDFDict) encryptEntriesInPlace(obj, enc)
    else if (obj instanceof PDFArray) {
      const t = encryptDirect(obj, enc)
      if (t !== obj) ctx.assign(ref, t)
    }
  }
}

const PDFAID_ELEMENT = /<pdfaid:(part|conformance|amd|rev|corr)\b[^>]*>[\s\S]*?<\/pdfaid:\1\s*>/g
const PDFAID_ATTRIBUTE = /\s+pdfaid:(part|conformance|amd|rev|corr)\s*=\s*("[^"]*"|'[^']*')/g

/**
 * Remove the PDF/A identification (pdfaid:*) from the catalog's XMP packet. PDF/A forbids
 * encryption, so an encrypted copy must not claim conformance. Returns true if a claim
 * was removed.
 */
export function stripPdfAIdentification(doc: PDFDocument): boolean {
  const ref = doc.catalog.get(PDFName.of('Metadata'))
  const stream = doc.context.lookup(ref)
  if (!(stream instanceof PDFRawStream)) return false
  let xml: string
  try {
    xml = new TextDecoder('utf-8').decode(decodePDFRawStream(stream).decode())
  } catch {
    return false
  }
  if (!/pdfaid:/.test(xml)) return false
  const stripped = xml.replace(PDFAID_ELEMENT, '').replace(PDFAID_ATTRIBUTE, '')
  if (stripped === xml) return false
  const updated = doc.context.stream(new TextEncoder().encode(stripped), { Type: 'Metadata', Subtype: 'XML' })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(updated))
  return true
}
