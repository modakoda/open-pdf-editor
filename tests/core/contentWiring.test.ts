import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib'
import {
  addObject,
  duplicatePages,
  editContentItem,
  editField,
  exportDocument,
  getContentItems,
  insertSourcePages,
  loadSource,
  openDocument,
  pageNeedsPreview,
  renderPagePreview,
  setFormValue,
  updateSettings,
  type EditorDocument
} from '../../src/core'
import { FIXTURES, makeEditableFormPdf, makeExistingContentPdf, makeFormPdf, makeTextPdf } from '../fixtures/pdfs'
import { allPagesText, pageAnnotations, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

async function deleteText(doc: EditorDocument, pageId: string, text: string): Promise<EditorDocument> {
  const item = (await getContentItems(doc, pageId)).find((i) => i.text === text)
  if (!item) throw new Error(`no content item "${text}"`)
  return editContentItem(doc, pageId, item.id, { deleted: true })
}

describe('field edits in previews', () => {
  it('moves and deletes widgets of the page and flags the page', async () => {
    const doc = await openDocument(await makeEditableFormPdf(), 'f.pdf')
    const sid = doc.primarySourceId!
    const [p1, p2] = doc.pages.map((p) => p.id)
    expect(pageNeedsPreview(doc, p1)).toBe(false)
    let d = editField(doc, sid, 'name', { widgetBoxes: [{ x: 20, y: 30, width: 100, height: 25 }] })
    d = editField(d, sid, 'country', { deleted: true })
    d = editField(d, sid, 'agree', { readOnly: true })
    expect(pageNeedsPreview(d, p1)).toBe(true)
    expect(pageNeedsPreview(d, p2)).toBe(false)
    expect(pageNeedsPreview(editField(doc, sid, 'notes', { deleted: true }), p2)).toBe(true)
    expect(pageNeedsPreview(editField(doc, sid, 'notes', { readOnly: true }), p2)).toBe(false)
    const preview = await renderPagePreview(d, p1)
    const widgets = (await pageAnnotations(preview, 1)).filter((a) => a.subtype === 'Widget')
    expect(widgets.some((w) => w.fieldName === 'country')).toBe(false)
    const name = widgets.find((w) => w.fieldName === 'name')!
    expect(name.rect.map((v: number) => Math.round(v * 100) / 100)).toEqual([20, 841.89 - 55, 120, 841.89 - 30])
    expect(widgets.some((w) => w.fieldName === 'agree')).toBe(true)
  })
})

describe('the existing-content fixture', () => {
  it('is registered for the e2e tests', async () => {
    expect(FIXTURES['existing-content.pdf']).toBe(makeExistingContentPdf)
    const doc = await openDocument(await makeExistingContentPdf(), 'e.pdf')
    expect((await getContentItems(doc, doc.pages[0].id)).length).toBeGreaterThan(0)
  })
})

describe('content edits together with everything else that draws on a page', () => {
  it('pages from another file whose form is flattened', async () => {
    let doc = await openDocument(await makeTextPdf(1), 't.pdf')
    const form = await loadSource(await makeFormPdf(), 'f.pdf')
    doc = insertSourcePages(doc, form, 1, [0])
    doc = setFormValue(doc, form.id, 'name', 'Ona Šimkutė')
    doc = await deleteText(doc, doc.pages[1].id, 'Email')
    const text = (await allPagesText(await exportDocument(doc)))[1]
    expect(text).not.toContain('Email')
    expect(text).toContain('Name')
    expect(text).toContain('Ona Šimkutė')
    expect(text).toContain('Country')
  })

  it('duplicated form pages (widgets burned into the copy) edited independently', async () => {
    let doc = await openDocument(await makeFormPdf(), 'f.pdf')
    doc = setFormValue(doc, doc.primarySourceId!, 'name', 'Petras')
    doc = duplicatePages(doc, [doc.pages[0].id])
    doc = await deleteText(doc, doc.pages[1].id, 'Email')
    doc = await deleteText(doc, doc.pages[0].id, 'Notes')
    const out = await exportDocument(doc)
    const [first, copy] = await allPagesText(out)
    expect(first).toContain('Email')
    expect(first).not.toContain('Notes')
    expect(copy).not.toContain('Email')
    expect(copy).toContain('Notes')
    expect(copy).toContain('Petras')
    expect((await PDFDocument.load(out)).getForm().getTextField('name').getText()).toBe('Petras')
  })

  it('new fields, flattening and drawn objects on an edited page', async () => {
    let doc = await openDocument(await makeFormPdf(), 'f.pdf')
    const pageId = doc.pages[0].id
    doc = await deleteText(doc, pageId, 'Agree')
    doc = addObject(doc, { id: 'nf', pageId, type: 'field', fieldType: 'text', name: 'added', value: 'NEWFIELD', x: 300, y: 700, width: 150, height: 20 })
    doc = addObject(doc, { id: 'tx', pageId, type: 'text', x: 300, y: 750, width: 200, height: 20, text: 'DRAWN', font: 'sans', bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0 })
    doc = setFormValue(doc, doc.primarySourceId!, 'email', 'a@b.lt')
    const flat = await exportDocument(updateSettings(doc, { flattenForms: true }))
    const text = (await allPagesText(flat))[0]
    expect(text).not.toContain('Agree')
    for (const s of ['Name', 'Color', 'NEWFIELD', 'DRAWN', 'a@b.lt']) expect(text).toContain(s)
    expect((await PDFDocument.load(flat)).catalog.get(PDFName.of('AcroForm'))).toBeUndefined()
  })

  it('a reopened file with restored objects', async () => {
    let doc = await openDocument(await makeTextPdf(1), 't.pdf')
    const pageId = doc.pages[0].id
    doc = addObject(doc, { id: 'keep', pageId, type: 'text', x: 60, y: 300, width: 300, height: 30, text: 'Editor text', font: 'sans', bold: false, italic: false, fontSize: 14, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0 })
    const saved = await exportDocument(doc)
    let reopened = await openDocument(saved, 's.pdf')
    const rp = reopened.pages[0].id
    const items = await getContentItems(reopened, rp)
    expect(items.some((i) => i.text?.includes('Editor text'))).toBe(false)
    reopened = await deleteText(reopened, rp, 'Lorem ipsum dolor sit amet')
    const out = await exportDocument(reopened)
    const text = (await allPagesText(out))[0]
    expect(text).not.toContain('Lorem')
    expect(text.match(/Editor text/g)).toHaveLength(1)
    expect(text).toContain('Page 1')
    const preview = await renderPagePreview(reopened, rp)
    const previewText = (await allPagesText(preview))[0]
    expect(previewText).not.toContain('Lorem')
    expect(previewText).not.toContain('Editor text')
    expect(previewText).toContain('Page 1')
    // And it restores again.
    const third = await openDocument(out, 'o.pdf')
    expect(third.objects.map((o) => o.id)).toEqual(['keep'])
    const page = (await PDFDocument.load(out)).getPage(0)
    expect(page.node.lookup(PDFName.of('PieceInfo'), PDFDict).get(PDFName.of('OpenPDFEditor'))).toBeTruthy()
  })
})
