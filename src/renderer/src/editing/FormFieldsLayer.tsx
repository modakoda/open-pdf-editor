/**
 * HTML inputs for the AcroForm widgets of a source page (pdf.js renders with ENABLE_FORMS, so
 * widgets are not painted on the canvas). Laid out in page space inside a transformed layer.
 */
import { memo, useMemo, type CSSProperties } from 'react'
import {
  getFormValue,
  setFormValue,
  type EditorDocument,
  type FormFieldInfo,
  type FormFieldWidget,
  type FormValue,
  type PageEntry
} from '@core'
import { useEditor } from '@renderer/state/store'

interface WidgetEntry {
  field: FormFieldInfo
  widget: FormFieldWidget
  /** Index of this widget among the field's widgets. */
  index: number
}

const SUPPORTED = new Set(['text', 'checkbox', 'radio', 'dropdown', 'optionlist'])

export function widgetsForPage(doc: EditorDocument, page: PageEntry): { sourceId: string; entries: WidgetEntry[] } | null {
  if (page.source.kind !== 'source') return null
  const { sourceId, pageIndex } = page.source
  const source = doc.sources[sourceId]
  if (!source?.formFields?.length) return null
  const entries: WidgetEntry[] = []
  for (const field of source.formFields) {
    if (!SUPPORTED.has(field.type)) continue
    field.widgets.forEach((widget, index) => {
      if (widget.pageIndex === pageIndex) entries.push({ field, widget, index })
    })
  }
  return entries.length ? { sourceId, entries } : null
}

function currentValue(doc: EditorDocument, sourceId: string, field: FormFieldInfo): FormValue | undefined {
  try {
    return getFormValue(doc, sourceId, field.name)
  } catch {
    return doc.formValues[sourceId]?.[field.name] ?? field.value
  }
}

function radioValue(entry: WidgetEntry): string {
  return entry.widget.onValue ?? entry.field.options?.[entry.index] ?? String(entry.index)
}

function textFontSize(box: { height: number }, multiline: boolean): number {
  return multiline ? 11 : Math.min(12, Math.max(6, box.height * 0.6))
}

interface FieldProps {
  entry: WidgetEntry
  sourceId: string
  pageId: string
  value: FormValue | undefined
  scale: number
}

const FormField = memo(function FormField({ entry, sourceId, pageId, value, scale }: FieldProps) {
  const { field, widget } = entry
  const apply = useEditor((s) => s.apply)
  const set = (v: FormValue) =>
    apply((d) => setFormValue(d, sourceId, field.name, v), { coalesceKey: `form:${sourceId}:${field.name}` })
  const box = widget.box
  const style: CSSProperties = {
    left: box.x * scale,
    top: box.y * scale,
    width: box.width * scale,
    height: box.height * scale
  }
  const common = {
    'data-testid': 'form-field',
    'data-field-name': field.name,
    'data-field-type': field.type,
    'data-overlay-control': '',
    'aria-label': field.name,
    disabled: field.readOnly,
    required: field.required,
    title: field.name,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation()
  }
  switch (field.type) {
    case 'text': {
      const text = typeof value === 'string' ? value : ''
      const multiline = !!field.multiline
      const fontSize = textFontSize(box, multiline) * scale
      const s = { ...style, fontSize, ...(multiline ? {} : { lineHeight: `${box.height * scale}px` }) }
      // pdf.js still paints read-only text widgets on the canvas (ENABLE_FORMS), so the input
      // is kept for accessibility but made invisible to avoid showing the value twice.
      const painted = field.readOnly ? ' ed-field-painted' : ''
      return multiline ? (
        <textarea
          {...common}
          className={`ed-field ed-field-text ed-field-multiline${painted}`}
          style={s}
          value={text}
          maxLength={field.maxLength}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          {...common}
          className={`ed-field ed-field-text${painted}`}
          type="text"
          style={s}
          value={text}
          maxLength={field.maxLength}
          onChange={(e) => set(e.target.value)}
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
          checked={value === true || (typeof value === 'string' && value !== '' && value !== 'Off')}
          onChange={(e) => set(e.target.checked)}
        />
      )
    case 'radio': {
      const on = radioValue(entry)
      return (
        <input
          {...common}
          className="ed-field ed-field-check ed-field-radio"
          type="radio"
          name={`${sourceId}:${field.name}:${pageId}`}
          value={on}
          style={style}
          checked={value === on}
          onChange={(e) => {
            if (e.target.checked) set(on)
          }}
        />
      )
    }
    case 'dropdown': {
      const v = typeof value === 'string' ? value : ''
      const options = field.options ?? []
      const fontSize = textFontSize(box, false) * scale
      return (
        <select
          {...common}
          className="ed-field ed-field-select"
          style={{ ...style, fontSize }}
          value={v}
          onChange={(e) => set(e.target.value)}
        >
          {!options.includes(v) && <option value={v}>{v}</option>}
          {options.map((o, i) => (
            <option key={o} value={o}>
              {field.optionLabels?.[i] ?? o}
            </option>
          ))}
        </select>
      )
    }
    case 'optionlist': {
      const v = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
      return (
        <select
          {...common}
          className="ed-field ed-field-select ed-field-list"
          multiple
          style={{ ...style, fontSize: 10 * scale }}
          value={v}
          onChange={(e) => set(Array.from(e.target.selectedOptions, (o) => o.value))}
        >
          {(field.options ?? []).map((o, i) => (
            <option key={o} value={o}>
              {field.optionLabels?.[i] ?? o}
            </option>
          ))}
        </select>
      )
    }
    default:
      return null
  }
})

export function FormFieldsLayer({ page, scale, interactive }: { page: PageEntry; scale: number; interactive: boolean }) {
  const doc = useEditor((s) => s.doc)
  const sources = doc?.sources
  const info = useMemo(() => (doc ? widgetsForPage(doc, page) : null), [sources, page]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc || !info) return null
  return (
    <div className="ed-forms" data-interactive={interactive ? 'true' : 'false'}>
      {info.entries.map((entry) => (
        <FormField
          key={`${entry.field.name}#${entry.index}`}
          entry={entry}
          sourceId={info.sourceId}
          pageId={page.id}
          value={currentValue(doc, info.sourceId, entry.field)}
          scale={scale}
        />
      ))}
    </div>
  )
}
