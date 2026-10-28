/** Properties panel sections for existing elements (content, annotations, form fields) and FieldObjects. */
import { RotateCcw, Trash } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  editAnnotation,
  editField,
  getFieldEdit,
  updateObject,
  type Box,
  type EditorDocument,
  type FieldObject
} from '@core'
import { useEditor, type ElementRef } from '@renderer/state/store'
import { boundsOfPoints, placedQuad } from './elementGeometry'
import { boxChange, CONTENT_KIND_LABELS, editContent, hasEdit, resetElement, type ElementGeom } from './elements'
import { FIELD_TYPE_LABELS, fieldObjects, validateFieldName, widgetOnValue } from './fields'
import { ensureElementPreview } from './previews'
import { measureContentText } from './textLayout'
import { CheckRow, ColorInput, CommitInput, NumberInput, OptionsEditor, Row } from './propControls'
import { changeElement, deleteSelection } from './selection'

function BoxGrid({ box, onChange, testPrefix = 'prop' }: { box: Box; onChange(b: Box): void; testPrefix?: string }) {
  return (
    <div className="ed-prop-grid">
      {(['x', 'y', 'width', 'height'] as const).map((f) => (
        <label key={f}>
          <span className="ed-prop-label">{f === 'width' ? 'W' : f === 'height' ? 'H' : f.toUpperCase()}</span>
          <NumberInput
            value={box[f]}
            onChange={(v) => onChange({ ...box, [f]: v })}
            testId={`${testPrefix}-${f}`}
            label={f}
            min={f === 'width' || f === 'height' ? 1 : -10000}
          />
        </label>
      ))}
    </div>
  )
}

function ElementActions({ refEl, canReset }: { refEl: ElementRef; canReset: boolean }) {
  const apply = useEditor((s) => s.apply)
  return (
    <div className="ed-prop-actions">
      <button
        type="button"
        className="ed-action ed-action-wide"
        data-testid="prop-reset"
        title="Undo all changes to this element"
        disabled={!canReset}
        onClick={() => {
          ensureElementPreview(refEl)
          apply((d) => resetElement(d, refEl))
        }}
      >
        <RotateCcw size={15} aria-hidden="true" /> Reset
      </button>
      <button
        type="button"
        className="ed-action ed-action-danger"
        data-testid="prop-delete"
        title="Delete (Del)"
        aria-label="Delete"
        onClick={() => deleteSelection()}
      >
        <Trash size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

function Panel({ title, kind, children }: { title: string; kind: string; children: ReactNode }) {
  return (
    <aside className="ed-props" data-testid="properties-panel" data-mode="element" data-element-kind={kind} aria-label={`${title} properties`}>
      <h3 className="ed-props-title">{title}</h3>
      {children}
    </aside>
  )
}

export function ContentProperties({ refEl, geom }: { refEl: ElementRef & { kind: 'content' }; geom: ElementGeom & { kind: 'content' } }) {
  const apply = useEditor((s) => s.apply)
  const { item, edit } = geom
  const key = `content:${refEl.pageId}:${refEl.itemId}`
  const set = (patch: Parameters<typeof editContent>[3], field: string, coalesce = true) => {
    ensureElementPreview(refEl)
    apply((d) => editContent(d, refEl.pageId, refEl.itemId, patch), coalesce ? { coalesceKey: `${key}:${field}` } : undefined)
  }
  const bounds = boundsOfPoints(placedQuad(item, geom.transform, edit, measureContentText))
  return (
    <Panel title={CONTENT_KIND_LABELS[item.kind]} kind="content">
      {item.kind === 'text' && (
        <>
          <div className="ed-prop-col">
            <span className="ed-prop-label">Text</span>
            <CommitInput value={edit?.text ?? item.text ?? ''} testId="prop-content-text" label="Text" onCommit={(text) => set({ text }, 'text', false)} />
          </div>
          {item.editableInPlace === false && (
            <p className="ed-prop-hint" data-testid="prop-font-fallback">
              New text cannot use the original font: a similar font will be used.
            </p>
          )}
          <Row label="Size">
            <NumberInput
              value={edit?.fontSize ?? item.fontSize ?? 12}
              onChange={(v) => set({ fontSize: v }, 'fontSize')}
              testId="prop-content-fontSize"
              label="Font size"
              min={1}
              max={500}
              suffix="pt"
            />
          </Row>
          <Row label="Color">
            <ColorInput value={edit?.color ?? item.color ?? '#000000'} onChange={(v) => v && set({ color: v }, 'color')} testId="prop-content-color" label="Text color" />
          </Row>
        </>
      )}
      {item.kind === 'path' && (
        <Row label="Fill">
          <ColorInput value={edit?.color ?? item.color ?? '#000000'} onChange={(v) => v && set({ color: v }, 'color')} testId="prop-content-color" label="Fill color" />
        </Row>
      )}
      <BoxGrid box={bounds} onChange={(b) => changeElement(refEl, (g) => boxChange(g, b), `${key}:box`)} />
      <ElementActions refEl={refEl} canReset={!!edit} />
    </Panel>
  )
}

export function AnnotationProperties({ doc, refEl, geom }: { doc: EditorDocument; refEl: ElementRef & { kind: 'annotation' }; geom: ElementGeom & { kind: 'annotation' } }) {
  const apply = useEditor((s) => s.apply)
  const a = geom.annot
  const key = `annot:${refEl.pageId}:${refEl.annotId}`
  const set = (patch: Parameters<typeof editAnnotation>[3], field: string) =>
    apply((d) => editAnnotation(d, refEl.pageId, refEl.annotId, patch), { coalesceKey: `${key}:${field}` })
  const isLink = a.subtype === 'Link'
  return (
    <Panel title={`${a.subtype} annotation`} kind="annotation">
      {!isLink && (
        <>
          <div className="ed-prop-col">
            <span className="ed-prop-label">Contents</span>
            <textarea data-testid="prop-annot-contents" aria-label="Contents" rows={3} value={a.contents ?? ''} onChange={(e) => set({ contents: e.target.value }, 'contents')} />
          </div>
          <Row label="Author">
            <input data-testid="prop-annot-author" aria-label="Author" value={a.author ?? ''} onChange={(e) => set({ author: e.target.value }, 'author')} />
          </Row>
        </>
      )}
      {isLink && (
        <Row label="Link">
          <input data-testid="prop-annot-uri" aria-label="Link address" placeholder="https://…" value={a.uri ?? ''} onChange={(e) => set({ uri: e.target.value }, 'uri')} />
        </Row>
      )}
      {!isLink && (
        <Row label="Color">
          <ColorInput
            value={a.color ?? '#facc15'}
            onChange={(v) => {
              if (!v) return
              ensureElementPreview(refEl)
              set({ color: v }, 'color')
            }}
            testId="prop-annot-color"
            label="Color"
          />
        </Row>
      )}
      <BoxGrid box={geom.box} onChange={(b) => changeElement(refEl, () => ({ box: b }), `${key}:box`)} />
      <ElementActions refEl={refEl} canReset={hasEdit(doc, refEl)} />
    </Panel>
  )
}

export function FieldProperties({ doc, refEl, geom }: { doc: EditorDocument; refEl: ElementRef & { kind: 'field' }; geom: ElementGeom & { kind: 'field' } }) {
  const apply = useEditor((s) => s.apply)
  const { field } = geom.entry
  const key = `field:${refEl.sourceId}:${refEl.fieldName}`
  const set = (patch: Parameters<typeof editField>[3], prop: string, coalesce = true) =>
    apply((d) => editField(d, refEl.sourceId, refEl.fieldName, patch), coalesce ? { coalesceKey: `${key}:${prop}` } : undefined)
  const t = field.type
  return (
    <Panel title={FIELD_TYPE_LABELS[t] ?? 'Field'} kind="field">
      <div className="ed-prop-col">
        <span className="ed-prop-label">Name</span>
        <CommitInput
          value={field.name}
          testId="prop-field-name"
          label="Field name"
          validate={(v) => validateFieldName(doc, v, { kind: 'field', sourceId: refEl.sourceId, originalName: refEl.fieldName })}
          onCommit={(v) => set({ name: v.trim() === refEl.fieldName ? undefined : v.trim() }, 'name', false)}
        />
      </div>
      <div className="ed-prop-checks">
        <CheckRow label="Required" checked={!!field.required} onChange={(v) => set({ required: v }, 'required')} testId="prop-field-required" />
        <CheckRow label="Read-only" checked={field.readOnly} onChange={(v) => set({ readOnly: v }, 'readOnly')} testId="prop-field-readOnly" />
        {t === 'text' && (
          <CheckRow label="Multi-line" checked={!!field.multiline} onChange={(v) => set({ multiline: v }, 'multiline')} testId="prop-field-multiline" />
        )}
      </div>
      {t === 'text' && (
        <Row label="Max length">
          <input
            type="number"
            min={0}
            data-testid="prop-field-maxLength"
            aria-label="Maximum length"
            placeholder="none"
            value={field.maxLength ?? ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              set({ maxLength: e.target.value === '' || !(n > 0) ? null : n }, 'maxLength')
            }}
          />
        </Row>
      )}
      {(t === 'text' || t === 'dropdown' || t === 'optionlist') && (
        <Row label="Font size">
          <NumberInput value={field.fontSize ?? 0} onChange={(v) => set({ fontSize: v }, 'fontSize')} testId="prop-field-fontSize" label="Font size (0 = auto)" min={0} max={200} suffix="pt" />
        </Row>
      )}
      {(t === 'dropdown' || t === 'optionlist') && (
        <div className="ed-prop-col">
          <span className="ed-prop-label">Options</span>
          <OptionsEditor options={field.options ?? []} testId="prop-field-options" onCommit={(options) => set({ options, optionLabels: null }, 'options', false)} />
        </div>
      )}
      {t === 'radio' && (
        <div className="ed-prop-col">
          <span className="ed-prop-label">Export value of this button</span>
          <CommitInput
            value={widgetOnValue(doc, geom.entry)}
            testId="prop-field-exportValue"
            label="Export value"
            validate={(v) => (v.trim() ? null : 'The export value cannot be empty.')}
            onCommit={(v) => {
              const current = getFieldEdit(doc, refEl.sourceId, refEl.fieldName)?.options
              const values = field.widgets.map((w, i) => current?.[i] ?? w.onValue ?? field.options?.[i] ?? String(i))
              values[geom.entry.index] = v.trim()
              set({ options: values }, 'options', false)
            }}
          />
        </div>
      )}
      <BoxGrid box={geom.box} onChange={(b) => changeElement(refEl, () => ({ box: b }), `${key}:box`)} />
      <ElementActions refEl={refEl} canReset={hasEdit(doc, refEl)} />
    </Panel>
  )
}

/** Name, behaviour and choices of a new field placed by the user. */
export function FieldObjectRows({ doc, obj }: { doc: EditorDocument; obj: FieldObject }) {
  const apply = useEditor((s) => s.apply)
  const set = (patch: Partial<FieldObject>, prop: string, coalesce = true) =>
    apply((d) => updateObject(d, obj.id, patch), coalesce ? { coalesceKey: `prop:${obj.id}:${prop}` } : undefined)
  const t = obj.fieldType
  const rename = (name: string) =>
    apply((d) => {
      // Renaming a radio button renames its whole group.
      if (t !== 'radio') return updateObject(d, obj.id, { name })
      return fieldObjects(d)
        .filter((o) => o.fieldType === 'radio' && o.name === obj.name)
        .reduce((acc, o) => updateObject(acc, o.id, { name }), d)
    })
  return (
    <>
      <div className="ed-prop-col">
        <span className="ed-prop-label">{t === 'radio' ? 'Group name' : 'Name'}</span>
        <CommitInput
          value={obj.name}
          testId="prop-field-name"
          label="Field name"
          validate={(v) => validateFieldName(doc, v, { kind: 'object', id: obj.id })}
          onCommit={(v) => rename(v.trim())}
        />
      </div>
      {t !== 'signature' && (
        <div className="ed-prop-checks">
          <CheckRow label="Required" checked={!!obj.required} onChange={(v) => set({ required: v }, 'required')} testId="prop-field-required" />
          <CheckRow label="Read-only" checked={!!obj.readOnly} onChange={(v) => set({ readOnly: v }, 'readOnly')} testId="prop-field-readOnly" />
          {t === 'text' && <CheckRow label="Multi-line" checked={!!obj.multiline} onChange={(v) => set({ multiline: v }, 'multiline')} testId="prop-field-multiline" />}
        </div>
      )}
      {t === 'text' && (
        <Row label="Max length">
          <input
            type="number"
            min={0}
            data-testid="prop-field-maxLength"
            aria-label="Maximum length"
            placeholder="none"
            value={obj.maxLength ?? ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              set({ maxLength: n > 0 ? n : undefined }, 'maxLength')
            }}
          />
        </Row>
      )}
      {(t === 'text' || t === 'dropdown' || t === 'optionlist') && (
        <Row label="Font size">
          <NumberInput value={obj.fontSize ?? 0} onChange={(v) => set({ fontSize: v }, 'fontSize')} testId="prop-field-fontSize" label="Font size (0 = auto)" min={0} max={200} suffix="pt" />
        </Row>
      )}
      {(t === 'dropdown' || t === 'optionlist') && (
        <div className="ed-prop-col">
          <span className="ed-prop-label">Options</span>
          <OptionsEditor
            options={obj.options ?? []}
            testId="prop-field-options"
            onCommit={(options) => {
              const value = t === 'dropdown' ? (options.includes(String(obj.value ?? '')) ? obj.value : '') : (Array.isArray(obj.value) ? obj.value.filter((v) => options.includes(v)) : [])
              set({ options, value }, 'options', false)
            }}
          />
        </div>
      )}
      {(t === 'checkbox' || t === 'radio') && (
        <div className="ed-prop-col">
          <span className="ed-prop-label">Export value</span>
          <CommitInput
            value={obj.exportValue ?? (t === 'checkbox' ? 'Yes' : '')}
            testId="prop-field-exportValue"
            label="Export value"
            validate={(v) => {
              if (!v.trim()) return 'The export value cannot be empty.'
              if (t === 'radio' && fieldObjects(doc).some((o) => o.id !== obj.id && o.fieldType === 'radio' && o.name === obj.name && o.exportValue === v.trim()))
                return 'Another button of this group uses this value.'
              return null
            }}
            onCommit={(v) => set({ exportValue: v.trim() }, 'exportValue', false)}
          />
        </div>
      )}
    </>
  )
}

