import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, StandardFonts, rgb } from '@cantoo/pdf-lib'
import { applyContentEdits, listContentItems } from '../../../src/core/content'
import { visibleBox } from '../../../src/core/pdf'
import { addStdFont, byText, edit, listItems, pdfFromContent, pdfjsText, testHelpers } from './helpers'
import { bigContent, makeFormWrappedPdf } from './fixtures'

describe('content engine: misc behaviour', () => {
  it('lists a form XObject container before the items inside it', async () => {
    const ids = (await listItems(await makeFormWrappedPdf())).map((i) => i.id)
    expect(ids.indexOf('x2')).toBeLessThan(ids.indexOf('x2/t3'))
    expect(ids.indexOf('x2/x17')).toBeLessThan(ids.indexOf('x2/x17/t3'))
  })

  it('handles pages without content', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])
    expect(listContentItems(doc, page, visibleBox(page))).toEqual([])
    await applyContentEdits(doc, page, visibleBox(page), [{ itemId: 't1', deleted: true }], testHelpers(doc))
    expect(page.node.get(PDFName.of('Contents'))).toBeUndefined()
  })

  it('works on unsaved documents (pdf-lib content streams) and drawing after an edit', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([300, 300])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('Fresh', { x: 20, y: 250, size: 12, font })
    page.drawText('Keep', { x: 20, y: 230, size: 12, font })
    const items = listContentItems(doc, page, visibleBox(page))
    expect(items.map((i) => i.text)).toEqual(['Fresh', 'Keep'])
    await applyContentEdits(doc, page, visibleBox(page), [{ itemId: items[0].id, transform: [1, 0, 0, 1, 10, 0] }], testHelpers(doc))
    page.drawText('Drawn later', { x: 20, y: 200, size: 12, font, color: rgb(1, 0, 0) })
    const pj = await pdfjsText(await doc.save())
    // The moved item keeps its place in the stacking order.
    expect(pj.map((p) => [p.str, Math.round(p.x)])).toEqual([
      ['Fresh', 30],
      ['Keep', 20],
      ['Drawn later', 20]
    ])
  })

  it('joins text across marked-content boundaries of tagged PDFs', async () => {
    const bytes = await pdfFromContent(
      'BT /F1 12 Tf 72 700 Td /P <</MCID 0>> BDC (Tagged ) Tj EMC /Span <</MCID 1>> BDC (sentence) Tj EMC ET',
      async (doc, page) => {
        await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
        return {}
      }
    )
    const items = await listItems(bytes)
    expect(items.map((i) => i.text)).toEqual(['Tagged sentence'])
    const out = await edit(bytes, [{ itemId: items[0].id, deleted: true }])
    expect(await pdfjsText(out)).toEqual([])
  })

  it('joins words separated by positioning or repeated identical state operators', async () => {
    const bytes = await pdfFromContent(
      'BT /F1 12 Tf 72 700 Td 0 g (Each) Tj 0 g 30 0 Td (word) Tj 0 g 30 0 Td (positioned) Tj ET',
      async (doc, page) => {
        await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
        return {}
      }
    )
    expect((await listItems(bytes)).map((i) => i.text)).toEqual(['Each word positioned'])
  })

  it('reads the font set by an ExtGState /Font entry', async () => {
    const bytes = await pdfFromContent('BT /GSF gs 72 700 Td (ViaGS) Tj ET', async (doc, page) => {
      const f = await doc.embedFont(StandardFonts.Courier)
      page.node.setExtGState(PDFName.of('GSF'), doc.context.obj({ Type: 'ExtGState', Font: [f.ref, 14] }))
      return {}
    })
    const [t] = await listItems(bytes)
    expect(t).toMatchObject({ text: 'ViaGS', fontName: 'Courier', fontSize: 14, fontFamily: 'mono' })
    const out = await edit(bytes, [{ itemId: t.id, transform: [1, 0, 0, 1, 0, 50] }])
    const [p] = await pdfjsText(out)
    expect(p.str).toBe('ViaGS')
    expect(p.y).toBeCloseTo(t.origin!.y + 50, 2)
    expect(p.transform[0]).toBeCloseTo(14, 3)
  })

  it('lists page-covering background rectangles and skips clip-only paths', async () => {
    const bytes = await pdfFromContent('1 1 0.9 rg 0 0 612 792 re f 0 0 612 792 re W n 0 g 10 10 m 20 20 l S', async () => ({}))
    const items = await listItems(bytes)
    expect(items.map((i) => [i.kind, i.bounds])).toEqual([
      ['path', { x: 0, y: 0, width: 612, height: 792 }],
      ['path', { x: 9.5, y: 771.5, width: 11, height: 11 }]
    ])
  })

  it('gives missing fonts no name and still lists the text', async () => {
    const bytes = await pdfFromContent('BT /Missing 12 Tf 72 700 Td (No font) Tj ET', async () => ({}))
    const [t] = await listItems(bytes)
    expect(t.text).toBe('No font')
    expect(t.fontName).toBeUndefined()
    expect(t.editableInPlace).toBe(false)
  })

  it('applies many edits to a page with 50k operators quickly', async () => {
    const bytes = await pdfFromContent(bigContent(5000), async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    })
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const items = listContentItems(doc, page, visibleBox(page))
    const edits = items
      .filter((_, i) => i % 10 === 0)
      .map((it, i) => (i % 2 ? { itemId: it.id, deleted: true } : { itemId: it.id, transform: [1, 0, 0, 1, 5, 5] as [number, number, number, number, number, number] }))
    const t0 = performance.now()
    await applyContentEdits(doc, page, visibleBox(page), edits, testHelpers(doc))
    expect(performance.now() - t0).toBeLessThan(2000)
    const after = listContentItems(doc, page, visibleBox(page))
    expect(after.length).toBe(items.length - edits.length / 2)
    const moved = byText(after, items[0].text!)
    expect(moved.origin!.x).toBeCloseTo(items[0].origin!.x + 5, 3)
  })
})

describe('shared fixture makeExistingContentPdf', () => {
  it('has the documented items on both pages', async () => {
    const { makeExistingContentPdf } = await import('../../fixtures/pdfs')
    const bytes = await makeExistingContentPdf()
    const p1 = await listItems(bytes, 0)
    expect(p1.filter((i) => i.kind === 'text').map((i) => [i.text, i.origin])).toEqual([
      ['Existing title', { x: 72, y: 72 }],
      ['Body line one', { x: 72, y: 102 }],
      ['Body line two', { x: 72, y: 118 }],
      ['Name', { x: 72, y: 152 }],
      ['Qty', expect.objectContaining({ y: 152 })],
      ['Price', expect.objectContaining({ y: 152 })]
    ])
    expect(byText(p1, 'Existing title')).toMatchObject({ fontName: 'Helvetica-Bold', fontSize: 24, color: '#1a33b3' })
    expect(p1.filter((i) => i.kind !== 'text').map((i) => [i.kind, i.bounds])).toEqual([
      ['image', { x: 72, y: 232, width: 100, height: 60 }],
      ['path', { x: 300, y: 242, width: 150, height: 50 }]
    ])
    const p2 = await listItems(bytes, 1)
    expect(p2.map((i) => [i.id, i.kind, i.text])).toEqual([
      ['x1', 'xobject', undefined],
      ['x1/t3', 'text', 'Wrapped title'],
      ['x1/p7', 'path', undefined]
    ])
  })
})
