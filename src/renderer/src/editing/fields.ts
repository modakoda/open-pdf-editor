/** Form field helpers: effective (edited) fields, names, and new FieldObjects. */
import {
  getEffectiveFormFields,
  getFieldEdit,
  type Box,
  type EditorDocument,
  type EffectiveFormField,
  type FieldObject,
  type FormFieldWidget,
  type NewFieldType,
  type PageEntry
} from '@core'
import type { ToolId } from '@renderer/state/store'
import { newObjectId } from './objects'

/** Field types rendered as inputs (buttons and signatures are left to the canvas). */
export const FILLABLE_TYPES = new Set(['text', 'checkbox', 'radio', 'dropdown', 'optionlist'])

export function effectiveFields(doc: EditorDocument, sourceId: string): EffectiveFormField[] {
  try {
    return getEffectiveFormFields(doc, sourceId)
  } catch {
    return (doc.sources[sourceId]?.formFields ?? []).map((f) => ({ ...f, originalName: f.name }))
  }
}

export interface WidgetEntry {
  sourceId: string
  field: EffectiveFormField
  widget: FormFieldWidget
  /** Index into the field's widgets (FormFieldInfo.widgets order). */
  index: number
}

/**
 * Current widgets of a field, indexed like the SOURCE FormFieldInfo.widgets (the indexes used by
 * FieldEdit.widgetBoxes / deletedWidgets and ElementRef.widgetIndex), with edits applied and
 * deleted widgets left out. Works whether or not getEffectiveFormFields filters deleted widgets.
 */
export function currentWidgets(doc: EditorDocument, sourceId: string, originalName: string): { widget: FormFieldWidget; index: number }[] {
  const src = doc.sources[sourceId]?.formFields.find((f) => f.name === originalName)
  if (!src) return []
  const edit = getFieldEdit(doc, sourceId, originalName)
  if (edit?.deleted) return []
  const deleted = new Set(edit?.deletedWidgets ?? [])
  const out: { widget: FormFieldWidget; index: number }[] = []
  src.widgets.forEach((w, index) => {
    if (deleted.has(index)) return
    const box = edit?.widgetBoxes?.[index]
    out.push({ widget: box ? { ...w, box } : w, index })
  })
  return out
}

/** Widgets of existing fields that sit on `page` (edits applied). */
export function widgetsOnPage(doc: EditorDocument, page: PageEntry, types?: Set<string>): WidgetEntry[] {
  if (page.source.kind !== 'source') return []
  const { sourceId, pageIndex } = page.source
  if (!doc.sources[sourceId]?.formFields?.length) return []
  const out: WidgetEntry[] = []
  for (const field of effectiveFields(doc, sourceId)) {
    if (types && !types.has(field.type)) continue
    for (const { widget, index } of currentWidgets(doc, sourceId, field.originalName)) {
      if (widget.pageIndex === pageIndex) out.push({ sourceId, field, widget, index })
    }
  }
  return out
}

/** Value a radio/checkbox widget stands for ("on" value), honouring edited export values. */
export function widgetOnValue(doc: EditorDocument, e: WidgetEntry): string {
  const edited = getFieldEdit(doc, e.sourceId, e.field.originalName)?.options
  return edited?.[e.index] ?? e.widget.onValue ?? e.field.options?.[e.index] ?? String(e.index)
}

export function fieldObjects(doc: EditorDocument): FieldObject[] {
  return doc.objects.filter((o): o is FieldObject => o.type === 'field')
}

/**
 * AcroForm names are hierarchical: "a" and "a.b" cannot both be fields (the engine rejects
 * this on save), so names clash when equal or when one is a dotted prefix of the other.
 */
export function namesClash(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '.') || a.startsWith(b + '.')
}

/**
 * Names in use by effective fields of the primary source (and of `sourceId`) plus FieldObjects,
 * excluding the field being renamed: `selfKey` is its original name when `sourceId` is given,
 * else the FieldObject id (radio buttons of the same group share their name).
 */
export function fieldNamesInUse(doc: EditorDocument, sourceId: string | null, selfKey: string | null): string[] {
  const names: string[] = []
  const sources = new Set([doc.primarySourceId, sourceId].filter((s): s is string => !!s))
  for (const sid of sources) {
    for (const f of effectiveFields(doc, sid)) {
      if (sourceId !== null && sid === sourceId && f.originalName === selfKey) continue
      names.push(f.name)
    }
  }
  const selfObj = sourceId === null && selfKey ? doc.objects.find((o) => o.id === selfKey) : undefined
  for (const o of fieldObjects(doc)) {
    if (sourceId === null && o.id === selfKey) continue
    if (selfObj?.type === 'field' && selfObj.fieldType === 'radio' && o.fieldType === 'radio' && o.name === selfObj.name) continue
    names.push(o.name)
  }
  return names
}

export function isNameTaken(name: string, used: Iterable<string>): boolean {
  for (const u of used) if (namesClash(name, u)) return true
  return false
}

/**
 * Error message when `newName` cannot be used for a field, or null. Shared by the properties
 * panel and the workspace's fields list. `sourceId` + original name identify an existing field;
 * `sourceId` null + object id identify a FieldObject; `selfKey` null validates a brand-new name.
 */
export function validateFieldName(doc: EditorDocument, sourceId: string | null, newName: string, selfKey: string | null): string | null {
  const name = newName.trim()
  if (!name) return 'The name cannot be empty.'
  if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) return 'Invalid name.'
  for (const u of fieldNamesInUse(doc, sourceId, selfKey)) {
    if (u === name) return `A field named “${name}” already exists.`
    if (namesClash(name, u)) return `“${name}” conflicts with the field “${u}” (one name cannot be a prefix of the other followed by “.”).`
  }
  return null
}

export function uniqueName(prefix: string, used: Iterable<string>): string {
  const list = [...used]
  for (let n = 1; ; n++) if (!isNameTaken(`${prefix}${n}`, list)) return `${prefix}${n}`
}

export const FIELD_TOOL_TYPES: Partial<Record<ToolId, NewFieldType>> = {
  'field-text': 'text',
  'field-checkbox': 'checkbox',
  'field-radio': 'radio',
  'field-dropdown': 'dropdown',
  'field-list': 'optionlist',
  'field-signature': 'signature'
}

export function isFieldTool(tool: ToolId): boolean {
  return tool in FIELD_TOOL_TYPES
}

const PREFIX: Record<NewFieldType, string> = {
  text: 'Text',
  checkbox: 'Check',
  radio: 'Group',
  dropdown: 'Dropdown',
  optionlist: 'List',
  signature: 'Signature'
}

/** Size (points) of a field placed with a click instead of a drag. */
export const DEFAULT_FIELD_SIZE: Record<NewFieldType, { width: number; height: number }> = {
  text: { width: 160, height: 22 },
  checkbox: { width: 14, height: 14 },
  radio: { width: 14, height: 14 },
  dropdown: { width: 160, height: 22 },
  optionlist: { width: 160, height: 60 },
  signature: { width: 180, height: 44 }
}

export const DEFAULT_OPTIONS = ['Option 1', 'Option 2']

/**
 * New FieldObject with a unique default name (Text1, Check1, Dropdown1…). Radio buttons start
 * a new group ("Group1" with export value "Choice1") unless `joinGroup` names an existing group.
 */
export function makeFieldObject(
  doc: EditorDocument,
  fieldType: NewFieldType,
  pageId: string,
  box: Box,
  joinGroup?: string | null
): FieldObject {
  const used = fieldNamesInUse(doc, null, null)
  const base = { id: newObjectId(), pageId, type: 'field' as const, fieldType, ...box, fontSize: 0 }
  switch (fieldType) {
    case 'radio': {
      const group = joinGroup && fieldObjects(doc).some((o) => o.fieldType === 'radio' && o.name === joinGroup) ? joinGroup : null
      const name = group ?? uniqueName(PREFIX.radio, used)
      const values = new Set(
        fieldObjects(doc)
          .filter((o) => o.fieldType === 'radio' && o.name === name)
          .map((o) => o.exportValue ?? '')
      )
      const sibling = fieldObjects(doc).find((o) => o.fieldType === 'radio' && o.name === name)
      let n = 1
      while (values.has(`Choice${n}`)) n++
      return { ...base, name, exportValue: `Choice${n}`, value: sibling?.value ?? '' }
    }
    case 'checkbox':
      return { ...base, name: uniqueName(PREFIX.checkbox, used), exportValue: 'Yes', value: false }
    case 'dropdown':
      return { ...base, name: uniqueName(PREFIX.dropdown, used), options: [...DEFAULT_OPTIONS], value: '' }
    case 'optionlist':
      return { ...base, name: uniqueName(PREFIX.optionlist, used), options: [...DEFAULT_OPTIONS], value: [] }
    case 'text':
      return { ...base, name: uniqueName(PREFIX.text, used), value: '' }
    case 'signature':
      return { ...base, name: uniqueName(PREFIX.signature, used) }
  }
}

export const FIELD_TYPE_LABELS: Record<string, string> = {
  text: 'Text field',
  checkbox: 'Checkbox',
  radio: 'Radio button',
  dropdown: 'Dropdown',
  optionlist: 'List box',
  signature: 'Signature field',
  button: 'Button',
  unknown: 'Field'
}
