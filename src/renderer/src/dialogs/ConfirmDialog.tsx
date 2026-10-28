import { FileText } from 'lucide-react'
import type { ConfirmResult } from '@renderer/state/dialogs'
import { Dialog } from './Dialog'

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  altLabel,
  danger,
  onClose
}: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  altLabel?: string
  danger?: boolean
  onClose: (result: ConfirmResult | null) => void
}) {
  return (
    <Dialog
      kind="confirm"
      title={title}
      onCancel={() => onClose(null)}
      onConfirm={() => onClose('confirm')}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      danger={danger}
      width={420}
      footerStart={
        altLabel ? (
          <button type="button" className="btn" data-testid="dialog-alt" onClick={() => onClose('alt')}>
            {altLabel}
          </button>
        ) : undefined
      }
    >
      <p className="dialog-message">{message}</p>
    </Dialog>
  )
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog kind="about" title="About" onCancel={onClose} cancelLabel="Close" width={360}>
      <div className="about">
        <div className="welcome-logo" aria-hidden="true">
          <FileText size={28} strokeWidth={1.6} />
        </div>
        <h3>Open PDF Editor</h3>
        <p>A free, cross-platform PDF editor.</p>
        <p>Rendering by pdf.js · Fonts: Noto (SIL OFL)</p>
      </div>
    </Dialog>
  )
}
