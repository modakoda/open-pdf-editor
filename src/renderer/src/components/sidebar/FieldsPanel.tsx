/**
 * Sidebar "Fields" tab: every form field of the document — existing fields of all sources
 * (core getEffectiveFormFields, so renames/deletions are reflected) and new FieldObjects (radio
 * FieldObjects sharing a name are one group). Click selects the field in Prepare form mode and
 * scrolls to it; fields can be renamed inline (unique names) and deleted. All edits undoable.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  CircleDot,
  CircleQuestionMark,
  ClipboardList,
  List,
  MousePointerClick,
  Pencil,
  Signature,
  SquareCheck,
  TextCursorInput,
  Trash,
  type LucideIcon
} from 'lucide-react'
import {
  boxCenter,
  editField,
  getEffectiveFormFields,
  getFormValue,
  removeObject,
  updateObject,
  type Box,
  type EditorDocument,
  type FieldObject,
  type FormValue
} from '@core'
import { applyEdit, isImeComposing } from '@renderer/actions/util'
import * as editing from '@renderer/editing'
import { useEditor, type EditorState } from '@renderer/state/store'

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature' | 'button' | 'unknown'

export interface FieldEntry {
  /** Unique row key. */
  key: string
  /** 'existing' = a field of a source file, 'new' = FieldObject(s) added in the editor. */
  origin: 'existing' | 'new'
  name: string
  type: FieldKind
  /** Existing fields: source and ORIGINAL name (key for editField / formValues). */
  sourceId?: string
  originalName?: string
  /** New fields: the FieldObjects of this field (several for a radio group). */
  objectIds?: string[]
  /** First document page showing the field (null when none of its widgets is in the document). */
  pageId: string | null
  pageIndex: number
  /** Index into FormFieldInfo.widgets of the widget on `pageId` (existing fields). */
  widgetIndex: number
  box: Box | null
  widgetCount: number
  value: FormValue | undefined
  options?: string[]
  optionLabels?: string[]
}

const cache = new WeakMap<EditorDocument, FieldEntry[]>()

/** All fields of the document in page / reading order. Memoized per document snapshot. */
export function collectFields(doc: EditorDocument): FieldEntry[] {
  const cached = cache.get(doc)
  if (cached) return cached
  const pageOf = new Map<string, number>()
  doc.pages.forEach((p, i) => {
    if (p.source.kind !== 'source') return
    const k = `${p.source.sourceId}:${p.source.pageIndex}`
    if (!pageOf.has(k)) pageOf.set(k, i)
  })
  const entries: FieldEntry[] = []
  const sourceIds = Object.keys(doc.sources).sort((a, b) =>
    a === doc.primarySourceId ? -1 : b === doc.primarySourceId ? 1 : 0
  )
  for (const sourceId of sourceIds) {
    let fields: ReturnType<typeof getEffectiveFormFields> = []
    try {
      fields = getEffectiveFormFields(doc, sourceId)
    } catch {
      fields = (doc.sources[sourceId]?.formFields ?? []).map((f) => ({ ...f, originalName: f.name }))
    }
    for (const f of fields) {
      let widgetIndex = -1
      let pageIndex = -1
      f.widgets.forEach((w, i) => {
        const at = pageOf.get(`${sourceId}:${w.pageIndex}`)
        if (at !== undefined && (pageIndex < 0 || at < pageIndex)) {
          pageIndex = at
          widgetIndex = i
        }
      })
      if (pageIndex < 0) continue // none of its pages is in the document
      let value: FormValue | undefined
      try {
        value = getFormValue(doc, sourceId, f.originalName)
      } catch {
        value = f.value
      }
      entries.push({
        key: `existing:${sourceId}:${f.originalName}`,
        origin: 'existing',
        name: f.name,
        type: f.type,
        sourceId,
        originalName: f.originalName,
        pageId: doc.pages[pageIndex].id,
        pageIndex,
        widgetIndex,
        box: f.widgets[widgetIndex]?.box ?? null,
        widgetCount: f.widgets.length,
        value,
        options: f.options,
        optionLabels: f.optionLabels
      })
    }
  }
  const groups = new Map<string, FieldObject[]>()
  for (const obj of doc.objects) {
    if (obj.type !== 'field') continue
    const key = obj.fieldType === 'radio' ? `radio:${obj.name}` : obj.id
    const list = groups.get(key)
    if (list) list.push(obj)
    else groups.set(key, [obj])
  }
  const pageIndexById = new Map(doc.pages.map((p, i) => [p.id, i]))
  for (const [key, objs] of groups) {
    const placed = objs
      .map((o) => ({ o, i: pageIndexById.get(o.pageId) ?? -1 }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i || a.o.y - b.o.y)
    if (!placed.length) continue
    const first = placed[0].o
    const value = objs.find((o) => o.value !== undefined && o.value !== '' && o.value !== false)?.value ?? first.value
    entries.push({
      key: `new:${key}`,
      origin: 'new',
      name: first.name,
      type: first.fieldType === 'optionlist' ? 'optionlist' : first.fieldType,
      objectIds: objs.map((o) => o.id),
      pageId: first.pageId,
      pageIndex: placed[0].i,
      widgetIndex: 0,
      box: { x: first.x, y: first.y, width: first.width, height: first.height },
      widgetCount: objs.length,
      value,
      options: first.fieldType === 'radio' ? objs.map((o) => o.exportValue ?? '') : first.options
    })
  }
  entries.sort((a, b) => a.pageIndex - b.pageIndex || (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0))
  cache.set(doc, entries)
  return entries
}

export function useFieldCount(): number {
  return useEditor((s) => (s.doc ? collectFields(s.doc).length : 0))
}

const ICONS: Record<FieldKind, LucideIcon> = {
  text: TextCursorInput,
  checkbox: SquareCheck,
  radio: CircleDot,
  dropdown: ChevronDown,
  optionlist: List,
  signature: Signature,
  button: MousePointerClick,
  unknown: CircleQuestionMark
}

const TYPE_LABELS: Record<FieldKind, string> = {
  text: 'Text field',
  checkbox: 'Checkbox',
  radio: 'Radio buttons',
  dropdown: 'Dropdown',
  optionlist: 'List box',
  signature: 'Signature',
  button: 'Button',
  unknown: 'Field'
}

function label(entry: FieldEntry, value: string): string {
  const i = entry.options?.indexOf(value) ?? -1
  return i >= 0 && entry.optionLabels?.[i] ? entry.optionLabels[i] : value
}

function truncate(text: string, max = 28): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Short description of a field's current value. */
export function summarizeValue(entry: FieldEntry): string {
  const v = entry.value
  switch (entry.type) {
    case 'text':
      return typeof v === 'string' && v.trim() ? `“${truncate(v)}”` : 'Empty'
    case 'checkbox':
      return v === true || (typeof v === 'string' && v !== '' && v !== 'Off') ? 'Checked' : 'Unchecked'
    case 'radio':
    case 'dropdown':
      return typeof v === 'string' && v && v !== 'Off' ? truncate(label(entry, v)) : 'No selection'
    case 'optionlist':
      return Array.isArray(v) && v.length ? truncate(v.map((x) => label(entry, x)).join(', ')) : 'No selection'
    case 'signature':
      return 'Signature'
    case 'button':
      return 'Button'
    default:
      return ''
  }
}

/** True when two fully qualified names cannot coexist: equal, or one is a dotted prefix of the other. */
export function fieldNamesClash(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

/** Names of every other field of the document (all sources, FieldObjects), excluding `entry`. */
function otherFieldNames(doc: EditorDocument, entry: FieldEntry): string[] {
  const names: string[] = []
  for (const sourceId of Object.keys(doc.sources)) {
    let fields: { name: string; originalName: string }[]
    try {
      fields = getEffectiveFormFields(doc, sourceId)
    } catch {
      fields = (doc.sources[sourceId]?.formFields ?? []).map((f) => ({ name: f.name, originalName: f.name }))
    }
    for (const f of fields) {
      if (entry.origin === 'existing' && entry.sourceId === sourceId && entry.originalName === f.originalName) continue
      names.push(f.name)
    }
  }
  for (const o of doc.objects) {
    if (o.type === 'field' && !entry.objectIds?.includes(o.id)) names.push(o.name)
  }
  return names
}

type SharedValidator = (
  doc: EditorDocument,
  name: string,
  self: { kind: 'field'; sourceId: string; originalName: string } | { kind: 'object'; id: string }
) => string | null

/** The editing layer's validateFieldName() once it is exported (same rules everywhere). */
function sharedValidator(): SharedValidator | null {
  try {
    const fn = (editing as unknown as Record<string, unknown>).validateFieldName
    return typeof fn === 'function' ? (fn as SharedValidator) : null
  } catch {
    return null
  }
}

/** Error message for renaming `entry` to `name`, or null when the name is valid. */
export function validateFieldName(doc: EditorDocument, entry: FieldEntry, name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === entry.name) return null
  const shared = sharedValidator()
  if (shared) {
    const self =
      entry.origin === 'existing'
        ? { kind: 'field' as const, sourceId: entry.sourceId ?? '', originalName: entry.originalName ?? entry.name }
        : { kind: 'object' as const, id: entry.objectIds?.[0] ?? '' }
    return shared(doc, trimmed, self)
  }
  if (!trimmed) return 'Enter a field name.'
  if (/^\.|\.$|\.\./.test(trimmed)) return 'Names cannot start or end with “.” or contain “..”.'
  const clash = otherFieldNames(doc, entry).find((other) => fieldNamesClash(trimmed, other))
  if (clash === trimmed) return `A field named “${trimmed}” already exists.`
  if (clash) return `“${trimmed}” conflicts with the field “${clash}”.`
  return null
}

export function renameField(entry: FieldEntry, name: string): boolean {
  const next = name.trim()
  if (next === entry.name) return true
  if (entry.origin === 'existing' && entry.sourceId && entry.originalName) {
    const { sourceId, originalName } = entry
    return applyEdit('Rename field', (d) =>
      editField(d, sourceId, originalName, { name: next === originalName ? undefined : next })
    )
  }
  const ids = entry.objectIds ?? []
  return applyEdit('Rename field', (d) => ids.reduce((acc, id) => updateObject(acc, id, { name: next } as Partial<FieldObject>), d))
}

export function deleteField(entry: FieldEntry): boolean {
  if (entry.origin === 'existing' && entry.sourceId && entry.originalName) {
    const { sourceId, originalName } = entry
    return applyEdit('Delete field', (d) => editField(d, sourceId, originalName, { deleted: true }))
  }
  const ids = entry.objectIds ?? []
  return applyEdit('Delete field', (d) => ids.reduce((acc, id) => removeObject(acc, id), d))
}

/** Select the field in Prepare form mode and scroll it into view. */
export function selectField(entry: FieldEntry): void {
  if (!entry.pageId) return
  const s = useEditor.getState()
  if (s.tool !== 'form-design') s.setTool('form-design')
  if (entry.origin === 'existing' && entry.sourceId && entry.originalName) {
    s.selectElement({
      kind: 'field',
      sourceId: entry.sourceId,
      fieldName: entry.originalName,
      widgetIndex: Math.max(0, entry.widgetIndex),
      pageId: entry.pageId
    })
  } else if (entry.objectIds?.length) {
    s.selectObject(entry.objectIds[0])
  }
  s.goToPage(entry.pageId, entry.box ? boxCenter(entry.box) : undefined)
}

function isSelected(entry: FieldEntry, s: Pick<EditorState, 'selectedElement' | 'selectedObjectId'>): boolean {
  if (entry.origin === 'existing') {
    const el = s.selectedElement
    return el?.kind === 'field' && el.sourceId === entry.sourceId && el.fieldName === entry.originalName
  }
  return !!s.selectedObjectId && !!entry.objectIds?.includes(s.selectedObjectId)
}

export function FieldsPanel() {
  const doc = useEditor((s) => s.doc)
  const selectedElement = useEditor((s) => s.selectedElement)
  const selectedObjectId = useEditor((s) => s.selectedObjectId)
  const entries = useMemo(() => (doc ? collectFields(doc) : []), [doc])
  const [editing, setEditing] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Keep the selected field's row visible (selection may come from the page).
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [selectedElement, selectedObjectId])

  return (
    <div
      className="sidebar-panel fields-panel"
      role="tabpanel"
      id="sidebar-panel-fields"
      aria-labelledby="sidebar-tab-fields"
      data-testid="fields-panel"
    >
      {entries.length === 0 ? (
        <div className="fields-empty" data-testid="fields-empty">
          <ClipboardList size={28} strokeWidth={1.5} aria-hidden="true" />
          <strong>No form fields</strong>
          <span>Add text boxes, checkboxes and other fields with Prepare form.</span>
          <button type="button" className="btn btn-small" onClick={() => useEditor.getState().setTool('form-design')}>
            Prepare form
          </button>
        </div>
      ) : (
        <ul ref={listRef} className="field-list" aria-label="Form fields">
          {entries.map((entry) => (
            <FieldRow
              key={entry.key}
              entry={entry}
              selected={isSelected(entry, { selectedElement, selectedObjectId })}
              editing={editing === entry.key}
              onEdit={(on) => setEditing(on ? entry.key : null)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function FieldRow({
  entry,
  selected,
  editing,
  onEdit
}: {
  entry: FieldEntry
  selected: boolean
  editing: boolean
  onEdit: (on: boolean) => void
}) {
  const Icon = ICONS[entry.type] ?? CircleQuestionMark
  const summary = summarizeValue(entry)
  const meta = [summary, entry.widgetCount > 1 ? `${entry.widgetCount} widgets` : null].filter(Boolean).join(' · ')
  const pageLabel = entry.pageIndex >= 0 ? `p. ${entry.pageIndex + 1}` : ''
  return (
    <li
      className={`field-row${selected ? ' selected' : ''}`}
      data-testid="field-row"
      data-field-name={entry.name}
      data-field-origin={entry.origin}
      data-selected={selected ? 'true' : 'false'}
    >
      {editing ? (
        <RenameInput entry={entry} onDone={() => onEdit(false)} />
      ) : (
        <>
          <button
            type="button"
            className="field-row-main"
            title={`${TYPE_LABELS[entry.type]} “${entry.name}”`}
            onClick={() => selectField(entry)}
            onDoubleClick={() => onEdit(true)}
          >
            <Icon size={15} aria-label={TYPE_LABELS[entry.type]} className="field-row-icon" />
            <span className="field-row-text">
              <span className="field-row-name">{entry.name}</span>
              <span className="field-row-meta">{meta}</span>
            </span>
            <span className="field-row-page" title={`Page ${entry.pageIndex + 1}`}>
              {pageLabel}
            </span>
          </button>
          <span className="field-row-actions">
            <button
              type="button"
              className="field-row-action"
              data-testid="field-rename"
              title="Rename"
              aria-label={`Rename ${entry.name}`}
              onClick={() => onEdit(true)}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="field-row-action danger"
              data-testid="field-delete"
              title="Delete field"
              aria-label={`Delete ${entry.name}`}
              onClick={() => deleteField(entry)}
            >
              <Trash size={13} aria-hidden="true" />
            </button>
          </span>
        </>
      )}
    </li>
  )
}

function RenameInput({ entry, onDone }: { entry: FieldEntry; onDone: () => void }) {
  const [value, setValue] = useState(entry.name)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): boolean => {
    const doc = useEditor.getState().doc
    const err = doc ? validateFieldName(doc, entry, value) : null
    if (err) {
      setError(err)
      inputRef.current?.focus()
      return false
    }
    renameField(entry, value)
    onDone()
    return true
  }

  return (
    <div className="field-rename">
      <input
        ref={inputRef}
        className="input field-rename-input"
        data-testid="field-name-input"
        aria-label="Field name"
        aria-invalid={error ? 'true' : undefined}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          if (error) setError(null)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (isImeComposing(e)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          }
        }}
        onBlur={() => {
          // Leaving the field keeps a valid name and discards an invalid one.
          const doc = useEditor.getState().doc
          if (doc && !validateFieldName(doc, entry, value)) commit()
          else onDone()
        }}
      />
      {error && (
        <div className="field-error" role="alert" data-testid="field-rename-error">
          {error}
        </div>
      )}
    </div>
  )
}
