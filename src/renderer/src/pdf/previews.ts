/**
 * Preview documents for pages whose existing content changed (core pageNeedsPreview): such a
 * page is displayed from the one-page PDF produced by core renderPagePreview() instead of its
 * source page. One preview is kept per page (the latest edit state, identified by a cheap
 * fingerprint of that page's edits); older ones are destroyed, and at most MAX_PREVIEWS
 * documents are kept alive.
 */
import { pageNeedsPreview, renderPagePreview, type EditorDocument, type PageEntry } from '@core'
import { openPdfBytes, type PDFPageProxy } from './pdfjs'

const MAX_PREVIEWS = 24

type LoadingTask = ReturnType<typeof openPdfBytes>

interface PreviewEntry {
  key: string
  task: LoadingTask | null
  page: Promise<PDFPageProxy>
  destroyed: boolean
  lastUsed: number
}

const previews = new Map<string, PreviewEntry>()
const failed = new Set<string>()
let useCounter = 0

/** Thrown (as a rejection) when a newer preview of the same page superseded this one. */
export class PreviewCancelledError extends Error {
  override name = 'RenderingCancelledException'
  constructor() {
    super('Preview cancelled')
  }
}

/** 32-bit FNV-1a, as a short base-36 string. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Fingerprint of everything that changes the page's preview, or null when the page is shown
 * from its source page. Cheap: only this page's edits are serialized.
 */
export function previewKeyFor(doc: EditorDocument, page: PageEntry): string | null {
  if (page.source.kind !== 'source') return null
  let needed = false
  try {
    needed = pageNeedsPreview(doc, page.id)
  } catch {
    return null
  }
  if (!needed) return null
  const { sourceId, pageIndex } = page.source
  const source = doc.sources[sourceId]
  const restored = source?.pageInfo?.[pageIndex]?.restoredObjectIds?.join(',') ?? ''
  const edits = JSON.stringify([
    doc.contentEdits?.[page.id] ?? null,
    doc.annotationEdits?.[page.id] ?? null,
    restored,
    widgetEditsOnPage(doc, sourceId, pageIndex)
  ])
  return `${sourceId}:${pageIndex}:${edits.length}:${hash(edits)}`
}

/**
 * Field edits that change how this page's widgets are painted in the preview (field deleted,
 * widget moved or removed), limited to widgets on this source page.
 */
function widgetEditsOnPage(doc: EditorDocument, sourceId: string, pageIndex: number): unknown[] {
  const edits = doc.fieldEdits?.[sourceId]
  if (!edits) return []
  const fields = doc.sources[sourceId]?.formFields ?? []
  const out: unknown[] = []
  for (const name of Object.keys(edits).sort()) {
    const edit = edits[name]
    if (!edit.deleted && !edit.widgetBoxes && !edit.deletedWidgets?.length) continue
    const widgets = fields.find((f) => f.name === name)?.widgets ?? []
    const onPage = widgets.map((w, i) => (w.pageIndex === pageIndex ? i : -1)).filter((i) => i >= 0)
    if (!onPage.length) continue
    out.push([
      name,
      edit.deleted ? 1 : 0,
      onPage.map((i) => edit.widgetBoxes?.[i] ?? null),
      onPage.filter((i) => edit.deletedWidgets?.includes(i))
    ])
  }
  return out
}

function destroy(entry: PreviewEntry): void {
  entry.destroyed = true
  entry.task?.destroy().catch(() => undefined)
}

function evict(): void {
  if (previews.size <= MAX_PREVIEWS) return
  const oldest = [...previews.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [pageId, entry] of oldest.slice(0, previews.size - MAX_PREVIEWS)) {
    previews.delete(pageId)
    destroy(entry)
  }
}

/** pdf.js page 1 of the preview document for `pageId` in the edit state identified by `key`. */
export function getPreviewPage(doc: EditorDocument, pageId: string, key: string): Promise<PDFPageProxy> {
  const existing = previews.get(pageId)
  if (existing && existing.key === key && !existing.destroyed) {
    existing.lastUsed = ++useCounter
    return existing.page
  }
  if (existing) {
    previews.delete(pageId)
    destroy(existing)
  }
  const entry: PreviewEntry = { key, task: null, page: Promise.resolve(null as unknown as PDFPageProxy), destroyed: false, lastUsed: ++useCounter }
  entry.page = (async () => {
    const bytes = await renderPagePreview(doc, pageId)
    if (entry.destroyed) throw new PreviewCancelledError()
    const task = openPdfBytes(bytes)
    entry.task = task
    const pdf = await task.promise
    if (entry.destroyed) throw new PreviewCancelledError()
    return pdf.getPage(1)
  })()
  entry.page.catch(() => {
    if (previews.get(pageId) === entry) previews.delete(pageId)
  })
  previews.set(pageId, entry)
  evict()
  return entry.page
}

/** Remember that a preview could not be produced, so the page falls back to its source. */
export function markPreviewFailed(key: string): void {
  failed.add(key)
}

export function hasPreviewFailed(key: string): boolean {
  return failed.has(key)
}

let failureNotified = false

/** True the first time it is called (per document session): show the fallback notice once. */
export function shouldNotifyPreviewFailure(): boolean {
  if (failureNotified) return false
  failureNotified = true
  return true
}

/** Destroy previews of pages that are not in `keepPageIds` (all when omitted). */
export function releasePreviews(keepPageIds?: Iterable<string>): void {
  const keep = new Set(keepPageIds ?? [])
  for (const [pageId, entry] of previews) {
    if (!keep.has(pageId)) {
      previews.delete(pageId)
      destroy(entry)
    }
  }
  if (!keepPageIds) {
    failed.clear()
    failureNotified = false
  }
}
