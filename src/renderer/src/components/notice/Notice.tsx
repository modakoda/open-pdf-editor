/** Toast for store.notice (data-testid="notice", data-kind="info|error"). */
import { useEffect } from 'react'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { useEditor } from '@renderer/state/store'
import './notice.css'

const INFO_MS = 4000
const ERROR_MS = 10000
/** Notices that offer an action stay longer. */
const ACTION_MS = 20000

export function Notice() {
  const notice = useEditor((s) => s.notice)
  const clear = useEditor((s) => s.clearNotice)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => {
      if (useEditor.getState().notice === notice) clear()
    }, notice.action ? ACTION_MS : notice.kind === 'error' ? ERROR_MS : INFO_MS)
    return () => clearTimeout(t)
  }, [notice, clear])

  if (!notice) return null
  const Icon = notice.kind === 'error' ? CircleAlert : CircleCheck
  return (
    <div className="notice-host">
      <div
        key={notice.id}
        className={`notice notice-${notice.kind}`}
        data-testid="notice"
        data-kind={notice.kind}
        role={notice.kind === 'error' ? 'alert' : 'status'}
      >
        <Icon size={16} aria-hidden="true" className="notice-icon" />
        <span className="notice-text">{notice.text}</span>
        {notice.action && (
          <button
            type="button"
            className="notice-action"
            data-testid="notice-action"
            onClick={() => {
              const { action } = notice
              clear()
              action?.run()
            }}
          >
            {notice.action.label}
          </button>
        )}
        <button type="button" className="notice-close" aria-label="Dismiss" title="Dismiss" onClick={clear}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
