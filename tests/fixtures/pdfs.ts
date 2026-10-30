/**
 * Test PDFs generated on the fly. Shared by core unit tests, renderer tests and e2e tests.
 * Only depends on @cantoo/pdf-lib so it can also run under plain Node (see generate.ts).
 */
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'

export const A4: [number, number] = [595.28, 841.89]
export const LETTER: [number, number] = [612, 792]
export const FIXTURE_PASSWORD = 'secret'

/** `pages` pages; each shows "Page N" near the top-left and "Lorem ipsum" body text. */
export async function makeTextPdf(pages = 3, size: [number, number] = A4): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle('Text fixture')
  doc.setAuthor('Fixture Author')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage(size)
    page.drawText(`Page ${i}`, { x: 72, y: size[1] - 72, size: 24, font, color: rgb(0, 0, 0) })
    page.drawText('Lorem ipsum dolor sit amet', { x: 72, y: size[1] - 120, size: 12, font })
  }
  return doc.save()
}

/** Four pages with /Rotate 0, 90, 180, 270. */
export async function makeRotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  ;[0, 90, 180, 270].forEach((r, i) => {
    const page = doc.addPage(A4)
    page.drawText(`Rotated ${r}`, { x: 72, y: A4[1] - 72, size: 24, font })
    page.setRotation(degrees(r))
    void i
  })
  return doc.save()
}

/** One page whose media box and crop box do not start at the origin. */
export async function makeCropBoxPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([700, 900])
  page.setMediaBox(-50, -50, 700, 900)
  page.setCropBox(50, 100, 500, 600)
  page.drawText('Cropped', { x: 100, y: 650, size: 24, font })
  return doc.save()
}

/** A4, Letter and landscape A4 pages. */
export async function makeMixedSizesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const sizes: [number, number][] = [A4, LETTER, [A4[1], A4[0]]]
  sizes.forEach((s, i) => {
    const page = doc.addPage(s)
    page.drawText(`Size ${i + 1}`, { x: 72, y: s[1] - 72, size: 24, font })
  })
  return doc.save()
}

/**
 * AcroForm with: name (text), email (text), notes (multiline text), agree (checkbox),
 * color (radio: red/green/blue), country (dropdown), langs (option list, multi-select),
 * readonly (read-only text, value "fixed"). Page 2 has the field "page2" (text).
 */
export async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage(A4)
  const page2 = doc.addPage(A4)
  const form = doc.getForm()
  const top = A4[1]
  const label = (text: string, y: number) => page.drawText(text, { x: 50, y: y + 6, size: 11, font })

  label('Name', top - 100)
  form.createTextField('name').addToPage(page, { x: 150, y: top - 100, width: 250, height: 22 })
  label('Email', top - 140)
  form.createTextField('email').addToPage(page, { x: 150, y: top - 140, width: 250, height: 22 })

  label('Notes', top - 230)
  const notes = form.createTextField('notes')
  notes.enableMultiline()
  notes.addToPage(page, { x: 150, y: top - 230, width: 250, height: 70 })

  label('Agree', top - 270)
  form.createCheckBox('agree').addToPage(page, { x: 150, y: top - 270, width: 18, height: 18 })

  label('Color', top - 310)
  const color = form.createRadioGroup('color')
  ;['red', 'green', 'blue'].forEach((v, i) =>
    color.addOptionToPage(v, page, { x: 150 + i * 60, y: top - 310, width: 18, height: 18 })
  )

  label('Country', top - 350)
  const country = form.createDropdown('country')
  country.addOptions(['Lithuania', 'Germany', 'France'])
  country.addToPage(page, { x: 150, y: top - 350, width: 200, height: 22 })

  label('Languages', top - 440)
  const langs = form.createOptionList('langs')
  langs.addOptions(['English', 'German', 'Lithuanian'])
  langs.enableMultiselect()
  langs.addToPage(page, { x: 150, y: top - 440, width: 200, height: 70 })

  label('Read only', top - 480)
  const ro = form.createTextField('readonly')
  ro.setText('fixed')
  ro.enableReadOnly()
  ro.addToPage(page, { x: 150, y: top - 480, width: 200, height: 22 })

  page2.drawText('Second page', { x: 50, y: top - 60, size: 14, font })
  form.createTextField('page2').addToPage(page2, { x: 150, y: top - 100, width: 200, height: 22 })

  return doc.save()
}

/** Two-page text PDF encrypted with a user password (default "secret"). */
export async function makeEncryptedPdf(password = FIXTURE_PASSWORD): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await makeTextPdf(2))
  doc.encrypt({ userPassword: password, ownerPassword: `${password}-owner` })
  return doc.save()
}

/** Encrypted with an owner password only: opens without asking for a password. */
export async function makeOwnerOnlyEncryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await makeTextPdf(1))
  doc.encrypt({ userPassword: '', ownerPassword: 'owner-only' })
  return doc.save()
}

/** One page with an existing link annotation and a sticky note annotation. */
export async function makeAnnotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage(A4)
  page.drawText('Annotated', { x: 72, y: A4[1] - 72, size: 24, font })
  const link = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 700, 272, 720],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') }
  })
  const note = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [400, 700, 420, 720],
    Contents: PDFString.of('Existing note'),
    Name: 'Comment'
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link), doc.context.register(note)]))
  return doc.save()
}

export const FIXTURES = {
  'text-3pages.pdf': () => makeTextPdf(3),
  'text-10pages.pdf': () => makeTextPdf(10),
  'rotated.pdf': makeRotatedPdf,
  'cropbox.pdf': makeCropBoxPdf,
  'mixed-sizes.pdf': makeMixedSizesPdf,
  'form.pdf': makeFormPdf,
  'encrypted.pdf': () => makeEncryptedPdf(),
  'owner-only-encrypted.pdf': makeOwnerOnlyEncryptedPdf,
  'annotated.pdf': makeAnnotatedPdf,
  'existing-content.pdf': makeExistingContentPdf
} as const

export type FixtureName = keyof typeof FIXTURES

// ---------------------------------------------------------------------------------------
// Additional fixtures (core engine tests)
// ---------------------------------------------------------------------------------------
// eslint-disable-next-line import/first
import { concatTransformationMatrix, setFillingRgbColor } from '@cantoo/pdf-lib'

/**
 * One A4 page whose content stream ends with an unbalanced "3 0 0 3 0 0 cm" (no q/Q), so
 * anything appended naively after it would be drawn 3x scaled.
 */
export async function makeUnbalancedGraphicsStatePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage(A4)
  page.drawText('Unbalanced', { x: 72, y: A4[1] - 72, size: 24, font })
  page.pushOperators(concatTransformationMatrix(3, 0, 0, 3, 0, 0), setFillingRgbColor(1, 0, 0))
  return doc.save()
}

/**
 * Two pages under an intermediate page-tree node that provides the (inherited) MediaBox
 * [0 0 400 600] and /Rotate 90. Page texts: "Inherited 1", "Inherited 2".
 */
export async function makeInheritedAttributesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = [1, 2].map((n) => {
    const page = doc.addPage([400, 600])
    page.drawText(`Inherited ${n}`, { x: 50, y: 500, size: 20, font })
    return page
  })
  const ctx = doc.context
  const rootRef = doc.catalog.get(PDFName.of('Pages'))!
  const mid = ctx.obj({
    Type: 'Pages',
    Parent: rootRef,
    Kids: pages.map((p) => p.ref),
    Count: pages.length,
    MediaBox: [0, 0, 400, 600],
    Rotate: 90
  })
  const midRef = ctx.register(mid)
  doc.catalog.Pages().set(PDFName.of('Kids'), ctx.obj([midRef]))
  for (const p of pages) {
    p.node.set(PDFName.of('Parent'), midRef)
    p.node.delete(PDFName.of('MediaBox'))
  }
  return doc.save()
}

/** Two pages; page 2 contains an internal link to page 1 and a URI link. */
export async function makeLinkedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage(A4)
  const p2 = doc.addPage(A4)
  p1.drawText('Target page', { x: 72, y: A4[1] - 72, size: 24, font })
  p2.drawText('Links page', { x: 72, y: A4[1] - 72, size: 24, font })
  const internal = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 600, 272, 620],
    Border: [0, 0, 0],
    Dest: [p1.ref, 'XYZ', null, null, null]
  })
  const uri = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 500, 272, 520],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org') }
  })
  p2.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(internal), doc.context.register(uri)]))
  return doc.save()
}

// ---------------------------------------------------------------------------------------
// Fixtures for engine review findings
// ---------------------------------------------------------------------------------------
// eslint-disable-next-line import/first
import {
  PDFBool,
  PDFDict,
  PDFOperator,
  PDFOperatorNames,
  PDFRawStream,
  type PDFRef as FixtureRef
} from '@cantoo/pdf-lib'

/** One page "Secret text"; encrypted with the given algorithm (RC4 needs allowWeakCryptography). */
export async function makeEncryptedWithPdf(
  algorithm: 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40',
  userPassword: string,
  ownerPassword: string,
  permissions: { printing?: boolean | 'lowResolution' | 'highResolution'; copying?: boolean; modifying?: boolean } = {
    printing: 'highResolution'
  }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle('Encrypted fixture')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage(A4).drawText('Secret text', { x: 72, y: A4[1] - 72, size: 24, font })
  doc.encrypt({ userPassword, ownerPassword, algorithm, allowWeakCryptography: true, permissions })
  return doc.save()
}

/**
 * Strings stored directly in the catalog and page dictionary (uncompressed objects):
 * /Lang "lt-LT", /PageLabels prefix "Cover-", a direct link annotation with a /URI.
 * `version14` writes a PDF 1.4 file (no object streams at all).
 */
export async function makeDirectStringsPdf(version14 = false): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const font = await d.embedFont(StandardFonts.Helvetica)
  const page = d.addPage([400, 400])
  page.drawText('Hi', { x: 50, y: 300, font })
  const ctx = d.context
  d.setTitle('Direct strings')
  d.catalog.set(PDFName.of('Lang'), PDFString.of('lt-LT'))
  d.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, { S: 'D', P: PDFString.of('Cover-') }] }))
  page.node.set(
    PDFName.of('Annots'),
    ctx.obj([
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [50, 50, 150, 70],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.com/a') }
      })
    ])
  )
  if (version14) {
    const { PDFHeader } = await import('@cantoo/pdf-lib')
    d.context.header = PDFHeader.forVersion(1, 4)
    return d.save({ useObjectStreams: false })
  }
  return d.save()
}

/** A text field whose /V was set by another tool with /NeedAppearances true and a stale (empty) appearance. */
export async function makeNeedAppearancesPdf(value = 'Jonas Jonaitis'): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage(A4)
  d.getForm().createTextField('name').addToPage(page, { x: 50, y: 700, width: 200, height: 20 })
  const d2 = await PDFDocument.load(await d.save())
  d2.getForm().getTextField('name').acroField.dict.set(PDFName.of('V'), PDFString.of(value))
  d2.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('NeedAppearances'), d2.context.obj(true))
  return d2.save({ updateFieldAppearances: false })
}

/** Dropdown "country" and multi-select list "langs" with [export, display] /Opt pairs. */
export async function makeChoiceExportValuesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage(A4)
  const form = doc.getForm()
  const dd = form.createDropdown('country')
  dd.addToPage(page, { x: 100, y: 700, width: 200, height: 20 })
  const ol = form.createOptionList('langs')
  ol.addToPage(page, { x: 100, y: 600, width: 200, height: 60 })
  ol.enableMultiselect()
  const ctx = doc.context
  dd.acroField.dict.set(
    PDFName.of('Opt'),
    ctx.obj([
      [PDFString.of('LT'), PDFString.of('Lithuania')],
      [PDFString.of('DE'), PDFString.of('Germany')]
    ])
  )
  dd.acroField.dict.set(PDFName.of('V'), PDFString.of('LT'))
  ol.acroField.dict.set(
    PDFName.of('Opt'),
    ctx.obj([
      [PDFString.of('en'), PDFString.of('English')],
      [PDFString.of('de'), PDFString.of('German')],
      [PDFString.of('lt'), PDFString.of('Lithuanian')]
    ])
  )
  ol.acroField.dict.set(PDFName.of('V'), ctx.obj([PDFString.of('en')]))
  return doc.save({ updateFieldAppearances: false })
}

/** Checkbox "married" with two widgets whose on-states are /Yes and /No (V = /No). */
export async function makeYesNoCheckboxPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage(A4)
  const cb = d.getForm().createCheckBox('married')
  cb.addToPage(page, { x: 50, y: 700, width: 15, height: 15 })
  cb.addToPage(page, { x: 100, y: 700, width: 15, height: 15 })
  const [w1, w2] = cb.acroField.getWidgets()
  const ap2 = w2.dict.lookup(PDFName.of('AP'), PDFDict)
  for (const k of ['N', 'D']) {
    const sub = ap2.lookup(PDFName.of(k)) as PDFDict | undefined
    if (sub) {
      const on = sub.get(PDFName.of('Yes'))
      sub.delete(PDFName.of('Yes'))
      sub.set(PDFName.of('No'), on!)
    }
  }
  cb.acroField.dict.set(PDFName.of('V'), PDFName.of('No'))
  w1.dict.set(PDFName.of('AS'), PDFName.of('Off'))
  w2.dict.set(PDFName.of('AS'), PDFName.of('No'))
  return d.save({ updateFieldAppearances: false })
}

/** Text fields "secret" (Hidden flag, value HIDDENVALUE) and "visible" (value SHOWNVALUE). */
export async function makeHiddenWidgetPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage(A4)
  const form = doc.getForm()
  const f = form.createTextField('secret')
  f.setText('HIDDENVALUE')
  f.addToPage(page, { x: 100, y: 500, width: 200, height: 20 })
  f.acroField.getWidgets()[0].dict.set(PDFName.of('F'), doc.context.obj(2))
  const g = form.createTextField('visible')
  g.setText('SHOWNVALUE')
  g.addToPage(page, { x: 100, y: 400, width: 200, height: 20 })
  return doc.save()
}

/**
 * Two text fields with hand-made appearances: "rotated" (widget Rect 100,500 20x200 with an
 * Acrobat-style /Matrix [0 1 -1 0 0 0], text ROTATED) and "offset" (Rect 300,300 200x20,
 * BBox [300 300 500 320], text OFFSET drawn at 302,305).
 */
export async function makeAppearanceMatrixFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage(A4)
  const form = doc.getForm()
  const ctx = doc.context
  const a = form.createTextField('rotated')
  a.addToPage(page, { x: 100, y: 500, width: 20, height: 200, borderWidth: 0 })
  a.acroField.dict.set(PDFName.of('V'), PDFString.of('ROTATED'))
  const wa = a.acroField.getWidgets()[0]
  wa.dict.set(PDFName.of('Rect'), ctx.obj([100, 500, 120, 700]))
  wa.dict.set(PDFName.of('MK'), ctx.obj({ R: 90 }))
  const apA = ctx.stream(`/Tx BMC q BT /F1 12 Tf 2 5 Td (ROTATED) Tj ET Q EMC`, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 200, 20],
    Matrix: [0, 1, -1, 0, 0, 0],
    Resources: { Font: { F1: font.ref } }
  })
  wa.dict.set(PDFName.of('AP'), ctx.obj({ N: ctx.register(apA) }))
  const b = form.createTextField('offset')
  b.addToPage(page, { x: 300, y: 300, width: 200, height: 20, borderWidth: 0 })
  b.acroField.dict.set(PDFName.of('V'), PDFString.of('OFFSET'))
  const wb = b.acroField.getWidgets()[0]
  wb.dict.set(PDFName.of('Rect'), ctx.obj([300, 300, 500, 320]))
  const apB = ctx.stream(`/Tx BMC q BT /F1 12 Tf 302 305 Td (OFFSET) Tj ET Q EMC`, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [300, 300, 500, 320],
    Resources: { Font: { F1: font.ref } }
  })
  wb.dict.set(PDFName.of('AP'), ctx.obj({ N: ctx.register(apB) }))
  return doc.save({ updateFieldAppearances: false })
}

const PDFA_XMP = (part: number) =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/"><pdfaid:part>${part}</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Statement</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`

/** A file whose XMP claims PDF/A-`part`B; optionally encrypted (user password, owner "bank"). */
export async function makePdfAClaimPdf(part = 2, userPassword?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage(A4).drawText('Statement', { x: 50, y: 700, font })
  if (userPassword !== undefined) doc.encrypt({ userPassword, ownerPassword: 'bank' })
  const stream = doc.context.stream(new TextEncoder().encode(PDFA_XMP(part)), { Type: 'Metadata', Subtype: 'XML' })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream))
  return doc.save({ useObjectStreams: false })
}

/**
 * Hand-written PDF whose page /Resources object has a syntax glitch (pdf-lib keeps it as an
 * unparsed object); the page draws "HELLO" with the Courier-Bold font referenced from it.
 */
export function makeInvalidResourcesPdf(resourcesBody = `<< /Font << /F1 6 0 R >> /ProcSet [/PDF /Text] /Foo >>`): Uint8Array {
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources 4 0 R /Contents 5 0 R >>`,
    resourcesBody,
    null,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>`
  ]
  const content = 'BT /F1 24 Tf 50 150 Td (HELLO) Tj ET'
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    if (o === null) out += `${i + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
    else out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/**
 * Tagged three-page PDF. Page 2 holds "SECRET PAGE TEXT", a filled field "ssn"
 * (123-45-6789) and a note "Confidential reviewer note", all referenced from the structure
 * tree / ParentTree. Outline: "Intro" → p1, "Secret" → p2 (with child "Inside" → p3),
 * "End" → p3; named destination "secret" → p2; page 1 links to p2 (explicit) and to "secret".
 */
export async function makeTaggedSecretPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const font = await d.embedFont(StandardFonts.Helvetica)
  const p1 = d.addPage(A4)
  const p2 = d.addPage(A4)
  const p3 = d.addPage(A4)
  p1.drawText('Public page', { x: 50, y: 700, font })
  p2.drawText('SECRET PAGE TEXT', { x: 50, y: 700, font })
  p3.drawText('Last page', { x: 50, y: 700, font })
  const form = d.getForm()
  const f = form.createTextField('ssn')
  f.setText('123-45-6789')
  f.addToPage(p2, { x: 50, y: 600, width: 200, height: 20 })
  const pub = form.createTextField('public')
  pub.setText('PUBLICVALUE')
  pub.addToPage(p1, { x: 50, y: 600, width: 200, height: 20 })
  const ctx = d.context
  const widget = f.acroField.getWidgets()[0]
  const widgetRef = ctx.getObjectRef(widget.dict)!
  const note = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [300, 700, 320, 720],
      Contents: PDFString.of('Confidential reviewer note'),
      P: p2.ref,
      StructParent: 1
    })
  )
  p2.node.addAnnot(note)
  widget.dict.set(PDFName.of('StructParent'), ctx.obj(0))
  p1.node.set(PDFName.of('StructParents'), ctx.obj(2))
  p2.node.set(PDFName.of('StructParents'), ctx.obj(3))
  const root = ctx.nextRef()
  const formElem = ctx.register(
    ctx.obj({ Type: 'StructElem', S: 'Form', P: root, Pg: p2.ref, K: ctx.obj({ Type: 'OBJR', Obj: widgetRef, Pg: p2.ref }) })
  )
  const annotElem = ctx.register(
    ctx.obj({ Type: 'StructElem', S: 'Annot', P: root, Pg: p2.ref, K: ctx.obj({ Type: 'OBJR', Obj: note, Pg: p2.ref }) })
  )
  const p1Elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: root, Pg: p1.ref, K: 0 }))
  const p2Elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: root, Pg: p2.ref, K: 0, ID: PDFString.of('secret-par') }))
  ctx.assign(
    root,
    ctx.obj({
      Type: 'StructTreeRoot',
      K: [p1Elem, formElem, annotElem, p2Elem],
      ParentTree: ctx.obj({ Nums: [0, formElem, 1, annotElem, 2, [p1Elem], 3, [p2Elem]] }),
      IDTree: ctx.obj({ Names: [PDFString.of('secret-par'), p2Elem] })
    })
  )
  d.catalog.set(PDFName.of('StructTreeRoot'), root)
  d.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }))

  // Outline
  const outlines = ctx.nextRef()
  const [intro, secret, inside, end] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()]
  const dest = (p: { ref: FixtureRef }) => ctx.obj([p.ref, 'XYZ', null, null, null])
  ctx.assign(intro, ctx.obj({ Title: PDFString.of('Intro'), Parent: outlines, Next: secret, Dest: dest(p1) }))
  ctx.assign(
    secret,
    ctx.obj({ Title: PDFString.of('Secret'), Parent: outlines, Prev: intro, Next: end, First: inside, Last: inside, Count: 1, Dest: dest(p2) })
  )
  ctx.assign(inside, ctx.obj({ Title: PDFString.of('Inside'), Parent: secret, Dest: dest(p3) }))
  ctx.assign(end, ctx.obj({ Title: PDFString.of('End'), Parent: outlines, Prev: secret, Dest: dest(p3) }))
  ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: intro, Last: end, Count: 4 }))
  d.catalog.set(PDFName.of('Outlines'), outlines)
  d.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of('secret'), dest(p2)] }) }))
  const link = (rect: number[], extra: Record<string, unknown>) =>
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...extra } as never))
  p1.node.addAnnot(link([50, 500, 150, 520], { Dest: dest(p2) }))
  p1.node.addAnnot(link([50, 450, 150, 470], { Dest: PDFString.of('secret') }))
  p1.node.addAnnot(link([50, 400, 150, 420], { Dest: dest(p3) }))
  return d.save({ useObjectStreams: false })
}

const PLAIN_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP Title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`

/** Owner-only AES-256 file with an unencrypted XMP packet and /EncryptMetadata false. */
export async function makeEncryptMetadataFalsePdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const font = await d.embedFont(StandardFonts.Helvetica)
  d.addPage(A4).drawText('x', { x: 50, y: 700, font })
  d.catalog.set(
    PDFName.of('Metadata'),
    d.context.register(d.context.stream(new TextEncoder().encode(PLAIN_XMP), { Type: 'Metadata', Subtype: 'XML' }))
  )
  d.encrypt({ userPassword: '', ownerPassword: 'o' })
  const enc = await d.save({ useObjectStreams: false })
  const raw = await PDFDocument.load(enc, { ignoreEncryption: true, updateMetadata: false })
  const mdRef = raw.catalog.get(PDFName.of('Metadata')) as FixtureRef
  raw.context.assign(
    mdRef,
    PDFRawStream.of(
      raw.context.obj({ Type: 'Metadata', Subtype: 'XML', Length: PLAIN_XMP.length }) as PDFDict,
      new TextEncoder().encode(PLAIN_XMP)
    )
  )
  raw.context.lookup(raw.context.trailerInfo.Encrypt, PDFDict).set(PDFName.of('EncryptMetadata'), PDFBool.False)
  return raw.save({ useObjectStreams: false })
}

/** `pages` pages with `perPage` text fields each, plus `extraObjects` unrelated objects. */
export async function makeBigFormPdf(pages: number, perPage: number, extraObjects = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const form = doc.getForm()
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4)
    for (let k = 0; k < perPage; k++) {
      form.createTextField(`f${p}_${k}`).addToPage(page, { x: 50, y: 50 + k * 30, width: 200, height: 20 })
    }
  }
  const arr = []
  for (let i = 0; i < extraObjects; i++) arr.push(doc.context.register(doc.context.obj({ N: i })))
  if (arr.length) doc.catalog.set(PDFName.of('Junk'), doc.context.obj(arr))
  // Object streams make pdf-lib's writer quadratic for this many objects.
  return doc.save({ useObjectStreams: extraObjects < 10_000 })
}

/** One page drawing a large (incompressible, `bytes` long) image XObject. */
export async function makeLargeImagePdf(bytes = 300_000): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage(A4)
  const data = new Uint8Array(bytes)
  let x = 12345
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    data[i] = x >> 16
  }
  const width = 100
  const height = Math.floor(bytes / (width * 3))
  const img = d.context.stream(data.subarray(0, width * height * 3), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8
  })
  const name = page.node.newXObject('Im', d.context.register(img))
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.PushGraphicsState),
    concatTransformationMatrix(200, 0, 0, 200, 50, 400),
    PDFOperator.of(PDFOperatorNames.DrawObject, [name]),
    PDFOperator.of(PDFOperatorNames.PopGraphicsState)
  )
  return d.save()
}

/** Text fields "name" and "city" with /DA "/Helv 0 Tf 0 g" (auto size) and /Helv in /DR. */
export async function makeAutoSizeDAFormPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const helv = await d.embedFont(StandardFonts.Helvetica)
  const page = d.addPage(A4)
  const form = d.getForm()
  const f = form.createTextField('name')
  f.addToPage(page, { x: 50, y: 700, width: 200, height: 20 })
  const g = form.createTextField('city')
  g.addToPage(page, { x: 50, y: 650, width: 200, height: 20 })
  form.acroForm.dict.set(PDFName.of('DR'), d.context.obj({ Font: { Helv: helv.ref } }))
  for (const x of [f, g]) x.acroField.dict.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'))
  return d.save({ updateFieldAppearances: false })
}

/**
 * One page with "DRAFT" in an optional content group that is OFF by default, "ALWAYS"
 * outside it, a link with a named destination "start" and /StructParents 0.
 */
export async function makeOptionalContentPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage([400, 400])
  const ctx = d.context
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Draft') }))
  d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }))
  const font = await d.embedFont(StandardFonts.Helvetica)
  page.node.normalize()
  page.node.Resources()!.set(PDFName.of('Properties'), ctx.obj({ oc1: ocg }))
  page.drawText('ALWAYS', { x: 50, y: 300, size: 20, font })
  page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of('oc1')]))
  page.drawText('DRAFT', { x: 50, y: 200, size: 40, font })
  page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
  page.node.set(PDFName.of('StructParents'), ctx.obj(0))
  d.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of('start'), ctx.obj([page.ref, 'Fit'])] }) }))
  page.node.addAnnot(
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 50, 150, 70], Border: [0, 0, 0], Dest: PDFString.of('start'), StructParent: 1 }))
  )
  return d.save()
}

// ---------------------------------------------------------------------------------------
// Fixtures for editing existing annotations / fields and persisted editor objects
// ---------------------------------------------------------------------------------------

/**
 * One page with common annotation types, in this /Annots order (ids a0…a11):
 * a0 Square, a1 Circle, a2 Line, a3 Ink, a4 Highlight, a5 Underline, a6 StrikeOut,
 * a7 Squiggly, a8 FreeText, a9 Text (with a10 Popup), a11 Link (URI), a12 Stamp,
 * a13 Widget (text field "field1").
 * Options: page /Rotate and a crop box offset (crop box [50 100 550 700] on a 700x900 page).
 */
export async function makeMarkupAnnotationsPdf(options: { rotate?: number; cropped?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = options.cropped ? doc.addPage([700, 900]) : doc.addPage(A4)
  if (options.cropped) page.setCropBox(50, 100, 500, 600)
  if (options.rotate) page.setRotation(degrees(options.rotate))
  page.drawText('Markup page', { x: 120, y: 650, size: 20, font })
  const ctx = doc.context
  const S = (s: string) => PDFString.of(s)
  const ap = (w: number, h: number, ops: string) =>
    ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }))
  const annots = [
    { Subtype: 'Square', Rect: [100, 500, 200, 560], C: [1, 0, 0], IC: [1, 1, 0], BS: { W: 2 }, Contents: S('square note'), T: S('Ann') },
    { Subtype: 'Circle', Rect: [220, 500, 300, 560], C: [0, 0, 1] },
    { Subtype: 'Line', Rect: [100, 440, 300, 480], L: [105, 450, 295, 470], C: [0, 0.5, 0], LE: ['None', 'OpenArrow'], BS: { W: 2 } },
    { Subtype: 'Ink', Rect: [320, 440, 420, 520], InkList: [[330, 450, 360, 500, 410, 460]], C: [0.5, 0, 0.5], BS: { W: 3 } },
    { Subtype: 'Highlight', Rect: [100, 400, 250, 420], QuadPoints: [100, 420, 250, 420, 100, 400, 250, 400], C: [1, 1, 0] },
    { Subtype: 'Underline', Rect: [100, 370, 250, 390], QuadPoints: [100, 390, 250, 390, 100, 370, 250, 370], C: [0, 0, 1] },
    { Subtype: 'StrikeOut', Rect: [100, 340, 250, 360], QuadPoints: [100, 360, 250, 360, 100, 340, 250, 340], C: [1, 0, 0] },
    { Subtype: 'Squiggly', Rect: [100, 310, 250, 330], QuadPoints: [100, 330, 250, 330, 100, 310, 250, 310], C: [0, 0.6, 0] },
    { Subtype: 'FreeText', Rect: [300, 300, 480, 340], Contents: S('Free text'), DA: S('/Helv 12 Tf 0 0 1 rg'), T: S('Writer') },
    { Subtype: 'Text', Rect: [450, 560, 470, 580], Contents: S('Sticky'), T: S('Reviewer'), C: [1, 0.8, 0], Name: 'Comment' },
    { Subtype: 'Popup', Rect: [480, 500, 580, 580], Open: false },
    { Subtype: 'Link', Rect: [100, 250, 200, 270], Border: [0, 0, 0], A: { S: 'URI', URI: S('https://example.com/old') } },
    { Subtype: 'Stamp', Rect: [300, 200, 400, 240], Name: 'Approved', AP: { N: ap(100, 40, '0 0.5 0 rg 0 0 100 40 re f') } }
  ]
  const refs = annots.map((a) => ctx.register(ctx.obj({ Type: 'Annot', P: page.ref, ...a } as never)))
  // Popup ↔ parent
  ctx.lookup(refs[9], PDFDict).set(PDFName.of('Popup'), refs[10])
  ctx.lookup(refs[10], PDFDict).set(PDFName.of('Parent'), refs[9])
  page.node.set(PDFName.of('Annots'), ctx.obj(refs))
  doc.getForm().createTextField('field1').addToPage(page, { x: 300, y: 100, width: 150, height: 20 })
  return doc.save()
}

/**
 * Two pages. Page 1: "name" (text, value "Ona"), "person.age" (text, value "41"), "color" (radio
 * red/green, value green), "country" (dropdown A/B/C, value B), "agree" (checkbox).
 * Page 2: "notes" (text).
 */
export async function makeEditableFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const p1 = doc.addPage(A4)
  const p2 = doc.addPage(A4)
  const form = doc.getForm()
  const name = form.createTextField('name')
  name.setText('Ona')
  name.addToPage(p1, { x: 100, y: 700, width: 200, height: 20 })
  const age = form.createTextField('person.age')
  age.setText('41')
  age.addToPage(p1, { x: 100, y: 650, width: 80, height: 20 })
  const color = form.createRadioGroup('color')
  color.addOptionToPage('red', p1, { x: 100, y: 600, width: 15, height: 15 })
  color.addOptionToPage('green', p1, { x: 140, y: 600, width: 15, height: 15 })
  color.select('green')
  const country = form.createDropdown('country')
  country.addOptions(['A', 'B', 'C'])
  country.select('B')
  country.addToPage(p1, { x: 100, y: 550, width: 120, height: 20 })
  form.createCheckBox('agree').addToPage(p1, { x: 100, y: 500, width: 15, height: 15 })
  form.createTextField('notes').addToPage(p2, { x: 100, y: 700, width: 200, height: 60 })
  return doc.save()
}

// ---------------------------------------------------------------------------------------
// Existing page content (content-stream engine: src/core/content)
// ---------------------------------------------------------------------------------------

/** 1x1 red PNG. */
const RED_PIXEL_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
)

/**
 * Two Letter pages with existing content to select / move / delete / re-type.
 * Page 1 (drawn directly): "Existing title" (Helvetica-Bold 24, blue) at (72, 720); body lines
 * "Body line one" / "Body line two" (Helvetica 12) at y 690 / 674; one TJ table row
 * "Name", "Qty", "Price" (three separate items) at y 640; a red image 100x60 at (72, 500);
 * a yellow rectangle 150x50 at (300, 500).
 * Page 2: everything is inside one page-wrapping form XObject (content item "x1"): "Wrapped
 * title" (Times-Roman 20, item "x1/t3") at (72, 720) and a green rectangle (item "x1/p7") at
 * (72, 600, 120 x 40). Coordinates above are PDF user space (bottom-left origin).
 */
export async function makeExistingContentPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const times = await doc.embedFont(StandardFonts.TimesRoman)
  const p1 = doc.addPage(LETTER)
  p1.drawText('Existing title', { x: 72, y: 720, size: 24, font: bold, color: rgb(0.1, 0.2, 0.7) })
  p1.drawText('Body line one\nBody line two', { x: 72, y: 690, size: 12, font: helv, lineHeight: 16 })
  const img = await doc.embedPng(RED_PIXEL_PNG)
  p1.drawImage(img, { x: 72, y: 500, width: 100, height: 60 })
  p1.drawRectangle({ x: 300, y: 500, width: 150, height: 50, color: rgb(1, 0.9, 0.2) })
  const ctx = doc.context
  const fonts = p1.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  fonts.set(PDFName.of('FT'), helv.ref)
  const table = ctx.register(ctx.flateStream('BT /FT 11 Tf 72 640 Td [(Name) -9000 (Qty) -6000 (Price)] TJ ET'))
  p1.node.addContentStream(table)

  const p2 = doc.addPage(LETTER)
  const form = ctx.register(
    ctx.stream('BT /F1 20 Tf 72 720 Td (Wrapped title) Tj ET 0 0.6 0 rg 72 600 120 40 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, LETTER[0], LETTER[1]],
      Resources: { Font: { F1: times.ref } }
    })
  )
  p2.node.setXObject(PDFName.of('Page'), form)
  p2.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q /Page Do Q')))
  return doc.save()
}

/**
 * Two 600x800 pages. "keep" (text) on page 1; "gone" (text, value "secret on deleted page")
 * only on page 2; "split" (text, value "Jane") with one widget on each page (both at 50,700 200x20).
 */
export async function makeSplitWidgetsPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const p1 = pdf.addPage([600, 800])
  const p2 = pdf.addPage([600, 800])
  const form = pdf.getForm()
  form.createTextField('keep').addToPage(p1, { x: 50, y: 600, width: 200, height: 20 })
  const gone = form.createTextField('gone')
  gone.addToPage(p2, { x: 50, y: 600, width: 200, height: 20 })
  gone.setText('secret on deleted page')
  const split = form.createTextField('split')
  split.addToPage(p1, { x: 50, y: 700, width: 200, height: 20 })
  split.addToPage(p2, { x: 50, y: 700, width: 200, height: 20 })
  split.setText('Jane')
  return pdf.save()
}

/**
 * One 600x800 page: a centered (/Q 1) Courier FreeText with its own appearance, rich text
 * (/RC) and DA "/Cour 18 Tf 0 0 0.8 rg" (a0); a sticky note with /RC (a1); a hidden Square (a2).
 */
export async function makeStyledFreeTextPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([600, 800])
  const ctx = pdf.context
  const cour = await pdf.embedFont(StandardFonts.CourierBold)
  const ap = ctx.register(
    ctx.stream('1 1 0.8 rg 0 0 300 60 re f BT /F1 18 Tf 0 0 0.8 rg 60 25 Td (Centered Courier) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 60],
      Resources: { Font: { F1: cour.ref } }
    } as never)
  )
  const rc = (t: string) => PDFString.of(`<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>${t}</p></body>`)
  const ft = ctx.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [100, 600, 400, 660],
    Contents: PDFString.of('Centered Courier'),
    RC: rc('Centered Courier'),
    DA: PDFString.of('/Cour 18 Tf 0 0 0.8 rg'),
    Q: 1,
    C: [1, 1, 0.8],
    AP: { N: ap }
  })
  const sticky = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [450, 700, 470, 720], Contents: PDFString.of('old comment'), RC: rc('old comment') })
  const hidden = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50], C: [1, 0, 0], F: 2 })
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ft), ctx.register(sticky), ctx.register(hidden)]))
  return pdf.save()
}
