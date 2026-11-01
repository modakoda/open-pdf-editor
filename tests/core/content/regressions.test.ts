/**
 * Regression tests for review findings: form XObject edits via private copies (transparency
 * groups, pattern space, structure), consecutive binary inline images, ExtGState / pattern
 * coordinate spaces of redrawn items, optional content, predefined CJK CMaps, zero /Widths.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, StandardFonts, decodePDFRawStream } from '@cantoo/pdf-lib'
import { applyContentEdits, listContentItems, setCMapLoader } from '../../../src/core/content'
import { parseContent } from '../../../src/core/content/lexer'
import { readPageContent } from '../../../src/core/content/page'
import { visibleBox } from '../../../src/core/pdf'
import type { ContentEdit } from '../../../src/core/model'
import { OPS, closePdfjs, makePng, openWithPdfjs, pageContent } from '../helpers'
import { addStdFont, edit, latin1, listItems, pdfFromContent, pdfjsImages, pdfjsText, testHelpers } from './helpers'

const near = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol)

async function opCounts(bytes: Uint8Array): Promise<Map<number, number>> {
  const doc = await openWithPdfjs(bytes)
  try {
    const list = await (await doc.getPage(1)).getOperatorList()
    const m = new Map<number, number>()
    for (const f of list.fnArray) m.set(f, (m.get(f) ?? 0) + 1)
    return m
  } finally {
    await closePdfjs(doc)
  }
}

/** The page's XObject resources, resolved. */
async function xobjects(bytes: Uint8Array): Promise<Map<string, PDFStream>> {
  const doc = await PDFDocument.load(bytes)
  const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
  const out = new Map<string, PDFStream>()
  for (const [k, v] of xo.entries()) out.set(k.decodeText(), doc.context.lookup(v) as PDFStream)
  return out
}

function streamText(s: PDFStream): string {
  return new TextDecoder('latin1').decode(decodePDFRawStream(s as PDFRawStream).decode())
}

/** A transparency-group form drawn at 50% opacity: two overlapping squares and a text. */
async function groupFormPdf(): Promise<Uint8Array> {
  return pdfFromContent('/GS1 gs 1 0 0 1 100 400 cm /Fm1 Do', async (doc, page) => {
    const ctx = doc.context
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    const form = ctx.stream(
      latin1(
        '/P <</MCID 0>> BDC 1 0 0 rg 0 0 200 200 re f EMC 0 0 1 rg 100 100 200 200 re f BT /F1 24 Tf 10 250 Td (Hello group) Tj ET'
      ),
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 300, 300],
        Group: { S: 'Transparency', I: true, K: false },
        Resources: { Font: { F1: helv.ref } }
      } as never
    )
    page.node.set(
      PDFName.of('Resources'),
      ctx.obj({ XObject: { Fm1: ctx.register(form) }, ExtGState: { GS1: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } } }) as never
    )
    return {}
  })
}

describe('editing items inside form XObjects uses a private copy of the form', () => {
  it('keeps the transparency group, structure and the original form', async () => {
    const bytes = await groupFormPdf()
    const items = await listItems(bytes)
    const text = items.find((i) => i.text === 'Hello group')!
    expect(text.id).toBe('x2/t11')
    const out = await edit(bytes, [{ itemId: text.id, color: '#00aa00' }])
    const xos = await xobjects(out)
    expect([...xos.keys()].sort()).toEqual(['Fm1', 'Fm1_e'])
    const copy = xos.get('Fm1_e')!
    expect(copy.dict.lookup(PDFName.of('Group'), PDFDict).lookup(PDFName.of('S'))).toBe(PDFName.of('Transparency'))
    // The page content only changed the Do operand; the structure stays inside the form.
    const page = await pageContent(out, 0)
    expect(page).toBe('/GS1 gs 1 0 0 1 100 400 cm \n/Fm1_e Do\n')
    expect(streamText(copy)).toContain('/P <</MCID 0>> BDC')
    // The original form is untouched.
    expect(streamText(xos.get('Fm1')!)).toBe(streamText((await xobjects(bytes)).get('Fm1')!))
    // pdf.js still composites the content as one group.
    const counts = await opCounts(out)
    expect(counts.get(OPS.beginGroup)).toBe(1)
    expect(counts.get(OPS.paintFormXObjectBegin)).toBe(1)
    const after = await listItems(out)
    expect(after.find((i) => i.text === 'Hello group')!.color).toBe('#00aa00')
    expect(after.filter((i) => i.kind === 'path').map((p) => p.color)).toEqual(['#ff0000', '#0000ff'])
  })

  it('keeps patterns anchored to the form space', async () => {
    const bytes = await pdfFromContent('q 1 0 0 1 200 300 cm /Fm1 Do Q', async (doc, page) => {
      const ctx = doc.context
      const helv = await doc.embedFont(StandardFonts.Helvetica)
      const shading = ctx.obj({
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [0, 0, 200, 0],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }
      })
      const pattern = ctx.register(ctx.obj({ Type: 'Pattern', PatternType: 2, Shading: shading }))
      const form = ctx.stream(latin1('/Pattern cs /P0 scn 0 0 200 100 re f 0 g BT /F1 12 Tf 0 110 Td (Caption) Tj ET'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 220, 140],
        Resources: { Font: { F1: helv.ref }, Pattern: { P0: pattern } }
      } as never)
      page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm1: ctx.register(form) } }) as never)
      return {}
    })
    const caption = (await listItems(bytes)).find((i) => i.text === 'Caption')!
    const out = await edit(bytes, [{ itemId: caption.id, deleted: true }])
    expect((await pdfjsText(out)).map((t) => t.str)).toEqual([])
    const copy = (await xobjects(out)).get('Fm1_e')!
    expect(streamText(copy)).toContain('/Pattern cs /P0 scn 0 0 200 100 re f')
    const orig = (await xobjects(bytes)).get('Fm1')!
    expect(String(copy.dict.get(PDFName.of('Resources')))).toBe(String(orig.dict.get(PDFName.of('Resources'))))
  })

  it('lets a moved inner item leave a small form box (box enlarged, content still clipped)', async () => {
    const bytes = await pdfFromContent('/Fm1 Do', async (doc, page) => {
      const ctx = doc.context
      const helv = await doc.embedFont(StandardFonts.Helvetica)
      const form = ctx.stream(latin1('BT /F1 12 Tf 10 50 Td (Small) Tj ET 0 0 1 rg 0 0 100 20 re f'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Matrix: [1, 0, 0, 1, 72, 600],
        Resources: { Font: { F1: helv.ref } }
      } as never)
      page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm1: ctx.register(form) } }) as never)
      return {}
    })
    const small = (await listItems(bytes)).find((i) => i.text === 'Small')!
    const out = await edit(bytes, [{ itemId: small.id, transform: [1, 0, 0, 1, 300, 0] }])
    const copy = (await xobjects(out)).get('Fm1_e')!
    const bbox = (copy.dict.lookup(PDFName.of('BBox'), PDFArray)).asArray().map((n) => Number(n.toString()))
    expect(bbox).toEqual([-72, -600, 540, 192])
    const content = streamText(copy)
    expect(content.startsWith('q\n0 0 100 100 re W n\n')).toBe(true)
    const [p] = await pdfjsText(out)
    near(p.x, small.origin!.x + 300)
    near(p.y, small.origin!.y)
    // The moved text is clipped by the original box moved with it (form space).
    expect(content).toMatch(/300 0 m\n400 0 l\n400 100 l\n300 100 l\nh\nW n\n1 0 0 1 300 0 cm/)
  })
})

describe('consecutive inline images with binary data', () => {
  it('ends each image at its exactly located EI', async () => {
    const img = (x: number) =>
      `q 8 0 0 8 ${x} 700 cm BI /W 8 /H 8 /IM true ID ` + String.fromCharCode(0xff, 0x81, 0xbd, 0xa5, 0xa5, 0xbd, 0x81, 0xff) + ' EI Q\n'
    let content = ''
    for (let i = 0; i < 4; i++) content += img(100 + i * 20)
    content += 'BT /F1 12 Tf 100 650 Td (After images) Tj ET'
    expect(parseContent(latin1(content)).map((o) => o.op).join(' ')).toBe('q cm BI Q q cm BI Q q cm BI Q q cm BI Q BT Tf Td Tj ET')
    const bytes = await pdfFromContent(content, async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    })
    const items = await listItems(bytes)
    expect(items.map((i) => i.kind)).toEqual(['image', 'image', 'image', 'image', 'text'])
    expect((await pdfjsImages(bytes)).length).toBe(4)
  })
})

describe('coordinate spaces of redrawn items', () => {
  it('applies ExtGStates (soft masks) in the space they were set in, moved with the item', async () => {
    const bytes = await pdfFromContent('q /GS1 gs q 300 0 0 200 100 400 cm /Im1 Do Q Q', async (doc, page) => {
      const ctx = doc.context
      const png = await doc.embedPng(makePng(4, 4, [255, 0, 0]))
      const mask = ctx.register(
        ctx.stream(latin1('0 g 0 0 612 792 re f 1 g 200 450 100 100 re f'), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 612, 792],
          Group: { S: 'Transparency', CS: 'DeviceGray' }
        } as never)
      )
      page.node.set(
        PDFName.of('Resources'),
        ctx.obj({ XObject: { Im1: png.ref }, ExtGState: { GS1: { Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: mask } } } }) as never
      )
      return {}
    })
    const [img] = await listItems(bytes)
    const out = await edit(bytes, [{ itemId: img.id, transform: [1, 0, 0, 1, 20, 0] }])
    const content = await pageContent(out, 0)
    const block = content.slice(content.lastIndexOf('\nq\n'))
    // gs is applied with the (moved) page CTM, then the image's own CTM follows.
    expect(block).toMatch(/q\n1 0 0 1 20 0 cm\n\/GS1 gs\n300 0 0 200 100 400 cm\n/)
    const [p] = await pdfjsImages(out)
    expect(p.transform).toEqual([300, 0, 0, 200, 120, 400])
  })

  it('moves pattern fills with the item (re-anchored pattern copy)', async () => {
    const bytes = await pdfFromContent('/Pattern cs /P0 scn 100 300 200 100 re f', async (doc, page) => {
      const ctx = doc.context
      const shading = ctx.obj({
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [100, 0, 300, 0],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }
      })
      page.node.set(
        PDFName.of('Resources'),
        ctx.obj({ Pattern: { P0: ctx.register(ctx.obj({ Type: 'Pattern', PatternType: 2, Shading: shading, Matrix: [1, 0, 0, 1, 0, 5] })) } }) as never
      )
      return {}
    })
    const [rect] = await listItems(bytes)
    const out = await edit(bytes, [{ itemId: rect.id, transform: [1, 0, 0, 1, 250, -10] }])
    const doc = await PDFDocument.load(out)
    const patterns = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Pattern'), PDFDict)
    expect(patterns.keys().map((k) => k.decodeText()).sort()).toEqual(['P0', 'P0_m'])
    const moved = patterns.lookup(PDFName.of('P0_m'), PDFDict)
    expect(moved.lookup(PDFName.of('Matrix'), PDFArray).asArray().map((n) => Number(n.toString()))).toEqual([1, 0, 0, 1, 250, 15])
    const original = patterns.lookup(PDFName.of('P0'), PDFDict)
    expect(original.lookup(PDFName.of('Matrix'), PDFArray).asArray().map((n) => Number(n.toString()))).toEqual([1, 0, 0, 1, 0, 5])
    expect(await pageContent(out, 0)).toContain('/Pattern cs\n/P0_m scn')
  })
})

describe('optional content', () => {
  async function ocPdf(options: { baseOff?: boolean; ocmd?: 'AllOn' | 'AnyOn' } = {}) {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
    const ctx = doc.context
    const on = ctx.register(ctx.obj({ Type: 'OCG', Name: ctx.obj('Shown' as never) }))
    const off = ctx.register(ctx.obj({ Type: 'OCG', Name: ctx.obj('Draft' as never) }))
    const props: Record<string, unknown> = { ocOn: on, ocOff: off }
    if (options.ocmd) props.ocMd = ctx.obj({ Type: 'OCMD', OCGs: [on, off], P: options.ocmd })
    page.node.Resources()!.set(PDFName.of('Properties'), ctx.obj(props as never))
    const img = ctx.stream(new Uint8Array([0, 255, 255, 0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
      OC: off
    } as never)
    page.node.setXObject(PDFName.of('ImOff'), ctx.register(img))
    const D = options.baseOff ? { BaseState: 'OFF', ON: [on] } : { OFF: [off] }
    doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [on, off], D } as never))
    const content = [
      'BT /F1 12 Tf 72 700 Td (Always) Tj ET',
      '/OC /ocOn BDC 0 0 1 rg 72 600 100 40 re f BT /F1 12 Tf 72 580 Td (Shown layer) Tj ET EMC',
      '/OC /ocOff BDC 1 0 0 rg 300 600 100 40 re f BT /F1 12 Tf 300 580 Td (Draft layer) Tj ET EMC',
      options.ocmd ? '/OC /ocMd BDC BT /F1 12 Tf 72 500 Td (Membership) Tj ET EMC' : '',
      'q 50 0 0 50 400 400 cm /ImOff Do Q'
    ].join('\n')
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(latin1(content))))
    return doc.save()
  }

  it('does not list items of layers hidden in the default configuration', async () => {
    const items = await listItems(await ocPdf())
    expect(items.map((i) => i.text ?? i.kind)).toEqual(['Always', 'path', 'Shown layer'])
    const base = await listItems(await ocPdf({ baseOff: true }))
    expect(base.map((i) => i.text ?? i.kind)).toEqual(['Always', 'path', 'Shown layer'])
    expect((await listItems(await ocPdf({ ocmd: 'AnyOn' }))).some((i) => i.text === 'Membership')).toBe(true)
    expect((await listItems(await ocPdf({ ocmd: 'AllOn' }))).some((i) => i.text === 'Membership')).toBe(false)
  })

  it('keeps redrawn items in their layer', async () => {
    const bytes = await ocPdf()
    const items = await listItems(bytes)
    const shown = items.find((i) => i.text === 'Shown layer')!
    const rect = items.find((i) => i.kind === 'path')!
    const edits: ContentEdit[] = [
      { itemId: shown.id, color: '#00ff00' },
      { itemId: rect.id, transform: [1, 0, 0, 1, 0, 50] }
    ]
    const out = await edit(bytes, edits)
    const content = await pageContent(out, 0)
    // Both are redrawn in place, inside their layer's section.
    const start = content.indexOf('/OC /ocOn BDC')
    const layer = content.slice(start, content.indexOf('EMC', start))
    expect(layer).toContain('1 0 0 1 0 -50 cm')
    expect(layer).toContain('0 1 0 rg\nBT')
    expect(content.match(/\bBDC\b/g)?.length).toBe(content.match(/\bEMC\b/g)?.length)
    // The hidden layer is still hidden and its content untouched.
    expect(content).toContain('/OC /ocOff BDC 1 0 0 rg 300 600 100 40 re f BT /F1 12 Tf 300 580 Td (Draft layer) Tj ET EMC')
    const after = await listItems(out)
    expect(after.map((i) => i.text ?? i.kind)).toEqual(['Always', 'path', 'Shown layer'])
  })

  it('keeps blocks drawn at the end in their layer', async () => {
    const bytes = await ocPdf()
    const items = await listItems(bytes)
    const shown = items.find((i) => i.text === 'Shown layer')!
    // Sorted above everything: drawn after the page content.
    const out = await edit(bytes, [{ itemId: shown.id, z: items.length }])
    const content = await pageContent(out, 0)
    expect(content).toMatch(/\nQ\n\/OC \/ocOn BDC\nq\n[^]*\(Shown layer\) Tj\nET\nQ\nEMC\n$/)
    const after = await listItems(out)
    expect(after.map((i) => i.text ?? i.kind)).toEqual(['Always', 'path', 'Shown layer'])
  })
})

describe('predefined CJK CMaps', () => {
  afterEach(() => setCMapLoader(undefined))

  async function rksjPdf(): Promise<Uint8Array> {
    const content = 'BT /F1 24 Tf 72 700 Td (ABC) Tj /F2 24 Tf (Tail) Tj ET'
    return pdfFromContent(content, async (doc, page) => {
      const ctx = doc.context
      const helv = await doc.embedFont(StandardFonts.Helvetica)
      const desc = ctx.obj({ Type: 'FontDescriptor', FontName: 'MS-Mincho', Flags: 6, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 700, StemV: 80 })
      const cid = ctx.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: 'MS-Mincho',
        CIDSystemInfo: { Registry: ctx.obj('Adobe' as never), Ordering: ctx.obj('Japan1' as never), Supplement: 2 } as never,
        FontDescriptor: ctx.register(desc),
        DW: 1000,
        W: [231, 389, 500, 631, 631, 500]
      })
      const t0 = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Mincho', Encoding: '90ms-RKSJ-H', DescendantFonts: [ctx.register(cid)] })
      page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: ctx.register(t0), F2: helv.ref } }) as never)
      return {}
    })
  }

  it('loads the bundled binary CMap: correct codes, widths and Unicode', async () => {
    const bytes = await rksjPdf()
    const items = await listItems(bytes)
    expect(items.map((i) => i.text)).toEqual(['ABC', 'Tail'])
    near(items[0].bounds.width, 36)
    expect(items[0].readOnly).toBeUndefined()
    near(items[1].origin!.x, 72 + 36)
    const out = await edit(bytes, [{ itemId: items[0].id, deleted: true }])
    // The following text keeps its place (the deleted glyphs' advance is preserved).
    expect(await pageContent(out, 0)).toContain('[-1500] TJ')
    const after = await listItems(out)
    expect(after.map((i) => i.text)).toEqual(['Tail'])
    near(after[0].origin!.x, 72 + 36)
    // pdf.js (which renders the page) places it there too.
    near((await pdfjsText(out))[0].x, 108)
  })

  it('marks text read-only and refuses edits when the CMap is unavailable', async () => {
    setCMapLoader(() => null)
    const bytes = await rksjPdf()
    const items = await listItems(bytes)
    const abc = items.find((i) => i.kind === 'text' && i.fontName === 'MS-Mincho')!
    expect(abc.readOnly).toBe(true)
    expect(abc.editableInPlace).toBe(false)
    const before = await pageContent(bytes, 0)
    const out = await edit(bytes, [{ itemId: abc.id, deleted: true }])
    expect(await pageContent(out, 0)).toBe(before)
  })

  it('uses an injected loader', async () => {
    const names: string[] = []
    setCMapLoader((name) => {
      names.push(name)
      return null
    })
    await listItems(await rksjPdf())
    expect(names).toContain('90ms-RKSJ-H')
  })
})

describe('in-place re-encoding', () => {
  it('does not use codes whose /Widths entry is 0 (falls back to an embedded font)', async () => {
    const used: Record<string, number> = { ' ': 278, H: 722, e: 556, l: 222, o: 556 }
    const widths: number[] = []
    for (let c = 32; c <= 122; c++) widths.push(used[String.fromCharCode(c)] ?? 0)
    const bytes = await pdfFromContent('BT /TT0 24 Tf 72 700 Td (Hello Hello) Tj ET', async (doc, page) => {
      const ctx = doc.context
      const font = ctx.obj({
        Type: 'Font',
        Subtype: 'TrueType',
        BaseFont: 'Arial',
        Encoding: 'WinAnsiEncoding',
        FirstChar: 32,
        LastChar: 122,
        Widths: widths,
        FontDescriptor: ctx.register(
          ctx.obj({ Type: 'FontDescriptor', FontName: 'Arial', Flags: 32, FontBBox: [-665, -325, 2000, 1040], ItalicAngle: 0, Ascent: 905, Descent: -212, CapHeight: 716, StemV: 80 })
        )
      })
      page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { TT0: ctx.register(font) } }) as never)
      return {}
    })
    const [item] = await listItems(bytes)
    expect(item.editableInPlace).toBe(true)
    // Only glyphs with widths: re-encoded in place.
    const inPlace = await edit(bytes, [{ itemId: item.id, text: 'Hole' }])
    expect(await pageContent(inPlace, 0)).toContain('/TT0 24 Tf')
    expect(await pageContent(inPlace, 0)).not.toContain('OPEF')
    // "a", "W", "t" have zero widths: fallback font.
    const out = await edit(bytes, [{ itemId: item.id, text: 'Hallo Welt' }])
    expect(await pageContent(out, 0)).toContain('/OPEF1 24 Tf')
    const [p] = await pdfjsText(out)
    expect(p.str).toBe('Hallo Welt')
    expect(p.width).toBeGreaterThan(100)
  })
})

describe('API', () => {
  it('applyContentEdits on a directly loaded page leaves readable content', async () => {
    const bytes = await groupFormPdf()
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const items = listContentItems(doc, page, visibleBox(page))
    await applyContentEdits(doc, page, visibleBox(page), [{ itemId: items[1].id, deleted: true }], testHelpers(doc))
    expect(new TextDecoder('latin1').decode(readPageContent(page))).toContain('Fm1_e Do')
  })
})
