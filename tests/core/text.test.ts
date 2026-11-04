import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Encodings } from '@cantoo/pdf-lib/standard-fonts'
import { PDFDocument } from '@cantoo/pdf-lib'
import fontkit from '@cantoo/fontkit'
import {
  clearRegisteredFonts,
  cssFontFamily,
  firstBaselineOffset,
  getRegisteredFonts,
  isWinAnsiEncodable,
  layoutText,
  measureText,
  namedFaceFor,
  prepareText,
  registerFonts,
  resolveNamedFace,
  resolveUnicodeFontKey,
  type TextLayoutInput
} from '../../src/core'
import { loadFontAssets, registerTestFonts } from './helpers'

const helv = { font: 'sans' as const, bold: false, italic: false, fontSize: 12 }
const input = (text: string, width: number, extra: Partial<TextLayoutInput> = {}): TextLayoutInput => ({
  ...helv,
  lineHeight: 1.2,
  text,
  width,
  align: 'left',
  ...extra
})

beforeAll(() => registerTestFonts())
afterAll(() => registerTestFonts())

describe('isWinAnsiEncodable', () => {
  it('accepts ASCII, Latin-1 and the CP1252 extras', () => {
    expect(isWinAnsiEncodable('Hello, world! 123')).toBe(true)
    expect(isWinAnsiEncodable('Café déjà vu – “quoted” ‘x’ … € ™ • — Œœ Ÿ ƒ ‰ ‹›')).toBe(true)
    expect(isWinAnsiEncodable('Žž Šš')).toBe(true)
    expect(isWinAnsiEncodable('line 1\nline 2\r\n\ttab')).toBe(true)
    expect(isWinAnsiEncodable('')).toBe(true)
  })

  it('rejects characters outside WinAnsi', () => {
    for (const s of ['ą', 'č', 'ę', 'ė', 'į', 'ų', 'ū', 'α', 'Ж', '😀', '中', '\u0001']) {
      expect(isWinAnsiEncodable(`abc${s}`), s).toBe(false)
    }
  })

  it('matches pdf-lib’s WinAnsi encoding for every BMP code point', () => {
    const mismatches: number[] = []
    for (let cp = 0x20; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      if (isWinAnsiEncodable(String.fromCodePoint(cp)) !== Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) {
        mismatches.push(cp)
      }
    }
    expect(mismatches.map((c) => c.toString(16))).toEqual([])
  })
})

describe('measureText', () => {
  it('uses the standard font metrics without kerning', () => {
    // Helvetica AFM: H 722, e 556, l 222, o 556
    expect(measureText('Hello', helv)).toBeCloseTo((722 + 556 + 222 + 222 + 556) * 0.012, 6)
    // AV is a kerning pair in Helvetica; kerning must not be applied (the PDF is drawn with Tj).
    expect(measureText('AV', helv)).toBeCloseTo((667 + 667) * 0.012, 6)
    expect(measureText('', helv)).toBe(0)
  })

  it('distinguishes bold / serif / mono', () => {
    const w = (font: 'sans' | 'serif' | 'mono', bold = false) => measureText('Hello', { ...helv, font, bold })
    expect(w('sans', true)).toBeGreaterThan(w('sans'))
    expect(w('serif')).not.toBeCloseTo(w('sans'))
    expect(w('mono')).toBeCloseTo(5 * 600 * 0.012, 6)
  })

  it('measures Unicode text with the embedded font exactly like pdf-lib draws it', async () => {
    const text = 'Ąžuolas čiuožia į ūką'
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(loadFontAssets()['sans-regular']!, { subset: true })
    expect(measureText(text, helv)).toBeCloseTo(font.widthOfTextAtSize(text, 12), 6)
  })

  it('returns the widest line for multi-line input', () => {
    expect(measureText('a\nHello\nbb', helv)).toBeCloseTo(measureText('Hello', helv), 6)
  })
})

describe('layoutText', () => {
  it('keeps short text on one line and computes height and baseline', () => {
    const layout = layoutText(input('Hello world', 500))
    expect(layout.lines).toHaveLength(1)
    expect(layout.lines[0].text).toBe('Hello world')
    expect(layout.lines[0].x).toBe(0)
    expect(layout.height).toBeCloseTo(12 * 1.2)
    expect(layout.maxLineWidth).toBeCloseTo(measureText('Hello world', helv))
    expect(layout.unicode).toBe(false)
    // Helvetica: ascender 718, descender -207, centered in the 14.4pt line box.
    const expected = (14.4 - (0.718 + 0.207) * 12) / 2 + 0.718 * 12
    expect(layout.lines[0].baseline).toBeCloseTo(expected, 6)
  })

  it('wraps at spaces to fit the width', () => {
    const text = 'The quick brown fox jumps over the lazy dog'
    const width = measureText('The quick brown fox', helv) + 0.5
    const layout = layoutText(input(text, width))
    expect(layout.lines.map((l) => l.text)).toEqual(['The quick brown fox', 'jumps over the lazy', 'dog'])
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(width + 1e-6)
    const L = 12 * 1.2
    layout.lines.forEach((l, i) => expect(l.baseline).toBeCloseTo(layout.lines[0].baseline + i * L, 6))
    expect(layout.height).toBeCloseTo(3 * L)
  })

  it('respects explicit newlines and keeps empty lines', () => {
    const layout = layoutText(input('one\n\nthree\r\nfour', 500))
    expect(layout.lines.map((l) => l.text)).toEqual(['one', '', 'three', 'four'])
  })

  it('breaks words longer than the width', () => {
    const mono = { ...helv, font: 'mono' as const }
    const width = measureText('abcde', mono) + 0.1
    const layout = layoutText(input('abcdefghijkl xy', width, { font: 'mono' }))
    expect(layout.lines.map((l) => l.text)).toEqual(['abcde', 'fghij', 'kl xy'])
    // Even a single character wider than the box gets its own line.
    const tiny = layoutText(input('WW', 1))
    expect(tiny.lines.map((l) => l.text)).toEqual(['W', 'W'])
  })

  it('does not wrap when the width is zero or not finite', () => {
    expect(layoutText(input('a b c d e f g', 0)).lines).toHaveLength(1)
    expect(layoutText(input('a b c d e f g', Infinity)).lines).toHaveLength(1)
  })

  it('aligns lines left, center and right', () => {
    const w = 200
    const lw = measureText('Hello', helv)
    expect(layoutText(input('Hello', w, { align: 'left' })).lines[0].x).toBe(0)
    expect(layoutText(input('Hello', w, { align: 'center' })).lines[0].x).toBeCloseTo((w - lw) / 2)
    expect(layoutText(input('Hello', w, { align: 'right' })).lines[0].x).toBeCloseTo(w - lw)
  })

  it('applies lineHeight and font size', () => {
    const layout = layoutText(input('a\nb', 100, { fontSize: 20, lineHeight: 2 }))
    expect(layout.height).toBeCloseTo(80)
    expect(layout.lines[1].baseline - layout.lines[0].baseline).toBeCloseTo(40)
  })

  it('uses the Unicode font iff the text is not WinAnsi', () => {
    expect(layoutText(input('Žalias € “ok”', 300)).unicode).toBe(false)
    const lt = layoutText(input('Ąčęėįšųūž', 300))
    expect(lt.unicode).toBe(true)
    expect(lt.lines[0].text).toBe('Ąčęėįšųūž')
    expect(lt.lines[0].width).toBeGreaterThan(0)
    expect(layoutText(input('Привет мир', 300)).unicode).toBe(true)
  })

  it('baseline offset matches the font used for export', () => {
    const lt = layoutText(input('Ąčęėįšųūž', 300))
    const prepared = prepareText('Ąčęėįšųūž', helv)
    expect(prepared.font.unicode).toBe(true)
    expect(lt.lines[0].baseline).toBeCloseTo(firstBaselineOffset(prepared.font, 12, 1.2), 9)
  })

  it('replaces characters the Unicode font cannot draw with "?"', () => {
    const lt = layoutText(input('ą中b', 300))
    expect(lt.unicode).toBe(true)
    expect(lt.lines[0].text).toBe('ą?b')
  })
})

describe('font fallbacks', () => {
  it('mono italic falls back to the upright mono faces', () => {
    expect(resolveUnicodeFontKey('mono', false, true)).toBe('mono-regular')
    expect(resolveUnicodeFontKey('mono', true, true)).toBe('mono-bold')
    expect(resolveUnicodeFontKey('serif', true, true)).toBe('serif-bolditalic')
    expect(layoutText(input('ąčę', 300, { font: 'mono', italic: true })).unicode).toBe(true)
  })

  it('without registered fonts replaces non-WinAnsi characters with "?"', () => {
    clearRegisteredFonts()
    try {
      expect(getRegisteredFonts()).toEqual({})
      const lt = layoutText(input('Ąžuolas ėglė €', 300))
      expect(lt.unicode).toBe(false)
      expect(lt.lines[0].text).toBe('?žuolas ?gl? €')
      expect(lt.lines[0].width).toBeCloseTo(measureText('?žuolas ?gl? €', helv))
      const prepared = prepareText('Ąžuolas', helv)
      expect(prepared.text).toBe('?žuolas')
      expect(prepared.font.unicode).toBe(false)
    } finally {
      registerTestFonts()
    }
  })

  it('falls back to sans when only sans is registered', () => {
    clearRegisteredFonts()
    try {
      registerFonts({ 'sans-regular': loadFontAssets()['sans-regular'] })
      expect(Object.keys(getRegisteredFonts())).toEqual(['sans-regular'])
      expect(resolveUnicodeFontKey('serif', true, false)).toBe('sans-regular')
      expect(layoutText(input('ąčę', 300, { font: 'serif', bold: true })).unicode).toBe(true)
    } finally {
      registerTestFonts()
    }
  })
})

describe('named fonts', () => {
  const face = (name: string, bold = false, italic = false) => resolveNamedFace(name, bold, italic)?.weight

  it('matches PDF font names of the family to the closest registered weight', () => {
    expect(face('Inter-Regular')).toBe(400)
    expect(face('ABCDEF+Inter-Medium')).toBe(500)
    expect(face('Inter-SemiBold', true)).toBe(600)
    expect(face('Inter,Bold', true)).toBe(700)
    expect(face('Inter-ExtraBold', true)).toBe(700)
    expect(face('Inter-Light')).toBe(400)
    expect(face('Inter-Regular_SemiBold', true)).toBe(600) // variable font instance
    expect(face('InterVariable', true)).toBe(700)
    expect(face('Inter-SemiBold-7098', true)).toBe(600) // pdf-lib's suffix
    expect(face('Inter-Medium-Identity-H')).toBe(500)
    expect(face('Inter')).toBe(400)
  })

  it('does not match other families, other words after the family or italics without italic faces', () => {
    expect(face('InterDisplay-Bold', true)).toBeUndefined()
    expect(face('Interstate-Regular')).toBeUndefined()
    expect(face('Helvetica')).toBeUndefined()
    expect(face('Inter-Italic', false, true)).toBeUndefined()
  })

  it('re-sets text in the named face when it has every character', () => {
    const style = { font: 'sans' as const, bold: true, italic: false, fontName: 'Inter-SemiBold' }
    const prepared = prepareText('Total €93.47 – Šiaurės', style)
    expect(prepared.font).toMatchObject({ unicode: true, fontKey: 'named:inter-600' })
    expect(prepared.text).toBe('Total €93.47 – Šiaurės')
    expect(measureText('Total', { ...style, fontSize: 10 })).not.toBeCloseTo(measureText('Total', { ...helv, bold: true, fontSize: 10 }))
    // Characters Inter lacks: the generic fonts as before.
    expect(namedFaceFor('漢字', style)).toBeUndefined()
    expect(prepareText('Total', { ...style, fontName: undefined }).font).toMatchObject({ unicode: false })
  })

  it('are removed with the other registered fonts', () => {
    clearRegisteredFonts()
    try {
      expect(face('Inter-Regular')).toBeUndefined()
    } finally {
      registerTestFonts()
    }
  })
})

describe('cssFontFamily', () => {
  it('returns the documented stacks', () => {
    expect(cssFontFamily('sans', true)).toBe("'OPE Noto Sans', 'Noto Sans', sans-serif")
    expect(cssFontFamily('serif', true)).toBe("'OPE Noto Serif', 'Noto Serif', serif")
    expect(cssFontFamily('mono', true)).toBe("'OPE Noto Sans Mono', 'Noto Sans Mono', monospace")
    expect(cssFontFamily('sans', false)).toBe("Helvetica, Arial, 'Liberation Sans', Arimo, sans-serif")
    expect(cssFontFamily('serif', false)).toBe("'Times New Roman', Times, 'Liberation Serif', Tinos, serif")
    expect(cssFontFamily('mono', false)).toBe("'Courier New', Courier, 'Liberation Mono', Cousine, monospace")
  })
})
