import { useState } from 'react'
import { updateSettings, type PageNumberPosition, type PageNumberSettings } from '@core'
import { applyEdit } from '@renderer/actions/util'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'

export const DEFAULT_PAGE_NUMBERS: PageNumberSettings = {
  format: '{n}',
  position: 'bottom-center',
  fontSize: 10,
  color: '#374151',
  startAt: 1,
  margin: 24
}

const FORMATS = ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}', '- {n} -']
const POSITIONS: { value: PageNumberPosition; label: string }[] = [
  { value: 'bottom-center', label: 'Bottom center' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-center', label: 'Top center' },
  { value: 'top-right', label: 'Top right' },
  { value: 'top-left', label: 'Top left' }
]

export function formatPageNumber(format: string, n: number, total: number): string {
  return format.replaceAll('{n}', String(n)).replaceAll('{total}', String(total))
}

export function validatePageNumbers(p: PageNumberSettings): string | null {
  if (!p.format.includes('{n}')) return 'The format must contain {n}.'
  if (!(p.fontSize >= 4 && p.fontSize <= 144)) return 'Font size must be between 4 and 144.'
  if (!Number.isInteger(p.startAt) || p.startAt < 0) return 'Start number must be a whole number ≥ 0.'
  if (!(p.margin >= 0 && p.margin <= 200)) return 'Margin must be between 0 and 200 pt.'
  return null
}

const PREVIEW_SCALE = 150 / 595.28

export function PageNumbersDialog({ onClose }: { onClose: (applied: boolean | null) => void }) {
  const existing = useEditor((s) => s.doc?.settings.pageNumbers ?? null)
  const total = useEditor((s) => s.doc?.pages.length ?? 0)
  const [p, setP] = useState<PageNumberSettings>(existing ?? DEFAULT_PAGE_NUMBERS)
  const custom = !FORMATS.includes(p.format)
  const [customFormat, setCustomFormat] = useState(custom)
  const error = validatePageNumbers(p)
  const set = (patch: Partial<PageNumberSettings>) => setP((v) => ({ ...v, ...patch }))

  const confirm = () => {
    if (error) return
    if (applyEdit('Page numbers', (d) => updateSettings(d, { pageNumbers: p }))) onClose(true)
  }
  const remove = () => {
    if (applyEdit('Remove page numbers', (d) => updateSettings(d, { pageNumbers: null }))) onClose(true)
  }

  const [vertical, horizontal] = p.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right']
  const m = Math.max(4, p.margin * PREVIEW_SCALE)
  const previewStyle: React.CSSProperties = {
    fontSize: Math.max(5, p.fontSize * PREVIEW_SCALE * 1.4),
    color: p.color,
    [vertical]: m,
    ...(horizontal === 'center'
      ? { left: '50%', transform: 'translateX(-50%)' }
      : horizontal === 'left'
        ? { left: m }
        : { right: m })
  }

  return (
    <Dialog
      kind="page-numbers"
      title="Page numbers"
      onCancel={() => onClose(null)}
      onConfirm={confirm}
      confirmLabel={existing ? 'Update' : 'Add page numbers'}
      confirmDisabled={!!error}
      width={560}
      footerStart={
        existing ? (
          <button type="button" className="btn" data-testid="page-numbers-remove" onClick={remove}>
            Remove page numbers
          </button>
        ) : undefined
      }
    >
      <div className="dialog-with-preview">
        <div className="dialog-fields">
          <Field label="Format" htmlFor="pn-format" hint="{n} = page number, {total} = page count" error={error?.includes('{n}') ? error : null}>
            <select
              id="pn-format"
              className="select"
              data-testid="page-numbers-format"
              value={customFormat ? '__custom' : p.format}
              onChange={(e) => {
                if (e.target.value === '__custom') setCustomFormat(true)
                else {
                  setCustomFormat(false)
                  set({ format: e.target.value })
                }
              }}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {formatPageNumber(f, 1, Math.max(total, 1))}
                </option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
            {customFormat && (
              <input
                className="input"
                data-testid="page-numbers-custom"
                aria-label="Custom format"
                value={p.format}
                onChange={(e) => set({ format: e.target.value })}
              />
            )}
          </Field>
          <Field label="Position" htmlFor="pn-position">
            <select
              id="pn-position"
              className="select"
              data-testid="page-numbers-position"
              value={p.position}
              onChange={(e) => set({ position: e.target.value as PageNumberPosition })}
            >
              {POSITIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="field-row">
            <Field label="Font size" htmlFor="pn-size">
              <input
                id="pn-size"
                className="input"
                data-testid="page-numbers-size"
                type="number"
                min={4}
                max={144}
                value={Number.isFinite(p.fontSize) ? p.fontSize : ''}
                onChange={(e) => set({ fontSize: e.target.valueAsNumber })}
              />
            </Field>
            <Field label="Start at" htmlFor="pn-start">
              <input
                id="pn-start"
                className="input"
                data-testid="page-numbers-start"
                type="number"
                min={0}
                step={1}
                value={Number.isFinite(p.startAt) ? p.startAt : ''}
                onChange={(e) => set({ startAt: e.target.valueAsNumber })}
              />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Margin (pt)" htmlFor="pn-margin">
              <input
                id="pn-margin"
                className="input"
                data-testid="page-numbers-margin"
                type="number"
                min={0}
                max={200}
                value={Number.isFinite(p.margin) ? p.margin : ''}
                onChange={(e) => set({ margin: e.target.valueAsNumber })}
              />
            </Field>
            <Field label="Color" htmlFor="pn-color">
              <input
                id="pn-color"
                className="input"
                data-testid="page-numbers-color"
                type="color"
                value={p.color}
                onChange={(e) => set({ color: e.target.value })}
              />
            </Field>
          </div>
          {error && !error.includes('{n}') && <div className="field-error">{error}</div>}
        </div>
        <div className="page-preview" aria-label="Preview" role="img">
          <div className="page-preview-lines" />
          <div className="page-preview-number" style={previewStyle}>
            {formatPageNumber(p.format, Number.isFinite(p.startAt) ? p.startAt : 1, Math.max(total, 1))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
