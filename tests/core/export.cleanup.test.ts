import { beforeAll, describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib'
import {
  addObject,
  deletePages,
  documentFromSource,
  duplicatePages,
  exportDocument,
  insertSourcePages,
  loadSource,
  openDocument,
  type EditorDocument
} from '../../src/core'
import {
  makeBigFormPdf,
  makeInvalidResourcesPdf,
  makeLargeImagePdf,
  makeOptionalContentPdf,
  makeTaggedSecretPdf,
  makeTextPdf
} from '../fixtures/pdfs'
import { OPS, allPagesText, allStreamsText, closePdfjs, hexText, openWithPdfjs, pageAnnotations, registerTestFonts, timeBudget } from './helpers'

beforeAll(() => registerTestFonts())

/** Every string of every object in the file, decoded. */
async function allStrings(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: string[] = []
  const visit = (o: PDFObject | undefined, depth = 0) => {
    if (!o || depth > 20) return
    if (o instanceof PDFString || o instanceof PDFHexString) out.push(o.decodeText())
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v, depth + 1)
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1)
    else if (o instanceof PDFStream) visit(o.dict, depth + 1)
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj)
  return out.join('\n')
}

const text = (s: string) => ({ id: `t${s}`, type: 'text' as const, x: 50, y: 300, width: 300, height: 30, text: s, font: 'sans' as const, bold: false, italic: false, fontSize: 14, color: '#000000', align: 'left' as const, lineHeight: 1.2, rotation: 0 })

describe('objects referenced from unparseable objects survive cleanup (finding 9)', () => {
  for (const body of [`<< /Font << /F1 6 0 R >> /ProcSet [/PDF /Text] /Foo >>`, `<< /Font << /F1 6 0 R >> /Junk 1.2.3 >>`]) {
    it(`keeps the font of ${body}`, async () => {
      const bytes = makeInvalidResourcesPdf(body)
      expect(await allPagesText(bytes)).toEqual(['HELLO'])
      const out = await exportDocument(await openDocument(bytes, 'm.pdf'))
      expect(await allPagesText(out)).toEqual(['HELLO'])
      const re = await PDFDocument.load(out, { updateMetadata: false })
      const all = re.context.enumerateIndirectObjects().map(([, o]) => o.toString()).join(' ')
      expect(all).toContain('/Courier-Bold')
    })
  }
})

describe('deleted pages leave nothing behind (finding 10)', () => {
  let out: Uint8Array
  beforeAll(async () => {
    let doc = await openDocument(await makeTaggedSecretPdf(), 't.pdf')
    doc = deletePages(doc, [doc.pages[1].id])
    out = await exportDocument(doc)
  })

  it('removes the page content, its field value, annotations and appearance streams', async () => {
    const strings = await allStrings(out)
    const streams = await allStreamsText(out)
    expect(streams).not.toContain(hexText('SECRET PAGE TEXT'))
    expect(strings).not.toContain('123-45-6789')
    expect(streams).not.toContain(hexText('123-45-6789'))
    expect(strings).not.toContain('Confidential reviewer note')
    expect(strings).not.toContain('secret-par')
    const src = await loadSource(out, 'o.pdf')
    expect(src.formFields.map((f) => f.name)).toEqual(['public'])
    expect(await allPagesText(out)).toEqual(['Public page', 'Last page'])
  })

  it('prunes the structure tree, ParentTree and IDTree', async () => {
    const re = await PDFDocument.load(out, { updateMetadata: false })
    const root = re.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict)
    const kids = root.lookup(PDFName.of('K'), PDFArray)
    expect(kids.size()).toBe(1)
    expect((kids.lookup(0, PDFDict).lookup(PDFName.of('S')) as PDFName).decodeText()).toBe('P')
    const nums = root.lookup(PDFName.of('ParentTree'), PDFDict).lookup(PDFName.of('Nums'), PDFArray)
    const keys = Array.from({ length: nums.size() / 2 }, (_, i) => (nums.lookup(i * 2) as PDFNumber).asNumber())
    expect(keys).toEqual([2])
    const ids = root.lookup(PDFName.of('IDTree'), PDFDict).lookup(PDFName.of('Names'), PDFArray)
    expect(ids.size()).toBe(0)
  })

  it('removes outline items, named destinations and links that pointed at the page', async () => {
    const pj = await openWithPdfjs(out)
    const outline = (await pj.getOutline()) as Array<{ title: string; dest: unknown; items: Array<{ title: string; dest: unknown }> }>
    expect(outline.map((o) => o.title)).toEqual(['Intro', 'Secret', 'End'])
    // "Secret" keeps its child but loses its destination.
    expect(outline[1].dest).toBeNull()
    expect(outline[1].items.map((i) => i.title)).toEqual(['Inside'])
    expect(outline[0].dest).toBeTruthy()
    expect(await pj.getDestination('secret')).toBeNull()
    await closePdfjs(pj)
    const links = (await pageAnnotations(out, 1)).filter((a) => a.subtype === 'Link')
    expect(links.map((l) => !!l.dest)).toEqual([false, false, true])
    const re = await PDFDocument.load(out, { updateMetadata: false })
    const root = re.catalog.lookup(PDFName.of('Outlines'), PDFDict)
    expect((root.lookup(PDFName.of('Count')) as PDFNumber).asNumber()).toBe(4)
  })

  it('also cleans exported subsets and split parts', async () => {
    const doc = await openDocument(await makeTaggedSecretPdf(), 't.pdf')
    const part = await exportDocument(doc, { pageIds: [doc.pages[0].id] })
    const strings = await allStrings(part)
    expect(strings).not.toContain('123-45-6789')
    expect(strings).not.toContain('Confidential reviewer note')
    expect(await allPagesText(part)).toEqual(['Public page'])
  })
})

describe('repeated pages share resources (finding 13)', () => {
  it('duplicates of a primary page do not copy its image', async () => {
    const bytes = await makeLargeImagePdf(300_000)
    let doc = await openDocument(bytes, 'img.pdf')
    for (let i = 0; i < 5; i++) doc = duplicatePages(doc, [doc.pages[0].id])
    doc = addObject(doc, { ...text('only on page 3'), pageId: doc.pages[2].id })
    const out = await exportDocument(doc)
    expect(doc.pages).toHaveLength(6)
    expect(out.length).toBeLessThan(bytes.length * 1.3)
    const texts = await allPagesText(out)
    expect(texts.filter((t) => t.includes('only on page 3'))).toHaveLength(1)
    expect(texts[2]).toBe('only on page 3')
    const pj = await openWithPdfjs(out)
    for (let n = 1; n <= 6; n++) {
      const ops = await (await pj.getPage(n)).getOperatorList()
      expect(ops.fnArray.includes(OPS.paintImageXObject), `page ${n}`).toBe(true)
    }
    await closePdfjs(pj)
  })

  it('a page inserted several times from another file is copied once', async () => {
    const bytes = await makeLargeImagePdf(300_000)
    const base = await openDocument(await makeTextPdf(1), 'a.pdf')
    const other = await loadSource(bytes, 'img.pdf')
    const merged = insertSourcePages(base, other, 1, [0, 0, 0, 0])
    const out = await exportDocument(merged)
    expect(out.length).toBeLessThan(bytes.length * 1.3)
    expect((await PDFDocument.load(out)).getPageCount()).toBe(5)
  })

  it('duplicated pages with notes get their own annotations', async () => {
    let doc: EditorDocument = await openDocument(await (await import('../fixtures/pdfs')).makeAnnotatedPdf(), 'a.pdf')
    doc = duplicatePages(doc, [doc.pages[0].id])
    doc = addObject(doc, { id: 'n', pageId: doc.pages[1].id, type: 'note', x: 100, y: 100, text: 'only on copy', color: '#ff0000' })
    const out = await exportDocument(doc)
    const a1 = await pageAnnotations(out, 1)
    const a2 = await pageAnnotations(out, 2)
    expect(a1.map((a) => a.subtype).sort()).toEqual(['Link', 'Text'])
    expect(a2.map((a) => a.subtype).sort()).toEqual(['Link', 'Text', 'Text'])
    expect(a2.find((a) => a.contentsObj?.str === 'only on copy')).toBeTruthy()
    expect(a1.find((a) => a.contentsObj?.str === 'only on copy')).toBeUndefined()
  })
})

describe('pages copied from other files (finding 15)', () => {
  it('keep optional content that is OFF hidden', async () => {
    const bytes = await makeOptionalContentPdf()
    const merged = insertSourcePages(await openDocument(await makeTextPdf(1), 'a.pdf'), await loadSource(bytes, 'b.pdf'), 1)
    const out = await exportDocument(merged)
    const visibility = async (b: Uint8Array, pageNumber: number) => {
      const pj = await openWithPdfjs(b)
      const cfg = await pj.getOptionalContentConfig()
      const ops = await (await pj.getPage(pageNumber)).getOperatorList()
      const i = ops.fnArray.findIndex((f: number) => f === OPS.beginMarkedContentProps)
      const visible = cfg.isVisible((ops.argsArray[i] as unknown[])[1] as never)
      await closePdfjs(pj)
      return visible
    }
    expect(await visibility(bytes, 1)).toBe(false)
    expect(await visibility(out, 2)).toBe(false)
    const re = await PDFDocument.load(out, { updateMetadata: false })
    const props = re.catalog.lookup(PDFName.of('OCProperties'), PDFDict)
    expect(props.lookup(PDFName.of('OCGs'), PDFArray).size()).toBe(1)
    expect(props.lookup(PDFName.of('D'), PDFDict).lookup(PDFName.of('OFF'), PDFArray).size()).toBe(1)
    expect(props.lookup(PDFName.of('D'), PDFDict).lookup(PDFName.of('Order'), PDFArray).size()).toBe(1)
  })

  it('drop structure keys and named destinations of the other file', async () => {
    const merged = insertSourcePages(await openDocument(await makeTextPdf(1), 'a.pdf'), await loadSource(await makeOptionalContentPdf(), 'b.pdf'), 1)
    const out = await exportDocument(merged)
    const re = await PDFDocument.load(out, { updateMetadata: false })
    const page = re.getPage(1)
    expect(page.node.get(PDFName.of('StructParents'))).toBeUndefined()
    const link = re.context.lookup(page.node.Annots()!.get(0), PDFDict)
    expect(link.get(PDFName.of('Dest'))).toBeUndefined()
    expect(link.get(PDFName.of('StructParent'))).toBeUndefined()
  })
})

describe('large forms stay fast (finding 12)', () => {
  it('loads and exports 2,000 widgets among 100,000 objects quickly', async () => {
    const bytes = await makeBigFormPdf(200, 10, 100_000)
    let t = performance.now()
    const src = await loadSource(bytes, 'big.pdf')
    const loadMs = performance.now() - t
    expect(src.formFields).toHaveLength(2000)
    expect(src.formFields[1999].widgets[0].pageIndex).toBe(199)
    const doc = documentFromSource(src)
    t = performance.now()
    const out = await exportDocument(deletePages(doc, [doc.pages[0].id]))
    const exportMs = performance.now() - t
    expect(loadMs).toBeLessThan(timeBudget(3000))
    expect(exportMs).toBeLessThan(timeBudget(6000))
    const re = await loadSource(out, 'o.pdf')
    expect(re.pageCount).toBe(199)
    expect(re.formFields).toHaveLength(1990)
  }, 120_000)
})
