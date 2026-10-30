/** Plain-data results of signature verification (kept in SourceDocument.signatures). */
import type { CertificateSummary } from './x509'

export type { CertificateSummary }

/**
 * - valid: intact, made with the embedded certificate, and nothing was added to the file after it
 * - modified: intact for the revision it signs, but the file was changed (incrementally) afterwards
 * - invalid: the signed bytes or the signature do not match: altered or corrupt
 * - unknown: could not be checked (unsupported algorithm or format)
 */
export type SignatureStatus = 'valid' | 'modified' | 'invalid' | 'unknown'

export interface PdfSignatureInfo {
  /** 'timestamp' for document timestamps (/Type /DocTimeStamp). */
  kind: 'signature' | 'timestamp'
  /** Fully qualified name of the signature field. */
  fieldName: string
  /** Page (0-based, in the file) and rectangle (page space) of the visible widget, if any. */
  pageIndex?: number
  box?: { x: number; y: number; width: number; height: number }
  /** True when the widget has no area (an invisible signature). */
  invisible: boolean
  subFilter?: string
  /** Signer's name: certificate subject (or /Name when no certificate could be read). */
  signerName: string
  certificate?: CertificateSummary
  /** Number of certificates embedded in the signature. */
  certificateCount: number
  /** ISO time of signing: from a verified timestamp, the signed attributes, or /M. */
  signingTime?: string
  signingTimeSource?: 'timestamp' | 'signature' | 'pdf'
  /** Embedded RFC 3161 timestamp (signature timestamp or document timestamp). */
  timestamp?: { time: string; valid: boolean; authority?: string }
  reason?: string
  location?: string
  contactInfo?: string
  byteRange: number[]
  /** Length of the file revision covered by the signature. */
  signedLength: number
  /** The signature covers the whole file (nothing appended after signing). */
  coversWholeDocument: boolean
  /** Incremental updates saved after the signed revision. */
  laterRevisions: number
  /** The signed bytes hash to the value in the signature (null: not checked). */
  digestValid: boolean | null
  /** The cryptographic signature verifies with the signer certificate (null: not checked). */
  signatureValid: boolean | null
  /** The certificate was within its validity period at the signing time. */
  certificateValidAtSigningTime?: boolean
  digestAlgorithm?: string
  signatureAlgorithm?: string
  status: SignatureStatus
  /** Why a signature is invalid or unknown. */
  problems: string[]
  /** Things worth knowing that do not invalidate the signature. */
  warnings: string[]
}
