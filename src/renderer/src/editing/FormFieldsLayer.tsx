/**
 * Form fields of a source page. pdf.js renders with ENABLE_FORMS, so most widgets are not
 * painted on the canvas: they are drawn here as HTML inputs (fill mode), as labelled boxes
 * (Prepare form mode) or as inert inputs (other tools). Laid out in page space.
 */
import { memo, useMemo, type CSSProperties } from 'react'
import {
  getFieldEdit,
  getFormValue,
  setFormValue,
  type Box,
  type EditorDocument,
  type FormValue,
  type PageEntry
} from '@core'
import { useEditor, type ElementRef } from '@renderer/state/store'
import { FIELD_TYPE_LABELS, FILLABLE_TYPES, widgetOnValue, widgetsOnPage, type WidgetEntry } from './fields'

export type FieldMode = 'fill' | 'design' | 'static'

export interface FieldInputProps {
  type: string
  /** Current (effective) field name. */
  name: string
  box: Box
  scale: number
  value: FormValue | undefined
  options?: string[]
  optionLabels?: string[]
  readOnly: boolean
  required?: boolean
  multiline?: boolean
  maxLength?: number
  /** Points; 0 or undefined = auto. */
  fontSize?: number
  /** Radio: value this widget stands for. Checkbox: on-value. */
  onValue?: string
  /** `name` attribute grouping radio inputs. */
  group: string
  /** pdf.js still paints this widget on the canvas: keep the input but make it invisible. */
  painted?: boolean
  interactive: boolean
  attrs?: Record<string, string>
  onChange(v: FormValue): void
}

function autoFontSize(box: Box, multiline: boolean): number {
  return multiline ? 11 : Math.min(12, Math.max(6, box.height * 0.6))
}

/** One HTML control for a form widget (existing field or FieldObject). */
export const FieldInput = memo(function FieldInput(p: FieldInputProps) {
  const { box, scale } = p
  const style: CSSProperties = {
    left: box.x * scale,
    top: box.y * scale,
    width: box.width * scale,
    height: box.height * scale
  }
  const common = {
    'data-testid': 'form-field',
    'data-field-name': p.name,
    'data-field-type': p.type,
    'data-overlay-control': '',
    'aria-label': p.name,
    disabled: p.readOnly,
    required: p.required,
    title: p.name,
    tabIndex: p.interactive ? undefined : -1,
    onPointerDown: (e: React.PointerEvent) => p.interactive && e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    ...p.attrs
  }
  const size = (multiline: boolean) => (p.fontSize && p.fontSize > 0 ? p.fontSize : autoFontSize(box, multiline)) * scale
  const labels = p.optionLabels && p.optionLabels.length === p.options?.length ? p.optionLabels : p.options
  switch (p.type) {
    case 'text': {
      const text = typeof p.value === 'string' ? p.value : ''
      const multiline = !!p.multiline
      const s = { ...style, fontSize: size(multiline), ...(multiline ? {} : { lineHeight: `${box.height * scale}px` }) }
      const painted = p.painted ? ' ed-field-painted' : ''
      return multiline ? (
        <textarea
          {...common}
          className={`ed-field ed-field-text ed-field-multiline${painted}`}
          style={s}
          value={text}
          maxLength={p.maxLength}
          onChange={(e) => p.onChange(e.target.value)}
        />
      ) : (
        <input
          {...common}
          className={`ed-field ed-field-text${painted}`}
          type="text"
          style={s}
          value={text}
          maxLength={p.maxLength}
          onChange={(e) => p.onChange(e.target.value)}
        />
      )
    }
    case 'checkbox':
      return (
        <input
          {...common}
          className="ed-field ed-field-check"
          type="checkbox"
          style={style}
          checked={p.value === true || (typeof p.value === 'string' && p.value !== '' && p.value !== 'Off')}
          onChange={(e) => p.onChange(e.target.checked)}
        />
      )
    case 'radio': {
      const on = p.onValue ?? ''
      return (
        <input
          {...common}
          className="ed-field ed-field-check ed-field-radio"
          type="radio"
          name={p.group}
          value={on}
          style={style}
          checked={p.value === on && on !== ''}
          onChange={(e) => {
            if (e.target.checked) p.onChange(on)
          }}
        />
      )
    }
    case 'dropdown': {
      const v = typeof p.value === 'string' ? p.value : ''
      const options = p.options ?? []
      return (
        <select
          {...common}
          className="ed-field ed-field-select"
          style={{ ...style, fontSize: size(false) }}
          value={v}
          onChange={(e) => p.onChange(e.target.value)}
        >
          {!options.includes(v) && <option value={v}>{v}</option>}
          {options.map((o, i) => (
            <option key={`${o}#${i}`} value={o}>
              {labels?.[i] ?? o}
            </option>
          ))}
        </select>
      )
    }
    case 'optionlist': {
      const v = Array.isArray(p.value) ? p.value : typeof p.value === 'string' && p.value ? [p.value] : []
      return (
        <select
          {...common}
          className="ed-field ed-field-select ed-field-list"
          multiple
          style={{ ...style, fontSize: (p.fontSize && p.fontSize > 0 ? p.fontSize : 10) * scale }}
          value={v}
          onChange={(e) => p.onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
        >
          {(p.options ?? []).map((o, i) => (
            <option key={`${o}#${i}`} value={o}>
              {labels?.[i] ?? o}
            </option>
          ))}
        </select>
      )
    }
    default:
      return null
  }
})

export interface FieldBoxProps {
  name: string
  type: string
  box: Box
  scale: number
  selected: boolean
  attrs: Record<string, string>
}

/** Labelled box shown for a widget in Prepare form mode. */
export function FieldBox({ name, type, box, scale, selected, attrs }: FieldBoxProps) {
  const w = box.width * scale
  const small = w < 48 || box.height * scale < 14
  return (
    <div
      className={`ed-field-box ed-field-box-${type}${small ? ' ed-field-box-small' : ''}`}
      data-selected={selected ? 'true' : 'false'}
      title={`${FIELD_TYPE_LABELS[type] ?? 'Field'}: ${name}`}
      style={{ left: box.x * scale, top: box.y * scale, width: w, height: box.height * scale }}
      {...attrs}
    >
      <span className="ed-field-box-label">{name}</span>
    </div>
  )
}

function currentValue(doc: EditorDocument, sourceId: string, name: string, fallback: FormValue): FormValue | undefined {
  try {
    return getFormValue(doc, sourceId, name)
  } catch {
    return doc.formValues[sourceId]?.[name] ?? fallback
  }
}

function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01
}

/** Box of every widget pdf.js paints on the canvas (checkboxes, radios, read-only text), keyed by field#index. */
function paintedWidgetBoxes(doc: EditorDocument, page: PageEntry): Map<string, Box> {
  const out = new Map<string, Box>()
  if (page.source.kind !== 'source') return out
  const { sourceId, pageIndex } = page.source
  for (const f of doc.sources[sourceId]?.formFields ?? []) {
    const painted = f.type === 'checkbox' || f.type === 'radio' || (f.type === 'text' && f.readOnly)
    if (!painted) continue
    const edit = getFieldEdit(doc, sourceId, f.name)
    if (edit?.deleted) continue
    f.widgets.forEach((w, i) => {
      if (w.pageIndex === pageIndex) out.set(`${f.name}#${i}`, edit?.widgetBoxes?.[i] ?? w.box)
    })
  }
  return out
}

/**
 * Where the canvas still paints widgets that were moved, resized or deleted since the page was
 * last rendered (`rendered` = the document as of that render). Covered until the re-render,
 * which draws them at their new place (the viewer renders such pages via renderPagePreview).
 */
export function staleWidgetMasks(doc: EditorDocument, rendered: EditorDocument, page: PageEntry): Box[] {
  if (page.source.kind !== 'source') return []
  const sourceId = page.source.sourceId
  if (doc.fieldEdits?.[sourceId] === rendered.fieldEdits?.[sourceId]) return []
  const before = paintedWidgetBoxes(rendered, page)
  const now = paintedWidgetBoxes(doc, page)
  const out: Box[] = []
  for (const [key, box] of before) {
    const cur = now.get(key)
    if (!cur || !sameBox(cur, box)) out.push(box)
  }
  return out
}

export function fieldRefOf(entry: WidgetEntry, pageId: string): ElementRef {
  return { kind: 'field', sourceId: entry.sourceId, fieldName: entry.field.originalName, widgetIndex: entry.index, pageId }
}

export function FormFieldsLayer({
  page,
  scale,
  mode,
  selected,
  boxOverride
}: {
  page: PageEntry
  scale: number
  mode: FieldMode
  /** Selected field widget (Prepare form). */
  selected?: ElementRef | null
  /** Live geometry of a widget being dragged: `${originalName}#${index}` → box. */
  boxOverride?: { key: string; box: Box } | null
}) {
  const doc = useEditor((s) => s.doc)
  const apply = useEditor((s) => s.apply)
  const sources = doc?.sources
  const fieldEdits = doc?.fieldEdits
  const entries = useMemo(
    () => (doc ? widgetsOnPage(doc, page, FILLABLE_TYPES) : []),
    [sources, fieldEdits, page] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const allEntries = useMemo(
    () => (doc && mode === 'design' ? widgetsOnPage(doc, page) : entries),
    [sources, fieldEdits, page, mode, entries] // eslint-disable-line react-hooks/exhaustive-deps
  )
  if (!doc || !allEntries.length) return null

  return (
    <div className="ed-forms" data-interactive={mode === 'fill' ? 'true' : 'false'} data-mode={mode}>
      {mode === 'design'
        ? allEntries.map((e) => {
            const key = `${e.field.originalName}#${e.index}`
            const isSel =
              selected?.kind === 'field' &&
              selected.sourceId === e.sourceId &&
              selected.fieldName === e.field.originalName &&
              selected.widgetIndex === e.index
            return (
              <FieldBox
                key={key}
                name={e.field.name}
                type={e.field.type}
                box={boxOverride?.key === key ? boxOverride.box : e.widget.box}
                scale={scale}
                selected={isSel}
                attrs={{
                  'data-testid': 'field-box',
                  'data-field-name': e.field.name,
                  'data-original-name': e.field.originalName,
                  'data-source-id': e.sourceId,
                  'data-widget-index': String(e.index),
                  'data-field-type': e.field.type
                }}
              />
            )
          })
        : entries.map((e) => (
            <FieldInput
              key={`${e.field.originalName}#${e.index}`}
              type={e.field.type}
              name={e.field.name}
              box={e.widget.box}
              scale={scale}
              value={currentValue(doc, e.sourceId, e.field.originalName, e.field.value)}
              options={e.field.options}
              optionLabels={e.field.optionLabels}
              readOnly={e.field.readOnly}
              required={e.field.required}
              multiline={e.field.multiline}
              maxLength={e.field.maxLength}
              fontSize={e.field.fontSize}
              onValue={widgetOnValue(doc, e)}
              group={`${e.sourceId}:${e.field.originalName}:${page.id}`}
              painted={e.field.type === 'text' && e.field.readOnly}
              interactive={mode === 'fill'}
              attrs={{ 'data-original-name': e.field.originalName, 'data-widget-index': String(e.index) }}
              onChange={(v) =>
                apply((d) => setFormValue(d, e.sourceId, e.field.originalName, v), {
                  coalesceKey: `form:${e.sourceId}:${e.field.originalName}`
                })
              }
            />
          ))}
    </div>
  )
}
