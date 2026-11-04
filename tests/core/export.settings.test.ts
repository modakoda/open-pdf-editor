import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString } from '@cantoo/pdf-lib'
import {
  InvalidPasswordError,
  PRODUCER,
  PasswordRequiredError,
  addObject,
  createBlankDocument,
  exportDocument,
  loadSource,
  openDocument,
  updateSettings
} from '../../src/core'
import { FIXTURE_PASSWORD, makeEncryptedPdf, makeOwnerOnlyEncryptedPdf, makeTextPdf } from '../fixtures/pdfs'
import { allPagesText, openWithPdfjs, closePdfjs, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

describe('export: metadata', () => {
  it('applies overrides on top of the source metadata', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'a.pdf')
    doc = updateSettings(doc, { metadata: { title: 'Sutartis Nr. 5 – ąčę', keywords: 'contract, 2026, signed', subject: 'Legal' } })
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    // The rest (producer and dates too) is the source's.
    expect(re.metadata).toEqual({
      ...doc.sources[doc.primarySourceId!].metadata,
      title: 'Sutartis Nr. 5 – ąčę',
      keywords: 'contract, 2026, signed',
      subject: 'Legal'
    })
    expect(re.metadata.author).toBe('Fixture Author')
    const pdfjsDoc = await openWithPdfjs(out)
    const info = (await pdfjsDoc.getMetadata()).info as Record<string, unknown>
    expect(info.Title).toBe('Sutartis Nr. 5 – ąčę')
    await closePdfjs(pdfjsDoc)
  })

  it('lets the user override the producer and clear fields', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'a.pdf')
    doc = updateSettings(doc, { metadata: { producer: 'Custom', author: '' } })
    const re = await loadSource(await exportDocument(doc), 'out.pdf')
    expect(re.metadata.producer).toBe('Custom')
    expect(re.metadata.author).toBeUndefined()
    expect(re.metadata.title).toBe('Text fixture')
  })

  it('reads and writes dates and custom properties', async () => {
    const src = await PDFDocument.create()
    src.addPage()
    src.setCreator('Word')
    src.setCreationDate(new Date('2024-01-03T10:20:30Z'))
    src.setModificationDate(new Date('2024-06-01T00:00:00Z'))
    const info = src.context.lookup(src.context.trailerInfo.Info) as PDFDict
    info.set(PDFName.of('Company'), PDFHexString.fromText('ACME'))
    info.set(PDFName.of('Department'), PDFString.of('Legal'))
    info.set(PDFName.of('Count'), PDFNumber.of(3))
    let doc = await openDocument(await src.save({ updateFieldAppearances: false }), 'a.pdf')
    expect(doc.sources[doc.primarySourceId!].metadata).toMatchObject({
      creator: 'Word',
      creationDate: '2024-01-03T10:20:30.000Z',
      modificationDate: '2024-06-01T00:00:00.000Z',
      custom: { Company: 'ACME', Department: 'Legal' }
    })

    // Unchanged: kept, the modification date too.
    let re = await loadSource(await exportDocument(doc), 'out.pdf')
    expect(re.metadata).toEqual(doc.sources[doc.primarySourceId!].metadata)

    doc = updateSettings(doc, {
      metadata: {
        creator: 'Pages',
        creationDate: '2020-05-06T07:08:09.000Z',
        modificationDate: '2021-01-02T03:04:05.000Z',
        custom: { Company: 'Globex', 'Šaltinis #1 / ąčę': 'Įmonė', Empty: '' }
      }
    })
    const out = await exportDocument(doc)
    re = await loadSource(out, 'out.pdf')
    expect(re.metadata).toMatchObject({
      creator: 'Pages',
      creationDate: '2020-05-06T07:08:09.000Z',
      modificationDate: '2021-01-02T03:04:05.000Z'
    })
    expect(re.metadata.custom).toEqual({ Company: 'Globex', 'Šaltinis #1 / ąčę': 'Įmonė', Empty: '' })
    // Entries that are not text are not custom properties: left alone.
    const raw = await PDFDocument.load(out, { updateMetadata: false })
    expect((raw.context.lookup(raw.context.trailerInfo.Info) as PDFDict).get(PDFName.of('Count'))).toEqual(PDFNumber.of(3))
    const pdfjsDoc = await openWithPdfjs(out)
    const pdfjsInfo = (await pdfjsDoc.getMetadata()).info as Record<string, unknown>
    expect(pdfjsInfo.Creator).toBe('Pages')
    expect((pdfjsInfo.Custom as Map<string, unknown>).get('Company')).toBe('Globex')
    await closePdfjs(pdfjsDoc)
  })

  it('removes dates and all custom properties when cleared', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'a.pdf')
    doc = updateSettings(doc, { metadata: { custom: { Company: 'ACME' } } })
    doc = await openDocument(await exportDocument(doc), 'b.pdf')
    doc = updateSettings(doc, { metadata: { creationDate: '', modificationDate: '', custom: {} } })
    const re = await loadSource(await exportDocument(doc), 'out.pdf')
    expect(re.metadata.creationDate).toBeUndefined()
    expect(re.metadata.modificationDate).toBeUndefined()
    expect(re.metadata.custom).toBeUndefined()
    expect(re.metadata.title).toBe('Text fixture')
  })

  it('keeps the metadata of an opened file as it is', async () => {
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>'
    const src = await PDFDocument.create({ updateMetadata: false })
    src.addPage()
    src.setTitle('Original')
    src.setProducer('Acrobat Distiller 10.0')
    src.setCreator('Word')
    src.setCreationDate(new Date('2020-01-02T03:04:05Z'))
    src.setModificationDate(new Date('2021-02-03T04:05:06Z'))
    const srcInfo = src.context.lookup(src.context.trailerInfo.Info) as PDFDict
    srcInfo.set(PDFName.of('Trapped'), PDFName.of('False'))
    srcInfo.set(PDFName.of('Company'), PDFString.of('ACME'))
    src.catalog.set(PDFName.of('Metadata'), src.context.register(src.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })))
    let doc = await openDocument(await src.save({ updateFieldAppearances: false }), 'a.pdf')
    // Edited content, not edited properties.
    doc = addObject(doc, { id: 'tx', pageId: doc.pages[0].id, type: 'text', x: 50, y: 300, width: 300, height: 30, text: 'Added', font: 'sans', bold: false, italic: false, fontSize: 14, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0 })
    const out = await PDFDocument.load(await exportDocument(doc), { updateMetadata: false })
    const entries = (pdf: PDFDocument) => {
      const info = pdf.context.lookup(pdf.context.trailerInfo.Info) as PDFDict
      return Object.fromEntries(info.entries().map(([k, v]) => [k.toString(), pdf.context.lookup(v)?.toString()]))
    }
    expect(entries(out)).toEqual(entries(src))
    const stream = out.context.lookup(out.catalog.get(PDFName.of('Metadata'))) as PDFRawStream
    expect(new TextDecoder().decode(stream.getContents())).toBe(xmp)

    // Nothing is added to a file without metadata.
    const bare = await PDFDocument.create({ updateMetadata: false })
    bare.addPage()
    const exported = await PDFDocument.load(await exportDocument(await openDocument(await bare.save(), 'b.pdf')), { updateMetadata: false })
    expect(exported.context.trailerInfo.Info).toBeUndefined()
  })

  it('edits the same properties in the XMP packet and keeps the rest of it', async () => {
    const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original</rdf:li></rdf:Alt></dc:title>
<pdf:Producer>Acrobat Distiller</pdf:Producer>
<xmpMM:DocumentID>uuid:1234</xmpMM:DocumentID>
<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`
    const src = await PDFDocument.create({ updateMetadata: false })
    src.addPage()
    src.setTitle('Original')
    src.setProducer('Acrobat Distiller')
    src.catalog.set(PDFName.of('Metadata'), src.context.register(src.context.flateStream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })))
    let doc = await openDocument(await src.save({ updateFieldAppearances: false }), 'a.pdf')
    doc = updateSettings(doc, { metadata: { title: 'Sutartis – ąčę' } })
    const out = await exportDocument(doc)

    const pdf = await PDFDocument.load(out, { updateMetadata: false })
    const stream = pdf.context.lookup(pdf.catalog.get(PDFName.of('Metadata'))) as PDFRawStream
    expect(stream.dict.get(PDFName.of('Filter'))).toBeUndefined()
    const text = new TextDecoder().decode(stream.getContents())
    for (const kept of ['<pdf:Producer>Acrobat Distiller</pdf:Producer>', '<xmpMM:DocumentID>uuid:1234</xmpMM:DocumentID>', '<pdfaid:part>2</pdfaid:part>']) {
      expect(text).toContain(kept)
    }
    expect(text).not.toContain('Original')
    const pdfjsDoc = await openWithPdfjs(out)
    const { info, metadata } = await pdfjsDoc.getMetadata()
    expect((info as Record<string, unknown>).Title).toBe('Sutartis – ąčę')
    expect(metadata?.get('dc:title')).toBe('Sutartis – ąčę')
    expect(metadata?.get('pdfaid:part')).toBe('2')
    await closePdfjs(pdfjsDoc)
  })

  it('writes metadata for new documents', async () => {
    const doc = updateSettings(createBlankDocument(), { metadata: { title: 'New', author: 'Me' } })
    const re = await loadSource(await exportDocument(doc), 'new.pdf')
    expect(re.metadata).toMatchObject({ title: 'New', author: 'Me', producer: PRODUCER, creator: PRODUCER })
  })
})

describe('export: encryption', () => {
  it('encrypts with AES-256 and requires the password', async () => {
    let doc = await openDocument(await makeTextPdf(2), 'a.pdf')
    doc = updateSettings(doc, { encryption: { userPassword: 'open-me', ownerPassword: 'owner-pw' } })
    const out = await exportDocument(doc)
    await expect(loadSource(out, 'out.pdf')).rejects.toBeInstanceOf(PasswordRequiredError)
    await expect(loadSource(out, 'out.pdf', { password: 'nope' })).rejects.toBeInstanceOf(InvalidPasswordError)
    const re = await loadSource(out, 'out.pdf', { password: 'open-me' })
    expect(re.isEncrypted).toBe(true)
    expect(re.pageCount).toBe(2)
    expect(re.metadata.title).toBe('Text fixture')
    expect((await loadSource(out, 'out.pdf', { password: 'owner-pw' })).pageCount).toBe(2)
    // pdf.js agrees.
    await expect(openWithPdfjs(out)).rejects.toMatchObject({ name: 'PasswordException' })
    expect(await allPagesText(out, 'open-me')).toEqual([
      'Page 1 Lorem ipsum dolor sit amet',
      'Page 2 Lorem ipsum dolor sit amet'
    ])
    const raw = await PDFDocument.load(out, { ignoreEncryption: true })
    expect(raw.isEncrypted).toBe(true)
  })

  it('re-encrypts an opened encrypted file with its password by default', async () => {
    const doc = await openDocument(await makeEncryptedPdf(), 'enc.pdf', { password: FIXTURE_PASSWORD })
    const out = await exportDocument(doc)
    await expect(loadSource(out, 'out.pdf')).rejects.toBeInstanceOf(PasswordRequiredError)
    const re = await loadSource(out, 'out.pdf', { password: FIXTURE_PASSWORD })
    expect(re.pageCount).toBe(2)
  })

  it('saves decrypted when encryption is cleared', async () => {
    let doc = await openDocument(await makeEncryptedPdf(), 'enc.pdf', { password: FIXTURE_PASSWORD })
    doc = updateSettings(doc, { encryption: null })
    doc = addObject(doc, {
      id: 'n',
      pageId: doc.pages[0].id,
      type: 'text',
      x: 72,
      y: 400,
      width: 300,
      height: 30,
      text: 'Decrypted copy',
      font: 'sans',
      bold: false,
      italic: false,
      fontSize: 12,
      color: '#000000',
      align: 'left',
      lineHeight: 1.2,
      rotation: 0
    })
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.isEncrypted).toBe(false)
    expect(re.metadata.title).toBe('Text fixture')
    const texts = await allPagesText(out)
    expect(texts[0]).toBe('Page 1 Lorem ipsum dolor sit amet Decrypted copy')
  })

  it('owner-only encrypted files export unencrypted by default', async () => {
    const doc = await openDocument(await makeOwnerOnlyEncryptedPdf(), 'owner.pdf')
    const re = await loadSource(await exportDocument(doc), 'out.pdf')
    expect(re.isEncrypted).toBe(false)
    expect(re.pageCount).toBe(1)
  })

  it('supports an owner password without a user password', async () => {
    let doc = await openDocument(await makeTextPdf(1), 'a.pdf')
    doc = updateSettings(doc, { encryption: { userPassword: '', ownerPassword: 'boss' } })
    const out = await exportDocument(doc)
    const re = await loadSource(out, 'out.pdf')
    expect(re.isEncrypted).toBe(true)
    expect(re.password).toBe('')
  })
})
