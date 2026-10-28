import { useState } from 'react'
import { updateSettings, type WatermarkSettings } from '@core'
import { applyEdit } from '@renderer/actions/util'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'

export const DEFAULT_WATERMARK: WatermarkSettings = {
  text: 'CONFIDENTIAL',
  fontSize: 64,
  color: '#9ca3af',
  opacity: 0.35,
  angle: 45
}

/** Preview page width in CSS px, relative to an A4 page. */
const PREVIEW_SCALE = 150 / 595.28

export function validateWatermark(w: WatermarkSettings): string | null {
  if (!w.text.trim()) return 'Enter the watermark text.'
  if (!(w.fontSize >= 6 && w.fontSize <= 400)) return 'Font size must be between 6 and 400.'
  if (!(w.opacity > 0 && w.opacity <= 1)) return 'Opacity must be between 1% and 100%.'
  if (!(w.angle >= -180 && w.angle <= 180)) return 'Angle must be between -180° and 180°.'
  return null
}

export function WatermarkDialog({ onClose }: { onClose: (applied: boolean | null) => void }) {
  const existing = useEditor((s) => s.doc?.settings.watermark ?? null)
  const [w, setW] = useState<WatermarkSettings>(existing ?? DEFAULT_WATERMARK)
  const [touched, setTouched] = useState(false)
  const error = validateWatermark(w)
  const set = (patch: Partial<WatermarkSettings>) => {
    setTouched(true)
    setW((v) => ({ ...v, ...patch }))
  }

  const confirm = () => {
    if (error) return
    const watermark: WatermarkSettings = { ...w, text: w.text.trim() }
    if (applyEdit('Watermark', (d) => updateSettings(d, { watermark }))) onClose(true)
  }

  const remove = () => {
    if (applyEdit('Remove watermark', (d) => updateSettings(d, { watermark: null }))) onClose(true)
  }

  return (
    <Dialog
      kind="watermark"
      title={existing ? 'Edit watermark' : 'Add watermark'}
      onCancel={() => onClose(null)}
      onConfirm={confirm}
      confirmLabel={existing ? 'Update' : 'Add watermark'}
      confirmDisabled={!!error}
      width={560}
      footerStart={
        existing ? (
          <button type="button" className="btn" data-testid="watermark-remove" onClick={remove}>
            Remove watermark
          </button>
        ) : undefined
      }
    >
      <div className="dialog-with-preview">
        <div className="dialog-fields">
          <Field label="Text" htmlFor="wm-text" error={touched && !w.text.trim() ? 'Enter the watermark text.' : null}>
            <input
              id="wm-text"
              className="input"
              data-testid="watermark-text"
              value={w.text}
              onChange={(e) => set({ text: e.target.value })}
            />
          </Field>
          <div className="field-row">
            <Field label="Font size" htmlFor="wm-size">
              <input
                id="wm-size"
                className="input"
                data-testid="watermark-size"
                type="number"
                min={6}
                max={400}
                value={Number.isFinite(w.fontSize) ? w.fontSize : ''}
                onChange={(e) => set({ fontSize: e.target.valueAsNumber })}
              />
            </Field>
            <Field label="Color" htmlFor="wm-color">
              <input
                id="wm-color"
                className="input"
                data-testid="watermark-color"
                type="color"
                value={w.color}
                onChange={(e) => set({ color: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Opacity" htmlFor="wm-opacity">
            <div className="control-row">
              <input
                id="wm-opacity"
                data-testid="watermark-opacity"
                type="range"
                min={5}
                max={100}
                step={5}
                value={Math.round(w.opacity * 100)}
                onChange={(e) => set({ opacity: e.target.valueAsNumber / 100 })}
                style={{ flex: 1 }}
              />
              <span className="range-value">{Math.round(w.opacity * 100)}%</span>
            </div>
          </Field>
          <Field label="Angle" htmlFor="wm-angle">
            <div className="control-row">
              <input
                id="wm-angle"
                data-testid="watermark-angle"
                type="range"
                min={-90}
                max={90}
                step={5}
                value={w.angle}
                onChange={(e) => set({ angle: e.target.valueAsNumber })}
                style={{ flex: 1 }}
              />
              <span className="range-value">{w.angle}°</span>
            </div>
          </Field>
          {error && touched && w.text.trim() && <div className="field-error">{error}</div>}
        </div>
        <div className="page-preview" aria-label="Preview" role="img">
          <div className="page-preview-lines" />
          <div
            className="page-preview-watermark"
            style={{
              fontSize: Math.max(4, (w.fontSize || 0) * PREVIEW_SCALE),
              color: w.color,
              opacity: w.opacity,
              transform: `translate(-50%, -50%) rotate(${-w.angle}deg)`
            }}
          >
            {w.text}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
