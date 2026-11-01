import { beforeAll, describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib'
import {
  duplicatePages,
  editAnnotation,
  exportDocument,
  getPageAnnotations,
  insertSourcePages,
  loadSource,
  openDocument,
  pageNeedsPreview,
  renderPagePreview,
  type EditorDocument
} from '../../src/core'
import { makeAnnotatedPdf, makeFormPdf, makeMarkupAnnotationsPdf, makeTextPdf } from '../fixtures/pdfs'
import { pageAnnotations, pageInfo, registerTestFonts, timeBudget } from './helpers'

beforeAll(() => registerTestFonts())

const nums = (o: unknown) => {
  const a = o as PDFArray
  return Array.from({ length: a.size() }, (_, i) => (a.lookup(i) as PDFNumber).asNumber())
}

async function annotDicts(bytes: Uint8Array, pageIndex = 0): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const annots = doc.getPage(pageIndex).node.Annots()
  if (!annots) return []
  return Array.from({ length: annots.size() }, (_, i) => doc.context.lookup(annots.get(i)) as PDFDict)
}

const subtype = (d: PDFDict) => (d.lookup(PDFName.of('Subtype')) as PDFName).decodeText()

function apContent(d: PDFDict): string {
  const ap = d.lookup(PDFName.of('AP'), PDFDict)
  return new TextDecoder().decode(decodePDFRawStream(ap.lookup(PDFName.of('N')) as PDFRawStream).decode())
}

describe('reading annotations', () => {
  it('lists annotations with page-space bounds, contents, author, color and uri', async () => {
    const src = await loadSource(await makeMarkupAnnotationsPdf(), 'm.pdf')
    const annots = src.pageInfo![0].annotations!
    expect(annots.map((a) => a.subtype)).toEqual([
      'Square',
      'Circle',
      'Line',
      'Ink',
      'Highlight',
      'Underline',
      'StrikeOut',
      'Squiggly',
      'FreeText',
      'Text',
      'Link',
      'Stamp'
    ])
    // Ids are positions in /Annots (the popup a10 and the widget a13 are left out).
    expect(annots.map((a) => a.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a11', 'a12'])
    const square = annots[0]
    expect(square).toMatchObject({ contents: 'square note', author: 'Ann', color: '#ff0000' })
    expect(square.bounds).toEqual({ x: 100, y: 841.89 - 560, width: 100, height: 60 })
    expect(annots.find((a) => a.subtype === 'FreeText')).toMatchObject({ color: '#0000ff', contents: 'Free text', author: 'Writer' })
    expect(annots.find((a) => a.subtype === 'Link')!.uri).toBe('https://example.com/old')
    // Stable across loads
    const again = await loadSource(await makeMarkupAnnotationsPdf(), 'm.pdf')
    expect(again.pageInfo![0].annotations!.map((a) => a.id)).toEqual(annots.map((a) => a.id))
  })

  it('uses the visible box on cropped pages and unrotated page space on rotated pages', async () => {
    const cropped = (await loadSource(await makeMarkupAnnotationsPdf({ cropped: true }), 'c.pdf')).pageInfo![0].annotations!
    // Crop box [50 100 550 700]: Rect [100 500 200 560] → x 50, y 700-560 = 140
    expect(cropped[0].bounds).toEqual({ x: 50, y: 140, width: 100, height: 60 })
    const rotated = (await loadSource(await makeMarkupAnnotationsPdf({ rotate: 90 }), 'r.pdf')).pageInfo![0].annotations!
    expect(rotated[0].bounds).toEqual({ x: 100, y: 841.89 - 560, width: 100, height: 60 })
  })

  it('reports whether an annotation has an appearance; exported notes always get one', async () => {
    const src = await loadSource(await makeMarkupAnnotationsPdf(), 'm.pdf')
    const byType = Object.fromEntries(src.pageInfo![0].annotations!.map((a) => [a.subtype, a.hasAppearance]))
    expect(byType.Stamp).toBe(true)
    expect(byType.Text).toBe(false)
    expect(byType.Square).toBe(false)
    // After an edit that regenerates it, the square has one.
    const d0 = await openDocument(await makeMarkupAnnotationsPdf(), 'm.pdf')
    const out = await exportDocument(editAnnotation(d0, d0.pages[0].id, 'a0', { color: '#0000ff' }))
    const re = await loadSource(out, 'o.pdf')
    expect(re.pageInfo![0].annotations!.find((a) => a.subtype === 'Square')!.hasAppearance).toBe(true)
    // Notes drawn by the editor are real Text annotations with an appearance stream.
    const { addObject } = await import('../../src/core')
    let d = await openDocument(await makeTextPdf(1), 't.pdf')
    d = addObject(d, { id: 'n1', pageId: d.pages[0].id, type: 'note', x: 100, y: 100, text: 'hi', color: '#00aa00' })
    const withNote = await exportDocument(d)
    const note = (await pageAnnotations(withNote, 1)).find((a) => a.subtype === 'Text')!
    expect(note.hasAppearance).toBe(true)
    const dict = (await annotDicts(withNote)).find((x) => subtype(x) === 'Text')!
    expect(apContent(dict)).toContain('0 0.667 0 rg')
  })

  it('leaves out widgets and has none for plain pages', async () => {
    const form = await loadSource(await makeFormPdf(), 'f.pdf')
    expect(form.pageInfo!.every((p) => p.annotations!.length === 0)).toBe(true)
    const annotated = await loadSource(await makeAnnotatedPdf(), 'a.pdf')
    expect(annotated.pageInfo![0].annotations!.map((a) => [a.subtype, a.contents ?? a.uri])).toEqual([
      ['Link', 'https://example.com'],
      ['Text', 'Existing note']
    ])
  })
})

describe('editing annotations', () => {
  let doc: EditorDocument
  beforeAll(async () => {
    doc = await openDocument(await makeMarkupAnnotationsPdf(), 'm.pdf')
  })

  it('getPageAnnotations reflects edits and pageNeedsPreview flags the page', () => {
    const pageId = doc.pages[0].id
    let d = editAnnotation(doc, pageId, 'a0', { contents: 'changed' })
    d = editAnnotation(d, pageId, 'a1', { deleted: true })
    expect(getPageAnnotations(d, pageId).find((a) => a.id === 'a0')!.contents).toBe('changed')
    expect(getPageAnnotations(d, pageId).some((a) => a.id === 'a1')).toBe(false)
    expect(pageNeedsPreview(d, pageId)).toBe(true)
    expect(pageNeedsPreview(doc, pageId)).toBe(false)
    // Clearing an edit removes it.
    const cleared = editAnnotation(d, pageId, 'a0', { contents: undefined })
    expect(cleared.annotationEdits![pageId].some((e) => e.annotId === 'a0')).toBe(false)
  })

  it('deletes annotations together with their popup', async () => {
    const pageId = doc.pages[0].id
    let d = editAnnotation(doc, pageId, 'a9', { deleted: true })
    d = editAnnotation(d, pageId, 'a11', { deleted: true })
    const out = await exportDocument(d)
    const subtypes = (await annotDicts(out)).map(subtype)
    expect(subtypes).not.toContain('Text')
    expect(subtypes).not.toContain('Popup')
    expect(subtypes).not.toContain('Link')
    expect(subtypes).toContain('Widget')
    expect(subtypes).toContain('Square')
  })

  it('moves and resizes annotations with their geometry', async () => {
    const pageId = doc.pages[0].id
    const H = 841.89
    let d = editAnnotation(doc, pageId, 'a4', { bounds: { x: 300, y: H - 220, width: 300, height: 20 } }) // highlight
    d = editAnnotation(d, pageId, 'a3', { bounds: { x: 0, y: 100, width: 200, height: 160 } }) // ink 100x80 → 200x160
    d = editAnnotation(d, pageId, 'a2', { bounds: { x: 0, y: 0, width: 200, height: 40 } }) // line
    const out = await exportDocument(d)
    const dicts = await annotDicts(out)
    const hl = dicts.find((x) => subtype(x) === 'Highlight')!
    expect(nums(hl.lookup(PDFName.of('Rect')))).toEqual([300, 200, 600, 220])
    expect(nums(hl.lookup(PDFName.of('QuadPoints')))).toEqual([300, 220, 600, 220, 300, 200, 600, 200])
    const ink = dicts.find((x) => subtype(x) === 'Ink')!
    const inkRect = nums(ink.lookup(PDFName.of('Rect')))
    expect(inkRect[0]).toBe(0)
    expect(inkRect[1]).toBeCloseTo(H - 260)
    expect(inkRect[2]).toBe(200)
    expect(inkRect[3]).toBeCloseTo(H - 100)
    const inkPts = nums(ink.lookup(PDFName.of('InkList'), PDFArray).lookup(0))
    // (330,450) in the old rect [320 440 420 520], scaled 2x → (0 + 10*2, rectY + 10*2)
    expect(inkPts[0]).toBeCloseTo(20)
    expect(inkPts[1]).toBeCloseTo(H - 260 + 20)
    const line = dicts.find((x) => subtype(x) === 'Line')!
    const rect = nums(line.lookup(PDFName.of('Rect')))
    expect(rect).toEqual([0, H - 40, 200, H])
    const l = nums(line.lookup(PDFName.of('L')))
    expect(l[0]).toBeCloseTo(5)
    expect(l[1]).toBeCloseTo(H - 40 + 10)
    // pdf.js sees the new rectangles
    const pj = await pageAnnotations(out, 1)
    expect(pj.find((a) => a.subtype === 'Highlight')!.rect.map((v: number) => Math.round(v))).toEqual([300, 200, 600, 220])
  })

  it('changes contents, author, color and uri and regenerates appearances', async () => {
    const pageId = doc.pages[0].id
    let d = editAnnotation(doc, pageId, 'a0', { color: '#00ff00', contents: 'new note', author: 'Bob' })
    d = editAnnotation(d, pageId, 'a8', { contents: 'Ąžuolas text', color: '#ff0000' })
    d = editAnnotation(d, pageId, 'a11', { uri: 'https://example.org/new' })
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a9']) d = editAnnotation(d, pageId, id, { color: '#123456' })
    const out = await exportDocument(d)
    const dicts = await annotDicts(out)
    const square = dicts.find((x) => subtype(x) === 'Square')!
    expect(nums(square.lookup(PDFName.of('C')))).toEqual([0, 1, 0])
    expect(apContent(square)).toContain('0 1 0 RG')
    expect(apContent(square)).toContain('1 1 0 rg') // interior color kept
    for (const t of ['Circle', 'Line', 'Ink', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text']) {
      const a = dicts.find((x) => subtype(x) === t)!
      expect(apContent(a), t).toMatch(/0\.071 0\.204 0\.337 (RG|rg)/)
    }
    const hl = dicts.find((x) => subtype(x) === 'Highlight')!
    const gs = hl.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream
    expect(gs.dict.lookup(PDFName.of('Resources'), PDFDict).toString()).toContain('/Multiply')
    const pj = await pageAnnotations(out, 1)
    const sq = pj.find((a) => a.subtype === 'Square')!
    expect(sq.contentsObj.str).toBe('new note')
    expect(sq.titleObj.str).toBe('Bob')
    expect(pj.find((a) => a.subtype === 'Link')!.unsafeUrl).toBe('https://example.org/new')
    const ft = pj.find((a) => a.subtype === 'FreeText')!
    expect(ft.contentsObj.str).toBe('Ąžuolas text')
    // The FreeText appearance draws the new text with a font that has the glyphs.
    const reloaded = await loadSource(out, 'o.pdf')
    expect(reloaded.pageInfo![0].annotations!.find((a) => a.subtype === 'FreeText')!.color).toBe('#ff0000')
    // Untouched annotations keep their appearance (the stamp).
    const stamp = dicts.find((x) => subtype(x) === 'Stamp')!
    expect(apContent(stamp)).toBe('0 0.5 0 rg 0 0 100 40 re f')
    // No temporary keys are left in the file.
    expect(dicts.every((x) => !x.has(PDFName.of('OPEAnnotId')))).toBe(true)
  })

  it('works on rotated and cropped pages (bounds in page space)', async () => {
    for (const opts of [{ rotate: 90 }, { cropped: true }]) {
      const d0 = await openDocument(await makeMarkupAnnotationsPdf(opts), 'x.pdf')
      const pageId = d0.pages[0].id
      const out = await exportDocument(editAnnotation(d0, pageId, 'a0', { bounds: { x: 10, y: 20, width: 30, height: 40 } }))
      const square = (await annotDicts(out)).find((x) => subtype(x) === 'Square')!
      const [vb] = (await pageInfo(out)).map((p) => p.view)
      expect(nums(square.lookup(PDFName.of('Rect')))).toEqual([vb[0] + 10, vb[3] - 60, vb[0] + 40, vb[3] - 20])
      const re = await loadSource(out, 'o.pdf')
      expect(re.pageInfo![0].annotations![0].bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    }
  })

  it('applies to duplicated pages independently', async () => {
    let d = duplicatePages(doc, [doc.pages[0].id])
    d = editAnnotation(d, d.pages[1].id, 'a0', { deleted: true })
    d = editAnnotation(d, d.pages[0].id, 'a1', { contents: 'only on first' })
    const out = await exportDocument(d)
    const first = await annotDicts(out, 0)
    const second = await annotDicts(out, 1)
    expect(first.map(subtype)).toContain('Square')
    expect(second.map(subtype)).not.toContain('Square')
    const circle = (list: PDFDict[]) => list.find((x) => subtype(x) === 'Circle')!.lookup(PDFName.of('Contents'))
    expect((circle(first) as unknown as { decodeText(): string }).decodeText()).toBe('only on first')
    expect(circle(second)).toBeUndefined()
  })

  it('applies to pages inserted from other files', async () => {
    let d = await openDocument(await makeTextPdf(1), 't.pdf')
    d = insertSourcePages(d, await loadSource(await makeMarkupAnnotationsPdf(), 'm.pdf'), 1)
    d = editAnnotation(d, d.pages[1].id, 'a9', { contents: 'edited sticky' })
    d = editAnnotation(d, d.pages[1].id, 'a0', { deleted: true })
    const out = await exportDocument(d)
    const pj = await pageAnnotations(out, 2)
    expect(pj.find((a) => a.subtype === 'Text')!.contentsObj.str).toBe('edited sticky')
    expect(pj.some((a) => a.subtype === 'Square')).toBe(false)
  })

  it('renderPagePreview shows annotation edits and keeps rotation and boxes', async () => {
    const d0 = await openDocument(await makeMarkupAnnotationsPdf({ rotate: 90, cropped: true }), 'x.pdf')
    const pageId = d0.pages[0].id
    const d = editAnnotation(d0, pageId, 'a0', { deleted: true })
    const t = performance.now()
    const preview = await renderPagePreview(d, pageId)
    const first = performance.now() - t
    const info = await pageInfo(preview)
    expect(info).toEqual([{ rotate: 90, view: [50, 100, 550, 700] }])
    const subtypes = (await pageAnnotations(preview, 1)).map((a) => a.subtype)
    expect(subtypes).not.toContain('Square')
    expect(subtypes).toContain('Circle')
    const t2 = performance.now()
    await renderPagePreview(editAnnotation(d, pageId, 'a1', { deleted: true }), pageId)
    expect(performance.now() - t2).toBeLessThan(timeBudget(200))
    expect(first).toBeLessThan(timeBudget(2000))
  })
})
