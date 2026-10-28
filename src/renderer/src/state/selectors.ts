/** Derived values from the editor store. Pure functions so they are easy to test. */
import type { DocumentMetadata, EditorDocument, PageEntry } from '@core'
import type { EditorState } from './store'

/**
 * Pages that page operations act on: the sidebar selection (in document order) if there is
 * one, otherwise the current page.
 */
export function getTargetPageIds(s: Pick<EditorState, 'doc' | 'selectedPageIds' | 'currentPageId'>): string[] {
  const { doc } = s
  if (!doc || doc.pages.length === 0) return []
  if (s.selectedPageIds.length) {
    const selected = new Set(s.selectedPageIds)
    const ids = doc.pages.filter((p) => selected.has(p.id)).map((p) => p.id)
    if (ids.length) return ids
  }
  const current = s.currentPageId && doc.pages.some((p) => p.id === s.currentPageId) ? s.currentPageId : doc.pages[0].id
  return [current]
}

export function pageIndexOf(doc: EditorDocument | null, pageId: string | null): number {
  if (!doc || !pageId) return -1
  return doc.pages.findIndex((p) => p.id === pageId)
}

/** 0-based index of the current page (0 when unknown). */
export function currentPageIndex(s: Pick<EditorState, 'doc' | 'currentPageId'>): number {
  return Math.max(0, pageIndexOf(s.doc, s.currentPageId))
}

export function getPage(doc: EditorDocument | null, pageId: string | null): PageEntry | undefined {
  if (!doc || !pageId) return undefined
  return doc.pages.find((p) => p.id === pageId)
}

/** Metadata as it will be written: the primary source's metadata with the user's overrides. */
export function effectiveMetadata(doc: EditorDocument): DocumentMetadata {
  const base = doc.primarySourceId ? doc.sources[doc.primarySourceId]?.metadata : undefined
  return { ...(base ?? {}), ...stripUndefined(doc.settings.metadata) }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** "report.pdf" → "report". */
export function baseFileName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() || fileName
  return name.replace(/\.pdf$/i, '') || 'document'
}

/**
 * The document's raw display name for DocumentState.title ("" without a document). The desktop
 * shell formats the window title itself; see formatWindowTitle for the browser.
 */
export function documentTitle(s: Pick<EditorState, 'doc' | 'fileName'>): string {
  if (!s.doc) return ''
  return s.fileName || 'Untitled.pdf'
}

/** Browser tab title: "report.pdf • — Open PDF Editor" (• = unsaved changes). */
export function formatWindowTitle(name: string, dirty: boolean, hasDocument: boolean): string {
  if (!hasDocument || !name) return 'Open PDF Editor'
  return `${name}${dirty ? ' •' : ''} — Open PDF Editor`
}

export function windowTitle(s: Pick<EditorState, 'doc' | 'fileName' | 'dirty'>): string {
  return formatWindowTitle(documentTitle(s), s.dirty, !!s.doc)
}
