/**
 * Reading PKCS#12 (.p12 / .pfx) files into a signing identity: certificate chain plus a
 * non-extractable WebCrypto private key (RSA or ECDSA).
 *
 * The structure is walked here (so certificates keep their exact DER bytes); node-forge does
 * the password-based decryption (PBES2 with AES/3DES, legacy PKCS#12 3DES/RC2) and the MAC.
 * Not exported from the core index: it pulls in node-forge, which only the signing side needs.
 */
import forge from 'node-forge'
import {
  Tag,
  contentBytes,
  equalBytes,
  isContext,
  isUniversal,
  latin1,
  ownBytes,
  parseAsn1,
  rawBytes,
  readOid,
  readSmallInteger,
  type Asn1
} from './asn1'
import { createCmsSignature, maxSignatureSize, verifyCms, type CmsSigner } from './cms'
import { OID, curveFromOid, orderChain, parseCertificate, subtleCrypto, type Certificate, type CertificateSummary, type NamedCurve } from './x509'

const P12 = {
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  friendlyName: '1.2.840.113549.1.9.20',
  encryptedData: '1.2.840.113549.1.7.6',
  pbes2: '1.2.840.113549.1.5.13',
  pbmac1: '1.2.840.113549.1.5.14'
} as const

/** The password does not open the certificate file. */
export class CertificatePasswordError extends Error {
  override name = 'CertificatePasswordError'
  constructor() {
    super('Incorrect certificate password.')
  }
}

/** The file is not a usable PKCS#12 certificate (corrupt, unsupported, or without a key). */
export class CertificateFileError extends Error {
  override name = 'CertificateFileError'
}

export interface SigningIdentity extends CmsSigner {
  certificate: Uint8Array
  /** Issuer certificates (DER), nearest first. */
  chain: Uint8Array[]
  summary: CertificateSummary
  keyType: 'RSA' | 'EC'
  /** Largest signature value in bytes (for sizing). */
  maxSignatureSize: number
}

interface Bag {
  type: string
  value: Asn1
  localKeyId?: Uint8Array
}

const toForgeBuffer = (bytes: Uint8Array) => forge.util.createBuffer(latin1(bytes), 'raw')
const fromForge = (binary: string) => {
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Password as PBES2 expects it (UTF-8 bytes); legacy PKCS#12 PBE uses the string (BMPString). */
function passwordFor(oid: string, password: string | null): string | null {
  if (password === null) return null
  return oid === P12.pbes2 ? forge.util.encodeUtf8(password) : password
}

function decrypt(algorithm: Asn1, encrypted: Uint8Array, password: string | null): Uint8Array {
  const oid = readOid(algorithm.children[0])
  const params = algorithm.children[1] ? forge.asn1.fromDer(toForgeBuffer(rawBytes(algorithm.children[1]))) : undefined
  const pbe = (forge.pki as unknown as { pbe: { getCipher(oid: string, params: unknown, password: string | null): forge.cipher.BlockCipher } }).pbe
  let cipher: forge.cipher.BlockCipher
  try {
    cipher = pbe.getCipher(oid, params, passwordFor(oid, password))
  } catch (e) {
    throw new CertificateFileError(`The certificate file uses an unsupported encryption (${(e as Error).message}).`)
  }
  cipher.update(toForgeBuffer(encrypted))
  if (!cipher.finish()) throw new CertificatePasswordError()
  return fromForge(cipher.output.getBytes())
}

const MAC_DIGESTS: Record<string, { create(): forge.md.MessageDigest; size: number }> = {
  [OID.sha1]: { create: () => forge.md.sha1.create(), size: 20 },
  [OID.sha256]: { create: () => forge.md.sha256.create(), size: 32 },
  [OID.sha384]: { create: () => forge.md.sha384.create(), size: 48 },
  [OID.sha512]: { create: () => forge.md.sha512.create(), size: 64 }
}

function macMatches(macData: Asn1, authSafe: Uint8Array, password: string | null): boolean {
  const digestInfo = macData.children[0]
  const algOid = readOid(digestInfo.children[0].children[0])
  if (algOid === P12.pbmac1) throw new CertificateFileError('The certificate file uses PBMAC1, which is not supported yet.')
  const md = MAC_DIGESTS[algOid]
  if (!md) throw new CertificateFileError(`The certificate file uses an unsupported integrity algorithm (${algOid}).`)
  const expected = contentBytes(digestInfo.children[1])
  const salt = contentBytes(macData.children[1])
  const iterations = macData.children[2] ? readSmallInteger(macData.children[2]) : 1
  if (iterations < 1 || iterations > 10_000_000) throw new CertificateFileError('The certificate file is damaged.')
  const key = forge.pkcs12.generateKey(password, toForgeBuffer(salt), 3, iterations, md.size, md.create())
  const hmac = forge.hmac.create()
  hmac.start(md.create(), key.getBytes())
  hmac.update(latin1(authSafe))
  return equalBytes(fromForge(hmac.digest().getBytes()), expected)
}

/** ContentInfo with content type data: the OCTET STRING content (possibly chunked). */
function dataContent(contentInfo: Asn1): Uint8Array {
  const explicit = contentInfo.children[1]
  if (!isContext(explicit, 0)) throw new CertificateFileError('The certificate file is damaged.')
  return contentBytes(explicit.children[0])
}

function readBags(safeContents: Uint8Array, password: string | null, out: Bag[]): void {
  const seq = parseAsn1(safeContents)
  for (const bag of seq.children) {
    const type = readOid(bag.children[0])
    const value = bag.children[1]?.children[0]
    if (!value) continue
    let localKeyId: Uint8Array | undefined
    for (const attr of bag.children[2]?.children ?? []) {
      if (readOid(attr.children[0]) === P12.localKeyId) localKeyId = contentBytes(attr.children[1].children[0])
    }
    if (type === P12.shroudedKeyBag) {
      // EncryptedPrivateKeyInfo { encryptionAlgorithm, encryptedData OCTET STRING }
      const keyInfo = decrypt(value.children[0], contentBytes(value.children[1]), password)
      out.push({ type: P12.keyBag, value: parseAsn1(keyInfo), localKeyId })
    } else if (type === P12.keyBag || type === P12.certBag) {
      out.push({ type, value, localKeyId })
    }
  }
}

function parsePkcs12(bytes: Uint8Array, password: string | null): Bag[] {
  let pfx: Asn1
  try {
    pfx = parseAsn1(bytes)
    if (!isUniversal(pfx, Tag.Sequence) || readSmallInteger(pfx.children[0]) !== 3) throw new Error('not PKCS#12')
  } catch {
    throw new CertificateFileError('The file is not a PKCS#12 certificate (.p12 or .pfx).')
  }
  const authSafeInfo = pfx.children[1]
  if (readOid(authSafeInfo.children[0]) !== OID.data) {
    throw new CertificateFileError('Certificate files protected with a public key are not supported.')
  }
  const authSafe = dataContent(authSafeInfo)
  const macData = pfx.children[2]
  if (macData && !macMatches(macData, authSafe, password)) throw new CertificatePasswordError()

  const bags: Bag[] = []
  for (const contentInfo of parseAsn1(authSafe).children) {
    const type = readOid(contentInfo.children[0])
    if (type === OID.data) readBags(dataContent(contentInfo), password, bags)
    else if (type === P12.encryptedData) {
      // EncryptedData { version, EncryptedContentInfo { contentType, algorithm, [0] IMPLICIT content } }
      const eci = contentInfo.children[1].children[0].children[1]
      const encrypted = eci.children[2]
      if (!encrypted) continue
      readBags(decrypt(eci.children[1], contentBytes(encrypted), password), password, bags)
    }
  }
  return bags
}

interface KeyCandidate {
  pkcs8: Uint8Array
  keyType: 'RSA' | 'EC'
  curve?: NamedCurve
  localKeyId?: Uint8Array
}

function readKey(bag: Bag): KeyCandidate | null {
  // PrivateKeyInfo { version, privateKeyAlgorithm AlgorithmIdentifier, privateKey OCTET STRING, … }
  const alg = bag.value.children[1]
  const oid = readOid(alg.children[0])
  if (oid === OID.rsaEncryption) return { pkcs8: rawBytes(bag.value).slice(), keyType: 'RSA', localKeyId: bag.localKeyId }
  if (oid === OID.ecPublicKey) {
    const params = alg.children[1]
    const curve = isUniversal(params, Tag.Oid) ? curveFromOid(readOid(params)) : undefined
    return { pkcs8: rawBytes(bag.value).slice(), keyType: 'EC', curve, localKeyId: bag.localKeyId }
  }
  return null
}

async function importKey(key: KeyCandidate, cert: Certificate): Promise<CryptoKey> {
  const subtle = subtleCrypto()
  if (key.keyType === 'RSA') {
    return subtle.importKey('pkcs8', ownBytes(key.pkcs8), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  }
  const namedCurve = key.curve ?? cert.curve
  if (!namedCurve) throw new CertificateFileError('The certificate uses an unsupported elliptic curve.')
  return subtle.importKey('pkcs8', ownBytes(key.pkcs8), { name: 'ECDSA', namedCurve }, false, ['sign'])
}

function rawToDerSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  const int = (bytes: Uint8Array) => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    const v = bytes.subarray(i)
    const pad = v[0] & 0x80 ? 1 : 0
    return [0x02, v.length + pad, ...(pad ? [0] : []), ...v]
  }
  const body = [...int(raw.subarray(0, half)), ...int(raw.subarray(half))]
  const len = body.length < 0x80 ? [body.length] : [0x81, body.length]
  return new Uint8Array([0x30, ...len, ...body])
}

async function signWith(key: CryptoKey, keyType: 'RSA' | 'EC', data: Uint8Array): Promise<Uint8Array> {
  const subtle = subtleCrypto()
  if (keyType === 'RSA') return new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', key, ownBytes(data)))
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, ownBytes(data)))
  return rawToDerSignature(raw)
}

/** Whether `key` belongs to `cert` (signs a challenge and verifies it with the certificate). */
async function keyMatches(key: CryptoKey, keyType: 'RSA' | 'EC', cert: Certificate): Promise<boolean> {
  if ((keyType === 'RSA') !== (cert.keyType === 'RSA')) return false
  try {
    const challenge = new Uint8Array(32)
    globalThis.crypto.getRandomValues(challenge)
    const der = await createCmsSignature(challenge, { certificate: cert.der, sign: (d) => signWith(key, keyType, d) }, { cades: true })
    const result = await verifyCms(der, async () => challenge)
    return result.signatureValid === true
  } catch {
    return false
  }
}

/**
 * Opens a PKCS#12 file. Throws CertificatePasswordError for a wrong password and
 * CertificateFileError when the file cannot be used for signing.
 */
export async function loadPkcs12(bytes: Uint8Array, password: string): Promise<SigningIdentity> {
  let bags: Bag[]
  try {
    bags = parsePkcs12(bytes, password)
  } catch (e) {
    // Files exported "without a password" may use an absent password instead of an empty one.
    if (!(e instanceof CertificatePasswordError) || password !== '') throw rethrow(e)
    try {
      bags = parsePkcs12(bytes, null)
    } catch (e2) {
      throw rethrow(e2)
    }
  }
  const certs: { cert: Certificate; localKeyId?: Uint8Array }[] = []
  for (const bag of bags) {
    if (bag.type !== P12.certBag) continue
    // CertBag { certId, [0] EXPLICIT certValue OCTET STRING }
    if (readOid(bag.value.children[0]) !== P12.x509Certificate) continue
    try {
      certs.push({ cert: parseCertificate(contentBytes(bag.value.children[1].children[0]).slice()), localKeyId: bag.localKeyId })
    } catch {
      /* skip unreadable certificates */
    }
  }
  const keys = bags.filter((b) => b.type === P12.keyBag).map(readKey)
  if (!bags.some((b) => b.type === P12.keyBag)) throw new CertificateFileError('The certificate file contains no private key.')
  const usable = keys.filter((k): k is KeyCandidate => !!k)
  if (!usable.length) throw new CertificateFileError('The certificate’s key type is not supported. Use an RSA or ECDSA certificate.')
  if (!certs.length) throw new CertificateFileError('The certificate file contains no certificate.')

  for (const key of usable) {
    // Pair by localKeyId first, then by trying the key against each certificate.
    const byId = key.localKeyId ? certs.filter((c) => c.localKeyId && equalBytes(c.localKeyId, key.localKeyId!)) : []
    const candidates = [...byId, ...certs.filter((c) => !byId.includes(c))]
    for (const { cert } of candidates) {
      let cryptoKey: CryptoKey
      try {
        cryptoKey = await importKey(key, cert)
      } catch (e) {
        if (e instanceof CertificateFileError) throw e
        continue
      }
      if (!(await keyMatches(cryptoKey, key.keyType, cert))) continue
      const chain = orderChain(
        cert,
        certs.map((c) => c.cert)
      ).slice(1)
      const keyType = key.keyType
      return {
        certificate: cert.der,
        chain: chain.map((c) => c.der),
        summary: cert.summary,
        keyType,
        maxSignatureSize: maxSignatureSize(cert),
        sign: (data) => signWith(cryptoKey, keyType, data)
      }
    }
  }
  throw new CertificateFileError('The private key in the certificate file does not match any of its certificates.')
}

function rethrow(e: unknown): Error {
  if (e instanceof CertificatePasswordError || e instanceof CertificateFileError) return e
  return new CertificateFileError(`The certificate file could not be read (${(e as Error)?.message ?? e}).`)
}
