import { describe, expect, it } from 'vitest'
import { CertificateFileError, CertificatePasswordError, loadPkcs12 } from '../../../src/core/signatures/pkcs12'
import { assertSignedAttributes, parseCertificate } from '../../../src/core'
import { createCertificate, createForgePkcs12, createPkcs12, testKey } from './certs'

describe('PKCS#12 certificates', () => {
  it('opens an RSA certificate (PBES2 AES-256, SHA-256 MAC) and signs with it', async () => {
    const cert = createCertificate({ CN: 'Jane Signer', O: 'Example Org', E: 'jane@example.com', key: testKey('rsa') })
    const p12 = createPkcs12({ key: cert.key, certs: [cert.der], password: 'secret' })
    const identity = await loadPkcs12(p12, 'secret')
    expect(identity.keyType).toBe('RSA')
    expect(identity.certificate).toEqual(cert.der)
    expect(identity.summary).toMatchObject({
      subjectName: 'Jane Signer',
      organization: 'Example Org',
      email: 'jane@example.com',
      selfSigned: true,
      keyDescription: 'RSA 2048'
    })
    expect(identity.maxSignatureSize).toBe(256)
    const sig = await identity.sign(new Uint8Array([1, 2, 3]))
    expect(sig.length).toBe(256)
  })

  it('rejects a wrong password', async () => {
    const cert = createCertificate({ CN: 'Jane', key: testKey('rsa') })
    const p12 = createPkcs12({ key: cert.key, certs: [cert.der], password: 'right' })
    await expect(loadPkcs12(p12, 'wrong')).rejects.toBeInstanceOf(CertificatePasswordError)
  })

  it('opens ECDSA P-256 and P-384 certificates', async () => {
    for (const curve of ['prime256v1', 'secp384r1']) {
      const cert = createCertificate({ CN: `EC ${curve}`, key: testKey('ec', curve) })
      const identity = await loadPkcs12(createPkcs12({ key: cert.key, certs: [cert.der], password: 'pw', algorithm: '3des', mac: 'sha1' }), 'pw')
      expect(identity.keyType).toBe('EC')
      expect(identity.summary.keyDescription).toBe(curve === 'prime256v1' ? 'ECDSA P-256' : 'ECDSA P-384')
      const sig = await identity.sign(new Uint8Array([4, 5, 6]))
      expect(sig[0]).toBe(0x30) // DER Ecdsa-Sig-Value
    }
  })

  it('opens files written by node-forge (legacy PKCS#12 3DES encryption)', async () => {
    const cert = createCertificate({ CN: 'Forge Legacy', key: testKey('rsa') })
    const identity = await loadPkcs12(createForgePkcs12(cert, 'pässwörd'), 'pässwörd')
    expect(identity.summary.subjectName).toBe('Forge Legacy')
    await expect(loadPkcs12(createForgePkcs12(cert, 'pässwörd'), 'passwort')).rejects.toBeInstanceOf(CertificatePasswordError)
  })

  it('handles non-ASCII passwords with PBES2 and pairs the key without localKeyId', async () => {
    const ca = createCertificate({ CN: 'Test CA', key: testKey('rsa', 2048, 1), ca: true })
    const leaf = createCertificate({ CN: 'Leaf Person', key: testKey('ec'), issuer: ca })
    const p12 = createPkcs12({ key: leaf.key, certs: [ca.der, leaf.der], password: 'žalias–🔑', localKeyId: false, encryptCertificates: false })
    const identity = await loadPkcs12(p12, 'žalias–🔑')
    expect(identity.certificate).toEqual(leaf.der)
    expect(identity.chain).toEqual([ca.der])
    expect(identity.summary).toMatchObject({ subjectName: 'Leaf Person', issuerName: 'Test CA', selfSigned: false })
  })

  it('reports files that are not certificates', async () => {
    await expect(loadPkcs12(new TextEncoder().encode('not a certificate'), 'x')).rejects.toBeInstanceOf(CertificateFileError)
  })

  it('parses certificate details', () => {
    const cert = createCertificate({ CN: 'Ona Žemaitė', O: 'Įmonė', C: 'LT', key: testKey('ec') })
    const parsed = parseCertificate(cert.der)
    expect(parsed.summary.subject).toBe('CN=Ona Žemaitė, O=Įmonė, C=LT')
    expect(parsed.keyType).toBe('EC')
    expect(parsed.curve).toBe('P-256')
  })

  it('only signs CMS signed attributes', () => {
    expect(() => assertSignedAttributes(new Uint8Array([1, 2, 3]))).toThrow(/Refusing/)
    expect(() => assertSignedAttributes(new Uint8Array([0x31, 0x00]))).toThrow(/Refusing/)
  })
})
