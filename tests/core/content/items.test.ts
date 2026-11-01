import { beforeAll, describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'
import fontkit from '@cantoo/fontkit'
import type { ContentItem } from '../../../src/core/model'
import {
  addStdFont,
  byText,
  fontBytes,
  imageBoundsInPage,
  latin1,
  listItems,
  pdfFromContent,
  pdfjsImages,
  pdfjsText,
  type PdfjsTextItem
} from './helpers'
import { timeBudget } from '../helpers'
import {
  makeCroppedPdf,
  makeDifferencesPdf,
  makeFormWrappedPdf,
  makeGarbagePdf,
  makeInlineImagePdf,
  makeMixedPdf,
  makeTextOpsPdf,
  makeType3Pdf
} from './fixtures'

const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol)

/** Our item's baseline end x (horizontal text). */
const endX = (it: ContentItem) => it.bounds.x + it.bounds.width

function expectMatchesPdfjs(item: ContentItem, pj: PdfjsTextItem, widthTol = 1) {
  near(item.origin!.x, pj.x)
  near(item.origin!.y, pj.y)
  near(item.bounds.width, pj.width, widthTol)
}

describe('listContentItems: content drawn by pdf-lib', () => {
  let bytes: Uint8Array
  let items: ContentItem[]
  let pj: PdfjsTextItem[]
  beforeAll(async () => {
    bytes = await makeMixedPdf()
    items = await listItems(bytes)
    pj = await pdfjsText(bytes)
  })

  it('lists every text line pdf.js finds, with the same string, baseline origin and width', () => {
    const texts = items.filter((i) => i.kind === 'text')
    expect(texts.map((t) => t.text).sort()).toEqual(pj.map((p) => p.str).sort())
    for (const p of pj) {
      const it = byText(items, p.str)
      if (Math.abs(it.angle ?? 0) > 0.01) continue
      expectMatchesPdfjs(it, p)
    }
  })

  it('reports font name, family, style, size, color and editability', () => {
    const title = byText(items, 'Quarterly Report')
    expect(title).toMatchObject({ fontName: 'Helvetica-Bold', fontFamily: 'sans', bold: true, italic: false, fontSize: 24, editableInPlace: true })
    expect(title.color).toBe('#1a3399')
    expect(byText(items, 'Italic serif words')).toMatchObject({ fontName: 'Times-Italic', fontFamily: 'serif', italic: true, bold: false })
    const noto = byText(items, 'Ąžuolas čiulba vėjyje')
    expect(noto.fontName).toMatch(/^NotoSans-Regular/)
    expect(noto.editableInPlace).toBe(false) // CID (Type0) font
    expect(noto.color).toBe('#008000')
    expect(noto.fontSize).toBe(16)
    const serif = byText(items, 'Serif bold full font')
    expect(serif.bold).toBe(true)
    expect(serif.fontFamily).toBe('serif')
  })

  it('gives text a box from descent to ascent along the baseline', () => {
    const t = byText(items, 'First line of body text')
    // Helvetica: ascent 718, descent -207 at 12pt.
    near(t.bounds.y, 112 - 0.718 * 12, 0.3)
    near(t.bounds.y + t.bounds.height, 112 + 0.207 * 12, 0.3)
    expect(t.quad).toEqual([
      { x: t.bounds.x, y: t.bounds.y },
      { x: t.bounds.x + t.bounds.width, y: t.bounds.y },
      { x: t.bounds.x + t.bounds.width, y: t.bounds.y + t.bounds.height },
      { x: t.bounds.x, y: t.bounds.y + t.bounds.height }
    ])
  })

  it('handles rotated text: angle, origin and a rotated quad', () => {
    const r = byText(items, 'Rotated text')
    expect(r.angle).toBe(-45) // counter-clockwise on screen
    const p = pj.find((x) => x.str === 'Rotated text')!
    near(r.origin!.x, p.x)
    near(r.origin!.y, p.y)
    const [tl, tr] = r.quad!
    const len = Math.hypot(tr.x - tl.x, tr.y - tl.y)
    near(len, p.width) // the quad's top edge runs along the baseline
    near((Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI, -45, 0.01)
    const v = byText(items, 'Vertical')
    expect(v.angle).toBe(-90)
    near(v.bounds.height, pj.find((x) => x.str === 'Vertical')!.width)
  })

  it('lists images at the positions pdf.js paints them', async () => {
    const imgs = items.filter((i) => i.kind === 'image')
    const pjImgs = await pdfjsImages(bytes)
    expect(imgs).toHaveLength(2)
    expect(pjImgs).toHaveLength(2)
    imgs.forEach((img, k) => {
      const expected = imageBoundsInPage(pjImgs[k].transform, 792)
      near(img.bounds.x, expected.x)
      near(img.bounds.y, expected.y)
      near(img.bounds.width, expected.width)
      near(img.bounds.height, expected.height)
    })
    // The rotated JPEG has a rotated quad (top edge at -30°).
    const [tl, tr] = imgs[1].quad!
    near((Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI, -30, 0.01)
  })

  it('lists one item per painted path with stroke-inclusive bounds and colors', () => {
    const paths = items.filter((i) => i.kind === 'path')
    expect(paths).toHaveLength(4)
    const [rect, ellipse, svg, line] = paths
    // Rectangle 150x60 at (72, 300) with a 2pt border → 1pt outside on each side.
    expect(rect.bounds).toEqual({ x: 71, y: 792 - 361, width: 152, height: 62 })
    expect(rect.color).toBe('#ffff00')
    expect(rect.strokeColor).toBe('#000000')
    // Ellipse centred at (350, 330), radii 60 x 30.
    near(ellipse.bounds.x, 290, 0.01)
    near(ellipse.bounds.y, 792 - 360, 0.01)
    near(ellipse.bounds.width, 120, 0.01)
    near(ellipse.bounds.height, 60, 0.01)
    expect(ellipse.color).toBe('#0099ff')
    // SVG triangle: (450,360) (500,360) (475,400) in PDF space.
    expect(svg.bounds).toEqual({ x: 450, y: 792 - 400, width: 50, height: 40 })
    // A stroke-only line: color is the stroke color.
    expect(line.color).toBe('#4d4d4d')
    near(line.bounds.height, 1.5, 0.01)
  })

  it('splits table cells into separate items', () => {
    for (const cell of ['Item', 'Qty', 'Price', 'Apples', '12', '3.40', 'Pears', '7', '2.10']) {
      expectMatchesPdfjs(byText(items, cell), pj.find((p) => p.str === cell)!)
    }
  })

  it('returns deterministic ids', async () => {
    const again = await listItems(bytes)
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id))
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    for (const it of items) expect(it.id).toMatch(/^[tpixs]\d+(\.\d+)?$/)
  })
})

describe('listContentItems: text operators', () => {
  let items: ContentItem[]
  let pj: PdfjsTextItem[]
  beforeAll(async () => {
    const bytes = await makeTextOpsPdf()
    items = await listItems(bytes)
    pj = await pdfjsText(bytes)
  })

  it('joins TJ kerning runs into one item', () => {
    expectMatchesPdfjs(byText(items, 'Worldwide web'), pj.find((p) => p.str === 'Worldwide web')!)
  })

  it('splits a TJ array at column-sized gaps', () => {
    const name = byText(items, 'Name')
    const qty = byText(items, 'Qty')
    const price = byText(items, 'Price')
    expect(name.id).toBe('t8')
    expect(qty.id).toBe('t8.1')
    expect(price.id).toBe('t8.2')
    for (const it of [name, qty, price]) expectMatchesPdfjs(it, pj.find((p) => p.str === it.text)!)
  })

  it('applies horizontal scaling, character and word spacing', () => {
    const it = byText(items, 'Scaled spaced text')
    const first = pj.find((p) => p.str === 'Scaled')!
    const last = pj.find((p) => p.str === 'text')!
    near(it.origin!.x, first.x)
    near(endX(it), last.x + last.width, 1.5) // pdf.js counts the trailing Tc
  })

  it('applies text rise and keeps raised text separate', () => {
    const up = byText(items, 'up')
    near(up.origin!.y, pj.find((p) => p.str === 'up')!.y)
    near(byText(items, 'Base').origin!.y - up.origin!.y, 4, 0.01)
    expect(byText(items, 'again').origin!.x).toBeCloseTo(pj.find((p) => p.str === 'again')!.x, 1)
  })

  it("handles ' and \" (next line, word/char spacing) with TL", () => {
    expect(['Line one', 'Line two', 'Line three', 'Line four'].map((t) => byText(items, t).origin!.y)).toEqual([192, 206, 220, 234])
    expectMatchesPdfjs(byText(items, 'Line three'), pj.find((p) => p.str === 'Line three')!)
  })

  it('computes the effective font size from Tf × Tm', () => {
    const it = byText(items, 'Matrix sized')
    expect(it.fontSize).toBe(12)
    expect(it.fontName).toBe('Times-Roman')
    near(it.origin!.x, 300)
  })

  it('splits at color changes and reports each color', () => {
    expect(byText(items, 'Red').color).toBe('#ff0000')
    const blue = byText(items, 'Blue')
    expect(blue.color).toBe('#0000ff')
    // pdf.js reports "Red Blue" as one item; the B starts after "Red ".
    const pjRed = pj.find((p) => p.str === 'Red Blue')!
    expect(blue.origin!.x).toBeGreaterThan(pjRed.x + 18)
  })

  it('skips invisible text and uses the stroke color for outlined text', () => {
    expect(items.some((i) => i.text?.includes('Invisible'))).toBe(false)
    const outlined = byText(items, 'Outlined')
    expect(outlined.color).toBe('#0000ff')
    expect(outlined.strokeColor).toBe('#0000ff')
  })
})

describe('listContentItems: fonts', () => {
  it('reads Type3 fonts (FontMatrix widths, ToUnicode)', async () => {
    const bytes = await makeType3Pdf()
    const items = await listItems(bytes)
    const pj = await pdfjsText(bytes)
    const t3 = byText(items, 'XYYX')
    expectMatchesPdfjs(t3, pj.find((p) => p.str === 'XYYX')!)
    expect(t3.bounds.width).toBeCloseTo(((800 + 600 + 600 + 800) / 1000) * 20, 5)
    expect(t3.editableInPlace).toBe(false)
    expectMatchesPdfjs(byText(items, 'After type3'), pj.find((p) => p.str === 'After type3')!)
  })

  it('decodes /Differences glyph names (incl. uniXXXX) like pdf.js', async () => {
    const bytes = await makeDifferencesPdf()
    const [item] = await listItems(bytes)
    const [p] = await pdfjsText(bytes)
    expect(item.text).toBe('Ąšė')
    expect(p.str).toBe('Ąšė')
    near(item.origin!.x, p.x)
  })

  it('decodes CID fonts without /ToUnicode via the embedded TrueType cmap', async () => {
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const page = doc.addPage([612, 792])
    // Full (non-subset) font: subsets written by pdf-lib have no cmap table.
    const font = await doc.embedFont(fontBytes(), { subset: false })
    page.drawText('Žąsys skrido', { x: 72, y: 700, size: 20, font })
    await doc.save() // finalize the subset font
    const fontDict = doc.context.lookup(font.ref) as PDFDict
    fontDict.delete(PDFName.of('ToUnicode'))
    const bytes = await doc.save()
    const items = await listItems(bytes)
    expect(items[0].text).toBe('Žąsys skrido')
  })

  it('handles vertical (Identity-V) CID fonts without crashing', async () => {
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const page = doc.addPage([612, 792])
    const font = await doc.embedFont(fontBytes(), { subset: true })
    page.drawText('Tate', { x: 300, y: 700, size: 20, font })
    await doc.save()
    const fontDict = doc.context.lookup(font.ref) as PDFDict
    fontDict.set(PDFName.of('Encoding'), PDFName.of('Identity-V'))
    const bytes = await doc.save()
    const items = await listItems(bytes)
    const t = items.find((i) => i.kind === 'text')!
    expect(t.text).toBe('Tate')
    // Glyphs advance downwards (default vertical metrics: 1 em per glyph).
    near(t.bounds.height, 4 * 20, 0.5)
  })

  it('reads embedded encoding CMaps with mixed code lengths and /W widths', async () => {
    const bytes = await pdfFromContent('BT /C0 10 Tf 72 700 Td <4181818182> Tj ET', async (doc, page) => {
      const ctx = doc.context
      const cmap = ctx.register(
        ctx.stream(
          latin1(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Mixed def 2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange 2 begincidrange <41> <41> 1 <8181> <8182> 2 endcidrange endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
      const toUnicode = ctx.register(
        ctx.stream(
          latin1('begincmap 2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange 1 beginbfchar <41> <0058> endbfchar 1 beginbfrange <8181> <8182> <0061> endbfrange endcmap')
        )
      )
      const desc = ctx.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: 'Mixed',
        CIDSystemInfo: { Registry: ctx.obj('Adobe') as never, Ordering: ctx.obj('Identity') as never, Supplement: 0 },
        DW: 500,
        W: [1, [1000], 2, 3, 250]
      })
      const font = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Mixed', Encoding: cmap, DescendantFonts: [ctx.register(desc)], ToUnicode: toUnicode })
      page.node.setFontDictionary(PDFName.of('C0'), ctx.register(font))
      return {}
    })
    const [item] = await listItems(bytes)
    expect(item.text).toBe('Xab')
    // widths: X = 1000, a = b = 250 (per 1000) at 10pt.
    near(item.bounds.width, 10 + 2.5 + 2.5, 0.01)
    expect(item.editableInPlace).toBe(false)
  })
})

describe('listContentItems: images, forms and structure', () => {
  it('lists inline images (binary data with EI inside, ASCIIHex) and content after them', async () => {
    const bytes = await makeInlineImagePdf()
    const items = await listItems(bytes)
    const imgs = items.filter((i) => i.kind === 'image')
    const pj = await pdfjsImages(bytes)
    expect(imgs).toHaveLength(2)
    expect(pj).toHaveLength(2)
    imgs.forEach((img, k) => expect(img.bounds).toEqual(imageBoundsInPage(pj[k].transform, 792)))
    const pjText = await pdfjsText(bytes)
    expectMatchesPdfjs(byText(items, 'After images'), pjText.find((p) => p.str === 'After images')!)
  })

  it('lists a page-wrapping form XObject and the items inside it (nested 2 levels)', async () => {
    const bytes = await makeFormWrappedPdf()
    const items = await listItems(bytes)
    const pj = await pdfjsText(bytes)
    const ids = items.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['x2', 'x2/t3', 'x2/t8', 'x2/p12', 'x2/i15', 'x2/x17', 'x2/x17/t3', 'x2/x17/p7', 't7']))
    for (const t of ['Form title', 'Form body line', 'Nested form text', 'Page level text']) {
      expectMatchesPdfjs(byText(items, t), pj.find((p) => p.str === t)!)
    }
    expect(byText(items, 'Nested form text').fontName).toBe('Times-Roman')
    expect(byText(items, 'Form title').fontName).toBe('Helvetica')
    expect(byText(items, 'Page level text').fontName).toBe('Courier')
    const img = items.find((i) => i.id === 'x2/i15')!
    const [pjImg] = await pdfjsImages(bytes)
    expect(img.bounds).toEqual(imageBoundsInPage(pjImg.transform, 792))
    const form = items.find((i) => i.id === 'x2')!
    expect(form.kind).toBe('xobject')
    expect(form.bounds).toEqual({ x: 10, y: -20, width: 612, height: 792 })
    const nested = items.find((i) => i.id === 'x2/x17')!
    expect(nested.bounds).toEqual({ x: 60, y: 792 - 220, width: 300, height: 100 })
  })

  it('does not expand a form XObject drawn more than once', async () => {
    const items = await listItems(await makeFormWrappedPdf({ twice: true }))
    expect(items.map((i) => i.kind)).toEqual(['xobject', 'xobject'])
  })

  it('tolerates garbage, unbalanced q/Q and a missing ET', async () => {
    const bytes = await makeGarbagePdf()
    const items = await listItems(bytes)
    const pj = await pdfjsText(bytes)
    expectMatchesPdfjs(byText(items, 'Still readable'), pj.find((p) => p.str === 'Still readable')!)
    expectMatchesPdfjs(byText(items, 'No ET at end'), pj.find((p) => p.str === 'No ET at end')!)
    expect(items.filter((i) => i.kind === 'path')).toHaveLength(2)
  })

  it('uses the crop box for page space', async () => {
    const bytes = await makeCroppedPdf()
    const items = await listItems(bytes)
    const [pj] = await pdfjsText(bytes)
    expectMatchesPdfjs(byText(items, 'Cropped text'), pj)
    const rect = items.find((i) => i.kind === 'path')!
    // Rect at (100, 300) 100x50 in user space; crop box origin (50, 100), height 600.
    expect(rect.bounds).toEqual({ x: 50, y: 100 + 600 - 350, width: 100, height: 50 })
  })

  it('clips image bounds to the clipping path and lists shadings', async () => {
    const bytes = await pdfFromContent(
      [
        'q 72 600 100 50 re W n 200 0 0 200 72 500 cm /Im0 Do Q',
        'q 300 300 150 80 re W n /Sh0 sh Q',
        'q 0 0 0 0 re W n 1 0 0 rg 10 10 50 50 re f Q'
      ].join('\n'),
      async (doc, page) => {
        const { makePng } = await import('../helpers')
        const img = await doc.embedPng(makePng(2, 2))
        page.node.setXObject(PDFName.of('Im0'), img.ref)
        const ctx = doc.context
        const sh = ctx.obj({
          ShadingType: 2,
          ColorSpace: 'DeviceRGB',
          Coords: [300, 0, 450, 0],
          Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }
        })
        const res = page.node.Resources()!
        res.set(PDFName.of('Shading'), ctx.obj({ Sh0: ctx.register(sh) }))
        return {}
      }
    )
    const items = await listItems(bytes)
    expect(items.map((i) => i.kind)).toEqual(['image', 'shading']) // fully clipped rect is invisible
    expect(items[0].bounds).toEqual({ x: 72, y: 792 - 650, width: 100, height: 50 })
    expect(items[1].bounds).toEqual({ x: 300, y: 792 - 380, width: 150, height: 80 })
  })

  it('keeps ids identical after copyPages into another document', async () => {
    const bytes = await makeMixedPdf()
    const src = await PDFDocument.load(bytes)
    const dst = await PDFDocument.create()
    dst.addPage([100, 100])
    const [copy] = await dst.copyPages(src, [0])
    dst.addPage(copy)
    const { listContentItems } = await import('../../../src/core/content')
    const { visibleBox } = await import('../../../src/core/pdf')
    const original = await listItems(bytes)
    const copied = listContentItems(dst, dst.getPage(1), visibleBox(dst.getPage(1)))
    expect(copied).toEqual(original)
    const reloaded = await listItems(await dst.save(), 1)
    expect(reloaded).toEqual(original)
  })

  it('handles pages with several content streams and inherited resources', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('One', { x: 72, y: 700, size: 12, font })
    page.drawText('Two', { x: 72, y: 680, size: 12, font, rotate: degrees(0), color: rgb(0, 0, 0) })
    // Move the page resources to the page tree node (inherited).
    const res = page.node.Resources()!
    page.node.delete(PDFName.of('Resources'))
    doc.catalog.Pages().set(PDFName.of('Resources'), res)
    const bytes = await doc.save()
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPage(0).node.Contents()).toBeInstanceOf(PDFArray)
    const items = await listItems(bytes)
    expect(items.map((i) => i.text)).toEqual(['One', 'Two'])
    expect(items.every((i) => i.fontName === 'Helvetica')).toBe(true)
  })
})

describe('performance', () => {
  it('lists a page with 50k operators in well under a second', async () => {
    const { bigContent } = await import('./fixtures')
    const bytes = await pdfFromContent(bigContent(5000), async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    })
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const { listContentItems } = await import('../../../src/core/content')
    const { visibleBox } = await import('../../../src/core/pdf')
    listContentItems(doc, page, visibleBox(page)) // warm-up
    const t0 = performance.now()
    const items = listContentItems(doc, page, visibleBox(page))
    const ms = performance.now() - t0
    expect(items.length).toBe(10000)
    expect(ms).toBeLessThan(timeBudget(700))
  })
})
