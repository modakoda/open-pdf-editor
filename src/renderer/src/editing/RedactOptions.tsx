/**
 * Toolbar options of the Redact tool: fill color and overlay text (of the selected area, or of
 * new areas when none is selected), the number of marked areas and "Apply redactions…" (saves).
 */
import { activeRedactions, DEFAULT_REDACTION_FILL, updateRedaction } from '@core'
import { save } from '@renderer/actions/fileActions'
import { useEditor } from '@renderer/state/store'
import { useRedaction } from './redactionState'

export function RedactOptions() {
  const doc = useEditor((s) => s.doc)
  const selectedId = useRedaction((s) => s.selectedId)
  const fillDefault = useRedaction((s) => s.fillColor)
  const textDefault = useRedaction((s) => s.overlayText)
  const selected = doc?.redactions?.find((r) => r.id === selectedId)
  const count = doc ? activeRedactions(doc).length : 0
  const fill = selected ? (selected.fillColor === undefined ? DEFAULT_REDACTION_FILL : selected.fillColor) : fillDefault
  const text = selected ? (selected.overlayText ?? '') : textDefault

  const change = (patch: { fillColor?: string | null; overlayText?: string }) => {
    useRedaction.getState().setDefaults(patch)
    if (selected) {
      const p = patch.overlayText === '' ? { ...patch, overlayText: undefined } : patch
      useEditor.getState().apply((d) => updateRedaction(d, selected.id, p), { coalesceKey: `redaction-props-${selected.id}` })
    }
  }

  return (
    <div className="ed-quick ed-redact-options" aria-label="Redaction options">
      <label title="Fill the area after removing its content">
        <input
          type="checkbox"
          data-testid="redact-fill-enabled"
          checked={fill !== null}
          onChange={(e) => change({ fillColor: e.target.checked ? (fillDefault ?? DEFAULT_REDACTION_FILL) : null })}
        />
        Fill
      </label>
      <input
        type="color"
        className="ed-quick-color"
        data-testid="redact-fill"
        title="Fill color"
        aria-label="Fill color"
        disabled={fill === null}
        value={fill ?? DEFAULT_REDACTION_FILL}
        onChange={(e) => change({ fillColor: e.target.value })}
      />
      <input
        type="text"
        className="ed-quick-text"
        data-testid="redact-overlay-text"
        placeholder="Overlay text"
        aria-label="Overlay text"
        value={text}
        onChange={(e) => change({ overlayText: e.target.value })}
      />
      <span className="ed-redact-count" data-testid="redact-count">
        {count === 1 ? '1 area' : `${count} areas`}
      </span>
      <button
        type="button"
        className="btn btn-small"
        data-testid="redact-apply"
        disabled={count === 0}
        title="Remove the marked content permanently and save the file"
        onClick={() => void save()}
      >
        Apply…
      </button>
    </div>
  )
}
