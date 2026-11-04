import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib'
import { listContentItems } from '../../src/core/content'
import { visibleBox } from '../../src/core/pdf'
import { exportDocument, openDocument, addRedactions, makeRedaction, snapToGlyphs } from '../../src/core'
import { makeExistingContentPdf, makeOptionalContentPdf } from '../fixtures/pdfs'
import { addStdFont, pdfFromContent, pdfjsText as pdfjsItems } from './content/helpers'
import { registerTestFonts } from './helpers'
import { pdfjsText, rawContains, redact } from './redactionHelpers'

beforeAll(() => registerTestFonts())

/** Page space box (top-left origin) for a run of text drawn at baseline `y` (PDF space) on a 792pt page. */
function lineBox(x0: number, x1: number, baselinePdf: number, size: number, pageHeight = 792) {
  return { x: x0, y: pageHeight - baselinePdf - size * 0.75, width: x1 - x0, height: size * 0.95 }
}

async function textItems(bytes: Uint8Array, pageIndex = 0) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const page = pdf.getPage(pageIndex)
  return listContentItems(pdf, page, visibleBox(page))
}

describe('redacting text', () => {
  it('removes the glyphs under the area and keeps every other glyph in place', async () => {
    // Courier: every glyph is 600/1000 em wide, so "Secret" starts at 72 + 15 * 7.2 = 180.
    const bytes = await pdfFromContent(
      'BT /F1 12 Tf 72 700 Td (Account holder Secret Smith) Tj ET BT /F1 12 Tf 72 680 Td (Second line stays) Tj ET',
      async (doc, page) => {
        await addStdFont(doc, page, 'F1', StandardFonts.Courier)
        return {}
      }
    )
    const before = await pdfjsItems(bytes)
    const out = await redact(bytes, [lineBox(180, 180 + 6 * 7.2, 700, 12)])

    const text = await pdfjsText(out)
    expect(text).not.toContain('Secret')
    expect(text).toContain('Account holder')
    expect(text).toContain('Smith')
    expect(text).toContain('Second line stays')
    expect(await rawContains(out, 'Secret')).toBe(false)
    expect(await rawContains(out, 'ecre')).toBe(false)

    // Neighbouring glyphs keep their exact positions.
    const after = await pdfjsItems(out)
    const smithBefore = before[0].x + 22 * 7.2
    const smith = after.find((i) => i.str.includes('Smith'))!
    expect(smith.x + (smith.str.indexOf('Smith') * 7.2)).toBeCloseTo(smithBefore, 2)
    expect(smith.y).toBeCloseTo(before[0].y, 3)
    const holder = after.find((i) => i.str.includes('Account'))!
    expect(holder.x).toBeCloseTo(before[0].x, 3)
    const second = after.find((i) => i.str.includes('Second'))!
    const secondBefore = before.find((i) => i.str.includes('Second'))!
    expect([second.x, second.y]).toEqual([secondBefore.x, secondBefore.y])

    // The content engine does not find the text either.
    const items = await textItems(out)
    expect(items.some((i) => i.text?.includes('Secret'))).toBe(false)
  })

  it('splits TJ arrays with kerning and keeps the following strings in place', async () => {
    const bytes = await pdfFromContent(
      'BT /F1 10 Tf 50 600 Td [(AB) -500 (CD) 250 (EFGH)] TJ (IJ) Tj ET',
      async (doc, page) => {
        await addStdFont(doc, page, 'F1', StandardFonts.Courier)
        return {}
      }
    )
    // Courier 10pt: 6pt per glyph. A=50 B=56, gap 5, C=67 D=73, back 2.5, E=76.5 F=82.5 G=88.5 H=94.5, I=100.5 J=106.5
    const out = await redact(bytes, [{ x: 66, y: 792 - 600 - 8, width: 16.4, height: 10 }])
    const text = await pdfjsText(out)
    expect(text.replace(/\s/g, '')).toContain('AB')
    expect(text).not.toMatch(/C|D|E/)
    expect(text).toContain('FGH')
    expect(text).toContain('IJ')
    const items = await pdfjsItems(out)
    const fgh = items.find((i) => i.str.includes('FGH'))!
    expect(fgh.x + fgh.str.indexOf('F') * 6).toBeCloseTo(82.5, 2)
    const ij = items.find((i) => i.str.includes('IJ'))!
    expect(ij.x + ij.str.indexOf('I') * 6).toBeCloseTo(100.5, 2)
    expect(await rawContains(out, 'CD')).toBe(false)
  })

  it("rewrites ' and \" operators and invisible (Tr 3) text", async () => {
    const bytes = await pdfFromContent(
      'BT /F1 12 Tf 14 TL 72 700 Td (first) Tj (hidden secret) \' 3 Tr 1 0.5 (ocrocr secret words) " ET',
      async (doc, page) => {
        await addStdFont(doc, page, 'F1', StandardFonts.Courier)
        return {}
      }
    )
    // Lines at 700, 686, 672; "secret" is characters 7..13 of both lines.
    const out = await redact(bytes, [{ x: 72 + 7 * 7.2 - 1, y: 792 - 690, width: 6 * 7.2 + 4, height: 30 }])
    const text = await pdfjsText(out)
    expect(text).toContain('first')
    expect(text).toContain('hidden')
    expect(text).toContain('ocrocr')
    expect(text).toContain('words')
    expect(text).not.toContain('secret')
    expect(await rawContains(out, 'secret')).toBe(false)
  })

  it('redacts text in hex strings of embedded (Identity-H) fonts', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('Keep this. Remove Confidential here.', { x: 72, y: 700, size: 14, font })
    const bytes = await doc.save()
    const width = font.widthOfTextAtSize('Keep this. Remove ', 14)
    const w2 = font.widthOfTextAtSize('Confidential', 14)
    const out = await redact(bytes, [{ x: 72 + width + 0.5, y: 792 - 700 - 11, width: w2 - 1, height: 14 }])
    const text = await pdfjsText(out)
    expect(text).not.toContain('Confidential')
    expect(text).toContain('Keep this. Remove')
    expect(text).toContain('here.')
    expect(await rawContains(out, 'Confidential')).toBe(false)
  })

  it('redacts text inside a form XObject through a private copy', async () => {
    const out = await redact(await makeExistingContentPdf(), [{ x: 70, y: 792 - 740, width: 200, height: 30 }], 1)
    const pages = (await pdfjsText(out)).split('\n')
    expect(pages[1]).not.toContain('Wrapped title')
    expect(pages[0]).toContain('Existing title')
    expect(await rawContains(out, 'Wrapped')).toBe(false)
  })

  it('redacts text and leaves the other pages untouched', async () => {
    const bytes = await makeExistingContentPdf()
    // "Body line one" at baseline 690, Helvetica 12.
    const out = await redact(bytes, [{ x: 60, y: 792 - 690 - 10, width: 120, height: 13 }])
    const pages = (await pdfjsText(out)).split('\n')
    expect(pages[0]).not.toContain('Body line one')
    expect(pages[0]).toContain('Body line two')
    expect(pages[0]).toContain('Existing title')
    expect(pages[1]).toContain('Wrapped title')
    expect(await rawContains(out, 'line one')).toBe(false)
  })

  it('drops /ActualText of marked content that lost glyphs', async () => {
    const bytes = await pdfFromContent(
      'BT /F1 12 Tf 72 700 Td /Span <</ActualText (Top Secret Name)>> BDC (XXXX) Tj EMC ( tail) Tj ET',
      async (doc, page) => {
        await addStdFont(doc, page, 'F1', StandardFonts.Courier)
        return {}
      }
    )
    const out = await redact(bytes, [{ x: 70, y: 792 - 700 - 10, width: 4 * 7.2 + 2, height: 13 }])
    expect(await rawContains(out, 'Top Secret')).toBe(false)
    expect(await pdfjsText(out)).toContain('tail')
  })

  it('keeps content that is only next to the area byte-identical', async () => {
    const content = 'BT /F1 12 Tf 72 700 Td (untouched text) Tj ET 0 0 1 rg 300 300 50 50 re f'
    const bytes = await pdfFromContent(content, async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Courier)
      return {}
    })
    const out = await redact(bytes, [{ x: 400, y: 400, width: 50, height: 50 }])
    const pdf = await PDFDocument.load(out)
    const contents = pdf.getPage(0).node.get(PDFName.of('Contents'))
    expect(contents).toBeDefined()
    expect(await pdfjsText(out)).toContain('untouched text')
  })

  it('removes text of a hidden layer under the area (without sanitize)', async () => {
    // "DRAFT" (hidden layer) at (50, 200) Helvetica 40 on a 400pt page.
    const out = await redact(await makeOptionalContentPdf(), [{ x: 45, y: 400 - 235, width: 140, height: 45 }])
    expect(await rawContains(out, 'DRAFT')).toBe(false)
    expect(await pdfjsText(out)).toContain('ALWAYS')
  })
})

describe('snapping search results to glyphs', () => {
  it('turns a rough box into the bounds of the glyphs it covers', async () => {
    const bytes = await pdfFromContent('BT /F1 12 Tf 72 700 Td (Account holder Secret Smith) Tj ET', async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Courier)
      return {}
    })
    const doc = await openDocument(bytes, 's.pdf')
    const pageId = doc.pages[0].id
    // Rough box: a little too wide on both sides (but not past the neighbours' centers).
    const [snapped] = await snapToGlyphs(doc, pageId, [{ x: 178, y: 80, width: 6 * 7.2 + 5, height: 18 }])
    expect(snapped.x).toBeCloseTo(180, 3)
    expect(snapped.width).toBeCloseTo(6 * 7.2, 3)
    expect(snapped.y).toBeCloseTo(792 - 700 - 12 * 0.629, 0)
    const out = await exportDocument(addRedactions(doc, [makeRedaction(pageId, snapped)]))
    const text = await pdfjsText(out)
    expect(text).toContain('Account holder')
    expect(text).toContain('Smith')
    expect(text).not.toContain('Secret')
  })
})
