/** Small form controls used by the properties panel. */
import { useState, type ReactNode } from 'react'
import type { Color, FontFamily } from '@core'

export function toHex(c: string | null | undefined, fallback = '#000000'): string {
  if (!c) return fallback
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase()
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : fallback
}

export const fmt = (v: number) => String(Math.round(v * 100) / 100)

const FONT_LABELS: Record<FontFamily, string> = { sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' }

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ed-prop-row">
      <span className="ed-prop-label">{label}</span>
      <div className="ed-prop-control">{children}</div>
    </div>
  )
}

export function NumberInput(props: {
  value: number
  onChange(v: number): void
  testId: string
  label: string
  min?: number
  max?: number
  step?: number
  suffix?: string
}) {
  const { value, onChange, testId, label, min = -Infinity, max = Infinity, step = 1, suffix } = props
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <span className="ed-number">
      <input
        type="number"
        data-testid={testId}
        aria-label={label}
        value={draft ?? fmt(value)}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
        onBlur={() => setDraft(null)}
      />
      {suffix && <span className="ed-suffix">{suffix}</span>}
    </span>
  )
}

export function ColorInput(props: {
  value: Color | null | undefined
  onChange(v: Color | null): void
  testId: string
  label: string
  allowNone?: boolean
  fallback?: Color
}) {
  const { value, onChange, testId, label, allowNone, fallback = '#000000' } = props
  const [last, setLast] = useState(toHex(value, fallback))
  const none = value === null || value === undefined
  return (
    <span className="ed-color">
      <input
        type="color"
        data-testid={testId}
        aria-label={label}
        value={none ? last : toHex(value, fallback)}
        disabled={allowNone && none}
        onChange={(e) => {
          setLast(e.target.value)
          onChange(e.target.value)
        }}
      />
      {allowNone && (
        <label className="ed-none">
          <input type="checkbox" data-testid={`${testId}-none`} checked={none} onChange={(e) => onChange(e.target.checked ? null : last)} />
          None
        </label>
      )}
    </span>
  )
}

export function OpacityInput({ value, onChange, testId }: { value: number; onChange(v: number): void; testId: string }) {
  return (
    <span className="ed-range">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        data-testid={testId}
        aria-label="Opacity"
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="ed-suffix">{Math.round(value * 100)}%</span>
    </span>
  )
}

export function FontSelect({ value, onChange, testId }: { value: FontFamily; onChange(v: FontFamily): void; testId: string }) {
  return (
    <select data-testid={testId} aria-label="Font" value={value} onChange={(e) => onChange(e.target.value as FontFamily)}>
      {(Object.keys(FONT_LABELS) as FontFamily[]).map((f) => (
        <option key={f} value={f}>
          {FONT_LABELS[f]}
        </option>
      ))}
    </select>
  )
}

export function Toggle(props: { pressed: boolean; onChange(v: boolean): void; label: string; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`ed-toggle${props.pressed ? ' active' : ''}`}
      aria-pressed={props.pressed}
      aria-label={props.label}
      title={props.label}
      data-testid={props.testId}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.children}
    </button>
  )
}

export function CheckRow({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange(v: boolean): void; testId: string }) {
  return (
    <label className="ed-prop-check">
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/**
 * Text input that commits on Enter or blur (not on every keystroke); `validate` may reject the
 * value with a message (shown under the input; nothing is committed). Escape reverts.
 */
export function CommitInput(props: {
  value: string
  onCommit(v: string): void
  validate?(v: string): string | null
  testId: string
  label: string
  multiline?: boolean
  placeholder?: string
}) {
  const { value, onCommit, validate, testId, label, multiline, placeholder } = props
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    if (draft === value) {
      setDraft(null)
      setError(null)
      return
    }
    const err = validate?.(draft) ?? null
    setError(err)
    if (err) return
    onCommit(draft)
    setDraft(null)
  }
  const common = {
    'data-testid': testId,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    placeholder,
    value: draft ?? value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value)
      if (error) setError(null)
    },
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDraft(null)
        setError(null)
      }
    }
  }
  return (
    <span className="ed-commit">
      {multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
      {error && (
        <span className="ed-prop-error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </span>
      )}
    </span>
  )
}

/** One option per line; empty lines are ignored when committing. Commits on blur. */
export function OptionsEditor({ options, onCommit, testId }: { options: string[]; onCommit(v: string[]): void; testId: string }) {
  return (
    <CommitInput
      value={options.join('\n')}
      multiline
      testId={testId}
      label="Options (one per line)"
      placeholder="One option per line"
      validate={(v) => (v.split('\n').some((l) => l.trim()) ? null : 'Add at least one option.')}
      onCommit={(v) =>
        onCommit(
          v
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        )
      }
    />
  )
}
