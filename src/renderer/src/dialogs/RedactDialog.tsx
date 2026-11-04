import { useState } from 'react'
import type { RedactionChoice } from '@renderer/actions/redactActions'
import { Dialog } from './Dialog'

/** "Apply redactions" confirmation shown before a save that applies redaction areas. */
export function RedactDialog({
  areas,
  pages,
  onClose
}: {
  areas: number
  pages: number
  onClose: (result: RedactionChoice | null) => void
}) {
  const [sanitize, setSanitize] = useState(false)
  const what = `${areas} marked ${areas === 1 ? 'area' : 'areas'}${pages > 1 ? ` on ${pages} pages` : ''}`
  return (
    <Dialog
      kind="redact"
      title="Apply redactions"
      onCancel={() => onClose(null)}
      onConfirm={() => onClose({ sanitize })}
      confirmLabel="Apply and save"
      danger
      width={460}
    >
      <p className="dialog-message">
        Everything under the {what} — text, images, graphics, comments and form fields — is permanently removed
        from the saved file. This cannot be undone; the saved file is opened again so you can check the result.
      </p>
      <label className="check">
        <input type="checkbox" data-testid="redact-sanitize" checked={sanitize} onChange={(e) => setSanitize(e.target.checked)} />
        <span>
          Sanitize document
          <small>Also remove document properties and metadata, attachments, JavaScript and hidden layers.</small>
        </span>
      </label>
    </Dialog>
  )
}
