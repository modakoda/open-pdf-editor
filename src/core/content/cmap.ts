/**
 * CMaps: encoding CMaps of Type0 fonts (code → CID, codespace ranges), embedded or predefined
 * (e.g. 90ms-RKSJ-H, loaded as pdf.js binary .bcmap files through a CMap loader), and
 * /ToUnicode / Adobe-*-UCS2 maps (code or CID → Unicode text).
 */
import { PdfName, PdfStr, parseContent, type Operand } from './lexer'

interface Codespace {
  len: number
  lo: number
  hi: number
}

/** A code range mapped to consecutive values starting at `value`. */
interface Range {
  lo: number
  hi: number
  value: number
}

function bytesToNumber(b: Uint8Array): number {
  let v = 0
  for (let i = 0; i < b.length && i < 4; i++) v = v * 256 + b[i]
  return v
}

/** Maximum number of codes flattened into a lookup table. */
const FLATTEN_LIMIT = 300_000

/** Encoding CMap of a composite font. */
export class CMap {
  codespaces: Codespace[] = []
  /** Mappings in precedence order (later entries win). */
  private entries: Range[] = []
  private table: Map<number, number> | null = null
  vertical = false
  identity = false
  /** A CMap it is based on (usecmap) could not be loaded. */
  incomplete = false

  static identity(vertical: boolean): CMap {
    const c = new CMap()
    c.codespaces.push({ len: 2, lo: 0, hi: 0xffff })
    c.identity = true
    c.vertical = vertical
    return c
  }

  addCodespace(len: number, lo: number, hi: number): void {
    this.codespaces.push({ len, lo, hi })
  }

  map(lo: number, hi: number, value: number): void {
    if (hi < lo) return
    this.entries.push({ lo, hi, value })
    this.table = null
  }

  get size(): number {
    return this.entries.length
  }

  /** Make `base` (usecmap) the fallback: its mappings have lower precedence. */
  inherit(base: CMap): void {
    if (!this.codespaces.length) this.codespaces.push(...base.codespaces)
    if (base.identity && !this.entries.length) this.identity = true
    else if (this.identity && base.entries.length) this.identity = false
    this.entries = [...base.entries, ...this.entries]
    this.vertical ||= base.vertical
    this.incomplete ||= base.incomplete
    this.table = null
  }

  readCode(bytes: Uint8Array, pos: number): { code: number; len: number } {
    if (!this.codespaces.length) {
      const len = Math.min(2, bytes.length - pos)
      let code = 0
      for (let i = 0; i < len; i++) code = code * 256 + bytes[pos + i]
      return { code, len: Math.max(1, len) }
    }
    let code = 0
    for (let n = 1; n <= 4 && pos + n <= bytes.length; n++) {
      code = code * 256 + bytes[pos + n - 1]
      for (const cs of this.codespaces) {
        if (cs.len === n && code >= cs.lo && code <= cs.hi) return { code, len: n }
      }
    }
    // No codespace matched: use the shortest codespace length (pdf.js does the same).
    let minLen = 4
    for (const cs of this.codespaces) minLen = Math.min(minLen, cs.len)
    const len = Math.max(1, Math.min(minLen, bytes.length - pos))
    code = 0
    for (let i = 0; i < len; i++) code = code * 256 + bytes[pos + i]
    return { code, len }
  }

  /** Byte length of codes when all codespaces have the same length (else undefined). */
  uniformLength(): number | undefined {
    if (!this.codespaces.length) return 2
    const l = this.codespaces[0].len
    return this.codespaces.every((c) => c.len === l) ? l : undefined
  }

  private lookupTable(): Map<number, number> | null {
    if (this.table) return this.table
    let total = 0
    for (const e of this.entries) total += e.hi - e.lo + 1
    if (total > FLATTEN_LIMIT) return null
    const t = new Map<number, number>()
    for (const e of this.entries) for (let c = e.lo; c <= e.hi; c++) t.set(c, e.value + (c - e.lo))
    this.table = t
    return t
  }

  cid(code: number): number {
    if (this.identity) return code
    const t = this.lookupTable()
    if (t) return t.get(code) ?? 0
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const r = this.entries[i]
      if (code >= r.lo && code <= r.hi) return r.value + (code - r.lo)
    }
    return 0
  }

  /** Character code for a CID (reverse lookup), used to re-encode text. */
  codeForCid(cid: number): number | undefined {
    if (this.identity) return cid
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const r = this.entries[i]
      if (cid >= r.value && cid <= r.value + (r.hi - r.lo)) return r.lo + (cid - r.value)
    }
    return undefined
  }

  /** Parse a text (PostScript) CMap. `usecmap` resolves predefined base CMaps by name. */
  static parse(data: Uint8Array, usecmap: (name: string) => CMap | null | undefined = builtinCMap): CMap {
    const cmap = new CMap()
    let base: CMap | null | undefined
    for (const op of parseContent(data)) {
      const a = op.args
      switch (op.op) {
        case 'endcodespacerange':
          for (let i = 0; i + 1 < a.length; i += 2) {
            const lo = a[i]
            const hi = a[i + 1]
            if (lo instanceof PdfStr && hi instanceof PdfStr && lo.bytes.length) {
              cmap.addCodespace(lo.bytes.length, bytesToNumber(lo.bytes), bytesToNumber(hi.bytes))
            }
          }
          break
        case 'endcidrange':
          for (let i = 0; i + 2 < a.length; i += 3) {
            const lo = a[i]
            const hi = a[i + 1]
            const v = a[i + 2]
            if (lo instanceof PdfStr && hi instanceof PdfStr && typeof v === 'number') {
              cmap.map(bytesToNumber(lo.bytes), bytesToNumber(hi.bytes), v)
            }
          }
          break
        case 'endcidchar':
          for (let i = 0; i + 1 < a.length; i += 2) {
            const c = a[i]
            const v = a[i + 1]
            if (c instanceof PdfStr && typeof v === 'number') {
              const code = bytesToNumber(c.bytes)
              cmap.map(code, code, v)
            }
          }
          break
        case 'usecmap': {
          const n = a[a.length - 1]
          if (n instanceof PdfName) {
            base = usecmap(n.name)
            if (!base) cmap.incomplete = true
          }
          break
        }
        case 'def': {
          const k = a[a.length - 2]
          const v = a[a.length - 1]
          if (k instanceof PdfName && k.name === 'WMode' && v === 1) cmap.vertical = true
          break
        }
      }
    }
    if (base) cmap.inherit(base)
    return cmap
  }

  /** Parse a pdf.js binary CMap (.bcmap). */
  static parseBinary(data: Uint8Array, usecmap: (name: string) => CMap | null | undefined = builtinCMap): CMap {
    const cmap = new CMap()
    const useName = readBinaryCMap(data, {
      vertical: (v) => (cmap.vertical = v),
      codespace: (len, lo, hi) => cmap.addCodespace(len, lo, hi),
      cid: (lo, hi, cid) => cmap.map(lo, hi, cid),
      unicode: () => undefined
    })
    if (useName) {
      const base = usecmap(useName)
      if (base) cmap.inherit(base)
      else cmap.incomplete = true
    }
    return cmap
  }
}

function utf16be(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  if (bytes.length % 2 === 1) s += String.fromCharCode(bytes[bytes.length - 1])
  return s
}

function incrementText(s: string, by: number): string {
  if (!s) return s
  // Increment the last UTF-16 code unit (the usual bfrange semantics).
  return s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + by)
}

/** /ToUnicode CMap (or a predefined Adobe-*-UCS2 map keyed by CID). */
export class ToUnicodeMap {
  private map = new Map<number, string>()
  private ranges: { lo: number; hi: number; start: string }[] = []

  get(code: number): string | undefined {
    const v = this.map.get(code)
    if (v !== undefined) return v
    for (const r of this.ranges) if (code >= r.lo && code <= r.hi) return incrementText(r.start, code - r.lo)
    return undefined
  }

  get size(): number {
    return this.map.size + this.ranges.length
  }

  set(code: number, text: string): void {
    this.map.set(code, text)
  }

  setRange(lo: number, hi: number, start: string): void {
    if (hi < lo) return
    if (hi - lo <= 256) for (let c = lo; c <= hi; c++) this.map.set(c, incrementText(start, c - lo))
    else this.ranges.push({ lo, hi, start })
  }

  /** Every mapping (ranges of more than `maxRange` codes are skipped). */
  forEach(fn: (code: number, text: string) => void, maxRange = 0x10000): void {
    for (const [code, t] of this.map) fn(code, t)
    for (const r of this.ranges) {
      if (r.hi - r.lo >= maxRange) continue
      for (let c = r.lo; c <= r.hi; c++) fn(c, incrementText(r.start, c - r.lo))
    }
  }

  /** Codes mapped to exactly this text (for re-encoding). */
  codeFor(text: string): number | undefined {
    for (const [code, t] of this.map) if (t === text) return code
    for (const r of this.ranges) {
      if (text.length !== r.start.length || text.slice(0, -1) !== r.start.slice(0, -1)) continue
      const d = text.charCodeAt(text.length - 1) - r.start.charCodeAt(r.start.length - 1)
      if (d >= 0 && d <= r.hi - r.lo) return r.lo + d
    }
    return undefined
  }

  static parse(data: Uint8Array): ToUnicodeMap {
    const m = new ToUnicodeMap()
    const dst = (o: Operand): string | undefined => {
      if (o instanceof PdfStr) return utf16be(o.bytes)
      if (o instanceof PdfName) return o.name.length === 1 ? o.name : undefined
      return undefined
    }
    for (const op of parseContent(data)) {
      const a = op.args
      if (op.op === 'endbfchar') {
        for (let i = 0; i + 1 < a.length; i += 2) {
          const src = a[i]
          const t = dst(a[i + 1])
          if (src instanceof PdfStr && t !== undefined) m.map.set(bytesToNumber(src.bytes), t)
        }
      } else if (op.op === 'endbfrange') {
        for (let i = 0; i + 2 < a.length; i += 3) {
          const lo = a[i]
          const hi = a[i + 1]
          const d = a[i + 2]
          if (!(lo instanceof PdfStr) || !(hi instanceof PdfStr)) continue
          const l = bytesToNumber(lo.bytes)
          const h = bytesToNumber(hi.bytes)
          if (h < l) continue
          if (Array.isArray(d)) {
            for (let k = 0; k < d.length && l + k <= h; k++) {
              const t = dst(d[k])
              if (t !== undefined) m.map.set(l + k, t)
            }
          } else {
            const t = dst(d)
            if (t !== undefined) m.setRange(l, h, t)
          }
        }
      }
    }
    return m
  }

  static parseBinary(data: Uint8Array): ToUnicodeMap {
    const m = new ToUnicodeMap()
    readBinaryCMap(data, {
      vertical: () => undefined,
      codespace: () => undefined,
      cid: () => undefined,
      unicode: (lo, hi, text) => (lo === hi ? m.set(lo, text) : m.setRange(lo, hi, text))
    })
    return m
  }
}

// ---------------------------------------------------------------------------------------
// pdf.js binary CMap format (see pdf.js src/core/binary_cmap.js)

interface BinarySink {
  vertical(v: boolean): void
  codespace(len: number, lo: number, hi: number): void
  cid(lo: number, hi: number, cid: number): void
  unicode(lo: number, hi: number, text: string): void
}

const MAX_NUM_SIZE = 16

/** Reads a .bcmap; returns the name of the CMap it uses (usecmap), if any. */
function readBinaryCMap(data: Uint8Array, sink: BinarySink): string | undefined {
  let pos = 0
  const byte = () => (pos < data.length ? data[pos++] : -1)
  const readNumber = () => {
    let n = 0
    let last: boolean
    do {
      const b = byte()
      if (b < 0) throw new Error('unexpected end of bcmap')
      last = !(b & 0x80)
      n = n * 128 + (b & 0x7f)
    } while (!last)
    return n
  }
  const readSigned = () => {
    const n = readNumber()
    return n % 2 ? -Math.floor(n / 2) - 1 : n / 2
  }
  const readHex = (num: Uint8Array, size: number) => {
    for (let i = 0; i <= size; i++) {
      const b = byte()
      if (b < 0) throw new Error('unexpected end of bcmap')
      num[i] = b
    }
  }
  const stack = new Uint8Array(MAX_NUM_SIZE + 4)
  const readHexNumber = (num: Uint8Array, size: number) => {
    let sp = 0
    let last: boolean
    do {
      const b = byte()
      if (b < 0) throw new Error('unexpected end of bcmap')
      last = !(b & 0x80)
      stack[sp++] = b & 0x7f
    } while (!last && sp < stack.length)
    let i = size
    let buffer = 0
    let bufferSize = 0
    while (i >= 0) {
      while (bufferSize < 8 && sp > 0) {
        buffer |= stack[--sp] << bufferSize
        bufferSize += 7
      }
      num[i] = buffer & 255
      i--
      buffer >>= 8
      bufferSize -= 8
    }
  }
  const readHexSigned = (num: Uint8Array, size: number) => {
    readHexNumber(num, size)
    const sign = num[size] & 1 ? 255 : 0
    let c = 0
    for (let i = 0; i <= size; i++) {
      c = ((c & 1) << 8) | num[i]
      num[i] = (c >> 1) ^ sign
    }
  }
  const readString = () => {
    const len = readNumber()
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(readNumber())
    return s
  }
  const toInt = (a: Uint8Array, size: number) => {
    let n = 0
    for (let i = 0; i <= size; i++) n = n * 256 + a[i]
    return n
  }
  const toText = (a: Uint8Array, size: number) => utf16be(a.subarray(0, size + 1))
  const add = (a: Uint8Array, b: Uint8Array, size: number) => {
    let c = 0
    for (let i = size; i >= 0; i--) {
      c += a[i] + b[i]
      a[i] = c & 255
      c >>= 8
    }
  }
  const inc = (a: Uint8Array, size: number) => {
    let c = 1
    for (let i = size; i >= 0 && c > 0; i--) {
      c += a[i]
      a[i] = c & 255
      c >>= 8
    }
  }

  const header = byte()
  sink.vertical(!!(header & 1))
  let useCMap: string | undefined
  const start = new Uint8Array(MAX_NUM_SIZE)
  const end = new Uint8Array(MAX_NUM_SIZE)
  const char = new Uint8Array(MAX_NUM_SIZE)
  const charCode = new Uint8Array(MAX_NUM_SIZE)
  const tmp = new Uint8Array(MAX_NUM_SIZE)
  let b: number
  while ((b = byte()) >= 0) {
    const type = b >> 5
    if (type === 7) {
      const sub = b & 0x1f
      if (sub === 0) readString()
      else if (sub === 1) useCMap = readString()
      continue
    }
    const sequence = !!(b & 0x10)
    const dataSize = b & 15
    if (dataSize + 1 > MAX_NUM_SIZE) throw new Error('invalid bcmap data size')
    const ucs2Size = 1
    const count = readNumber()
    switch (type) {
      case 0: // codespace ranges
        readHex(start, dataSize)
        readHexNumber(end, dataSize)
        add(end, start, dataSize)
        sink.codespace(dataSize + 1, toInt(start, dataSize), toInt(end, dataSize))
        for (let i = 1; i < count; i++) {
          inc(end, dataSize)
          readHexNumber(start, dataSize)
          add(start, end, dataSize)
          readHexNumber(end, dataSize)
          add(end, start, dataSize)
          sink.codespace(dataSize + 1, toInt(start, dataSize), toInt(end, dataSize))
        }
        break
      case 1: // notdef ranges (ignored)
        readHex(start, dataSize)
        readHexNumber(end, dataSize)
        add(end, start, dataSize)
        readNumber()
        for (let i = 1; i < count; i++) {
          inc(end, dataSize)
          readHexNumber(start, dataSize)
          add(start, end, dataSize)
          readHexNumber(end, dataSize)
          add(end, start, dataSize)
          readNumber()
        }
        break
      case 2: {
        // cidchar
        readHex(char, dataSize)
        let code = readNumber()
        sink.cid(toInt(char, dataSize), toInt(char, dataSize), code)
        for (let i = 1; i < count; i++) {
          inc(char, dataSize)
          if (!sequence) {
            readHexNumber(tmp, dataSize)
            add(char, tmp, dataSize)
          }
          code = readSigned() + (code + 1)
          sink.cid(toInt(char, dataSize), toInt(char, dataSize), code)
        }
        break
      }
      case 3: {
        // cidrange
        readHex(start, dataSize)
        readHexNumber(end, dataSize)
        add(end, start, dataSize)
        let code = readNumber()
        sink.cid(toInt(start, dataSize), toInt(end, dataSize), code)
        for (let i = 1; i < count; i++) {
          inc(end, dataSize)
          if (!sequence) {
            readHexNumber(start, dataSize)
            add(start, end, dataSize)
          } else {
            start.set(end)
          }
          readHexNumber(end, dataSize)
          add(end, start, dataSize)
          code = readNumber()
          sink.cid(toInt(start, dataSize), toInt(end, dataSize), code)
        }
        break
      }
      case 4: {
        // bfchar (UCS2 maps)
        readHex(char, ucs2Size)
        readHex(charCode, dataSize)
        sink.unicode(toInt(char, ucs2Size), toInt(char, ucs2Size), toText(charCode, dataSize))
        for (let i = 1; i < count; i++) {
          inc(char, ucs2Size)
          if (!sequence) {
            readHexNumber(tmp, ucs2Size)
            add(char, tmp, ucs2Size)
          }
          inc(charCode, dataSize)
          readHexSigned(tmp, dataSize)
          add(charCode, tmp, dataSize)
          sink.unicode(toInt(char, ucs2Size), toInt(char, ucs2Size), toText(charCode, dataSize))
        }
        break
      }
      case 5: {
        // bfrange (UCS2 maps)
        readHex(start, ucs2Size)
        readHexNumber(end, ucs2Size)
        add(end, start, ucs2Size)
        readHex(charCode, dataSize)
        sink.unicode(toInt(start, ucs2Size), toInt(end, ucs2Size), toText(charCode, dataSize))
        for (let i = 1; i < count; i++) {
          inc(end, ucs2Size)
          if (!sequence) {
            readHexNumber(start, ucs2Size)
            add(start, end, ucs2Size)
          } else {
            start.set(end)
          }
          readHexNumber(end, ucs2Size)
          add(end, start, ucs2Size)
          readHex(charCode, dataSize)
          sink.unicode(toInt(start, ucs2Size), toInt(end, ucs2Size), toText(charCode, dataSize))
        }
        break
      }
      default:
        throw new Error(`unknown bcmap record type ${type}`)
    }
  }
  return useCMap
}

// ---------------------------------------------------------------------------------------
// Predefined CMaps

/**
 * Returns the bytes of a predefined CMap by name (e.g. "90ms-RKSJ-H", "Adobe-Japan1-UCS2"),
 * as a pdf.js binary CMap (`<name>.bcmap`) or a text CMap; null if unavailable.
 */
export type CMapLoader = (name: string) => Uint8Array | null | undefined

let customLoader: CMapLoader | null | undefined
const cmapCache = new Map<string, CMap | null>()
const unicodeCache = new Map<string, ToUnicodeMap | null>()
let defaultLoader: CMapLoader | null | undefined

/**
 * Set how predefined CMaps are loaded (synchronously). The default (Node only) reads the
 * .bcmap files shipped with pdfjs-dist; in a browser there is no default, so the host should
 * install a loader (e.g. from preloaded /pdfjs/cmaps assets). `null` disables loading.
 */
export function setCMapLoader(loader: CMapLoader | null | undefined): void {
  customLoader = loader
  cmapCache.clear()
  unicodeCache.clear()
}

/** Node default: pdfjs-dist/cmaps/<name>.bcmap (no static Node imports, so bundles stay clean). */
function nodeDefaultLoader(): CMapLoader | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown; versions?: { node?: string } } }).process
    if (!proc?.versions?.node || typeof proc.getBuiltinModule !== 'function') return null
    const fs = proc.getBuiltinModule('fs') as { readFileSync(p: string): Uint8Array; existsSync(p: string): boolean }
    const path = proc.getBuiltinModule('path') as { join(...p: string[]): string; dirname(p: string): string }
    const mod = proc.getBuiltinModule('module') as { createRequire(from: string): { resolve(id: string): string } }
    let dir: string | undefined
    try {
      dir = path.join(path.dirname(mod.createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'cmaps')
    } catch {
      dir = undefined
    }
    if (!dir || !fs.existsSync(dir)) {
      const cwd = (proc as unknown as { cwd?: () => string }).cwd?.()
      dir = cwd ? path.join(cwd, 'node_modules', 'pdfjs-dist', 'cmaps') : undefined
    }
    if (!dir || !fs.existsSync(dir)) return null
    const base = dir
    return (name: string) => {
      const file = path.join(base, `${name}.bcmap`)
      return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null
    }
  } catch {
    return null
  }
}

function loadCMapBytes(name: string): Uint8Array | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null
  let loader = customLoader
  if (loader === undefined) {
    if (defaultLoader === undefined) defaultLoader = nodeDefaultLoader()
    loader = defaultLoader
  }
  if (!loader) return null
  try {
    return loader(name) ?? null
  } catch {
    return null
  }
}

function isTextCMap(data: Uint8Array): boolean {
  // Binary CMaps start with a small header byte; text CMaps with "%!" or "/CIDInit".
  return data.length > 1 && (data[0] === 0x25 || data[0] === 0x2f)
}

/** A predefined encoding CMap (Identity-H/V built in, others via the loader). */
export function builtinCMap(name: string, depth = 0): CMap | null {
  if (name === 'Identity-H' || name === 'Identity-V') return CMap.identity(name === 'Identity-V')
  if (cmapCache.has(name)) return cmapCache.get(name)!
  let cmap: CMap | null = null
  const data = depth < 8 ? loadCMapBytes(name) : null
  if (data) {
    try {
      const use = (n: string) => builtinCMap(n, depth + 1)
      cmap = isTextCMap(data) ? CMap.parse(data, use) : CMap.parseBinary(data, use)
    } catch {
      cmap = null
    }
  }
  cmapCache.set(name, cmap)
  return cmap
}

/** A predefined CID → Unicode map, e.g. "Adobe-Japan1-UCS2". */
export function builtinUnicodeMap(name: string): ToUnicodeMap | null {
  if (unicodeCache.has(name)) return unicodeCache.get(name)!
  let map: ToUnicodeMap | null = null
  const data = loadCMapBytes(name)
  if (data) {
    try {
      map = isTextCMap(data) ? ToUnicodeMap.parse(data) : ToUnicodeMap.parseBinary(data)
    } catch {
      map = null
    }
  }
  unicodeCache.set(name, map)
  return map
}
