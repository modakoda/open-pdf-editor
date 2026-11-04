/**
 * Existing page elements (content items, annotations, form field widgets) as selectable,
 * movable things. Pure functions over the document; the overlay supplies loaded content items.
 */
import {
  editAnnotation,
  editContentItem,
  editField,
  getContentEdit,
  getFieldEdit,
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
  boundsOfPoints,
  boxToBox,
  IDENTITY,
  invert,
  isIdentity,
  multiply,
  placedQuad,
  placedRect,
  rectBox,
  rectFromBox,
  rectToRect,
  rotationAround,
  roundMatrix,
  translation,
  type RotRect
} from './elementGeometry'
import { currentWidgets, widgetsOnPage, type WidgetEntry } from './fields'
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

/** An item is gone when it, or a container it is inside (ids "x1/…"), was deleted. */
export function isContentDeleted(doc: EditorDocument, pageId: string, itemId: string): boolean {
  const parts = itemId.split('/')
  for (let k = parts.length; k >= 1; k--) {
    if (getContentEdit(doc, pageId, parts.slice(0, k).join('/'))?.deleted) return true
  }
  return false
}

export function resolveElement(doc: EditorDocument, ref: ElementRef, items?: ContentItem[]): ElementGeom | null {
  switch (ref.kind) {
    case 'content': {
      const item = items?.find((i) => i.id === ref.itemId)
      if (!item) return null
      if (isContentDeleted(doc, ref.pageId, ref.itemId)) return null
      const edit = getContentEdit(doc, ref.pageId, ref.itemId)
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

/** Axis-aligned bounds of an element as shown in the properties panel (X/Y/W/H). */
export function elementBounds(g: ElementGeom): Box {
  if (g.kind !== 'content') return g.box
  return boundsOfPoints(placedQuad(g.item, g.transform, g.edit, measureContentText))
}

/**
 * Set an element's axis-aligned bounds (properties panel X/Y/W/H). Rotated content cannot be
 * stretched along the page axes without skewing it: a W or H change scales it uniformly,
 * keeping the bounds' top-left corner.
 */
export function boxChange(g: ElementGeom, to: Box): ElementChange {
  if (g.kind !== 'content') return { box: to }
  const from = elementBounds(g)
  // Multiples of 90° stay axis-aligned and can be stretched like unrotated items.
  const a = ((elementRect(g).angle % 90) + 90) % 90
  const rotated = a > 1e-6 && 90 - a > 1e-6
  const sizeChanged = Math.abs(to.width - from.width) > 1e-6 || Math.abs(to.height - from.height) > 1e-6
  if (!sizeChanged) return { transform: multiply(translation(to.x - from.x, to.y - from.y), g.transform) }
  if (!rotated) return { transform: multiply(boxToBox(from, to), g.transform) }
  const f = Math.abs(to.width - from.width) > 1e-6 ? (from.width ? to.width / from.width : 1) : from.height ? to.height / from.height : 1
  const m: Matrix = [f, 0, 0, f, to.x - from.x * f, to.y - from.y * f]
  return { transform: multiply(m, g.transform) }
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
      const { sourceId, field, index } = g.entry
      const src = doc.sources[sourceId]?.formFields.find((f) => f.name === field.originalName)
      if (!src) return doc
      const edited = getFieldEdit(doc, sourceId, field.originalName)?.widgetBoxes
      // widgetBoxes is aligned with the SOURCE widgets (deleted ones keep their slot).
      const boxes = src.widgets.map((w, i) => (i === index ? roundBox(change.box) : (edited?.[i] ?? w.box)))
      return editField(doc, sourceId, field.originalName, { widgetBoxes: boxes })
    }
  }
}

export function deleteElement(doc: EditorDocument, ref: ElementRef): EditorDocument {
  switch (ref.kind) {
    case 'content':
      return editContentItem(doc, ref.pageId, ref.itemId, { deleted: true })
    case 'annotation':
      return editAnnotation(doc, ref.pageId, ref.annotId, { deleted: true })
    case 'field': {
      // Deleting one widget (e.g. one radio button) keeps the field, unless it was the last one.
      const remaining = currentWidgets(doc, ref.sourceId, ref.fieldName).filter((w) => w.index !== ref.widgetIndex)
      if (!remaining.length) return deleteField(doc, ref.sourceId, ref.fieldName)
      const deleted = getFieldEdit(doc, ref.sourceId, ref.fieldName)?.deletedWidgets ?? []
      return editField(doc, ref.sourceId, ref.fieldName, { deletedWidgets: [...new Set([...deleted, ref.widgetIndex])].sort((a, b) => a - b) })
    }
  }
}

export function deleteField(doc: EditorDocument, sourceId: string, originalName: string): EditorDocument {
  return editField(doc, sourceId, originalName, { deleted: true })
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
        fontSize: undefined,
        z: undefined
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

// ---------------------------------------------------------------------------------------------
// Stacking order of existing content

export type ZOrderCommand = 'front' | 'forward' | 'backward' | 'back'

/** The form XObject item a content item is drawn by ("x1" for "x1/t3"; '' for page level). */
export function contentContainer(itemId: string): string {
  const parts = itemId.split('/')
  for (let k = parts.length - 1; k >= 1; k--) if (/^x\d+$/.test(parts[k - 1])) return parts.slice(0, k).join('/')
  return ''
}

/**
 * The items an item can be re-ordered among (same container, not deleted) in their current
 * stacking order, with their ContentEdit.z sort keys (item i of `items` has key i by default).
 */
function stackingOrder(doc: EditorDocument, pageId: string, items: ContentItem[], itemId: string) {
  const container = contentContainer(itemId)
  return items
    .map((item, i) => ({ item, i, key: getContentEdit(doc, pageId, item.id)?.z ?? i }))
    .filter((e) => contentContainer(e.item.id) === container && !isContentDeleted(doc, pageId, e.item.id))
    .sort((a, b) => a.key - b.key || a.i - b.i)
}

function placedBounds(doc: EditorDocument, pageId: string, item: ContentItem): Box {
  const transform = effectiveTransform(doc, pageId, item.id)
  return boundsOfPoints(placedQuad(item, transform, getContentEdit(doc, pageId, item.id), measureContentText))
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1e-6

/** The new sort key for a z-order command; undefined when it changes nothing. */
function zFor(doc: EditorDocument, pageId: string, items: ContentItem[], itemId: string, cmd: ZOrderCommand): number | undefined {
  const order = stackingOrder(doc, pageId, items, itemId)
  const at = order.findIndex((e) => e.item.id === itemId)
  if (at < 0 || order[at].item.readOnly) return undefined
  const last = order.length - 1
  const between = (lo: number, hi: number) => {
    const z = (lo + hi) / 2
    return z > lo && z < hi ? z : undefined
  }
  switch (cmd) {
    case 'front':
      return at < last ? order[last].key + 1 : undefined
    case 'back':
      return at > 0 ? order[0].key - 1 : undefined
    case 'forward': {
      // Above the next item it overlaps (moving past others changes nothing visible).
      const own = placedBounds(doc, pageId, order[at].item)
      const j = order.findIndex((e, j) => j > at && overlaps(own, placedBounds(doc, pageId, e.item)))
      if (j < 0) return undefined
      return j < last ? between(order[j].key, order[j + 1].key) : order[j].key + 1
    }
    case 'backward': {
      const own = placedBounds(doc, pageId, order[at].item)
      let j = at - 1
      while (j >= 0 && !overlaps(own, placedBounds(doc, pageId, order[j].item))) j--
      if (j < 0) return undefined
      return j > 0 ? between(order[j - 1].key, order[j].key) : order[j].key - 1
    }
  }
}

/** Whether a z-order command would change the stacking order of an existing content item. */
export function canReorderContent(doc: EditorDocument, pageId: string, items: ContentItem[], itemId: string, cmd: ZOrderCommand): boolean {
  return zFor(doc, pageId, items, itemId, cmd) !== undefined
}

/**
 * Bring an existing content item to the front / forward (above the next item it overlaps),
 * or send it backward / to the back, among the items of its page or form XObject (`items`:
 * the page's content items). Returns `doc` when nothing changes.
 */
export function reorderContent(doc: EditorDocument, pageId: string, items: ContentItem[], itemId: string, cmd: ZOrderCommand): EditorDocument {
  const z = zFor(doc, pageId, items, itemId, cmd)
  return z === undefined ? doc : editContent(doc, pageId, itemId, { z })
}

export const CONTENT_KIND_LABELS: Record<ContentItem['kind'], string> = {
  text: 'Text',
  image: 'Image',
  path: 'Vector graphic',
  xobject: 'Embedded graphic',
  shading: 'Gradient'
}
