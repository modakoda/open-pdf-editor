/**
 * "Sign digitally": choose a PKCS#12 certificate and unlock it with its password (the password
 * is sent once to the main process and not kept), choose an empty signature field or a new box,
 * and the signature details and appearance. Resolves with a SignRequest (see actions/signActions).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileKey, ImagePlus, Info, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import type { UnlockedCertificate } from '@shared/ipc'
import { emptySignatureFieldChoices } from '@renderer/actions/signActions'
import { SignatureDialog } from '@renderer/editing'
import { platform } from '@renderer/platform'
import { documentSignatures, isUnchangedSinceOpen, type SignRequest } from '@renderer/state/signing'
import { useEditor, type PendingImage } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'
import '../components/signatures/signatures.css'

const NEW_FIELD = '__new__'

function formatDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Why a certificate cannot sign now (expired / not yet valid), or null. */
export function certificateValidityProblem(cert: Pick<UnlockedCertificate, 'summary'>, now = new Date()): string | null {
  const { notBefore, notAfter } = cert.summary
  if (now.getTime() > Date.parse(notAfter)) return `This certificate expired on ${formatDay(notAfter)}.`
  if (now.getTime() < Date.parse(notBefore)) return `This certificate is not valid before ${formatDay(notBefore)}.`
  return null
}

function useImageUrl(image: PendingImage | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!image) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(new Blob([image.data as BlobPart], { type: image.mimeType }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [image])
  return url
}

export function SignDialog({ onClose }: { onClose: (result: SignRequest | null) => void }) {
  const doc = useEditor((s) => s.doc)
  const fields = useMemo(() => (doc ? emptySignatureFieldChoices(doc) : []), [doc])
  const existing = documentSignatures(doc).length
  const changed = !!doc && existing > 0 && !isUnchangedSinceOpen(doc)

  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [password, setPassword] = useState('')
  const [certificate, setCertificate] = useState<UnlockedCertificate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState(fields[0]?.name ?? NEW_FIELD)
  const [reason, setReason] = useState('')
  const [location, setLocation] = useState('')
  const [contactInfo, setContactInfo] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showDate, setShowDate] = useState(true)
  const [image, setImage] = useState<PendingImage | null>(null)
  const [padOpen, setPadOpen] = useState(false)
  const imageUrl = useImageUrl(image)
  const passwordRef = useRef<HTMLInputElement>(null)
  // The certificate to release if the dialog is cancelled or another file is chosen.
  const held = useRef<string | null>(null)
  const done = useRef(false)

  useEffect(
    () => () => {
      if (!done.current && held.current) platform.releaseCertificate?.(held.current)
    },
    []
  )

  const release = () => {
    if (held.current) platform.releaseCertificate?.(held.current)
    held.current = null
  }

  const chooseCertificate = async () => {
    setError(null)
    try {
      const picked = await platform.openCertificateDialog?.()
      if (!picked) return
      release()
      held.current = picked.id
      setFile(picked)
      setCertificate(null)
      setPassword('')
      setTimeout(() => passwordRef.current?.focus(), 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const unlock = async () => {
    if (!file || !platform.unlockCertificate) return
    setBusy(true)
    setError(null)
    try {
      const result = await platform.unlockCertificate(file.id, password)
      if (!result.ok) {
        setError(result.reason === 'password' ? 'Incorrect password. Please try again.' : result.message)
        if (result.reason === 'password') passwordRef.current?.select()
        return
      }
      setPassword('')
      setCertificate(result.certificate)
      setDisplayName((name) => name || result.certificate.summary.subjectName)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const validityProblem = certificate ? certificateValidityProblem(certificate) : null

  const confirm = () => {
    if (!certificate) {
      void unlock()
      return
    }
    if (validityProblem) return
    done.current = true
    onClose({
      certificate,
      target: target === NEW_FIELD ? { kind: 'new' } : { kind: 'field', name: target },
      reason: reason.trim(),
      location: location.trim(),
      contactInfo: contactInfo.trim(),
      displayName: displayName.trim(),
      showDate,
      image
    })
  }

  const cancel = () => {
    release()
    onClose(null)
  }

  const confirmLabel = !certificate ? 'Unlock' : target === NEW_FIELD ? 'Place signature…' : 'Sign and save as…'

  return (
    <>
      <Dialog
        kind="sign"
        title="Sign digitally"
        onCancel={cancel}
        onConfirm={confirm}
        confirmLabel={confirmLabel}
        confirmDisabled={!file || (!!certificate && !!validityProblem)}
        busy={busy}
        width={500}
      >
        <Field label="Certificate" inline hint={file ? undefined : 'A PKCS#12 file (.p12 or .pfx) with your certificate and private key.'}>
          <div className="sign-file-row">
            {file && (
              <span className="sign-file-name" data-testid="sign-certificate-file" title={file.name}>
                <FileKey size={14} aria-hidden="true" />
                {file.name}
              </span>
            )}
            <button type="button" className="btn" data-testid="sign-choose-certificate" onClick={() => void chooseCertificate()} disabled={busy}>
              {file ? 'Change…' : 'Choose certificate…'}
            </button>
          </div>
        </Field>

        {file && !certificate && (
          <Field label="Password" htmlFor="sign-password" inline error={error} hint="Used once to open the certificate; it is not stored.">
            <input
              ref={passwordRef}
              id="sign-password"
              className="input"
              data-testid="sign-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {!file && error && (
          <div className="callout callout-warning" role="alert" data-testid="field-error">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {certificate && (
          <div className="sign-certificate" data-testid="sign-certificate">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <div className="sign-certificate-name">{certificate.summary.subjectName}</div>
              <div className="sign-certificate-meta">
                Issued by {certificate.summary.selfSigned ? 'itself (self-signed)' : certificate.summary.issuerName} · valid until{' '}
                {formatDay(certificate.summary.notAfter)} · {certificate.summary.keyDescription}
              </div>
            </div>
          </div>
        )}
        {validityProblem && (
          <div className="callout callout-warning" role="alert" data-testid="sign-certificate-invalid">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>{validityProblem} Choose another certificate.</span>
          </div>
        )}

        {certificate && (
          <>
            <Field label="Signature field" htmlFor="sign-field" inline>
              <select id="sign-field" className="input" data-testid="sign-field" value={target} onChange={(e) => setTarget(e.target.value)}>
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                    {f.pageNumber ? ` (page ${f.pageNumber})` : ''}
                  </option>
                ))}
                <option value={NEW_FIELD}>New signature box — draw it on a page</option>
              </select>
            </Field>
            <Field label="Reason" htmlFor="sign-reason" inline>
              <input
                id="sign-reason"
                className="input"
                data-testid="sign-reason"
                placeholder="Optional, e.g. I approve this document"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Field label="Location" htmlFor="sign-location" inline>
              <input
                id="sign-location"
                className="input"
                data-testid="sign-location"
                placeholder="Optional"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </Field>
            <Field label="Contact" htmlFor="sign-contact" inline>
              <input
                id="sign-contact"
                className="input"
                data-testid="sign-contact"
                placeholder="Optional, e.g. an email address"
                value={contactInfo}
                onChange={(e) => setContactInfo(e.target.value)}
              />
            </Field>
            <Field label="Name shown" htmlFor="sign-display-name" inline>
              <input
                id="sign-display-name"
                className="input"
                data-testid="sign-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
            <Field label="Appearance" inline>
              <div className="sign-appearance">
                <label className="check">
                  <input type="checkbox" data-testid="sign-show-date" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} />
                  <span>Show the date</span>
                </label>
                <div className="sign-image-row">
                  {imageUrl ? (
                    <>
                      <img className="sign-image-preview" src={imageUrl} alt="Handwritten signature" data-testid="sign-image-preview" />
                      <button type="button" className="btn btn-icon" aria-label="Remove the signature image" title="Remove" onClick={() => setImage(null)}>
                        <X size={14} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn" data-testid="sign-add-image" onClick={() => setPadOpen(true)}>
                      <ImagePlus size={14} aria-hidden="true" /> Add handwritten signature…
                    </button>
                  )}
                </div>
              </div>
            </Field>
          </>
        )}

        {changed && (
          <div className="callout callout-warning" data-testid="sign-existing-removed">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              The document was changed after it was opened, so its {existing === 1 ? 'existing signature' : `${existing} existing signatures`} will
              not be in the signed copy.
            </span>
          </div>
        )}
        {!changed && existing > 0 && (
          <div className="callout" data-testid="sign-existing-kept">
            <Info size={16} aria-hidden="true" />
            <span>Existing signatures stay valid: your signature is added as an update to the signed file.</span>
          </div>
        )}
        {certificate?.summary.selfSigned && (
          <div className="callout" data-testid="sign-self-signed">
            <Info size={16} aria-hidden="true" />
            <span>This certificate is self-signed: recipients can check that the document is unchanged, but not who signed it.</span>
          </div>
        )}
      </Dialog>
      {padOpen && <SignatureDialog onClose={() => setPadOpen(false)} onCreate={setImage} confirmLabel="Use in signature" />}
    </>
  )
}
