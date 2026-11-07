/**
 * PDF fonts as needed by the content engine: glyph advances, Unicode decoding, vertical
 * metrics for text boxes, style guesses, and re-encoding of replacement text.
 *
 * Supported: simple fonts (Type1, MMType1, TrueType, Type3) via /Widths, /FirstChar,
 * /MissingWidth, the standard-14 AFM metrics when /Widths is missing, /Encoding (base
 * encodings + /Differences, built-in encoding of embedded Type1 programs) and /ToUnicode;
 * composite fonts (Type0 with CIDFontType0/2) via /W, /DW, /W2, /DW2, Identity-H/V and
 * embedded CMaps, /ToUnicode, else the embedded TrueType program's cmap.
 */
import fontkit from '@cantoo/fontkit'
import { PDFArray, PDFDict, PDFName, PDFStream, StandardFontEmbedder, type PDFContext, type PDFObject } from '@cantoo/pdf-lib'
import type { FontFamily, Matrix } from '../model'
import { CMap, ToUnicodeMap, builtinCMap, builtinUnicodeMap } from './cmap'
import { ENCODE_PREFERENCE, baseEncoding, glyphToUnicode } from './glyphs'
import {
  arrayItems,
  get,
  getArray,
  getDict,
  getMatrix,
  getName,
  getNumber,
  getStream,
  nameOf,
  numberArray,
  numberOf,
  streamData,
  stringBytes
} from './pdfobj'

export interface Glyph {
  code: number
  /** Number of bytes of the character code. */
  len: number
  /**
   * Advance in text space units for font size 1 (horizontal: w0; vertical writing: w1y,
   * usually negative = downwards).
   */
  width: number
  unicode: string
  /** Single-byte code 32: word spacing (Tw) applies. */
  space: boolean
}

export interface FontInfo {
  baseFont: string
  /** BaseFont without the subset prefix ("ABCDEF+"). */
  name: string
  subtype: string
  subset: boolean
  embedded: boolean
  /** Standard-14 font this font is (when not embedded). */
  standard?: string
  composite: boolean
  type3: boolean
  vertical: boolean
  /** Ascent / descent (negative) in text space units for font size 1. */
  ascent: number
  descent: number
  /** Width of a space in text space units for size 1 (0 = unknown). */
  spaceWidth: number
  family: FontFamily
  bold: boolean
  italic: boolean
  /**
   * Replacement text can be encoded with this font: simple non-subset fonts with a known
   * encoding, and Identity-H fonts with an embedded TrueType program (only the characters
   * whose glyphs the program contains, so encode() can still fail for subsets).
   */
  editable: boolean
  /**
   * The character code → glyph mapping is not known (a predefined CMap that could not be
   * loaded): glyph boundaries and widths are guesses, so layout-dependent edits are unsafe.
   */
  encodingUnknown: boolean
  glyphs(bytes: Uint8Array): Glyph[]
  /**
   * Encode text (no line breaks) with this font; null if a character cannot be encoded.
   * `known`: further character → code mappings seen in the content (see ActualSpan).
   */
  encode(text: string, known?: ReadonlyMap<string, number>): Uint8Array | null
  /**
   * /ToUnicode entries that text extraction needs to yield `text` from encode(text): codes
   * without an entry (or mapped to U+0000) → their character. null when a code is mapped to
   * other text (the caller then marks the encoded text with /ActualText).
   */
  toUnicodeAdditions(text: string, known?: ReadonlyMap<string, number>): Map<number, string> | null
}

/** A /ToUnicode entry of U+0000 only: no mapping (Chrome writes these and uses /ActualText). */
function isNul(u: string): boolean {
  return u.length > 0 && /^\0+$/.test(u)
}

// ---------------------------------------------------------------------------------------
// Standard 14 fonts

const STD14 = new Set([
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats'
])

const STD_ALIASES: Record<string, string> = {
  Arial: 'Helvetica',
  'Arial-Bold': 'Helvetica-Bold',
  'Arial-Italic': 'Helvetica-Oblique',
  'Arial-BoldItalic': 'Helvetica-BoldOblique',
  ArialMT: 'Helvetica',
  'Arial-BoldMT': 'Helvetica-Bold',
  'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  'Helvetica-Italic': 'Helvetica-Oblique',
  'Helvetica-BoldItalic': 'Helvetica-BoldOblique',
  'Courier-Italic': 'Courier-Oblique',
  'Courier-BoldItalic': 'Courier-BoldOblique',
  CourierNew: 'Courier',
  'CourierNew-Bold': 'Courier-Bold',
  'CourierNew-Italic': 'Courier-Oblique',
  'CourierNew-BoldItalic': 'Courier-BoldOblique',
  CourierNewPSMT: 'Courier',
  'CourierNewPS-BoldMT': 'Courier-Bold',
  'CourierNewPS-ItalicMT': 'Courier-Oblique',
  'CourierNewPS-BoldItalicMT': 'Courier-BoldOblique',
  TimesNewRoman: 'Times-Roman',
  'TimesNewRoman-Bold': 'Times-Bold',
  'TimesNewRoman-Italic': 'Times-Italic',
  'TimesNewRoman-BoldItalic': 'Times-BoldItalic',
  TimesNewRomanPSMT: 'Times-Roman',
  'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic',
  'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  'Symbol-Bold': 'Symbol',
  'Symbol-Italic': 'Symbol'
}

function standardName(name: string): string | undefined {
  const n = name.replace(/\s+/g, '').replace(/,/g, '-')
  if (STD14.has(n)) return n
  return STD_ALIASES[n]
}

type AfmFont = StandardFontEmbedder['font']
const afmCache = new Map<string, AfmFont | null>()
function afm(name: string): AfmFont | null {
  if (afmCache.has(name)) return afmCache.get(name)!
  let f: AfmFont | null = null
  try {
    f = StandardFontEmbedder.for(name as never).font
  } catch {
    f = null
  }
  afmCache.set(name, f)
  return f
}

// ---------------------------------------------------------------------------------------
// Style guesses

const FLAG_FIXED = 1
const FLAG_SERIF = 2
const FLAG_SYMBOLIC = 4
const FLAG_ITALIC = 64
const FLAG_FORCE_BOLD = 1 << 18

function guessStyle(
  name: string,
  descriptor: PDFDict | undefined
): { family: FontFamily; bold: boolean; italic: boolean } {
  const lower = name.toLowerCase()
  const flags = getNumber(descriptor, 'Flags') ?? 0
  const weight = getNumber(descriptor, 'FontWeight') ?? 0
  const italicAngle = getNumber(descriptor, 'ItalicAngle') ?? 0
  const bold =
    /bold|black|heavy|semibold|demi|extrabold|ultrabold|w[6-9]\b/.test(lower) ||
    weight >= 600 ||
    (flags & FLAG_FORCE_BOLD) !== 0
  const italic = /italic|oblique|slanted|kursiv/.test(lower) || (flags & FLAG_ITALIC) !== 0 || Math.abs(italicAngle) > 0.5
  let family: FontFamily = 'sans'
  if ((flags & FLAG_FIXED) !== 0 || /courier|mono|consol|menlo|typewriter|code|fixed|lucidaconsole/.test(lower)) {
    family = 'mono'
  } else if (
    /sans|arial|helvet|verdana|tahoma|calibri|segoe|gothic|futura|roboto|ubuntu|dejavusans|liberationsans|frutiger|myriad|univers|avenir|lato|open ?sans|source ?sans/.test(
      lower
    )
  ) {
    family = 'sans'
  } else if (
    (flags & FLAG_SERIF) !== 0 ||
    /times|serif|roman|georgia|garamond|cambria|palatino|minion|baskerville|bookman|book ?antiqua|century|caslon|didot|bodoni|cmr|lmroman|nimbusrom|utopia|charter/.test(
      lower
    )
  ) {
    family = 'serif'
  }
  return { family, bold, italic }
}

// ---------------------------------------------------------------------------------------
// Shared helpers

function stringOf(o: PDFObject | undefined): string | undefined {
  const b = stringBytes(o)
  if (b) return String.fromCharCode(...b)
  return nameOf(o)
}

function stripSubset(name: string): { name: string; subset: boolean } {
  const m = /^[A-Z]{6}\+(.*)$/.exec(name)
  return m ? { name: m[1], subset: true } : { name, subset: false }
}

function descriptorMetrics(
  descriptor: PDFDict | undefined,
  fallback: { ascent: number; descent: number }
): { ascent: number; descent: number } {
  let ascent = getNumber(descriptor, 'Ascent')
  let descent = getNumber(descriptor, 'Descent')
  const bbox = numberArray(descriptor?.context as PDFContext, getArray(descriptor, 'FontBBox'))
  if (!ascent || ascent <= 0) ascent = bbox && bbox.length === 4 && bbox[3] > 0 ? bbox[3] : undefined
  if (descent === undefined || descent === 0) descent = bbox && bbox.length === 4 && bbox[1] < 0 ? bbox[1] : undefined
  let a = ascent !== undefined ? ascent / 1000 : fallback.ascent
  let d = descent !== undefined ? -Math.abs(descent) / 1000 : fallback.descent
  if (!(a > 0.2) || a > 1.6) a = fallback.ascent
  if (!(d < 0) || d < -1) d = fallback.descent
  return { ascent: a, descent: d }
}

const DEFAULT_METRICS = { ascent: 0.8, descent: -0.2 }

function hasFontFile(descriptor: PDFDict | undefined): boolean {
  return !!(get(descriptor, 'FontFile') || get(descriptor, 'FontFile2') || get(descriptor, 'FontFile3'))
}

function readToUnicode(dict: PDFDict): ToUnicodeMap | undefined {
  const s = getStream(dict, 'ToUnicode')
  const data = streamData(s)
  if (!data) return undefined
  try {
    const m = ToUnicodeMap.parse(data)
    return m.size ? m : undefined
  } catch {
    return undefined
  }
}

/** Built-in encoding of an embedded Type1 font program (`dup <code> /<name> put` entries). */
function type1BuiltinEncoding(descriptor: PDFDict | undefined): string[] | undefined {
  const data = streamData(getStream(descriptor, 'FontFile'))
  if (!data) return undefined
  const limit = Math.min(data.length, 65536)
  let text = ''
  for (let i = 0; i < limit; i++) text += String.fromCharCode(data[i])
  const eexec = text.indexOf('eexec')
  if (eexec > 0) text = text.slice(0, eexec)
  if (/\/Encoding\s+StandardEncoding\s+def/.test(text)) return undefined
  const names = new Array<string>(256).fill('')
  let found = false
  for (const m of text.matchAll(/dup\s+(\d+)\s*\/([^\s/[\]{}()<>]+)\s+put/g)) {
    const code = Number(m[1])
    if (code >= 0 && code < 256) {
      names[code] = m[2]
      found = true
    }
  }
  return found ? names : undefined
}

// ---------------------------------------------------------------------------------------
// Simple fonts

interface FontkitGlyphs {
  hasGlyphForCodePoint(cp: number): boolean
}

interface FontkitProgram {
  numGlyphs: number
  characterSet: number[]
  glyphForCodePoint(cp: number): { id: number }
  getGlyph(gid: number): { path: { commands: unknown[] } }
}

/** Parse an embedded font program (first font of a collection); null if fontkit cannot. */
function parseProgram(data: Uint8Array | undefined): FontkitProgram | null {
  if (!data) return null
  try {
    const created = fontkit.create(data as never) as unknown
    const font = (created as { fonts?: unknown[] }).fonts ? (created as { fonts: unknown[] }).fonts[0] : created
    const f = font as FontkitProgram
    return f && typeof f.glyphForCodePoint === 'function' && typeof f.getGlyph === 'function' ? f : null
  } catch {
    return null
  }
}

function hasOutline(program: FontkitProgram, gid: number): boolean {
  try {
    return program.getGlyph(gid).path.commands.length > 0
  } catch {
    return false
  }
}

class SimpleFont implements FontInfo {
  baseFont: string
  name: string
  subtype: string
  subset: boolean
  embedded: boolean
  standard?: string
  composite = false
  type3: boolean
  vertical = false
  ascent: number
  descent: number
  spaceWidth: number
  family: FontFamily
  bold: boolean
  italic: boolean
  editable: boolean
  encodingUnknown = false
  private names: string[]
  private fontFile: { data?: Uint8Array; font?: FontkitGlyphs | null } | undefined
  private nonSymbolic = true
  private widths = new Float64Array(256)
  private hasWidth = new Uint8Array(256)
  private unicodes: string[] = new Array(256)
  private reverse: Map<string, number> | null = null
  private unextractable = new Set<number>()
  private cache: Glyph[] = new Array(256)
  private isDingbats: boolean

  constructor(dict: PDFDict) {
    const ctx = dict.context
    this.subtype = getName(dict, 'Subtype') ?? 'Type1'
    this.type3 = this.subtype === 'Type3'
    this.baseFont = getName(dict, 'BaseFont') ?? getName(dict, 'Name') ?? ''
    const stripped = stripSubset(this.baseFont)
    this.name = stripped.name
    this.subset = stripped.subset
    const descriptor = getDict(dict, 'FontDescriptor')
    this.embedded = hasFontFile(descriptor)
    this.standard = !this.embedded && !this.type3 ? standardName(this.name) : undefined
    const std = this.standard ? afm(this.standard) : null
    const flags = getNumber(descriptor, 'Flags') ?? 0
    this.isDingbats = this.standard === 'ZapfDingbats'
    this.nonSymbolic = !(flags & FLAG_SYMBOLIC)
    if (this.embedded) this.fontFile = { data: streamData(getStream(descriptor, 'FontFile2') ?? getStream(descriptor, 'FontFile3')) }

    // Font matrix (Type3) → scale of glyph space widths.
    let fontMatrix: Matrix = [0.001, 0, 0, 0.001, 0, 0]
    if (this.type3) fontMatrix = getMatrix(dict, 'FontMatrix') ?? fontMatrix
    const wScale = fontMatrix[0]

    // Encoding.
    const encObj = get(dict, 'Encoding')
    let base: string[] | undefined
    let differences: PDFArray | undefined
    let encodingKnown = false
    if (encObj instanceof PDFName) {
      base = baseEncoding(nameOf(encObj))
      encodingKnown = !!base
    } else if (encObj instanceof PDFDict) {
      base = baseEncoding(getName(encObj, 'BaseEncoding'))
      differences = getArray(encObj, 'Differences')
      encodingKnown = true
    }
    if (!base) {
      if (this.standard === 'Symbol') base = baseEncoding('SymbolSetEncoding')
      else if (this.standard === 'ZapfDingbats') base = baseEncoding('ZapfDingbatsEncoding')
      else if (this.standard) base = baseEncoding('StandardEncoding')
      else if (this.type3) base = undefined
      else if (this.subtype === 'Type1' || this.subtype === 'MMType1') {
        base = type1BuiltinEncoding(descriptor) ?? baseEncoding('StandardEncoding')
        if (!(flags & FLAG_SYMBOLIC)) encodingKnown = encodingKnown || !this.embedded
      } else if (!(flags & FLAG_SYMBOLIC)) {
        base = baseEncoding('StandardEncoding')
      }
      if (this.standard) encodingKnown = true
    }
    const names = base ? base.slice() : new Array<string>(256).fill('')
    if (differences) {
      let code = 0
      for (const item of arrayItems(ctx, differences)) {
        const n = numberOf(item)
        if (n !== undefined) code = Math.floor(n)
        else if (item instanceof PDFName) {
          if (code >= 0 && code < 256) names[code] = item.decodeText()
          code++
        }
      }
    }
    this.names = names

    // Widths.
    const widthsArr = getArray(dict, 'Widths')
    const first = getNumber(dict, 'FirstChar') ?? 0
    const missing = getNumber(descriptor, 'MissingWidth') ?? 0
    const widthNums = widthsArr ? arrayItems(ctx, widthsArr).map((o) => numberOf(o) ?? 0) : undefined
    for (let code = 0; code < 256; code++) {
      let w: number | undefined
      if (widthNums && !(std && widthNums.length === 0)) {
        const i = code - first
        if (i >= 0 && i < widthNums.length) {
          w = widthNums[i]
          this.hasWidth[code] = 1
        }
      } else if (std) {
        // Like pdf.js: a /Differences glyph missing from the AFM falls back to the base
        // encoding's glyph for the code.
        let gw = names[code] ? std.getWidthOfGlyph(names[code]) : undefined
        if (typeof gw !== 'number' && base?.[code]) gw = std.getWidthOfGlyph(base[code])
        if (typeof gw === 'number') {
          w = gw
          this.hasWidth[code] = 1
        }
      }
      this.widths[code] = (w ?? missing) * (this.type3 ? wScale : 0.001)
    }

    // Unicode.
    const toUnicode = readToUnicode(dict)
    for (let code = 0; code < 256; code++) {
      let u = toUnicode?.get(code)
      if (u !== undefined && isNul(u)) {
        // Extraction yields nothing for the code: decode it, but do not re-encode with it.
        u = undefined
        this.unextractable.add(code)
      }
      if (u === undefined && names[code]) u = glyphToUnicode(names[code], this.isDingbats)
      if (u === undefined) u = code >= 0x20 && code !== 0x7f ? String.fromCharCode(code) : ''
      this.unicodes[code] = u
    }

    // Metrics.
    if (this.type3) {
      const bbox = numberArray(ctx, getArray(dict, 'FontBBox'))
      let a = 0.8
      let d = -0.2
      if (bbox && bbox.length === 4 && (bbox[1] || bbox[3])) {
        const y0 = bbox[1] * fontMatrix[3]
        const y1 = bbox[3] * fontMatrix[3]
        a = Math.max(y0, y1)
        d = Math.min(y0, y1)
        if (!(a > 0)) a = 0.8
        if (!(d < 0)) d = Math.min(d, 0)
      }
      this.ascent = a
      this.descent = d
    } else {
      const fb = std
        ? {
            ascent: ((std.Ascender as number) || std.FontBBox[3]) / 1000,
            descent: ((std.Descender as number) || std.FontBBox[1]) / 1000
          }
        : DEFAULT_METRICS
      const m = descriptorMetrics(descriptor, fb)
      this.ascent = m.ascent
      this.descent = m.descent
    }

    let space = this.hasWidth[32] && names[32] !== '' ? this.widths[32] : 0
    if (!space) {
      const code = names.indexOf('space')
      if (code >= 0 && this.hasWidth[code]) space = this.widths[code]
    }
    if (!space && std) space = ((std.getWidthOfGlyph('space') as number) || 0) / 1000
    this.spaceWidth = space > 0 ? space : 0

    const style = guessStyle(this.name, descriptor)
    this.family = this.standard?.startsWith('Courier')
      ? 'mono'
      : this.standard?.startsWith('Times')
        ? 'serif'
        : this.standard?.startsWith('Helvetica')
          ? 'sans'
          : style.family
    this.bold = style.bold
    this.italic = style.italic
    this.editable = !this.type3 && !this.subset && encodingKnown && this.subtype !== 'Type0'
  }

  glyphs(bytes: Uint8Array): Glyph[] {
    const out = new Array<Glyph>(bytes.length)
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i]
      let g = this.cache[code]
      if (!g) {
        g = { code, len: 1, width: this.widths[code], unicode: this.unicodes[code], space: code === 32 }
        this.cache[code] = g
      }
      out[i] = g
    }
    return out
  }

  /** Whether the embedded font program (TrueType/OpenType) has a glyph for the character. */
  private programHasGlyph(u: string): boolean {
    if (!this.fontFile) return true
    if (this.fontFile.font === undefined) {
      this.fontFile.font = null
      const data = this.fontFile.data
      if (data && this.nonSymbolic) {
        try {
          const created = fontkit.create(data as never) as unknown
          const font = (created as { fonts?: unknown[] }).fonts ? (created as { fonts: unknown[] }).fonts[0] : created
          if (font && typeof (font as FontkitGlyphs).hasGlyphForCodePoint === 'function') this.fontFile.font = font as FontkitGlyphs
        } catch {
          this.fontFile.font = null
        }
      }
    }
    const f = this.fontFile.font
    if (!f) return true
    const cp = u.codePointAt(0)!
    return u === ' ' || f.hasGlyphForCodePoint(cp)
  }

  encode(text: string): Uint8Array | null {
    if (!this.editable) return null
    if (!this.reverse) {
      this.reverse = new Map()
      const std = this.standard ? afm(this.standard) : null
      for (const code of ENCODE_PREFERENCE) {
        const u = this.unicodes[code]
        const name = this.names[code]
        if (!u || !name || this.reverse.has(u) || this.unextractable.has(code)) continue
        // The glyph must exist in the font: known, non-zero width (Word writes 0 for codes it
        // did not use), in the AFM for standard fonts, in the embedded program if parseable.
        if (!this.hasWidth[code]) continue
        if (!(this.widths[code] > 0) && u !== ' ') continue
        if (std && std.getWidthOfGlyph(name) === undefined) continue
        if (!this.programHasGlyph(u)) continue
        this.reverse.set(u, code)
      }
    }
    const out: number[] = []
    for (const ch of text) {
      let code = this.reverse.get(ch)
      if (code === undefined && ch === ' ') code = this.reverse.get(' ')
      if (code === undefined) return null
      out.push(code)
    }
    return Uint8Array.from(out)
  }

  toUnicodeAdditions(): Map<number, string> {
    return new Map()
  }
}

// ---------------------------------------------------------------------------------------
// Composite fonts

class CompositeFont implements FontInfo {
  baseFont: string
  name: string
  subtype = 'Type0'
  subset: boolean
  embedded: boolean
  composite = true
  type3 = false
  vertical: boolean
  ascent: number
  descent: number
  spaceWidth = 0
  family: FontFamily
  bold: boolean
  italic: boolean
  editable = false
  encodingUnknown = false
  private cmap: CMap
  private ucs2: boolean
  private cidUnicode: ToUnicodeMap | null = null
  private toUnicode?: ToUnicodeMap
  private dw: number
  private w = new Map<number, number>()
  private wRanges: { lo: number; hi: number; w: number }[] = []
  private dw2: [number, number]
  private w2 = new Map<number, number>()
  private cache = new Map<number, Glyph>()
  private gidToUnicode: Map<number, string> | null | undefined
  private cidToGid: Uint8Array | undefined
  private descendant: PDFDict | undefined
  private program: FontkitProgram | null | undefined
  private reverse: Map<string, number> | null = null

  constructor(dict: PDFDict) {
    const ctx = dict.context
    this.baseFont = getName(dict, 'BaseFont') ?? ''
    const stripped = stripSubset(this.baseFont)
    this.name = stripped.name.replace(/-Identity-[HV]$/, '')
    this.subset = stripped.subset
    const descendants = getArray(dict, 'DescendantFonts')
    const d0 = descendants ? arrayItems(ctx, descendants)[0] : undefined
    const desc = d0 instanceof PDFDict ? d0 : undefined
    this.descendant = desc
    const descriptor = getDict(desc, 'FontDescriptor')
    this.embedded = hasFontFile(descriptor)

    const enc = get(dict, 'Encoding')
    const encName = nameOf(enc)
    this.ucs2 = !!encName && /UCS2|UTF16/.test(encName)
    if (encName === 'Identity-H' || encName === 'Identity-V') {
      this.cmap = CMap.identity(encName === 'Identity-V')
    } else if (enc instanceof PDFStream) {
      const data = streamData(enc)
      let cmap: CMap | undefined
      try {
        cmap = data ? CMap.parse(data) : undefined
      } catch {
        cmap = undefined
      }
      this.cmap = cmap ?? CMap.identity(false)
      this.encodingUnknown = !cmap || cmap.incomplete
      const wmode = getNumber(enc.dict, 'WMode')
      if (wmode === 1) this.cmap.vertical = true
    } else {
      // Predefined CMap (90ms-RKSJ-H, GBK-EUC-H, UniJIS-UCS2-H, …) via the CMap loader.
      const builtin = encName ? builtinCMap(encName) : null
      this.cmap = builtin && !builtin.incomplete ? builtin : CMap.identity(!!encName && encName.endsWith('-V'))
      this.encodingUnknown = !builtin || builtin.incomplete
    }
    this.vertical = this.cmap.vertical
    this.toUnicode = readToUnicode(dict)
    if (!this.toUnicode && !this.ucs2) {
      // Character collections with a predefined CID → Unicode map (pdf.js does the same).
      const info = getDict(desc, 'CIDSystemInfo')
      const reg = info ? stringOf(get(info, 'Registry')) : undefined
      const ord = info ? stringOf(get(info, 'Ordering')) : undefined
      if (reg === 'Adobe' && ord && ['GB1', 'CNS1', 'Japan1', 'Korea1'].includes(ord)) {
        this.cidUnicode = builtinUnicodeMap(`Adobe-${ord}-UCS2`)
      }
    }

    this.dw = getNumber(desc, 'DW') ?? 1000
    const wArr = getArray(desc, 'W')
    if (wArr) {
      const items = arrayItems(ctx, wArr)
      for (let i = 0; i < items.length; ) {
        const first = numberOf(items[i])
        const next = items[i + 1]
        if (first === undefined) {
          i++
          continue
        }
        if (next instanceof PDFArray) {
          const ws = arrayItems(ctx, next)
          ws.forEach((o, k) => this.w.set(first + k, numberOf(o) ?? this.dw))
          i += 2
        } else {
          const last = numberOf(next)
          const w = numberOf(items[i + 2])
          if (last !== undefined && w !== undefined) {
            if (last - first < 512) for (let c = first; c <= last; c++) this.w.set(c, w)
            else this.wRanges.push({ lo: first, hi: last, w })
          }
          i += 3
        }
      }
    }
    const dw2 = numberArray(ctx, getArray(desc, 'DW2'))
    this.dw2 = dw2 && dw2.length === 2 ? [dw2[0], dw2[1]] : [880, -1000]
    const w2Arr = getArray(desc, 'W2')
    if (w2Arr) {
      const items = arrayItems(ctx, w2Arr)
      for (let i = 0; i < items.length; ) {
        const first = numberOf(items[i])
        const next = items[i + 1]
        if (first === undefined) {
          i++
          continue
        }
        if (next instanceof PDFArray) {
          const ws = arrayItems(ctx, next).map((o) => numberOf(o) ?? 0)
          for (let k = 0; k * 3 < ws.length; k++) this.w2.set(first + k, ws[k * 3])
          i += 2
        } else {
          const last = numberOf(next)
          const w1 = numberOf(items[i + 2])
          if (last !== undefined && w1 !== undefined && last - first < 4096) for (let c = first; c <= last; c++) this.w2.set(c, w1)
          i += 5
        }
      }
    }
    const cidToGid = get(desc, 'CIDToGIDMap')
    if (cidToGid instanceof PDFStream) this.cidToGid = streamData(cidToGid)
    // Identity-H: the code is the CID, so text can be re-encoded from the glyphs of the
    // embedded TrueType program (what browsers' "Save as PDF" and most generators write).
    this.editable = encName === 'Identity-H' && !!getStream(descriptor, 'FontFile2')

    const m = descriptorMetrics(descriptor, { ascent: 0.88, descent: -0.12 })
    this.ascent = m.ascent
    this.descent = m.descent
    const style = guessStyle(this.name, descriptor)
    this.family = style.family
    this.bold = style.bold
    this.italic = style.italic

    // Space width: the code that maps to " ".
    const spaceCode = this.toUnicode?.codeFor(' ') ?? (this.ucs2 ? 32 : undefined)
    if (spaceCode !== undefined) this.spaceWidth = this.widthOfCid(this.cmap.cid(spaceCode)) / 1000
  }

  private widthOfCid(cid: number): number {
    const w = this.w.get(cid)
    if (w !== undefined) return w
    for (const r of this.wRanges) if (cid >= r.lo && cid <= r.hi) return r.w
    return this.dw
  }

  private hasWidth(cid: number): boolean {
    return this.w.has(cid) || this.wRanges.some((r) => cid >= r.lo && cid <= r.hi)
  }

  private gidOf(cid: number): number {
    if (this.cidToGid && this.cidToGid.length >= cid * 2 + 2) return (this.cidToGid[cid * 2] << 8) | this.cidToGid[cid * 2 + 1]
    return cid
  }

  private fallbackUnicode(code: number, cid: number): string {
    if (this.ucs2) return String.fromCharCode(code)
    const viaCid = this.cidUnicode?.get(cid)
    if (viaCid) return viaCid
    if (this.gidToUnicode === undefined) this.gidToUnicode = this.buildGidMap()
    if (this.gidToUnicode) {
      const u = this.gidToUnicode.get(this.gidOf(cid))
      if (u) return u
    }
    return '�'
  }

  /** The embedded TrueType/OpenType program, parsed once. */
  private fontProgram(): FontkitProgram | null {
    if (this.program === undefined) {
      const descriptor = getDict(this.descendant, 'FontDescriptor')
      this.program = parseProgram(streamData(getStream(descriptor, 'FontFile2') ?? getStream(descriptor, 'FontFile3')))
    }
    return this.program
  }

  /** Reverse cmap of an embedded TrueType/OpenType program (GID → Unicode). */
  private buildGidMap(): Map<number, string> | null {
    const f = this.fontProgram()
    if (!f) return null
    try {
      const map = new Map<number, string>()
      for (const cp of f.characterSet) {
        const id = f.glyphForCodePoint(cp).id
        if (id && !map.has(id)) map.set(id, String.fromCodePoint(cp))
      }
      return map
    } catch {
      return null
    }
  }

  /**
   * Character → code for re-encoding (editable fonts): /ToUnicode entries first, then the
   * program's cmap. Only glyphs that are really there: a /W width, and an outline unless the
   * character is whitespace (subsets keep the glyph ids of unused glyphs, but empty).
   */
  private reverseMap(): Map<string, number> {
    if (this.reverse) return this.reverse
    const rev = new Map<string, number>()
    this.reverse = rev
    const program = this.fontProgram()
    if (!program) return rev
    const usable = (cid: number, ch: string): boolean => {
      if (cid > 0xffff || !this.hasWidth(cid) || !(this.widthOfCid(cid) > 0)) return false
      const gid = this.gidOf(cid)
      if (gid <= 0 || gid >= program.numGlyphs) return false
      return !ch.trim() || hasOutline(program, gid)
    }
    this.toUnicode?.forEach((code, u) => {
      if ([...u].length !== 1) return
      if (!rev.has(u) && !isNul(u) && usable(code, u)) rev.set(u, code)
    })
    let cidOfGid: Map<number, number> | undefined
    if (this.cidToGid) {
      cidOfGid = new Map()
      for (let cid = 0; cid * 2 + 1 < this.cidToGid.length; cid++) {
        const gid = this.gidOf(cid)
        if (!cidOfGid.has(gid)) cidOfGid.set(gid, cid)
      }
    }
    try {
      for (const cp of program.characterSet) {
        const ch = String.fromCodePoint(cp)
        if (rev.has(ch)) continue
        const gid = program.glyphForCodePoint(cp).id
        const cid = cidOfGid ? cidOfGid.get(gid) : gid
        if (cid !== undefined && usable(cid, ch)) rev.set(ch, cid)
      }
    } catch {
      // A broken cmap: the /ToUnicode entries are enough.
    }
    return rev
  }

  private codeFor(ch: string, known?: ReadonlyMap<string, number>): number | undefined {
    const rev = this.reverseMap()
    return rev.get(ch) ?? known?.get(ch) ?? (ch.trim() ? undefined : rev.get(' '))
  }

  glyphs(bytes: Uint8Array): Glyph[] {
    const out: Glyph[] = []
    let pos = 0
    while (pos < bytes.length) {
      const { code, len } = this.cmap.readCode(bytes, pos)
      pos += len
      const key = code * 8 + len
      let g = this.cache.get(key)
      if (!g) {
        const cid = this.cmap.cid(code)
        const width = this.vertical ? (this.w2.get(cid) ?? this.dw2[1]) / 1000 : this.widthOfCid(cid) / 1000
        let unicode = this.toUnicode?.get(code)
        if (unicode === undefined || isNul(unicode)) unicode = this.fallbackUnicode(code, cid)
        g = { code, len, width, unicode, space: len === 1 && code === 32 }
        this.cache.set(key, g)
      }
      out.push(g)
    }
    return out
  }

  encode(text: string, known?: ReadonlyMap<string, number>): Uint8Array | null {
    if (!this.editable) return null
    const out: number[] = []
    for (const ch of text) {
      const code = this.codeFor(ch, known)
      if (code === undefined) return null
      out.push(code >> 8, code & 0xff)
    }
    return Uint8Array.from(out)
  }

  toUnicodeAdditions(text: string, known?: ReadonlyMap<string, number>): Map<number, string> | null {
    const add = new Map<number, string>()
    const rev = this.reverseMap()
    for (const ch of text) {
      const code = this.codeFor(ch, known)
      if (code === undefined || !ch.trim()) continue
      if (!this.toUnicode) {
        // Extraction falls back to the program's cmap, which knows rev's characters only.
        if (rev.get(ch) !== code) return null
        continue
      }
      const u = this.toUnicode.get(code)
      if (u === ch) continue
      if (u !== undefined && !isNul(u)) return null
      add.set(code, ch)
    }
    return add
  }
}

/** Font used when a Tf refers to a missing font: Helvetica metrics, Latin-1 text. */
class MissingFont extends SimpleFont {
  constructor(ctx: PDFContext) {
    super(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) as PDFDict)
    this.editable = false
    this.name = ''
    this.baseFont = ''
  }
}

const cache = new WeakMap<object, FontInfo>()

export function loadFont(ctx: PDFContext, obj: PDFObject | undefined): FontInfo {
  const dict = obj instanceof PDFDict ? obj : undefined
  const key: object = dict ?? ctx
  const cached = cache.get(key)
  if (cached) return cached
  let font: FontInfo
  try {
    if (!dict) font = new MissingFont(ctx)
    else if (getName(dict, 'Subtype') === 'Type0') font = new CompositeFont(dict)
    else font = new SimpleFont(dict)
  } catch {
    font = new MissingFont(ctx)
  }
  cache.set(key, font)
  return font
}
