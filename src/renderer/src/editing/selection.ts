/** Actions on the current selection (an EditObject or an existing element), shared by panel and shortcuts. */
import { updateObject, type EditorDocument, type Point } from '@core'
import { useEditor, type ElementRef } from '@renderer/state/store'
import { getLoadedContentItems } from './contentItems'
import { useEditing } from './editingState'
import { applyElementChange, deleteElement, moveChange, resolveElement, type ElementChange, type ElementGeom } from './elements'
import { translatePatch } from './manip'
import { deleteSelected, findObject } from './objects'
import { ensureElementPreview } from './previews'

/** Geometry of an element, using content items already loaded by the page's overlay. */
export function resolveSelected(doc: EditorDocument, ref: ElementRef): ElementGeom | null {
  const page = doc.pages.find((p) => p.id === ref.pageId)
  return page ? resolveElement(doc, ref, getLoadedContentItems(doc, page)) : null
}

/** Delete whatever is selected: an object, existing content, an annotation or a form field. */
export function deleteSelection(): boolean {
  const s = useEditor.getState()
  if (!s.doc) return false
  if (s.selectedObjectId) return deleteSelected()
  const ref = s.selectedElement
  if (!ref) return false
  if (ref.kind === 'content') useEditing.getState().setEditingContent(null)
  ensureElementPreview(ref)
  s.apply((d) => deleteElement(d, ref))
  useEditor.getState().selectElement(null)
  return true
}

/** Apply a geometry change to an element as one (optionally coalesced) undo step. */
export function changeElement(ref: ElementRef, make: (g: ElementGeom) => ElementChange | null, coalesceKey?: string): boolean {
  const s = useEditor.getState()
  if (!s.doc) return false
  const g = resolveSelected(s.doc, ref)
  if (!g) return false
  const change = make(g)
  if (!change) return false
  ensureElementPreview(ref)
  s.apply((d) => applyElementChange(d, ref, g, change), coalesceKey ? { coalesceKey } : undefined)
  return true
}

/** Move the selection by a page-space delta (keyboard nudging, coalesced). */
export function nudgeSelection(d: Point): boolean {
  const s = useEditor.getState()
  if (!s.doc) return false
  const obj = findObject(s.doc, s.selectedObjectId)
  if (obj) {
    s.apply(
      (doc) => {
        const cur = doc.objects.find((o) => o.id === obj.id)
        return cur ? updateObject(doc, obj.id, translatePatch(cur, d.x, d.y)) : doc
      },
      { coalesceKey: `nudge:${obj.id}` }
    )
    return true
  }
  const ref = s.selectedElement
  if (!ref) return false
  return changeElement(ref, (g) => moveChange(g, d.x, d.y), `nudge:${JSON.stringify(ref)}`)
}

/** Page of the current selection (for converting screen-direction nudges). */
export function selectionPageId(): string | null {
  const s = useEditor.getState()
  const obj = findObject(s.doc, s.selectedObjectId)
  return obj?.pageId ?? s.selectedElement?.pageId ?? null
}
