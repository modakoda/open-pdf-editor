/**
 * Minimal ASN.1 DER/BER reader and DER writer for CMS, X.509 and PKCS#12.
 *
 * The reader keeps byte offsets, so the exact original encoding of any element can be used
 * (signatures are computed over original bytes: re-encoding a parsed structure could differ).
 * It accepts BER indefinite lengths (some signers produce them) and limits nesting depth.
 */

export const TagClass = { Universal: 0, Application: 1, Context: 2, Private: 3 } as const
export type TagClass = (typeof TagClass)[keyof typeof TagClass]

export const Tag = {
  Boolean: 0x01,
  Integer: 0x02,
  BitString: 0x03,
  OctetString: 0x04,
  Null: 0x05,
  Oid: 0x06,
  Utf8String: 0x0c,
  Sequence: 0x10,
  Set: 0x11,
  PrintableString: 0x13,
  T61String: 0x14,
  Ia5String: 0x16,
  UtcTime: 0x17,
  GeneralizedTime: 0x18,
  UniversalString: 0x1c,
  BmpString: 0x1e
} as const

export interface Asn1 {
  cls: TagClass
  constructed: boolean
  tag: number
  /** Offset of the identifier octet in `data`. */
  start: number
  /** Offset of the first content octet. */
  contentStart: number
  /** Offset after the last content octet (excluding an end-of-contents marker). */
  contentEnd: number
  /** Offset after the element (including an end-of-contents marker). */
  end: number
  data: Uint8Array
  children: Asn1[]
}

export class Asn1Error extends Error {
  override name = 'Asn1Error'
}

const MAX_DEPTH = 64

/** Parses one element starting at `offset`. Trailing bytes after it are ignored. */
export function parseAsn1(data: Uint8Array, offset = 0, limit = data.length): Asn1 {
  return parseElement(data, offset, limit, 0)
}

function parseElement(data: Uint8Array, offset: number, limit: number, depth: number): Asn1 {
  if (depth > MAX_DEPTH) throw new Asn1Error('ASN.1 nesting is too deep')
  let pos = offset
  if (pos >= limit) throw new Asn1Error('Unexpected end of ASN.1 data')
  const id = data[pos++]
  const cls = (id >> 6) as TagClass
  const constructed = (id & 0x20) !== 0
  let tag = id & 0x1f
  if (tag === 0x1f) {
    tag = 0
    for (let i = 0; ; i++) {
      if (pos >= limit || i > 4) throw new Asn1Error('Invalid ASN.1 tag')
      const b = data[pos++]
      tag = tag * 128 + (b & 0x7f)
      if (!(b & 0x80)) break
    }
  }
  if (pos >= limit) throw new Asn1Error('Unexpected end of ASN.1 data')
  const first = data[pos++]
  let length = -1
  if (first < 0x80) length = first
  else if (first > 0x80) {
    const n = first & 0x7f
    if (n > 6 || pos + n > limit) throw new Asn1Error('Invalid ASN.1 length')
    length = 0
    for (let i = 0; i < n; i++) length = length * 256 + data[pos++]
  }
  const contentStart = pos
  const node: Asn1 = { cls, constructed, tag, start: offset, contentStart, contentEnd: 0, end: 0, data, children: [] }
  if (length >= 0) {
    const contentEnd = contentStart + length
    if (contentEnd > limit) throw new Asn1Error('ASN.1 length exceeds the data')
    node.contentEnd = contentEnd
    node.end = contentEnd
    if (constructed) {
      let p = contentStart
      while (p < contentEnd) {
        const child = parseElement(data, p, contentEnd, depth + 1)
        node.children.push(child)
        p = child.end
      }
    }
    return node
  }
  // Indefinite length (BER): children until the end-of-contents octets 00 00.
  if (!constructed) throw new Asn1Error('Indefinite length on a primitive ASN.1 element')
  let p = contentStart
  for (;;) {
    if (p + 2 > limit) throw new Asn1Error('Unterminated indefinite-length ASN.1 element')
    if (data[p] === 0 && data[p + 1] === 0) {
      node.contentEnd = p
      node.end = p + 2
      return node
    }
    const child = parseElement(data, p, limit, depth + 1)
    node.children.push(child)
    p = child.end
  }
}

/** The element's complete original encoding. */
export function rawBytes(node: Asn1): Uint8Array {
  return node.data.subarray(node.start, node.end)
}

/**
 * Content octets of a primitive element. Constructed (BER) strings are concatenated, so
 * chunked OCTET STRINGs read like plain ones.
 */
export function contentBytes(node: Asn1): Uint8Array {
  if (!node.constructed) return node.data.subarray(node.contentStart, node.contentEnd)
  return concatBytes(node.children.map(contentBytes))
}

export function isUniversal(node: Asn1 | undefined, tag: number): node is Asn1 {
  return !!node && node.cls === TagClass.Universal && node.tag === tag
}

export function isContext(node: Asn1 | undefined, tag: number): node is Asn1 {
  return !!node && node.cls === TagClass.Context && node.tag === tag
}

export function expectUniversal(node: Asn1 | undefined, tag: number, what: string): Asn1 {
  if (!isUniversal(node, tag)) throw new Asn1Error(`Invalid ${what}`)
  return node
}

export function readOid(node: Asn1): string {
  if (!isUniversal(node, Tag.Oid)) throw new Asn1Error('Expected an OBJECT IDENTIFIER')
  const bytes = contentBytes(node)
  if (!bytes.length) throw new Asn1Error('Empty OBJECT IDENTIFIER')
  const parts: number[] = []
  let value = 0
  for (let i = 0; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f)
    if (!(bytes[i] & 0x80)) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2
        parts.push(first, value - first * 40)
      } else parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

/** INTEGER content without leading zero bytes, as hex (for display / comparison). */
export function integerHex(node: Asn1): string {
  let bytes = contentBytes(node)
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1)
  return toHex(bytes)
}

export function readSmallInteger(node: Asn1): number {
  if (!isUniversal(node, Tag.Integer)) throw new Asn1Error('Expected an INTEGER')
  const bytes = contentBytes(node)
  if (bytes.length > 6) throw new Asn1Error('INTEGER is too large')
  let value = bytes.length && bytes[0] & 0x80 ? -1 : 0
  for (const b of bytes) value = value * 256 + b
  return value
}

/** Text of a string type (UTF8String, PrintableString, IA5String, BMPString, …). */
export function readString(node: Asn1): string {
  const bytes = contentBytes(node)
  switch (node.tag) {
    case Tag.BmpString: {
      let s = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
      return s
    }
    case Tag.UniversalString: {
      let s = ''
      for (let i = 0; i + 3 < bytes.length; i += 4) {
        s += String.fromCodePoint(((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0)
      }
      return s
    }
    case Tag.Utf8String:
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    default:
      return latin1(bytes)
  }
}

/** UTCTime / GeneralizedTime. */
export function readTime(node: Asn1): Date {
  const s = latin1(contentBytes(node))
  const m =
    node.tag === Tag.UtcTime
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,](\d+))?(Z|[+-]\d{4})?$/.exec(s)
  if (!m) throw new Asn1Error('Invalid time')
  let year = Number(m[1])
  if (node.tag === Tag.UtcTime) year += year < 50 ? 2000 : 1900
  const frac = node.tag === Tag.UtcTime ? 0 : m[7] ? Number(`0.${m[7]}`) * 1000 : 0
  const zone = node.tag === Tag.UtcTime ? m[7] : m[8]
  let ms = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5] ?? 0), Number(m[6] ?? 0), frac)
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1
    ms -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60_000
  }
  return new Date(ms)
}

// ---------------------------------------------------------------------------------------------
// DER writer

function encodeLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

/** An element with an explicit identifier octet (e.g. 0x30 SEQUENCE, 0xa0 [0] constructed). */
export function derElement(identifier: number, ...content: Uint8Array[]): Uint8Array {
  const body = concatBytes(content)
  const header = [identifier, ...encodeLength(body.length)]
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

export const derSequence = (...items: Uint8Array[]) => derElement(0x30, ...items)
export const derOctetString = (bytes: Uint8Array) => derElement(0x04, bytes)
export const derNull = () => new Uint8Array([0x05, 0x00])
/** [n] constructed (EXPLICIT tagging, or IMPLICIT tagging of a constructed type). */
export const derContext = (n: number, ...items: Uint8Array[]) => derElement(0xa0 | n, ...items)

/** SET OF with the elements sorted as DER requires. */
export function derSetOf(items: Uint8Array[]): Uint8Array {
  return derElement(0x31, ...sortDer(items))
}

export function sortDer(items: Uint8Array[]): Uint8Array[] {
  return [...items].sort(compareDer)
}

function compareDer(a: Uint8Array, b: Uint8Array): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x - y
  }
  return a.length - b.length
}

export function derOid(oid: string): Uint8Array {
  const parts = oid.split('.').map(Number)
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Asn1Error(`Invalid OID ${oid}`)
  const values = [parts[0] * 40 + parts[1], ...parts.slice(2)]
  const bytes: number[] = []
  for (const v of values) {
    const chunk: number[] = []
    let n = v
    do {
      chunk.unshift(n & 0x7f)
      n = Math.floor(n / 128)
    } while (n > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
    bytes.push(...chunk)
  }
  return derElement(0x06, new Uint8Array(bytes))
}

/** INTEGER from unsigned big-endian bytes (a leading zero is added when the high bit is set). */
export function derUnsignedInteger(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const trimmed = bytes.subarray(start)
  return trimmed.length && trimmed[0] & 0x80 ? derElement(0x02, new Uint8Array([0]), trimmed) : derElement(0x02, trimmed)
}

export function derSmallInteger(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) throw new Asn1Error('Unsupported INTEGER value')
  const bytes: number[] = []
  let n = value
  do {
    bytes.unshift(n & 0xff)
    n = Math.floor(n / 256)
  } while (n > 0)
  return derUnsignedInteger(new Uint8Array(bytes))
}

/** UTCTime for 1950–2049, GeneralizedTime otherwise (RFC 5280 / RFC 5652). */
export function derTime(date: Date): Uint8Array {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const y = date.getUTCFullYear()
  const rest =
    pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z'
  if (y >= 1950 && y < 2050) return derElement(0x17, asciiBytes(pad(y % 100) + rest))
  return derElement(0x18, asciiBytes(pad(y, 4) + rest))
}

export function derUtf8String(text: string): Uint8Array {
  return derElement(0x0c, new TextEncoder().encode(text))
}

// ---------------------------------------------------------------------------------------------
// Byte helpers

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 ? `${hex}0` : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(v)) throw new Asn1Error('Invalid hex string')
    out[i] = v
  }
  return out
}

export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

export function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return s
}

/** A copy backed by its own ArrayBuffer (WebCrypto rejects views of shared or foreign buffers). */
export function ownBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}
