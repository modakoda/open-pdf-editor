/** Regression tests for the second engine review (field edits vs. deleted pages, flattened
 * FieldObjects, annotation edits, duplicated /PieceInfo, deleted widgets / containers). */
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from '@cantoo/pdf-lib'
import {
  addObject,
  deletePages,
  duplicatePages,
  editAnnotation,
  editContentItem,
  editField,
  effectiveContentEdits,
  exportDocument,
  getContentItems,
  getEffectiveFormFields,
  loadSource,
  openDocument,
  pageNeedsPreview,
  renderPagePreview,
  updateObject,
  updateSettings,
  type FieldObject
} from '../../src/core'
import {
  makeEditableFormPdf,
  makeExistingContentPdf,
  makeSplitWidgetsPdf,
  makeStyledFreeTextPdf,
  makeTextPdf,
  makeYesNoCheckboxPdf
} from '../fixtures/pdfs'
import { allPagesText, allStreamsText, hexText, pageAnnotations, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

describe('field edits and deleted pages', () => {
  it('a renamed field whose only page was deleted is removed, and the output is valid', async () => {
    let doc = await openDocument(await makeSplitWidgetsPdf(), 'f.pdf')
    const sid = doc.primarySourceId!
    doc = editField(doc, sid, 'gone', { name: 'renamed', fontSize: 9 })
    doc = deletePages(doc, [doc.pages[1].id])
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'o.pdf')
    expect(re.formFields.map((f) => f.name).sort()).toEqual(['keep', 'split'])
    const pdf = await PDFDocument.load(out)
    for (const f of pdf.getForm().getFields()) expect(() => f.acroField.getWidgets()).not.toThrow()
    expect((await allStreamsText(out)).includes(hexText('secret on deleted page'))).toBe(false)
  })

  it('widget moves index the original widgets even when another widget’s page is deleted', async () => {
    let doc = await openDocument(await makeSplitWidgetsPdf(), 'f.pdf')
    const sid = doc.primarySourceId!
    doc = editField(doc, sid, 'split', { widgetBoxes: [undefined as never, { x: 300, y: 400, width: 100, height: 30 }] })
    doc = deletePages(doc, [doc.pages[0].id])
    const re = await loadSource(await exportDocument(doc), 'o.pdf')
    const split = re.formFields.find((f) => f.name === 'split')!
    expect(split.widgets).toEqual([{ pageIndex: 0, box: { x: 300, y: 400, width: 100, height: 30 } }])
  })
})

describe('FieldEdit.deletedWidgets', () => {
  it('removes single widgets in export, preview, effective fields and flags the page', async () => {
    const doc = await openDocument(await makeSplitWidgetsPdf(), 'f.pdf')
    const sid = doc.primarySourceId!
    const [p1, p2] = doc.pages.map((p) => p.id)
    const d = editField(doc, sid, 'split', { deletedWidgets: [1] })
    expect(pageNeedsPreview(d, p2)).toBe(true)
    expect(pageNeedsPreview(d, p1)).toBe(false)
    expect(getEffectiveFormFields(d, sid).find((f) => f.name === 'split')!.widgets.map((w) => w.pageIndex)).toEqual([0])
    const re = await loadSource(await exportDocument(d), 'o.pdf')
    const split = re.formFields.find((f) => f.name === 'split')!
    expect(split.widgets.map((w) => w.pageIndex)).toEqual([0])
    expect(split.value).toBe('Jane')
    const preview = await renderPagePreview(d, p2)
    expect((await pageAnnotations(preview, 1)).filter((a) => a.fieldName === 'split')).toEqual([])
    expect((await pageAnnotations(preview, 1)).filter((a) => a.fieldName === 'gone')).toHaveLength(1)
  })

  it('deleting the last widget deletes the field', async () => {
    const doc = await openDocument(await makeSplitWidgetsPdf(), 'f.pdf')
    const sid = doc.primarySourceId!
    const d = editField(doc, sid, 'split', { deletedWidgets: [0, 1] })
    expect(getEffectiveFormFields(d, sid).some((f) => f.name === 'split')).toBe(false)
    const re = await loadSource(await exportDocument(d), 'o.pdf')
    expect(re.formFields.map((f) => f.name).sort()).toEqual(['gone', 'keep'])
  })
})

describe('renaming export values of buttons keeps the selection', () => {
  it('radio groups with /Opt', async () => {
    const doc = await openDocument(await makeEditableFormPdf(), 'f.pdf')
    const out = await exportDocument(editField(doc, doc.primarySourceId!, 'color', { options: ['rot', 'grün'] }))
    const color = (await loadSource(out, 'o.pdf')).formFields.find((f) => f.name === 'color')!
    expect(color.options).toEqual(['rot', 'grün'])
    expect(color.value).toBe('grün')
    expect(color.widgets.map((w) => w.onValue)).toEqual(['rot', 'grün'])
  })

  it('checkbox groups without /Opt (on-state names renamed)', async () => {
    const doc = await openDocument(await makeYesNoCheckboxPdf(), 'c.pdf')
    const out = await exportDocument(editField(doc, doc.primarySourceId!, 'married', { options: ['Ja', 'Nein'] }))
    const f = (await loadSource(out, 'o.pdf')).formFields[0]
    expect(f).toMatchObject({ type: 'radio', value: 'Nein', options: ['Ja', 'Nein'] })
    const cb = (await PDFDocument.load(out)).getForm().getCheckBox('married')
    expect(cb.acroField.getWidgets().map((w) => w.getAppearanceState()?.toString())).toEqual(['/Off', '/Nein'])
  })
})

describe('flattened FieldObjects stay editable after reopening', () => {
  it('the burned copy is marked and replaced on the next save', async () => {
    let doc = await openDocument(await makeTextPdf(1), 't.pdf')
    const field: FieldObject = { id: 'obj_f', pageId: doc.pages[0].id, type: 'field', fieldType: 'text', name: 'amount', value: 'OLDVALUE', x: 100, y: 300, width: 150, height: 22 }
    doc = updateSettings(addObject(doc, field), { flattenForms: true })
    const out1 = await exportDocument(doc)
    expect((await allPagesText(out1))[0]).toContain('OLDVALUE')
    let doc2 = await openDocument(out1, 'out1.pdf')
    expect(doc2.objects).toMatchObject([{ id: 'obj_f', type: 'field', value: 'OLDVALUE' }])
    doc2 = updateObject(doc2, 'obj_f', { value: 'NEWVALUE', x: 300, y: 400 } as never)
    // Saved again with flattening: only the new value is burned in.
    const flat = await exportDocument(updateSettings(doc2, { flattenForms: true }))
    const text = (await allPagesText(flat))[0]
    expect(text).toContain('NEWVALUE')
    expect(text).not.toContain('OLDVALUE')
    // Saved without flattening: a live field with the new value, no stale burned copy.
    const live = await exportDocument(doc2)
    expect((await allPagesText(live))[0]).not.toContain('OLDVALUE')
    expect((await PDFDocument.load(live)).getForm().getTextField('amount').getText()).toBe('NEWVALUE')
  })
})

describe('duplicated pages keep their own /PieceInfo', () => {
  it('restores the objects of both copies and keeps other applications’ data', async () => {
    const pdf = await PDFDocument.create()
    const p = pdf.addPage([600, 800])
    p.drawText('hello', { x: 50, y: 700 })
    p.node.set(PDFName.of('PieceInfo'), pdf.context.obj({ Illustrator: { LastModified: PDFString.of('D:2020'), Private: {} } }) as never)
    let doc = await openDocument(await pdf.save(), 'a.pdf')
    doc = duplicatePages(doc, [doc.pages[0].id])
    const rect = (id: string, pageId: string, x: number) =>
      ({ id, pageId, type: 'rect', x, y: 10, width: 50, height: 50, strokeColor: '#ff0000', fillColor: null, strokeWidth: 2, rotation: 0 }) as const
    doc = addObject(doc, rect('o1', doc.pages[0].id, 10))
    doc = addObject(doc, rect('o2', doc.pages[1].id, 100))
    const out = await exportDocument(doc)
    const re = await openDocument(out, 'b.pdf')
    expect(re.objects.map((o) => [o.id, re.pages.findIndex((pg) => pg.id === o.pageId)])).toEqual([
      ['o1', 0],
      ['o2', 1]
    ])
    const saved = await PDFDocument.load(out)
    for (const page of saved.getPages()) {
      expect(page.node.lookup(PDFName.of('PieceInfo'), PDFDict).get(PDFName.of('Illustrator'))).toBeTruthy()
    }
  })
})

describe('annotation edits keep styling', () => {
  const apText = (d: PDFDict) =>
    new TextDecoder().decode(decodePDFRawStream(d.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream).decode())
  async function annots(bytes: Uint8Array): Promise<PDFDict[]> {
    const pdf = await PDFDocument.load(bytes)
    const arr = pdf.getPage(0).node.Annots()!
    return Array.from({ length: arr.size() }, (_, i) => pdf.context.lookup(arr.get(i)) as PDFDict)
  }

  it('moving keeps the original appearance; changing contents drops stale rich text', async () => {
    const doc = await openDocument(await makeStyledFreeTextPdf(), 'a.pdf')
    const pageId = doc.pages[0].id
    const [ft] = doc.sources[doc.primarySourceId!].pageInfo![0].annotations!
    let d = editAnnotation(doc, pageId, 'a0', { bounds: { ...ft.bounds, x: ft.bounds.x + 50 } })
    d = editAnnotation(d, pageId, 'a1', { contents: 'new comment' })
    const [free, sticky] = await annots(await exportDocument(d))
    expect(apText(free)).toBe('1 1 0.8 rg 0 0 300 60 re f BT /F1 18 Tf 0 0 0.8 rg 60 25 Td (Centered Courier) Tj ET')
    expect(free.get(PDFName.of('RC'))).toBeTruthy()
    expect(sticky.get(PDFName.of('RC'))).toBeUndefined()
  })

  it('regenerated FreeText appearances use the /DA font and /Q alignment', async () => {
    const doc = await openDocument(await makeStyledFreeTextPdf(), 'a.pdf')
    const out = await exportDocument(editAnnotation(doc, doc.pages[0].id, 'a0', { contents: 'Short' }))
    const [free] = await annots(out)
    expect(free.get(PDFName.of('RC'))).toBeUndefined()
    const n = free.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream
    const fonts = n.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    const f1 = fonts.lookup(PDFName.of('F1'), PDFDict)
    expect(f1.lookup(PDFName.of('BaseFont'))?.toString()).toBe('/Courier')
    // Centered: "Short" (5 × 600/1000 × 18 = 54pt wide) in a 300pt box → starts near x 123.
    const x = Number(/BT \/F1 18 Tf ([\d.]+) /.exec(apText(free))![1])
    expect(x).toBeGreaterThan(110)
    expect(x).toBeLessThan(130)
  })

  it('hidden annotations are not listed', async () => {
    const src = await loadSource(await makeStyledFreeTextPdf(), 'a.pdf')
    expect(src.pageInfo![0].annotations!.map((a) => a.id)).toEqual(['a0', 'a1'])
  })
})

describe('edits inside a deleted container are ignored', () => {
  it('filters descendant edits', () => {
    expect(
      effectiveContentEdits([
        { itemId: 'x1', deleted: true },
        { itemId: 'x1/t3', text: 'ignored' },
        { itemId: 'x10/t1', deleted: true },
        { itemId: 't6', color: '#ff0000' }
      ]).map((e) => e.itemId)
    ).toEqual(['x1', 'x10/t1', 't6'])
    expect(effectiveContentEdits(undefined)).toEqual([])
  })

  it('export and preview delete the container even with edits to its children', async () => {
    const doc = await openDocument(await makeExistingContentPdf(), 'e.pdf')
    const pageId = doc.pages[1].id
    const items = await getContentItems(doc, pageId)
    expect(items.map((i) => i.id)).toContain('x1/t3')
    let d = editContentItem(doc, pageId, 'x1/t3', { text: 'Changed', transform: [1, 0, 0, 1, 10, 10] })
    d = editContentItem(d, pageId, 'x1', { deleted: true })
    expect((await allPagesText(await exportDocument(d)))[1]).not.toMatch(/Wrapped title|Changed/)
    expect((await allPagesText(await renderPagePreview(d, pageId)))[0]).not.toMatch(/Wrapped title|Changed/)
  })
})
