/**
 * Digital signatures: signing (incremental update with a CMS / CAdES signature) and verification.
 * PKCS#12 loading lives in ./pkcs12 (imported directly by the signing side; it needs node-forge).
 */
export * from './types'
export { parseCertificate, certificateFingerprint, type Certificate, type CertificateSummary } from './x509'
export { createCmsSignature, estimateCmsSize, assertSignedAttributes, type CmsSigner, type CmsSignOptions } from './cms'
export {
  signPdf,
  emptySignatureFields,
  appearanceLines,
  SigningError,
  type SignPdfOptions,
  type SignatureTarget,
  type SignatureAppearanceOptions,
  type SignatureImage,
  type SignatureSubFilter,
  type SigningErrorCode
} from './sign'
export { verifyPdfSignatures, verifyLoadedSignatures, hasSignedFields, parsePdfDate } from './verify'
