/**
 * Tokenizer / parser for PDF content streams (and CMaps, which use the same syntax).
 *
 * The parser turns the bytes into a flat list of operations. Each operation keeps the byte
 * range it was parsed from (operands + operator keyword), so unchanged content can be copied
 * byte-for-byte when a page is rewritten. Garbage is tolerated: stray delimiters are skipped,
 * unknown keywords become operations the interpreter ignores, unterminated strings/arrays end
 * at the end of the data.
 */

/** A name operand (`/Name`), #xx escapes decoded, as a latin1 string. */
export class PdfName {
  constructor(readonly name: string) {}
}

/** A string operand: raw bytes (escapes decoded). */
export class PdfStr {
  constructor(
    readonly bytes: Uint8Array,
    readonly hex = false
  ) {}
}

/** A dictionary operand (`<< … >>`), only used by BDC/DP properties and inline images. */
export class PdfDictOp {
  constructor(readonly map: Map<string, Operand>) {}
  get(key: string): Operand | undefined {
    return this.map.get(key)
  }
}

export type Operand = number | boolean | null | PdfName | PdfStr | PdfDictOp | Operand[]

export interface InlineImageData {
  dict: PdfDictOp
  /** Byte range of the image data (between ID and EI). */
  dataStart: number
  dataEnd: number
}

export interface Op {
  /** Operator keyword, e.g. "Tj", "re", "BI" (inline image: the whole BI … ID … EI sequence). */
  op: string
  args: Operand[]
  /** Byte offset of the first operand (or of the keyword when there are none). */
  start: number
  /** Byte offset just after the keyword (for BI: after EI). */
  end: number
  image?: InlineImageData
}

const WS = new Uint8Array(256)
const DELIM = new Uint8Array(256)
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1

export function isWhite(c: number): boolean {
  return WS[c] === 1
}

function isRegular(c: number): boolean {
  return WS[c] === 0 && DELIM[c] === 0
}

const HEX = new Int8Array(256).fill(-1)
for (let i = 0; i < 10; i++) HEX[0x30 + i] = i
for (let i = 0; i < 6; i++) {
  HEX[0x41 + i] = 10 + i
  HEX[0x61 + i] = 10 + i
}

const NUMBER_RE = /^[+-]*(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i])
  return s
}

/** Operators of the content stream syntax (used to validate the end of inline images). */
export const KNOWN_OPERATORS = new Set([
  'b', 'B', 'b*', 'B*', 'BDC', 'BI', 'BMC', 'BT', 'BX', 'c', 'cm', 'CS', 'cs', 'd', 'd0', 'd1', 'Do', 'DP',
  'EI', 'EMC', 'ET', 'EX', 'f', 'F', 'f*', 'G', 'g', 'gs', 'h', 'i', 'ID', 'j', 'J', 'K', 'k', 'l', 'm',
  'M', 'MP', 'n', 'q', 'Q', 're', 'RG', 'rg', 'ri', 's', 'S', 'SC', 'sc', 'SCN', 'scn', 'sh', 'T*', 'Tc',
  'Td', 'TD', 'Tf', 'Tj', 'TJ', 'TL', 'Tm', 'Tr', 'Ts', 'Tw', 'Tz', 'v', 'w', 'W', 'W*', 'y', "'", '"'
])

const MAX_DEPTH = 64

export class ContentLexer {
  pos = 0
  constructor(readonly data: Uint8Array) {}

  skipWhitespaceAndComments(): void {
    const d = this.data
    const len = d.length
    let p = this.pos
    while (p < len) {
      const c = d[p]
      if (WS[c]) {
        p++
      } else if (c === 0x25 /* % */) {
        while (p < len && d[p] !== 0x0a && d[p] !== 0x0d) p++
      } else {
        break
      }
    }
    this.pos = p
  }

  /**
   * Next token as an operand, or a keyword string (operators). Returns undefined at the end.
   * Stray closing delimiters are returned as the symbols ']' / '>>' / '}' so callers can
   * close arrays/dicts; other garbage is skipped.
   */
  next(depth = 0): Operand | Keyword | undefined {
    for (;;) {
      this.skipWhitespaceAndComments()
      const d = this.data
      if (this.pos >= d.length) return undefined
      const c = d[this.pos]
      switch (c) {
        case 0x28: // (
          return this.literalString()
        case 0x3c: // <
          if (d[this.pos + 1] === 0x3c) {
            this.pos += 2
            return this.dict(depth)
          }
          return this.hexString()
        case 0x3e: // >
          if (d[this.pos + 1] === 0x3e) {
            this.pos += 2
            return CLOSE_DICT
          }
          this.pos++
          continue
        case 0x5b: // [
          this.pos++
          return this.array(depth)
        case 0x5d: // ]
          this.pos++
          return CLOSE_ARRAY
        case 0x7b: // {
        case 0x7d: // }
        case 0x29: // )
          this.pos++
          continue
        case 0x2f: // /
          return this.name()
        default:
          return this.regular()
      }
    }
  }

  private regular(): Operand | Keyword {
    const d = this.data
    const start = this.pos
    let p = start
    while (p < d.length && isRegular(d[p])) p++
    this.pos = p
    if (p === start) {
      // Not a regular character and not handled: skip it.
      this.pos++
      return new Keyword('')
    }
    const c = d[start]
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const s = latin1(d, start, p)
      if (NUMBER_RE.test(s)) {
        let t = s
        // "--5" → -5 (Adobe Reader / pdf.js behaviour); "+-5" → -5
        const m = /^[+-]+/.exec(t)
        if (m && m[0].length > 1) t = (m[0].includes('-') ? '-' : '') + t.slice(m[0].length)
        const n = Number(t)
        return Number.isFinite(n) ? n : 0
      }
      return new Keyword(s)
    }
    const s = latin1(d, start, p)
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null') return null
    return new Keyword(s)
  }

  private name(): PdfName {
    const d = this.data
    let p = this.pos + 1
    let s = ''
    while (p < d.length && isRegular(d[p])) {
      const c = d[p]
      if (c === 0x23 /* # */ && p + 2 < d.length + 0 && HEX[d[p + 1]] >= 0 && HEX[d[p + 2]] >= 0) {
        s += String.fromCharCode(HEX[d[p + 1]] * 16 + HEX[d[p + 2]])
        p += 3
      } else {
        s += String.fromCharCode(c)
        p++
      }
    }
    this.pos = p
    return new PdfName(s)
  }

  private literalString(): PdfStr {
    const d = this.data
    const len = d.length
    let p = this.pos + 1
    let depth = 1
    const out: number[] = []
    while (p < len) {
      const c = d[p++]
      if (c === 0x5c /* \ */) {
        if (p >= len) break
        const e = d[p++]
        switch (e) {
          case 0x6e:
            out.push(0x0a)
            break
          case 0x72:
            out.push(0x0d)
            break
          case 0x74:
            out.push(0x09)
            break
          case 0x62:
            out.push(0x08)
            break
          case 0x66:
            out.push(0x0c)
            break
          case 0x0d:
            if (d[p] === 0x0a) p++
            break
          case 0x0a:
            break
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30
              for (let k = 0; k < 2 && p < len && d[p] >= 0x30 && d[p] <= 0x37; k++) v = v * 8 + (d[p++] - 0x30)
              out.push(v & 0xff)
            } else {
              out.push(e)
            }
        }
      } else if (c === 0x28) {
        depth++
        out.push(c)
      } else if (c === 0x29) {
        if (--depth === 0) break
        out.push(c)
      } else if (c === 0x0d) {
        if (d[p] === 0x0a) p++
        out.push(0x0a)
      } else {
        out.push(c)
      }
    }
    this.pos = p
    return new PdfStr(Uint8Array.from(out), false)
  }

  private hexString(): PdfStr {
    const d = this.data
    let p = this.pos + 1
    const out: number[] = []
    let hi = -1
    while (p < d.length) {
      const c = d[p++]
      if (c === 0x3e) break
      const v = HEX[c]
      if (v < 0) continue
      if (hi < 0) hi = v
      else {
        out.push(hi * 16 + v)
        hi = -1
      }
    }
    if (hi >= 0) out.push(hi * 16)
    this.pos = p
    return new PdfStr(Uint8Array.from(out), true)
  }

  private array(depth: number): Operand[] {
    const items: Operand[] = []
    for (;;) {
      if (depth > MAX_DEPTH) return items
      const t = this.next(depth + 1)
      if (t === undefined || t === CLOSE_ARRAY) return items
      if (t instanceof Keyword) continue
      items.push(t)
    }
  }

  private dict(depth: number): PdfDictOp {
    const map = new Map<string, Operand>()
    let key: string | null = null
    for (;;) {
      if (depth > MAX_DEPTH) break
      const t = this.next(depth + 1)
      if (t === undefined || t === CLOSE_DICT) break
      if (t instanceof Keyword) continue
      if (key === null) {
        if (t instanceof PdfName) key = t.name
        continue
      }
      map.set(key, t)
      key = null
    }
    return new PdfDictOp(map)
  }
}

/** An operator keyword token. */
export class Keyword {
  constructor(readonly word: string) {}
}

const CLOSE_ARRAY = new Keyword(']')
const CLOSE_DICT = new Keyword('>>')

/** Abbreviations allowed in inline image dictionaries. */
const INLINE_FILTER_ABBREV: Record<string, string> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode'
}

export function inlineFilters(dict: PdfDictOp): string[] {
  const f = dict.get('F') ?? dict.get('Filter')
  const list = Array.isArray(f) ? f : f !== undefined ? [f] : []
  return list
    .filter((x): x is PdfName => x instanceof PdfName)
    .map((n) => INLINE_FILTER_ABBREV[n.name] ?? n.name)
}

function inlineComponents(cs: Operand | undefined): number | undefined {
  if (cs instanceof PdfName) {
    switch (cs.name) {
      case 'G':
      case 'DeviceGray':
      case 'CalGray':
        return 1
      case 'RGB':
      case 'DeviceRGB':
      case 'CalRGB':
        return 3
      case 'CMYK':
      case 'DeviceCMYK':
        return 4
      default:
        return undefined
    }
  }
  if (Array.isArray(cs) && cs[0] instanceof PdfName && (cs[0].name === 'I' || cs[0].name === 'Indexed')) return 1
  return undefined
}

function num(o: Operand | undefined): number | undefined {
  return typeof o === 'number' && Number.isFinite(o) ? o : undefined
}

/**
 * True if an "EI" keyword at `i` (data[i] = 'E') ends an inline image: it must be followed by
 * whitespace/EOF/delimiter, and what follows must look like content stream syntax.
 */
function plausibleEI(d: Uint8Array, i: number): boolean {
  const len = d.length
  if (d[i] !== 0x45 || d[i + 1] !== 0x49) return false
  const after = i + 2
  if (after < len && isRegular(d[after])) return false
  // The bytes that follow must be ASCII text (content stream syntax), not binary data.
  const limit = Math.min(len, after + 96)
  for (let k = after; k < limit; k++) {
    const c = d[k]
    if (c > 0x7e || (c < 0x20 && !WS[c])) return false
  }
  // And the next keyword (if any, within the window) must be a known operator.
  const lx = new ContentLexer(d)
  lx.pos = after
  for (let n = 0; n < 12; n++) {
    const t = lx.next()
    if (t === undefined) return true
    if (lx.pos > limit + 32) return true
    if (t instanceof Keyword) return t.word === '' || KNOWN_OPERATORS.has(t.word) || t.word === ']' || t.word === '>>'
  }
  return true
}

/** Find the "EI" that ends inline image data starting at `dataStart`; returns its index (or data.length). */
function findInlineImageEnd(d: Uint8Array, dataStart: number, dict: PdfDictOp): number {
  const len = d.length
  const eiAfter = (p: number): number => {
    let k = p
    while (k < len && WS[d[k]]) k++
    return plausibleEI(d, k) ? k : -1
  }
  // 1. Explicit length (PDF 2.0 /L, or /Length).
  const L = num(dict.get('L')) ?? num(dict.get('Length'))
  if (L !== undefined && L >= 0 && dataStart + L <= len) {
    const k = eiAfter(dataStart + L)
    if (k >= 0) return k
  }
  const filters = inlineFilters(dict)
  const first = filters[0]
  // 2. Filters with an end marker.
  if (first === 'DCTDecode') {
    for (let p = dataStart; p + 1 < len; p++) {
      if (d[p] === 0xff && d[p + 1] === 0xd9) {
        const k = eiAfter(p + 2)
        if (k >= 0) return k
      }
    }
  } else if (first === 'ASCIIHexDecode' || first === 'ASCII85Decode') {
    const marker = first === 'ASCIIHexDecode' ? [0x3e] : [0x7e, 0x3e]
    for (let p = dataStart; p < len; p++) {
      if (d[p] === marker[0] && (marker.length === 1 || d[p + 1] === marker[1])) {
        const k = eiAfter(p + marker.length)
        if (k >= 0) return k
      }
    }
  } else if (!filters.length) {
    // 3. Unfiltered: the size follows from the image parameters.
    const w = num(dict.get('W')) ?? num(dict.get('Width'))
    const h = num(dict.get('H')) ?? num(dict.get('Height'))
    const mask = dict.get('IM') ?? dict.get('ImageMask')
    const bpc = mask === true ? 1 : num(dict.get('BPC')) ?? num(dict.get('BitsPerComponent'))
    const comps = mask === true ? 1 : inlineComponents(dict.get('CS') ?? dict.get('ColorSpace'))
    if (w && h && bpc && comps) {
      const size = Math.ceil((w * comps * bpc) / 8) * h
      if (dataStart + size <= len) {
        const k = eiAfter(dataStart + size)
        if (k >= 0) return k
      }
    }
  }
  // 4. Generic scan: whitespace-delimited EI followed by plausible content.
  for (let p = dataStart; p + 1 < len; p++) {
    if (d[p] === 0x45 && d[p + 1] === 0x49 && (p === dataStart || WS[d[p - 1]]) && plausibleEI(d, p)) return p
  }
  return len
}

/** Parse a content stream into operations. Linear in the input size. */
export function parseContent(data: Uint8Array): Op[] {
  const lx = new ContentLexer(data)
  const ops: Op[] = []
  let args: Operand[] = []
  let start = -1
  for (;;) {
    lx.skipWhitespaceAndComments()
    const tokStart = lx.pos
    const t = lx.next()
    if (t === undefined) break
    if (t instanceof Keyword) {
      if (t.word === '' || t.word === ']' || t.word === '>>') continue
      const op: Op = { op: t.word, args, start: start < 0 ? tokStart : start, end: lx.pos }
      if (t.word === 'BI') parseInlineImage(lx, op)
      ops.push(op)
      args = []
      start = -1
      continue
    }
    if (start < 0) start = tokStart
    args.push(t)
  }
  return ops
}

function parseInlineImage(lx: ContentLexer, op: Op): void {
  const d = lx.data
  const map = new Map<string, Operand>()
  let key: string | null = null
  for (;;) {
    const t = lx.next()
    if (t === undefined) break
    if (t instanceof Keyword) {
      if (t.word === 'ID') break
      if (t.word === 'EI') {
        // BI … EI without data: malformed; stop here.
        op.end = lx.pos
        op.image = { dict: new PdfDictOp(map), dataStart: lx.pos, dataEnd: lx.pos }
        return
      }
      continue
    }
    if (key === null) {
      if (t instanceof PdfName) key = t.name
      continue
    }
    map.set(key, t)
    key = null
  }
  const dict = new PdfDictOp(map)
  // A single whitespace byte separates ID from the data.
  let dataStart = lx.pos
  if (dataStart < d.length && WS[d[dataStart]]) dataStart++
  const ei = findInlineImageEnd(d, dataStart, dict)
  let dataEnd = ei
  op.image = { dict, dataStart, dataEnd }
  if (ei >= d.length) {
    op.end = d.length
  } else {
    // Trailing whitespace before EI is not part of the data.
    while (dataEnd > dataStart && WS[d[dataEnd - 1]] && dataEnd > ei - 1) dataEnd--
    op.image.dataEnd = dataEnd
    op.end = ei + 2
  }
  lx.pos = op.end
}
