/**
 * Turns pdf.js text content into "runs" (merged items on one line) positioned in page space,
 * for the "edit existing text" tool.
 */
import type { FontFamily } from '@core'

export interface TextRun {
  /** Stable key within a page. */
  key: string
  text: string
  /** Left edge / baseline origin in page space (points). */
  x: number
  baseline: number
  /** Box covering the glyphs (ascent..descent), unrotated. */
  top: number
  width: number
  height: number
  fontSize: number
  /** Clockwise degrees in page space (0 for normal horizontal text). */
  angle: number
  font: FontFamily
  bold: boolean
  italic: boolean
}

type Matrix = number[]

interface PdfTextItem {
  str: string
  transform: Matrix
  width: number
  height: number
  fontName: string
  hasEOL?: boolean
  dir?: string
}

interface PdfTextStyle {
  ascent?: number
  descent?: number
  vertical?: boolean
  fontFamily?: string
}

export interface PdfTextContentLike {
  items: Array<PdfTextItem | { type: string }>
  styles: Record<string, PdfTextStyle>
}

/** Multiply two 2D affine matrices [a b c d e f] (same as pdf.js Util.transform). */
export function transformMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

function familyOf(s: string): FontFamily | undefined {
  if (!s) return undefined
  if (/courier|mono|consol|menlo|typewriter/i.test(s)) return 'mono'
  if (/sans|helvetica|arial|verdana|tahoma|calibri|segoe|roboto|gothic|grotesk|frutiger|myriad|lato/i.test(s)) return 'sans'
  if (/serif|times|roman|georgia|garamond|minion|cambria|palatino|bookman|caslon|baskerville/i.test(s)) return 'serif'
  return undefined
}

/** Guess family/bold/italic from a PDF font name (e.g. "ABCDEF+Times-BoldItalic") and the CSS fallback family. */
export function classifyFont(name: string | undefined, cssFamily: string | undefined): {
  font: FontFamily
  bold: boolean
  italic: boolean
} {
  const n = (name ?? '').replace(/^[A-Z]{6}\+/, '')
  const font = familyOf(n) ?? familyOf(cssFamily ?? '') ?? 'sans'
  return {
    font,
    bold: /bold|black|heavy|semibold|demi|,b$/i.test(n),
    italic: /italic|oblique|,i$/i.test(n)
  }
}

/**
 * @param viewportTransform pdf.js `page.getViewport({ scale: 1, rotation: 0 }).transform`
 *   (maps PDF user space to page space).
 * @param fontNameOf resolves pdf.js internal font ids to the real PDF font name, if known.
 */
export function extractTextRuns(
  content: PdfTextContentLike,
  viewportTransform: Matrix,
  fontNameOf: (id: string) => string | undefined = () => undefined
): TextRun[] {
  const items: TextRun[] = []
  let n = 0
  for (const raw of content.items) {
    if (!('str' in raw)) continue
    const item = raw as PdfTextItem
    if (!item.str || !item.str.trim()) {
      n++
      continue
    }
    const style = content.styles[item.fontName] ?? {}
    if (style.vertical) continue
    const tx = transformMatrix(viewportTransform, item.transform)
    const fontSize = Math.hypot(tx[2], tx[3])
    if (!(fontSize > 0.5)) continue
    const angle = (Math.atan2(tx[1], tx[0]) * 180) / Math.PI
    const ascent = style.ascent && style.ascent > 0 ? style.ascent : 0.8
    const descent = style.descent !== undefined && style.descent < 0 ? style.descent : -0.2
    // item.width is in user space units along the text direction (viewport scale 1).
    const scaleX = Math.hypot(viewportTransform[0], viewportTransform[1]) || 1
    const width = Math.abs(item.width) * scaleX
    const cls = classifyFont(fontNameOf(item.fontName), style.fontFamily)
    items.push({
      key: `r${n++}`,
      text: item.str,
      x: tx[4],
      baseline: tx[5],
      top: tx[5] - ascent * fontSize,
      width,
      height: (ascent - descent) * fontSize,
      fontSize,
      angle: Math.abs(angle) < 0.5 ? 0 : angle,
      ...cls
    })
  }
  return mergeRuns(items)
}

/** Merge items on the same line that are adjacent (pdf.js often splits words and spaces). */
export function mergeRuns(items: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const item of items) {
    const prev = out[out.length - 1]
    if (prev && canMerge(prev, item)) {
      const gap = item.x - (prev.x + prev.width)
      const needsSpace = gap > prev.fontSize * 0.15 && !prev.text.endsWith(' ') && !item.text.startsWith(' ')
      const right = Math.max(prev.x + prev.width, item.x + item.width)
      const top = Math.min(prev.top, item.top)
      const bottom = Math.max(prev.top + prev.height, item.top + item.height)
      out[out.length - 1] = {
        ...prev,
        text: prev.text + (needsSpace ? ' ' : '') + item.text,
        width: right - prev.x,
        top,
        height: bottom - top,
        bold: prev.bold && item.bold,
        italic: prev.italic && item.italic
      }
    } else {
      out.push({ ...item })
    }
  }
  return out.map((r) => ({ ...r, text: r.text.replace(/\s+$/, '') })).filter((r) => r.text.length > 0)
}

function canMerge(a: TextRun, b: TextRun): boolean {
  if (a.angle !== 0 || b.angle !== 0) return false
  const size = Math.max(a.fontSize, b.fontSize)
  if (Math.abs(a.fontSize - b.fontSize) > size * 0.2) return false
  if (Math.abs(a.baseline - b.baseline) > size * 0.25) return false
  const gap = b.x - (a.x + a.width)
  return gap > -size * 0.3 && gap < size * 1.2
}
