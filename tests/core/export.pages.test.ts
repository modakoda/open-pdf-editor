import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import {
  PRODUCER,
  addObject,
  createBlankDocument,
  deletePages,
  duplicatePages,
  exportDocument,
  insertBlankPage,
  insertSourcePages,
  loadSource,
  movePages,
  openDocument,
  rotatePages,
  splitDocument,
  type EditorDocument
} from '../../src/core'
import {
  A4,
  LETTER,
  makeAnnotatedPdf,
  makeCropBoxPdf,
  makeInheritedAttributesPdf,
  makeLinkedPdf,
  makeMixedSizesPdf,
  makeRotatedPdf,
  makeTextPdf
} from '../fixtures/pdfs'
import { allPagesText, allStreamsText, deepFreeze, hexText, pageAnnotations, pageInfo, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

const pageTexts = (n: number[]) => n.map((i) => `Page ${i} Lorem ipsum dolor sit amet`)

describe('export: identity', () => {
  it('round-trips a plain document', async () => {
    const bytes = await makeTextPdf(3)
    const doc = await openDocument(bytes, 'a.pdf')
    const out = await exportDocument(doc)
    expect(await allPagesText(out)).toEqual(pageTexts([1, 2, 3]))
    const reloaded = await loadSource(out, 'out.pdf')
    expect(reloaded.metadata).toEqual((await loadSource(bytes, 'a.pdf')).metadata)
    expect(reloaded.isEncrypted).toBe(false)
  })

  it('keeps existing annotations and links', async () => {
    const doc = await openDocument(await makeAnnotatedPdf(), 'annotated.pdf')
    const out = await exportDocument(doc)
    const annots = await pageAnnotations(out, 1)
    const link = annots.find((a) => a.subtype === 'Link')
    const note = annots.find((a) => a.subtype === 'Text')
    expect(link?.unsafeUrl).toBe('https://example.com')
    expect(note?.contentsObj?.str).toBe('Existing note')
  })

  it('keeps rotation and crop boxes', async () => {
    const rotated = await exportDocument(await openDocument(await makeRotatedPdf(), 'r.pdf'))
    expect((await pageInfo(rotated)).map((p) => p.rotate)).toEqual([0, 90, 180, 270])
    expect(await allPagesText(rotated)).toEqual(['Rotated 0', 'Rotated 90', 'Rotated 180', 'Rotated 270'])
    const crop = await exportDocument(await openDocument(await makeCropBoxPdf(), 'c.pdf'))
    expect((await pageInfo(crop))[0].view).toEqual([50, 100, 550, 700])
  })

  it('preserves pages that inherit MediaBox / Rotate from the page tree', async () => {
    let doc = await openDocument(await makeInheritedAttributesPdf(), 'inh.pdf')
    doc = movePages(doc, [doc.pages[1].id], 0)
    const out = await exportDocument(doc)
    const info = await pageInfo(out)
    expect(info.map((p) => p.rotate)).toEqual([90, 90])
    expect(info.map((p) => p.view)).toEqual([
      [0, 0, 400, 600],
      [0, 0, 400, 600]
    ])
    expect(await allPagesText(out)).toEqual(['Inherited 2', 'Inherited 1'])
  })
})

describe('export: page operations', () => {
  let base: EditorDocument
  beforeAll(async () => {
    base = deepFreeze(await openDocument(await makeTextPdf(4), 'four.pdf'))
  })

  it('reorders, deletes and rotates pages', async () => {
    const [p1, p2, p3, p4] = base.pages.map((p) => p.id)
    let doc = movePages(base, [p4], 0)
    doc = deletePages(doc, [p2])
    doc = rotatePages(doc, [p3], 90)
    doc = rotatePages(doc, [p1], -90)
    const out = await exportDocument(doc)
    expect(await allPagesText(out)).toEqual(pageTexts([4, 1, 3]))
    expect((await pageInfo(out)).map((p) => p.rotate)).toEqual([0, 270, 90])
  })

  it('adds user rotation to the page’s own /Rotate', async () => {
    let doc = await openDocument(await makeRotatedPdf(), 'r.pdf')
    doc = rotatePages(doc, doc.pages.map((p) => p.id), 90)
    const out = await exportDocument(doc)
    expect((await pageInfo(out)).map((p) => p.rotate)).toEqual([90, 180, 270, 0])
  })

  it('duplicates pages and inserts blank pages', async () => {
    let doc = duplicatePages(base, [base.pages[0].id, base.pages[2].id])
    doc = insertBlankPage(doc, 0, { width: 300, height: 400 }).doc
    doc = insertBlankPage(doc, doc.pages.length).doc
    const out = await exportDocument(doc)
    const texts = await allPagesText(out)
    expect(texts).toEqual(['', ...pageTexts([1, 1, 2, 3, 3, 4]), ''])
    const info = await pageInfo(out)
    expect(info[0].view).toEqual([0, 0, 300, 400])
    expect(info[7].view[2]).toBeCloseTo(A4[0])
  })

  it('removes the content of deleted pages from the file', async () => {
    const doc = deletePages(base, [base.pages[1].id, base.pages[2].id])
    const out = await exportDocument(doc)
    const streams = await allStreamsText(out)
    expect(streams).toContain(hexText('Page 1'))
    expect(streams).toContain(hexText('Page 4'))
    expect(streams).not.toContain(hexText('Page 2'))
    expect(streams).not.toContain(hexText('Page 3'))
  })

  it('exports a subset in document order', async () => {
    const [p1, , p3] = base.pages.map((p) => p.id)
    const out = await exportDocument(base, { pageIds: [p3, p1, 'unknown'] })
    expect(await allPagesText(out)).toEqual(pageTexts([1, 3]))
    const streams = await allStreamsText(out)
    expect(streams).not.toContain(hexText('Page 2'))
  })

  it('splits into one file per group', async () => {
    const [p1, p2, p3, p4] = base.pages.map((p) => p.id)
    const parts = await splitDocument(base, [[p1, p2], [p3], [p4]])
    expect(parts).toHaveLength(3)
    expect(await allPagesText(parts[0])).toEqual(pageTexts([1, 2]))
    expect(await allPagesText(parts[1])).toEqual(pageTexts([3]))
    expect(await allPagesText(parts[2])).toEqual(pageTexts([4]))
    // Each part only carries its own content.
    expect(parts[1].length).toBeLessThan((await exportDocument(base)).length)
  })

  it('refuses to export zero pages', async () => {
    await expect(exportDocument(deletePages(base, base.pages.map((p) => p.id)))).rejects.toThrow()
    await expect(exportDocument(base, { pageIds: [] })).rejects.toThrow()
  })

  it('is repeatable and never touches the source bytes', async () => {
    const bytes = await makeTextPdf(2)
    const copy = bytes.slice()
    let doc = await openDocument(bytes, 'x.pdf')
    doc = addObject(doc, {
      id: 't',
      pageId: doc.pages[0].id,
      type: 'text',
      x: 50,
      y: 300,
      width: 300,
      height: 40,
      text: 'Ąžuolas and Hello',
      font: 'serif',
      bold: false,
      italic: false,
      fontSize: 14,
      color: '#000000',
      align: 'left',
      lineHeight: 1.2,
      rotation: 0
    })
    deepFreeze(doc)
    const a = await exportDocument(doc)
    const b = await exportDocument(doc)
    expect(bytes).toEqual(copy)
    expect(await allPagesText(a)).toEqual(await allPagesText(b))
    expect(Math.abs(a.length - b.length)).toBeLessThan(64)
    expect(await allPagesText(a)).toEqual(['Page 1 Lorem ipsum dolor sit amet Ąžuolas and Hello', pageTexts([2])[0]])
  })
})

describe('export: multiple sources', () => {
  it('merges pages from two files', async () => {
    let doc = await openDocument(await makeTextPdf(2), 'a.pdf')
    const mixed = await loadSource(await makeMixedSizesPdf(), 'b.pdf')
    doc = insertSourcePages(doc, mixed, 1)
    const out = await exportDocument(doc)
    expect(await allPagesText(out)).toEqual([pageTexts([1])[0], 'Size 1', 'Size 2', 'Size 3', pageTexts([2])[0]])
    const info = await pageInfo(out)
    expect(info[2].view).toEqual([0, 0, ...LETTER])
    expect(info[3].view[2]).toBeCloseTo(A4[1])
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(5)
  })

  it('takes pages from another source several times and from a blank document', async () => {
    let doc = createBlankDocument()
    const src = await loadSource(await makeTextPdf(3), 'a.pdf')
    doc = insertSourcePages(doc, src, 1, [2, 0])
    const extra = await loadSource(await makeRotatedPdf(), 'r.pdf')
    doc = insertSourcePages(doc, extra, 0, [1])
    doc = duplicatePages(doc, [doc.pages[0].id])
    // primarySourceId stays the text file (first inserted); the rotated file is secondary.
    expect(doc.primarySourceId).toBe(src.id)
    const out = await exportDocument(doc)
    expect(await allPagesText(out)).toEqual(['Rotated 90', 'Rotated 90', '', ...pageTexts([3, 1])])
    expect((await pageInfo(out)).map((p) => p.rotate)).toEqual([90, 90, 0, 0, 0])
  })

  it('drops internal links of pages copied from other files but keeps URI links', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'a.pdf')
    doc = insertSourcePages(doc, await loadSource(await makeLinkedPdf(), 'links.pdf'), 1, [1])
    const out = await exportDocument(doc)
    const annots = await pageAnnotations(out, 2)
    expect(annots.filter((a) => a.subtype === 'Link').map((a) => a.unsafeUrl ?? null)).toEqual([null, 'https://example.org'])
    // Page 1 of links.pdf ("Target page") was not dragged into the file.
    expect(await allStreamsText(out)).not.toContain(hexText('Target page'))
  })

  it('keeps internal links of the primary file', async () => {
    const doc = await openDocument(await makeLinkedPdf(), 'links.pdf')
    const out = await exportDocument(doc)
    const internal = (await pageAnnotations(out, 2)).find((a) => a.subtype === 'Link' && !a.unsafeUrl)
    expect(internal?.dest).toBeTruthy()
  })
})

describe('export: blank documents', () => {
  it('exports a new document', async () => {
    const out = await exportDocument(createBlankDocument())
    const reloaded = await loadSource(out, 'new.pdf')
    expect(reloaded.pageCount).toBe(1)
    expect(reloaded.pageInfo![0].width).toBeCloseTo(A4[0])
    expect(reloaded.metadata.producer).toBe(PRODUCER)
    expect(reloaded.metadata.creator).toBe(PRODUCER)
  })
})
