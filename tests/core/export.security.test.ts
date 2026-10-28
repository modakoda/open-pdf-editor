import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream } from '@cantoo/pdf-lib'
import {
  exportDocument,
  loadSource,
  openDocument,
  updateSettings,
  type ExportWarning
} from '../../src/core'
import { md5, rc4 } from '../../src/core/pdfCrypto'
import {
  makeDirectStringsPdf,
  makeEncryptMetadataFalsePdf,
  makeEncryptedWithPdf,
  makePdfAClaimPdf,
  makeTextPdf
} from '../fixtures/pdfs'
import { allPagesText, closePdfjs, openWithPdfjs, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

async function canOpen(bytes: Uint8Array, password: string): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { password, updateMetadata: false })
    return true
  } catch {
    return false
  }
}

async function inspectWithPdfjs(bytes: Uint8Array, password?: string) {
  const doc = await openWithPdfjs(bytes, password)
  try {
    const labels = await doc.getPageLabels()
    const annots = await (await doc.getPage(1)).getAnnotations()
    const md = await doc.getMetadata()
    return {
      labels,
      urls: annots.map((a: Record<string, unknown>) => a.unsafeUrl),
      title: (md.info as Record<string, unknown>).Title,
      lang: (md.info as Record<string, unknown>).Language
    }
  } finally {
    await closePdfjs(doc)
  }
}

describe('crypto primitives', () => {
  it('md5 and rc4 match Node', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(200)]) {
      const bytes = new TextEncoder().encode(s)
      expect(Buffer.from(md5(bytes)).toString('hex')).toBe(createHash('md5').update(bytes).digest('hex'))
    }
    // RC4 test vector ("Key" / "Plaintext")
    const out = rc4(new TextEncoder().encode('Key'), new TextEncoder().encode('Plaintext'))
    expect(Buffer.from(out).toString('hex').toUpperCase()).toBe('BBF316E8D940AF0AD3')
  })
})

describe('encrypted exports encrypt every string (finding 1)', () => {
  for (const version14 of [false, true]) {
    it(`strings in uncompressed objects decrypt correctly${version14 ? ' (PDF 1.4 file)' : ''}`, async () => {
      const bytes = await makeDirectStringsPdf(version14)
      const plain = await inspectWithPdfjs(bytes)
      expect(plain.labels).toEqual(['Cover-1'])
      const out = await exportDocument(updateSettings(await openDocument(bytes, 's.pdf'), { encryption: { userPassword: 'pw' } }))
      const viaPdfjs = await inspectWithPdfjs(out, 'pw')
      expect(viaPdfjs.labels).toEqual(['Cover-1'])
      expect(viaPdfjs.urls).toEqual(['https://example.com/a'])
      expect(viaPdfjs.title).toBe('Direct strings')
      expect(viaPdfjs.lang).toBe('lt-LT')
      const viaPdfLib = await PDFDocument.load(out, { password: 'pw', updateMetadata: false })
      expect((viaPdfLib.catalog.lookup(PDFName.of('Lang')) as PDFString).decodeText()).toBe('lt-LT')
      expect(viaPdfLib.getTitle()).toBe('Direct strings')
      const reopened = await loadSource(out, 'o.pdf', { password: 'pw' })
      expect(reopened.metadata.title).toBe('Direct strings')
    })
  }

  it('Unicode passwords work with pdf.js and the engine', async () => {
    for (const pw of ['žąsis', 'pässwörd', 'пароль']) {
      const out = await exportDocument(updateSettings(await openDocument(await makeTextPdf(1), 't.pdf'), { encryption: { userPassword: pw } }))
      expect((await allPagesText(out, pw))[0]).toContain('Page 1')
      expect((await loadSource(out, 'o.pdf', { password: pw })).pageCount).toBe(1)
    }
  })
})

describe('passwords and permissions of opened encrypted files (finding 4)', () => {
  const restricted = { printing: 'lowResolution' as const, copying: false, modifying: false }

  for (const algorithm of ['RC4-40', 'RC4-128', 'AES-128', 'AES-256'] as const) {
    it(`${algorithm}: identifies the password kind and keeps both passwords working`, async () => {
      // Revision 2 (RC4-40) has a single "print" bit: low resolution reads back as allowed.
      const printing = algorithm === 'RC4-40' ? 'highResolution' : 'lowResolution'
      const bytes = await makeEncryptedWithPdf(algorithm, 'user-pw', 'owner-pw', restricted)
      const asUser = await loadSource(bytes, 'e.pdf', { password: 'user-pw' })
      expect(asUser.passwordKind).toBe('user')
      expect(asUser.userPassword).toBe('user-pw')
      expect(asUser.permissions).toMatchObject({ printing, copying: false, modifying: false })
      const asOwner = await loadSource(bytes, 'e.pdf', { password: 'owner-pw' })
      expect(asOwner.passwordKind).toBe('owner')
      if (algorithm === 'AES-256') expect(asOwner.userPassword).toBeUndefined()
      else expect(asOwner.userPassword).toBe('user-pw')

      for (const password of ['user-pw', 'owner-pw']) {
        const doc = await openDocument(bytes, 'e.pdf', { password })
        expect(doc.settings.encryption?.permissions).toMatchObject({ printing, copying: false })
        const out = await exportDocument(doc)
        expect(await canOpen(out, 'user-pw'), `${password}: user`).toBe(true)
        expect(await canOpen(out, 'owner-pw'), `${password}: owner`).toBe(true)
        expect(await canOpen(out, 'wrong'), `${password}: wrong`).toBe(false)
        expect((await allPagesText(out, 'user-pw'))[0]).toBe('Secret text')
        const re = await loadSource(out, 'o.pdf', { password: 'user-pw' })
        expect(re.permissions).toMatchObject({ printing, copying: false, modifying: false })
        expect(re.passwordKind).toBe('user')
      }
    })
  }

  it('pre-fills the recovered user password and the owner password (RC4 / AES-128)', async () => {
    const bytes = await makeEncryptedWithPdf('AES-128', 'user-pw', 'owner-pw', restricted)
    const doc = await openDocument(bytes, 'e.pdf', { password: 'owner-pw' })
    expect(doc.settings.encryption).toMatchObject({ userPassword: 'user-pw', ownerPassword: 'owner-pw' })
  })

  it('AES-256 opened with the owner password: user password unknown, original kept on save', async () => {
    const bytes = await makeEncryptedWithPdf('AES-256', 'user-pw', 'owner-pw', restricted)
    const doc = await openDocument(bytes, 'e.pdf', { password: 'owner-pw' })
    const src = doc.sources[doc.primarySourceId!]
    expect(src.passwordKind).toBe('owner')
    expect(src.userPassword).toBeUndefined()
    expect(doc.settings.encryption).toMatchObject({ userPassword: '', ownerPassword: 'owner-pw' })
  })

  it('new passwords replace the original encryption; permissions are honoured', async () => {
    const bytes = await makeEncryptedWithPdf('AES-256', 'user-pw', 'owner-pw', restricted)
    let doc = await openDocument(bytes, 'e.pdf', { password: 'user-pw' })
    doc = updateSettings(doc, { encryption: { userPassword: 'new-pw', permissions: { ...doc.settings.encryption!.permissions! } } })
    const out = await exportDocument(doc)
    expect(await canOpen(out, 'new-pw')).toBe(true)
    expect(await canOpen(out, 'user-pw')).toBe(false)
    const re = await loadSource(out, 'o.pdf', { password: 'new-pw' })
    expect(re.permissions).toMatchObject({ printing: 'lowResolution', copying: false })
    // A random owner password keeps the restrictions: the user password is not the owner password.
    expect(re.passwordKind).toBe('user')
    const raw = await PDFDocument.load(out, { ignoreEncryption: true, updateMetadata: false })
    const p = (raw.context.lookup(raw.context.trailerInfo.Encrypt, PDFDict).lookup(PDFName.of('P')) as PDFNumber).asNumber()
    expect(p & 16).toBe(0) // no copying
  })

  it('distinct owner password when the user sets only a user password with restrictions', async () => {
    let doc = await openDocument(await makeTextPdf(1), 't.pdf')
    doc = updateSettings(doc, {
      encryption: {
        userPassword: 'u',
        permissions: {
          printing: 'none',
          modifying: false,
          copying: false,
          annotating: false,
          fillingForms: true,
          contentAccessibility: true,
          documentAssembly: false
        }
      }
    })
    const re = await loadSource(await exportDocument(doc), 'o.pdf', { password: 'u' })
    expect(re.passwordKind).toBe('user')
    expect(re.permissions).toMatchObject({ printing: 'none', copying: false, fillingForms: true })
  })
})

describe('PDF/A files can be encrypted (finding 8)', () => {
  it('strips the PDF/A claim before encrypting and reports it', async () => {
    const warnings: ExportWarning[] = []
    const doc = updateSettings(await openDocument(await makePdfAClaimPdf(2), 'a.pdf'), { encryption: { userPassword: 'pw' } })
    const out = await exportDocument(doc, { onWarning: (w) => warnings.push(w) })
    expect(warnings.map((w) => w.code)).toEqual(['pdfa-claim-removed'])
    const re = await PDFDocument.load(out, { password: 'pw', updateMetadata: false })
    const xmp = new TextDecoder().decode(decodePDFRawStream(re.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).decode())
    expect(xmp).not.toContain('pdfaid:part')
    expect(xmp).toContain('Statement')
  })

  it('an encrypted PDF/A file opened with its password can be saved', async () => {
    const doc = await openDocument(await makePdfAClaimPdf(3, '1990-01-01'), 's.pdf', { password: '1990-01-01' })
    const out = await exportDocument(doc)
    expect(await canOpen(out, '1990-01-01')).toBe(true)
    expect(await canOpen(out, 'bank')).toBe(true)
    expect((await allPagesText(out, '1990-01-01'))[0]).toBe('Statement')
  })

  it('keeps the claim when not encrypting', async () => {
    const warnings: ExportWarning[] = []
    const out = await exportDocument(await openDocument(await makePdfAClaimPdf(2), 'a.pdf'), { onWarning: (w) => warnings.push(w) })
    expect(warnings).toEqual([])
    const re = await PDFDocument.load(out, { updateMetadata: false })
    const xmp = new TextDecoder().decode(decodePDFRawStream(re.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).decode())
    expect(xmp).toContain('<pdfaid:part>2</pdfaid:part>')
  })
})

describe('/EncryptMetadata false (finding 11)', () => {
  it('keeps the plain-text XMP readable after export', async () => {
    const bytes = await makeEncryptMetadataFalsePdf()
    const before = await openWithPdfjs(bytes)
    expect((await before.getMetadata()).metadata?.get('dc:title')).toBe('XMP Title')
    await closePdfjs(before)
    const out = await exportDocument(await openDocument(bytes, 'm.pdf'))
    const after = await openWithPdfjs(out)
    expect((await after.getMetadata()).metadata?.get('dc:title')).toBe('XMP Title')
    await closePdfjs(after)
    const re = await PDFDocument.load(out, { updateMetadata: false })
    const s = re.context.lookup(re.catalog.get(PDFName.of('Metadata'))) as PDFRawStream
    expect(new TextDecoder().decode(decodePDFRawStream(s).decode())).toContain('<?xpacket')
  })
})
