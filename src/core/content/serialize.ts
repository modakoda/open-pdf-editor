/**
 * Writing content stream syntax (operands and operators).
 */
import { PdfDictOp, PdfName, PdfStr, type Operand } from './lexer'
import type { Matrix } from '../model'

/** Format a number compactly, without exponent notation. */
export function fmt(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1e21) return BigInt(Math.round(n)).toString()
  if (Number.isInteger(n)) return String(n)
  let s = n.toFixed(decimals)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0') s = '0'
  return s
}

const NAME_REGULAR = /^[!-~]$/

export function writeName(name: string): string {
  let out = '/'
  for (const ch of name) {
    const c = ch.charCodeAt(0) & 0xff
    if (NAME_REGULAR.test(ch) && !'()<>[]{}/%#'.includes(ch)) out += ch
    else out += '#' + c.toString(16).padStart(2, '0')
  }
  return out
}

export function writeHexBytes(bytes: Uint8Array): string {
  let s = '<'
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s + '>'
}

export function writeLiteralBytes(bytes: Uint8Array): string {
  let s = '('
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c)
    else if (c === 0x0a) s += '\\n'
    else if (c === 0x0d) s += '\\r'
    else if (c < 0x20 || c > 0x7e) s += '\\' + c.toString(8).padStart(3, '0')
    else s += String.fromCharCode(c)
  }
  return s + ')'
}

/** A string operand; bytes are written in the representation they were read in. */
export function writeString(str: PdfStr): string {
  return str.hex ? writeHexBytes(str.bytes) : writeLiteralBytes(str.bytes)
}

/** A latin1 JS string as a PDF literal string. */
export function writeTextString(text: string): string {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return writeLiteralBytes(bytes)
}

export function writeOperand(o: Operand): string {
  if (typeof o === 'number') return fmt(o)
  if (typeof o === 'boolean') return o ? 'true' : 'false'
  if (o === null) return 'null'
  if (o instanceof PdfName) return writeName(o.name)
  if (o instanceof PdfStr) return writeString(o)
  if (o instanceof PdfDictOp) {
    let s = '<<'
    for (const [k, v] of o.map) s += writeName(k) + ' ' + writeOperand(v) + ' '
    return s + '>>'
  }
  if (Array.isArray(o)) return '[' + o.map(writeOperand).join(' ') + ']'
  return 'null'
}

export function writeOp(op: string, args: Operand[] = []): string {
  return args.length ? args.map(writeOperand).join(' ') + ' ' + op : op
}

export function writeMatrix(m: Matrix): string {
  return m.map((v) => fmt(v)).join(' ')
}

const encoder = new TextEncoder()

/** latin1 string → bytes (content syntax we generate is ASCII; strings are already escaped). */
export function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** Growable byte buffer. */
export class ByteWriter {
  private chunks: Uint8Array[] = []
  private size = 0

  bytes(b: Uint8Array): this {
    if (b.length) {
      this.chunks.push(b)
      this.size += b.length
    }
    return this
  }

  text(s: string): this {
    if (!s) return this
    // Generated syntax is ASCII; text with chars above U+00FF (not latin1) is written as UTF-8.
    let ascii = true
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) ascii = false
    return this.bytes(ascii ? latin1Bytes(s) : encoder.encode(s))
  }

  get length(): number {
    return this.size
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}
