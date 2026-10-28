import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib'
import {
  addObject,
  exportDocument,
  getContentItems,
  insertSourcePages,
  loadSource,
  openDocument,
  pageNeedsPreview,
  renderPagePreview,
  type EditObject,
  type EditorDocument
} from '../../src/core'
import { stripMarkedContent } from '../../src/core/content'
import { makeTextPdf } from '../fixtures/pdfs'
import { TINY_JPEG, allPagesText, makePng, pageAnnotations, pageContent, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

/** The content-stream library (src/core/content) is developed in parallel. */
async function contentLibraryReady(): Promise<boolean> {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  try {
    stripMarkedContent(doc, page)
    return true
  } catch (e) {
    return !/not implemented/.test(String(e))
  }
}
const libraryReady = await contentLibraryReady()

function sampleObjects(p1: string, p2: string): EditObject[] {
  return [
    { id: 'obj_text', pageId: p1, type: 'text', x: 60, y: 200, width: 300, height: 40, text: 'Persisted Ąžuolas', font: 'serif', bold: true, italic: false, fontSize: 16, color: '#112233', align: 'left', lineHeight: 1.2, rotation: 15, background: null },
    { id: 'obj_png', pageId: p1, type: 'image', x: 60, y: 300, width: 80, height: 40, data: makePng(4, 2, [10, 20, 30]), mimeType: 'image/png', rotation: 0, opacity: 0.8 },
    { id: 'obj_jpg', pageId: p1, type: 'image', x: 160, y: 300, width: 40, height: 40, data: TINY_JPEG, mimeType: 'image/jpeg', rotation: 30 },
    { id: 'obj_rect', pageId: p1, type: 'rect', x: 60, y: 400, width: 100, height: 50, strokeColor: '#ff0000', fillColor: null, strokeWidth: 2, rotation: 0 },
    { id: 'obj_ink', pageId: p1, type: 'ink', paths: [[{ x: 10, y: 10 }, { x: 40, y: 30 }]], color: '#000000', strokeWidth: 3 },
    { id: 'obj_line', pageId: p2, type: 'line', x1: 10, y1: 500, x2: 200, y2: 520, color: '#00ff00', strokeWidth: 2, arrowEnd: true },
    { id: 'obj_hl', pageId: p2, type: 'highlight', x: 50, y: 60, width: 200, height: 14, color: '#ffeb3b' },
    { id: 'obj_white', pageId: p2, type: 'whiteout', x: 300, y: 60, width: 50, height: 20, color: '#ffffff' },
    { id: 'obj_note', pageId: p2, type: 'note', x: 400, y: 100, text: 'Persisted note', color: '#ff0000', author: 'Me' },
    { id: 'obj_field', pageId: p2, type: 'field', fieldType: 'text', name: 'persisted.field', value: 'hello', x: 100, y: 600, width: 150, height: 22 },
    { id: 'obj_radio1', pageId: p2, type: 'field', fieldType: 'radio', name: 'choice', exportValue: 'A', x: 100, y: 650, width: 14, height: 14 },
    { id: 'obj_radio2', pageId: p2, type: 'field', fieldType: 'radio', name: 'choice', exportValue: 'B', value: 'B', x: 130, y: 650, width: 14, height: 14 }
  ]
}

async function savedWithObjects(): Promise<{ doc: EditorDocument; out: Uint8Array; objects: EditObject[] }> {
  let doc = await openDocument(await makeTextPdf(2), 't.pdf')
  const objects = sampleObjects(doc.pages[0].id, doc.pages[1].id)
  for (const o of objects) doc = addObject(doc, o)
  return { doc, out: await exportDocument(doc), objects }
}

const withoutPageId = (o: EditObject) => {
  const { pageId: _p, ...rest } = o
  return rest
}

describe('saving editor objects', () => {
  it('wraps drawings in marked content and stores the objects in /PieceInfo', async () => {
    const { out } = await savedWithObjects()
    const content = await pageContent(out, 0)
    for (const id of ['obj_text', 'obj_png', 'obj_jpg', 'obj_rect', 'obj_ink']) {
      expect(content).toContain(`/OPEObject << /Id (${id}) >> BDC`)
    }
    expect(content.match(/EMC/g)?.length).toBeGreaterThanOrEqual(5)
    const pdf = await PDFDocument.load(out, { updateMetadata: false })
    const page = pdf.getPage(0)
    const data = page.node.lookup(PDFName.of('PieceInfo'), PDFDict).lookup(PDFName.of('OpenPDFEditor'), PDFDict)
    const lm = (o: unknown) => (o as PDFString).decodeText()
    expect(lm(data.lookup(PDFName.of('LastModified')))).toBe(lm(page.node.lookup(PDFName.of('LastModified'))))
    expect(data.lookup(PDFName.of('Private'), PDFDict).get(PDFName.of('Objects'))).toBeTruthy()
  })
})

describe('reopening a saved file', () => {
  it('restores the same objects (images byte-identical) without duplicating notes or fields', async () => {
    const { out, objects } = await savedWithObjects()
    const doc = await openDocument(out, 'saved.pdf')
    const src = doc.sources[doc.primarySourceId!]
    expect(src.pageInfo![0].restoredObjectIds).toEqual(['obj_text', 'obj_png', 'obj_jpg', 'obj_rect', 'obj_ink'])
    expect(src.pageInfo![1].restoredObjectIds).toHaveLength(7)
    expect(doc.objects.map((o) => o.id)).toEqual(objects.map((o) => o.id))
    for (const o of doc.objects) {
      const original = objects.find((x) => x.id === o.id)!
      expect(o.pageId).toBe(doc.pages[original.pageId === objects[0].pageId ? 0 : 1].id)
      if (o.type === 'field' && original.type === 'field') {
        expect({ ...withoutPageId(o), value: undefined }).toEqual({ ...withoutPageId(original), value: undefined })
        continue
      }
      expect(withoutPageId(o)).toEqual(withoutPageId(original))
    }
    const png = doc.objects.find((o) => o.id === 'obj_png')!
    expect(png.type === 'image' && Buffer.from(png.data).equals(Buffer.from((objects[1] as { data: Uint8Array }).data))).toBe(true)
    const jpg = doc.objects.find((o) => o.id === 'obj_jpg')!
    expect(jpg.type === 'image' && Buffer.from(jpg.data).equals(Buffer.from(TINY_JPEG))).toBe(true)
    // The real annotation / fields are represented by the objects only.
    expect(src.pageInfo![1].annotations).toEqual([])
    expect(src.formFields).toEqual([])
    // Field values come from the file.
    expect(doc.objects.find((o) => o.id === 'obj_field')).toMatchObject({ value: 'hello' })
    expect(doc.objects.find((o) => o.id === 'obj_radio1')).toMatchObject({ value: 'B' })
    expect(pageNeedsPreview(doc, doc.pages[0].id)).toBe(true)
  })

  it('restores from encrypted files', async () => {
    const { doc } = await savedWithObjects()
    const { updateSettings } = await import('../../src/core')
    const out = await exportDocument(updateSettings(doc, { encryption: { userPassword: 'pw' } }))
    const reopened = await openDocument(out, 'enc.pdf', { password: 'pw' })
    expect(reopened.objects.map((o) => o.id)).toEqual(doc.objects.map((o) => o.id))
    const png = reopened.objects.find((o) => o.id === 'obj_png')!
    const original = doc.objects.find((o) => o.id === 'obj_png')!
    expect(png.type === 'image' && original.type === 'image' && Buffer.from(png.data).equals(Buffer.from(original.data))).toBe(true)
  })

  it('picks up changes made to notes and field values by other viewers', async () => {
    const { out } = await savedWithObjects()
    const pdf = await PDFDocument.load(out)
    const annots = pdf.getPage(1).node.Annots()!
    for (let i = 0; i < annots.size(); i++) {
      const d = pdf.context.lookup(annots.get(i)) as PDFDict
      if ((d.lookup(PDFName.of('Subtype')) as PDFName).decodeText() === 'Text') d.set(PDFName.of('Contents'), PDFHexString.fromText('Edited elsewhere'))
    }
    pdf.getForm().getTextField('persisted.field').acroField.dict.set(PDFName.of('V'), PDFHexString.fromText('filled elsewhere'))
    const edited = await pdf.save({ updateFieldAppearances: false })
    const doc = await openDocument(edited, 'e.pdf')
    expect(doc.objects.find((o) => o.id === 'obj_note')).toMatchObject({ text: 'Edited elsewhere' })
    expect(doc.objects.find((o) => o.id === 'obj_field')).toMatchObject({ value: 'filled elsewhere' })
  })

  it('does not restore when the page content was modified elsewhere', async () => {
    const { out } = await savedWithObjects()
    const pdf = await PDFDocument.load(out)
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.getPage(0).drawText('added by another app', { x: 50, y: 50, font, size: 10 })
    const modified = await pdf.save()
    const doc = await openDocument(modified, 'm.pdf')
    const src = doc.sources[doc.primarySourceId!]
    expect(src.pageInfo![0].restoredObjectIds).toBeUndefined()
    expect(doc.objects.filter((o) => o.pageId === doc.pages[0].id)).toEqual([])
    // Page 2 was not touched and still restores.
    expect(src.pageInfo![1].restoredObjectIds).toHaveLength(7)
    // The drawings simply stay page content.
    expect((await allPagesText(modified))[0]).toContain('Persisted Ąžuolas')
  })

  it('does not restore when LastModified or the stored data do not match', async () => {
    const { out } = await savedWithObjects()
    const pdf = await PDFDocument.load(out)
    pdf.getPage(0).node.set(PDFName.of('LastModified'), PDFString.fromDate(new Date(2000, 0, 1)))
    const data = pdf.getPage(1).node.lookup(PDFName.of('PieceInfo'), PDFDict).lookup(PDFName.of('OpenPDFEditor'), PDFDict)
    const priv = data.lookup(PDFName.of('Private'), PDFDict)
    priv.set(PDFName.of('Objects'), pdf.context.register(pdf.context.flateStream('{"version":1,"objects":[{"id":"x"')))
    const doc = await openDocument(await pdf.save(), 'm.pdf')
    expect(doc.objects).toEqual([])
    const src = doc.sources[doc.primarySourceId!]
    // Not restored → the note and fields are ordinary annotations / fields again.
    expect(src.pageInfo![1].annotations!.map((a) => a.subtype)).toEqual(['Text'])
    expect(src.formFields.map((f) => f.name).sort()).toEqual(['choice', 'persisted.field'])
  })

  it('insertSourcePages brings the restored objects along, with fresh ids and names when needed', async () => {
    const { out } = await savedWithObjects()
    const saved = await loadSource(out, 'saved.pdf')
    let doc = await openDocument(await makeTextPdf(1), 'base.pdf')
    doc = insertSourcePages(doc, saved, 1, [1])
    expect(doc.objects.map((o) => o.id)).toEqual(saved.pageInfo![1].restoredObjectIds)
    expect(doc.objects.every((o) => o.pageId === doc.pages[1].id)).toBe(true)
    doc = insertSourcePages(doc, saved, 2, [1])
    const second = doc.objects.filter((o) => o.pageId === doc.pages[2].id)
    expect(second).toHaveLength(7)
    expect(new Set(doc.objects.map((o) => o.id)).size).toBe(14)
    const names = second.flatMap((o) => (o.type === 'field' ? [o.name] : []))
    expect(names).toEqual(['persisted.field_2', 'choice_2', 'choice_2'])
  })
})

describe.skipIf(!libraryReady)('re-exporting a reopened file (needs the content library)', () => {
  it('draws every object exactly once', async () => {
    const { out } = await savedWithObjects()
    const again = await exportDocument(await openDocument(out, 'saved.pdf'))
    const text = (await allPagesText(again))[0]
    expect(text.match(/Persisted Ąžuolas/g)).toHaveLength(1)
    expect((await pageAnnotations(again, 2)).filter((a) => a.subtype === 'Text')).toHaveLength(1)
    const pdf = await PDFDocument.load(again)
    expect(pdf.getForm().getFields().map((f) => f.getName()).sort()).toEqual(['choice', 'persisted.field'])
    const third = await openDocument(again, 'again.pdf')
    expect(third.objects.map((o) => o.id)).toHaveLength(12)
  })

  it('removes the drawings of deleted objects and hides restored drawings in previews', async () => {
    const { out } = await savedWithObjects()
    let doc = await openDocument(out, 'saved.pdf')
    doc = { ...doc, objects: doc.objects.filter((o) => o.id !== 'obj_text' && o.id !== 'obj_note') }
    const again = await exportDocument(doc)
    expect((await allPagesText(again))[0]).not.toContain('Persisted')
    expect((await pageAnnotations(again, 2)).filter((a) => a.subtype === 'Text')).toHaveLength(0)
    const preview = await renderPagePreview(doc, doc.pages[0].id)
    expect((await allPagesText(preview))[0]).not.toContain('Persisted')
    expect((await allPagesText(preview))[0]).toContain('Page 1')
    const items = await getContentItems(doc, doc.pages[0].id)
    expect(items.some((i) => i.text?.includes('Persisted'))).toBe(false)
  })
})
