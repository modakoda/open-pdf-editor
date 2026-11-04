import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'
import type { ContentEdit, ContentItem, Matrix } from '../../../src/core/model'
import { OPS, closePdfjs, makePng, openWithPdfjs, pageContent, registerTestFonts, textAngle } from '../helpers'
import {
  addStdFont,
  byText,
  edit,
  imageBoundsInPage,
  listItems,
  pdfFromContent,
  pdfjsImages,
  pdfjsText,
  type PdfjsTextItem
} from './helpers'
import {
  makeCroppedPdf,
  makeFormWrappedPdf,
  makeGarbagePdf,
  makeInlineImagePdf,
  makeMixedPdf,
  makeTextOpsPdf
} from './fixtures'

const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol)
const move = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy]
/** Scale by k around (cx, cy) in page space. */
const scaleAt = (k: number, cx: number, cy: number): Matrix => [k, 0, 0, k, cx - k * cx, cy - k * cy]
/** Rotate clockwise (on screen) by deg around (cx, cy) in page space. */
function rotateAt(deg: number, cx: number, cy: number): Matrix {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
}

async function pathCount(bytes: Uint8Array, pageNumber = 1): Promise<number> {
  const doc = await openWithPdfjs(bytes)
  try {
    const page = await doc.getPage(pageNumber)
    const list = await page.getOperatorList()
    return list.fnArray.filter((f) => f === OPS.constructPath).length
  } finally {
    await closePdfjs(doc)
  }
}

/** pdf.js items, except the given strings, must be unchanged (position, width, font size). */
function expectUnchanged(before: PdfjsTextItem[], after: PdfjsTextItem[], except: string[] = []) {
  const keep = before.filter((b) => !except.includes(b.str))
  for (const b of keep) {
    const a = after.find((x) => x.str === b.str && Math.abs(x.x - b.x) < 0.05 && Math.abs(x.y - b.y) < 0.05)
    expect(a, `"${b.str}" at (${b.x}, ${b.y}) is gone`).toBeDefined()
    near(a!.width, b.width, 0.05)
    near(a!.transform[0], b.transform[0], 0.001)
    near(a!.transform[3], b.transform[3], 0.001)
  }
}

describe('deleting items', () => {
  let mixed: Uint8Array
  let items: ContentItem[]
  let pjBefore: PdfjsTextItem[]
  beforeAll(async () => {
    mixed = await makeMixedPdf()
    items = await listItems(mixed)
    pjBefore = await pdfjsText(mixed)
  })

  it('removes exactly one text line and nothing else', async () => {
    const target = byText(items, 'Second line of body text')
    const out = await edit(mixed, [{ itemId: target.id, deleted: true }])
    const after = await pdfjsText(out)
    expect(after.map((a) => a.str)).not.toContain('Second line of body text')
    expect(after).toHaveLength(pjBefore.length - 1)
    expectUnchanged(pjBefore, after, ['Second line of body text'])
    expect(await pdfjsImages(out)).toEqual(await pdfjsImages(mixed))
    expect(await pathCount(out)).toBe(await pathCount(mixed))
    // The rest of the content stream is byte-identical.
    const before = await pageContent(mixed, 0)
    const show = /<5365636F6E64[0-9A-F]*> Tj/.exec(before)![0]
    expect(await pageContent(out, 0)).toBe(before.replace(show, ''))
  })

  it('removes one cell of a TJ array and keeps the other cells in place', async () => {
    const bytes = await makeTextOpsPdf()
    const its = await listItems(bytes)
    const before = await pdfjsText(bytes)
    for (const cell of ['Qty', 'Name', 'Price']) {
      const out = await edit(bytes, [{ itemId: byText(its, cell).id, deleted: true }])
      const after = await pdfjsText(out)
      expect(after.map((a) => a.str)).not.toContain(cell)
      expectUnchanged(before, after, [cell])
    }
  })

  it('keeps later text of the same text object at its position', async () => {
    const bytes = await makeTextOpsPdf()
    const its = await listItems(bytes)
    const blue = byText(its, 'Blue')
    const out = await edit(bytes, [{ itemId: byText(its, 'Red').id, deleted: true }])
    const outItems = await listItems(out)
    expect(byText(outItems, 'Blue').origin).toEqual(blue.origin)
    const pj = await pdfjsText(out)
    expect(pj.find((p) => p.str === 'Blue')).toBeDefined()
    expect(pj.some((p) => p.str.includes('Red'))).toBe(false)
  })

  it("replaces deleted ' and \" lines by the equivalent line moves", async () => {
    const bytes = await makeTextOpsPdf()
    const its = await listItems(bytes)
    const four = byText(its, 'Line four')
    const out = await edit(bytes, [
      { itemId: byText(its, 'Line two').id, deleted: true },
      { itemId: byText(its, 'Line three').id, deleted: true }
    ])
    const outItems = await listItems(out)
    expect(outItems.some((i) => i.text === 'Line two' || i.text === 'Line three')).toBe(false)
    const four2 = byText(outItems, 'Line four')
    expect(four2.origin).toEqual(four.origin)
    expect(four2.bounds).toEqual(four.bounds) // word/char spacing from " still applies
    expect(byText(outItems, 'Line one').origin).toEqual(byText(its, 'Line one').origin)
  })

  it('deletes paths, images and inline images', async () => {
    const paths = items.filter((i) => i.kind === 'path')
    const png = items.find((i) => i.kind === 'image')!
    const out = await edit(mixed, [
      { itemId: paths[0].id, deleted: true },
      { itemId: paths[1].id, deleted: true },
      { itemId: png.id, deleted: true }
    ])
    expect(await pathCount(out)).toBe((await pathCount(mixed)) - 2)
    const imgs = await pdfjsImages(out)
    expect(imgs).toHaveLength(1)
    expect(imgs[0]).toEqual((await pdfjsImages(mixed))[1])
    expectUnchanged(pjBefore, await pdfjsText(out))
    const outItems = await listItems(out)
    const remaining = outItems.filter((i) => i.kind !== 'text').map((i) => i.bounds)
    expect(remaining).toEqual(items.filter((i) => i.kind !== 'text' && ![paths[0].id, paths[1].id, png.id].includes(i.id)).map((i) => i.bounds))

    const inline = await makeInlineImagePdf()
    const inlineItems = await listItems(inline)
    const out2 = await edit(inline, [{ itemId: inlineItems[0].id, deleted: true }])
    const pj2 = await pdfjsImages(out2)
    expect(pj2).toHaveLength(1)
    expect(pj2[0].transform).toEqual([60, 0, 0, 60, 300, 600])
    expect((await pdfjsText(out2)).map((t) => t.str)).toEqual(['After images'])
  })

  it('keeps the clipping effect of a deleted clipping path', async () => {
    const bytes = await pdfFromContent('q 0 0 1 rg 72 600 100 50 re W f 200 0 0 200 72 500 cm /Im0 Do Q', async (doc, page) => {
      const img = await doc.embedPng(makePng(2, 2))
      page.node.setXObject(PDFName.of('Im0'), img.ref)
      return {}
    })
    const its = await listItems(bytes)
    expect(its.map((i) => i.kind)).toEqual(['path', 'image'])
    const out = await edit(bytes, [{ itemId: its[0].id, deleted: true }])
    const outItems = await listItems(out)
    expect(outItems.map((i) => i.kind)).toEqual(['image'])
    expect(outItems[0].bounds).toEqual({ x: 72, y: 792 - 650, width: 100, height: 50 })
    expect(await pathCount(out)).toBe(1) // the clip path is still constructed (re W n)
  })

  it('deletes a form XObject and a shading', async () => {
    const form = await makeFormWrappedPdf()
    const out = await edit(form, [{ itemId: 'x2', deleted: true }])
    expect((await pdfjsText(out)).map((t) => t.str)).toEqual(['Page level text'])
  })
})

describe('moving and transforming items', () => {
  let mixed: Uint8Array
  let items: ContentItem[]
  let pjBefore: PdfjsTextItem[]
  beforeAll(async () => {
    mixed = await makeMixedPdf()
    items = await listItems(mixed)
    pjBefore = await pdfjsText(mixed)
  })

  it('moves text', async () => {
    const title = byText(items, 'Quarterly Report')
    const out = await edit(mixed, [{ itemId: title.id, transform: move(30, 40) }])
    const after = await pdfjsText(out)
    const moved = after.find((a) => a.str === 'Quarterly Report')!
    near(moved.x, title.origin!.x + 30, 0.01)
    near(moved.y, title.origin!.y + 40, 0.01)
    expectUnchanged(pjBefore, after, ['Quarterly Report'])
    const outItems = await listItems(out)
    const t = byText(outItems, 'Quarterly Report')
    expect(t.color).toBe(title.color)
    expect(t.fontName).toBe('Helvetica-Bold')
    near(t.bounds.x, title.bounds.x + 30, 0.01)
    near(t.bounds.y, title.bounds.y + 40, 0.01)
  })

  it('scales text around its origin', async () => {
    const t = byText(items, 'Third line')
    const out = await edit(mixed, [{ itemId: t.id, transform: scaleAt(2, t.origin!.x, t.origin!.y) }])
    const p = (await pdfjsText(out)).find((a) => a.str === 'Third line')!
    near(p.x, t.origin!.x, 0.01)
    near(p.y, t.origin!.y, 0.01)
    near(p.transform[0], 24, 0.001)
    near(p.width, t.bounds.width * 2, 0.05)
  })

  it('rotates text', async () => {
    const t = byText(items, 'Third line')
    const out = await edit(mixed, [{ itemId: t.id, transform: rotateAt(90, t.origin!.x, t.origin!.y) }])
    const p = (await pdfjsText(out)).find((a) => a.str === 'Third line')!
    expect(textAngle(p)).toBe(270) // 90° clockwise on screen
    near(p.x, t.origin!.x, 0.01)
    near(p.y, t.origin!.y, 0.01)
    const r = byText(await listItems(out), 'Third line')
    expect(r.angle).toBe(90)
  })

  it('moves, scales and rotates images', async () => {
    const [png, jpg] = items.filter((i) => i.kind === 'image')
    const out = await edit(mixed, [
      { itemId: png.id, transform: move(100, -50) },
      { itemId: jpg.id, transform: scaleAt(0.5, jpg.bounds.x, jpg.bounds.y) }
    ])
    const pj = await pdfjsImages(out)
    expect(pj).toHaveLength(2)
    const boxes = pj.map((p) => imageBoundsInPage(p.transform, 792))
    const pngBox = boxes.find((b) => Math.abs(b.width - 120) < 0.01)!
    near(pngBox.x, png.bounds.x + 100, 0.01)
    near(pngBox.y, png.bounds.y - 50, 0.01)
    const jpgBox = boxes.find((b) => b !== pngBox)!
    near(jpgBox.x, jpg.bounds.x, 0.01)
    near(jpgBox.y, jpg.bounds.y, 0.01)
    near(jpgBox.width, jpg.bounds.width / 2, 0.01)
    const rotated = await edit(mixed, [{ itemId: png.id, transform: rotateAt(90, png.bounds.x + 60, png.bounds.y + 45) }])
    const [r] = (await listItems(rotated)).filter((i) => i.kind === 'image' && Math.abs(i.bounds.width - 90) < 0.01)
    expect(r).toBeDefined()
    near(r.bounds.height, 120, 0.01)
    near(r.bounds.x + r.bounds.width / 2, png.bounds.x + 60, 0.01)
  })

  it('moves and rotates paths', async () => {
    const rect = items.find((i) => i.kind === 'path')!
    const out = await edit(mixed, [{ itemId: rect.id, transform: move(100, 50) }])
    expect(await pathCount(out)).toBe(await pathCount(mixed))
    const moved = (await listItems(out)).filter((i) => i.kind === 'path').find((p) => p.color === '#ffff00')!
    expect(moved.bounds).toEqual({ ...rect.bounds, x: rect.bounds.x + 100, y: rect.bounds.y + 50 })
    expect(moved.strokeColor).toBe('#000000')
    expectUnchanged(pjBefore, await pdfjsText(out))
    const cx = rect.bounds.x + rect.bounds.width / 2
    const cy = rect.bounds.y + rect.bounds.height / 2
    const rot = await edit(mixed, [{ itemId: rect.id, transform: rotateAt(90, cx, cy) }])
    const r = (await listItems(rot)).filter((i) => i.kind === 'path').find((p) => p.color === '#ffff00')!
    near(r.bounds.width, rect.bounds.height, 0.01)
    near(r.bounds.height, rect.bounds.width, 0.01)
    near(r.bounds.x + r.bounds.width / 2, cx, 0.01)
  })

  it('moves form XObjects with everything inside', async () => {
    const form = await makeFormWrappedPdf()
    const before = await pdfjsText(form)
    const out = await edit(form, [{ itemId: 'x2', transform: move(5, 7) }])
    const after = await pdfjsText(out)
    for (const b of before) {
      const a = after.find((x) => x.str === b.str)!
      const d = b.str === 'Page level text' ? [0, 0] : [5, 7]
      near(a.x, b.x + d[0], 0.01)
      near(a.y, b.y + d[1], 0.01)
    }
  })

  it('moves inline images and shadings (with their clip)', async () => {
    const inline = await makeInlineImagePdf()
    const its = await listItems(inline)
    const out = await edit(inline, [{ itemId: its[0].id, transform: move(10, 20) }])
    const pj = await pdfjsImages(out)
    expect(pj.map((p) => p.transform)).toEqual(expect.arrayContaining([[100, 0, 0, 50, 82, 580]]))
    const sh = await pdfFromContent('q 300 300 150 80 re W n /Sh0 sh Q 0 0 1 rg 10 10 20 20 re f', async (doc, page) => {
      const ctx = doc.context
      const shading = ctx.obj({
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [300, 0, 450, 0],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }
      })
      page.node.Resources()!.set(PDFName.of('Shading'), ctx.obj({ Sh0: ctx.register(shading) }))
      return {}
    })
    const shItems = await listItems(sh)
    const shOut = await edit(sh, [{ itemId: shItems[0].id, transform: move(-100, 100) }])
    const outItems = await listItems(shOut)
    const s = outItems.find((i) => i.kind === 'shading')!
    expect(s.bounds).toEqual({ x: 200, y: 792 - 380 + 100, width: 150, height: 80 })
    expect(outItems.find((i) => i.kind === 'path')!.bounds).toEqual(shItems[1].bounds)
  })

  it('moves clipped images together with their clip', async () => {
    const bytes = await pdfFromContent('q 72 600 100 50 re W n 200 0 0 200 72 500 cm /Im0 Do Q', async (doc, page) => {
      const img = await doc.embedPng(makePng(2, 2))
      page.node.setXObject(PDFName.of('Im0'), img.ref)
      return {}
    })
    const [img] = await listItems(bytes)
    const out = await edit(bytes, [{ itemId: img.id, transform: move(200, 100) }])
    const [moved] = await listItems(out)
    expect(moved.bounds).toEqual({ x: 272, y: 792 - 650 + 100, width: 100, height: 50 })
  })

  it('re-applies ExtGStates (transparency) to moved items', async () => {
    const bytes = await pdfFromContent('q /GS0 gs 1 0 0 rg 72 600 100 50 re f Q', async (doc, page) => {
      page.node.setExtGState(PDFName.of('GS0'), doc.context.obj({ Type: 'ExtGState', ca: 0.5 }))
      return {}
    })
    const [rect] = await listItems(bytes)
    const out = await edit(bytes, [{ itemId: rect.id, transform: move(10, 10) }])
    const content = await pageContent(out, 0)
    const block = content.slice(content.lastIndexOf('\nq\n'))
    expect(block).toContain('/GS0 gs')
    expect(block).toContain('1 0 0 rg')
    const doc = await openWithPdfjs(out)
    try {
      const list = await (await doc.getPage(1)).getOperatorList()
      expect(list.fnArray.filter((f) => f === OPS.setGState).length).toBe(2)
    } finally {
      await closePdfjs(doc)
    }
  })
})

describe('re-typing, re-coloring and re-sizing text', () => {
  let mixed: Uint8Array
  let items: ContentItem[]
  let pjBefore: PdfjsTextItem[]
  beforeAll(async () => {
    registerTestFonts()
    mixed = await makeMixedPdf()
    items = await listItems(mixed)
    pjBefore = await pdfjsText(mixed)
  })

  const fontKeys = async (bytes: Uint8Array) => {
    const doc = await PDFDocument.load(bytes)
    const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    return fonts.keys().map((k) => k.decodeText())
  }

  it('re-encodes replacement text in the original font when possible', async () => {
    const title = byText(items, 'Quarterly Report')
    expect(title.editableInPlace).toBe(true)
    const out = await edit(mixed, [{ itemId: title.id, text: 'Annual Report 2026 – “final”' }])
    const p = (await pdfjsText(out)).find((a) => a.str === 'Annual Report 2026 – “final”')!
    expect(p).toBeDefined()
    near(p.x, title.origin!.x, 0.01)
    near(p.y, title.origin!.y, 0.01)
    expect(await fontKeys(out)).toEqual(await fontKeys(mixed)) // no new font
    const t = byText(await listItems(out), 'Annual Report 2026 – “final”')
    expect(t.fontName).toBe('Helvetica-Bold')
    expect(t.color).toBe(title.color)
    expect(t.fontSize).toBe(24)
    expectUnchanged(pjBefore, await pdfjsText(out), ['Quarterly Report'])
  })

  it('falls back to an embedded Unicode font for text the original font cannot encode', async () => {
    const t = byText(items, 'Third line')
    const lt = 'Ąžuolas ąčęėįšųūž'
    const out = await edit(mixed, [{ itemId: t.id, text: lt }])
    const p = (await pdfjsText(out)).find((a) => a.str === lt)!
    expect(p).toBeDefined()
    near(p.x, t.origin!.x, 0.01)
    near(p.y, t.origin!.y, 0.01)
    near(p.transform[0], 12, 0.001)
    const keys = await fontKeys(out)
    expect(keys.length).toBe((await fontKeys(mixed)).length + 1)
    const r = byText(await listItems(out), lt)
    expect(r.fontName).toMatch(/NotoSans-Regular/)
    expect(r.fontFamily).toBe('sans')
  })

  it('uses a fallback font matching the family and style (serif italic)', async () => {
    const t = byText(items, 'Italic serif words')
    const out = await edit(mixed, [{ itemId: t.id, text: 'Ąžuolai' }])
    const r = byText(await listItems(out), 'Ąžuolai')
    expect(r.fontName).toMatch(/NotoSerif-Italic/)
    expect(r.italic).toBe(true)
  })

  it('re-types text of a subset CID font (always the fallback font)', async () => {
    const t = byText(items, 'Ąžuolas čiulba vėjyje')
    const out = await edit(mixed, [{ itemId: t.id, text: 'Ąžuolėlis' }])
    const p = (await pdfjsText(out)).find((a) => a.str === 'Ąžuolėlis')!
    near(p.x, t.origin!.x, 0.01)
    near(p.y, t.origin!.y, 0.01)
    expect(byText(await listItems(out), 'Ąžuolėlis').color).toBe('#008000')
  })

  it('lays out multi-line replacement text downwards', async () => {
    const t = byText(items, 'First line of body text')
    const out = await edit(mixed, [{ itemId: t.id, text: 'Alpha\nBeta\nGamma' }])
    const pj = await pdfjsText(out)
    const [a, b, g] = ['Alpha', 'Beta', 'Gamma'].map((s) => pj.find((p) => p.str === s)!)
    for (const p of [a, b, g]) near(p.x, t.origin!.x, 0.01)
    near(a.y, t.origin!.y, 0.01)
    const lh = b.y - a.y
    expect(lh).toBeGreaterThanOrEqual(12 * 1.1)
    expect(lh).toBeLessThanOrEqual(12 * 1.5)
    near(g.y - b.y, lh, 0.01)
  })

  it('keeps the rotation of rotated text when re-typing', async () => {
    const t = byText(items, 'Rotated text')
    const out = await edit(mixed, [{ itemId: t.id, text: 'Turned' }])
    const p = (await pdfjsText(out)).find((a) => a.str === 'Turned')!
    expect(textAngle(p)).toBe(45)
    near(p.x, t.origin!.x, 0.01)
    near(p.y, t.origin!.y, 0.01)
  })

  it('changes the color of text', async () => {
    const t = byText(items, 'First line of body text')
    const out = await edit(mixed, [{ itemId: t.id, color: '#ff8800' }])
    const r = byText(await listItems(out), 'First line of body text')
    expect(r.color).toBe('#ff8800')
    expect(r.origin).toEqual(t.origin)
    expect(r.bounds).toEqual(t.bounds)
    expectUnchanged(pjBefore, await pdfjsText(out))
  })

  it('changes the font size around the origin', async () => {
    const t = byText(items, 'Second line of body text')
    const out = await edit(mixed, [{ itemId: t.id, fontSize: 18 }])
    const r = byText(await listItems(out), 'Second line of body text')
    expect(r.fontSize).toBe(18)
    expect(r.origin).toEqual(t.origin)
    near(r.bounds.width, (t.bounds.width * 18) / 12, 0.01)
    const p = (await pdfjsText(out)).find((a) => a.str === 'Second line of body text')!
    near(p.transform[0], 18, 0.001)
  })

  it('combines move, re-type, size and color in one edit', async () => {
    const t = byText(items, 'Apples')
    const out = await edit(mixed, [{ itemId: t.id, text: 'Plums', fontSize: 22, color: '#00aa00', transform: move(0, -300) }])
    const r = byText(await listItems(out), 'Plums')
    expect(r.fontSize).toBe(22)
    expect(r.color).toBe('#00aa00')
    near(r.origin!.x, t.origin!.x, 0.01)
    near(r.origin!.y, t.origin!.y - 300, 0.01)
  })

  it('removes text replaced by an empty string', async () => {
    const t = byText(items, 'Pears')
    const out = await edit(mixed, [{ itemId: t.id, text: '' }])
    expect((await pdfjsText(out)).map((p) => p.str)).not.toContain('Pears')
  })

  it('re-colors paths in place, keeping the stacking order', async () => {
    const [rect, , , line] = items.filter((i) => i.kind === 'path')
    const out = await edit(mixed, [
      { itemId: rect.id, color: '#123456' },
      { itemId: line.id, color: '#ff0000' }
    ])
    const outItems = await listItems(out)
    expect(outItems.map((i) => i.kind)).toEqual(items.map((i) => i.kind))
    const paths = outItems.filter((i) => i.kind === 'path')
    expect(paths[0].color).toBe('#123456')
    expect(paths[0].strokeColor).toBe('#000000')
    expect(paths[0].bounds).toEqual(rect.bounds)
    expect(paths[3].color).toBe('#ff0000') // stroke-only: the stroke is re-colored
    expect(paths[3].strokeColor).toBe('#ff0000')
    expect(paths.slice(1, 3).map((p) => p.color)).toEqual(['#0099ff', '#ff0080'])
  })
})

describe('editing items inside form XObjects', () => {
  let form: Uint8Array
  let before: PdfjsTextItem[]
  beforeAll(async () => {
    registerTestFonts()
    form = await makeFormWrappedPdf()
    before = await pdfjsText(form)
  })

  it('edits a private copy of the form and deletes the inner item', async () => {
    const out = await edit(form, [{ itemId: 'x2/t8', deleted: true }])
    const after = await pdfjsText(out)
    expect(after.map((a) => a.str)).not.toContain('Form body line')
    expectUnchanged(before, after, ['Form body line'])
    expect(await pdfjsImages(out)).toEqual(await pdfjsImages(form))
    const its = await listItems(out)
    // The Do keeps its operator index; fonts with clashing resource names stay distinct.
    expect(its.find((i) => i.id === 'x2/t3')?.text).toBe('Form title')
    expect(byText(its, 'Form title').fontName).toBe('Helvetica')
    expect(byText(its, 'Nested form text').fontName).toBe('Times-Roman')
    expect(byText(its, 'Page level text').fontName).toBe('Courier')
  })

  it('moves an inner image and re-types nested (2 levels) text', async () => {
    const out = await edit(form, [
      { itemId: 'x2/i15', transform: move(0, 100) },
      { itemId: 'x2/x17/t3', text: 'Changed nested' }
    ])
    const [img] = await pdfjsImages(out)
    expect(img.transform).toEqual([100, 0, 0, 80, 310, 480])
    const after = await pdfjsText(out)
    const nested = before.find((b) => b.str === 'Nested form text')!
    const changed = after.find((a) => a.str === 'Changed nested')!
    near(changed.x, nested.x, 0.01)
    near(changed.y, nested.y, 0.01)
    expectUnchanged(before, after, ['Nested form text'])
  })

  it('applies several inner edits and an edit of the form itself', async () => {
    const out = await edit(form, [
      { itemId: 'x2/t3', transform: move(0, 30) },
      { itemId: 'x2/x17/p7', deleted: true },
      { itemId: 'x2', transform: move(10, 0) }
    ])
    const after = await pdfjsText(out)
    const title = after.find((a) => a.str === 'Form title')!
    const t0 = before.find((b) => b.str === 'Form title')!
    // The title is redrawn inside the form copy, which itself is moved by the form's edit.
    near(title.x, t0.x + 10, 0.01)
    near(title.y, t0.y + 30, 0.01)
    const body = after.find((a) => a.str === 'Form body line')!
    near(body.x, before.find((b) => b.str === 'Form body line')!.x + 10, 0.01)
    const its = await listItems(out)
    expect(its.some((i) => i.kind === 'path' && i.color === '#00ff00')).toBe(false)
  })

  it('does not touch other pages that draw the same form XObject', async () => {
    const doc = await PDFDocument.load(form)
    const [copy] = await doc.copyPages(doc, [0])
    doc.addPage(copy)
    const two = await doc.save()
    const out = await edit(two, [{ itemId: 'x2/t3', deleted: true }], 0)
    expect((await pdfjsText(out, 1)).map((t) => t.str)).not.toContain('Form title')
    expect((await pdfjsText(out, 2)).map((t) => t.str)).toContain('Form title')
  })
})

describe('robustness of rewriting', () => {
  it('rewrites pages with garbage, unbalanced q/Q and a missing ET', async () => {
    const bytes = await makeGarbagePdf()
    const its = await listItems(bytes)
    const out = await edit(bytes, [{ itemId: byText(its, 'Still readable').id, transform: move(0, 100) }])
    const pj = await pdfjsText(out)
    near(pj.find((p) => p.str === 'Still readable')!.y, byText(its, 'Still readable').origin!.y + 100, 0.01)
    near(pj.find((p) => p.str === 'No ET at end')!.y, byText(its, 'No ET at end').origin!.y, 0.01)
    const outItems = await listItems(out)
    expect(outItems.filter((i) => i.kind === 'path').map((i) => [i.bounds, i.color])).toEqual(
      its.filter((i) => i.kind === 'path').map((i) => [i.bounds, i.color])
    )
    expect(byText(outItems, 'Still readable').color).toBe('#0000ff')
  })

  it('uses page space of rotated and cropped pages', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 600])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('Rotated page', { x: 50, y: 500, size: 12, font })
    page.setRotation(degrees(90))
    const rot = await doc.save()
    const [t] = await listItems(rot)
    expect(t.origin).toEqual({ x: 50, y: 100 })
    const out = await edit(rot, [{ itemId: t.id, transform: move(10, 20) }])
    const [p] = await pdfjsText(out)
    near(p.transform[4], 60, 0.01)
    near(p.transform[5], 480, 0.01)

    const cropped = await makeCroppedPdf()
    const [c] = await listItems(cropped)
    const out2 = await edit(cropped, [{ itemId: c.id, transform: move(10, 20) }])
    const [p2] = await pdfjsText(out2)
    near(p2.x, c.origin!.x + 10, 0.01)
    near(p2.y, c.origin!.y + 20, 0.01)
  })

  it('handles content drawn in a flipped (y-down) coordinate system', async () => {
    registerTestFonts()
    const bytes = await pdfFromContent('q 1 0 0 -1 0 792 cm BT /F1 12 Tf 1 0 0 -1 72 100 Tm (Flipped) Tj ET 0 0 1 rg 72 200 100 20 re f Q', async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    })
    const its = await listItems(bytes)
    const t = byText(its, 'Flipped')
    expect(t.origin).toEqual({ x: 72, y: 100 })
    expect(t.angle).toBe(0)
    near(t.bounds.y, 100 - 0.718 * 12, 0.01)
    expect(its[1].bounds).toEqual({ x: 72, y: 200, width: 100, height: 20 })
    const out = await edit(bytes, [{ itemId: t.id, text: 'Pakeistas tekstas ąę' }])
    const p = (await pdfjsText(out)).find((a) => a.str === 'Pakeistas tekstas ąę')!
    near(p.x, 72, 0.01)
    near(p.y, 100, 0.01)
    expect(textAngle(p)).toBe(0)
  })

  it('ignores unknown ids and no-op edits', async () => {
    const bytes = await makeMixedPdf()
    const before = await pageContent(bytes, 0)
    const out = await edit(bytes, [{ itemId: 'nope', deleted: true }, { itemId: 't6' }, { itemId: 't6', transform: [1, 0, 0, 1, 0, 0] }])
    expect(await pageContent(out, 0)).toBe(before)
  })

  it('is deterministic', async () => {
    const bytes = await makeTextOpsPdf()
    const edits: ContentEdit[] = [{ itemId: 't8.1', transform: move(5, 5) }, { itemId: 't3', deleted: true }]
    expect(await pageContent(await edit(bytes, edits), 0)).toBe(await pageContent(await edit(bytes, edits), 0))
  })

  it('applies edits to pages with resources shared with other pages without affecting them', async () => {
    registerTestFonts()
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p1 = doc.addPage([300, 300])
    p1.drawText('Shared one', { x: 20, y: 200, size: 12, font, color: rgb(0, 0, 0) })
    const p2 = doc.addPage([300, 300])
    p2.drawText('Shared two', { x: 20, y: 200, size: 12, font })
    // Make both pages use the same /Resources dict.
    const res = p1.node.get(PDFName.of('Resources'))!
    const ref = doc.context.register(doc.context.lookup(res)!)
    p1.node.set(PDFName.of('Resources'), ref)
    p2.node.set(PDFName.of('Resources'), ref)
    const bytes = await doc.save()
    const [t] = await listItems(bytes, 0)
    const out = await edit(bytes, [{ itemId: t.id, text: 'Ąčę' }], 0)
    expect((await pdfjsText(out, 1)).map((x) => x.str)).toEqual(['Ąčę'])
    expect((await pdfjsText(out, 2)).map((x) => x.str)).toEqual(['Shared two'])
    const loaded = await PDFDocument.load(out)
    const r2 = loaded.getPage(1).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    expect(r2.keys()).toHaveLength(1)
  })
})
