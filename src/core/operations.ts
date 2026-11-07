/**
 * Pure, immutable operations on EditorDocument. Each returns a NEW document and never
 * mutates its input (unchanged parts are shared structurally).
 */
import { createId } from './ids'
import { displaySize, normalizeRotation } from './geometry'
import {
  PAGE_SIZES,
  type AnnotationEdit,
  type AnnotationInfo,
  type Box,
  type ContentEdit,
  type DocumentSettings,
  type FieldEdit,
  type FieldObject,
  type FormFieldInfo,
  type EditObject,
  type EditorDocument,
  type FormValue,
  type PageEntry,
  type SourceDocument
} from './model'

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return index > 0 ? length : 0
  return Math.min(length, Math.max(0, Math.trunc(index)))
}

/** Rotate pages by a multiple of 90 degrees (positive = clockwise). */
export function rotatePages(doc: EditorDocument, pageIds: string[], delta: number): EditorDocument {
  const ids = new Set(pageIds)
  return {
    ...doc,
    pages: doc.pages.map((p) =>
      ids.has(p.id) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p
    )
  }
}

/** Remove pages and every object on them. Removing all pages is allowed (empty document). */
export function deletePages(doc: EditorDocument, pageIds: string[]): EditorDocument {
  const ids = new Set(pageIds)
  return {
    ...doc,
    pages: doc.pages.filter((p) => !ids.has(p.id)),
    objects: doc.objects.filter((o) => !ids.has(o.pageId)),
    ...withoutPages(doc, ids),
    ...(doc.redactions ? { redactions: doc.redactions.filter((r) => !ids.has(r.pageId)) } : {})
  }
}

/** contentEdits / annotationEdits / ocr without the given pages (only keys that exist are returned). */
function withoutPages(
  doc: EditorDocument,
  ids: Set<string>
): Pick<EditorDocument, 'contentEdits' | 'annotationEdits' | 'ocr'> {
  const out: Pick<EditorDocument, 'contentEdits' | 'annotationEdits' | 'ocr'> = {}
  for (const key of ['contentEdits', 'annotationEdits', 'ocr'] as const) {
    const map = doc[key]
    if (!map) continue
    out[key] = Object.fromEntries(Object.entries(map).filter(([pageId]) => !ids.has(pageId))) as never
  }
  return out
}

/**
 * Move pages (kept in their current relative order) so the first of them lands at
 * `targetIndex` in the resulting page list (clamped to [0, remaining.length]).
 */
export function movePages(doc: EditorDocument, pageIds: string[], targetIndex: number): EditorDocument {
  const ids = new Set(pageIds)
  const moving = doc.pages.filter((p) => ids.has(p.id))
  const remaining = doc.pages.filter((p) => !ids.has(p.id))
  const t = clampIndex(targetIndex, remaining.length)
  return {
    ...doc,
    pages: [...remaining.slice(0, t), ...moving, ...remaining.slice(t)]
  }
}

/** Insert a blank page at `index`. Size defaults to the size of the neighbouring page, else A4. */
export function insertBlankPage(
  doc: EditorDocument,
  index: number,
  size?: { width: number; height: number }
): { doc: EditorDocument; page: PageEntry } {
  const i = clampIndex(index, doc.pages.length)
  // The neighbour is the page before the insertion point (or the one after it when
  // inserting at the start). Its *displayed* size is used, so a blank page next to a
  // landscape-looking page is landscape too.
  const neighbour = doc.pages[i - 1] ?? doc.pages[i]
  const dims = size ?? (neighbour ? displaySize(neighbour) : PAGE_SIZES.A4)
  const page: PageEntry = {
    id: createId('page'),
    source: { kind: 'blank' },
    width: dims.width,
    height: dims.height,
    baseRotation: 0,
    rotation: 0
  }
  const pages = [...doc.pages.slice(0, i), page, ...doc.pages.slice(i)]
  return { doc: { ...doc, pages }, page }
}

/** Duplicate pages (with copies of their objects); each copy is inserted right after its original. */
export function duplicatePages(doc: EditorDocument, pageIds: string[]): EditorDocument {
  const ids = new Set(pageIds)
  const pages: PageEntry[] = []
  const newObjects: EditObject[] = []
  const contentEdits = doc.contentEdits ? { ...doc.contentEdits } : undefined
  const annotationEdits = doc.annotationEdits ? { ...doc.annotationEdits } : undefined
  const ocr = doc.ocr ? { ...doc.ocr } : undefined
  // A copy of a page shows the same content, so it is redacted the same way.
  const redactions = doc.redactions ? [...doc.redactions] : undefined
  for (const p of doc.pages) {
    pages.push(p)
    if (!ids.has(p.id)) continue
    const copy: PageEntry = { ...p, id: createId('page') }
    pages.push(copy)
    const copies = doc.objects
      .filter((o) => o.pageId === p.id)
      .map((o) => ({ ...o, id: createId('obj'), pageId: copy.id }) as EditObject)
    newObjects.push(...withUniqueFieldNames(doc, copies, newObjects))
    if (contentEdits?.[p.id]) contentEdits[copy.id] = contentEdits[p.id]
    if (annotationEdits?.[p.id]) annotationEdits[copy.id] = annotationEdits[p.id]
    if (ocr?.[p.id]) ocr[copy.id] = ocr[p.id]
    for (const r of doc.redactions ?? []) if (r.pageId === p.id) redactions!.push({ ...r, id: createId('redact'), pageId: copy.id })
  }
  return {
    ...doc,
    pages,
    objects: newObjects.length ? [...doc.objects, ...newObjects] : doc.objects,
    ...(contentEdits ? { contentEdits } : {}),
    ...(annotationEdits ? { annotationEdits } : {}),
    ...(ocr ? { ocr } : {}),
    ...(redactions ? { redactions } : {})
  }
}

/**
 * Add another PDF's pages (all, or the given 0-based `pageIndices`) at `index`.
 * Registers `source` in doc.sources. Used for "Insert pages from file" and merging.
 * If the document has no primary source yet, `source` becomes the primary source.
 */
export function insertSourcePages(
  doc: EditorDocument,
  source: SourceDocument,
  index: number,
  pageIndices?: number[]
): EditorDocument {
  const indices = (pageIndices ?? Array.from({ length: source.pageCount }, (_, i) => i)).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < source.pageCount
  )
  const newPages: PageEntry[] = indices.map((pageIndex) => {
    const info = source.pageInfo?.[pageIndex]
    return {
      id: createId('page'),
      source: { kind: 'source', sourceId: source.id, pageIndex },
      width: info?.width ?? PAGE_SIZES.A4.width,
      height: info?.height ?? PAGE_SIZES.A4.height,
      baseRotation: info?.rotation ?? 0,
      rotation: 0
    }
  })
  const i = clampIndex(index, doc.pages.length)
  const restored = withUniqueFieldNames(
    doc,
    restoredObjectsFor(source, newPages, new Set(doc.objects.map((o) => o.id)))
  )
  const restoredOcr = restoredOcrFor(source, newPages).ocr
  return {
    ...doc,
    primarySourceId: doc.primarySourceId ?? source.id,
    sources: { ...doc.sources, [source.id]: source },
    pages: [...doc.pages.slice(0, i), ...newPages, ...doc.pages.slice(i)],
    objects: restored.length ? [...doc.objects, ...restored] : doc.objects,
    ...(restoredOcr ? { ocr: { ...doc.ocr, ...restoredOcr } } : {})
  }
}

/** OCR results restored from `source` (SourcePageInfo.restoredOcr) for the given page entries. */
export function restoredOcrFor(source: SourceDocument, pages: PageEntry[]): Pick<EditorDocument, 'ocr'> {
  const ocr: NonNullable<EditorDocument['ocr']> = {}
  for (const page of pages) {
    if (page.source.kind !== 'source' || page.source.sourceId !== source.id) continue
    const result = source.pageInfo?.[page.source.pageIndex]?.restoredOcr
    if (result) ocr[page.id] = result
  }
  return Object.keys(ocr).length ? { ocr } : {}
}

/**
 * EditObjects restored from `source` (SourcePageInfo.restoredObjects) for the given page
 * entries, with their pageId set. Ids already in `taken` are replaced by fresh ones.
 */
export function restoredObjectsFor(source: SourceDocument, pages: PageEntry[], taken: Set<string>): EditObject[] {
  const out: EditObject[] = []
  for (const page of pages) {
    if (page.source.kind !== 'source' || page.source.sourceId !== source.id) continue
    for (const o of source.pageInfo?.[page.source.pageIndex]?.restoredObjects ?? []) {
      const id = taken.has(o.id) ? createId('obj') : o.id
      taken.add(id)
      out.push({ ...o, id, pageId: page.id } as EditObject)
    }
  }
  return out
}

/**
 * Give FieldObjects in `added` names that do not clash with fields already in the document
 * (other FieldObjects, the primary source's fields). Radio objects that shared a name keep
 * sharing their new name.
 */
function withUniqueFieldNames(doc: EditorDocument, added: EditObject[], alsoTaken: EditObject[] = []): EditObject[] {
  const fields = added.filter((o): o is FieldObject => o.type === 'field')
  if (!fields.length) return added
  const taken = new Set<string>()
  for (const o of [...doc.objects, ...alsoTaken]) if (o.type === 'field') taken.add(o.name)
  if (doc.primarySourceId) for (const f of getEffectiveFormFields(doc, doc.primarySourceId)) taken.add(f.name)
  const renamed = new Map<string, string>()
  for (const f of fields) {
    if (renamed.has(f.name) || !taken.has(f.name)) continue
    let n = 2
    while (taken.has(`${f.name}_${n}`)) n++
    renamed.set(f.name, `${f.name}_${n}`)
    taken.add(`${f.name}_${n}`)
  }
  if (!renamed.size) return added
  return added.map((o) => (o.type === 'field' && renamed.has(o.name) ? { ...o, name: renamed.get(o.name)! } : o))
}

export function addObject(doc: EditorDocument, obj: EditObject): EditorDocument {
  return { ...doc, objects: [...doc.objects, obj] }
}

/** Shallow-merge `patch` into the object with `id` (type and id cannot change). */
export function updateObject(doc: EditorDocument, id: string, patch: Partial<EditObject>): EditorDocument {
  return {
    ...doc,
    objects: doc.objects.map((o) =>
      o.id === id ? ({ ...o, ...patch, id: o.id, type: o.type } as EditObject) : o
    )
  }
}

export function removeObject(doc: EditorDocument, id: string): EditorDocument {
  return { ...doc, objects: doc.objects.filter((o) => o.id !== id) }
}

/** Move an object to the top or bottom of the z-order. */
export function reorderObject(doc: EditorDocument, id: string, to: 'front' | 'back'): EditorDocument {
  const obj = doc.objects.find((o) => o.id === id)
  if (!obj) return { ...doc }
  const rest = doc.objects.filter((o) => o.id !== id)
  return { ...doc, objects: to === 'front' ? [...rest, obj] : [obj, ...rest] }
}

export function setFormValue(
  doc: EditorDocument,
  sourceId: string,
  fieldName: string,
  value: FormValue
): EditorDocument {
  const forSource = doc.formValues[sourceId] ?? {}
  return {
    ...doc,
    formValues: {
      ...doc.formValues,
      [sourceId]: { ...forSource, [fieldName]: Array.isArray(value) ? [...value] : value }
    }
  }
}

/** Shallow-merge into doc.settings (metadata is merged one level deeper). */
export function updateSettings(doc: EditorDocument, patch: Partial<DocumentSettings>): EditorDocument {
  const settings: DocumentSettings = {
    ...doc.settings,
    ...patch,
    metadata: patch.metadata ? { ...doc.settings.metadata, ...patch.metadata } : doc.settings.metadata
  }
  return { ...doc, settings }
}

export function getObjectsForPage(doc: EditorDocument, pageId: string): EditObject[] {
  return doc.objects.filter((o) => o.pageId === pageId)
}

/** Current value of a form field: user value if set, else the value stored in the file. */
export function getFormValue(doc: EditorDocument, sourceId: string, fieldName: string): FormValue | undefined {
  const user = doc.formValues[sourceId]
  if (user && Object.prototype.hasOwnProperty.call(user, fieldName)) return user[fieldName]
  return doc.sources[sourceId]?.formFields.find((f) => f.name === fieldName)?.value
}

// ---------------------------------------------------------------------------------------------
// Existing content, annotations and form fields

function mergeEdit<E extends object>(edits: E[] | undefined, match: (e: E) => boolean, next: E): E[] {
  const list = edits ?? []
  const i = list.findIndex(match)
  return i < 0 ? [...list, next] : list.map((e, j) => (j === i ? next : e))
}

/**
 * Merge `patch` into the edit of an existing content item (see getContentItems). Fields set to
 * undefined in the patch are removed. An edit that ends up empty is dropped.
 */
export function editContentItem(
  doc: EditorDocument,
  pageId: string,
  itemId: string,
  patch: Partial<Omit<ContentEdit, 'itemId'>>
): EditorDocument {
  const current = getContentEdit(doc, pageId, itemId) ?? { itemId }
  const next = dropUndefined({ ...current, ...patch, itemId })
  const edits = mergeEdit(doc.contentEdits?.[pageId], (e) => e.itemId === itemId, next).filter(
    (e) => Object.keys(e).length > 1
  )
  return { ...doc, contentEdits: { ...doc.contentEdits, [pageId]: edits } }
}

export function getContentEdit(doc: EditorDocument, pageId: string, itemId: string): ContentEdit | undefined {
  return doc.contentEdits?.[pageId]?.find((e) => e.itemId === itemId)
}

/** Merge `patch` into the edit of an existing annotation. Fields set to undefined are removed. */
export function editAnnotation(
  doc: EditorDocument,
  pageId: string,
  annotId: string,
  patch: Partial<Omit<AnnotationEdit, 'annotId'>>
): EditorDocument {
  const current = getAnnotationEdit(doc, pageId, annotId) ?? { annotId }
  const next = dropUndefined({ ...current, ...patch, annotId })
  const edits = mergeEdit(doc.annotationEdits?.[pageId], (e) => e.annotId === annotId, next).filter(
    (e) => Object.keys(e).length > 1
  )
  return { ...doc, annotationEdits: { ...doc.annotationEdits, [pageId]: edits } }
}

export function getAnnotationEdit(doc: EditorDocument, pageId: string, annotId: string): AnnotationEdit | undefined {
  return doc.annotationEdits?.[pageId]?.find((e) => e.annotId === annotId)
}

/** Existing annotations of a page as they currently are (edits applied, deleted ones left out). */
export function getPageAnnotations(doc: EditorDocument, pageId: string): AnnotationInfo[] {
  const page = doc.pages.find((p) => p.id === pageId)
  if (!page || page.source.kind !== 'source') return []
  const info = doc.sources[page.source.sourceId]?.pageInfo?.[page.source.pageIndex]
  const out: AnnotationInfo[] = []
  for (const a of info?.annotations ?? []) {
    const edit = getAnnotationEdit(doc, pageId, a.id)
    if (edit?.deleted) continue
    if (!edit) {
      out.push(a)
      continue
    }
    const { annotId: _id, deleted: _deleted, ...changes } = edit
    out.push({ ...a, ...changes })
  }
  return out
}

/** Merge `patch` into the structural edit of an existing form field (keyed by its original name). */
export function editField(
  doc: EditorDocument,
  sourceId: string,
  fieldName: string,
  patch: Partial<FieldEdit>
): EditorDocument {
  const forSource = doc.fieldEdits?.[sourceId] ?? {}
  const next = dropUndefined({ ...forSource[fieldName], ...patch })
  const nextForSource = { ...forSource, [fieldName]: next }
  if (!Object.keys(next).length) delete nextForSource[fieldName]
  return { ...doc, fieldEdits: { ...doc.fieldEdits, [sourceId]: nextForSource } }
}

export function getFieldEdit(doc: EditorDocument, sourceId: string, fieldName: string): FieldEdit | undefined {
  return doc.fieldEdits?.[sourceId]?.[fieldName]
}

/** A source's form fields as they currently are: edits applied, deleted fields left out. */
export interface EffectiveFormField extends FormFieldInfo {
  /** Name in the source file; the key for formValues, fieldEdits and setFormValue. */
  originalName: string
  fontSize?: number
}

export function getEffectiveFormFields(doc: EditorDocument, sourceId: string): EffectiveFormField[] {
  const fields = doc.sources[sourceId]?.formFields ?? []
  const out: EffectiveFormField[] = []
  for (const f of fields) {
    const edit = getFieldEdit(doc, sourceId, f.name)
    if (edit?.deleted) continue
    if (!edit) {
      out.push({ ...f, originalName: f.name })
      continue
    }
    const deletedWidgets = new Set(edit.deletedWidgets ?? [])
    const widgets = f.widgets
      .map((w, i) => (edit.widgetBoxes?.[i] ? { ...w, box: edit.widgetBoxes[i] as Box } : w))
      .filter((_, i) => !deletedWidgets.has(i))
    // Deleting the last widget deletes the field.
    if (f.widgets.length && !widgets.length) continue
    const field: EffectiveFormField = {
      ...f,
      originalName: f.name,
      name: edit.name ?? f.name,
      widgets,
      readOnly: edit.readOnly ?? f.readOnly,
      required: edit.required ?? f.required,
      multiline: edit.multiline ?? f.multiline,
      maxLength: edit.maxLength === null ? undefined : (edit.maxLength ?? f.maxLength),
      options: edit.options ?? f.options,
      optionLabels: edit.optionLabels === null ? undefined : (edit.optionLabels ?? f.optionLabels)
    }
    if (edit.fontSize !== undefined) field.fontSize = edit.fontSize
    out.push(field)
  }
  return out
}

/**
 * True when the page must be displayed from renderPagePreview() instead of its source page:
 * it has content or annotation edits, hides drawings of restored objects, or has deleted or
 * moved form widgets.
 */
export function pageNeedsPreview(doc: EditorDocument, pageId: string): boolean {
  if (doc.contentEdits?.[pageId]?.length || doc.annotationEdits?.[pageId]?.length) return true
  const page = doc.pages.find((p) => p.id === pageId)
  if (!page || page.source.kind !== 'source') return false
  const { sourceId, pageIndex } = page.source
  const source = doc.sources[sourceId]
  if (source?.pageInfo?.[pageIndex]?.restoredObjectIds?.length) return true
  // Deleted fields and moved widgets on this page: pdf.js would still paint the old widgets.
  for (const [name, edit] of Object.entries(doc.fieldEdits?.[sourceId] ?? {})) {
    if (!edit.deleted && !edit.widgetBoxes && !edit.deletedWidgets?.length) continue
    const widgets = source?.formFields.find((f) => f.name === name)?.widgets ?? []
    const touched = (i: number) => !!edit.deleted || !!edit.widgetBoxes?.[i] || !!edit.deletedWidgets?.includes(i)
    if (widgets.some((w, i) => w.pageIndex === pageIndex && touched(i))) return true
  }
  return false
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
