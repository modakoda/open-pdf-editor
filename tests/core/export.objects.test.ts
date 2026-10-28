import { beforeAll, describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib'
import fontkit, { type Font } from '@cantoo/fontkit'
import {
  NOTE_ICON_SIZE,
  addObject,
  exportDocument,
  fontMetrics,
  layoutText,
  openDocument,
  prepareText,
  rotatePages,
  updateSettings,
  type EditObject,
  type EditorDocument,
  type TextObject
} from '../../src/core'
import {
  A4,
  makeCropBoxPdf,
  makeRotatedPdf,
  makeTextPdf,
  makeUnbalancedGraphicsStatePdf
} from '../fixtures/pdfs'
import {
  OPS,
  TINY_JPEG,
  allPagesText,
  makePng,
  openWithPdfjs,
  closePdfjs,
  pageAnnotations,
  pageContent,
  pageTextItems,
  loadFontAssets,
  registerTestFonts,
  textAngle,
  type TextItem
} from './helpers'

beforeAll(() => registerTestFonts())

const W = A4[0]
const H = A4[1]

function textObj(pageId: string, extra: Partial<TextObject> = {}): TextObject {
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    pageId,
    type: 'text',
    x: 100,
    y: 200,
    width: 250,
    height: 60,
    text: 'Hello export',
    font: 'sans',
    bold: false,
    italic: false,
    fontSize: 16,
    color: '#112233',
    align: 'left',
    lineHeight: 1.2,
    rotation: 0,
    ...extra
  }
}

async function withObjects(bytes: Uint8Array, objects: (doc: EditorDocument) => EditObject[]): Promise<{ doc: EditorDocument; out: Uint8Array }> {
  let doc = await openDocument(bytes, 'x.pdf')
  for (const o of objects(doc)) doc = addObject(doc, o)
  return { doc, out: await exportDocument(doc) }
}

function find(items: TextItem[], str: string): TextItem {
  const item = items.find((i) => i.str === str)
  if (!item) throw new Error(`"${str}" not found in ${JSON.stringify(items.map((i) => i.str))}`)
  return item
}

/** Expected PDF-space origin of the first line of a text object on a page with visible box `vb`. */
function expectedOrigin(obj: TextObject, vb = { x: 0, y: 0, width: W, height: H }, lineIndex = 0) {
  const line = layoutText(obj).lines[lineIndex]
  const cx = vb.x + obj.x + obj.width / 2
  const cy = vb.y + vb.height - (obj.y + obj.height / 2)
  const lx = -obj.width / 2 + line.x
  const ly = obj.height / 2 - line.baseline
  const a = (-obj.rotation * Math.PI) / 180
  return { x: cx + lx * Math.cos(a) - ly * Math.sin(a), y: cy + lx * Math.sin(a) + ly * Math.cos(a) }
}

describe('export: text objects', () => {
  it('places text at the laid-out baseline', async () => {
    let obj!: TextObject
    const { out } = await withObjects(await makeTextPdf(1), (d) => [(obj = textObj(d.pages[0].id))])
    const item = find(await pageTextItems(out, 1), 'Hello export')
    const o = expectedOrigin(obj)
    expect(item.transform[0]).toBeCloseTo(16)
    expect(item.transform[4]).toBeCloseTo(o.x, 2)
    expect(item.transform[5]).toBeCloseTo(o.y, 2)
    expect(textAngle(item)).toBe(0)
  })

  it('places text in unrotated page space on rotated pages', async () => {
    const bytes = await makeRotatedPdf()
    const objs: TextObject[] = []
    let doc = await openDocument(bytes, 'r.pdf')
    doc = rotatePages(doc, [doc.pages[1].id], 90)
    doc.pages.forEach((p, i) => {
      const o = textObj(p.id, { text: `Object ${i}`, x: 60 + i * 10, y: 300 })
      objs.push(o)
      doc = addObject(doc, o)
    })
    const out = await exportDocument(doc)
    for (let i = 0; i < 4; i++) {
      const item = find(await pageTextItems(out, i + 1), `Object ${i}`)
      const o = expectedOrigin(objs[i])
      expect(item.transform[4]).toBeCloseTo(o.x, 2)
      expect(item.transform[5]).toBeCloseTo(o.y, 2)
      expect(textAngle(item)).toBe(0)
    }
  })

  it('offsets by the crop box', async () => {
    let obj!: TextObject
    const { out } = await withObjects(await makeCropBoxPdf(), (d) => [(obj = textObj(d.pages[0].id, { x: 10, y: 20 }))])
    const item = find(await pageTextItems(out, 1), 'Hello export')
    const o = expectedOrigin(obj, { x: 50, y: 100, width: 500, height: 600 })
    expect(item.transform[4]).toBeCloseTo(o.x, 2)
    expect(item.transform[5]).toBeCloseTo(o.y, 2)
    expect(item.transform[4]).toBeCloseTo(60, 2)
  })

  it('rotates text clockwise around the box center', async () => {
    const objs: TextObject[] = []
    const { out } = await withObjects(await makeTextPdf(1), (d) =>
      [90, 45, 180, 270, -30].map((rotation, i) => {
        const o = textObj(d.pages[0].id, { text: `Rot ${rotation}`, rotation, x: 150, y: 250 + i * 80 })
        objs.push(o)
        return o
      })
    )
    const items = await pageTextItems(out, 1)
    for (const o of objs) {
      const item = find(items, o.text)
      const exp = expectedOrigin(o)
      expect(item.transform[4]).toBeCloseTo(exp.x, 2)
      expect(item.transform[5]).toBeCloseTo(exp.y, 2)
      // Clockwise in page space = negative (counter-clockwise) angle in PDF space.
      expect(textAngle(item)).toBeCloseTo(((-o.rotation % 360) + 360) % 360, 3)
    }
    // 90° clockwise: the baseline runs downwards on the page.
    const r90 = find(items, 'Rot 90')
    expect(r90.transform[1]).toBeCloseTo(-16)
  })

  it('wraps lines and aligns text like layoutText', async () => {
    let obj!: TextObject
    const text = 'alpha beta gamma delta epsilon zeta eta theta'
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      (obj = textObj(d.pages[0].id, { text, width: 120, align: 'right' }))
    ])
    const layout = layoutText(obj)
    expect(layout.lines.length).toBeGreaterThan(2)
    const items = await pageTextItems(out, 1)
    layout.lines.forEach((line, i) => {
      const item = find(items, line.text)
      const o = expectedOrigin(obj, undefined, i)
      expect(item.transform[4]).toBeCloseTo(o.x, 2)
      expect(item.transform[5]).toBeCloseTo(o.y, 2)
    })
    // Right edge of each line (as measured by pdf.js from the PDF's font) hits the box edge.
    const pdfjsDoc = await openWithPdfjs(out)
    const tc = await (await pdfjsDoc.getPage(1)).getTextContent()
    for (const line of layout.lines) {
      const it = (tc.items as Array<{ str: string; width: number; transform: number[] }>).find((i) => i.str === line.text)!
      expect(it.transform[4] + it.width).toBeCloseTo(obj.x + obj.width, 1)
    }
    await closePdfjs(pdfjsDoc)
  })

  it('round-trips Lithuanian (and other Unicode) text through text extraction', async () => {
    const texts = ['Ąčęėįšųūž', 'ĄČĘĖĮŠŲŪŽ ąčęėįšųūž', 'Привет, κόσμε']
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      textObj(d.pages[0].id, { text: texts[0], y: 100 }),
      textObj(d.pages[0].id, { text: texts[1], y: 200, font: 'serif', bold: true, width: 400 }),
      textObj(d.pages[0].id, { text: texts[2], y: 300, font: 'mono', italic: true, width: 400 })
    ])
    const strs = (await pageTextItems(out, 1)).map((i) => i.str)
    for (const t of texts) expect(strs).toContain(t)
    const reloaded = await PDFDocument.load(out)
    const fonts = reloaded.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    const subtypes = fonts.keys().map((k) => (fonts.lookup(k, PDFDict).lookup(PDFName.of('Subtype')) as PDFName).asString())
    expect(subtypes).toContain('/Type0')
  })

  it('embeds font subsets whose glyph outlines match the original font', async () => {
    // Text extraction only checks ToUnicode maps; this checks the glyphs a viewer actually draws.
    const text = 'Hello ąčęėįšųūž — Привет κόσμε'
    const { out } = await withObjects(await makeTextPdf(1), (d) => [textObj(d.pages[0].id, { text, width: 500 })])
    const original = fontkit.create(loadFontAssets()['sans-regular']!) as Font
    const reloaded = await PDFDocument.load(out)
    const fonts = reloaded.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    const type0 = fonts
      .keys()
      .map((k) => fonts.lookup(k, PDFDict))
      .find((f) => f.lookup(PDFName.of('Subtype')) === PDFName.of('Type0'))!
    const descendant = type0.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict)
    const fontFile = descendant
      .lookup(PDFName.of('FontDescriptor'), PDFDict)
      .lookup(PDFName.of('FontFile2')) as PDFRawStream
    const subset = fontkit.create(decodePDFRawStream(fontFile).decode()) as Font
    const toUnicode = new TextDecoder().decode(
      decodePDFRawStream(type0.lookup(PDFName.of('ToUnicode')) as PDFRawStream).decode()
    )
    const mapped = new Map<number, number>()
    for (const [, cid, uni] of toUnicode.matchAll(/<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4,8})>/g)) {
      mapped.set(parseInt(cid, 16), parseInt(uni, 16))
    }
    const expected = new Set([...text].map((c) => c.codePointAt(0)!).filter((cp) => cp !== 0x20))
    for (const cp of expected) expect([...mapped.values()]).toContain(cp)
    for (const [cid, cp] of mapped) {
      if (cp === 0x20) continue
      const want = original.glyphForCodePoint(cp)!.path.toSVG()
      expect(want.length).toBeGreaterThan(0)
      expect(subset.getGlyph(cid)!.path.toSVG(), `glyph for U+${cp.toString(16)}`).toBe(want)
    }
  })

  it('uses standard fonts (not embedded) for WinAnsi text', async () => {
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      textObj(d.pages[0].id, { text: 'Plain € “text” Žž', font: 'serif', italic: true })
    ])
    expect((await pageTextItems(out, 1)).map((i) => i.str)).toContain('Plain € “text” Žž')
    const content = await pageContent(out, 0)
    expect(content).toMatch(/Tf/)
    const reloaded = await PDFDocument.load(out)
    const fonts = reloaded.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    const baseFonts = fonts.keys().map((k) => (fonts.lookup(k, PDFDict).lookup(PDFName.of('BaseFont')) as PDFName).asString())
    expect(baseFonts).toContain('/Times-Italic')
  })

  it('draws an opaque background and honours opacity', async () => {
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      textObj(d.pages[0].id, { background: '#ffffff', opacity: 0.5 })
    ])
    const content = await pageContent(out, 0)
    expect(content).toMatch(/1 1 1 rg/)
    const gs = extGStates(await PDFDocument.load(out), 0)
    expect(gs.some((g) => g.ca === 0.5)).toBe(true)
  })

  it('is not displaced by an unbalanced graphics state in the original content', async () => {
    let obj!: TextObject
    const { out } = await withObjects(await makeUnbalancedGraphicsStatePdf(), (d) => [(obj = textObj(d.pages[0].id))])
    const item = find(await pageTextItems(out, 1), 'Hello export')
    const o = expectedOrigin(obj)
    expect(item.transform[0]).toBeCloseTo(16)
    expect(item.transform[4]).toBeCloseTo(o.x, 2)
    expect(item.transform[5]).toBeCloseTo(o.y, 2)
  })
})

function extGStates(doc: PDFDocument, pageIndex: number): Array<{ ca?: number; CA?: number; BM?: string }> {
  const res = doc.getPage(pageIndex).node.Resources()!
  const gsDict = res.lookupMaybe(PDFName.of('ExtGState'), PDFDict)
  if (!gsDict) return []
  return gsDict.keys().map((k) => {
    const g = gsDict.lookup(k, PDFDict)
    const num = (n: string) => (g.lookup(PDFName.of(n)) as PDFNumber | undefined)?.asNumber()
    const bm = g.lookup(PDFName.of('BM'))
    return { ca: num('ca'), CA: num('CA'), BM: bm instanceof PDFName ? bm.decodeText() : undefined }
  })
}

/** CTMs in effect when images are painted (pdf.js operator list). */
async function imageTransforms(bytes: Uint8Array, pageNumber: number): Promise<number[][]> {
  const doc = await openWithPdfjs(bytes)
  try {
    const page = await doc.getPage(pageNumber)
    const list = await page.getOperatorList()
    const result: number[][] = []
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    const mul = (m: number[], n: number[]) => [
      m[0] * n[0] + m[1] * n[2],
      m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2],
      m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4],
      m[4] * n[1] + m[5] * n[3] + n[5]
    ]
    list.fnArray.forEach((fn: number, i: number) => {
      const args = list.argsArray[i] as unknown[]
      if (fn === OPS.save) stack.push(ctm)
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      else if (fn === OPS.transform) {
        const m = (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]) ? Array.from(args[0] as number[]) : (args as number[])).slice(0, 6)
        ctm = mul(m, ctm)
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) result.push(ctm)
    })
    return result
  } finally {
    await closePdfjs(doc)
  }
}

describe('export: images', () => {
  it('draws PNG images in the box', async () => {
    const png = makePng(4, 2, [0, 128, 255])
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      { id: 'img', pageId: d.pages[0].id, type: 'image', x: 50, y: 60, width: 200, height: 100, data: png, mimeType: 'image/png', rotation: 0 }
    ])
    const [ctm] = await imageTransforms(out, 1)
    expect(ctm).toBeDefined()
    // Unit square → box: [w 0 0 h x y] in PDF space.
    expect(ctm[0]).toBeCloseTo(200)
    expect(ctm[3]).toBeCloseTo(100)
    expect(ctm[4]).toBeCloseTo(50)
    expect(ctm[5]).toBeCloseTo(H - 60 - 100)
  })

  it('rotates images around their center and supports JPEG', async () => {
    const png = makePng(2, 2)
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      { id: 'img', pageId: d.pages[0].id, type: 'image', x: 50, y: 60, width: 200, height: 100, data: png, mimeType: 'image/png', rotation: 90 },
      { id: 'jpg', pageId: d.pages[0].id, type: 'image', x: 300, y: 400, width: 50, height: 50, data: TINY_JPEG, mimeType: 'image/jpeg', rotation: 0 }
    ])
    const [ctm] = await imageTransforms(out, 1)
    const center = { x: ctm[0] * 0.5 + ctm[2] * 0.5 + ctm[4], y: ctm[1] * 0.5 + ctm[3] * 0.5 + ctm[5] }
    expect(center.x).toBeCloseTo(150)
    expect(center.y).toBeCloseTo(H - 110)
    // The image's x axis points down the page after a 90° clockwise rotation.
    expect(ctm[0]).toBeCloseTo(0)
    expect(ctm[1]).toBeCloseTo(-200)

    const reloaded = await PDFDocument.load(out)
    const xobjects = reloaded.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const filters = xobjects.keys().map((k) => {
      const s = reloaded.context.lookup(xobjects.get(k)) as PDFRawStream
      return String(s.dict.lookup(PDFName.of('Filter')))
    })
    expect(filters).toContain('/DCTDecode')
  })

  it('skips a corrupt image instead of failing the export', async () => {
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      { id: 'bad', pageId: d.pages[0].id, type: 'image', x: 0, y: 0, width: 10, height: 10, data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', rotation: 0 },
      textObj(d.pages[0].id, { text: 'still here' })
    ])
    expect((await allPagesText(out))[0]).toContain('still here')
  })
})

describe('export: vector objects', () => {
  it('draws rectangles, ellipses, highlights, whiteout, lines, arrows and ink', async () => {
    const { out } = await withObjects(await makeTextPdf(1), (d) => {
      const pageId = d.pages[0].id
      return [
        { id: 'r', pageId, type: 'rect', x: 10, y: 10, width: 100, height: 50, strokeColor: '#ff0000', fillColor: '#00ff00', strokeWidth: 2, rotation: 30 },
        { id: 'e', pageId, type: 'ellipse', x: 200, y: 10, width: 80, height: 40, strokeColor: '#0000ff', fillColor: null, strokeWidth: 1, rotation: 0 },
        { id: 'h', pageId, type: 'highlight', x: 70, y: 60, width: 150, height: 20, color: '#ffff00' },
        { id: 'w', pageId, type: 'whiteout', x: 300, y: 300, width: 40, height: 40, color: '#ffffff' },
        { id: 'l', pageId, type: 'line', x1: 100, y1: 500, x2: 300, y2: 500, color: '#123456', strokeWidth: 3, arrowEnd: true },
        { id: 'i', pageId, type: 'ink', paths: [[{ x: 10, y: 700 }, { x: 20, y: 710 }, { x: 30, y: 705 }], [{ x: 50, y: 50 }]], color: '#000000', strokeWidth: 4 }
      ] as EditObject[]
    })
    const c = await pageContent(out, 0)
    // rect: fill + stroke, rotated frame (cos 30°)
    expect(c).toMatch(/1 0 0 RG/)
    expect(c).toMatch(/0 1 0 rg/)
    const cm = /^(\S+) (\S+) (\S+) (\S+) 60 806\.89 cm$/m.exec(c)
    expect(cm).toBeTruthy()
    const [a, b, cc, dd] = cm!.slice(1, 5).map(Number)
    expect(a).toBeCloseTo(Math.cos(Math.PI / 6), 9)
    expect(b).toBeCloseTo(-0.5, 9)
    expect(cc).toBeCloseTo(0.5, 9)
    expect(dd).toBeCloseTo(Math.cos(Math.PI / 6), 9)
    // ellipse uses Bézier curves
    expect(c).toMatch(/ c\n/)
    // whiteout
    expect(c).toMatch(/1 1 1 rg/)
    // line: shaft ends at the arrow base, head is a filled triangle with its tip at (300, H-500)
    expect(c).toMatch(/100 341\.89 m\s+288 341\.89 l\s+S/)
    expect(c).toMatch(/300 341\.89 m\s+288 (335|347)\.89 l\s+288 (347|335)\.89 l\s+h\s+f/)
    // ink: round caps and joins, page space → PDF space
    expect(c).toMatch(/1 J/)
    expect(c).toMatch(/1 j/)
    expect(c).toMatch(/10 141\.89 m\s+20 131\.89 l\s+30 136\.89 l/)
    // highlight: Multiply blend, default opacity 0.4
    const gs = extGStates(await PDFDocument.load(out), 0)
    expect(gs).toContainEqual({ ca: 0.4, CA: undefined, BM: 'Multiply' })
  })

  it('draws objects in z-order', async () => {
    const { out } = await withObjects(await makeTextPdf(1), (d) => [
      { id: 'w', pageId: d.pages[0].id, type: 'whiteout', x: 0, y: 0, width: 10, height: 10, color: '#abcdef' },
      textObj(d.pages[0].id, { text: 'on top' })
    ])
    const c = await pageContent(out, 0)
    expect(c.indexOf('0.6705882')).toBeGreaterThan(-1)
    expect(c.indexOf('0.6705882')).toBeLessThan(c.lastIndexOf('Tj'))
  })
})

describe('export: notes', () => {
  it('creates a real /Text annotation', async () => {
    const { out } = await withObjects(await makeCropBoxPdf(), (d) => [
      { id: 'n1', pageId: d.pages[0].id, type: 'note', x: 100, y: 50, text: 'Please review ąčę', color: '#ff0000', author: 'Modestas' }
    ])
    const annots = await pageAnnotations(out, 1)
    const note = annots.find((a) => a.subtype === 'Text')!
    expect(note).toBeTruthy()
    expect(note.contentsObj.str).toBe('Please review ąčę')
    expect(note.titleObj.str).toBe('Modestas')
    expect(Array.from(note.color as Uint8ClampedArray)).toEqual([255, 0, 0])
    // Top-left of the icon at the note position (crop box origin 50,100; height 600).
    expect(note.rect[0]).toBeCloseTo(150)
    expect(note.rect[3]).toBeCloseTo(650)
    expect(note.rect[2] - note.rect[0]).toBeCloseTo(NOTE_ICON_SIZE)
  })
})

describe('export: watermark and page numbers', () => {
  it('puts the watermark on every page, oriented for the reader', async () => {
    let doc = await openDocument(await makeRotatedPdf(), 'r.pdf')
    doc = updateSettings(doc, { watermark: { text: 'CONFIDENTIAL', fontSize: 40, color: '#ff0000', opacity: 0.3, angle: 45 } })
    const out = await exportDocument(doc)
    for (let i = 0; i < 4; i++) {
      const item = find(await pageTextItems(out, i + 1), 'CONFIDENTIAL')
      expect(textAngle(item)).toBeCloseTo((45 + i * 90) % 360, 3)
    }
    const gs = extGStates(await PDFDocument.load(out), 0)
    expect(gs.some((g) => Math.abs((g.ca ?? 1) - 0.3) < 1e-6)).toBe(true)
  })

  it('centers a horizontal watermark and supports Unicode text', async () => {
    let doc = await openDocument(await makeTextPdf(2), 't.pdf')
    doc = updateSettings(doc, { watermark: { text: 'KONFIDENCIALU ąčę', fontSize: 30, color: '#000000', opacity: 0.5, angle: 0 } })
    const out = await exportDocument(doc)
    for (const n of [1, 2]) {
      const pdfjsDoc = await openWithPdfjs(out)
      const tc = await (await pdfjsDoc.getPage(n)).getTextContent()
      const it = (tc.items as Array<{ str: string; width: number; transform: number[] }>).find((i) => i.str === 'KONFIDENCIALU ąčę')!
      expect(it).toBeTruthy()
      expect(it.transform[4] + it.width / 2).toBeCloseTo(W / 2, 0)
      expect(Math.abs(it.transform[5] - H / 2)).toBeLessThan(30)
      await closePdfjs(pdfjsDoc)
    }
  })

  it('numbers every page with the format and start value', async () => {
    let doc = await openDocument(await makeTextPdf(3), 't.pdf')
    doc = updateSettings(doc, {
      pageNumbers: { format: 'Page {n} of {total}', position: 'bottom-center', fontSize: 10, color: '#000000', startAt: 1, margin: 24 }
    })
    const out = await exportDocument(doc)
    const style = { font: 'sans' as const, bold: false, italic: false }
    const { descent } = fontMetrics(prepareText('x', style).font)
    for (let n = 1; n <= 3; n++) {
      const pdfjsDoc = await openWithPdfjs(out)
      const tc = await (await pdfjsDoc.getPage(n)).getTextContent()
      const it = (tc.items as Array<{ str: string; width: number; transform: number[] }>).find((i) => i.str === `Page ${n} of 3`)!
      expect(it).toBeTruthy()
      expect(it.transform[4] + it.width / 2).toBeCloseTo(W / 2, 1)
      expect(it.transform[5]).toBeCloseTo(24 + descent * 10, 2)
      await closePdfjs(pdfjsDoc)
    }
  })

  it('places page numbers as the reader sees rotated pages', async () => {
    let doc = await openDocument(await makeRotatedPdf(), 'r.pdf')
    doc = updateSettings(doc, {
      pageNumbers: { format: '{n}', position: 'top-right', fontSize: 12, color: '#333333', startAt: 5, margin: 30 }
    })
    const out = await exportDocument(doc)
    const { ascent } = fontMetrics(prepareText('5', { font: 'sans', bold: false, italic: false }).font)
    const asc = ascent * 12
    const pdfjsDoc = await openWithPdfjs(out)
    const expectations = [
      // rotation 0: top-right corner of the page
      (e: number, f: number, w: number) => {
        expect(e + w).toBeCloseTo(W - 30, 1)
        expect(f).toBeCloseTo(H - 30 - asc, 1)
      },
      // rotation 90: the reader's top edge is the page's left edge, the reader's right is the page's top
      (e: number, f: number, w: number) => {
        expect(e).toBeCloseTo(30 + asc, 1)
        expect(f + w).toBeCloseTo(H - 30, 1)
      },
      // rotation 180: reader's top-right is the page's bottom-left
      (e: number, f: number, w: number) => {
        expect(e - w).toBeCloseTo(30, 1)
        expect(f).toBeCloseTo(30 + asc, 1)
      },
      // rotation 270: reader's top is the page's right edge, reader's right is the page's bottom
      (e: number, f: number, w: number) => {
        expect(e).toBeCloseTo(W - 30 - asc, 1)
        expect(f - w).toBeCloseTo(30, 1)
      }
    ]
    for (let n = 1; n <= 4; n++) {
      const tc = await (await pdfjsDoc.getPage(n)).getTextContent()
      const it = (tc.items as Array<{ str: string; width: number; transform: number[] }>).find((i) => i.str === `${n + 4}`)!
      expect(it, `page ${n}`).toBeTruthy()
      expect(textAngle(it)).toBeCloseTo(((n - 1) * 90) % 360, 3)
      expectations[n - 1](it.transform[4], it.transform[5], it.width)
    }
    await closePdfjs(pdfjsDoc)
  })
})
