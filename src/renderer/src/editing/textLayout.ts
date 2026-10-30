/** Overlay-side wrappers around the engine's text layout (never throw while rendering). */
import {
  cssFontFamily,
  fallbackFontId,
  isWinAnsiEncodable,
  layoutText,
  measureText,
  prepareText,
  type FontFamily,
  type TextLayout,
  type TextObject,
  type UnicodeFontKey
} from '@core'
import { UNICODE_CSS_FAMILIES } from '@renderer/fonts/fonts'

type TextProps = Pick<TextObject, 'text' | 'font' | 'bold' | 'italic' | 'fontSize' | 'lineHeight' | 'width' | 'align'>

const FALLBACK_STACKS: Record<FontFamily, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace'
}

/** CSS family stack; pass the layout's fontKey so fallback (system) fonts are used as on export. */
export function fontStack(font: FontFamily, unicode: boolean, fontKey?: UnicodeFontKey): string {
  try {
    return cssFontFamily(font, unicode, fontKey)
  } catch {
    return unicode ? `"${UNICODE_CSS_FAMILIES[font]}", ${FALLBACK_STACKS[font]}` : FALLBACK_STACKS[font]
  }
}

/** CSS family stack for a text drawn with the font the engine picks for it. */
export function textFontStack(text: string, style: { font: FontFamily; bold?: boolean; italic?: boolean }): string {
  try {
    const { font } = prepareText(text, { font: style.font, bold: !!style.bold, italic: !!style.italic })
    return fontStack(style.font, font.unicode, font.unicode ? font.fontKey : undefined)
  } catch {
    return fontStack(style.font, isUnicodeText(text))
  }
}

/**
 * Fallback fonts are declared as one face for every weight and have no italic: never let the
 * browser fake bold/italic, since the export draws the face as is.
 */
export function usesFallbackFont(fontKey: UnicodeFontKey | undefined): boolean {
  return fallbackFontId(fontKey) !== undefined
}

export function isUnicodeText(text: string): boolean {
  try {
    return !isWinAnsiEncodable(text)
  } catch {
    return /[^\u0000-ÿ]/.test(text)
  }
}

/** Layout used to draw a text object; falls back to naive line splitting if the engine fails. */
export function safeLayout(t: TextProps): TextLayout {
  try {
    return layoutText({
      text: t.text,
      font: t.font,
      bold: t.bold,
      italic: t.italic,
      fontSize: t.fontSize,
      lineHeight: t.lineHeight,
      width: t.width,
      align: t.align
    })
  } catch {
    const lh = t.fontSize * t.lineHeight
    const lines = t.text.split('\n').map((text, i) => ({
      text,
      x: 0,
      baseline: i * lh + (lh - t.fontSize) / 2 + t.fontSize * 0.8,
      width: text.length * t.fontSize * 0.5
    }))
    return {
      lines,
      height: lines.length * lh,
      maxLineWidth: Math.max(0, ...lines.map((l) => l.width)),
      unicode: isUnicodeText(t.text)
    }
  }
}

export function safeMeasure(text: string, style: Pick<TextObject, 'font' | 'bold' | 'italic' | 'fontSize'>): number {
  try {
    return measureText(text, style)
  } catch {
    return text.length * style.fontSize * 0.5
  }
}

/** Width of an existing text run re-set in the generic font closest to its original. */
export function measureContentText(text: string, item: { fontFamily?: FontFamily; bold?: boolean; italic?: boolean }, fontSize: number): number {
  return safeMeasure(text, { font: item.fontFamily ?? 'sans', bold: !!item.bold, italic: !!item.italic, fontSize })
}
