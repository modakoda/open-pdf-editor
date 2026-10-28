/**
 * CMaps: embedded encoding CMaps of Type0 fonts (code → CID, codespace ranges) and
 * /ToUnicode CMaps (code → Unicode text). Parsed with the content stream tokenizer.
 */
import { PdfName, PdfStr, parseContent, type Operand } from './lexer'

interface Codespace {
  len: number
  lo: number
  hi: number
}

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

/** Encoding CMap of a composite font. */
export class CMap {
  codespaces: Codespace[] = []
  private single = new Map<number, number>()
  private ranges: Range[] = []
  vertical = false
  identity = false

  static identity(vertical: boolean): CMap {
    const c = new CMap()
    c.codespaces.push({ len: 2, lo: 0, hi: 0xffff })
    c.identity = true
    c.vertical = vertical
    return c
  }

  /** Read one character code at `pos`. */
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

  cid(code: number): number {
    if (this.identity) return code
    const s = this.single.get(code)
    if (s !== undefined) return s
    for (const r of this.ranges) if (code >= r.lo && code <= r.hi) return r.value + (code - r.lo)
    return 0
  }

  /** Character code for a CID (reverse lookup), used to re-encode text. */
  codeForCid(cid: number): number | undefined {
    if (this.identity) return cid
    for (const [code, c] of this.single) if (c === cid) return code
    for (const r of this.ranges) if (cid >= r.value && cid <= r.value + (r.hi - r.lo)) return r.lo + (cid - r.value)
    return undefined
  }

  static parse(data: Uint8Array, usecmap?: (name: string) => CMap | undefined): CMap {
    const cmap = new CMap()
    for (const op of parseContent(data)) {
      const a = op.args
      switch (op.op) {
        case 'endcodespacerange':
          for (let i = 0; i + 1 < a.length; i += 2) {
            const lo = a[i]
            const hi = a[i + 1]
            if (lo instanceof PdfStr && hi instanceof PdfStr && lo.bytes.length) {
              cmap.codespaces.push({ len: lo.bytes.length, lo: bytesToNumber(lo.bytes), hi: bytesToNumber(hi.bytes) })
            }
          }
          break
        case 'endcidrange':
          for (let i = 0; i + 2 < a.length; i += 3) {
            const lo = a[i]
            const hi = a[i + 1]
            const v = a[i + 2]
            if (lo instanceof PdfStr && hi instanceof PdfStr && typeof v === 'number') {
              cmap.ranges.push({ lo: bytesToNumber(lo.bytes), hi: bytesToNumber(hi.bytes), value: v })
            }
          }
          break
        case 'endcidchar':
          for (let i = 0; i + 1 < a.length; i += 2) {
            const c = a[i]
            const v = a[i + 1]
            if (c instanceof PdfStr && typeof v === 'number') cmap.single.set(bytesToNumber(c.bytes), v)
          }
          break
        case 'usecmap': {
          const n = a[a.length - 1]
          if (n instanceof PdfName) {
            const base = /^Identity-[HV]$/.test(n.name) ? CMap.identity(n.name.endsWith('V')) : usecmap?.(n.name)
            if (base) {
              if (base.identity && !cmap.ranges.length && !cmap.single.size) cmap.identity = true
              cmap.codespaces.push(...base.codespaces)
              cmap.ranges.push(...base.ranges)
              for (const [k, v] of base.single) if (!cmap.single.has(k)) cmap.single.set(k, v)
            }
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
    if (cmap.identity && (cmap.ranges.length || cmap.single.size)) cmap.identity = false
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

/** /ToUnicode CMap. */
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
            if (t === undefined) continue
            if (h - l <= 256) for (let c = l; c <= h; c++) m.map.set(c, incrementText(t, c - l))
            else m.ranges.push({ lo: l, hi: h, start: t })
          }
        }
      }
    }
    return m
  }
}
