import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import {
  deletePages,
  duplicatePages,
  exportDocument,
  insertSourcePages,
  loadSource,
  openDocument,
  setFormValue,
  updateSettings,
  type EditorDocument,
  type FormValue
} from '../../src/core'
import { makeFormPdf, makeTextPdf } from '../fixtures/pdfs'
import { allPagesText, pageAnnotations, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

const VALUES: Record<string, FormValue> = {
  name: 'Jonas Ąžuolaitis',
  email: 'jonas@example.com',
  notes: 'Line one\nLine two',
  agree: true,
  color: 'green',
  country: 'Germany',
  langs: ['English', 'Lithuanian']
}

async function filledFormDoc(values = VALUES): Promise<EditorDocument> {
  let doc = await openDocument(await makeFormPdf(), 'form.pdf')
  for (const [k, v] of Object.entries(values)) doc = setFormValue(doc, doc.primarySourceId!, k, v)
  return doc
}

const fieldValues = (src: Awaited<ReturnType<typeof loadSource>>) =>
  Object.fromEntries(src.formFields.map((f) => [f.name, f.value]))

describe('export: form filling', () => {
  it('keeps the form intact when nothing changed', async () => {
    const doc = await openDocument(await makeFormPdf(), 'form.pdf')
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.formFields.map((f) => f.name).sort()).toEqual(doc.sources[doc.primarySourceId!].formFields.map((f) => f.name).sort())
    expect(fieldValues(re).readonly).toBe('fixed')
  })

  it('fills every field type and the values survive a reload', async () => {
    const out = await exportDocument(await filledFormDoc())
    const re = await loadSource(out, 'out.pdf')
    const values = fieldValues(re)
    for (const [k, v] of Object.entries(VALUES)) expect(values[k], k).toEqual(v)
    expect(values.readonly).toBe('fixed')
    expect(values.page2).toBe('')
    // pdf.js sees the same values.
    const annots = await pageAnnotations(out, 1)
    const byName = (n: string) => annots.filter((a) => a.fieldName === n)
    expect(byName('name')[0].fieldValue).toBe('Jonas Ąžuolaitis')
    expect(byName('agree')[0].fieldValue).toBe('Yes')
    expect(byName('country')[0].fieldValue).toEqual(['Germany'])
    expect(byName('langs')[0].fieldValue).toEqual(['English', 'Lithuanian'])
  })

  it('clears values and ignores invalid choices', async () => {
    let doc = await filledFormDoc()
    const sid = doc.primarySourceId!
    doc = setFormValue(doc, sid, 'agree', false)
    doc = setFormValue(doc, sid, 'color', 'purple')
    doc = setFormValue(doc, sid, 'langs', ['Klingon'])
    doc = setFormValue(doc, sid, 'readonly', 'changed')
    doc = setFormValue(doc, sid, 'does-not-exist', 'x')
    const values = fieldValues(await loadSource(await exportDocument(doc), 'out.pdf'))
    expect(values.agree).toBe(false)
    expect(values.color).toBe('')
    expect(values.langs).toEqual([])
    expect(values.readonly).toBe('changed')
  })

  it('flattens forms into page content', async () => {
    const doc = updateSettings(await filledFormDoc(), { flattenForms: true })
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.formFields).toEqual([])
    expect((await pageAnnotations(out, 1)).filter((a) => a.subtype === 'Widget')).toEqual([])
    const [page1] = await allPagesText(out)
    expect(page1).toContain('Jonas Ąžuolaitis')
    expect(page1).toContain('jonas@example.com')
    expect(page1).toContain('Germany')
    expect(page1).toContain('fixed')
  })

  it('removes fields whose pages were deleted', async () => {
    let doc = await filledFormDoc()
    doc = deletePages(doc, [doc.pages[1].id])
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.pageCount).toBe(1)
    const names = re.formFields.map((f) => f.name)
    expect(names).not.toContain('page2')
    expect(names).toContain('name')
    expect(fieldValues(re).name).toBe('Jonas Ąžuolaitis')
    // The reloaded form is consistent: every remaining field has its widget on page 0.
    for (const f of re.formFields) expect(f.widgets.map((w) => w.pageIndex)).toEqual(f.widgets.map(() => 0))
  })

  it('keeps fields of reordered pages attached to the right page', async () => {
    let doc = await openDocument(await makeFormPdf(), 'form.pdf')
    doc = { ...doc, pages: [doc.pages[1], doc.pages[0]] }
    const re = await loadSource(await exportDocument(doc), 'out.pdf')
    const page2 = re.formFields.find((f) => f.name === 'page2')!
    expect(page2.widgets[0].pageIndex).toBe(0)
    expect(re.formFields.find((f) => f.name === 'name')!.widgets[0].pageIndex).toBe(1)
  })

  it('duplicating a form page keeps one interactive copy and burns values into the duplicate', async () => {
    let doc = await filledFormDoc()
    doc = duplicatePages(doc, [doc.pages[0].id])
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.pageCount).toBe(3)
    const names = re.formFields.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    expect(re.formFields.find((f) => f.name === 'name')!.widgets.map((w) => w.pageIndex)).toEqual([0])
    const texts = await allPagesText(out)
    expect(texts[1]).toContain('Jonas Ąžuolaitis')
    expect((await pageAnnotations(out, 2)).filter((a) => a.subtype === 'Widget')).toEqual([])
  })

  it('pages from a form PDF inserted into another document are filled and flattened', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'base.pdf')
    const form = await loadSource(await makeFormPdf(), 'form.pdf')
    doc = insertSourcePages(doc, form, 1)
    doc = setFormValue(doc, form.id, 'name', 'Ona Šimkutė')
    doc = setFormValue(doc, form.id, 'agree', true)
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.pageCount).toBe(3)
    expect(re.formFields).toEqual([])
    const texts = await allPagesText(out)
    expect(texts[0]).toContain('Page 1')
    expect(texts[1]).toContain('Ona Šimkutė')
    expect(texts[1]).toContain('fixed')
    expect(texts[2]).toContain('Second page')
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(3)
  })

  it('merging a form PDF into a form PDF keeps the primary form only', async () => {
    let doc = await filledFormDoc()
    const other = await loadSource(await makeFormPdf(), 'other.pdf')
    doc = insertSourcePages(doc, other, doc.pages.length)
    doc = setFormValue(doc, other.id, 'name', 'Other person')
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.pageCount).toBe(4)
    expect(fieldValues(re).name).toBe('Jonas Ąžuolaitis')
    expect(re.formFields.every((f) => f.widgets.every((w) => w.pageIndex < 2))).toBe(true)
    expect((await allPagesText(out))[2]).toContain('Other person')
  })
})
