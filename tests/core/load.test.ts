import { describe, expect, it } from 'vitest'
import {
  InvalidPasswordError,
  PAGE_SIZES,
  PasswordRequiredError,
  PdfLoadError,
  createBlankDocument,
  loadSource,
  openDocument
} from '../../src/core'
import {
  A4,
  FIXTURE_PASSWORD,
  LETTER,
  makeAnnotatedPdf,
  makeCropBoxPdf,
  makeEncryptedPdf,
  makeFormPdf,
  makeInheritedAttributesPdf,
  makeMixedSizesPdf,
  makeOwnerOnlyEncryptedPdf,
  makeRotatedPdf,
  makeTextPdf
} from '../fixtures/pdfs'
import { pageAnnotations, pageInfo } from './helpers'

describe('loadSource', () => {
  it('loads a plain PDF with metadata and page geometry', async () => {
    const bytes = await makeTextPdf(3)
    const copy = bytes.slice()
    const src = await loadSource(bytes, 'plain.pdf')
    expect(src.name).toBe('plain.pdf')
    expect(src.id).toMatch(/^src_/)
    expect(src.bytes).toBe(bytes)
    expect(bytes).toEqual(copy)
    expect(src.isEncrypted).toBe(false)
    expect(src.password).toBeUndefined()
    expect(src.pageCount).toBe(3)
    expect(src.metadata.title).toBe('Text fixture')
    expect(src.metadata.author).toBe('Fixture Author')
    expect(src.formFields).toEqual([])
    expect(src.pageInfo).toHaveLength(3)
    expect(src.pageInfo![0]).toEqual({ width: A4[0], height: A4[1], rotation: 0, annotations: [] })
  })

  it('reads /Rotate of every page (unrotated sizes)', async () => {
    const src = await loadSource(await makeRotatedPdf(), 'rotated.pdf')
    expect(src.pageInfo!.map((p) => p.rotation)).toEqual([0, 90, 180, 270])
    for (const p of src.pageInfo!) {
      expect(p.width).toBeCloseTo(A4[0])
      expect(p.height).toBeCloseTo(A4[1])
    }
  })

  it('uses crop box ∩ media box like pdf.js', async () => {
    const bytes = await makeCropBoxPdf()
    const src = await loadSource(bytes, 'crop.pdf')
    const [view] = await pageInfo(bytes)
    expect(src.pageInfo![0].width).toBeCloseTo(view.view[2] - view.view[0])
    expect(src.pageInfo![0].height).toBeCloseTo(view.view[3] - view.view[1])
    expect(src.pageInfo![0]).toEqual({ width: 500, height: 600, rotation: 0, annotations: [] })
  })

  it('reads mixed page sizes', async () => {
    const src = await loadSource(await makeMixedSizesPdf(), 'mixed.pdf')
    expect(src.pageInfo!.map((p) => [p.width, p.height])).toEqual([A4, LETTER, [A4[1], A4[0]]])
  })

  it('resolves inherited MediaBox and Rotate', async () => {
    const src = await loadSource(await makeInheritedAttributesPdf(), 'inherited.pdf')
    expect(src.pageInfo).toEqual([
      { width: 400, height: 600, rotation: 90, annotations: [] },
      { width: 400, height: 600, rotation: 90, annotations: [] }
    ])
  })

  it('extracts every form field with values, flags and widgets', async () => {
    const bytes = await makeFormPdf()
    const src = await loadSource(bytes, 'form.pdf')
    const byName = Object.fromEntries(src.formFields.map((f) => [f.name, f]))
    expect(Object.keys(byName).sort()).toEqual(
      ['agree', 'color', 'country', 'email', 'langs', 'name', 'notes', 'page2', 'readonly'].sort()
    )
    expect(byName.name).toMatchObject({ type: 'text', value: '', readOnly: false, multiline: false })
    expect(byName.notes).toMatchObject({ type: 'text', multiline: true })
    expect(byName.readonly).toMatchObject({ type: 'text', value: 'fixed', readOnly: true })
    expect(byName.agree).toMatchObject({ type: 'checkbox', value: false })
    expect(byName.agree.widgets[0].onValue).toBe('Yes')
    expect(byName.color).toMatchObject({ type: 'radio', value: '', options: ['red', 'green', 'blue'] })
    expect(byName.color.widgets.map((w) => w.onValue)).toEqual(['red', 'green', 'blue'])
    expect(byName.country).toMatchObject({ type: 'dropdown', value: '', options: ['Lithuania', 'Germany', 'France'] })
    expect(byName.langs).toMatchObject({ type: 'optionlist', value: [], options: ['English', 'German', 'Lithuanian'] })
    expect(byName.page2.widgets).toHaveLength(1)
    expect(byName.page2.widgets[0].pageIndex).toBe(1)
    expect(byName.name.widgets[0].pageIndex).toBe(0)

    // Widget boxes in page space agree with pdf.js' annotation rects.
    const annots = await pageAnnotations(bytes, 1)
    const H = A4[1]
    for (const field of src.formFields.filter((f) => f.widgets[0]?.pageIndex === 0)) {
      for (const w of field.widgets) {
        const match = annots.find((a) => {
          const [x1, , x2, y2] = a.rect as number[]
          return Math.abs(x1 - w.box.x) < 0.01 && Math.abs(H - y2 - w.box.y) < 0.01 && Math.abs(x2 - x1 - w.box.width) < 0.01
        })
        expect(match, field.name).toBeTruthy()
        expect(match!.fieldName).toBe(field.name)
      }
    }
    // The text field "name" was created at (150, top-100) with height 22 (pdf-lib adds the border).
    const box = byName.name.widgets[0].box
    expect(box.x).toBeCloseTo(149.5, 1)
    expect(box.y + box.height).toBeCloseTo(100.5, 1)
  })

  it('opens an encrypted PDF only with the right password', async () => {
    const bytes = await makeEncryptedPdf()
    await expect(loadSource(bytes, 'enc.pdf')).rejects.toBeInstanceOf(PasswordRequiredError)
    await expect(loadSource(bytes, 'enc.pdf', { password: 'wrong' })).rejects.toBeInstanceOf(InvalidPasswordError)
    await expect(loadSource(bytes, 'enc.pdf', { password: '' })).rejects.toBeInstanceOf(InvalidPasswordError)
    const src = await loadSource(bytes, 'enc.pdf', { password: FIXTURE_PASSWORD })
    expect(src.isEncrypted).toBe(true)
    expect(src.password).toBe(FIXTURE_PASSWORD)
    expect(src.pageCount).toBe(2)
    expect(src.metadata.title).toBe('Text fixture')
    // The owner password opens it too.
    const owner = await loadSource(bytes, 'enc.pdf', { password: `${FIXTURE_PASSWORD}-owner` })
    expect(owner.pageCount).toBe(2)
  })

  it('opens owner-password-only files without prompting', async () => {
    const src = await loadSource(await makeOwnerOnlyEncryptedPdf(), 'owner.pdf')
    expect(src.isEncrypted).toBe(true)
    expect(src.password).toBe('')
    expect(src.pageCount).toBe(1)
  })

  it('throws PdfLoadError for garbage', async () => {
    await expect(loadSource(new Uint8Array([1, 2, 3, 4]), 'x.pdf')).rejects.toBeInstanceOf(PdfLoadError)
    await expect(loadSource(new Uint8Array(), 'x.pdf')).rejects.toBeInstanceOf(PdfLoadError)
    await expect(loadSource(new TextEncoder().encode('%PDF-1.7\nnot really'), 'x.pdf')).rejects.toBeInstanceOf(
      PdfLoadError
    )
  })

  it('loads annotated PDFs', async () => {
    const src = await loadSource(await makeAnnotatedPdf(), 'annotated.pdf')
    expect(src.pageCount).toBe(1)
    expect(src.formFields).toEqual([])
  })
})

describe('openDocument', () => {
  it('creates one page entry per page with base rotations', async () => {
    const doc = await openDocument(await makeRotatedPdf(), 'rotated.pdf')
    const src = doc.sources[doc.primarySourceId!]
    expect(doc.pages).toHaveLength(4)
    expect(new Set(doc.pages.map((p) => p.id)).size).toBe(4)
    expect(doc.pages.map((p) => p.baseRotation)).toEqual([0, 90, 180, 270])
    expect(doc.pages.every((p) => p.rotation === 0)).toBe(true)
    expect(doc.pages.map((p) => p.source)).toEqual(
      [0, 1, 2, 3].map((pageIndex) => ({ kind: 'source', sourceId: src.id, pageIndex }))
    )
    expect(doc.objects).toEqual([])
    expect(doc.formValues).toEqual({})
    expect(doc.settings).toEqual({
      metadata: {},
      watermark: null,
      pageNumbers: null,
      flattenForms: false,
      encryption: null
    })
  })

  it('pre-fills encryption with the user password', async () => {
    const doc = await openDocument(await makeEncryptedPdf(), 'enc.pdf', { password: FIXTURE_PASSWORD })
    // The fixture is encrypted with pdf-lib's default permissions (nothing allowed); they are kept.
    expect(doc.settings.encryption).toEqual({
      userPassword: FIXTURE_PASSWORD,
      permissions: {
        printing: 'none',
        modifying: false,
        copying: false,
        annotating: false,
        fillingForms: false,
        contentAccessibility: false,
        documentAssembly: false
      }
    })
    const src = doc.sources[doc.primarySourceId!]
    expect(src.passwordKind).toBe('user')
    expect(src.userPassword).toBe(FIXTURE_PASSWORD)
    const owner = await openDocument(await makeOwnerOnlyEncryptedPdf(), 'owner.pdf')
    expect(owner.settings.encryption).toBeNull()
  })

  it('propagates load errors', async () => {
    await expect(openDocument(await makeEncryptedPdf(), 'enc.pdf')).rejects.toBeInstanceOf(PasswordRequiredError)
  })
})

describe('createBlankDocument', () => {
  it('creates one blank A4 page by default', () => {
    const doc = createBlankDocument()
    expect(doc.primarySourceId).toBeNull()
    expect(doc.sources).toEqual({})
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages[0]).toMatchObject({ source: { kind: 'blank' }, ...PAGE_SIZES.A4, baseRotation: 0, rotation: 0 })
    expect(doc.settings.encryption).toBeNull()
  })

  it('accepts a custom size', () => {
    const doc = createBlankDocument(PAGE_SIZES.Letter)
    expect(doc.pages[0].width).toBe(612)
    expect(doc.pages[0].height).toBe(792)
  })
})
