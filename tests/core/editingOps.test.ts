import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import {
  addObject,
  deletePages,
  duplicatePages,
  editAnnotation,
  editContentItem,
  editField,
  exportDocument,
  getContentEdit,
  getContentItems,
  getEffectiveFormFields,
  getFieldEdit,
  openDocument,
  pageNeedsPreview,
  renderPagePreview,
  type EditorDocument,
  type FieldObject
} from '../../src/core'
import { makeEditableFormPdf, makeTextPdf } from '../fixtures/pdfs'
import { allPagesText, deepFreeze, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

let base: EditorDocument
beforeAll(async () => {
  base = deepFreeze(await openDocument(await makeEditableFormPdf(), 'f.pdf'))
})

describe('content, annotation and field edit operations', () => {
  it('editContentItem merges patches, drops emptied edits and never mutates', () => {
    const pageId = base.pages[0].id
    let d = editContentItem(base, pageId, 'c1', { deleted: true })
    d = editContentItem(d, pageId, 'c2', { transform: [1, 0, 0, 1, 5, 6] })
    d = editContentItem(d, pageId, 'c2', { color: '#ff0000' })
    expect(getContentEdit(d, pageId, 'c2')).toEqual({ itemId: 'c2', transform: [1, 0, 0, 1, 5, 6], color: '#ff0000' })
    d = editContentItem(d, pageId, 'c1', { deleted: undefined })
    expect(getContentEdit(d, pageId, 'c1')).toBeUndefined()
    expect(pageNeedsPreview(d, pageId)).toBe(true)
    expect(base.contentEdits).toBeUndefined()
  })

  it('editField merges, supports null and is reflected by getEffectiveFormFields', () => {
    const sid = base.primarySourceId!
    let d = editField(base, sid, 'name', { name: 'renamed', maxLength: 5 })
    d = editField(d, sid, 'name', { maxLength: null, readOnly: true })
    expect(getFieldEdit(d, sid, 'name')).toEqual({ name: 'renamed', maxLength: null, readOnly: true })
    const f = getEffectiveFormFields(d, sid).find((x) => x.originalName === 'name')!
    expect(f).toMatchObject({ name: 'renamed', readOnly: true, originalName: 'name' })
    expect(f.maxLength).toBeUndefined()
    d = editField(d, sid, 'country', { deleted: true })
    expect(getEffectiveFormFields(d, sid).map((x) => x.originalName)).not.toContain('country')
    d = editField(d, sid, 'name', { name: undefined, maxLength: undefined, readOnly: undefined })
    expect(getFieldEdit(d, sid, 'name')).toBeUndefined()
  })

  it('deletePages drops and duplicatePages copies the per-page edits', () => {
    const [p1, p2] = base.pages.map((p) => p.id)
    let d = editContentItem(base, p1, 'c1', { deleted: true })
    d = editAnnotation(d, p1, 'a0', { contents: 'x' })
    d = editContentItem(d, p2, 'c9', { deleted: true })
    const dup = duplicatePages(d, [p1])
    const copy = dup.pages[1].id
    expect(dup.contentEdits![copy]).toEqual(d.contentEdits![p1])
    expect(dup.annotationEdits![copy]).toEqual(d.annotationEdits![p1])
    const del = deletePages(d, [p1])
    expect(Object.keys(del.contentEdits!)).toEqual([p2])
    expect(Object.keys(del.annotationEdits!)).toEqual([])
  })

  it('duplicated FieldObjects get unique names (radio groups stay together)', () => {
    const pageId = base.pages[0].id
    const f = (patch: Partial<FieldObject>): FieldObject => ({
      id: patch.id!,
      pageId,
      type: 'field',
      fieldType: 'text',
      name: 'n',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      ...patch
    })
    let d = addObject(base, f({ id: 'a', name: 'email' }))
    d = addObject(d, f({ id: 'b', name: 'pick', fieldType: 'radio', exportValue: '1' }))
    d = addObject(d, f({ id: 'c', name: 'pick', fieldType: 'radio', exportValue: '2' }))
    d = duplicatePages(d, [pageId])
    const copies = d.objects.filter((o): o is FieldObject => o.type === 'field' && o.pageId === d.pages[1].id)
    expect(copies.map((o) => o.name)).toEqual(['email_2', 'pick_2', 'pick_2'])
    d = duplicatePages(d, [d.pages[0].id])
    const third = d.objects.filter((o): o is FieldObject => o.type === 'field' && o.pageId === d.pages[1].id)
    expect(third.map((o) => o.name)).toEqual(['email_3', 'pick_3', 'pick_3'])
    // Suffixes skip names already used by fields of the file or other objects.
    const clash = duplicatePages(addObject(base, f({ id: 'z', name: 'name_2' })), [pageId])
    expect(clash.objects.filter((o) => o.type === 'field' && o.pageId === clash.pages[1].id).map((o) => (o as FieldObject).name)).toEqual(['name_2_2'])
  })

  it('exports duplicated pages with fields without name clashes', async () => {
    const pageId = base.pages[0].id
    let d = addObject(base, { id: 'q', pageId, type: 'field', fieldType: 'text', name: 'extra', value: 'v', x: 300, y: 300, width: 100, height: 20 })
    d = duplicatePages(d, [pageId])
    const pdf = await PDFDocument.load(await exportDocument(d))
    const names = pdf.getForm().getFields().map((x) => x.getName())
    expect(names).toContain('extra')
    expect(names).toContain('extra_2')
  })
})

describe('content edits', () => {
  it('lists the items of a page and applies edits on export and in previews', async () => {
    const doc = await openDocument(await makeTextPdf(2), 't.pdf')
    const pageId = doc.pages[0].id
    const items = await getContentItems(doc, pageId)
    const title = items.find((i) => i.text === 'Page 1')!
    expect(title).toBeTruthy()
    expect(await getContentItems(doc, pageId)).toBe(items) // cached
    const d = editContentItem(doc, pageId, title.id, { deleted: true })
    expect((await allPagesText(await exportDocument(d)))[0]).not.toContain('Page 1')
    expect((await allPagesText(await renderPagePreview(d, pageId)))[0]).not.toContain('Page 1')
    expect((await allPagesText(await exportDocument(d)))[1]).toContain('Page 2')
  })

  it('edits one of two duplicated pages without affecting the other', async () => {
    let doc = await openDocument(await makeTextPdf(1), 't.pdf')
    doc = duplicatePages(doc, [doc.pages[0].id])
    const copy = doc.pages[1].id
    const item = (await getContentItems(doc, copy)).find((i) => i.text === 'Page 1')!
    const d = editContentItem(doc, copy, item.id, { deleted: true })
    const texts = await allPagesText(await exportDocument(d))
    expect(texts[0]).toContain('Page 1')
    expect(texts[1]).not.toContain('Page 1')
  })
})
