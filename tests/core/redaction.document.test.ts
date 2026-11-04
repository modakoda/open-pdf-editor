import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, rgb } from '@cantoo/pdf-lib'
import { listContentItems } from '../../src/core/content'
import { visibleBox } from '../../src/core/pdf'
import {
  addObject,
  addRedactions,
  exportDocument,
  makeRedaction,
  openDocument,
  type TextObject
} from '../../src/core'
import { makeAnnotatedPdf, makeFormPdf, makeOptionalContentPdf } from '../fixtures/pdfs'
import { addStdFont, pdfFromContent } from './content/helpers'
import { pageAnnotations, registerTestFonts } from './helpers'
import { decodedObjects, pdfjsText, rawContains, redact, withRedactions } from './redactionHelpers'

beforeAll(() => registerTestFonts())

async function paths(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const page = pdf.getPage(0)
  return listContentItems(pdf, page, visibleBox(page)).filter((i) => i.kind === 'path')
}

describe('redacting vector paths', () => {
  it('removes paths inside the area and clips the area out of partly covered ones', async () => {
    // A small red square inside the area, a long blue bar crossing it, a green square elsewhere.
    const bytes = await pdfFromContent('1 0 0 rg 110 610 20 20 re f 0 0 1 rg 50 600 300 10 re f 0 1 0 rg 400 100 30 30 re f')
    const area = { x: 100, y: 792 - 640, width: 50, height: 50 } // PDF 100..150 × 590..640
    const out = await redact(bytes, [area])
    const items = await paths(out)
    expect(items.some((i) => i.color === '#ff0000')).toBe(false)
    expect(items.find((i) => i.color === '#00ff00')?.bounds).toEqual({ x: 400, y: 792 - 130, width: 30, height: 30 })
    expect(items.some((i) => i.color === '#0000ff')).toBe(true)
    const { streams } = await decodedObjects(out)
    const content = streams.find((s) => s.includes('300 10 re'))!
    // The bar is drawn inside a clip that excludes the area.
    expect(content).toMatch(/q\s[^Q]*W\* n[\s\S]*300 10 re\s+f\s+Q/)
    expect(content).not.toContain('20 20 re')
  })

  it('keeps a path that is also a clip working as a clip', async () => {
    const bytes = await pdfFromContent('q 0 0 1 rg 50 600 300 10 re W f 1 0 0 rg 0 0 612 792 re f Q')
    const out = await redact(bytes, [{ x: 100, y: 792 - 640, width: 50, height: 50 }])
    const { streams } = await decodedObjects(out)
    const content = streams.find((s) => s.includes('300 10 re'))!
    expect(content).toMatch(/300 10 re\s+f\s+Q\s+50 600 300 10 re\s+W n/)
  })
})

describe('redacting annotations and form fields', () => {
  it('deletes annotations under the area and keeps the others', async () => {
    const bytes = await makeAnnotatedPdf()
    const before = await pageAnnotations(bytes, 1)
    const link = before.find((a) => a.subtype === 'Link')!
    const [x0, y0, x1, y1] = link.rect as number[]
    const out = await redact(bytes, [{ x: x0 + 1, y: 841.89 - y1 + 1, width: x1 - x0 - 2, height: y1 - y0 - 2 }])
    const after = await pageAnnotations(out, 1)
    expect(after.some((a) => a.subtype === 'Link')).toBe(false)
    expect(after.length).toBe(before.length - 1)
  })

  it('removes form widgets under the area together with their fields and values', async () => {
    const src = await PDFDocument.load(await makeFormPdf())
    src.getForm().getTextField('email').setText('jonas@example.com')
    src.getForm().getTextField('name').setText('Visible Name')
    const bytes = await src.save()
    // email widget: x 150..400, PDF y (841.89-140)..(841.89-118)
    const out = await redact(bytes, [{ x: 160, y: 120, width: 50, height: 15 }])
    const pdf = await PDFDocument.load(out)
    const names = pdf.getForm().getFields().map((f) => f.getName())
    expect(names).not.toContain('email')
    expect(names).toContain('name')
    expect(names).toContain('color')
    expect(await rawContains(out, 'jonas@example.com')).toBe(false)
    const widgets = (await pageAnnotations(out, 1)).filter((a) => a.subtype === 'Widget')
    expect(widgets.some((w) => w.fieldName === 'email')).toBe(false)
    expect(widgets.some((w) => w.fieldName === 'name')).toBe(true)
  })

  it('removes one radio button of a group and keeps the rest of the group', async () => {
    const out = await redact(await makeFormPdf(), [{ x: 205, y: 288, width: 30, height: 26 }])
    const pdf = await PDFDocument.load(out)
    const group = pdf.getForm().getRadioGroup('color')
    expect(group.getOptions()).toEqual(['red', 'blue'])
  })
})

describe('redaction boxes and editor objects', () => {
  it('fills the area and writes the overlay text', async () => {
    const bytes = await pdfFromContent('BT /F1 12 Tf 72 700 Td (Hidden words) Tj ET', async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Courier)
      return {}
    })
    const doc = await withRedactions(bytes, [{ x: 60, y: 80, width: 120, height: 20 }], 0, { overlayText: 'REDACTED', fillColor: '#202020' })
    const out = await exportDocument(doc)
    const text = await pdfjsText(out)
    expect(text).toContain('REDACTED')
    expect(text).not.toContain('Hidden')
    const items = (await paths(out)).filter((i) => i.color === '#202020')
    expect(items.map((i) => i.bounds)).toEqual([{ x: 60, y: 80, width: 120, height: 20 }])
  })

  it('removes editor objects under the area and does not keep them editable', async () => {
    let doc = await openDocument(await pdfFromContent('0 0 1 rg 400 100 30 30 re f'), 'o.pdf')
    const pageId = doc.pages[0].id
    const text: TextObject = {
      id: 'obj_secret',
      pageId,
      type: 'text',
      x: 100,
      y: 100,
      width: 200,
      height: 20,
      text: 'Typed secret note',
      font: 'sans',
      bold: false,
      italic: false,
      fontSize: 12,
      color: '#000000',
      align: 'left',
      lineHeight: 1.2,
      rotation: 0
    }
    const kept: TextObject = { ...text, id: 'obj_kept', y: 300, text: 'Typed public note' }
    doc = addObject(addObject(doc, text), kept)
    doc = addRedactions(doc, [makeRedaction(pageId, { x: 90, y: 95, width: 250, height: 30 })])
    const out = await exportDocument(doc)
    expect(await pdfjsText(out)).not.toContain('secret')
    expect(await pdfjsText(out)).toContain('Typed public note')
    expect(await rawContains(out, 'secret note')).toBe(false)
    const reopened = await openDocument(out, 'o.pdf')
    expect(reopened.objects.map((o) => o.id)).toEqual(['obj_kept'])
  })

  it('redacts the copy of a duplicated page as well', async () => {
    const { duplicatePages } = await import('../../src/core')
    const bytes = await pdfFromContent('BT /F1 12 Tf 72 700 Td (Twice secret) Tj ET', async (d, page) => {
      await addStdFont(d, page, 'F1', StandardFonts.Courier)
      return {}
    })
    let doc = await withRedactions(bytes, [{ x: 70, y: 80, width: 200, height: 16 }])
    doc = duplicatePages(doc, [doc.pages[0].id])
    expect(doc.redactions?.length).toBe(2)
    const out = await exportDocument(doc)
    expect(await pdfjsText(out)).not.toContain('secret')
    expect(await rawContains(out, 'secret')).toBe(false)
  })
})

describe('sanitize', () => {
  async function richPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.load(await makeOptionalContentPdf())
    doc.setTitle('Private title')
    doc.setAuthor('Private author')
    doc.setKeywords(['private-keyword'])
    await doc.attach(new TextEncoder().encode('attached secret data'), 'notes.txt', { mimeType: 'text/plain' })
    doc.addJavaScript('hello', 'app.alert("script secret")')
    const ctx = doc.context
    doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("open secret")') }))
    doc.catalog.set(
      PDFName.of('Metadata'),
      ctx.register(ctx.stream('<x:xmpmeta xmlns:x="adobe:ns:meta/">xmp-secret</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }))
    )
    const page = doc.getPage(0)
    page.node.set(PDFName.of('AA'), ctx.obj({ O: { S: 'JavaScript', JS: PDFString.of('page secret()') } }))
    page.drawRectangle({ x: 10, y: 10, width: 5, height: 5, color: rgb(0, 0, 0) })
    return doc.save()
  }

  it('removes metadata, XMP, attachments, scripts and hidden layers', async () => {
    const bytes = await richPdf()
    for (const s of ['Private title', 'attached secret data', 'script secret', 'open secret', 'xmp-secret', 'page secret']) {
      expect(await rawContains(bytes, s)).toBe(true)
    }
    const doc = await openDocument(bytes, 's.pdf')
    const out = await exportDocument(doc, { sanitize: true })
    for (const s of ['Private title', 'Private author', 'private-keyword', 'attached secret data', 'script secret', 'open secret', 'xmp-secret', 'page secret']) {
      expect(await rawContains(out, s), s).toBe(false)
    }
    const pdf = await PDFDocument.load(out, { updateMetadata: false })
    expect(pdf.getTitle()).toBeUndefined()
    expect(pdf.getProducer()).toBeUndefined()
    expect(pdf.catalog.get(PDFName.of('Metadata'))).toBeUndefined()
    expect(pdf.catalog.get(PDFName.of('OpenAction'))).toBeUndefined()
    const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
    expect(names?.get(PDFName.of('EmbeddedFiles'))).toBeUndefined()
    expect(names?.get(PDFName.of('JavaScript'))).toBeUndefined()
    // The hidden "DRAFT" layer is gone, visible content stays.
    const text = await pdfjsText(out)
    expect(text).toContain('ALWAYS')
    expect(await rawContains(out, 'DRAFT')).toBe(false)
    expect(pdf.catalog.get(PDFName.of('OCProperties'))).toBeUndefined()
    // The link keeps working.
    expect((await pageAnnotations(out, 1)).some((a) => a.subtype === 'Link')).toBe(true)
  })

  it('leaves everything in place without the option', async () => {
    const out = await exportDocument(await openDocument(await richPdf(), 's.pdf'))
    expect(await rawContains(out, 'attached secret data')).toBe(true)
    expect(await rawContains(out, 'DRAFT')).toBe(true)
  })

  it('also redacts the areas', async () => {
    const doc = await openDocument(await richPdf(), 's.pdf')
    const d = addRedactions(doc, [makeRedaction(doc.pages[0].id, { x: 40, y: 400 - 325, width: 120, height: 30 })])
    const out = await exportDocument(d, { sanitize: true })
    expect(await pdfjsText(out)).not.toContain('ALWAYS')
  })
})
