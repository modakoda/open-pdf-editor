/**
 * Stacking order of redrawn items: blocks are drawn where the item was (closing and
 * re-establishing graphics state levels, text objects and marked content around them), and
 * ContentEdit.z re-orders items among their siblings.
 */
import { describe, expect, it } from 'vitest'
import { PDFName, StandardFonts } from '@cantoo/pdf-lib'
import type { ContentEdit, ContentItem, Matrix } from '../../../src/core/model'
import { OPS, closePdfjs, openWithPdfjs, pageContent } from '../helpers'
import { addStdFont, byText, edit, latin1, listItems, pdfFromContent, pdfjsText, type PdfjsTextItem } from './helpers'

const near = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol)
const move = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy]

type Painted =
  | { kind: 'path'; color: string; bounds: [number, number, number, number] }
  | { kind: 'text'; text: string }
  | { kind: 'image' }

/** What pdf.js paints, in order: paths (fill color, or stroke color if only stroked; user-space bounds), texts, images. */
async function painted(bytes: Uint8Array): Promise<Painted[]> {
  const doc = await openWithPdfjs(bytes)
  try {
    const list = await (await doc.getPage(1)).getOperatorList()
    const out: Painted[] = []
    type St = { ctm: number[]; fill: string; stroke: string }
    let st: St = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000' }
    const stack: St[] = []
    const mul = (m1: number[], m2: number[]) => [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    ]
    const paints = new Set<number>([OPS.fill, OPS.eoFill, OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i]
      const args = list.argsArray[i] as unknown[]
      if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
        stack.push(st)
        st = { ...st }
        const m = fn === OPS.paintFormXObjectBegin ? (args[0] as number[] | null) : null
        if (m) st.ctm = mul(Array.from(m), st.ctm)
      } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) st = stack.pop() ?? st
      else if (fn === OPS.transform) st.ctm = mul(args as number[], st.ctm)
      else if (fn === OPS.setFillRGBColor) st.fill = String(args[0])
      else if (fn === OPS.setStrokeRGBColor) st.stroke = String(args[0])
      else if (fn === OPS.constructPath && paints.has(args[0] as number)) {
        const [x0, y0, x1, y1] = Array.from(args[2] as ArrayLike<number>)
        const pts = [
          [x0, y0],
          [x1, y0],
          [x0, y1],
          [x1, y1]
        ].map(([x, y]) => [st.ctm[0] * x + st.ctm[2] * y + st.ctm[4], st.ctm[1] * x + st.ctm[3] * y + st.ctm[5]])
        const r = (v: number) => Math.round(v * 1000) / 1000
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        const strokeOnly = args[0] === OPS.stroke || args[0] === OPS.closeStroke
        out.push({ kind: 'path', color: strokeOnly ? st.stroke : st.fill, bounds: [r(Math.min(...xs)), r(Math.min(...ys)), r(Math.max(...xs)), r(Math.max(...ys))] })
      } else if (fn === OPS.showText) {
        const glyphs = args[0] as Array<{ unicode?: string } | number>
        const text = glyphs.map((g) => (typeof g === 'object' && g ? (g.unicode ?? '') : '')).join('')
        if (text) out.push({ kind: 'text', text })
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        out.push({ kind: 'image' })
      }
    }
    return out
  } finally {
    await closePdfjs(doc)
  }
}

const colors = (p: Painted[]) => p.map((x) => (x.kind === 'path' ? x.color : x.kind === 'text' ? x.text : 'image'))

/** pdf.js text items other than `except` are unchanged (position, width, scale). */
function expectUnchanged(before: PdfjsTextItem[], after: PdfjsTextItem[], except: string[] = []) {
  for (const b of before.filter((x) => !except.includes(x.str))) {
    const a = after.find((x) => x.str === b.str && Math.abs(x.y - b.y) < 1)
    expect(a, `"${b.str}" is gone`).toBeDefined()
    near(a!.x, b.x)
    near(a!.y, b.y)
    near(a!.width, b.width)
    near(a!.transform[0], b.transform[0], 0.001)
    near(a!.transform[3], b.transform[3], 0.001)
  }
}

function balanced(content: string) {
  const count = (re: RegExp) => content.match(re)?.length ?? 0
  expect(count(/(^|\s)q(?=\s)/g), 'q/Q').toBe(count(/(^|\s)Q(?=\s)/g))
  expect(count(/(^|\s)BT(?=\s)/g), 'BT/ET').toBe(count(/(^|\s)ET(?=\s)/g))
  expect(count(/(^|\s)(BDC|BMC)(?=\s)/g), 'BDC/EMC').toBe(count(/(^|\s)EMC(?=\s)/g))
}

async function fonts(doc: Parameters<typeof addStdFont>[0], page: Parameters<typeof addStdFont>[1]) {
  await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
  await addStdFont(doc, page, 'F2', StandardFonts.TimesRoman)
  return {}
}

describe('redrawn items keep their stacking order', () => {
  it('draws a moved path under a later overlapping path', async () => {
    const bytes = await pdfFromContent('q 1 0 0 rg 100 600 100 100 re f Q q 0 0 1 rg 150 650 100 100 re f Q 0 g 400 100 20 20 re f')
    const [red] = await listItems(bytes)
    const out = await edit(bytes, [{ itemId: red.id, transform: move(20, -10) }])
    expect(await painted(out)).toEqual([
      { kind: 'path', color: '#ff0000', bounds: [120, 610, 220, 710] },
      { kind: 'path', color: '#0000ff', bounds: [150, 650, 250, 750] },
      { kind: 'path', color: '#000000', bounds: [400, 100, 420, 120] }
    ])
    balanced(await pageContent(out, 0))
  })

  it('re-establishes nested graphics state levels (clips, CTMs, ExtGStates) for the following content', async () => {
    const content = [
      'q 0 0 400 792 re W n',
      'q 2 0 0 2 0 0 cm 0.5 w /GS0 gs',
      '1 0 0 rg 50 300 50 50 re f',
      '0 0 1 rg 75 325 200 50 re f 1 0 0 RG 60 310 100 10 re S',
      'Q',
      '0 1 0 rg 300 100 200 50 re f',
      'Q',
      '0 g 10 10 20 20 re f'
    ].join('\n')
    const bytes = await pdfFromContent(content, (doc, page) => {
      page.node.setExtGState(PDFName.of('GS0'), doc.context.obj({ Type: 'ExtGState', ca: 0.5 }))
      return {}
    })
    const before = await listItems(bytes)
    expect(before.map((i) => i.color)).toEqual(['#ff0000', '#0000ff', '#ff0000', '#00ff00', '#000000'])
    const out = await edit(bytes, [{ itemId: before[0].id, transform: move(0, 300) }])
    const after = await listItems(out)
    // Same order, the others unchanged: still clipped at x = 400 and scaled by 2.
    expect(after.map((i) => i.color)).toEqual(before.map((i) => i.color))
    for (let i = 1; i < before.length; i++) expect(after[i].bounds).toEqual(before[i].bounds)
    expect(after[1].bounds.x + after[1].bounds.width).toBe(400)
    near(after[0].bounds.y, before[0].bounds.y + 300)
    const p = await painted(out)
    expect(colors(p)).toEqual(['#ff0000', '#0000ff', '#ff0000', '#00ff00', '#000000'])
    expect(p[1]).toEqual({ kind: 'path', color: '#0000ff', bounds: [150, 650, 550, 750] })
    const c = await pageContent(out, 0)
    balanced(c)
    // The transparency is re-applied for the blue rectangle (and drawn with the moved red one).
    expect(c.match(/\/GS0 gs/g)?.length).toBe(3)
    // Untouched operators are copied byte for byte.
    expect(c).toContain('0 0 1 rg 75 325 200 50 re f 1 0 0 RG 60 310 100 10 re S\nQ\n0 1 0 rg 300 100 200 50 re f\nQ\n0 g 10 10 20 20 re f')
  })

  it('closes and re-opens a text object around an item, restoring the exact text state', async () => {
    const content = [
      'BT /F1 12 Tf 1.5 Tc 6 Tw 80 Tz 2 Ts 16 TL 0.4 w 2 Tr 72 700 Td',
      '(First words) Tj /F2 14 Tf 1 0 0 rg (Second part) Tj /F1 12 Tf 0 g (third bit) Tj',
      "T* (Next line) Tj (quoted line) ' 2 0.5 (double quoted) \"",
      'ET',
      'q 0 0 1 rg 300 300 50 50 re f Q'
    ].join('\n')
    const bytes = await pdfFromContent(content, fonts)
    const items = await listItems(bytes)
    expect(items.filter((i) => i.kind === 'text').map((i) => i.text)).toEqual([
      'First words',
      'Second part',
      'third bit',
      'Next line',
      'quoted line',
      'double quoted'
    ])
    const second = byText(items, 'Second part')
    const pjBefore = await pdfjsText(bytes)
    const out = await edit(bytes, [{ itemId: second.id, transform: move(0, 100) }])
    const pjAfter = await pdfjsText(out)
    // (pdf.js lists words.)
    expect(pjBefore.map((t) => t.str)).toEqual(['First', 'words', 'Second', 'part', 'third', 'bit', 'Next', 'line', 'quoted', 'line', 'double quoted'])
    expectUnchanged(pjBefore, pjAfter, ['Second', 'part'])
    for (const word of ['Second', 'part']) {
      const moved = pjAfter.find((t) => t.str === word)!
      const orig = pjBefore.find((t) => t.str === word)!
      near(moved.x, orig.x)
      near(moved.y, orig.y + 100)
      near(moved.width, orig.width)
    }
    // Drawn where it was: after "First words", before "third bit".
    expect(colors(await painted(out))).toEqual(['First words', 'Second part', 'third bit', 'Next line', 'quoted line', 'double quoted', '#0000ff'])
    const c = await pageContent(out, 0)
    balanced(c)
    // The text object is closed before the block and re-opened with its state and position.
    // (Tm continues after the moved text: restored with an adjustment, Tc does not apply to it.)
    expect(c).toMatch(
      /\nET\nQ\nq\n[^]*\(Second part\) Tj\nET\nQ\nq\n0\.4 w\n1 0 0 rg\n\/F2 14 Tf\n1\.5 Tc\n6 Tw\n80 Tz\n16 TL\n2 Ts\n2 Tr\nBT\n1 0 0 1 72 700 Tm\n0 Tc\n\[-[\d.]+\] TJ\n1\.5 Tc\n \/F1 12 Tf 0 g \(third bit\) Tj\n/
    )
    // Re-listing the output finds the same text in the same places.
    const again = await listItems(out)
    for (const t of items.filter((i) => i.kind === 'text' && i.text !== 'Second part')) {
      const a = byText(again, t.text!)
      near(a.origin!.x, t.origin!.x, 0.001)
      near(a.origin!.y, t.origin!.y, 0.001)
      near(a.bounds.width, t.bounds.width, 0.001)
    }
  })

  it('keeps marked content balanced and the item in its MCID section', async () => {
    const content = [
      '/Artifact BMC q 0.9 g 0 0 612 792 re f Q EMC',
      'BT /F1 12 Tf 72 700 Td',
      '/P <</MCID 0>> BDC (Tagged start) Tj EMC',
      '/Span <</MCID 1>> BDC /F2 12 Tf (moved words) Tj /F1 12 Tf ( and the rest) Tj EMC',
      'ET'
    ].join('\n')
    const bytes = await pdfFromContent(content, fonts)
    const items = await listItems(bytes)
    const target = byText(items, 'moved words')
    const out = await edit(bytes, [{ itemId: target.id, transform: move(0, 50) }])
    const c = await pageContent(out, 0)
    balanced(c)
    expectUnchanged(await pdfjsText(bytes), await pdfjsText(out), ['moved words'])
    const doc = await openWithPdfjs(out)
    try {
      const tc = await (await doc.getPage(1)).getTextContent({ includeMarkedContent: true } as never)
      const seq: string[] = []
      for (const it of tc.items as Array<{ type?: string; id?: string; str?: string }>) {
        if (it.type === 'beginMarkedContentProps') seq.push(`<${it.id?.replace(/^.*_mc/, 'mc')}>`)
        else if (it.type === 'beginMarkedContent') seq.push('<>')
        else if (it.type === 'endMarkedContent') seq.push('</>')
        else if (it.str?.trim()) seq.push(it.str.trim())
      }
      // The moved text and the rest of its section keep MCID 1.
      expect(seq.join(' ')).toBe('<> </> <mc0> Tagged start </> <mc1> </> <mc1> moved words </> <mc1> and the rest </>')
    } finally {
      await closePdfjs(doc)
    }
  })

  it('keeps the last item of a tagged page inside its section (no repeated MCID)', async () => {
    const bytes = await pdfFromContent('/P <</MCID 0>> BDC q 0 0 1 rg 72 600 100 40 re f Q EMC /P <</MCID 1>> BDC BT /F1 12 Tf 72 700 Td (Last words) Tj ET EMC', fonts)
    const items = await listItems(bytes)
    for (const item of items) {
      const c = await pageContent(await edit(bytes, [{ itemId: item.id, transform: move(5, 5) }]), 0)
      balanced(c)
      expect(c.match(/\/MCID/g)?.length).toBe(2)
    }
    const c = await pageContent(await edit(bytes, [{ itemId: byText(items, 'Last words').id, transform: move(5, 5) }]), 0)
    // After the (now empty) text object, before the section's EMC.
    expect(c).toMatch(/\/P <<\/MCID 1>> BDC BT \/F1 12 Tf 72 700 Td\s+ET\nQ\nq\n[^]*\(Last words\) Tj\nET\nQ\nq\n[^]*EMC\nQ\n$/)
  })

  it('draws the block at the end of the content when a text clip cannot be re-established', async () => {
    // Glyphs added to a text clip (Tr 7) clip what follows the text object: the text object
    // cannot be closed early, and the clip cannot be restored after a block.
    for (const [content, target] of [
      ['BT /F1 40 Tf 72 600 Td 7 Tr (CLIP) Tj 0 Tr 1 0 0 rg (Shown) Tj 0 0 1 rg ( Blue) Tj ET q 0 1 0 rg 50 550 400 100 re f Q 0 g 10 10 5 5 re f', 'Shown'],
      ['BT /F1 40 Tf 72 600 Td 7 Tr (CLIP) Tj ET 1 0 0 rg 60 590 100 30 re f 0 0 1 rg 70 600 100 30 re f', 'path']
    ]) {
      const bytes = await pdfFromContent(content, fonts)
      const items = await listItems(bytes)
      const item = items.find((i) => (i.text ?? i.kind) === target)!
      const out = await edit(bytes, [{ itemId: item.id, transform: move(5, 0) }])
      const c = await pageContent(out, 0)
      balanced(c)
      // Nothing is inserted into the original content (only the item's operators are gone).
      const tail = content.slice(content.lastIndexOf(' re f') - 20)
      expect(c).toContain(tail + '\nQ\nq\n')
      const p = colors(await painted(out))
      expect(p[p.length - 1]).toBe(target === 'path' ? '#ff0000' : 'Shown')
    }
  })

  it('keeps blocks inside a form XObject copy in place', async () => {
    const bytes = await pdfFromContent('q 1 0 0 1 100 400 cm /Fm1 Do Q 0 g 500 10 5 5 re f', (doc, page) => {
      const ctx = doc.context
      const form = ctx.stream(latin1('1 0 0 rg 0 0 100 100 re f 0 0 1 rg 50 50 100 100 re f'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 200]
      } as never)
      page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm1: ctx.register(form) } }) as never)
      return {}
    })
    const items = await listItems(bytes)
    const red = items.find((i) => i.color === '#ff0000')!
    expect(red.id).toBe('x2/p2')
    const out = await edit(bytes, [{ itemId: red.id, transform: move(10, 0) }])
    expect(await painted(out)).toEqual([
      { kind: 'path', color: '#ff0000', bounds: [110, 400, 210, 500] },
      { kind: 'path', color: '#0000ff', bounds: [150, 450, 250, 550] },
      { kind: 'path', color: '#000000', bounds: [500, 10, 505, 15] }
    ])
  })
})

describe('re-ordering items (ContentEdit.z)', () => {
  // Red, green and blue overlapping squares, then text over them.
  const content = [
    'q 1 0 0 rg 100 600 100 100 re f Q',
    'q 0 1 0 rg 130 630 100 100 re f Q',
    'q 0 0 1 rg 160 660 100 100 re f Q',
    'BT /F1 12 Tf 110 650 Td (Label) Tj ET'
  ].join('\n')
  let bytes: Uint8Array
  let items: ContentItem[]
  const order = async (edits: ContentEdit[]) => {
    const out = await edit(bytes, edits)
    balanced(await pageContent(out, 0))
    const p = await painted(out)
    // Positions do not change.
    for (const x of p) {
      if (x.kind !== 'path') continue
      const k = ['#ff0000', '#00ff00', '#0000ff'].indexOf(x.color)
      expect(x.bounds).toEqual([100 + 30 * k, 600 + 30 * k, 200 + 30 * k, 700 + 30 * k])
    }
    return colors(p).join(' ')
  }
  const setup = async () => {
    bytes = await pdfFromContent(content, fonts)
    items = await listItems(bytes)
    expect(items.map((i) => i.color)).toEqual(['#ff0000', '#00ff00', '#0000ff', '#000000'])
  }

  it('brings an item to the front (drawn after all content)', async () => {
    await setup()
    expect(await order([{ itemId: items[0].id, z: 4 }])).toBe('#00ff00 #0000ff Label #ff0000')
    const out = await edit(bytes, [{ itemId: items[0].id, z: 4 }])
    expect(await pageContent(out, 0)).toMatch(/\(Label\) Tj ET\nQ\nq\n[^]*re\nf\nQ\n$/)
  })

  it('sends an item to the back (drawn before all content)', async () => {
    await setup()
    expect(await order([{ itemId: items[2].id, z: -1 }])).toBe('#0000ff #ff0000 #00ff00 Label')
    const out = await edit(bytes, [{ itemId: items[2].id, z: -1 }])
    expect(await pageContent(out, 0)).toMatch(/^q\n[^]*0 0 1 rg\n0 G\n160 660 100 100 re\nf\nQ\nq\nq 1 0 0 rg/)
  })

  it('brings an item forward and sends it backward by one', async () => {
    await setup()
    expect(await order([{ itemId: items[0].id, z: 1.5 }])).toBe('#00ff00 #ff0000 #0000ff Label')
    expect(await order([{ itemId: items[2].id, z: 0.5 }])).toBe('#ff0000 #0000ff #00ff00 Label')
    // Text among paths.
    expect(await order([{ itemId: items[3].id, z: 0.5 }])).toBe('#ff0000 Label #00ff00 #0000ff')
  })

  it('combines several re-ordered items, moves and recolors', async () => {
    await setup()
    const edits: ContentEdit[] = [
      { itemId: items[0].id, z: 10 },
      { itemId: items[1].id, z: 11, color: '#ffff00' },
      { itemId: items[3].id, z: -2, transform: move(0, 0.5) }
    ]
    const out = await edit(bytes, edits)
    balanced(await pageContent(out, 0))
    expect(colors(await painted(out))).toEqual(['Label', '#0000ff', '#ff0000', '#ffff00'])
    // Natural keys of the others: z between two items puts it between them.
    expect(await order([{ itemId: items[0].id, z: 2.5 }, { itemId: items[1].id, z: 2.25 }])).toBe('#0000ff #00ff00 #ff0000 Label')
  })

  it('does not change item ids or anything for z of the original position', async () => {
    await setup()
    const before = items.map((i) => i.id)
    const out = await edit(bytes, [{ itemId: items[1].id, z: 1 }])
    expect(colors(await painted(out))).toEqual(['#ff0000', '#00ff00', '#0000ff', 'Label'])
    expect((await listItems(bytes)).map((i) => i.id)).toEqual(before)
  })

  it('orders items inside a form XObject among the items of the form', async () => {
    const formBytes = await pdfFromContent('0 g 10 10 5 5 re f q 1 0 0 1 100 400 cm /Fm1 Do Q 0 0 1 rg 10 20 5 5 re f', (doc, page) => {
      const ctx = doc.context
      const form = ctx.stream(latin1('1 0 0 rg 0 0 100 100 re f 0 1 0 rg 50 50 100 100 re f'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 200]
      } as never)
      page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm1: ctx.register(form) } }) as never)
      return {}
    })
    const its = await listItems(formBytes)
    expect(its.map((i) => `${i.kind}:${i.color ?? ''}`)).toEqual(['path:#000000', 'xobject:', 'path:#ff0000', 'path:#00ff00', 'path:#0000ff'])
    const [red, green] = [its[2].id, its[3].id]
    expect(red).toMatch(new RegExp(`^${its[1].id}/`))
    // Front within the form: still under the page's blue square drawn after the form.
    const out = await edit(formBytes, [{ itemId: red, z: 10 }])
    expect(colors(await painted(out))).toEqual(['#000000', '#00ff00', '#ff0000', '#0000ff'])
    // Keys are those of the page listing: 1.5 sorts before the red square (2).
    const back = await edit(formBytes, [{ itemId: green, z: 1.5 }])
    expect(colors(await painted(back))).toEqual(['#000000', '#00ff00', '#ff0000', '#0000ff'])
  })
})
