/**
 * Sidebar tab listing the file's digital signatures with their verification result, and the
 * status-bar badge that summarizes them.
 */
import { useEffect } from 'react'
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, TriangleAlert } from 'lucide-react'
import type { EditorDocument, PdfSignatureInfo, SignatureStatus } from '@core'
import { runCommand } from '@renderer/actions/commands'
import { documentSignatures, hasLiveSignatures, isUnchangedSinceOpen, useSigning } from '@renderer/state/signing'
import { useEditor } from '@renderer/state/store'
import './signatures.css'

const STATUS_TEXT: Record<SignatureStatus, string> = {
  valid: 'Signature is valid',
  modified: 'Valid, but the document was changed later',
  invalid: 'Signature is invalid',
  unknown: 'Signature could not be verified'
}

const STATUS_ICON = { valid: ShieldCheck, modified: ShieldAlert, invalid: ShieldX, unknown: ShieldQuestion }

/** Worst status first. */
const SEVERITY: SignatureStatus[] = ['invalid', 'unknown', 'modified', 'valid']

export function overallStatus(signatures: PdfSignatureInfo[]): SignatureStatus | null {
  if (!signatures.length) return null
  return SEVERITY.find((s) => signatures.some((sig) => sig.status === s)) ?? 'unknown'
}

export function formatSigningTime(iso: string | undefined): string {
  if (!iso) return 'Unknown time'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

/** The signatures the panel and badge show (none once saving changes removed them). */
function useLiveSignatures(): PdfSignatureInfo[] {
  const doc = useEditor((s) => s.doc)
  const docSession = useEditor((s) => s.docSession)
  const removed = useSigning((s) => s.removedInSession === docSession)
  return removed ? [] : documentSignatures(doc)
}

export function useSignatureCount(): number {
  return useLiveSignatures().length
}

function pageIdFor(doc: EditorDocument, sig: PdfSignatureInfo): string | undefined {
  if (sig.pageIndex === undefined || !doc.primarySourceId) return undefined
  return doc.pages.find((p) => p.source.kind === 'source' && p.source.sourceId === doc.primarySourceId && p.source.pageIndex === sig.pageIndex)?.id
}

function SignatureItem({ doc, sig }: { doc: EditorDocument; sig: PdfSignatureInfo }) {
  const Icon = STATUS_ICON[sig.status]
  const pageId = pageIdFor(doc, sig)
  const pageNumber = pageId ? doc.pages.findIndex((p) => p.id === pageId) + 1 : undefined
  const cert = sig.certificate
  const timeLabel =
    sig.signingTimeSource === 'timestamp' ? 'timestamp' : sig.signingTimeSource === 'pdf' ? "signer's computer" : 'signature'
  return (
    <li className="signature-item" data-testid="signature-item" data-status={sig.status} data-field={sig.fieldName}>
      <button
        type="button"
        className="signature-item-head"
        disabled={!pageId}
        title={pageId ? 'Show the signature in the document' : undefined}
        onClick={() => {
          if (!pageId) return
          const box = sig.box
          useEditor.getState().goToPage(pageId, box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined)
        }}
      >
        <Icon size={18} className={`signature-icon signature-icon-${sig.status}`} aria-hidden="true" />
        <span className="signature-item-text">
          <span className="signature-signer" data-testid="signature-signer">
            {sig.kind === 'timestamp' ? `Timestamp: ${sig.signerName}` : sig.signerName}
          </span>
          <span className={`signature-status signature-status-${sig.status}`} data-testid="signature-status">
            {STATUS_TEXT[sig.status]}
          </span>
        </span>
      </button>
      <dl className="signature-details">
        <dt>Signed</dt>
        <dd data-testid="signature-time" title={`Time from the ${timeLabel}`}>
          {formatSigningTime(sig.signingTime)}
        </dd>
        {sig.reason && (
          <>
            <dt>Reason</dt>
            <dd data-testid="signature-reason">{sig.reason}</dd>
          </>
        )}
        {sig.location && (
          <>
            <dt>Location</dt>
            <dd>{sig.location}</dd>
          </>
        )}
        {sig.contactInfo && (
          <>
            <dt>Contact</dt>
            <dd>{sig.contactInfo}</dd>
          </>
        )}
        <dt>Field</dt>
        <dd>
          {sig.fieldName}
          {sig.invisible ? ' (invisible)' : pageNumber ? `, page ${pageNumber}` : ''}
        </dd>
      </dl>
      {(sig.problems.length > 0 || sig.warnings.length > 0) && (
        <ul className="signature-messages">
          {sig.problems.map((p, i) => (
            <li key={`p${i}`} className="signature-problem">
              {p}
            </li>
          ))}
          {sig.warnings.map((w, i) => (
            <li key={`w${i}`} className="signature-warning">
              {w}
            </li>
          ))}
        </ul>
      )}
      <p className="signature-coverage" data-testid="signature-coverage">
        {sig.coversWholeDocument ? 'Covers the whole document.' : 'Covers an earlier version of the document.'}
      </p>
      <details className="signature-cert">
        <summary data-testid="signature-identity">Identity not verified</summary>
        <p className="signature-cert-note">
          The certificate is not checked against trusted authorities. Confirm the signer’s identity another way.
        </p>
        {cert ? (
          <dl className="signature-details">
            <dt>Subject</dt>
            <dd>{cert.subject}</dd>
            <dt>Issuer</dt>
            <dd>{cert.selfSigned ? 'Self-signed' : cert.issuer}</dd>
            <dt>Valid</dt>
            <dd>
              {formatSigningTime(cert.notBefore)} – {formatSigningTime(cert.notAfter)}
            </dd>
            <dt>Serial</dt>
            <dd className="signature-mono">{cert.serialNumber}</dd>
            <dt>Algorithm</dt>
            <dd>{sig.signatureAlgorithm ?? cert.keyDescription}</dd>
          </dl>
        ) : (
          <p className="signature-cert-note">The signature contains no readable certificate.</p>
        )}
      </details>
    </li>
  )
}

export function SignaturesPanel() {
  const doc = useEditor((s) => s.doc)
  const dirty = useEditor((s) => s.dirty)
  const signatures = useLiveSignatures()
  if (!doc) return null
  const edited = signatures.length > 0 && dirty && !isUnchangedSinceOpen(doc)
  return (
    <div className="sidebar-panel signatures-panel" role="tabpanel" id="sidebar-panel-signatures" aria-labelledby="sidebar-tab-signatures" data-testid="signatures-panel">
      {edited && (
        <div className="signatures-edited" data-testid="signatures-edited-warning">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>You changed this document. Saving removes these signatures; use Save As to keep the signed original.</span>
        </div>
      )}
      {signatures.length ? (
        <ul className="signature-list">
          {signatures.map((sig) => (
            <SignatureItem key={`${sig.fieldName}:${sig.signedLength}`} doc={doc} sig={sig} />
          ))}
        </ul>
      ) : (
        <div className="fields-empty">
          <span>This document has no digital signatures.</span>
        </div>
      )}
      <div className="signatures-footer">
        <button type="button" className="btn" data-testid="signatures-sign" onClick={() => runCommand('sign', 'ui')}>
          Sign…
        </button>
      </div>
    </div>
  )
}

const BADGE_TEXT: Record<SignatureStatus, string> = {
  valid: 'Signed',
  modified: 'Signed, changed later',
  invalid: 'Invalid signature',
  unknown: 'Signature not verified'
}

/** Status-bar summary of the signatures; opens the Signatures tab. Warns once when a signed file is edited. */
export function SignatureBadge() {
  const signatures = useLiveSignatures()
  const dirty = useEditor((s) => s.dirty)
  const docSession = useEditor((s) => s.docSession)
  const status = overallStatus(signatures)

  useEffect(() => {
    const s = useEditor.getState()
    if (!dirty || !s.doc || !hasLiveSignatures(s.doc) || isUnchangedSinceOpen(s.doc)) return
    if (useSigning.getState().warnedInSession === docSession) return
    useSigning.setState({ warnedInSession: docSession })
    s.showNotice(
      'info',
      'This document is digitally signed. Saving your changes removes the signatures; use Save As to keep the signed original.',
      undefined,
      { important: true }
    )
  }, [dirty, docSession])

  if (!status) return null
  const Icon = STATUS_ICON[status]
  const count = signatures.length
  return (
    <button
      type="button"
      className={`signature-badge signature-badge-${status}`}
      data-testid="signature-badge"
      data-status={status}
      title={`${count} digital signature${count === 1 ? '' : 's'}: ${STATUS_TEXT[status].toLowerCase()}. Click for details.`}
      onClick={() => {
        const s = useEditor.getState()
        s.setSidebarOpen(true)
        s.setSidebarTab('signatures')
      }}
    >
      <Icon size={12} aria-hidden="true" />
      {BADGE_TEXT[status]}
      {count > 1 && <span className="signature-badge-count">{count}</span>}
    </button>
  )
}
