/**
 * Fixture PDFs for the content-engine tests.
 */
import fontkit from '@cantoo/fontkit'
import { PDFDocument, PDFName, StandardFonts, degrees, rgb, type PDFPage } from '@cantoo/pdf-lib'
import { TINY_JPEG, makePng } from '../helpers'
import { addStdFont, fontBytes, latin1, pdfFromContent } from './helpers'

/** pdf-lib drawn page: standard + embedded fonts, rotated text, images, shapes, a table. */
export async function makeMixedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const page = doc.addPage([612, 792])
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const times = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const noto = await doc.embedFont(fontBytes('NotoSans-Regular.ttf'), { subset: true })
  const notoSerif = await doc.embedFont(fontBytes('NotoSerif-Bold.ttf'), { subset: false })
  page.drawText('Quarterly Report', { x: 72, y: 720, size: 24, font: bold, color: rgb(0.1, 0.2, 0.6) })
  page.drawText('First line of body text\nSecond line of body text\nThird line', {
    x: 72,
    y: 680,
    size: 12,
    font: helv,
    lineHeight: 16
  })
  page.drawText('Italic serif words', { x: 72, y: 610, size: 14, font: times })
  page.drawText('Ąžuolas čiulba vėjyje', { x: 72, y: 580, size: 16, font: noto, color: rgb(0, 0.5, 0) })
  page.drawText('Serif bold full font', { x: 72, y: 555, size: 13, font: notoSerif })
  page.drawText('Rotated text', { x: 400, y: 600, size: 18, font: helv, rotate: degrees(45) })
  page.drawText('Vertical', { x: 560, y: 400, size: 14, font: helv, rotate: degrees(90) })
  const png = await doc.embedPng(makePng(4, 3, [255, 0, 0]))
  page.drawImage(png, { x: 72, y: 400, width: 120, height: 90 })
  const jpg = await doc.embedJpg(TINY_JPEG)
  page.drawImage(jpg, { x: 300, y: 380, width: 80, height: 60, rotate: degrees(30) })
  page.drawRectangle({ x: 72, y: 300, width: 150, height: 60, color: rgb(1, 1, 0), borderColor: rgb(0, 0, 0), borderWidth: 2 })
  page.drawEllipse({ x: 350, y: 330, xScale: 60, yScale: 30, color: rgb(0, 0.6, 1) })
  page.drawSvgPath('M 0 0 L 50 0 L 25 -40 Z', { x: 450, y: 360, color: rgb(1, 0, 0.5) })
  page.drawLine({ start: { x: 72, y: 280 }, end: { x: 540, y: 280 }, thickness: 1.5, color: rgb(0.3, 0.3, 0.3) })
  // A small table: one drawText per cell on shared baselines.
  const cols = [72, 220, 360]
  const rows = [['Item', 'Qty', 'Price'], ['Apples', '12', '3.40'], ['Pears', '7', '2.10']]
  rows.forEach((row, r) => {
    row.forEach((cell, c) => page.drawText(cell, { x: cols[c], y: 240 - r * 18, size: 11, font: r === 0 ? bold : helv }))
  })
  return doc.save()
}

/** Hand-written text operators: TJ kerning, table TJ, Tz/Tc/Tw/Ts, ' and ", TL, Tm scaling. */
export async function makeTextOpsPdf(): Promise<Uint8Array> {
  return pdfFromContent(
    [
      'BT /F1 12 Tf 72 720 Td [(W) 120 (orld) -30 (wide) ( web)] TJ ET',
      'BT /F1 10 Tf 72 690 Td [(Name) -9000 (Qty) -6000 (Price)] TJ ET',
      'BT /F1 12 Tf 80 Tz 1.5 Tc 6 Tw 72 660 Td (Scaled spaced text) Tj ET',
      'BT /F1 12 Tf 72 630 Td (Base) Tj 4 Ts (up) Tj 0 Ts ( again) Tj ET',
      "BT /F1 12 Tf 14 TL 72 600 Td (Line one) Tj (Line two) ' 3 0.5 (Line three) \" T* (Line four) Tj ET",
      'BT /F2 1 Tf 12 0 0 12 300 720 Tm (Matrix sized) Tj ET',
      'BT /F1 12 Tf 72 500 Td (Split ) Tj 10 0 Td (into) Tj ( two ops) Tj ET',
      'BT /F1 12 Tf 1 0 0 rg 72 470 Td (Red) Tj 0 0 1 rg ( Blue) Tj ET',
      'BT /F1 12 Tf 3 Tr 72 440 Td (Invisible OCR text) Tj ET',
      'BT /F1 12 Tf 1 Tr 0 0 1 RG 0.5 w 72 410 Td (Outlined) Tj ET'
    ].join('\n'),
    async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      await addStdFont(doc, page, 'F2', StandardFonts.TimesRoman)
      return {}
    }
  )
}

/** A Type3 font (two square/triangle glyphs) with a ToUnicode map. */
export async function makeType3Pdf(): Promise<Uint8Array> {
  return pdfFromContent('BT /T3 20 Tf 100 600 Td (ABBA) Tj ET\nBT /F1 12 Tf 100 560 Td (After type3) Tj ET', async (doc, page) => {
    const ctx = doc.context
    const square = ctx.register(ctx.stream('800 0 0 0 750 750 d1 0 0 750 750 re f'))
    const tri = ctx.register(ctx.stream('600 0 0 0 600 700 d1 0 0 m 600 0 l 300 700 l f'))
    const toUnicode = ctx.register(
      ctx.stream(
        latin1(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T3 def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <0058> <42> <0059> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    const t3 = ctx.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 800, 750],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { square, tri },
      Encoding: { Type: 'Encoding', Differences: [65, 'square', 'tri'] },
      FirstChar: 65,
      LastChar: 66,
      Widths: [800, 600],
      Resources: {},
      ToUnicode: toUnicode
    })
    page.node.setFontDictionary(PDFName.of('T3'), ctx.register(t3))
    await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
    return {}
  })
}

/** Inline images: binary data containing "EI", an ASCIIHex one, and /L. */
export async function makeInlineImagePdf(): Promise<Uint8Array> {
  // 2x2 RGB = 12 bytes; the data contains " EI " to trip naive parsers.
  const bin = String.fromCharCode(0x20, 0x45, 0x49, 0x20, 0xff, 0x00, 0x10, 0x45, 0x49, 0x0a, 0x80, 0x81)
  return pdfFromContent(
    [
      'q 100 0 0 50 72 600 cm',
      `BI /W 2 /H 2 /BPC 8 /CS /RGB ID ${bin} EI`,
      'Q',
      'q 60 0 0 60 300 600 cm BI /W 2 /H 1 /BPC 8 /CS /G /F /AHx ID 00FF> EI Q',
      'BT /F1 12 Tf 72 560 Td (After images) Tj ET'
    ].join('\n'),
    async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    }
  )
}

/**
 * Page content = one form XObject (`/Fm0 Do`) that draws everything: text, a rectangle, an
 * image and a nested form XObject (with its own text). Resource names clash with the page's.
 */
export async function makeFormWrappedPdf(options: { twice?: boolean } = {}): Promise<Uint8Array> {
  return pdfFromContent(
    options.twice ? 'q /Fm0 Do Q q 1 0 0 1 0 -300 cm /Fm0 Do Q' : 'q 1 0 0 1 10 20 cm /Fm0 Do Q\nBT /F1 10 Tf 72 40 Td (Page level text) Tj ET',
    async (doc, page) => {
      const ctx = doc.context
      const pageFont = await doc.embedFont(StandardFonts.Courier)
      page.node.setFontDictionary(PDFName.of('F1'), pageFont.ref)
      const helv = await doc.embedFont(StandardFonts.Helvetica)
      const times = await doc.embedFont(StandardFonts.TimesRoman)
      const png = await doc.embedPng(makePng(2, 2, [0, 0, 255]))
      const inner = ctx.register(
        ctx.stream(latin1('BT /F1 14 Tf 20 20 Td (Nested form text) Tj ET 0 1 0 rg 0 0 30 10 re f'), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 300, 100],
          Matrix: [1, 0, 0, 1, 50, 100],
          Resources: { Font: { F1: times.ref } }
        })
      )
      const fm0 = ctx.register(
        ctx.stream(
          latin1(
            [
              'BT /F1 18 Tf 62 700 Td (Form title) Tj ET',
              'BT /F1 12 Tf 62 670 Td (Form body line) Tj ET',
              '1 0 0 rg 62 600 200 40 re f',
              'q 100 0 0 80 300 560 cm /Im1 Do Q',
              '/Fx Do'
            ].join('\n')
          ),
          {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 612, 792],
            Resources: { Font: { F1: helv.ref }, XObject: { Im1: png.ref, Fx: inner } }
          }
        )
      )
      page.node.setXObject(PDFName.of('Fm0'), fm0)
      return {}
    }
  )
}

/** Broken syntax: unbalanced q/Q, garbage tokens, missing ET. */
export async function makeGarbagePdf(): Promise<Uint8Array> {
  return pdfFromContent(
    [
      'Q Q',
      'foo 1 2 bar ] }',
      'q 0 0 1 rg 72 600 100 50 re f',
      'BT /F1 12 Tf 72 560 Td (Still readable) Tj ET',
      '1 2 3 4 5 6 7 8 re f',
      'BT /F1 12 Tf 72 520 Td (No ET at end) Tj'
    ].join('\n'),
    async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    }
  )
}

/** Editor-object drawings in OPEObject sections around normal content. */
export async function makeMarkedPdf(): Promise<Uint8Array> {
  return pdfFromContent(
    [
      'BT /F1 12 Tf 72 700 Td (Before) Tj ET',
      '/OPEObject <</Id (obj_a)>> BDC q 1 0 0 rg 72 600 50 50 re f BT /F1 12 Tf 72 580 Td (Object A) Tj ET Q EMC',
      '0 0 1 rg 200 600 50 50 re f',
      '/OPEObject <</Id (obj_b)>> BDC q /Span BMC 0 1 0 rg 300 600 50 50 re f EMC Q EMC',
      'BT /F1 12 Tf 72 500 Td (After) Tj ET'
    ].join('\n'),
    async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    }
  )
}

/** A page with a crop box that does not start at the origin. */
export async function makeCroppedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([700, 900])
  page.setMediaBox(-50, -50, 700, 900)
  page.setCropBox(50, 100, 500, 600)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Cropped text', { x: 100, y: 650, size: 20, font })
  page.drawRectangle({ x: 100, y: 300, width: 100, height: 50, color: rgb(1, 0, 0) })
  return doc.save()
}

/** Non-embedded font with a /Differences encoding and a TrueType-like /Widths array. */
export async function makeDifferencesPdf(): Promise<Uint8Array> {
  return pdfFromContent('BT /FD 16 Tf 72 700 Td (ABC) Tj ET', async (doc, page: PDFPage) => {
    const ctx = doc.context
    const font = ctx.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [65, 'Aogonek', 'scaron', 'uni0117'] }
    })
    page.node.setFontDictionary(PDFName.of('FD'), ctx.register(font))
    return {}
  })
}

/** Many operators (performance). */
export function bigContent(rows: number): string {
  const parts: string[] = []
  for (let i = 0; i < rows; i++) {
    const y = 20 + (i % 700)
    parts.push(`BT /F1 8 Tf ${20 + (i % 3) * 180} ${y} Td [(Row ${i}) -200 (x)] TJ ET`)
    parts.push(`0.5 w ${20 + (i % 5)} ${y} m ${200 + (i % 7)} ${y} l S`)
  }
  return parts.join('\n')
}
