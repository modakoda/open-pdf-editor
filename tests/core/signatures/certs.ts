/**
 * Test certificates: self-signed / CA-issued X.509 certificates for RSA and EC keys (Node crypto)
 * and PKCS#12 files containing them (node-forge for the password-based encryption and MAC).
 */
import { generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from 'node:crypto'
import forge from 'node-forge'
import {
  derContext,
  derElement,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSetOf,
  derSmallInteger,
  derTime,
  derUnsignedInteger,
  derUtf8String,
  latin1
} from '../../../src/core/signatures/asn1'

export interface TestKey {
  type: 'rsa' | 'ec'
  privateKey: KeyObject
  publicKey: KeyObject
}

export interface TestCert {
  der: Uint8Array
  key: TestKey
  subject: string
}

const keyCache = new Map<string, TestKey>()

/** Key pairs are cached per kind (RSA generation is slow). */
export function testKey(type: 'rsa' | 'ec', variant: string | number = type === 'rsa' ? 2048 : 'prime256v1', slot = 0): TestKey {
  const id = `${type}:${variant}:${slot}`
  let key = keyCache.get(id)
  if (!key) {
    const pair =
      type === 'rsa'
        ? generateKeyPairSync('rsa', { modulusLength: Number(variant) })
        : generateKeyPairSync('ec', { namedCurve: String(variant) })
    key = { type, ...pair }
    keyCache.set(id, key)
  }
  return key
}

function name(parts: { CN: string; O?: string; C?: string; E?: string }): Uint8Array {
  const rdn = (oid: string, value: Uint8Array) => derSetOf([derSequence(derOid(oid), value)])
  const rdns: Uint8Array[] = []
  if (parts.C) rdns.push(rdn('2.5.4.6', derElement(0x13, new TextEncoder().encode(parts.C))))
  if (parts.O) rdns.push(rdn('2.5.4.10', derUtf8String(parts.O)))
  rdns.push(rdn('2.5.4.3', derUtf8String(parts.CN)))
  if (parts.E) rdns.push(rdn('1.2.840.113549.1.9.1', derElement(0x16, new TextEncoder().encode(parts.E))))
  return derSequence(...rdns)
}

function signatureAlgorithm(key: TestKey): Uint8Array {
  return key.type === 'rsa' ? derSequence(derOid('1.2.840.113549.1.1.11'), derNull()) : derSequence(derOid('1.2.840.10045.4.3.2'))
}

export interface CertOptions {
  CN: string
  O?: string
  C?: string
  E?: string
  key: TestKey
  /** Issuer (default: self-signed). */
  issuer?: TestCert
  ca?: boolean
  notBefore?: Date
  notAfter?: Date
}

export function createCertificate(options: CertOptions): TestCert {
  const subject = name(options)
  const issuerKey = options.issuer?.key ?? options.key
  const issuerName = options.issuer ? issuerNameOf(options.issuer) : subject
  const spki = new Uint8Array(options.key.publicKey.export({ type: 'spki', format: 'der' }))
  const extensions: Uint8Array[] = [
    derSequence(derOid('2.5.29.19'), ...(options.ca ? [derElement(0x01, new Uint8Array([0xff]))] : []), derOctetString(derSequence(...(options.ca ? [derElement(0x01, new Uint8Array([0xff]))] : [])))),
    derSequence(derOid('2.5.29.14'), derOctetString(derOctetString(randomBytes(20))))
  ]
  const tbs = derSequence(
    derContext(0, derSmallInteger(2)),
    derUnsignedInteger(new Uint8Array(randomBytes(12))),
    signatureAlgorithm(issuerKey),
    issuerName,
    derSequence(derTime(options.notBefore ?? new Date(Date.now() - 86_400_000)), derTime(options.notAfter ?? new Date(Date.now() + 365 * 86_400_000))),
    subject,
    spki,
    derContext(3, derSequence(...extensions))
  )
  const signature = nodeSign('sha256', tbs, issuerKey.privateKey)
  const der = derSequence(tbs, signatureAlgorithm(issuerKey), derElement(0x03, new Uint8Array([0]), new Uint8Array(signature)))
  return { der, key: options.key, subject: options.CN }
}

function issuerNameOf(cert: TestCert): Uint8Array {
  // Subject Name of the issuer certificate (6th TBS field incl. version).
  const asn = forge.asn1.fromDer(forge.util.createBuffer(latin1(cert.der), 'raw'))
  const tbs = (asn.value as forge.asn1.Asn1[])[0]
  const subject = (tbs.value as forge.asn1.Asn1[])[5]
  return bytesOf(forge.asn1.toDer(subject).getBytes())
}

export function bytesOf(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const fromDer = (bytes: Uint8Array) => forge.asn1.fromDer(forge.util.createBuffer(latin1(bytes), 'raw'))
const toDer = (asn: forge.asn1.Asn1) => bytesOf(forge.asn1.toDer(asn).getBytes())

export interface Pkcs12Options {
  key: TestKey
  /** Leaf first. */
  certs: Uint8Array[]
  password: string
  /** Key and certificate encryption: PBES2 AES-256 (OpenSSL 3 default) or PBES2 3DES. */
  algorithm?: 'aes256' | '3des'
  /** Store the certificates encrypted (default) or in plain data. */
  encryptCertificates?: boolean
  mac?: 'sha1' | 'sha256'
  /** Pair key and leaf with localKeyId attributes (default true). */
  localKeyId?: boolean
}

/** Encrypts `content` with PBES2 (via forge's EncryptedPrivateKeyInfo) → { algorithm, data }. */
function pbes2Encrypt(content: Uint8Array, password: string, algorithm: 'aes256' | '3des'): { alg: Uint8Array; data: Uint8Array } {
  const epki = forge.pki.encryptPrivateKeyInfo(fromDer(content), forge.util.encodeUtf8(password), {
    algorithm,
    count: 2048,
    prfAlgorithm: 'sha256'
  } as forge.pki.EncryptionOptions)
  const parts = epki.value as forge.asn1.Asn1[]
  return { alg: toDer(parts[0]), data: bytesOf(parts[1].value as string) }
}

export function createPkcs12(options: Pkcs12Options): Uint8Array {
  const algorithm = options.algorithm ?? 'aes256'
  const localKeyId = new Uint8Array(randomBytes(20))
  const withId = options.localKeyId !== false
  const idAttrs = derSetOf([derSequence(derOid('1.2.840.113549.1.9.21'), derSetOf([derOctetString(localKeyId)]))])

  const pkcs8 = new Uint8Array(options.key.privateKey.export({ type: 'pkcs8', format: 'der' }))
  const shrouded = pbes2Encrypt(pkcs8, options.password, algorithm)
  const keyBag = derSequence(
    derOid('1.2.840.113549.1.12.10.1.2'),
    derContext(0, derSequence(shrouded.alg, derOctetString(shrouded.data))),
    ...(withId ? [idAttrs] : [])
  )
  const certBags = options.certs.map((der, i) =>
    derSequence(
      derOid('1.2.840.113549.1.12.10.1.3'),
      derContext(0, derSequence(derOid('1.2.840.113549.1.9.22.1'), derContext(0, derOctetString(der)))),
      ...(withId && i === 0 ? [idAttrs] : [])
    )
  )
  const data = (bytes: Uint8Array) => derSequence(derOid('1.2.840.113549.1.7.1'), derContext(0, derOctetString(bytes)))
  const certContents = derSequence(...certBags)
  let certInfo: Uint8Array
  if (options.encryptCertificates === false) certInfo = data(certContents)
  else {
    const enc = pbes2Encrypt(certContents, options.password, algorithm)
    certInfo = derSequence(
      derOid('1.2.840.113549.1.7.6'),
      derContext(0, derSequence(derSmallInteger(0), derSequence(derOid('1.2.840.113549.1.7.1'), enc.alg, derElement(0x80, enc.data))))
    )
  }
  const authSafe = derSequence(certInfo, data(derSequence(keyBag)))

  const mac = options.mac ?? 'sha256'
  const md = () => (mac === 'sha1' ? forge.md.sha1.create() : forge.md.sha256.create())
  const salt = new Uint8Array(randomBytes(16))
  const iterations = 2048
  const macKey = forge.pkcs12.generateKey(options.password, forge.util.createBuffer(latin1(salt), 'raw'), 3, iterations, mac === 'sha1' ? 20 : 32, md())
  const hmac = forge.hmac.create()
  hmac.start(md(), macKey.getBytes())
  hmac.update(latin1(authSafe))
  const macValue = bytesOf(hmac.digest().getBytes())
  const macOid = mac === 'sha1' ? '1.3.14.3.2.26' : '2.16.840.1.101.3.4.2.1'
  return derSequence(
    derSmallInteger(3),
    data(authSafe),
    derSequence(derSequence(derSequence(derOid(macOid), derNull()), derOctetString(macValue)), derOctetString(salt), derSmallInteger(iterations))
  )
}

/** A PKCS#12 written by node-forge itself (RSA only), with legacy 3DES PKCS#12 encryption. */
export function createForgePkcs12(cert: TestCert, password: string, algorithm: '3des' | 'aes256' = '3des'): Uint8Array {
  const forgeCert = forge.pki.certificateFromAsn1(fromDer(cert.der))
  const pem = cert.key.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const forgeKey = forge.pki.privateKeyFromPem(pem)
  const asn = forge.pkcs12.toPkcs12Asn1(forgeKey, [forgeCert], password, { algorithm })
  return toDer(asn)
}
