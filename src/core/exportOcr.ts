/**
 * Invisible text layer for OCR results (internal to the exporter).
 *
 * Every recognized word is drawn with text render mode 3 (neither filled nor stroked) in an
 * embedded font (the bundled Noto Sans subset, which has a /ToUnicode map), at the word's
 * position: the text matrix puts the glyphs on the line's baseline in reading orientation and
 * horizontal scaling (Tz) stretches each word to the width it has in the scan. Words of a line
 * are separated by a space stretched over the gap, so viewers extract "word word" and select,
 * search and copy the text where it is visible in the scan. The layer is wrapped in
 * `/OPEObject <</Id (OCR_LAYER_ID)>> BDC … EMC` so later saves can replace it.
 */
import {
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFFont,
  type PDFOperator
} from '@cantoo/pdf-lib'
import { pageToPdf } from './geometry'
import type { OcrPageResult } from './model'
import { OCR_LAYER_ID, readingFrame, readingPoint, toReading } from './ocr'
import { beginObjectMark, endObjectMark } from './persist'
import { getRegisteredFonts, resolveUnicodeFontKey } from './text'
import type { DrawTarget } from './exportDraw'
import type { EmbedCache } from './exportFonts'

/** Horizontal scaling limits in percent (beyond these the word box is probably wrong). */
const MIN_SCALE = 5
const MAX_SCALE = 2000

async function layerFont(t: DrawTarget, cache: EmbedCache): Promise<{ font: PDFFont; supports: (cp: number) => boolean; ascent: number }> {
  const key = resolveUnicodeFontKey('sans', false, false)
  const bytes = key ? getRegisteredFonts()[key] : undefined
  if (key && bytes) {
    const font = await cache.font(t.doc, { unicode: true, fontKey: key, fontBytes: bytes })
    const set = new Set(font.getCharacterSet())
    return { font, supports: (cp) => set.has(cp), ascent: fontAscent(font, 1.069) }
  }
  // Without the bundled fonts (bare engine use): Helvetica, WinAnsi characters only.
  const font = await cache.font(t.doc, { unicode: false, standardFont: StandardFonts.Helvetica })
  const set = new Set(font.getCharacterSet())
  return { font, supports: (cp) => set.has(cp), ascent: fontAscent(font, 0.718) }
}

function fontAscent(font: PDFFont, fallback: number): number {
  const h = font.heightAtSize(1, { descender: false })
  return Number.isFinite(h) && h > 0.3 && h < 2 ? h : fallback
}

/** Draw `result` as invisible text on the target page (page space → the page's visible box). */
export async function drawOcrTextLayer(t: DrawTarget, result: OcrPageResult, cache: EmbedCache): Promise<void> {
  const lines = result.lines.filter((l) => l.words.some((w) => w.text.trim()))
  if (!lines.length) return
  const { font, supports, ascent } = await layerFont(t, cache)
  const fontName = t.page.node.newFontDictionary(font.name, font.ref)
  const clean = (s: string) => Array.from(s, (ch) => (supports(ch.codePointAt(0)!) ? ch : '?')).join('')
  const spaceWidth = font.widthOfTextAtSize(' ', 1) || 0.26

  const ops: PDFOperator[] = [pushGraphicsState(), beginObjectMark(OCR_LAYER_ID), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)]
  for (const line of lines) {
    const frame = readingFrame(line.box, result.rotation)
    const baseline = Math.min(Math.max(line.baseline, frame.height * 0.3), frame.height)
    // The font's ascender sits at the line's top, so selection boxes cover the line.
    const size = Math.max(1, baseline / ascent)
    ops.push(setFontAndSize(fontName, size))
    // Text space axes in PDF user space: x along the text, y up in reading orientation.
    const ux = frame.u.x
    const uy = -frame.u.y
    const upx = -frame.v.x
    const upy = frame.v.y
    const words = line.words
      .map((w) => {
        const wf = readingFrame(w.box, result.rotation)
        return { text: clean(w.text.trim()), x: toReading(frame, wf.origin).x, width: wf.width }
      })
      .filter((w) => w.text && w.width > 0)
      .sort((a, b) => a.x - b.x)
    words.forEach((w, i) => {
      const natural = font.widthOfTextAtSize(w.text, size)
      if (!(natural > 0)) return
      const at = pageToPdf(readingPoint(frame, w.x, baseline), t.box)
      ops.push(
        setTextMatrix(ux, uy, upx, upy, at.x, at.y),
        setCharacterSqueeze(clampScale((100 * w.width) / natural)),
        showText(font.encodeText(w.text))
      )
      const next = words[i + 1]
      if (!next) return
      // A space up to the next word (at least a sliver, so the words stay apart).
      const gap = Math.max(next.x - (w.x + w.width), size * 0.05)
      ops.push(setCharacterSqueeze(clampScale((100 * gap) / (spaceWidth * size))), showText(font.encodeText(' ')))
    })
  }
  ops.push(endText(), endObjectMark(), popGraphicsState())
  t.page.pushOperators(...ops)
}

function clampScale(v: number): number {
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, v)) * 1000) / 1000
}
