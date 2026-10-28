import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, PDFTextField } from '@cantoo/pdf-lib'
import {
  FormFieldNameError,
  addObject,
  editField,
  exportDocument,
  getEffectiveFormFields,
  insertSourcePages,
  loadSource,
  openDocument,
  setFormValue,
  updateSettings,
  type EditorDocument,
  type FieldObject
} from '../../src/core'
import { makeEditableFormPdf, makeTextPdf } from '../fixtures/pdfs'
import { allPagesText, pageAnnotations, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

const str = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined)

/** Field name → value, via pdf-lib (independent of our loader). */
async function fieldValues(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  if (!doc.catalog.get(PDFName.of('AcroForm'))) return {}
  return Object.fromEntries(
    doc.getForm().getFields().map((f) => {
      const v = f.acroField.dict.lookup(PDFName.of('V'))
      return [f.getName(), v instanceof PDFName ? v.decodeText() : (str(v) ?? null)]
    })
  )
}

let base: EditorDocument
let sid: string
beforeAll(async () => {
  base = await openDocument(await makeEditableFormPdf(), 'f.pdf')
  sid = base.primarySourceId!
})

describe('editing existing form fields', () => {
  it('renames fields (also into and out of hierarchies); values stay keyed by the original name', async () => {
    let d = editField(base, sid, 'name', { name: 'applicant.fullName' })
    d = editField(d, sid, 'person.age', { name: 'age' })
    d = setFormValue(d, sid, 'name', 'Jonas Ąžuolas')
    expect(getEffectiveFormFields(d, sid).map((f) => f.name)).toContain('applicant.fullName')
    const out = await exportDocument(d)
    const values = await fieldValues(out)
    expect(values['applicant.fullName']).toBe('Jonas Ąžuolas')
    expect(values.age).toBe('41')
    expect(values.name).toBeUndefined()
    expect(values['person.age']).toBeUndefined()
    const re = await loadSource(out, 'o.pdf')
    expect(re.formFields.find((f) => f.name === 'age')).toMatchObject({ type: 'text', value: '41' })
  })

  it('swapping two names works; clashes throw FormFieldNameError', async () => {
    let d = editField(base, sid, 'name', { name: 'notes' })
    d = editField(d, sid, 'notes', { name: 'name' })
    const values = await fieldValues(await exportDocument(d))
    expect(values.notes).toBe('Ona')
    expect(values.name).toBeNull()
    await expect(exportDocument(editField(base, sid, 'name', { name: 'country' }))).rejects.toBeInstanceOf(FormFieldNameError)
    await expect(exportDocument(editField(base, sid, 'name', { name: 'person' }))).rejects.toThrow(/conflicts/)
    await expect(exportDocument(editField(base, sid, 'name', { name: 'a..b' }))).rejects.toBeInstanceOf(FormFieldNameError)
  })

  it('deletes fields with their widgets', async () => {
    const d = editField(base, sid, 'country', { deleted: true })
    expect(getEffectiveFormFields(d, sid).some((f) => f.name === 'country')).toBe(false)
    const out = await exportDocument(d)
    const re = await loadSource(out, 'o.pdf')
    expect(re.formFields.map((f) => f.name)).not.toContain('country')
    expect((await pageAnnotations(out, 1)).filter((a) => a.fieldName === 'country')).toEqual([])
  })

  it('moves widgets and changes flags, max length, options and font size', async () => {
    const H = 841.89
    let d = editField(base, sid, 'name', {
      widgetBoxes: [{ x: 300, y: 100, width: 150, height: 30 }],
      readOnly: true,
      required: true,
      multiline: true,
      maxLength: 2,
      fontSize: 9
    })
    d = editField(d, sid, 'country', { options: ['LT', 'DE'], optionLabels: ['Lietuva', 'Vokietija'] })
    d = editField(d, sid, 'person.age', { fontSize: 0 })
    const out = await exportDocument(d)
    const re = await loadSource(out, 'o.pdf')
    const name = re.formFields.find((f) => f.name === 'name')!
    expect(name).toMatchObject({ readOnly: true, required: true, multiline: true, maxLength: 2, value: 'On' })
    expect(name.widgets[0].box).toEqual({ x: 300, y: 100, width: 150, height: 30 })
    const country = re.formFields.find((f) => f.name === 'country')!
    expect(country.options).toEqual(['LT', 'DE'])
    expect(country.optionLabels).toEqual(['Lietuva', 'Vokietija'])
    const pdf = await PDFDocument.load(out, { updateMetadata: false })
    const da = (n: string) => str(pdf.getForm().getField(n).acroField.dict.lookup(PDFName.of('DA')))
    expect(da('name')).toMatch(/ 9 Tf/)
    expect(da('person.age')).toMatch(/ 0 Tf/)
    const rect = (pdf.getForm().getField('name') as PDFTextField).acroField.getWidgets()[0].getRectangle()
    expect(rect).toEqual({ x: 300, y: H - 130, width: 150, height: 30 })
    // Removing the limit again
    const d2 = editField(base, sid, 'name', { maxLength: null })
    expect(getEffectiveFormFields(d2, sid).find((f) => f.name === 'name')!.maxLength).toBeUndefined()
  })

  it('applies to pages inserted from another file before flattening', async () => {
    let d = await openDocument(await makeTextPdf(1), 't.pdf')
    const other = await loadSource(await makeEditableFormPdf(), 'f.pdf')
    d = insertSourcePages(d, other, 1, [0])
    d = editField(d, other.id, 'name', { deleted: true })
    d = setFormValue(d, other.id, 'person.age', '77')
    const texts = await allPagesText(await exportDocument(d))
    expect(texts[1]).toContain('77')
    expect(texts[1]).not.toContain('Ona')
  })
})

function field(pageId: string, patch: Partial<FieldObject>): FieldObject {
  return {
    id: `f_${Math.random().toString(36).slice(2)}`,
    pageId,
    type: 'field',
    fieldType: 'text',
    name: 'new',
    x: 100,
    y: 100,
    width: 150,
    height: 22,
    ...patch
  }
}

describe('new form fields', () => {
  it('creates real fields of every type with their values', async () => {
    let d = await openDocument(await makeTextPdf(2), 't.pdf')
    const [p1, p2] = d.pages.map((p) => p.id)
    const objs: FieldObject[] = [
      field(p1, { name: 'customer.name', value: 'Žemaitė Ąžuolienė', required: true, fontSize: 11 }),
      field(p1, { name: 'subscribe', fieldType: 'checkbox', exportValue: 'Taip', value: true, y: 140, width: 14, height: 14 }),
      field(p1, { name: 'size', fieldType: 'radio', exportValue: 'S', y: 180, width: 14, height: 14 }),
      field(p1, { name: 'size', fieldType: 'radio', exportValue: 'M', value: 'M', x: 130, y: 180, width: 14, height: 14 }),
      field(p2, { name: 'size', fieldType: 'radio', exportValue: 'L', y: 180, width: 14, height: 14 }),
      field(p1, { name: 'city', fieldType: 'dropdown', options: ['Vilnius', 'Kaunas'], value: 'Kaunas', y: 220 }),
      field(p1, { name: 'langs', fieldType: 'optionlist', options: ['lt', 'en', 'de'], value: ['lt', 'de'], y: 260, height: 60 }),
      field(p1, { name: 'sign', fieldType: 'signature', y: 340, height: 40 }),
      field(p2, { name: 'comments', multiline: true, maxLength: 200, value: 'line 1\nline 2', height: 60 })
    ]
    for (const o of objs) d = addObject(d, o)
    const out = await exportDocument(d)
    const pdf = await PDFDocument.load(out, { updateMetadata: false })
    const form = pdf.getForm()
    expect(form.getTextField('customer.name').getText()).toBe('Žemaitė Ąžuolienė')
    expect(form.getTextField('customer.name').isRequired()).toBe(true)
    expect(form.getCheckBox('subscribe').isChecked()).toBe(true)
    expect(form.getCheckBox('subscribe').acroField.dict.get(PDFName.of('V'))?.toString()).toBe('/Taip')
    const size = form.getRadioGroup('size')
    expect(size.getOptions()).toEqual(['S', 'M', 'L'])
    expect(size.getSelected()).toBe('M')
    expect(form.getDropdown('city').getSelected()).toEqual(['Kaunas'])
    expect(form.getOptionList('langs').getSelected()).toEqual(['lt', 'de'])
    expect(form.getSignature('sign')).toBeTruthy()
    expect(form.getTextField('comments').isMultiline()).toBe(true)
    expect(form.getTextField('comments').getMaxLength()).toBe(200)
    // Widgets sit exactly on the object boxes, on the right pages.
    const widget = form.getTextField('customer.name').acroField.getWidgets()[0]
    expect(widget.getRectangle()).toEqual({ x: 100, y: 841.89 - 122, width: 150, height: 22 })
    const p2Annots = await pageAnnotations(out, 2)
    expect(p2Annots.filter((a) => a.fieldName === 'size')).toHaveLength(1)
    // /DA fonts are in /DR; the Unicode value is drawn with a font that has the glyphs.
    const dr = pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    expect(dr.get(PDFName.of('Helv'))).toBeTruthy()
    expect(str(form.getTextField('customer.name').acroField.dict.lookup(PDFName.of('DA')))).toBe('/Helv 11 Tf 0 g')
    const flat = await exportDocument(updateSettings(d, { flattenForms: true }))
    const flatText = (await allPagesText(flat))[0]
    expect(flatText).toContain('Žemaitė Ąžuolienė')
    expect(flatText).toContain('Kaunas')
    expect((await PDFDocument.load(flat)).catalog.get(PDFName.of('AcroForm'))).toBeUndefined()
  })

  it('works in a new blank document and next to existing fields', async () => {
    const { createBlankDocument } = await import('../../src/core')
    let d = createBlankDocument()
    d = addObject(d, field(d.pages[0].id, { name: 'only', value: 'x' }))
    expect((await fieldValues(await exportDocument(d))).only).toBe('x')
    let e = addObject(base, field(base.pages[0].id, { name: 'extra', value: 'y', y: 300 }))
    e = setFormValue(e, sid, 'name', 'Petras')
    const values = await fieldValues(await exportDocument(e))
    expect(values).toMatchObject({ extra: 'y', name: 'Petras', 'person.age': '41' })
  })

  it('rejects clashing names', async () => {
    const pageId = base.pages[0].id
    await expect(exportDocument(addObject(base, field(pageId, { name: 'country' })))).rejects.toBeInstanceOf(FormFieldNameError)
    await expect(exportDocument(addObject(base, field(pageId, { name: 'person' })))).rejects.toThrow(/conflicts/)
    // A renamed field frees its old name.
    const renamed = addObject(editField(base, sid, 'country', { name: 'land' }), field(pageId, { name: 'country', value: 'ok' }))
    expect((await fieldValues(await exportDocument(renamed))).country).toBe('ok')
    let twice = addObject(base, field(pageId, { name: 'dup' }))
    twice = addObject(twice, field(pageId, { name: 'dup', y: 400 }))
    await expect(exportDocument(twice)).rejects.toBeInstanceOf(FormFieldNameError)
  })

  it('marks widgets so the fields can be found again', async () => {
    let d = await openDocument(await makeTextPdf(1), 't.pdf')
    const o = field(d.pages[0].id, { name: 'marked' })
    d = addObject(d, o)
    const pdf = await PDFDocument.load(await exportDocument(d))
    const w = pdf.getForm().getTextField('marked').acroField.getWidgets()[0]
    expect(str(w.dict.lookup(PDFName.of('OPEObjectId')))).toBe(o.id)
    expect((w.dict.lookup(PDFName.of('F')) as PDFNumber).asNumber()).toBe(4)
  })
})
