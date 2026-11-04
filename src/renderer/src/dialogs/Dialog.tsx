/**
 * Modal dialog frame: backdrop, title, form body, footer with cancel / confirm buttons.
 * Root carries data-testid="dialog" and data-dialog=<kind>; buttons dialog-cancel / dialog-confirm.
 * Enter submits (form), Escape cancels, focus is trapped inside and restored on close.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { DialogKind } from '@renderer/state/dialogs'
import './dialogs.css'

export interface DialogProps {
  kind: DialogKind
  title: string
  children: ReactNode
  onCancel: () => void
  onConfirm?: () => void
  confirmLabel?: string
  cancelLabel?: string
  confirmDisabled?: boolean
  danger?: boolean
  busy?: boolean
  /** Extra buttons on the left side of the footer (e.g. "Remove"). */
  footerStart?: ReactNode
  /** Extra buttons right before Cancel. */
  footerEnd?: ReactNode
  width?: number
  description?: string
}

export function Dialog({
  kind,
  title,
  children,
  onCancel,
  onConfirm,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  confirmDisabled,
  danger,
  busy,
  footerStart,
  footerEnd,
  width = 440,
  description
}: DialogProps) {
  const titleId = useId()
  const descId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not(:disabled), select, textarea')
    ;(first ?? panel?.querySelector<HTMLElement>('[data-testid="dialog-confirm"]') ?? panel)?.focus()
    if (first instanceof HTMLInputElement && first.type !== 'checkbox' && first.type !== 'radio') first.select()
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true })
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) cancelRef.current()
      return
    }
    if (e.key === 'Tab') {
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div className="dialog-backdrop">
      <div
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        data-testid="dialog"
        data-dialog={kind}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!confirmDisabled && !busy) onConfirm?.()
          }}
        >
          <header className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="dialog-close" aria-label="Close" title="Close" onClick={onCancel} disabled={busy}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="dialog-body">
            {description && (
              <p id={descId} className="dialog-description">
                {description}
              </p>
            )}
            {children}
          </div>
          <footer className="dialog-footer">
            <div className="dialog-footer-start">{footerStart}</div>
            {footerEnd}
            <button type="button" className="btn" data-testid="dialog-cancel" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
            {onConfirm && (
              <button
                type="submit"
                className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
                data-testid="dialog-confirm"
                disabled={confirmDisabled || busy}
              >
                {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
                {confirmLabel}
              </button>
            )}
          </footer>
        </form>
      </div>
    </div>
  )
}

/** Labeled form row. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  inline
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string | null
  children: ReactNode
  inline?: boolean
}) {
  return (
    <div className={`field${inline ? ' field-inline' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">
        {children}
        {error ? (
          <div className="field-error" role="alert" data-testid="field-error">
            {error}
          </div>
        ) : (
          hint && <div className="field-hint">{hint}</div>
        )}
      </div>
    </div>
  )
}
