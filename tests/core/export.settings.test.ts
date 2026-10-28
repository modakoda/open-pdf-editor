import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
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
    expect(re.metadata.title).toBe('Sutartis Nr. 5 – ąčę')
    expect(re.metadata.keywords).toBe('contract, 2026, signed')
    expect(re.metadata.subject).toBe('Legal')
    expect(re.metadata.author).toBe('Fixture Author')
    expect(re.metadata.producer).toBe(PRODUCER)
    const pdf = await PDFDocument.load(out, { updateMetadata: false })
    const mod = pdf.getModificationDate()!
    expect(Math.abs(mod.getTime() - Date.now())).toBeLessThan(60_000)
    expect(pdf.getCreationDate()).toBeInstanceOf(Date)
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
