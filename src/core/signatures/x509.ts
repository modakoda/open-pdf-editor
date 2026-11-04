/**
 * X.509 certificate reading (just what signing and verification need) and WebCrypto helpers
 * for the certificate's public key.
 */
import {
  Asn1Error,
  Tag,
  contentBytes,
  equalBytes,
  integerHex,
  isContext,
  isUniversal,
  parseAsn1,
  rawBytes,
  readOid,
  readString,
  readTime,
  toHex,
  type Asn1
} from './asn1'

export const OID = {
  // Algorithms
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha1WithRSA: '1.2.840.113549.1.1.5',
  rsaPss: '1.2.840.113549.1.1.10',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  sha384WithRSA: '1.2.840.113549.1.1.12',
  sha512WithRSA: '1.2.840.113549.1.1.13',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha1: '1.2.840.10045.4.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  ecdsaWithSha384: '1.2.840.10045.4.3.3',
  ecdsaWithSha512: '1.2.840.10045.4.3.4',
  p256: '1.2.840.10045.3.1.7',
  p384: '1.3.132.0.34',
  p521: '1.3.132.0.35',
  mgf1: '1.2.840.113549.1.1.8',
  // CMS
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  // Names
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  serialNumber: '2.5.4.5',
  country: '2.5.4.6',
  locality: '2.5.4.7',
  state: '2.5.4.8',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  title: '2.5.4.12',
  givenName: '2.5.4.42',
  emailAddress: '1.2.840.113549.1.9.1',
  // Extensions
  subjectKeyIdentifier: '2.5.29.14',
  basicConstraints: '2.5.29.19'
} as const

const NAME_LABELS: Record<string, string> = {
  [OID.commonName]: 'CN',
  [OID.surname]: 'SN',
  [OID.serialNumber]: 'SERIALNUMBER',
  [OID.country]: 'C',
  [OID.locality]: 'L',
  [OID.state]: 'ST',
  [OID.organization]: 'O',
  [OID.organizationalUnit]: 'OU',
  [OID.title]: 'T',
  [OID.givenName]: 'G',
  [OID.emailAddress]: 'E'
}

export type KeyType = 'RSA' | 'EC' | 'other'
export type NamedCurve = 'P-256' | 'P-384' | 'P-521'

const CURVES: Record<string, NamedCurve> = { [OID.p256]: 'P-256', [OID.p384]: 'P-384', [OID.p521]: 'P-521' }

export function curveFromOid(oid: string | undefined): NamedCurve | undefined {
  return oid ? CURVES[oid] : undefined
}

/** Display summary of a certificate (plain data: safe to send over IPC and keep in state). */
export interface CertificateSummary {
  /** Common name (or the whole subject when it has none). */
  subjectName: string
  /** Subject distinguished name, e.g. "CN=Jane Doe, O=Example, C=LT". */
  subject: string
  issuerName: string
  issuer: string
  organization?: string
  email?: string
  /** Hex, without leading zeros. */
  serialNumber: string
  /** ISO 8601. */
  notBefore: string
  notAfter: string
  /** Subject and issuer are the same (not issued by a certificate authority). */
  selfSigned: boolean
  /** e.g. "RSA 2048", "ECDSA P-256". */
  keyDescription: string
}

export interface Certificate {
  der: Uint8Array
  /** Raw DER of the issuer and subject Name (for IssuerAndSerialNumber matching). */
  issuerDer: Uint8Array
  subjectDer: Uint8Array
  /** Raw content of the serial number INTEGER. */
  serialDer: Uint8Array
  /** Complete SubjectPublicKeyInfo DER. */
  spki: Uint8Array
  keyType: KeyType
  keyAlgorithmOid: string
  curve?: NamedCurve
  /** RSA modulus length in bits. */
  keyBits?: number
  subjectKeyIdentifier?: Uint8Array
  summary: CertificateSummary
}

function attributesOf(name: Asn1): { oid: string; value: string }[] {
  const out: { oid: string; value: string }[] = []
  for (const rdn of name.children) {
    for (const atv of rdn.children) {
      const [type, value] = atv.children
      if (!type || !value) continue
      try {
        out.push({ oid: readOid(type), value: readString(value) })
      } catch {
        /* skip unreadable attributes */
      }
    }
  }
  return out
}

function escapeDn(value: string): string {
  return value.replace(/([,+"\\<>;])/g, '\\$1')
}

export function formatName(name: Asn1): string {
  return attributesOf(name)
    .reverse()
    .map((a) => `${NAME_LABELS[a.oid] ?? a.oid}=${escapeDn(a.value)}`)
    .join(', ')
}

function nameValue(name: Asn1, oid: string): string | undefined {
  return attributesOf(name).find((a) => a.oid === oid)?.value
}

function displayName(name: Asn1): string {
  return nameValue(name, OID.commonName) ?? nameValue(name, OID.organization) ?? (formatName(name) || 'Unknown')
}

function readSpki(spki: Asn1): Pick<Certificate, 'keyType' | 'keyAlgorithmOid' | 'curve' | 'keyBits'> {
  const [alg, key] = spki.children
  const algOid = readOid(alg.children[0])
  if (algOid === OID.rsaEncryption || algOid === OID.rsaPss) {
    let keyBits: number | undefined
    try {
      // BIT STRING: first content byte is the number of unused bits.
      const rsaKey = parseAsn1(contentBytes(key).subarray(1))
      const modulus = contentBytes(rsaKey.children[0])
      let start = 0
      while (start < modulus.length && modulus[start] === 0) start++
      keyBits = (modulus.length - start) * 8 - Math.clz32(modulus[start] ?? 0) + 24
    } catch {
      keyBits = undefined
    }
    return { keyType: 'RSA', keyAlgorithmOid: algOid, keyBits }
  }
  if (algOid === OID.ecPublicKey) {
    const params = alg.children[1]
    const curve = isUniversal(params, Tag.Oid) ? curveFromOid(readOid(params)) : undefined
    return { keyType: 'EC', keyAlgorithmOid: algOid, curve }
  }
  return { keyType: 'other', keyAlgorithmOid: algOid }
}

function readExtensions(tbs: Asn1): Map<string, Asn1> {
  const out = new Map<string, Asn1>()
  const ext = tbs.children.find((c) => isContext(c, 3))
  const list = ext?.children[0]
  if (!list) return out
  for (const e of list.children) {
    try {
      const oid = readOid(e.children[0])
      const value = e.children[e.children.length - 1]
      out.set(oid, parseAsn1(contentBytes(value)))
    } catch {
      /* skip */
    }
  }
  return out
}

export function parseCertificate(der: Uint8Array): Certificate {
  let cert: Asn1
  try {
    cert = parseAsn1(der)
  } catch (e) {
    throw new Asn1Error(`Invalid certificate (${(e as Error).message})`)
  }
  const tbs = cert.children[0]
  if (!isUniversal(cert, Tag.Sequence) || !isUniversal(tbs, Tag.Sequence)) throw new Asn1Error('Invalid certificate')
  // [0] EXPLICIT version is optional.
  const fields = isContext(tbs.children[0], 0) ? tbs.children.slice(1) : tbs.children
  const [serial, , issuer, validity, subject, spki] = fields
  if (!serial || !issuer || !validity || !subject || !spki) throw new Asn1Error('Invalid certificate')
  const notBefore = readTime(validity.children[0])
  const notAfter = readTime(validity.children[1])
  const key = readSpki(spki)
  const extensions = readExtensions(tbs)
  const ski = extensions.get(OID.subjectKeyIdentifier)
  const issuerDer = rawBytes(issuer)
  const subjectDer = rawBytes(subject)
  const keyDescription =
    key.keyType === 'RSA'
      ? `RSA${key.keyBits ? ` ${key.keyBits}` : ''}`
      : key.keyType === 'EC'
        ? `ECDSA${key.curve ? ` ${key.curve}` : ''}`
        : key.keyAlgorithmOid
  return {
    der,
    issuerDer,
    subjectDer,
    serialDer: contentBytes(serial),
    spki: rawBytes(spki),
    ...key,
    subjectKeyIdentifier: ski && isUniversal(ski, Tag.OctetString) ? contentBytes(ski) : undefined,
    summary: {
      subjectName: displayName(subject),
      subject: formatName(subject),
      issuerName: displayName(issuer),
      issuer: formatName(issuer),
      organization: nameValue(subject, OID.organization),
      email: nameValue(subject, OID.emailAddress),
      serialNumber: integerHex(serial),
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      selfSigned: equalBytes(issuerDer, subjectDer),
      keyDescription
    }
  }
}

/** `issuer` issued `cert` (by name; the chain is used for display and ordering only). */
export function isIssuedBy(cert: Certificate, issuer: Certificate): boolean {
  return equalBytes(cert.issuerDer, issuer.subjectDer)
}

/** Orders certificates from `leaf` up to the root (by name), followed by any unrelated ones. */
export function orderChain(leaf: Certificate, others: Certificate[]): Certificate[] {
  const rest = others.filter((c) => !equalBytes(c.der, leaf.der))
  const chain = [leaf]
  for (let current = leaf; ; ) {
    if (equalBytes(current.issuerDer, current.subjectDer)) break
    const i = rest.findIndex((c) => isIssuedBy(current, c))
    if (i < 0) break
    current = rest.splice(i, 1)[0]
    chain.push(current)
  }
  return [...chain, ...rest]
}

/** SHA-256 fingerprint as colon-separated hex. */
export async function certificateFingerprint(der: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtleCrypto().digest('SHA-256', der.slice()))
  return toHex(digest).toUpperCase().replace(/(..)(?!$)/g, '$1:')
}

export function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Cryptography is not available in this environment (WebCrypto is missing).')
  return subtle
}
