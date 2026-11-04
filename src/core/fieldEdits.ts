/**
 * Structural form edits for the exporter (internal): FieldEdits on existing fields
 * (rename, delete, move widgets, flags, options, font size) and new fields from FieldObjects.
 */
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  rgb,
  type PDFDocument,
  type PDFField,
  type PDFForm,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'
import { FormFieldNameError } from './errors'
import type { EmbedCache } from './exportFonts'
import { acroFormDict, ensureDAFontInDR, updateFieldAppearance } from './exportForms'
import { OBJECT_MARK, objectMark } from './annotations'
import { createWidgetPageFinder, rectFromArray, visibleBox } from './pdf'
import { buttonOptions, buttonStates, widgetRefs } from './formFields'
import type { Box, FieldEdit, FieldObject, FormFieldInfo, FormValue } from './model'

const N = (s: string) => PDFName.of(s)

function quiet<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

const decode = (o: PDFObject | undefined) =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined

function fullName(field: PDFField): string {
  return quiet(() => field.getName()) ?? ''
}

function nameConflict(name: string, others: Iterable<string>): string | undefined {
  for (const other of others) {
    if (other === name) return `A form field named "${name}" already exists.`
    if (other.startsWith(`${name}.`) || name.startsWith(`${other}.`)) {
      return `The form field name "${name}" conflicts with the existing field "${other}".`
    }
  }
  return undefined
}

function validateName(name: string): void {
  if (!name || name.split('.').some((p) => !p.trim())) {
    throw new FormFieldNameError(`"${name}" is not a valid form field name.`, name)
  }
}

/** Page (index) of every annotation ref in /Annots of `pages`. */
function annotPages(pages: PDFPage[]): Map<PDFObject, PDFPage> {
  const map = new Map<PDFObject, PDFPage>()
  for (const p of pages) {
    const annots = quiet(() => p.node.Annots())
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) map.set(annots.get(i), p)
  }
  return map
}

function removeAnnotRef(page: PDFPage, ref: PDFObject): void {
  const annots = page.node.Annots()
  if (!annots) return
  for (let i = annots.size() - 1; i >= 0; i--) if (annots.get(i) === ref) annots.remove(i)
}

/** Remove a field, its widgets from their pages, and empty parents from the AcroForm. */
export function deleteField(form: PDFForm, field: PDFField, pages: PDFPage[], byAnnot = annotPages(pages)): void {
  for (const ref of widgetRefs(field)) {
    if (!ref) continue
    const page = byAnnot.get(ref)
    if (page) removeAnnotRef(page, ref)
  }
  quiet(() => form.acroForm.removeField(field.acroField))
}

/**
 * Fields created by an earlier export for EditObjects that are being restored: all their
 * widgets carry an /OPEObjectId of a restored object. They are removed before the objects
 * are exported again.
 */
export function removeRestoredFields(form: PDFForm, fields: Iterable<PDFField>, ids: Set<string>, pages: PDFPage[]): Set<PDFField> {
  const removed = new Set<PDFField>()
  if (!ids.size) return removed
  let byAnnot: Map<PDFObject, PDFPage> | undefined
  for (const field of fields) {
    const widgets = quiet(() => field.acroField.getWidgets()) ?? []
    if (!widgets.length || !widgets.every((w) => ids.has(objectMark(w.dict) ?? ''))) continue
    byAnnot ??= annotPages(pages)
    deleteField(form, field, pages, byAnnot)
    removed.add(field)
  }
  return removed
}

/** Remove some widgets (indexes in getWidgets() order) of a field that keeps others. */
function removeWidgets(field: PDFField, indexes: number[], byAnnot: Map<PDFObject, PDFPage>): void {
  const kids = quiet(() => field.acroField.Kids())
  if (!kids) return
  const refs = widgetRefs(field)
  const hasOpt =
    (field instanceof PDFRadioGroup || field instanceof PDFCheckBox) && !!quiet(() => field.acroField.dict.lookup(N('Opt')))
  for (const i of [...indexes].sort((a, b) => b - a)) {
    const ref = refs[i]
    const page = ref ? byAnnot.get(ref) : undefined
    if (page && ref) removeAnnotRef(page, ref)
    kids.remove(i)
    if (hasOpt) quiet(() => (field.acroField as unknown as { removeExportValue(i: number): void }).removeExportValue(i))
  }
}

/**
 * New export values for a radio group / checkbox: `options` replaces the field's distinct
 * export values (FormFieldInfo.options order). The field keeps its selection: /Opt entries
 * are rewritten, or (without /Opt) the on-state names, /AS and /V are renamed.
 */
function renameButtonValues(field: PDFRadioGroup | PDFCheckBox, options: string[]): void {
  const states = buttonStates(field)
  const distinct = buttonOptions(states)
  const mapping = new Map<string, string>()
  distinct.forEach((old, i) => {
    if (options[i] !== undefined && options[i] !== old) mapping.set(old, options[i])
  })
  if (!mapping.size) return
  const dict = field.acroField.dict
  const ctx = dict.context
  const opt = dict.lookup(N('Opt'))
  if (opt instanceof PDFArray) {
    const next = states.map((s, i) => {
      const v = s.exportValue ?? decode(opt.lookup(i)) ?? ''
      return PDFHexString.fromText(mapping.get(v) ?? v)
    })
    dict.set(N('Opt'), ctx.obj(next))
    return
  }
  const widgets = quiet(() => field.acroField.getWidgets()) ?? []
  const renameState = (name: string) => mapping.get(name) ?? name
  widgets.forEach((w) => {
    const ap = w.dict.lookup(N('AP'))
    if (ap instanceof PDFDict) {
      for (const k of ['N', 'D', 'R']) {
        const sub = ap.lookup(N(k))
        if (!(sub instanceof PDFDict)) continue
        for (const key of sub.keys()) {
          const next = renameState(key.decodeText())
          if (next === key.decodeText()) continue
          sub.set(N(next), sub.get(key)!)
          sub.delete(key)
        }
      }
    }
    const as = w.dict.lookup(N('AS'))
    if (as instanceof PDFName) w.dict.set(N('AS'), N(renameState(as.decodeText())))
  })
  const v = dict.lookup(N('V'))
  if (v instanceof PDFName) dict.set(N('V'), N(renameState(v.decodeText())))
}

const INHERITABLE_FIELD_KEYS = ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'MaxLen', 'Opt']

/** Find or create the non-terminal fields for `parts` (all but the last name part). */
function parentFor(pdf: PDFDocument, form: PDFForm, parts: string[]): { ref?: PDFRef; kids: PDFArray } {
  const ctx = pdf.context
  let kids = form.acroForm.normalizedEntries().Fields
  let ref: PDFRef | undefined
  for (const part of parts) {
    let found: PDFRef | undefined
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.get(i)
      const d = ctx.lookup(k)
      if (k instanceof PDFRef && d instanceof PDFDict && decode(d.lookup(N('T'))) === part) {
        found = k
        break
      }
    }
    if (!found) {
      const dict = ctx.obj({ T: PDFHexString.fromText(part), Kids: [] })
      if (ref) dict.set(N('Parent'), ref)
      found = ctx.register(dict)
      kids.push(found)
    }
    const dict = ctx.lookup(found, PDFDict)
    let next = dict.lookup(N('Kids'))
    if (!(next instanceof PDFArray)) {
      next = ctx.obj([])
      dict.set(N('Kids'), next as PDFArray)
    }
    kids = next as PDFArray
    ref = found
  }
  return { ref, kids }
}

function attachField(pdf: PDFDocument, form: PDFForm, field: PDFField, name: string): void {
  const parts = name.split('.')
  const acro = field.acroField
  for (const key of INHERITABLE_FIELD_KEYS) {
    if (acro.dict.get(N(key))) continue
    const v = quiet(() => acro.getInheritableAttribute(N(key)))
    if (v) acro.dict.set(N(key), v)
  }
  quiet(() => form.acroForm.removeField(acro))
  const { ref, kids } = parentFor(pdf, form, parts.slice(0, -1))
  acro.dict.set(N('T'), PDFHexString.fromText(parts[parts.length - 1]))
  if (ref) acro.dict.set(N('Parent'), ref)
  else acro.dict.delete(N('Parent'))
  kids.push(field.ref)
}

function setDAFontSize(pdf: PDFDocument, field: PDFField, size: number): void {
  const dicts = [field.acroField.dict, ...(quiet(() => field.acroField.getWidgets()) ?? []).map((w) => w.dict)]
  let wrote = false
  for (const d of dicts) {
    const da = decode(d.lookup(N('DA')))
    if (da === undefined) continue
    const next = /[-\d.]+\s+Tf\b/.test(da) ? da.replace(/[-\d.]+(\s+Tf\b)/, `${size}$1`) : `/Helv ${size} Tf ${da}`
    d.set(N('DA'), PDFString.of(next))
    wrote = true
  }
  if (!wrote) {
    const inherited = decode(quiet(() => field.acroField.getInheritableAttribute(N('DA')))) ?? decode(acroFormDict(pdf)?.lookup(N('DA')))
    const base = inherited ?? '/Helv 0 Tf 0 g'
    const next = /[-\d.]+\s+Tf\b/.test(base) ? base.replace(/[-\d.]+(\s+Tf\b)/, `${size}$1`) : `/Helv ${size} Tf ${base}`
    field.acroField.dict.set(N('DA'), PDFString.of(next))
  }
  quiet(() => ensureDAFontInDR(pdf, field))
}

function setChoiceOptions(field: PDFDropdown | PDFOptionList, options: string[], labels: string[] | null | undefined): void {
  field.acroField.setOptions(
    options.map((value, i) => ({
      value: PDFHexString.fromText(value),
      display: labels?.[i] !== undefined ? PDFHexString.fromText(labels[i]) : undefined
    }))
  )
  // pdf-lib writes [value value] pairs when there is no label; plain strings are clearer.
  if (!labels) field.acroField.dict.set(N('Opt'), field.acroField.dict.context.obj(options.map((o) => PDFHexString.fromText(o))))
}

export interface FieldEditOptions {
  /** Apply renames (false for sources whose forms are flattened anyway). */
  renames: boolean
}

/**
 * Apply FieldEdits (keyed by original name) to a loaded form. `byOriginalName` must be built
 * before anything is renamed. Pages are the source document's pages (for widget boxes).
 * Throws FormFieldNameError for invalid or clashing new names.
 */
export async function applyFieldEdits(
  pdf: PDFDocument,
  form: PDFForm,
  byOriginalName: Map<string, PDFField>,
  edits: Record<string, FieldEdit> | undefined,
  pages: PDFPage[],
  cache: EmbedCache,
  options: FieldEditOptions = { renames: true }
): Promise<void> {
  if (!edits || !Object.keys(edits).length) return
  const byAnnot = annotPages(pages)
  const findPage = createWidgetPageFinder(pdf, pages)
  // 0. Widget-level edits first: widgetBoxes / deletedWidgets index FormFieldInfo.widgets,
  //    i.e. the widgets as listed from the unmodified file.
  const widgetEdited = new Set<string>()
  for (const [name, edit] of Object.entries(edits)) {
    const field = byOriginalName.get(name)
    if (!field || edit.deleted || (!edit.widgetBoxes && !edit.deletedWidgets?.length)) continue
    const widgets = quiet(() => field.acroField.getWidgets()) ?? []
    const refs = widgetRefs(field)
    // FormFieldInfo.widgets lists the widgets whose page and Rect are known, in order.
    const listed: { index: number; page: number }[] = []
    widgets.forEach((w, i) => {
      const p = findPage(w, refs[i])
      if (p !== undefined && rectFromArray(quiet(() => w.Rect()))) listed.push({ index: i, page: p })
    })
    edit.widgetBoxes?.forEach((box: Box | undefined, i) => {
      const target = listed[i]
      if (!box || !target) return
      const vb = visibleBox(pages[target.page])
      const x = vb.x + box.x
      const y = vb.y + vb.height - (box.y + box.height)
      widgets[target.index].dict.set(N('Rect'), pdf.context.obj([x, y, x + box.width, y + box.height]))
    })
    const remove = [...new Set((edit.deletedWidgets ?? []).map((i) => listed[i]?.index).filter((i): i is number => i !== undefined))]
    if (remove.length && remove.length >= widgets.length) {
      deleteField(form, field, pages, byAnnot)
      byOriginalName.delete(name)
      continue
    }
    if (remove.length) removeWidgets(field, remove, byAnnot)
    widgetEdited.add(name)
  }
  // 1. Deletions.
  for (const [name, edit] of Object.entries(edits)) {
    const field = byOriginalName.get(name)
    if (!edit.deleted || !field) continue
    deleteField(form, field, pages, byAnnot)
    byOriginalName.delete(name)
  }
  // 2. Renames (validated together, so swaps work).
  if (options.renames) {
    // Keyed by ref: pdf-lib creates new PDFField wrappers on every getFields() call.
    const finalNames = new Map<PDFRef, string>()
    for (const field of quiet(() => form.getFields()) ?? []) finalNames.set(field.ref, fullName(field))
    const renamed: [PDFField, string][] = []
    for (const [name, edit] of Object.entries(edits)) {
      const field = byOriginalName.get(name)
      if (!field || edit.name === undefined || edit.name === finalNames.get(field.ref)) continue
      validateName(edit.name)
      finalNames.set(field.ref, edit.name)
      renamed.push([field, edit.name])
    }
    for (const [field, name] of renamed) {
      const others = [...finalNames].filter(([ref]) => ref !== field.ref).map(([, n]) => n)
      const conflict = nameConflict(name, others)
      if (conflict) throw new FormFieldNameError(conflict, name)
    }
    for (const [field, name] of renamed) attachField(pdf, form, field, name)
  }
  // 3. Flags, options, font size (and appearances of moved widgets).
  for (const [name, edit] of Object.entries(edits)) {
    const field = byOriginalName.get(name)
    if (!field || edit.deleted) continue
    let refresh = widgetEdited.has(name)
    if (edit.readOnly !== undefined) (edit.readOnly ? field.enableReadOnly() : field.disableReadOnly())
    if (edit.required !== undefined) (edit.required ? field.enableRequired() : field.disableRequired())
    if (field instanceof PDFTextField) {
      if (edit.multiline !== undefined) {
        if (edit.multiline) field.enableMultiline()
        else field.disableMultiline()
        refresh = true
      }
      if (edit.maxLength === null) {
        field.acroField.dict.delete(N('MaxLen'))
        refresh = true
      } else if (edit.maxLength !== undefined) {
        const max = Math.max(0, Math.floor(edit.maxLength))
        const current = quiet(() => field.getText()) ?? ''
        if ([...current].length > max) field.setText([...current].slice(0, max).join(''))
        field.acroField.dict.set(N('MaxLen'), pdf.context.obj(max))
        refresh = true
      }
    }
    if ((field instanceof PDFDropdown || field instanceof PDFOptionList) && (edit.options || edit.optionLabels !== undefined)) {
      const current = (quiet(() => field.acroField.getOptions()) ?? []).map((o) => ({
        value: o.value.decodeText(),
        label: o.display?.decodeText()
      }))
      const values = edit.options ?? current.map((o) => o.value)
      const labels =
        edit.optionLabels === null ? null : (edit.optionLabels ?? (edit.options ? undefined : current.map((o) => o.label ?? o.value)))
      setChoiceOptions(field, values, labels ?? null)
      refresh = true
    }
    if ((field instanceof PDFRadioGroup || field instanceof PDFCheckBox) && edit.options) {
      renameButtonValues(field, edit.options)
    }
    if (edit.fontSize !== undefined && edit.fontSize >= 0) {
      setDAFontSize(pdf, field, edit.fontSize)
      refresh = true
    }
    if (refresh && !(field instanceof PDFCheckBox) && !(field instanceof PDFRadioGroup)) {
      await updateFieldAppearance(pdf, field, cache)
    }
  }
}

// ---------------------------------------------------------------------------------------
// New fields
// ---------------------------------------------------------------------------------------

function pdfRect(page: PDFPage, o: FieldObject) {
  const vb = visibleBox(page)
  return { x: vb.x + o.x, y: vb.y + vb.height - (o.y + o.height), width: o.width, height: o.height }
}

const asString = (v: FormValue | undefined) => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? '') : '')

/**
 * Create real AcroForm fields for FieldObjects (`pageFor` gives each object's output page).
 * Radio objects with the same name form one group. Throws FormFieldNameError on name clashes
 * with existing fields (after renames) or between objects.
 */
export async function createNewFields(
  pdf: PDFDocument,
  form: PDFForm,
  objects: FieldObject[],
  pageFor: (o: FieldObject) => PDFPage | undefined,
  cache: EmbedCache
): Promise<void> {
  if (!objects.length) return
  const existing = (quiet(() => form.getFields()) ?? []).map(fullName)
  const claimed = new Map<string, NewFieldKind>()
  for (const o of objects) {
    validateName(o.name)
    const kind: NewFieldKind = o.fieldType === 'radio' ? 'radio' : 'single'
    const prior = claimed.get(o.name)
    if (prior && (prior === 'single' || kind === 'single')) {
      throw new FormFieldNameError(`A form field named "${o.name}" already exists.`, o.name)
    }
    if (!prior) {
      const conflict = nameConflict(o.name, [...existing, ...[...claimed.keys()]])
      if (conflict) throw new FormFieldNameError(conflict, o.name)
    }
    claimed.set(o.name, kind)
  }

  const radios = new Map<string, PDFRadioGroup>()
  const radioValues = new Map<string, string>()
  const style = { borderColor: rgb(0.55, 0.55, 0.55), backgroundColor: rgb(1, 1, 1), borderWidth: 1, textColor: rgb(0, 0, 0) }
  const created: PDFField[] = []
  for (const o of objects) {
    const page = pageFor(o)
    if (!page) continue
    const r = pdfRect(page, o)
    // pdf-lib grows the widget Rect by half the border width on each side.
    const rect = { x: r.x + 0.5, y: r.y + 0.5, width: Math.max(1, r.width - 1), height: Math.max(1, r.height - 1) }
    let field: PDFField | undefined
    switch (o.fieldType) {
      case 'text': {
        const f = form.createTextField(o.name)
        if (o.multiline) f.enableMultiline()
        if (typeof o.maxLength === 'number' && o.maxLength > 0) f.setMaxLength(Math.floor(o.maxLength))
        let value = asString(o.value)
        if (typeof o.maxLength === 'number' && o.maxLength > 0) value = [...value].slice(0, Math.floor(o.maxLength)).join('')
        f.setText(value || undefined)
        f.addToPage(page, { ...rect, ...style })
        field = f
        break
      }
      case 'checkbox': {
        const f = form.createCheckBox(o.name)
        f.addToPage(page, { ...rect, ...style })
        const on = o.exportValue && o.exportValue !== 'Yes' ? o.exportValue : 'Yes'
        const widget = f.acroField.getWidgets()[0]
        if (on !== 'Yes') {
          const ap = widget.dict.lookup(N('AP'))
          if (ap instanceof PDFDict) {
            for (const k of ['N', 'D']) {
              const sub = ap.lookup(N(k))
              if (sub instanceof PDFDict && sub.get(N('Yes'))) {
                sub.set(N(on), sub.get(N('Yes'))!)
                sub.delete(N('Yes'))
              }
            }
          }
        }
        const checked = o.value === true || (typeof o.value === 'string' && o.value !== '' && o.value === on)
        f.acroField.dict.set(N('V'), N(checked ? on : 'Off'))
        widget.dict.set(N('AS'), N(checked ? on : 'Off'))
        field = f
        break
      }
      case 'radio': {
        let group = radios.get(o.name)
        if (!group) {
          group = form.createRadioGroup(o.name)
          radios.set(o.name, group)
          created.push(group)
        }
        const value = o.exportValue || `Option ${group.getOptions().length + 1}`
        group.addOptionToPage(value, page, { ...rect, ...style })
        if (typeof o.value === 'string' && o.value) radioValues.set(o.name, o.value)
        const widgets = group.acroField.getWidgets()
        const widget = widgets[widgets.length - 1]
        widget.dict.set(OBJECT_MARK, PDFString.of(o.id))
        widget.dict.set(N('Rect'), pdf.context.obj([r.x, r.y, r.x + r.width, r.y + r.height]))
        if (o.required) group.enableRequired()
        if (o.readOnly) group.enableReadOnly()
        break
      }
      case 'dropdown':
      case 'optionlist': {
        const f = o.fieldType === 'dropdown' ? form.createDropdown(o.name) : form.createOptionList(o.name)
        const options = o.options ?? []
        if (options.length) f.addOptions(options)
        if (f instanceof PDFOptionList) f.enableMultiselect()
        const wanted = Array.isArray(o.value) ? o.value : typeof o.value === 'string' && o.value ? [o.value] : []
        const valid = wanted.filter((v) => options.includes(v))
        if (f instanceof PDFDropdown && wanted[0] && !options.includes(wanted[0])) {
          f.enableEditing()
          f.acroField.dict.set(N('V'), PDFHexString.fromText(wanted[0]))
        } else if (valid.length) {
          f.select(f instanceof PDFDropdown ? valid[0] : valid)
        }
        f.addToPage(page, { ...rect, ...style })
        field = f
        break
      }
      case 'signature': {
        const ctx = pdf.context
        const parts = o.name.split('.')
        const { ref: parentRef, kids } = parentFor(pdf, form, parts.slice(0, -1))
        const ap = ctx.register(
          ctx.stream(`0.55 0.55 0.55 RG 1 w 0.5 0.5 ${r.width - 1} ${r.height - 1} re S`, {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, r.width, r.height]
          })
        )
        const dict = ctx.obj({
          FT: 'Sig',
          T: PDFHexString.fromText(parts[parts.length - 1]),
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
          F: 4,
          P: page.ref,
          AP: { N: ap }
        })
        if (parentRef) dict.set(N('Parent'), parentRef)
        dict.set(OBJECT_MARK, PDFString.of(o.id))
        const ref = ctx.register(dict)
        kids.push(ref)
        page.node.addAnnot(ref)
        break
      }
    }
    if (!field) continue
    // Exact box, our marker, flags, and a /DA whose font is in /DR.
    for (const w of field.acroField.getWidgets()) {
      w.dict.set(N('Rect'), pdf.context.obj([r.x, r.y, r.x + r.width, r.y + r.height]))
      w.dict.set(OBJECT_MARK, PDFString.of(o.id))
    }
    if (o.required) field.enableRequired()
    if (o.readOnly) field.enableReadOnly()
    if (!(field instanceof PDFCheckBox)) {
      field.acroField.dict.set(N('DA'), PDFString.of(`/Helv ${o.fontSize && o.fontSize > 0 ? o.fontSize : 0} Tf 0 g`))
    }
    created.push(field)
  }
  for (const [name, value] of radioValues) {
    const group = radios.get(name)!
    if (group.getOptions().includes(value)) group.select(value)
  }
  for (const field of created) await updateFieldAppearance(pdf, field, cache)
}

type NewFieldKind = 'radio' | 'single'

// ---------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------

/** Fully qualified name of the field a widget dict belongs to (walking /Parent). */
function widgetFieldName(widget: PDFDict): string | undefined {
  const parts: string[] = []
  let node: PDFDict | undefined = widget.get(N('T')) ? widget : (widget.lookup(N('Parent')) as PDFDict | undefined)
  for (let depth = 0; node instanceof PDFDict && depth < 32; depth++) {
    const t = decode(node.lookup(N('T')))
    if (t !== undefined) parts.unshift(t)
    const parent: PDFObject | undefined = node.lookup(N('Parent'))
    node = parent instanceof PDFDict ? parent : undefined
  }
  return parts.length ? parts.join('.') : undefined
}

const close = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5

/**
 * For page previews: apply field deletions and widget moves to the widgets on one page (a
 * standalone copy of the source page). `fields` are the source's FormFieldInfos, whose
 * widget lists `edit.widgetBoxes` is aligned with.
 */
export function applyWidgetEditsToPage(
  pdf: PDFDocument,
  page: PDFPage,
  pageIndex: number,
  fields: FormFieldInfo[],
  edits: Record<string, FieldEdit> | undefined
): void {
  if (!edits || !Object.keys(edits).length) return
  const annots = page.node.Annots()
  if (!annots) return
  const vb = visibleBox(page)
  const infos = new Map(fields.map((f) => [f.name, f]))
  for (let k = annots.size() - 1; k >= 0; k--) {
    const d = pdf.context.lookup(annots.get(k))
    if (!(d instanceof PDFDict) || d.lookup(N('Subtype')) !== N('Widget')) continue
    const name = widgetFieldName(d)
    const edit = name ? edits[name] : undefined
    if (!edit) continue
    if (edit.deleted) {
      annots.remove(k)
      continue
    }
    if (!edit.widgetBoxes && !edit.deletedWidgets?.length) continue
    const rect = rectFromArray(d.lookup(N('Rect')))
    const info = infos.get(name!)
    if (!rect || !info) continue
    const current = { x: rect.x - vb.x, y: vb.y + vb.height - (rect.y + rect.height), width: rect.width, height: rect.height }
    const i = info.widgets.findIndex((w) => w.pageIndex === pageIndex && close(w.box, current))
    if (i >= 0 && edit.deletedWidgets?.includes(i)) {
      annots.remove(k)
      continue
    }
    const box = i >= 0 ? edit.widgetBoxes?.[i] : undefined
    if (!box) continue
    const x = vb.x + box.x
    const y = vb.y + vb.height - (box.y + box.height)
    d.set(N('Rect'), pdf.context.obj([x, y, x + box.width, y + box.height]))
  }
}
