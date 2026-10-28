/**
 * Pure, immutable operations on EditorDocument. Each returns a NEW document and never
 * mutates its input (unchanged parts are shared structurally).
 */
import { createId } from './ids'
import { displaySize, normalizeRotation } from './geometry'
import {
  PAGE_SIZES,
  type DocumentSettings,
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
    objects: doc.objects.filter((o) => !ids.has(o.pageId))
  }
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
  for (const p of doc.pages) {
    pages.push(p)
    if (!ids.has(p.id)) continue
    const copy: PageEntry = { ...p, id: createId('page') }
    pages.push(copy)
    for (const o of doc.objects) {
      if (o.pageId === p.id) newObjects.push({ ...o, id: createId('obj'), pageId: copy.id })
    }
  }
  return { ...doc, pages, objects: newObjects.length ? [...doc.objects, ...newObjects] : doc.objects }
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
  return {
    ...doc,
    primarySourceId: doc.primarySourceId ?? source.id,
    sources: { ...doc.sources, [source.id]: source },
    pages: [...doc.pages.slice(0, i), ...newPages, ...doc.pages.slice(i)]
  }
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
