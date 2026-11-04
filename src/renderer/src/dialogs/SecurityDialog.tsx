import { useState } from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { updateSettings, type EncryptionSettings } from '@core'
import { applyEdit } from '@renderer/actions/util'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'

export function validateSecurity(v: {
  enabled: boolean
  password: string
  confirm: string
  ownerPassword: string
}): string | null {
  if (!v.enabled) return null
  if (!v.password) return 'Enter a password.'
  if (v.password !== v.confirm) return 'The passwords do not match.'
  return null
}

export function SecurityDialog({ onClose }: { onClose: (applied: boolean | null) => void }) {
  const existing = useEditor((s) => s.doc?.settings.encryption ?? null)
  // A file opened with its owner password may keep its original encryption without us knowing
  // the open password (userPassword ''). That protection is kept unless the user changes it here.
  const ownerOnly = !!existing && !existing.userPassword
  const [enabled, setEnabled] = useState(!!existing?.userPassword)
  const [password, setPassword] = useState(existing?.userPassword ?? '')
  const [confirmPw, setConfirmPw] = useState(existing?.userPassword ?? '')
  const [ownerPassword, setOwnerPassword] = useState(
    existing?.ownerPassword && existing.ownerPassword !== existing.userPassword ? existing.ownerPassword : ''
  )
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const error = validateSecurity({ enabled, password, confirm: confirmPw, ownerPassword })
  const mismatch = enabled && !!confirmPw && password !== confirmPw
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setTouched(true)
      set(v)
    }

  const confirm = () => {
    setSubmitted(true)
    if (error) return
    // Untouched: keep the settings exactly as they are (incl. the original encryption and permissions).
    if (!touched) return onClose(true)
    let encryption: EncryptionSettings | null = null
    if (enabled) {
      encryption = { userPassword: password }
      if (ownerPassword) encryption.ownerPassword = ownerPassword
      // Keep the file's original permission restrictions when only the passwords change.
      if (existing?.permissions) encryption.permissions = existing.permissions
    }
    const same =
      (existing === null && encryption === null) ||
      (!!existing &&
        !!encryption &&
        existing.userPassword === encryption.userPassword &&
        (existing.ownerPassword ?? '') === (encryption.ownerPassword ?? ''))
    if (same || applyEdit('Security', (d) => updateSettings(d, { encryption }))) onClose(true)
  }

  return (
    <Dialog
      kind="security"
      title="Password & security"
      onCancel={() => onClose(null)}
      onConfirm={confirm}
      confirmLabel="Apply"
      width={460}
    >
      <label className="check">
        <input
          type="checkbox"
          data-testid="security-enabled"
          checked={enabled}
          onChange={(e) => edit(setEnabled)(e.target.checked)}
        />
        <span>
          Require a password to open this document
          <small>The file is encrypted when you save it.</small>
        </span>
      </label>

      {enabled && (
        <>
          <Field label="Password" htmlFor="sec-password" inline error={submitted && !password ? 'Enter a password.' : null}>
            <input
              id="sec-password"
              className="input"
              data-testid="security-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => edit(setPassword)(e.target.value)}
            />
          </Field>
          <Field label="Confirm" htmlFor="sec-confirm" inline error={mismatch || (submitted && error === 'The passwords do not match.') ? 'The passwords do not match.' : null}>
            <input
              id="sec-confirm"
              className="input"
              data-testid="security-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              aria-invalid={mismatch ? 'true' : undefined}
              onChange={(e) => edit(setConfirmPw)(e.target.value)}
            />
          </Field>
          <Field label="Owner password" htmlFor="sec-owner" inline hint="Optional. Grants full permissions; defaults to the password above.">
            <input
              id="sec-owner"
              className="input"
              data-testid="security-owner-password"
              type="password"
              autoComplete="new-password"
              value={ownerPassword}
              onChange={(e) => edit(setOwnerPassword)(e.target.value)}
            />
          </Field>
          <div className="callout">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Keep the password safe — it cannot be recovered if you forget it.</span>
          </div>
        </>
      )}

      {ownerOnly && !touched && (
        <div className="callout" data-testid="security-owner-only">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            This file was opened with its owner password. Its original protection and permissions are kept when you
            save, unless you change them here.
          </span>
        </div>
      )}

      {!enabled && existing && touched && (
        <div className="callout callout-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>Password protection will be removed when you save.</span>
        </div>
      )}
    </Dialog>
  )
}
