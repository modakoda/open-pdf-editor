import { X509Certificate, createHash, verify as nodeVerify } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import forge from 'node-forge'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from '@cantoo/pdf-lib'
import {
  SigningError,
  createBlankDocument,
  emptySignatureFields,
  exportDocument,
  openDocument,
  signPdf,
  verifyPdfSignatures,
  type EditorDocument,
  type FieldObject
} from '../../../src/core'
import { latin1 } from '../../../src/core/signatures/asn1'
import { loadPkcs12, type SigningIdentity } from '../../../src/core/signatures/pkcs12'
import { closePdfjs, openWithPdfjs, registerTestFonts } from '../helpers'
import { bytesOf, createCertificate, createPkcs12, testKey } from './certs'

let rsa: SigningIdentity
let ec: SigningIdentity

beforeAll(async () => {
  registerTestFonts()
  const rsaCert = createCertificate({ CN: 'Jane Signer', O: 'Example', key: testKey('rsa') })
  rsa = await loadPkcs12(createPkcs12({ key: rsaCert.key, certs: [rsaCert.der], password: 'pw' }), 'pw')
  const ca = createCertificate({ CN: 'Example CA', key: testKey('rsa', 2048, 1), ca: true })
  const ecCert = createCertificate({ CN: 'Erik Elliptic', key: testKey('ec'), issuer: ca })
  ec = await loadPkcs12(createPkcs12({ key: ecCert.key, certs: [ecCert.der, ca.der], password: 'pw' }), 'pw')
})

async function basePdf(options: { objectStreams?: boolean; pages?: number; rotate?: number } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < (options.pages ?? 2); i++) {
    const page = doc.addPage([595, 842])
    page.drawText(`Contract page ${i + 1}`, { x: 72, y: 760, size: 18, font })
    if (options.rotate) page.setRotation({ type: 'degrees', angle: options.rotate } as never)
  }
  return doc.save({ useObjectStreams: options.objectStreams ?? true })
}

const BOX = { x: 72, y: 600, width: 220, height: 60 }
const T0 = new Date(Date.UTC(2026, 9, 30, 10, 0, 0))

/** Independent check (node-forge ASN.1 + Node crypto): digest of the byte ranges and CMS signature. */
function independentlyVerify(pdf: Uint8Array, nth = -1): { byteRange: number[]; digestOk: boolean; signatureOk: boolean; signedAttrOids: string[] } {
  const text = latin1(pdf)
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)]
  const m = all.at(nth)!
  const br = m.slice(1, 5).map(Number)
  const signed = Buffer.concat([pdf.subarray(br[0], br[0] + br[1]), pdf.subarray(br[2], br[2] + br[3])])
  const contentsHex = text.slice(br[1] + 1, br[2] - 1)
  // /Contents is zero-padded after the DER structure.
  const fromDer = forge.asn1.fromDer as unknown as (bytes: forge.util.ByteStringBuffer, options: { parseAllBytes: boolean }) => forge.asn1.Asn1
  const cms = fromDer(forge.util.createBuffer(forge.util.hexToBytes(contentsHex), 'raw'), { parseAllBytes: false })
  const signedData = (cms.value as forge.asn1.Asn1[])[1].value[0] as forge.asn1.Asn1
  const sd = signedData.value as forge.asn1.Asn1[]
  const certs = (sd[3].value as forge.asn1.Asn1[]).map((c) => bytesOf(forge.asn1.toDer(c).getBytes()))
  const signerInfo = (sd[sd.length - 1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[]
  const signedAttrs = signerInfo[3]
  const attrs = signedAttrs.value as forge.asn1.Asn1[]
  const oidOf = (a: forge.asn1.Asn1) => forge.asn1.derToOid((a.value as forge.asn1.Asn1[])[0].value as string)
  const md = attrs.find((a) => oidOf(a) === '1.2.840.113549.1.9.4')!
  const mdValue = ((md.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string
  const digestOk = createHash('sha256').update(signed).digest('latin1') === mdValue
  // Signature over the DER SET OF the signed attributes.
  const setDer = bytesOf(forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs)).getBytes())
  const signature = Buffer.from(bytesOf(signerInfo[5].value as string))
  const cert = new X509Certificate(Buffer.from(certs[0]))
  const signatureOk = nodeVerify('sha256', setDer, cert.publicKey, signature)
  return { byteRange: br, digestOk, signatureOk, signedAttrOids: attrs.map(oidOf) }
}

describe('signPdf', () => {
  it('appends a PAdES signature without changing the original bytes', async () => {
    const original = await basePdf()
    const signed = await signPdf(original, {
      signer: rsa,
      target: { pageIndex: 0, box: BOX },
      reason: 'I approve this contract',
      location: 'Vilnius',
      contactInfo: 'jane@example.com',
      signingTime: T0
    })
    expect(signed.subarray(0, original.length)).toEqual(original)
    const check = independentlyVerify(signed)
    expect(check.byteRange[0]).toBe(0)
    expect(check.byteRange[2] + check.byteRange[3]).toBe(signed.length)
    expect(check.digestOk).toBe(true)
    expect(check.signatureOk).toBe(true)
    // CAdES: content-type, message-digest, signing-certificate-v2 and no signing-time.
    expect(check.signedAttrOids).toEqual(expect.arrayContaining(['1.2.840.113549.1.9.3', '1.2.840.113549.1.9.4', '1.2.840.113549.1.9.16.2.47']))
    expect(check.signedAttrOids).not.toContain('1.2.840.113549.1.9.5')
    expect(latin1(signed)).toContain('/SubFilter /ETSI.CAdES.detached')

    const [sig] = await verifyPdfSignatures(signed)
    expect(sig).toMatchObject({
      status: 'valid',
      kind: 'signature',
      fieldName: 'Signature1',
      pageIndex: 0,
      signerName: 'Jane Signer',
      reason: 'I approve this contract',
      location: 'Vilnius',
      contactInfo: 'jane@example.com',
      coversWholeDocument: true,
      digestValid: true,
      signatureValid: true,
      signingTime: T0.toISOString(),
      signingTimeSource: 'pdf',
      signatureAlgorithm: 'RSA with SHA-256',
      digestAlgorithm: 'SHA-256',
      invisible: false
    })
    expect(sig.box!.x).toBeCloseTo(BOX.x)
    expect(sig.box!.y).toBeCloseTo(BOX.y)
    expect(sig.certificate!.subjectName).toBe('Jane Signer')
  })

  it('writes a valid file that pdf.js and pdf-lib read (xref stream and xref table bases)', async () => {
    for (const objectStreams of [true, false]) {
      const original = await basePdf({ objectStreams })
      const signed = await signPdf(original, { signer: ec, target: { pageIndex: 1, box: BOX }, signingTime: T0 })
      const tail = latin1(signed.subarray(original.length))
      if (objectStreams) expect(tail).toMatch(/\/Type \/XRef/)
      else expect(tail).toMatch(/\nxref\n/)
      const reloaded = await PDFDocument.load(signed)
      expect(reloaded.getPageCount()).toBe(2)
      const pdfjs = await openWithPdfjs(signed)
      try {
        const page = await pdfjs.getPage(2)
        const annots = await page.getAnnotations()
        expect(annots.some((a: { fieldType?: string; fieldName?: string }) => a.fieldType === 'Sig' && a.fieldName === 'Signature1')).toBe(true)
      } finally {
        await closePdfjs(pdfjs)
      }
      const [sig] = await verifyPdfSignatures(signed)
      expect(sig.status).toBe('valid')
      expect(sig.signatureAlgorithm).toBe('ECDSA P-256 with SHA-256')
      expect(sig.certificateCount).toBe(2)
      expect(sig.certificate?.issuerName).toBe('Example CA')
      expect(independentlyVerify(signed)).toMatchObject({ digestOk: true, signatureOk: true })
    }
  })

  it('detects tampering with the signed bytes and with the signature', async () => {
    const signed = await signPdf(await basePdf({ objectStreams: false }), { signer: rsa, target: { pageIndex: 0, box: BOX }, signingTime: T0 })
    const text = latin1(signed)
    // Change the page size (MediaBox 595 → 596) inside the signed range.
    const tampered = signed.slice()
    const at = text.indexOf('595')
    expect(at).toBeGreaterThan(0)
    tampered[at + 2] = '6'.charCodeAt(0)
    const [t1] = await verifyPdfSignatures(tampered)
    expect(t1.status).toBe('invalid')
    expect(t1.digestValid).toBe(false)

    // Flip a byte of the signature value (last non-zero hex digit pair of /Contents).
    const br = independentlyVerify(signed).byteRange
    const hex = text.slice(br[1] + 1, br[2] - 1).replace(/0+$/, '')
    const pos = br[1] + 1 + hex.length - 4
    const badSig = signed.slice()
    badSig[pos] = badSig[pos] === 0x41 ? 0x42 : 0x41
    const [t2] = await verifyPdfSignatures(badSig)
    expect(t2.status).toBe('invalid')
    expect(t2.signatureValid).toBe(false)
    expect(t2.problems.join(' ')).toMatch(/does not match/)
  })

  it('reports changes appended after signing and supports multiple signatures', async () => {
    const original = await basePdf()
    const once = await signPdf(original, { signer: rsa, target: { pageIndex: 0, box: BOX }, reason: 'Author', signingTime: T0 })
    const twice = await signPdf(once, {
      signer: ec,
      target: { pageIndex: 0, box: { ...BOX, y: 680 } },
      reason: 'Reviewer',
      signingTime: new Date(T0.getTime() + 60_000)
    })
    expect(twice.subarray(0, once.length)).toEqual(once)
    const sigs = await verifyPdfSignatures(twice)
    expect(sigs.map((s) => [s.fieldName, s.signerName, s.status])).toEqual([
      ['Signature1', 'Jane Signer', 'modified'],
      ['Signature2', 'Erik Elliptic', 'valid']
    ])
    expect(sigs[0]).toMatchObject({ coversWholeDocument: false, laterRevisions: 1, digestValid: true, signatureValid: true })
    expect(sigs[0].warnings.join(' ')).toMatch(/changed after this signature/)
    expect(independentlyVerify(twice, 0).digestOk).toBe(true)
    expect(independentlyVerify(twice, 1).digestOk).toBe(true)

    // A later incremental update that is not a signature (pdf-lib incremental save).
    const doc = await PDFDocument.load(twice, { forIncrementalUpdate: true })
    doc.setTitle('Changed later')
    const appended = await doc.commit({ useObjectStreams: false })
    expect(appended.subarray(0, twice.length)).toEqual(twice)
    const later = await verifyPdfSignatures(appended)
    expect(later.map((s) => s.status)).toEqual(['modified', 'modified'])
  })

  it('signs into an existing empty signature field created by the editor', async () => {
    let doc: EditorDocument = createBlankDocument()
    const field: FieldObject = {
      id: 'f1',
      type: 'field',
      fieldType: 'signature',
      name: 'Approver',
      pageId: doc.pages[0].id,
      x: 300,
      y: 700,
      width: 200,
      height: 50
    }
    doc = { ...doc, objects: [field] }
    const base = await exportDocument(doc)
    expect(await emptySignatureFields(base)).toEqual(['Approver'])
    const signed = await signPdf(base, { signer: rsa, target: { fieldName: 'Approver' }, signingTime: T0 })
    expect(await emptySignatureFields(signed)).toEqual([])
    const [sig] = await verifyPdfSignatures(signed)
    expect(sig).toMatchObject({ fieldName: 'Approver', status: 'valid', pageIndex: 0 })
    expect(sig.box!.x).toBeCloseTo(300)
    expect(sig.box!.y).toBeCloseTo(700)
    await expect(signPdf(signed, { signer: rsa, target: { fieldName: 'Approver' } })).rejects.toMatchObject({ code: 'already-signed' })
    await expect(signPdf(signed, { signer: rsa, target: { fieldName: 'Nope' } })).rejects.toBeInstanceOf(SigningError)
  })

  it('creates adbe.pkcs7.detached signatures with a signing-time attribute', async () => {
    const signed = await signPdf(await basePdf(), { signer: ec, target: { pageIndex: 0, box: BOX }, subFilter: 'adbe.pkcs7.detached', signingTime: T0 })
    expect(latin1(signed)).toContain('/SubFilter /adbe.pkcs7.detached')
    expect(independentlyVerify(signed).signedAttrOids).toContain('1.2.840.113549.1.9.5')
    const [sig] = await verifyPdfSignatures(signed)
    expect(sig).toMatchObject({ status: 'valid', subFilter: 'adbe.pkcs7.detached', signingTimeSource: 'signature', signingTime: T0.toISOString() })
  })

  it('verifies an adbe.pkcs7.detached signature made by another implementation (node-forge)', async () => {
    const cert = createCertificate({ CN: 'Forge Signer', key: testKey('rsa') })
    const identity = await loadPkcs12(createPkcs12({ key: cert.key, certs: [cert.der], password: 'pw' }), 'pw')
    // Lay out the file with our signer (big placeholder), then replace /Contents with forge's CMS.
    const signed = await signPdf(await basePdf(), {
      signer: identity,
      target: { pageIndex: 0, box: BOX },
      subFilter: 'adbe.pkcs7.detached',
      reserveBytes: 2048
    })
    const br = independentlyVerify(signed).byteRange
    const content = Buffer.concat([signed.subarray(0, br[1]), signed.subarray(br[2])])
    const forgeCert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(latin1(cert.der), 'raw')))
    const forgeKey = forge.pki.privateKeyFromPem(cert.key.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString())
    const p7 = forge.pkcs7.createSignedData()
    p7.content = forge.util.createBuffer(latin1(new Uint8Array(content)), 'raw')
    p7.addCertificate(forgeCert)
    p7.addSigner({
      key: forgeKey,
      certificate: forgeCert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: T0 as unknown as string }
      ]
    })
    p7.sign({ detached: true })
    const hex = forge.util.bytesToHex(forge.asn1.toDer(p7.toAsn1()).getBytes())
    const slot = br[2] - br[1] - 2
    expect(hex.length).toBeLessThanOrEqual(slot)
    const replaced = signed.slice()
    replaced.set(new TextEncoder().encode(hex.padEnd(slot, '0')), br[1] + 1)
    const [sig] = await verifyPdfSignatures(replaced)
    expect(sig).toMatchObject({ status: 'valid', signerName: 'Forge Signer', signingTimeSource: 'signature', signingTime: T0.toISOString() })
    // And forge's signature over different content is rejected.
    replaced[10] ^= 1
    expect((await verifyPdfSignatures(replaced))[0].status).toBe('invalid')
  })

  it('draws an upright appearance with text and an optional image', async () => {
    // 1×1 PNG
    const png = bytesOf(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))
    const signed = await signPdf(await basePdf({ rotate: 90 }), {
      signer: rsa,
      target: { pageIndex: 0, box: BOX },
      reason: 'Patvirtinu',
      appearance: { name: 'Ona Žemaitė', image: { data: png, mimeType: 'image/png' } },
      signingTime: T0
    })
    const doc = await PDFDocument.load(signed)
    const widget = doc.getPages()[0].node.Annots()!.lookup(0, PDFDict)
    const ap = widget.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream
    expect(ap.dict.lookup(PDFName.of('Matrix'))?.toString()).toBe('[ 0 1 -1 0 0 0 ]')
    expect(ap.dict.lookup(PDFName.of('BBox'))?.toString()).toBe('[ 0 0 60 220 ]')
    const content = new TextDecoder().decode(decodePDFRawStream(ap).decode())
    expect(content).toMatch(/\/Im1 Do/)
    expect(content).toMatch(/\/F1 [\d.]+ Tf/)
    // Three lines (name, date, reason); "ė" is not WinAnsi, so the bundled Noto Sans is embedded.
    expect(content.match(/Tj/g)).toHaveLength(3)
    const fontDict = (ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)).lookup(PDFName.of('F1'), PDFDict)
    expect(fontDict.lookup(PDFName.of('Subtype'))?.toString()).toBe('/Type0')
    expect((await verifyPdfSignatures(signed))[0].status).toBe('valid')
  })

  it('refuses password-protected documents', async () => {
    let doc = createBlankDocument()
    doc = { ...doc, settings: { ...doc.settings, encryption: { userPassword: 'open' } } }
    const encrypted = await exportDocument(doc)
    await expect(signPdf(encrypted, { signer: rsa, target: { pageIndex: 0, box: BOX } })).rejects.toMatchObject({ code: 'encrypted' })
  })

  it('removes signatures from exported (rewritten) copies, keeping the empty field', async () => {
    const signed = await signPdf(await basePdf(), { signer: rsa, target: { pageIndex: 0, box: BOX }, signingTime: T0 })
    const doc = await openDocument(signed, 'signed.pdf')
    const warnings: string[] = []
    const out = await exportDocument({ ...doc, pages: doc.pages.slice(0, 1) }, { onWarning: (w) => warnings.push(w.code) })
    expect(warnings).toContain('signatures-removed')
    expect(await verifyPdfSignatures(out)).toEqual([])
    expect(await emptySignatureFields(out)).toEqual(['Signature1'])
    // The emptied field can be signed again.
    const again = await signPdf(out, { signer: ec, target: { fieldName: 'Signature1' }, signingTime: T0 })
    expect((await verifyPdfSignatures(again))[0].status).toBe('valid')
  })

  it('verifies signatures when a signed file is opened', async () => {
    const signed = await signPdf(await basePdf(), { signer: rsa, target: { pageIndex: 1, box: BOX }, reason: 'OK', signingTime: T0 })
    const doc = await openDocument(signed, 'signed.pdf')
    const source = doc.sources[doc.primarySourceId!]
    expect(source.signatures).toHaveLength(1)
    expect(source.signatures![0]).toMatchObject({ status: 'valid', pageIndex: 1, reason: 'OK' })
    expect(source.formFields.find((f) => f.name === 'Signature1')?.type).toBe('signature')
    const unsigned = await openDocument(await basePdf(), 'plain.pdf')
    expect(unsigned.sources[unsigned.primarySourceId!].signatures).toBeUndefined()
  })
})
