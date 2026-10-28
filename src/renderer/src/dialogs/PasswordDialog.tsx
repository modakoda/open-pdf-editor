import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Dialog, Field } from './Dialog'

export function PasswordDialog({
  fileName,
  submit,
  onClose
}: {
  fileName: string
  submit: (password: string) => Promise<string | null>
  onClose: (ok: boolean | null) => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy, error])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const err = await submit(password)
      if (err === null) {
        onClose(true)
        return
      }
      setError(err)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      kind="password"
      title="Password required"
      onCancel={() => onClose(null)}
      onConfirm={() => void confirm()}
      confirmLabel="Open"
      busy={busy}
      width={400}
    >
      <div className="callout">
        <KeyRound size={16} aria-hidden="true" />
        <span>
          “{fileName}” is password protected. Enter the password to open it.
        </span>
      </div>
      <Field label="Password" htmlFor="password-input" error={error}>
        <input
          ref={inputRef}
          id="password-input"
          className="input"
          data-testid="password-input"
          type="password"
          autoComplete="off"
          value={password}
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => setPassword(e.target.value)}
          readOnly={busy}
        />
      </Field>
    </Dialog>
  )
}
