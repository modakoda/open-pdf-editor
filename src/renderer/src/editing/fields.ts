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

/** Widgets of existing fields that sit on `page` (edits applied). */
export function widgetsOnPage(doc: EditorDocument, page: PageEntry, types?: Set<string>): WidgetEntry[] {
  if (page.source.kind !== 'source') return []
  const { sourceId, pageIndex } = page.source
  if (!doc.sources[sourceId]?.formFields?.length) return []
  const out: WidgetEntry[] = []
  for (const field of effectiveFields(doc, sourceId)) {
    if (types && !types.has(field.type)) continue
    field.widgets.forEach((widget, index) => {
      if (widget.pageIndex === pageIndex) out.push({ sourceId, field, widget, index })
    })
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

export type FieldSelf = { kind: 'field'; sourceId: string; originalName: string } | { kind: 'object'; id: string }

/** Names in use by existing fields (all sources) and FieldObjects, excluding `self`. */
export function usedFieldNames(doc: EditorDocument, self?: FieldSelf): Set<string> {
  const names = new Set<string>()
  for (const sourceId of Object.keys(doc.sources)) {
    for (const f of effectiveFields(doc, sourceId)) {
      if (self?.kind === 'field' && self.sourceId === sourceId && self.originalName === f.originalName) continue
      names.add(f.name)
    }
  }
  const selfObj = self?.kind === 'object' ? doc.objects.find((o) => o.id === self.id) : undefined
  for (const o of fieldObjects(doc)) {
    if (self?.kind === 'object' && o.id === self.id) continue
    // Radio buttons of the same group share their name.
    if (selfObj?.type === 'field' && selfObj.fieldType === 'radio' && o.fieldType === 'radio' && o.name === selfObj.name) continue
    names.add(o.name)
  }
  return names
}

export function uniqueName(prefix: string, used: Set<string>): string {
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`
}

/** Error message for an invalid new field name, or null when it can be used. */
export function validateFieldName(doc: EditorDocument, name: string, self: FieldSelf): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'The name cannot be empty.'
  if (trimmed.startsWith('.') || trimmed.endsWith('.') || trimmed.includes('..')) return 'Invalid name.'
  if (usedFieldNames(doc, self).has(trimmed)) return `A field named “${trimmed}” already exists.`
  return null
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
  const used = usedFieldNames(doc)
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
      return { ...base, name, exportValue: uniqueName('Choice', values), value: sibling?.value ?? '' }
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
