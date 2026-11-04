/**
 * Glyph names → Unicode (subset of the Adobe Glyph List plus the algorithmic uniXXXX / uXXXX
 * forms) and the standard single-byte encodings.
 */
import {
  DINGBATS_GLYPH_LIST_DATA,
  GLYPH_LIST_DATA,
  MacExpertEncoding,
  MacRomanEncoding,
  StandardEncoding,
  SymbolSetEncoding,
  WinAnsiEncoding,
  ZapfDingbatsEncoding
} from './encodings'

let glyphMap: Map<string, number> | null = null
let dingbatsMap: Map<string, number> | null = null

function parseList(data: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const entry of data.split(',')) {
    const sp = entry.indexOf(' ')
    if (sp > 0) map.set(entry.slice(0, sp), parseInt(entry.slice(sp + 1), 16))
  }
  return map
}

function glyphs(): Map<string, number> {
  return (glyphMap ??= parseList(GLYPH_LIST_DATA))
}

function dingbats(): Map<string, number> {
  return (dingbatsMap ??= parseList(DINGBATS_GLYPH_LIST_DATA))
}

function fromHexUnits(hex: string): string | undefined {
  if (!hex || hex.length % 4 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) return undefined
  let s = ''
  for (let i = 0; i < hex.length; i += 4) {
    const v = parseInt(hex.slice(i, i + 4), 16)
    if (v >= 0xd800 && v <= 0xdfff && hex.length === 4) return undefined
    s += String.fromCharCode(v)
  }
  return s
}

/** Unicode text for a glyph name, or undefined if unknown. */
export function glyphToUnicode(name: string, isDingbats = false): string | undefined {
  if (!name) return undefined
  const direct = (isDingbats ? dingbats().get(name) : undefined) ?? glyphs().get(name)
  if (direct !== undefined) return String.fromCodePoint(direct)
  if (name.startsWith('uni') && name.length >= 7) {
    const s = fromHexUnits(name.slice(3))
    if (s) return s
  }
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) {
    const cp = parseInt(name.slice(1), 16)
    if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp)
  }
  const dot = name.indexOf('.')
  if (dot > 0) return glyphToUnicode(name.slice(0, dot), isDingbats)
  if (name.includes('_')) {
    const parts = name.split('_').map((p) => glyphToUnicode(p, isDingbats))
    if (parts.every((p) => p !== undefined)) return parts.join('')
  }
  return undefined
}

export type BaseEncodingName =
  | 'StandardEncoding'
  | 'MacRomanEncoding'
  | 'WinAnsiEncoding'
  | 'MacExpertEncoding'
  | 'SymbolSetEncoding'
  | 'ZapfDingbatsEncoding'

export function baseEncoding(name: string | undefined): string[] | undefined {
  switch (name) {
    case 'StandardEncoding':
      return StandardEncoding
    case 'MacRomanEncoding':
      return MacRomanEncoding
    case 'WinAnsiEncoding':
      return WinAnsiEncoding
    case 'MacExpertEncoding':
      return MacExpertEncoding
    case 'SymbolSetEncoding':
      return SymbolSetEncoding
    case 'ZapfDingbatsEncoding':
      return ZapfDingbatsEncoding
    default:
      return undefined
  }
}

/** Order in which codes are preferred when encoding (WinAnsi has duplicates like 0xA0 = space). */
export const ENCODE_PREFERENCE: number[] = (() => {
  const dup = new Set([0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xa0, 0xad])
  const order: number[] = []
  for (let c = 0x20; c < 0x7f; c++) order.push(c)
  for (let c = 0x80; c < 0x100; c++) if (!dup.has(c)) order.push(c)
  for (let c = 0; c < 0x20; c++) order.push(c)
  for (const c of dup) order.push(c)
  return order
})()
