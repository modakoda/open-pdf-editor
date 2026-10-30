/**
 * Text measurement and layout shared by the UI overlay and the exporter, so line breaks on
 * screen match the saved PDF exactly.
 *
 * Fonts: text that can be encoded in WinAnsi uses the standard PDF fonts
 * (Helvetica / Times / Courier + bold/italic variants, no embedding). Text with characters
 * outside WinAnsi (e.g. "ąčęėįšųūž", Greek, Cyrillic) uses the embedded Noto fonts that the
 * host registers via registerFonts(). Text those cannot draw (CJK, Thai, Devanagari…) uses
 * the fallback chain: fonts the host registers via registerFallbackFonts() (system fonts),
 * picking one font that contains every character, preferring the right CJK language, family
 * and weight. Each text is drawn with a single font. Characters no registered font contains,
 * and right-to-left scripts (not supported yet), are replaced with "?" and reported in
 * PreparedText.missing so the host can tell the user.
 *
 * Widths are the sum of glyph advance widths without kerning, which is exactly how the
 * exported PDF positions glyphs (Tj without adjustments). Overlays rendering with CSS
 * should use `font-kerning: none` to match.
 *
 * Vertical metrics: each line occupies `lineHeight * fontSize`; the glyphs are centered in
 * that line box like CSS does (half-leading above and below). So the first baseline is at
 * `(L - (A + D)) / 2 + A` from the box top, where L is the line height and A/D the export
 * font's ascender/descender at `fontSize`. Line i's baseline is `i * L` lower. For a
 * pixel-exact overlay draw each line at (line.x, line.baseline), e.g. with SVG <text>.
 */
import fontkit, { type Font as FkFont } from '@cantoo/fontkit'
import { StandardFontEmbedder, StandardFonts } from '@cantoo/pdf-lib'
import type { FontFamily } from './model'
import { hanLanguageFor, isRtlCodePoint, splitAtCjkBreaks, type HanLanguage } from './scripts'
import { isWinAnsiCodePoint } from './winansi'

export * from './scripts'
export * from './fontFiles'

export type FontStyleKey = `${FontFamily}-${'regular' | 'bold' | 'italic' | 'bolditalic'}`

/** TrueType font bytes for the Unicode fallback fonts (resources/fonts/*.ttf). */
export type FontAssets = Partial<Record<FontStyleKey, Uint8Array>>

/** Key of an embeddable Unicode font: a bundled face or a registered fallback font. */
export type UnicodeFontKey = FontStyleKey | `fallback:${string}`

/** A font for text the bundled fonts cannot draw (typically a system CJK font). */
export interface FallbackFont {
  /** Unique id; registering the same id again replaces the font. Letters, digits, "-", "_". */
  id: string
  /** TrueType/OpenType font or collection (.ttc/.otc) bytes. */
  bytes: Uint8Array
  /** Face to use in a collection. Default: the first face. */
  postscriptName?: string
  /** Generic family it stands in for (default 'sans'). */
  family?: FontFamily
  bold?: boolean
  /** CJK fonts: the language its Han glyphs are designed for. */
  language?: HanLanguage
}

interface FallbackEntry {
  asset: FallbackFont
  key: `fallback:${string}`
  /** Parsed face (undefined = not parsed yet, null = unusable). */
  font?: FkFont | null
  /** PostScript name of the face when the bytes are a collection (pdf-lib needs it). */
  collectionFace?: string
}

const registry: FontAssets = {}
const parsedFonts = new Map<FontStyleKey, FkFont | null>()
const fallbacks: FallbackEntry[] = []
const choiceCache = new Map<string, FontChoice>()
const widthCaches = new Map<string, Map<string, number>>()
const WIDTH_CACHE_LIMIT = 4000
const CHOICE_CACHE_LIMIT = 2000
let preferredHanLanguage: HanLanguage = 'zh-Hans'

/** Register Unicode fallback fonts. Call once at startup (renderer) or in test setup. */
export function registerFonts(assets: FontAssets): void {
  for (const [key, bytes] of Object.entries(assets) as [FontStyleKey, Uint8Array | undefined][]) {
    if (!bytes) continue
    registry[key] = bytes
    parsedFonts.delete(key)
    widthCaches.delete(`u:${key}`)
  }
  choiceCache.clear()
}

export function getRegisteredFonts(): FontAssets {
  return { ...registry }
}

/**
 * Add fonts to the fallback chain (after the bundled fonts, in registration order, which is
 * the tie-breaker between equally suitable fonts). Fonts are parsed lazily on first use.
 */
export function registerFallbackFonts(fonts: FallbackFont[]): void {
  for (const asset of fonts) {
    if (!asset?.bytes || !/^[\w-]+$/.test(asset.id)) throw new TypeError(`Invalid fallback font id: ${asset?.id}`)
    const key = fallbackFontKey(asset.id)
    const entry: FallbackEntry = { asset, key }
    const i = fallbacks.findIndex((f) => f.key === key)
    if (i >= 0) fallbacks[i] = entry
    else fallbacks.push(entry)
    widthCaches.delete(`u:${key}`)
  }
  choiceCache.clear()
}

/** Registered fallback fonts (without their bytes), in chain order. */
export function getFallbackFonts(): Omit<FallbackFont, 'bytes'>[] {
  return fallbacks.map(({ asset: { bytes: _bytes, ...meta } }) => meta)
}

export function fallbackFontKey(id: string): `fallback:${string}` {
  return `fallback:${id}`
}

/** Fallback font id of a font key, or undefined for bundled fonts. */
export function fallbackFontId(key: UnicodeFontKey | undefined): string | undefined {
  return key?.startsWith('fallback:') ? key.slice('fallback:'.length) : undefined
}

/** CSS font-family name under which the host declares a fallback font for the overlay. */
export function fallbackCssFamily(id: string): string {
  return `OPE Fallback ${id}`
}

/** Han glyph variant for CJK text without kana or Hangul (e.g. from the UI locale). */
export function setPreferredHanLanguage(language: HanLanguage): void {
  if (language === preferredHanLanguage) return
  preferredHanLanguage = language
  choiceCache.clear()
}

export function getPreferredHanLanguage(): HanLanguage {
  return preferredHanLanguage
}

/** Remove all registered fonts, bundled and fallback (mainly for tests). */
export function clearRegisteredFonts(): void {
  for (const key of Object.keys(registry) as FontStyleKey[]) {
    delete registry[key]
    widthCaches.delete(`u:${key}`)
  }
  for (const f of fallbacks.splice(0)) widthCaches.delete(`u:${f.key}`)
  parsedFonts.clear()
  choiceCache.clear()
}

const isLayoutControl = (cp: number) => cp === 0x0a || cp === 0x0d || cp === 0x09

/** True if every character can be drawn with the standard (non-embedded) PDF fonts. */
export function isWinAnsiEncodable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (!isLayoutControl(cp) && !isWinAnsiCodePoint(cp)) return false
  }
  return true
}

export interface TextStyle {
  font: FontFamily
  bold: boolean
  italic: boolean
  fontSize: number
  /** Multiple of fontSize. */
  lineHeight: number
}

export interface TextLayoutInput extends TextStyle {
  text: string
  /** Wrap width in points. Lines longer than this are broken at spaces (or mid-word if needed). */
  width: number
  align: 'left' | 'center' | 'right'
}

export interface LaidOutLine {
  text: string
  /** Offset of the line start from the box's left edge, in points (depends on align). */
  x: number
  /** Distance from the box's top edge to this line's baseline, in points. */
  baseline: number
  width: number
}

export interface TextLayout {
  lines: LaidOutLine[]
  /** Total height of the text block in points (lines.length * fontSize * lineHeight). */
  height: number
  /** Width of the longest line. */
  maxLineWidth: number
  /** Whether the embedded Unicode font is used (true) or a standard PDF font (false). */
  unicode: boolean
  /** The Unicode font used (bundled face or fallback font), for the overlay's CSS family. */
  fontKey?: UnicodeFontKey
  /** Characters drawn as "?" (see PreparedText.missing). */
  missing?: string[]
}

// ---------------------------------------------------------------------------------------
// Font resolution (shared with the exporter)
// ---------------------------------------------------------------------------------------

type StyleName = 'regular' | 'bold' | 'italic' | 'bolditalic'

function styleName(bold: boolean, italic: boolean): StyleName {
  return bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
}

const STANDARD_FONTS: Record<FontFamily, Record<StyleName, StandardFonts>> = {
  sans: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    bolditalic: StandardFonts.HelveticaBoldOblique
  },
  serif: {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    bolditalic: StandardFonts.TimesRomanBoldItalic
  },
  mono: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    bolditalic: StandardFonts.CourierBoldOblique
  }
}

/** Standard PDF font used for WinAnsi text of this family/style. */
export function standardFontFor(font: FontFamily, bold: boolean, italic: boolean): StandardFonts {
  return (STANDARD_FONTS[font] ?? STANDARD_FONTS.sans)[styleName(bold, italic)]
}

const STYLE_FALLBACKS: Record<StyleName, StyleName[]> = {
  regular: ['regular'],
  bold: ['bold', 'regular'],
  italic: ['italic', 'regular'],
  bolditalic: ['bolditalic', 'bold', 'italic', 'regular']
}

function parsedFont(key: FontStyleKey): FkFont | null {
  if (parsedFonts.has(key)) return parsedFonts.get(key)!
  const bytes = registry[key]
  let font: FkFont | null = null
  if (bytes) {
    try {
      const created = fontkit.create(bytes)
      font = 'fonts' in created ? (created.fonts[0] ?? null) : created
    } catch {
      font = null
    }
  }
  parsedFonts.set(key, font)
  return font
}

/**
 * Registered Unicode font to use for a family/style, with fallbacks: missing styles fall back
 * to simpler ones (e.g. mono italic → mono regular), a missing family falls back to sans.
 */
export function resolveUnicodeFontKey(font: FontFamily, bold: boolean, italic: boolean): FontStyleKey | undefined {
  const families: FontFamily[] = font === 'sans' ? ['sans'] : [font, 'sans']
  for (const family of families) {
    for (const style of STYLE_FALLBACKS[styleName(bold, italic)]) {
      const key = `${family}-${style}` as FontStyleKey
      if (parsedFont(key)) return key
    }
  }
  return undefined
}

function fallbackFace(entry: FallbackEntry): FkFont | null {
  if (entry.font !== undefined) return entry.font
  let font: FkFont | null = null
  try {
    const created = fontkit.create(entry.asset.bytes)
    if ('fonts' in created) {
      const faces = created.fonts
      font = faces.find((f) => f.postscriptName === entry.asset.postscriptName) ?? faces[0] ?? null
      entry.collectionFace = font?.postscriptName ?? undefined
    } else {
      font = created
    }
  } catch {
    font = null
  }
  entry.font = font
  return font
}

function fallbackByKey(key: string): FallbackEntry | undefined {
  return fallbacks.find((f) => f.key === key)
}

function unicodeFont(key: UnicodeFontKey): FkFont | null {
  const fallback = fallbackByKey(key)
  return fallback ? fallbackFace(fallback) : parsedFont(key as FontStyleKey)
}

/** How a piece of text is going to be drawn. */
export type ResolvedTextFont =
  | { unicode: false; standardFont: StandardFonts }
  | {
      unicode: true
      fontKey: UnicodeFontKey
      fontBytes: Uint8Array
      /** Face to embed when fontBytes is a font collection. */
      postscriptName?: string
    }

export interface PreparedText {
  /** Text with "\r\n"/"\r" normalized to "\n", tabs to spaces, undrawable characters → "?". */
  text: string
  font: ResolvedTextFont
  /**
   * Characters that were replaced with "?" (unique, in order): no registered font contains
   * them, or they belong to a right-to-left script.
   */
  missing: string[]
  /** Some replaced characters are right-to-left (Hebrew, Arabic…), which is not supported yet. */
  rtl: boolean
}

type TextStyleRef = { font: FontFamily; bold: boolean; italic: boolean }

interface FontChoice {
  key: UnicodeFontKey
  font: FkFont
}

/** Distinct drawable code points of `text` (no line breaks, controls or RTL characters). */
function neededCodePoints(text: string): number[] {
  const set = new Set<number>()
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && !isRtlCodePoint(cp)) set.add(cp)
  }
  return [...set]
}

function countMissing(font: FkFont, cps: number[]): number {
  let n = 0
  for (const cp of cps) if (!font.hasGlyphForCodePoint(cp)) n++
  return n
}

/**
 * The Unicode font for `text`: the bundled face for the family/style when it contains every
 * character; otherwise the fallback font that does, preferring the CJK language of the text,
 * then the family, then the weight, then registration order. When no font contains every
 * character, the one missing the fewest wins (the bundled face on ties).
 */
function chooseUnicodeFont(text: string, style: TextStyleRef): FontChoice | null {
  const cacheKey = `${style.font}|${style.bold ? 1 : 0}|${style.italic ? 1 : 0}|${text}`
  const cached = choiceCache.get(cacheKey)
  if (cached) return cached
  const cps = neededCodePoints(text)
  const bundledKey = resolveUnicodeFontKey(style.font, style.bold, style.italic)
  const bundled = bundledKey ? parsedFont(bundledKey) : null
  let best: (FontChoice & { missing: number; rank: number }) | null = null
  if (bundledKey && bundled) {
    best = { key: bundledKey, font: bundled, missing: countMissing(bundled, cps), rank: -1 }
  }
  if (!best || best.missing > 0) {
    const language = hanLanguageFor(text, preferredHanLanguage)
    const family = style.font === 'mono' ? ['mono', 'sans'] : [style.font]
    for (let order = 0; order < fallbacks.length; order++) {
      const entry = fallbacks[order]
      const font = fallbackFace(entry)
      if (!font) continue
      const missing = countMissing(font, cps)
      const a = entry.asset
      // Lower is better: language, family, weight, then registration order.
      const rank =
        (language && a.language !== language ? 8 : 0) +
        (family.includes(a.family ?? 'sans') ? 0 : 4) +
        (!!a.bold === style.bold ? 0 : 2) +
        order / (fallbacks.length + 1)
      if (!best || missing < best.missing || (missing === best.missing && best.rank >= 0 && rank < best.rank)) {
        best = { key: entry.key, font, missing, rank }
      }
    }
  }
  if (!best) return null
  const choice: FontChoice = { key: best.key, font: best.font }
  if (choiceCache.size >= CHOICE_CACHE_LIMIT) choiceCache.clear()
  choiceCache.set(cacheKey, choice)
  return choice
}

/**
 * Decide the font for a text (standard vs embedded Unicode) and sanitize it so that every
 * character can be drawn with that font. Used identically by layout and export.
 */
export function prepareText(text: string, style: TextStyleRef): PreparedText {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  if (isWinAnsiEncodable(normalized)) {
    return {
      text: normalized,
      font: { unicode: false, standardFont: standardFontFor(style.font, style.bold, style.italic) },
      missing: [],
      rtl: false
    }
  }
  const missing = new Set<string>()
  let rtl = false
  const sanitize = (drawable: (cp: number) => boolean) => {
    let out = ''
    for (const ch of normalized) {
      const cp = ch.codePointAt(0)!
      if (cp === 0x0a) out += ch
      else if (cp < 0x20) out += '?'
      else if (isRtlCodePoint(cp) || !drawable(cp)) {
        out += '?'
        missing.add(ch)
        if (isRtlCodePoint(cp)) rtl = true
      } else out += ch
    }
    return out
  }
  const choice = chooseUnicodeFont(normalized, style)
  if (choice) {
    const out = sanitize((cp) => choice.font.hasGlyphForCodePoint(cp))
    const fallback = fallbackByKey(choice.key)
    const font: ResolvedTextFont = fallback
      ? { unicode: true, fontKey: choice.key, fontBytes: fallback.asset.bytes, postscriptName: fallback.collectionFace }
      : { unicode: true, fontKey: choice.key, fontBytes: registry[choice.key as FontStyleKey]! }
    return { text: out, font, missing: [...missing], rtl }
  }
  const out = sanitize(isWinAnsiCodePoint)
  return {
    text: out,
    font: { unicode: false, standardFont: standardFontFor(style.font, style.bold, style.italic) },
    missing: [...missing],
    rtl
  }
}

const standardEmbedders = new Map<StandardFonts, StandardFontEmbedder>()
function standardEmbedder(name: StandardFonts): StandardFontEmbedder {
  let e = standardEmbedders.get(name)
  if (!e) {
    e = StandardFontEmbedder.for(name as never)
    standardEmbedders.set(name, e)
  }
  return e
}

function cacheFor(id: string): Map<string, number> {
  let c = widthCaches.get(id)
  if (!c) {
    c = new Map()
    widthCaches.set(id, c)
  }
  return c
}

/** Width of `text` (already prepared for `font`) at size 1, in points. */
function unitWidth(text: string, font: ResolvedTextFont): number {
  if (!text) return 0
  const cache = cacheFor(font.unicode ? `u:${font.fontKey}` : `s:${font.standardFont}`)
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  let width = 0
  if (font.unicode) {
    const fk = unicodeFont(font.fontKey)!
    const { glyphs } = fk.layout(text)
    let sum = 0
    for (const g of glyphs) sum += g.advanceWidth
    width = sum / fk.unitsPerEm
  } else {
    const emb = standardEmbedder(font.standardFont)
    let sum = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      const enc = emb.encoding.canEncodeUnicodeCodePoint(cp) ? cp : 0x3f
      const { name } = emb.encoding.encodeUnicodeCodePoint(enc)
      // Same default as pdf-lib's StandardFontEmbedder.
      sum += emb.font.getWidthOfGlyph(name) || 250
    }
    width = sum / 1000
  }
  if (cache.size >= WIDTH_CACHE_LIMIT) cache.clear()
  cache.set(text, width)
  return width
}

/** Ascender / descender (positive, below baseline) of the font at size 1. */
export function fontMetrics(font: ResolvedTextFont): { ascent: number; descent: number } {
  if (font.unicode) {
    const fk = unicodeFont(font.fontKey)!
    return { ascent: fk.ascent / fk.unitsPerEm, descent: Math.abs(fk.descent) / fk.unitsPerEm }
  }
  const f = standardEmbedder(font.standardFont).font
  const ascent = (f.Ascender || f.FontBBox[3]) / 1000
  const descent = Math.abs(f.Descender || f.FontBBox[1]) / 1000
  return { ascent, descent }
}

/** Distance from the top of a line box to its baseline (see file comment). */
export function firstBaselineOffset(font: ResolvedTextFont, fontSize: number, lineHeight: number): number {
  const { ascent, descent } = fontMetrics(font)
  const L = lineHeight * fontSize
  return (L - (ascent + descent) * fontSize) / 2 + ascent * fontSize
}

function safeFontSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 12
}

function safeLineHeight(lh: number): number {
  return Number.isFinite(lh) && lh > 0 ? lh : 1.2
}

// ---------------------------------------------------------------------------------------
// Public measurement / layout
// ---------------------------------------------------------------------------------------

/** Width of a single line of text in points (for multi-line input: the widest line). */
export function measureText(text: string, style: Omit<TextStyle, 'lineHeight'>): number {
  const prepared = prepareText(text, style)
  const size = safeFontSize(style.fontSize)
  let max = 0
  for (const line of prepared.text.split('\n')) max = Math.max(max, unitWidth(line, prepared.font) * size)
  return max
}

const EPSILON = 1e-6

/** Break text into lines that fit `width` and compute their positions. Synchronous. */
export function layoutText(input: TextLayoutInput): TextLayout {
  const prepared = prepareText(input.text ?? '', input)
  const font = prepared.font
  const size = safeFontSize(input.fontSize)
  const lineHeight = safeLineHeight(input.lineHeight)
  const maxWidth = Number.isFinite(input.width) && input.width > 0 ? input.width : Infinity
  const measure = (s: string) => unitWidth(s, font) * size
  const fits = (s: string) => measure(s) <= maxWidth + EPSILON

  const lines: string[] = []
  for (const paragraph of prepared.text.split('\n')) {
    if (fits(paragraph)) {
      lines.push(paragraph)
      continue
    }
    /** Start a new line with `word`; returns the (possibly partial) current line. */
    const startLine = (word: string): string => {
      if (fits(word)) return word
      // Break an over-long word into chunks that fit (at least one character each).
      let chunk = ''
      for (const ch of word) {
        if (chunk && !fits(chunk + ch)) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      return chunk
    }
    // Break opportunities: at spaces (the space is dropped at a break) and around CJK
    // characters (splitAtCjkBreaks; nothing is dropped there).
    let line: string | null = null
    for (const word of paragraph.split(' ')) {
      const pieces = splitAtCjkBreaks(word)
      for (let i = 0; i < pieces.length; i++) {
        if (line === null) {
          line = startLine(pieces[i])
          continue
        }
        const candidate: string = `${line}${i === 0 ? ' ' : ''}${pieces[i]}`
        if (fits(candidate)) {
          line = candidate
        } else {
          lines.push(line)
          line = startLine(pieces[i])
        }
      }
    }
    lines.push(line ?? '')
  }

  const widths = lines.map(measure)
  const maxLineWidth = widths.reduce((m, w) => Math.max(m, w), 0)
  const boxWidth = maxWidth === Infinity ? maxLineWidth : maxWidth
  const L = lineHeight * size
  const first = firstBaselineOffset(font, size, lineHeight)
  return {
    lines: lines.map((text, i) => {
      const w = widths[i]
      const x = input.align === 'center' ? (boxWidth - w) / 2 : input.align === 'right' ? boxWidth - w : 0
      return { text, x, baseline: i * L + first, width: w }
    }),
    height: lines.length * L,
    maxLineWidth,
    unicode: font.unicode,
    ...(font.unicode ? { fontKey: font.fontKey } : {}),
    ...(prepared.missing.length ? { missing: prepared.missing } : {})
  }
}

/**
 * CSS font-family stack for the overlay that approximates the font used on export. Pass the
 * layout's fontKey so that text drawn with a fallback font uses that font's declared family.
 */
export function cssFontFamily(font: FontFamily, unicode: boolean, fontKey?: UnicodeFontKey): string {
  const fallbackId = unicode ? fallbackFontId(fontKey) : undefined
  if (fallbackId) return `'${fallbackCssFamily(fallbackId)}', ${cssFontFamily(font, true)}`
  if (unicode) {
    switch (font) {
      case 'serif':
        return "'OPE Noto Serif', 'Noto Serif', serif"
      case 'mono':
        return "'OPE Noto Sans Mono', 'Noto Sans Mono', monospace"
      default:
        return "'OPE Noto Sans', 'Noto Sans', sans-serif"
    }
  }
  switch (font) {
    case 'serif':
      return "'Times New Roman', Times, 'Liberation Serif', Tinos, serif"
    case 'mono':
      return "'Courier New', Courier, 'Liberation Mono', Cousine, monospace"
    default:
      return "Helvetica, Arial, 'Liberation Sans', Arimo, sans-serif"
  }
}
