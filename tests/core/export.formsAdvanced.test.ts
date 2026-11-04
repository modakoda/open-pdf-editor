import { beforeAll, describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from '@cantoo/pdf-lib'
import {
  exportDocument,
  insertSourcePages,
  loadSource,
  openDocument,
  setFormValue,
  updateSettings
} from '../../src/core'
import {
  makeAppearanceMatrixFormPdf,
  makeAutoSizeDAFormPdf,
  makeChoiceExportValuesPdf,
  makeHiddenWidgetPdf,
  makeNeedAppearancesPdf,
  makeTextPdf,
  makeYesNoCheckboxPdf
} from '../fixtures/pdfs'
import { allPagesText, pageAnnotations, pageTextItems, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

const str = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : String(o))
const values = (o: unknown) =>
  o instanceof PDFArray ? Array.from({ length: o.size() }, (_, i) => str(o.lookup(i))) : o === undefined ? [] : [str(o)]

describe('/NeedAppearances forms (finding 2)', () => {
  it('flattening burns the value, not the stale appearance', async () => {
    const bytes = await makeNeedAppearancesPdf()
    expect((await loadSource(bytes, 'n.pdf')).formFields[0].value).toBe('Jonas Jonaitis')
    const out = await exportDocument(updateSettings(await openDocument(bytes, 'n.pdf'), { flattenForms: true }))
    expect(await allPagesText(out)).toEqual(['Jonas Jonaitis'])
  })

  it('pages inserted from such a file show the value', async () => {
    const merged = insertSourcePages(await openDocument(await makeTextPdf(1), 'b.pdf'), await loadSource(await makeNeedAppearancesPdf(), 'n.pdf'), 1)
    expect((await allPagesText(await exportDocument(merged)))[1]).toBe('Jonas Jonaitis')
  })
})

describe('choice fields with export values (finding 3)', () => {
  it('loads export values as values and display texts as labels', async () => {
    const src = await loadSource(await makeChoiceExportValuesPdf(), 'c.pdf')
    const country = src.formFields.find((f) => f.name === 'country')!
    const langs = src.formFields.find((f) => f.name === 'langs')!
    expect(country).toMatchObject({ type: 'dropdown', value: 'LT', options: ['LT', 'DE'], optionLabels: ['Lithuania', 'Germany'] })
    expect(langs).toMatchObject({ type: 'optionlist', value: ['en'], options: ['en', 'de', 'lt'], optionLabels: ['English', 'German', 'Lithuanian'] })
    const plain = (await loadSource(await (await import('../fixtures/pdfs')).makeFormPdf(), 'f.pdf')).formFields.find((f) => f.name === 'country')!
    expect(plain.optionLabels).toBeUndefined()
  })

  it('writes export values to /V and /I and shows labels in the appearance', async () => {
    const doc = await openDocument(await makeChoiceExportValuesPdf(), 'c.pdf')
    const sid = doc.primarySourceId!
    let d = setFormValue(doc, sid, 'country', 'DE')
    d = setFormValue(d, sid, 'langs', ['en', 'lt'])
    const out = await exportDocument(d)
    const re = await PDFDocument.load(out)
    const country = re.getForm().getField('country').acroField.dict
    const langs = re.getForm().getField('langs').acroField.dict
    expect(values(country.lookup(PDFName.of('V')))).toEqual(['DE'])
    expect(values(langs.lookup(PDFName.of('V')))).toEqual(['en', 'lt'])
    expect(langs.lookup(PDFName.of('I'))?.toString()).toBe('[ 0 2 ]')
    const reloaded = await loadSource(out, 'o.pdf')
    expect(reloaded.formFields.find((f) => f.name === 'country')!.value).toBe('DE')
    expect(reloaded.formFields.find((f) => f.name === 'langs')!.value).toEqual(['en', 'lt'])
    // The flattened appearance shows the display text.
    const flat = await exportDocument(updateSettings(d, { flattenForms: true }))
    expect((await allPagesText(flat))[0]).toContain('Germany')
    expect((await allPagesText(flat))[0]).not.toMatch(/\bDE\b/)
  })

  it('keeps existing selections when the user adds one (multi-select)', async () => {
    const doc = await openDocument(await makeChoiceExportValuesPdf(), 'c.pdf')
    const src = doc.sources[doc.primarySourceId!]
    const current = src.formFields.find((f) => f.name === 'langs')!.value as string[]
    const out = await exportDocument(setFormValue(doc, src.id, 'langs', [...current, 'de']))
    const re = await PDFDocument.load(out)
    expect(values(re.getForm().getField('langs').acroField.dict.lookup(PDFName.of('V')))).toEqual(['en', 'de'])
  })

  it('accepts display labels from older callers', async () => {
    const doc = await openDocument(await makeChoiceExportValuesPdf(), 'c.pdf')
    const out = await exportDocument(setFormValue(doc, doc.primarySourceId!, 'country', 'Germany'))
    const re = await PDFDocument.load(out)
    expect(values(re.getForm().getField('country').acroField.dict.lookup(PDFName.of('V')))).toEqual(['DE'])
  })
})

describe('checkbox groups with several on-states (finding 5)', () => {
  it('loads as a radio-like field whose value is the chosen state', async () => {
    const src = await loadSource(await makeYesNoCheckboxPdf(), 'c.pdf')
    const f = src.formFields[0]
    expect(f).toMatchObject({ name: 'married', type: 'radio', value: 'No', options: ['Yes', 'No'] })
    expect(f.widgets.map((w) => w.onValue)).toEqual(['Yes', 'No'])
  })

  it('setting a state turns on exactly that widget', async () => {
    const doc = await openDocument(await makeYesNoCheckboxPdf(), 'c.pdf')
    for (const [value, v, as] of [
      ['Yes', '/Yes', ['/Yes', '/Off']],
      ['No', '/No', ['/Off', '/No']],
      ['', '/Off', ['/Off', '/Off']]
    ] as const) {
      const out = await exportDocument(setFormValue(doc, doc.primarySourceId!, 'married', value))
      const cb = (await PDFDocument.load(out)).getForm().getCheckBox('married')
      expect(cb.acroField.dict.get(PDFName.of('V'))?.toString(), value).toBe(v)
      expect(cb.acroField.getWidgets().map((w) => w.getAppearanceState()?.toString())).toEqual(as)
      expect((await loadSource(out, 'o.pdf')).formFields[0].value).toBe(value)
    }
  })

  it('plain checkboxes still use booleans and keep their appearance streams', async () => {
    const { makeFormPdf } = await import('../fixtures/pdfs')
    const bytes = await makeFormPdf()
    const apBefore = (await PDFDocument.load(bytes)).getForm().getCheckBox('agree').acroField.getWidgets()[0].dict.get(PDFName.of('AP'))?.toString()
    const doc = await openDocument(bytes, 'f.pdf')
    expect(doc.sources[doc.primarySourceId!].formFields.find((f) => f.name === 'agree')!.type).toBe('checkbox')
    const out = await exportDocument(setFormValue(doc, doc.primarySourceId!, 'agree', true))
    const cb = (await PDFDocument.load(out)).getForm().getCheckBox('agree')
    expect(cb.isChecked()).toBe(true)
    expect(cb.acroField.getWidgets()[0].dict.get(PDFName.of('AP'))?.toString()).toBe(apBefore)
    expect((await loadSource(out, 'o.pdf')).formFields.find((f) => f.name === 'agree')!.value).toBe(true)
  })
})

describe('flattening (findings 6 and 7)', () => {
  it('does not reveal hidden widgets', async () => {
    const bytes = await makeHiddenWidgetPdf()
    expect((await allPagesText(bytes))[0]).toBe('')
    const flat = await exportDocument(updateSettings(await openDocument(bytes, 'h.pdf'), { flattenForms: true }))
    const text = (await allPagesText(flat))[0]
    expect(text).toContain('SHOWNVALUE')
    expect(text).not.toContain('HIDDENVALUE')
    const merged = insertSourcePages(await openDocument(await makeTextPdf(1), 'b.pdf'), await loadSource(bytes, 'h.pdf'), 1)
    const mergedText = (await allPagesText(await exportDocument(merged)))[1]
    expect(mergedText).toContain('SHOWNVALUE')
    expect(mergedText).not.toContain('HIDDENVALUE')
  })

  it('maps the appearance BBox through its Matrix onto the widget Rect', async () => {
    const out = await exportDocument(updateSettings(await openDocument(await makeAppearanceMatrixFormPdf(), 'f.pdf'), { flattenForms: true }))
    const items = await pageTextItems(out, 1)
    const rotated = items.find((i) => i.str === 'ROTATED')!
    const offset = items.find((i) => i.str === 'OFFSET')!
    // Rotated 90°: baseline runs up the page inside the 20x200 widget at (100, 500).
    expect(rotated.transform[1]).toBeCloseTo(12)
    expect(rotated.transform[4]).toBeGreaterThanOrEqual(100)
    expect(rotated.transform[4]).toBeLessThanOrEqual(120)
    expect(rotated.transform[5]).toBeGreaterThanOrEqual(500)
    expect(rotated.transform[5]).toBeLessThanOrEqual(700)
    // Non-zero BBox origin: drawn where the appearance says (302, 305), not off-page.
    expect(offset.transform[4]).toBeCloseTo(302, 1)
    expect(offset.transform[5]).toBeCloseTo(305, 1)
    expect((await pageAnnotations(out, 1)).filter((a) => a.subtype === 'Widget')).toEqual([])
    expect((await PDFDocument.load(out)).catalog.get(PDFName.of('AcroForm'))).toBeUndefined()
  })
})

describe('/DA is preserved when filling (finding 14)', () => {
  it('keeps the original /DA (font and auto size) and registers its font in /DR', async () => {
    const doc = await openDocument(await makeAutoSizeDAFormPdf(), 'da.pdf')
    const sid = doc.primarySourceId!
    let e = setFormValue(doc, sid, 'name', 'John')
    e = setFormValue(e, sid, 'city', 'Kaunas–Šiauliai')
    const out = await exportDocument(e)
    const re = await PDFDocument.load(out)
    const acroForm = re.catalog.lookup(PDFName.of('AcroForm'), PDFDict)
    const drFonts = acroForm.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    for (const n of ['name', 'city']) {
      const fld = re.getForm().getField(n)
      expect(str(fld.acroField.dict.lookup(PDFName.of('DA')))).toBe('/Helv 0 Tf 0 g')
      for (const w of fld.acroField.getWidgets()) {
        const da = w.dict.lookup(PDFName.of('DA'))
        if (da) expect(str(da)).toBe('/Helv 0 Tf 0 g')
      }
    }
    expect(drFonts.get(PDFName.of('Helv'))).toBeTruthy()
    const vals = Object.fromEntries((await loadSource(out, 'o.pdf')).formFields.map((f) => [f.name, f.value]))
    expect(vals).toEqual({ name: 'John', city: 'Kaunas–Šiauliai' })
    // The Unicode value is still drawn correctly (flattened check).
    expect((await allPagesText(await exportDocument(updateSettings(e, { flattenForms: true }))))[0]).toContain('Kaunas–Šiauliai')
  })

  it('adds a missing /DA font to /DR', async () => {
    const d = await PDFDocument.create()
    const page = d.addPage()
    const f = d.getForm().createTextField('x')
    f.addToPage(page, { x: 50, y: 700, width: 200, height: 20 })
    f.acroField.dict.set(PDFName.of('DA'), PDFString.of('/TiRo 10 Tf 0 g'))
    const bytes = await d.save({ updateFieldAppearances: false })
    const doc = await openDocument(bytes, 'x.pdf')
    const out = await exportDocument(setFormValue(doc, doc.primarySourceId!, 'x', 'hello'))
    const re = await PDFDocument.load(out)
    const fonts = re.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    const tiro = fonts.lookup(PDFName.of('TiRo'), PDFDict)
    expect(tiro.lookup(PDFName.of('BaseFont'))?.toString()).toBe('/Times-Roman')
  })
})
