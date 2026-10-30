/**
 * Pure operations on the redaction areas of an EditorDocument (see RedactionArea). The areas
 * are applied by exportDocument() (redaction.ts).
 */
import { createId } from './ids'
import type { Box, Color, EditorDocument, RedactionArea } from './model'

export const DEFAULT_REDACTION_FILL: Color = '#000000'

export function newRedactionId(): string {
  return createId('redact')
}

export function getRedactions(doc: EditorDocument): RedactionArea[] {
  return doc.redactions ?? []
}

export function getRedactionsForPage(doc: EditorDocument, pageId: string): RedactionArea[] {
  return (doc.redactions ?? []).filter((r) => r.pageId === pageId)
}

/** Areas on pages that exist in the document (areas of deleted pages are ignored). */
export function activeRedactions(doc: EditorDocument, pageIds?: Iterable<string>): RedactionArea[] {
  const ids = new Set(pageIds ?? doc.pages.map((p) => p.id))
  return (doc.redactions ?? []).filter((r) => ids.has(r.pageId) && r.width > 0 && r.height > 0)
}

export function addRedactions(doc: EditorDocument, areas: RedactionArea[]): EditorDocument {
  if (!areas.length) return doc
  return { ...doc, redactions: [...(doc.redactions ?? []), ...areas] }
}

export function updateRedaction(
  doc: EditorDocument,
  id: string,
  patch: Partial<Omit<RedactionArea, 'id' | 'pageId'>>
): EditorDocument {
  const list = doc.redactions ?? []
  const i = list.findIndex((r) => r.id === id)
  if (i < 0) return doc
  const next = { ...list[i], ...patch }
  if (Object.keys(patch).every((k) => (list[i] as unknown as Record<string, unknown>)[k] === (patch as Record<string, unknown>)[k])) return doc
  return { ...doc, redactions: [...list.slice(0, i), next, ...list.slice(i + 1)] }
}

export function removeRedactions(doc: EditorDocument, ids: Iterable<string>): EditorDocument {
  const set = new Set(ids)
  const list = doc.redactions ?? []
  const next = list.filter((r) => !set.has(r.id))
  return next.length === list.length ? doc : { ...doc, redactions: next }
}

/** A redaction area for `box` on `pageId` (fill defaults to black). */
export function makeRedaction(pageId: string, box: Box, options: { fillColor?: Color | null; overlayText?: string } = {}): RedactionArea {
  const area: RedactionArea = {
    id: newRedactionId(),
    pageId,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    fillColor: options.fillColor === undefined ? DEFAULT_REDACTION_FILL : options.fillColor
  }
  if (options.overlayText) area.overlayText = options.overlayText
  return area
}
