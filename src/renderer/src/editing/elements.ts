/**
 * Existing page elements (content items, annotations, form field widgets) as selectable,
 * movable things. Pure functions over the document; the overlay supplies loaded content items.
 */
import {
  editAnnotation,
  editContentItem,
  editField,
  getContentEdit,
  getPageAnnotations,
  type AnnotationInfo,
  type Box,
  type ContentEdit,
  type ContentItem,
  type EditorDocument,
  type Matrix,
  type Point
} from '@core'
import type { ElementRef } from '@renderer/state/store'
import {
  boxToBox,
  IDENTITY,
  invert,
  isIdentity,
  multiply,
  placedRect,
  rectBox,
  rectFromBox,
  rectToRect,
  rotationAround,
  roundMatrix,
  translation,
  type RotRect
} from './elementGeometry'
import { widgetsOnPage, type WidgetEntry } from './fields'
import { resizeBox, rotationFromPointer, round2, type ResizeHandle } from './manip'
import { measureContentText } from './textLayout'

export type ElementGeom =
  | { kind: 'content'; item: ContentItem; edit?: ContentEdit; transform: Matrix }
  | { kind: 'annotation'; annot: AnnotationInfo; box: Box }
  | { kind: 'field'; entry: WidgetEntry; box: Box }

/** A pending geometry change: a new total transform (content) or a new box (others). */
export type ElementChange = { transform: Matrix } | { box: Box }

export function sameRef(a: ElementRef | null | undefined, b: ElementRef | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind || a.pageId !== b.pageId) return false
  switch (a.kind) {
    case 'content':
      return a.itemId === (b as typeof a).itemId
    case 'annotation':
      return a.annotId === (b as typeof a).annotId
    case 'field':
      return a.sourceId === (b as typeof a).sourceId && a.fieldName === (b as typeof a).fieldName && a.widgetIndex === (b as typeof a).widgetIndex
  }
}

export function refKey(ref: ElementRef): string {
  switch (ref.kind) {
    case 'content':
      return `content:${ref.pageId}:${ref.itemId}`
    case 'annotation':
      return `annot:${ref.pageId}:${ref.annotId}`
    case 'field':
      return `field:${ref.sourceId}:${ref.fieldName}#${ref.widgetIndex}`
  }
}

/** Transform of the nearest ancestor container (form XObject, ids "x1/…") that has one. */
export function ancestorTransform(doc: EditorDocument, pageId: string, itemId: string): Matrix {
  const parts = itemId.split('/')
  for (let k = parts.length - 1; k >= 1; k--) {
    const t = getContentEdit(doc, pageId, parts.slice(0, k).join('/'))?.transform
    if (t) return t
  }
  return IDENTITY
}

/**
 * Current placement of a content item. Items inside a moved container follow it unless they
 * have their own transform (edited items are redrawn separately by the engine, in page space).
 */
export function effectiveTransform(doc: EditorDocument, pageId: string, itemId: string): Matrix {
  return getContentEdit(doc, pageId, itemId)?.transform ?? ancestorTransform(doc, pageId, itemId)
}

/** Apply `m` (page space) to the edited descendants of a container so they move with it. */
function moveEditedDescendants(before: EditorDocument, doc: EditorDocument, pageId: string, containerId: string, m: Matrix): EditorDocument {
  if (isIdentity(m)) return doc
  let d = doc
  for (const e of before.contentEdits?.[pageId] ?? []) {
    if (e.deleted || !e.itemId.startsWith(containerId + '/')) continue
    const t = multiply(m, effectiveTransform(before, pageId, e.itemId))
    d = editContentItem(d, pageId, e.itemId, { transform: isIdentity(t) ? undefined : roundMatrix(t) })
  }
  return d
}

/**
 * editContentItem for non-geometry changes (text, colour, size): an item inside a moved
 * container gets that placement recorded, because edited items no longer follow the container.
 */
export function editContent(doc: EditorDocument, pageId: string, itemId: string, patch: Partial<Omit<ContentEdit, 'itemId'>>): EditorDocument {
  if (!('transform' in patch) && !getContentEdit(doc, pageId, itemId)?.transform) {
    const a = ancestorTransform(doc, pageId, itemId)
    if (!isIdentity(a)) patch = { ...patch, transform: a }
  }
  return editContentItem(doc, pageId, itemId, patch)
}

export function resolveElement(doc: EditorDocument, ref: ElementRef, items?: ContentItem[]): ElementGeom | null {
  switch (ref.kind) {
    case 'content': {
      const item = items?.find((i) => i.id === ref.itemId)
      if (!item) return null
      const edit = getContentEdit(doc, ref.pageId, ref.itemId)
      if (edit?.deleted) return null
      return { kind: 'content', item, edit, transform: effectiveTransform(doc, ref.pageId, ref.itemId) }
    }
    case 'annotation': {
      const annot = getPageAnnotations(doc, ref.pageId).find((a) => a.id === ref.annotId)
      return annot ? { kind: 'annotation', annot, box: annot.bounds } : null
    }
    case 'field': {
      const page = doc.pages.find((p) => p.id === ref.pageId)
      if (!page) return null
      const entry = widgetsOnPage(doc, page).find(
        (e) => e.sourceId === ref.sourceId && e.field.originalName === ref.fieldName && e.index === ref.widgetIndex
      )
      return entry ? { kind: 'field', entry, box: entry.widget.box } : null
    }
  }
}

/** Current rectangle of an element, optionally with a pending change applied. */
export function elementRect(g: ElementGeom, change?: ElementChange | null): RotRect {
  if (g.kind === 'content') {
    const t = change && 'transform' in change ? change.transform : g.transform
    return placedRect(g.item, t, g.edit, measureContentText)
  }
  return rectFromBox(change && 'box' in change ? change.box : g.box)
}

export function canRotate(g: ElementGeom): boolean {
  return g.kind === 'content'
}

/** Images and form XObjects keep their aspect ratio unless Shift is held. */
export function keepsAspect(g: ElementGeom, shift: boolean): boolean {
  if (g.kind === 'content' && (g.item.kind === 'image' || g.item.kind === 'xobject')) return !shift
  return shift
}

export function moveChange(g: ElementGeom, dx: number, dy: number): ElementChange {
  if (g.kind === 'content') return { transform: multiply(translation(dx, dy), g.transform) }
  return { box: { ...g.box, x: g.box.x + dx, y: g.box.y + dy } }
}

export function resizeChange(
  g: ElementGeom,
  handle: ResizeHandle,
  pointer: Point,
  shift: boolean,
  minSize: number
): ElementChange {
  const rect = elementRect(g)
  const nb = resizeBox(rectBox(rect), rect.angle, handle, pointer, keepsAspect(g, shift), minSize)
  if (g.kind === 'content') {
    const to = rectFromBox(nb, rect.angle)
    return { transform: multiply(rectToRect(rect, to), g.transform) }
  }
  return { box: nb }
}

export function rotateChange(g: ElementGeom, pointer: Point, snap: boolean): ElementChange | null {
  if (g.kind !== 'content') return null
  const rect = elementRect(g)
  const target = rotationFromPointer({ x: rect.cx, y: rect.cy }, pointer, snap)
  const delta = target - rect.angle
  return { transform: multiply(rotationAround({ x: rect.cx, y: rect.cy }, delta), g.transform) }
}

/** Set an element's geometry to a given axis-aligned box (properties panel X/Y/W/H). */
export function boxChange(g: ElementGeom, to: Box): ElementChange {
  if (g.kind === 'content') {
    const rect = elementRect(g)
    const from = rectBox(rect)
    if (rect.angle) return { transform: multiply(translation(to.x - from.x, to.y - from.y), g.transform) }
    return { transform: multiply(boxToBox(from, to), g.transform) }
  }
  return { box: to }
}

function roundBox(b: Box): Box {
  return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) }
}

export function applyElementChange(doc: EditorDocument, ref: ElementRef, g: ElementGeom, change: ElementChange): EditorDocument {
  switch (g.kind) {
    case 'content': {
      if (!('transform' in change)) return doc
      const t = isIdentity(change.transform) ? undefined : roundMatrix(change.transform)
      const next = editContentItem(doc, ref.pageId, g.item.id, { transform: t })
      // Edited items inside a moved container are drawn on their own: move them along.
      return moveEditedDescendants(doc, next, ref.pageId, g.item.id, multiply(change.transform, invert(g.transform)))
    }
    case 'annotation':
      if (!('box' in change)) return doc
      return editAnnotation(doc, ref.pageId, g.annot.id, { bounds: roundBox(change.box) })
    case 'field': {
      if (!('box' in change)) return doc
      const boxes = g.entry.field.widgets.map((w, i) => (i === g.entry.index ? roundBox(change.box) : w.box))
      return editField(doc, g.entry.sourceId, g.entry.field.originalName, { widgetBoxes: boxes })
    }
  }
}

export function deleteElement(doc: EditorDocument, ref: ElementRef): EditorDocument {
  switch (ref.kind) {
    case 'content':
      return editContentItem(doc, ref.pageId, ref.itemId, { deleted: true })
    case 'annotation':
      return editAnnotation(doc, ref.pageId, ref.annotId, { deleted: true })
    case 'field':
      return editField(doc, ref.sourceId, ref.fieldName, { deleted: true })
  }
}

/** Remove every edit of an element (back to the original). */
export function resetElement(doc: EditorDocument, ref: ElementRef): EditorDocument {
  switch (ref.kind) {
    case 'content': {
      const own = getContentEdit(doc, ref.pageId, ref.itemId)?.transform
      const next = editContentItem(doc, ref.pageId, ref.itemId, {
        deleted: undefined,
        transform: undefined,
        text: undefined,
        color: undefined,
        fontSize: undefined
      })
      // A container moved back takes its edited items back too.
      if (!own) return next
      const back = multiply(ancestorTransform(doc, ref.pageId, ref.itemId), invert(own))
      return moveEditedDescendants(doc, next, ref.pageId, ref.itemId, back)
    }
    case 'annotation':
      return editAnnotation(doc, ref.pageId, ref.annotId, {
        deleted: undefined,
        bounds: undefined,
        contents: undefined,
        author: undefined,
        color: undefined,
        uri: undefined
      })
    case 'field': {
      const forSource = { ...doc.fieldEdits?.[ref.sourceId] }
      delete forSource[ref.fieldName]
      return { ...doc, fieldEdits: { ...doc.fieldEdits, [ref.sourceId]: forSource } }
    }
  }
}

export function hasEdit(doc: EditorDocument, ref: ElementRef): boolean {
  switch (ref.kind) {
    case 'content':
      return !!getContentEdit(doc, ref.pageId, ref.itemId)
    case 'annotation':
      return !!doc.annotationEdits?.[ref.pageId]?.some((e) => e.annotId === ref.annotId)
    case 'field':
      return !!doc.fieldEdits?.[ref.sourceId]?.[ref.fieldName]
  }
}

export const CONTENT_KIND_LABELS: Record<ContentItem['kind'], string> = {
  text: 'Text',
  image: 'Image',
  path: 'Vector graphic',
  xobject: 'Embedded graphic',
  shading: 'Gradient'
}
