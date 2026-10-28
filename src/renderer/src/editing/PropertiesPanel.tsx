import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Bold, BringToFront, Copy, Italic, SendToBack, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash } from 'lucide-react'
import { isBoxObject, reorderObject, type Color, type EditObject, type FontFamily } from '@core'
import { useEditor, type ToolId, type ToolOptions } from '@renderer/state/store'
import { useEditing } from './editingState'
import { deleteSelected, duplicateSelected, findObject, hasRotation, updateObjectFitted } from './objects'
import { normalizeAngle } from './manip'
import { TOOLS, toolHasOptions } from './tools'
import './PropertiesPanel.css'

const TYPE_LABELS: Record<EditObject['type'], string> = {
  text: 'Text',
  image: 'Image',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  highlight: 'Highlight',
  whiteout: 'Whiteout',
  line: 'Line',
  ink: 'Drawing',
  note: 'Sticky note'
}

const FONT_LABELS: Record<FontFamily, string> = { sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' }

function toHex(c: string | null | undefined, fallback = '#000000'): string {
  if (!c) return fallback
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase()
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : fallback
}

const fmt = (v: number) => String(Math.round(v * 100) / 100)

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ed-prop-row">
      <span className="ed-prop-label">{label}</span>
      <div className="ed-prop-control">{children}</div>
    </div>
  )
}

function NumberInput(props: {
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

function ColorInput(props: {
  value: Color | null
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
          <input
            type="checkbox"
            data-testid={`${testId}-none`}
            checked={none}
            onChange={(e) => onChange(e.target.checked ? null : last)}
          />
          None
        </label>
      )}
    </span>
  )
}

function OpacityInput({ value, onChange, testId }: { value: number; onChange(v: number): void; testId: string }) {
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

function FontSelect({ value, onChange, testId }: { value: FontFamily; onChange(v: FontFamily): void; testId: string }) {
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

function Toggle(props: { pressed: boolean; onChange(v: boolean): void; label: string; testId: string; children: ReactNode }) {
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

type Setter = (field: string, value: unknown) => void

function TextStyleRows(props: {
  font: FontFamily
  fontSize: number
  bold: boolean
  italic: boolean
  color: Color
  set: Setter
}) {
  const { set } = props
  return (
    <>
      <Row label="Font">
        <FontSelect value={props.font} onChange={(v) => set('font', v)} testId="prop-font" />
      </Row>
      <Row label="Size">
        <NumberInput value={props.fontSize} onChange={(v) => set('fontSize', v)} testId="prop-fontSize" label="Font size" min={1} max={500} step={1} suffix="pt" />
      </Row>
      <Row label="Style">
        <Toggle pressed={props.bold} onChange={(v) => set('bold', v)} label="Bold" testId="prop-bold">
          <Bold size={15} aria-hidden="true" />
        </Toggle>
        <Toggle pressed={props.italic} onChange={(v) => set('italic', v)} label="Italic" testId="prop-italic">
          <Italic size={15} aria-hidden="true" />
        </Toggle>
      </Row>
      <Row label="Color">
        <ColorInput value={props.color} onChange={(v) => set('color', v)} testId="prop-color" label="Text color" />
      </Row>
    </>
  )
}

function ObjectProperties({ obj }: { obj: EditObject }) {
  const apply = useEditor((s) => s.apply)
  const set: Setter = (field, value) =>
    apply((d) => updateObjectFitted(d, obj.id, { [field]: value } as Partial<EditObject>), {
      coalesceKey: `prop:${obj.id}:${field}`
    })

  let rows: ReactNode = null
  switch (obj.type) {
    case 'text':
      rows = (
        <>
          <TextStyleRows font={obj.font} fontSize={obj.fontSize} bold={obj.bold} italic={obj.italic} color={obj.color} set={set} />
          <Row label="Align">
            {(['left', 'center', 'right'] as const).map((a) => {
              const Icon = a === 'left' ? TextAlignStart : a === 'center' ? TextAlignCenter : TextAlignEnd
              return (
                <Toggle key={a} pressed={obj.align === a} onChange={() => set('align', a)} label={`Align ${a}`} testId={`prop-align-${a}`}>
                  <Icon size={15} aria-hidden="true" />
                </Toggle>
              )
            })}
          </Row>
          <Row label="Line height">
            <NumberInput value={obj.lineHeight} onChange={(v) => set('lineHeight', v)} testId="prop-lineHeight" label="Line height" min={0.5} max={5} step={0.1} />
          </Row>
          <Row label="Background">
            <ColorInput value={obj.background ?? null} onChange={(v) => set('background', v)} testId="prop-background" label="Background color" allowNone fallback="#ffffff" />
          </Row>
          <Row label="Opacity">
            <OpacityInput value={obj.opacity ?? 1} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
      break
    case 'rect':
    case 'ellipse':
      rows = (
        <>
          <Row label="Stroke">
            <ColorInput value={obj.strokeColor} onChange={(v) => set('strokeColor', v)} testId="prop-strokeColor" label="Stroke color" allowNone />
          </Row>
          <Row label="Fill">
            <ColorInput value={obj.fillColor} onChange={(v) => set('fillColor', v)} testId="prop-fillColor" label="Fill color" allowNone fallback="#ffffff" />
          </Row>
          <Row label="Width">
            <NumberInput value={obj.strokeWidth} onChange={(v) => set('strokeWidth', v)} testId="prop-strokeWidth" label="Stroke width" min={0} max={100} step={0.5} suffix="pt" />
          </Row>
          <Row label="Opacity">
            <OpacityInput value={obj.opacity ?? 1} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
      break
    case 'line':
      rows = (
        <>
          <Row label="Color">
            <ColorInput value={obj.color} onChange={(v) => set('color', v)} testId="prop-color" label="Line color" />
          </Row>
          <Row label="Width">
            <NumberInput value={obj.strokeWidth} onChange={(v) => set('strokeWidth', v)} testId="prop-strokeWidth" label="Line width" min={0.25} max={100} step={0.5} suffix="pt" />
          </Row>
          <Row label="Arrow">
            <Toggle pressed={obj.arrowEnd} onChange={(v) => set('arrowEnd', v)} label="Arrow head" testId="prop-arrowEnd">
              <ArrowUpRight size={15} aria-hidden="true" />
            </Toggle>
          </Row>
          <Row label="Opacity">
            <OpacityInput value={obj.opacity ?? 1} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
      break
    case 'ink':
      rows = (
        <>
          <Row label="Color">
            <ColorInput value={obj.color} onChange={(v) => set('color', v)} testId="prop-color" label="Ink color" />
          </Row>
          <Row label="Width">
            <NumberInput value={obj.strokeWidth} onChange={(v) => set('strokeWidth', v)} testId="prop-strokeWidth" label="Stroke width" min={0.25} max={100} step={0.5} suffix="pt" />
          </Row>
          <Row label="Opacity">
            <OpacityInput value={obj.opacity ?? 1} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
      break
    case 'highlight':
      rows = (
        <>
          <Row label="Color">
            <ColorInput value={obj.color} onChange={(v) => set('color', v)} testId="prop-color" label="Highlight color" />
          </Row>
          <Row label="Opacity">
            <OpacityInput value={obj.opacity ?? 0.4} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
      break
    case 'whiteout':
      rows = (
        <>
          <Row label="Color">
            <ColorInput value={obj.color} onChange={(v) => set('color', v)} testId="prop-color" label="Cover color" fallback="#ffffff" />
          </Row>
          <p className="ed-prop-hint">Covers content visually; the original stays in the file.</p>
        </>
      )
      break
    case 'image':
      rows = (
        <Row label="Opacity">
          <OpacityInput value={obj.opacity ?? 1} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
        </Row>
      )
      break
    case 'note':
      rows = (
        <>
          <div className="ed-prop-col">
            <span className="ed-prop-label">Comment</span>
            <textarea data-testid="prop-text" aria-label="Note text" rows={4} value={obj.text} onChange={(e) => set('text', e.target.value)} />
          </div>
          <Row label="Author">
            <input data-testid="prop-author" aria-label="Author" value={obj.author ?? ''} onChange={(e) => set('author', e.target.value)} />
          </Row>
          <Row label="Color">
            <ColorInput value={obj.color} onChange={(v) => set('color', v)} testId="prop-color" label="Note color" />
          </Row>
        </>
      )
      break
  }

  return (
    <>
      {rows}
      {isBoxObject(obj) && (
        <>
          {hasRotation(obj) && (
            <Row label="Rotation">
              <NumberInput
                value={obj.rotation ?? 0}
                onChange={(v) => set('rotation', normalizeAngle(v))}
                testId="prop-rotation"
                label="Rotation"
                min={-360}
                max={360}
                step={1}
                suffix="°"
              />
            </Row>
          )}
          <div className="ed-prop-grid">
            {(['x', 'y', 'width', 'height'] as const).map((f) => (
              <label key={f}>
                <span className="ed-prop-label">{f === 'width' ? 'W' : f === 'height' ? 'H' : f.toUpperCase()}</span>
                <NumberInput
                  value={obj[f]}
                  onChange={(v) => set(f, v)}
                  testId={`prop-${f}`}
                  label={f}
                  min={f === 'width' || f === 'height' ? 1 : -10000}
                  step={1}
                />
              </label>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function ToolDefaults({ tool, options }: { tool: ToolId; options: ToolOptions }) {
  const setToolOptions = useEditor((s) => s.setToolOptions)
  const set: Setter = (field, value) => setToolOptions({ [field]: value } as Partial<ToolOptions>)
  switch (tool) {
    case 'text':
      return <TextStyleRows font={options.font} fontSize={options.fontSize} bold={options.bold} italic={options.italic} color={options.color} set={set} />
    case 'rect':
    case 'ellipse':
      return (
        <>
          <Row label="Stroke">
            <ColorInput value={options.color} onChange={(v) => v && set('color', v)} testId="prop-color" label="Stroke color" />
          </Row>
          <Row label="Fill">
            <ColorInput value={options.fillColor} onChange={(v) => set('fillColor', v)} testId="prop-fillColor" label="Fill color" allowNone fallback="#ffffff" />
          </Row>
          <Row label="Width">
            <NumberInput value={options.strokeWidth} onChange={(v) => set('strokeWidth', v)} testId="prop-strokeWidth" label="Stroke width" min={0} max={100} step={0.5} suffix="pt" />
          </Row>
          <Row label="Opacity">
            <OpacityInput value={options.opacity} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
    case 'line':
    case 'arrow':
    case 'ink':
      return (
        <>
          <Row label="Color">
            <ColorInput value={options.color} onChange={(v) => v && set('color', v)} testId="prop-color" label="Color" />
          </Row>
          <Row label="Width">
            <NumberInput value={options.strokeWidth} onChange={(v) => set('strokeWidth', v)} testId="prop-strokeWidth" label="Stroke width" min={0.25} max={100} step={0.5} suffix="pt" />
          </Row>
          <Row label="Opacity">
            <OpacityInput value={options.opacity} onChange={(v) => set('opacity', v)} testId="prop-opacity" />
          </Row>
        </>
      )
    case 'highlight':
      return (
        <Row label="Color">
          <ColorInput value={options.highlightColor} onChange={(v) => v && set('highlightColor', v)} testId="prop-highlightColor" label="Highlight color" />
        </Row>
      )
    default:
      return null
  }
}

/** Right-hand panel with properties of the selected object (or the active tool's options). */
export function PropertiesPanel() {
  const doc = useEditor((s) => s.doc)
  const selectedId = useEditor((s) => s.selectedObjectId)
  const tool = useEditor((s) => s.tool)
  const options = useEditor((s) => s.toolOptions)
  const apply = useEditor((s) => s.apply)
  const obj = findObject(doc, selectedId)

  if (!obj) {
    if (!doc || !toolHasOptions(tool)) return null
    const label = TOOLS.find((t) => t.id === tool)?.label ?? tool
    return (
      <aside className="ed-props" data-testid="properties-panel" data-mode="tool" aria-label={`${label} options`}>
        <h3 className="ed-props-title">{label}</h3>
        <p className="ed-prop-hint">Defaults for new objects</p>
        <ToolDefaults tool={tool} options={options} />
      </aside>
    )
  }

  return (
    <aside className="ed-props" data-testid="properties-panel" data-mode="object" data-object-type={obj.type} aria-label="Object properties">
      <h3 className="ed-props-title">{TYPE_LABELS[obj.type]}</h3>
      <ObjectProperties key={obj.id} obj={obj} />
      <div className="ed-prop-actions">
        <button type="button" className="ed-action" data-testid="prop-front" title="Bring to front" aria-label="Bring to front" onClick={() => apply((d) => reorderObject(d, obj.id, 'front'))}>
          <BringToFront size={16} aria-hidden="true" />
        </button>
        <button type="button" className="ed-action" data-testid="prop-back" title="Send to back" aria-label="Send to back" onClick={() => apply((d) => reorderObject(d, obj.id, 'back'))}>
          <SendToBack size={16} aria-hidden="true" />
        </button>
        <button type="button" className="ed-action" data-testid="prop-duplicate" title="Duplicate (Ctrl/Cmd+D)" aria-label="Duplicate" onClick={() => duplicateSelected()}>
          <Copy size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ed-action ed-action-danger"
          data-testid="prop-delete"
          title="Delete (Del)"
          aria-label="Delete"
          onClick={() => {
            useEditing.getState().stopTextEdit(obj.id)
            deleteSelected()
          }}
        >
          <Trash size={16} aria-hidden="true" />
        </button>
      </div>
    </aside>
  )
}
