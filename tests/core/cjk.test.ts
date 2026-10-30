/**
 * CJK and other non-bundled scripts: script detection, the fallback font chain (system fonts,
 * collections), CJK line breaking, and export round trips with the small OFL test fonts in
 * tests/fixtures/fonts (OPE Test CJK: TrueType, Chinese + kana; OPE Test JP: CFF, Japanese).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fontkit, { type Font } from '@cantoo/fontkit'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib'
import {
  addObject,
  clearRegisteredFonts,
  collectionFaceIndex,
  cssFontFamily,
  editContentItem,
  exportDocument,
  extractCollectionFace,
  fallbackFontKey,
  getContentItems,
  getFallbackFonts,
  hanLanguageFor,
  hanLanguageForLocale,
  isFontCollection,
  isRtlCodePoint,
  layoutText,
  loadSource,
  measureText,
  openDocument,
  prepareText,
  registerFallbackFonts,
  scriptOf,
  scriptsIn,
  setFormValue,
  setPreferredHanLanguage,
  splitAtCjkBreaks,
  updateSettings,
  type FallbackFont,
  type TextLayoutInput,
  type TextObject
} from '../../src/core'
import { makeExistingContentPdf, makeFormPdf, makeTextPdf } from '../fixtures/pdfs'
import { allPagesText, pageTextItems, registerTestFonts, testFont } from './helpers'

const CJK_TTF: FallbackFont = { id: 'test-cjk', bytes: testFont('OPETestCJK-Regular.ttf'), language: 'zh-Hans' }
const JP_OTF: FallbackFont = { id: 'test-jp', bytes: testFont('OPETestJP-Regular.otf'), language: 'ja' }
const TTC = testFont('OPETestCJK.ttc')
const sans = { font: 'sans' as const, bold: false, italic: false }
const input = (text: string, width: number, extra: Partial<TextLayoutInput> = {}): TextLayoutInput => ({
  ...sans,
  fontSize: 10,
  lineHeight: 1.2,
  text,
  width,
  align: 'left',
  ...extra
})

beforeEach(() => {
  clearRegisteredFonts()
  registerTestFonts()
  setPreferredHanLanguage('zh-Hans')
})
afterEach(() => {
  clearRegisteredFonts()
  registerTestFonts()
})

function textObj(pageId: string, extra: Partial<TextObject> = {}): TextObject {
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    pageId,
    type: 'text',
    x: 60,
    y: 100,
    width: 300,
    height: 40,
    text: '你好世界',
    font: 'sans',
    bold: false,
    italic: false,
    fontSize: 16,
    color: '#000000',
    align: 'left',
    lineHeight: 1.2,
    rotation: 0,
    ...extra
  }
}

/** BaseFont names of the fonts used on a page (pdf-lib appends a suffix to embedded fonts). */
async function pageFontNames(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const fonts = doc.getPage(pageIndex).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  return fonts.keys().map((k) => (fonts.lookup(k, PDFDict).lookup(PDFName.of('BaseFont')) as PDFName).decodeText())
}

describe('script detection', () => {
  it('classifies the scripts that need fallback fonts', () => {
    const s = (ch: string) => scriptOf(ch.codePointAt(0)!)
    expect(['A', 'ą', 'Ж', 'λ', '€', '1'].map(s)).toEqual([null, null, null, null, null, null])
    expect(['中', '漢', '。', '「', 'Ａ', '𠀀', 'ㄅ'].map(s)).toEqual(['cjk', 'cjk', 'cjk', 'cjk', 'cjk', 'cjk', 'cjk'])
    expect(['あ', 'カ', 'ｶ', 'ー'].map(s)).toEqual(['kana', 'kana', 'kana', 'kana'])
    expect(['한', 'ᄀ', 'ㅎ'].map(s)).toEqual(['hangul', 'hangul', 'hangul'])
    expect([s('ก'), s('न'), s('ש'), s('م')]).toEqual(['thai', 'devanagari', 'hebrew', 'arabic'])
    expect(scriptsIn('Hello 你好 こんにちは 안녕')).toEqual(['cjk', 'kana', 'hangul'])
  })

  it('detects right-to-left characters', () => {
    for (const ch of ['ש', 'م', 'ܐ', 'ﷺ', 'ﻻ']) expect(isRtlCodePoint(ch.codePointAt(0)!), ch).toBe(true)
    for (const ch of ['a', '中', 'ก', 'न']) expect(isRtlCodePoint(ch.codePointAt(0)!), ch).toBe(false)
  })

  it('picks the Han language from kana, Hangul or the preference', () => {
    expect(hanLanguageFor('日本語のテキスト', 'zh-Hans')).toBe('ja')
    expect(hanLanguageFor('韓國語 한국어', 'zh-Hans')).toBe('ko')
    expect(hanLanguageFor('中文', 'zh-Hant')).toBe('zh-Hant')
    expect(hanLanguageFor('Latin ąčę', 'ja')).toBeNull()
    expect(['ja-JP', 'ko', 'zh-TW', 'zh-Hant-HK', 'zh-CN', 'en-US', undefined].map(hanLanguageForLocale)).toEqual([
      'ja',
      'ko',
      'zh-Hant',
      'zh-Hant',
      'zh-Hans',
      'zh-Hans',
      'zh-Hans'
    ])
  })
})

describe('CJK line breaks', () => {
  it('splits between ideographs, kana and Hangul but keeps other words whole', () => {
    expect(splitAtCjkBreaks('你好世界')).toEqual(['你', '好', '世', '界'])
    expect(splitAtCjkBreaks('한국어')).toEqual(['한', '국', '어'])
    expect(splitAtCjkBreaks('PDF编辑器')).toEqual(['PDF', '编', '辑', '器'])
    expect(splitAtCjkBreaks('Hello')).toEqual(['Hello'])
    expect(splitAtCjkBreaks('')).toEqual([''])
  })

  it('never starts a line with closing punctuation or small kana, nor ends one with an opening bracket', () => {
    expect(splitAtCjkBreaks('你好。世界！')).toEqual(['你', '好。', '世', '界！'])
    expect(splitAtCjkBreaks('「你好」')).toEqual(['「你', '好」'])
    expect(splitAtCjkBreaks('ちょっと')).toEqual(['ちょっ', 'と'])
    expect(splitAtCjkBreaks('コーヒー')).toEqual(['コー', 'ヒー'])
  })

  it('wraps CJK text without spaces at the box width', () => {
    registerFallbackFonts([CJK_TTF])
    // Ideographs are 1 em wide: 3 per 30 pt line at 10 pt.
    const lt = layoutText(input('你好世界中文测试', 30))
    expect(lt.lines.map((l) => l.text)).toEqual(['你好世', '界中文', '测试'])
    expect(lt.lines.every((l) => l.width <= 30 + 1e-6)).toBe(true)
    expect(lt.fontKey).toBe(fallbackFontKey('test-cjk'))
  })

  it('applies the punctuation rules when wrapping', () => {
    registerFallbackFonts([CJK_TTF])
    expect(layoutText(input('你好。世界', 20)).lines.map((l) => l.text)).toEqual(['你', '好。', '世界'])
    expect(layoutText(input('你「好」世', 30)).lines.map((l) => l.text)).toEqual(['你', '「好」', '世'])
  })

  it('wraps mixed Latin and CJK text at spaces and between ideographs', () => {
    registerFallbackFonts([CJK_TTF])
    const w = measureText('Hello 你好', { ...sans, fontSize: 10 })
    const lines = layoutText(input('Hello 你好世界', w + 0.01)).lines.map((l) => l.text)
    expect(lines).toEqual(['Hello 你好', '世界'])
    // A break at a space drops the space.
    expect(layoutText(input('你好 世界', 20)).lines.map((l) => l.text)).toEqual(['你好', '世界'])
  })
})

describe('fallback font chain', () => {
  it('replaces characters no font has with "?" and reports them', () => {
    const p = prepareText('Hi 你好 ą', sans)
    expect(p.text).toBe('Hi ?? ą')
    expect(p.missing).toEqual(['你', '好'])
    expect(p.rtl).toBe(false)
    expect(layoutText(input('你好', 0)).missing).toEqual(['你', '好'])
  })

  it('uses a registered fallback font that contains every character', () => {
    registerFallbackFonts([CJK_TTF])
    const p = prepareText('Hi 你好，世界', sans)
    expect(p.text).toBe('Hi 你好，世界')
    expect(p.missing).toEqual([])
    expect(p.font).toMatchObject({ unicode: true, fontKey: 'fallback:test-cjk' })
    // Text the bundled fonts can draw keeps using them.
    expect(prepareText('Ąžuolas', sans).font).toMatchObject({ unicode: true, fontKey: 'sans-regular' })
    expect(prepareText('Hello', sans).font.unicode).toBe(false)
    expect(getFallbackFonts()).toEqual([{ id: 'test-cjk', language: 'zh-Hans' }])
  })

  it('measures with the fallback font’s advance widths', () => {
    registerFallbackFonts([CJK_TTF])
    const font = fontkit.create(CJK_TTF.bytes) as Font
    const expected = font.layout('你好A').glyphs.reduce((s, g) => s + g.advanceWidth, 0) / font.unitsPerEm
    expect(measureText('你好A', { ...sans, fontSize: 10 })).toBeCloseTo(expected * 10, 9)
    expect(measureText('你好', { ...sans, fontSize: 10 })).toBeCloseTo(20, 6)
  })

  it('selects a face of a collection by PostScript name (default: the first face)', () => {
    registerFallbackFonts([{ id: 'ttc-regular', bytes: TTC, postscriptName: 'OPETestCJK-Regular' }])
    const regular = prepareText('你好', sans).font
    expect(regular).toMatchObject({ fontKey: 'fallback:ttc-regular', postscriptName: 'OPETestCJK-Regular' })
    const regularWidth = measureText('Hello 你好', { ...sans, fontSize: 10 })
    clearRegisteredFonts()
    registerFallbackFonts([CJK_TTF])
    expect(measureText('Hello 你好', { ...sans, fontSize: 10 })).toBeCloseTo(regularWidth, 9)
    clearRegisteredFonts()
    registerFallbackFonts([{ id: 'ttc-first', bytes: TTC }])
    expect(prepareText('你好', sans).font).toMatchObject({ postscriptName: 'OPETestCJK-Bold' })
    expect(measureText('Hello 你好', { ...sans, fontSize: 10 })).not.toBeCloseTo(regularWidth, 3)
  })

  it('prefers the font for the text’s CJK language', () => {
    registerFallbackFonts([CJK_TTF, JP_OTF])
    // Kana: Japanese font. Han only: the preferred language (Chinese by default).
    expect(prepareText('日本語のカタカナ', sans).font).toMatchObject({ fontKey: 'fallback:test-jp' })
    expect(prepareText('日本語', sans).font).toMatchObject({ fontKey: 'fallback:test-cjk' })
    setPreferredHanLanguage('ja')
    expect(prepareText('日本語', sans).font).toMatchObject({ fontKey: 'fallback:test-jp' })
    // A font that lacks a character loses against one that has them all.
    expect(prepareText('你好こんにちは', sans).font).toMatchObject({ fontKey: 'fallback:test-cjk' })
  })

  it('prefers the matching weight and family', () => {
    registerFallbackFonts([
      { id: 'regular', bytes: TTC, postscriptName: 'OPETestCJK-Regular' },
      { id: 'bold', bytes: TTC, postscriptName: 'OPETestCJK-Bold', bold: true },
      { id: 'serif', bytes: CJK_TTF.bytes, family: 'serif' }
    ])
    expect(prepareText('你好', sans).font).toMatchObject({ fontKey: 'fallback:regular' })
    expect(prepareText('你好', { ...sans, bold: true }).font).toMatchObject({ fontKey: 'fallback:bold' })
    expect(prepareText('你好', { ...sans, font: 'serif' }).font).toMatchObject({ fontKey: 'fallback:serif' })
    // Mono text uses a sans font when there is no mono one.
    expect(prepareText('你好', { ...sans, font: 'mono' }).font).toMatchObject({ fontKey: 'fallback:regular' })
  })

  it('without a font for every character picks the one missing the fewest', () => {
    registerFallbackFonts([JP_OTF])
    // The JP subset lacks 你好; the bundled sans face lacks everything CJK.
    const p = prepareText('こんにちは你好', sans)
    expect(p.font).toMatchObject({ fontKey: 'fallback:test-jp' })
    expect(p.text).toBe('こんにちは??')
    expect(p.missing).toEqual(['你', '好'])
  })

  it('treats right-to-left text as not supported yet', () => {
    registerFallbackFonts([CJK_TTF])
    const p = prepareText('שלום 你好', sans)
    expect(p.text).toBe('???? 你好')
    expect(p.rtl).toBe(true)
    expect(p.missing).toEqual(['ש', 'ל', 'ו', 'ם'])
  })

  it('declares fallback fonts for CSS under their own family', () => {
    expect(cssFontFamily('serif', true, 'fallback:sys3')).toBe("'OPE Fallback sys3', 'OPE Noto Serif', 'Noto Serif', serif")
    expect(cssFontFamily('sans', true, 'sans-regular')).toBe("'OPE Noto Sans', 'Noto Sans', sans-serif")
    expect(() => registerFallbackFonts([{ id: 'bad id"', bytes: CJK_TTF.bytes }])).toThrow(TypeError)
  })
})

describe('font collections', () => {
  it('extracts a face as a standalone font', () => {
    expect(isFontCollection(TTC)).toBe(true)
    expect(isFontCollection(CJK_TTF.bytes)).toBe(false)
    expect(collectionFaceIndex(TTC, 'OPETestCJK-Regular')).toBe(1)
    expect(collectionFaceIndex(TTC, 'Nope')).toBe(0)
    const face = extractCollectionFace(TTC, 1)
    expect(isFontCollection(face)).toBe(false)
    const parsed = fontkit.create(face) as Font
    const original = fontkit.create(CJK_TTF.bytes) as Font
    expect(parsed.postscriptName).toBe('OPETestCJK-Regular')
    expect(parsed.numGlyphs).toBe(original.numGlyphs)
    const advances = (f: Font) => f.layout('Hello 你好。').glyphs.map((g) => g.advanceWidth)
    expect(advances(parsed)).toEqual(advances(original))
    const outline = (f: Font) => f.glyphForCodePoint(0x4f60)!.path.toSVG()
    expect(outline(parsed)).toBe(outline(original))
    expect(extractCollectionFace(CJK_TTF.bytes)).toBe(CJK_TTF.bytes)
    expect(() => extractCollectionFace(TTC, 2)).toThrow(RangeError)
  })
})

describe('export with fallback fonts', () => {
  it('embeds the fallback font and round-trips CJK text through pdf.js', async () => {
    registerFallbackFonts([CJK_TTF, JP_OTF])
    let doc = await openDocument(await makeTextPdf(1), 'x.pdf')
    const pageId = doc.pages[0].id
    const texts = ['你好，世界！', 'Hello 中文测试', 'こんにちは、カタカナ']
    texts.forEach((text, i) => (doc = addObject(doc, textObj(pageId, { text, y: 100 + i * 60 }))))
    const out = await exportDocument(doc)
    const strs = (await pageTextItems(out, 1)).map((i) => i.str)
    for (const t of texts) expect(strs).toContain(t)
    const names = await pageFontNames(out)
    expect(names.some((n) => n.startsWith('OPETestCJK-Regular'))).toBe(true)
    // Kana text uses the Japanese font: a CFF (OpenType) font embedded as FontFile3.
    expect(names.some((n) => n.startsWith('OPETestJP-Regular'))).toBe(true)
    expect(await fontFileKinds(out)).toEqual(expect.arrayContaining(['FontFile2', 'FontFile3']))
  })

  it('embeds the selected face of a collection', async () => {
    registerFallbackFonts([{ id: 'ttc', bytes: TTC, postscriptName: 'OPETestCJK-Regular' }])
    let doc = await openDocument(await makeTextPdf(1), 'x.pdf')
    doc = addObject(doc, textObj(doc.pages[0].id, { text: '测试汉字' }))
    const out = await exportDocument(doc)
    expect((await pageTextItems(out, 1)).map((i) => i.str)).toContain('测试汉字')
    const names = await pageFontNames(out)
    expect(names.some((n) => n.startsWith('OPETestCJK-Regular'))).toBe(true)
    expect(names.some((n) => n.includes('Bold'))).toBe(false)
  })

  it('draws wrapped CJK lines exactly as laid out', async () => {
    registerFallbackFonts([CJK_TTF])
    let doc = await openDocument(await makeTextPdf(1), 'x.pdf')
    const obj = textObj(doc.pages[0].id, { text: '你好世界，这是中文测试。', width: 80, height: 80, fontSize: 16 })
    doc = addObject(doc, obj)
    const lines = layoutText(obj).lines.map((l) => l.text)
    expect(lines).toEqual(['你好世界，', '这是中文测', '试。'])
    const items = (await pageTextItems(await exportDocument(doc), 1)).filter((i) => lines.includes(i.str))
    expect(items.map((i) => i.str)).toEqual(lines)
    // One line below the other, all starting at the box's left edge.
    expect(new Set(items.map((i) => Math.round(i.transform[4] * 100)))).toEqual(new Set([60 * 100]))
    expect(items[0].transform[5] - items[1].transform[5]).toBeCloseTo(16 * 1.2, 3)
  })

  it('writes "?" for characters no font contains', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'x.pdf')
    doc = addObject(doc, textObj(doc.pages[0].id, { text: 'Total 你好' }))
    expect((await pageTextItems(await exportDocument(doc), 1)).map((i) => i.str)).toContain('Total ??')
  })

  it('fills form fields with CJK values and draws their appearance with the fallback font', async () => {
    registerFallbackFonts([CJK_TTF])
    let doc = await openDocument(await makeFormPdf(), 'form.pdf')
    doc = setFormValue(doc, doc.primarySourceId!, 'name', '王小明')
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.formFields.find((f) => f.name === 'name')?.value).toBe('王小明')
    const pdf = await PDFDocument.load(out)
    const widget = pdf.getForm().getTextField('name').acroField.getWidgets()[0]
    const ap = widget.getNormalAppearance()
    const stream = (ap instanceof PDFRef ? pdf.context.lookup(ap) : ap) as PDFRawStream
    const fonts = stream.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    const baseFonts = fonts.keys().map((k: PDFName) => (fonts.lookup(k, PDFDict).lookup(PDFName.of('BaseFont')) as PDFName).decodeText())
    expect(baseFonts.some((n) => n.startsWith('OPETestCJK-Regular'))).toBe(true)
    expect(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).toMatch(/Tj/)
  })

  it('draws CJK watermarks and page numbers', async () => {
    registerFallbackFonts([CJK_TTF])
    let doc = await openDocument(await makeTextPdf(2), 'x.pdf')
    doc = updateSettings(doc, {
      watermark: { text: '测试', fontSize: 40, color: '#ff0000', opacity: 0.3, angle: 45 },
      pageNumbers: { format: '第 {n} 页，共 {total} 页', position: 'bottom-center', fontSize: 10, color: '#000000', startAt: 1, margin: 24 }
    })
    const texts = await allPagesText(await exportDocument(doc))
    expect(texts[0]).toContain('测试')
    expect(texts[0]).toContain('第 1 页，共 2 页')
    expect(texts[1]).toContain('第 2 页，共 2 页')
  })

  it('re-types existing text in CJK with the fallback font', async () => {
    registerFallbackFonts([CJK_TTF])
    let doc = await openDocument(await makeExistingContentPdf(), 'e.pdf')
    const pageId = doc.pages[0].id
    const item = (await getContentItems(doc, pageId)).find((i) => i.kind === 'text' && i.text)!
    doc = editContentItem(doc, pageId, item.id, { text: '你好世界' })
    const out = await exportDocument(doc)
    const strs = (await pageTextItems(out, 1)).map((i) => i.str)
    expect(strs).toContain('你好世界')
    expect(strs).not.toContain(item.text)
    expect((await pageFontNames(out)).some((n) => n.startsWith('OPETestCJK-Regular'))).toBe(true)
  })
})

/** Which embedded font file kinds (FontFile2 = TrueType, FontFile3 = CFF) the PDF contains. */
async function fontFileKinds(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const kinds = new Set<string>()
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.lookup(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue
    for (const k of ['FontFile', 'FontFile2', 'FontFile3']) if (obj.get(PDFName.of(k))) kinds.add(k)
  }
  return [...kinds]
}
