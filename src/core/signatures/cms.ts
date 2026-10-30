/**
 * CMS SignedData (RFC 5652) for PDF signatures: creating detached CAdES / PKCS#7 signatures and
 * verifying them with WebCrypto.
 */
import {
  Asn1Error,
  Tag,
  contentBytes,
  derContext,
  derElement,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSetOf,
  derSmallInteger,
  derTime,
  equalBytes,
  isContext,
  isUniversal,
  ownBytes,
  parseAsn1,
  rawBytes,
  readOid,
  readSmallInteger,
  readTime,
  sortDer,
  type Asn1
} from './asn1'
import { OID, parseCertificate, subtleCrypto, type Certificate, type NamedCurve } from './x509'

export type DigestName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'

const DIGEST_OIDS: Record<string, DigestName> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512'
}

export function digestFromOid(oid: string): DigestName | undefined {
  return DIGEST_OIDS[oid]
}

export async function digest(name: DigestName, data: Uint8Array | Uint8Array[]): Promise<Uint8Array> {
  const parts = Array.isArray(data) ? data : [data]
  let joined: Uint8Array<ArrayBuffer>
  if (parts.length === 1) joined = ownBytes(parts[0])
  else {
    joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const p of parts) {
      joined.set(p, offset)
      offset += p.length
    }
  }
  return new Uint8Array(await subtleCrypto().digest(name, joined))
}

/** Something that can sign with the private key of `certificate` (SHA-256). */
export interface CmsSigner {
  /** DER of the signer's certificate. */
  certificate: Uint8Array
  /** Further certificates to embed (issuers), DER. */
  chain?: Uint8Array[]
  /**
   * Signs `data` (the DER-encoded signed attributes) with SHA-256. Returns the signature value
   * as CMS expects it: PKCS#1 v1.5 bytes for RSA, a DER Ecdsa-Sig-Value for ECDSA.
   */
  sign(data: Uint8Array): Promise<Uint8Array>
}

export interface CmsSignOptions {
  /**
   * CAdES (PAdES baseline, SubFilter ETSI.CAdES.detached): no signing-time attribute (the
   * claimed time is the signature dictionary's /M). PKCS#7 (adbe.pkcs7.detached): with it.
   */
  cades: boolean
  signingTime?: Date
}

const SHA256_ALG = derSequence(derOid(OID.sha256))

/** Largest signature value for the certificate's key (for sizing the /Contents placeholder). */
export function maxSignatureSize(cert: Certificate): number {
  if (cert.keyType === 'RSA') return Math.ceil((cert.keyBits ?? 4096) / 8)
  const curveSize: Record<NamedCurve, number> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 }
  const n = curveSize[cert.curve ?? 'P-521']
  // SEQUENCE { INTEGER r, INTEGER s }, each with a possible leading zero.
  return 2 * (n + 1 + 3) + 4
}

function signatureAlgorithm(cert: Certificate): Uint8Array {
  if (cert.keyType === 'RSA' && cert.keyAlgorithmOid === OID.rsaEncryption) return derSequence(derOid(OID.rsaEncryption), derNull())
  if (cert.keyType === 'EC') return derSequence(derOid(OID.ecdsaWithSha256))
  throw new Error(`Signing with ${cert.summary.keyDescription} keys is not supported. Use an RSA or ECDSA certificate.`)
}

function attribute(oid: string, value: Uint8Array): Uint8Array {
  return derSequence(derOid(oid), derSetOf([value]))
}

function generalNamesFor(cert: Certificate): Uint8Array {
  // GeneralNames ::= SEQUENCE OF GeneralName; directoryName [4] EXPLICIT Name
  return derSequence(derElement(0xa4, cert.issuerDer))
}

async function signedAttributes(contentDigest: Uint8Array, cert: Certificate, options: CmsSignOptions): Promise<Uint8Array[]> {
  const certHash = await digest('SHA-256', cert.der)
  // ESSCertIDv2 (hashAlgorithm defaults to SHA-256, so it is omitted) with IssuerSerial.
  const essCertId = derSequence(
    derOctetString(certHash),
    derSequence(generalNamesFor(cert), derElement(0x02, cert.serialDer))
  )
  const attrs = [
    attribute(OID.contentType, derOid(OID.data)),
    attribute(OID.messageDigest, derOctetString(contentDigest)),
    attribute(OID.signingCertificateV2, derSequence(derSequence(essCertId)))
  ]
  if (!options.cades) attrs.push(attribute(OID.signingTime, derTime(options.signingTime ?? new Date())))
  return sortDer(attrs)
}

function signedDataFor(cert: Certificate, chain: Uint8Array[], attrs: Uint8Array[], signature: Uint8Array): Uint8Array {
  const signerInfo = derSequence(
    derSmallInteger(1),
    derSequence(cert.issuerDer, derElement(0x02, cert.serialDer)),
    SHA256_ALG,
    derElement(0xa0, ...attrs),
    signatureAlgorithm(cert),
    derOctetString(signature)
  )
  const signedData = derSequence(
    derSmallInteger(1),
    derSetOf([SHA256_ALG]),
    derSequence(derOid(OID.data)),
    derElement(0xa0, cert.der, ...chain),
    derSetOf([signerInfo])
  )
  return derSequence(derOid(OID.signedData), derContext(0, signedData))
}

/**
 * Detached CMS SignedData over content whose SHA-256 is `contentDigest`, with the signed
 * attributes content-type, message-digest, signing-certificate-v2 (and signing-time unless CAdES).
 */
export async function createCmsSignature(contentDigest: Uint8Array, signer: CmsSigner, options: CmsSignOptions): Promise<Uint8Array> {
  const cert = parseCertificate(signer.certificate)
  const attrs = await signedAttributes(contentDigest, cert, options)
  const signature = await signer.sign(derSetOf(attrs))
  return signedDataFor(cert, signer.chain ?? [], attrs, signature)
}

/** Upper bound of the size of createCmsSignature()'s result for this signer. */
export async function estimateCmsSize(signer: Pick<CmsSigner, 'certificate' | 'chain'>, options: CmsSignOptions): Promise<number> {
  const cert = parseCertificate(signer.certificate)
  const attrs = await signedAttributes(new Uint8Array(32), cert, { ...options, signingTime: new Date(Date.UTC(2100, 0, 1)) })
  return signedDataFor(cert, signer.chain ?? [], attrs, new Uint8Array(maxSignatureSize(cert))).length
}

/**
 * Checks that `data` is a DER SET of CMS attributes with content-type and message-digest, i.e.
 * the only thing a PDF signer is expected to sign (the main process refuses anything else).
 */
export function assertSignedAttributes(data: Uint8Array): void {
  let set: Asn1
  try {
    set = parseAsn1(data)
  } catch {
    throw new Error('Refusing to sign: not CMS signed attributes')
  }
  if (!isUniversal(set, Tag.Set) || set.end !== data.length) throw new Error('Refusing to sign: not CMS signed attributes')
  const oids = set.children.map((a) => {
    if (!isUniversal(a, Tag.Sequence)) throw new Error('Refusing to sign: not CMS signed attributes')
    return readOid(a.children[0])
  })
  if (!oids.includes(OID.contentType) || !oids.includes(OID.messageDigest)) {
    throw new Error('Refusing to sign: not CMS signed attributes')
  }
}

// ---------------------------------------------------------------------------------------------
// Verification

export interface CmsVerification {
  /** Signer certificate (when found in the SignedData). */
  signer?: Certificate
  /** All embedded certificates. */
  certificates: Certificate[]
  digestAlgorithm?: DigestName
  /** e.g. "RSA with SHA-256". */
  signatureAlgorithm?: string
  /** The message-digest attribute matches the content (null: could not be checked). */
  digestValid: boolean | null
  /** The signature over the signed attributes verifies with the signer's key (null: unchecked). */
  signatureValid: boolean | null
  /** The signing-certificate(-v2) attribute matches the signer certificate (undefined: absent). */
  certificateBindingValid?: boolean
  signingTime?: Date
  /** Encapsulated content (eContent), e.g. a timestamp's TSTInfo. */
  encapsulatedContent?: Uint8Array
  encapsulatedContentType?: string
  /** Signature value (timestamp tokens hash it). */
  signatureValue?: Uint8Array
  /** Unsigned attributes by OID (values: the attribute's value elements). */
  unsignedAttributes: Map<string, Asn1[]>
  problems: string[]
}

interface SignerInfo {
  sid: Asn1
  digestOid: string
  signedAttrs?: Asn1
  signatureAlgOid: string
  signatureAlgParams?: Asn1
  signature: Uint8Array
  unsignedAttrs?: Asn1
}

function readSignerInfo(node: Asn1): SignerInfo {
  const c = node.children
  let i = 1 // skip version
  const sid = c[i++]
  const digestOid = readOid(c[i++].children[0])
  let signedAttrs: Asn1 | undefined
  if (isContext(c[i], 0)) signedAttrs = c[i++]
  const sigAlg = c[i++]
  const signature = contentBytes(c[i++])
  const unsignedAttrs = isContext(c[i], 1) ? c[i] : undefined
  return {
    sid,
    digestOid,
    signedAttrs,
    signatureAlgOid: readOid(sigAlg.children[0]),
    signatureAlgParams: sigAlg.children[1],
    signature,
    unsignedAttrs
  }
}

function attributesByOid(set: Asn1 | undefined): Map<string, Asn1[]> {
  const out = new Map<string, Asn1[]>()
  for (const attr of set?.children ?? []) {
    try {
      out.set(readOid(attr.children[0]), attr.children[1]?.children ?? [])
    } catch {
      /* skip */
    }
  }
  return out
}

function findSigner(sid: Asn1, certs: Certificate[]): Certificate | undefined {
  if (isUniversal(sid, Tag.Sequence)) {
    // IssuerAndSerialNumber
    const issuer = rawBytes(sid.children[0])
    const serial = contentBytes(sid.children[1])
    return certs.find((c) => equalBytes(c.issuerDer, issuer) && equalBytes(stripZeros(c.serialDer), stripZeros(serial)))
  }
  if (isContext(sid, 0)) {
    const ski = contentBytes(sid)
    return certs.find((c) => c.subjectKeyIdentifier && equalBytes(c.subjectKeyIdentifier, ski))
  }
  return undefined
}

function stripZeros(bytes: Uint8Array): Uint8Array {
  let i = 0
  while (i < bytes.length - 1 && bytes[i] === 0) i++
  return bytes.subarray(i)
}

const RSA_SIG_HASH: Record<string, DigestName> = {
  [OID.sha1WithRSA]: 'SHA-1',
  [OID.sha256WithRSA]: 'SHA-256',
  [OID.sha384WithRSA]: 'SHA-384',
  [OID.sha512WithRSA]: 'SHA-512'
}
const ECDSA_SIG_HASH: Record<string, DigestName> = {
  [OID.ecdsaWithSha1]: 'SHA-1',
  [OID.ecdsaWithSha256]: 'SHA-256',
  [OID.ecdsaWithSha384]: 'SHA-384',
  [OID.ecdsaWithSha512]: 'SHA-512'
}

/** DER Ecdsa-Sig-Value → IEEE P1363 r||s (what WebCrypto expects). */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
  const seq = parseAsn1(der)
  const out = new Uint8Array(size * 2)
  seq.children.slice(0, 2).forEach((n, i) => {
    const v = stripZeros(contentBytes(n))
    if (v.length > size) throw new Asn1Error('Invalid ECDSA signature')
    out.set(v, i * size + size - v.length)
  })
  return out
}

const CURVE_BYTES: Record<NamedCurve, number> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 }

async function verifyWithCertificate(
  cert: Certificate,
  info: SignerInfo,
  digestName: DigestName,
  data: Uint8Array
): Promise<{ valid: boolean | null; algorithm: string; problem?: string }> {
  const subtle = subtleCrypto()
  const oid = info.signatureAlgOid
  try {
    if (cert.keyType === 'RSA') {
      if (oid === OID.rsaPss) {
        const params = info.signatureAlgParams
        let hash: DigestName = 'SHA-1'
        let saltLength = 20
        for (const p of params?.children ?? []) {
          if (isContext(p, 0)) hash = digestFromOid(readOid(p.children[0].children[0])) ?? hash
          if (isContext(p, 2)) saltLength = readSmallInteger(p.children[0])
        }
        const key = await subtle.importKey('spki', ownBytes(cert.spki), { name: 'RSA-PSS', hash }, false, ['verify'])
        const valid = await subtle.verify({ name: 'RSA-PSS', saltLength }, key, ownBytes(info.signature), ownBytes(data))
        return { valid, algorithm: `RSA-PSS with ${hash}` }
      }
      const hash = oid === OID.rsaEncryption ? digestName : RSA_SIG_HASH[oid]
      if (!hash) return { valid: null, algorithm: oid, problem: `Unsupported signature algorithm (${oid}).` }
      const key = await subtle.importKey('spki', ownBytes(cert.spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify'])
      const valid = await subtle.verify('RSASSA-PKCS1-v1_5', key, ownBytes(info.signature), ownBytes(data))
      return { valid, algorithm: `RSA with ${hash}` }
    }
    if (cert.keyType === 'EC') {
      const hash = oid === OID.ecPublicKey ? digestName : ECDSA_SIG_HASH[oid]
      if (!hash || !cert.curve) return { valid: null, algorithm: oid, problem: 'Unsupported ECDSA signature algorithm or curve.' }
      const key = await subtle.importKey('spki', ownBytes(cert.spki), { name: 'ECDSA', namedCurve: cert.curve }, false, ['verify'])
      let raw: Uint8Array
      try {
        raw = ecdsaDerToRaw(info.signature, CURVE_BYTES[cert.curve])
      } catch {
        return { valid: false, algorithm: `ECDSA with ${hash}` }
      }
      const valid = await subtle.verify({ name: 'ECDSA', hash }, key, ownBytes(raw), ownBytes(data))
      return { valid, algorithm: `ECDSA ${cert.curve} with ${hash}` }
    }
    return { valid: null, algorithm: oid, problem: `Unsupported key type (${cert.keyAlgorithmOid}).` }
  } catch (e) {
    return { valid: null, algorithm: oid, problem: `The signature could not be checked (${(e as Error).message}).` }
  }
}

/** Signing certificate hash from a signing-certificate(-v2) attribute value. */
function boundCertHash(attrs: Map<string, Asn1[]>): { hash: DigestName; value: Uint8Array } | undefined {
  const v2 = attrs.get(OID.signingCertificateV2)?.[0]
  if (v2) {
    const essCertId = v2.children[0]?.children[0]
    if (!essCertId) return undefined
    let hash: DigestName = 'SHA-256'
    let idx = 0
    if (isUniversal(essCertId.children[0], Tag.Sequence)) {
      hash = digestFromOid(readOid(essCertId.children[0].children[0])) ?? hash
      idx = 1
    }
    return { hash, value: contentBytes(essCertId.children[idx]) }
  }
  const v1 = attrs.get(OID.signingCertificate)?.[0]
  const essCertId = v1?.children[0]?.children[0]
  if (essCertId) return { hash: 'SHA-1', value: contentBytes(essCertId.children[0]) }
  return undefined
}

/**
 * Verifies a CMS SignedData. `contentFor` returns the signed content for a digest algorithm
 * (the PDF byte ranges), unless the SignedData encapsulates its content.
 */
export async function verifyCms(
  cms: Uint8Array,
  contentDigestFor: (algorithm: DigestName) => Promise<Uint8Array>
): Promise<CmsVerification> {
  const result: CmsVerification = {
    certificates: [],
    digestValid: null,
    signatureValid: null,
    unsignedAttributes: new Map(),
    problems: []
  }
  let signedData: Asn1
  try {
    const contentInfo = parseAsn1(cms)
    if (readOid(contentInfo.children[0]) !== OID.signedData) throw new Asn1Error('not SignedData')
    signedData = contentInfo.children[1].children[0]
    if (!isUniversal(signedData, Tag.Sequence)) throw new Asn1Error('not SignedData')
  } catch (e) {
    result.problems.push(`The signature data is not a valid CMS signature (${(e as Error).message}).`)
    return result
  }

  let infos: SignerInfo[]
  try {
    const c = signedData.children
    const encap = c[2]
    result.encapsulatedContentType = readOid(encap.children[0])
    if (isContext(encap.children[1], 0)) result.encapsulatedContent = contentBytes(encap.children[1].children[0])
    let i = 3
    if (isContext(c[i], 0)) {
      for (const certNode of c[i].children) {
        // Only X.509 certificates (other CertificateChoices are tagged).
        if (!isUniversal(certNode, Tag.Sequence)) continue
        try {
          result.certificates.push(parseCertificate(rawBytes(certNode).slice()))
        } catch {
          /* skip unreadable certificates */
        }
      }
      i++
    }
    if (isContext(c[i], 1)) i++ // CRLs
    infos = (c[i]?.children ?? []).map(readSignerInfo)
  } catch (e) {
    result.problems.push(`The signature data is damaged (${(e as Error).message}).`)
    return result
  }
  if (infos.length !== 1) {
    result.problems.push(infos.length ? 'Signatures with several signers are not supported.' : 'The signature has no signer.')
    return result
  }
  const info = infos[0]
  result.signatureValue = info.signature
  result.unsignedAttributes = attributesByOid(info.unsignedAttrs)
  const digestName = digestFromOid(info.digestOid)
  if (!digestName) {
    result.problems.push(`Unsupported digest algorithm (${info.digestOid}).`)
    return result
  }
  result.digestAlgorithm = digestName

  const signer = findSigner(info.sid, result.certificates)
  result.signer = signer
  if (!signer) result.problems.push('The signer certificate is not included in the signature.')

  // Content digest: of the encapsulated content, or of the detached content.
  const contentDigest = result.encapsulatedContent
    ? await digest(digestName, result.encapsulatedContent)
    : await contentDigestFor(digestName)

  let signedBytes: Uint8Array
  if (info.signedAttrs) {
    const attrs = attributesByOid(info.signedAttrs)
    const md = attrs.get(OID.messageDigest)?.[0]
    result.digestValid = !!md && equalBytes(contentBytes(md), contentDigest)
    if (!md) result.problems.push('The signature has no message digest.')
    const st = attrs.get(OID.signingTime)?.[0]
    if (st) {
      try {
        result.signingTime = readTime(st)
      } catch {
        /* ignore */
      }
    }
    const bound = boundCertHash(attrs)
    if (bound && signer) result.certificateBindingValid = equalBytes(await digest(bound.hash, signer.der), bound.value)
    // The signature covers the DER encoding of the attributes with an explicit SET OF tag.
    signedBytes = rawBytes(info.signedAttrs).slice()
    signedBytes[0] = 0x31
  } else {
    // Without signed attributes the signature is over the content itself.
    signedBytes = result.encapsulatedContent ?? new Uint8Array()
    result.digestValid = true
    if (!result.encapsulatedContent) {
      result.problems.push('Signatures without signed attributes over detached content are not supported.')
      result.digestValid = null
      return result
    }
  }

  if (signer) {
    const { valid, algorithm, problem } = await verifyWithCertificate(signer, info, digestName, signedBytes)
    result.signatureValid = valid
    result.signatureAlgorithm = algorithm
    if (problem) result.problems.push(problem)
  }
  return result
}
