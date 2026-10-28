/** Derived values from the editor store. Pure functions so they are easy to test. */
import { getEffectiveFormFields, type DocumentMetadata, type EditObject, type EditorDocument, type PageEntry } from '@core'
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

const OBJECT_LABELS: Record<EditObject['type'], string> = {
  text: 'Text',
  image: 'Image',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  highlight: 'Highlight',
  whiteout: 'Whiteout',
  line: 'Line',
  ink: 'Drawing',
  note: 'Note',
  field: 'Field'
}

const ANNOTATION_LABELS: Record<string, string> = {
  Text: 'Comment',
  FreeText: 'Text box',
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strikeout',
  Squiggly: 'Underline',
  Link: 'Link',
  Ink: 'Drawing',
  Stamp: 'Stamp',
  Square: 'Rectangle',
  Circle: 'Ellipse',
  Line: 'Line',
  Polygon: 'Polygon',
  PolyLine: 'Polyline',
  FileAttachment: 'Attachment'
}

/** Status-bar description of the selected object / existing element, e.g. "Text selected". */
export function selectionLabel(s: Pick<EditorState, 'doc' | 'selectedObjectId' | 'selectedElement'>): string | null {
  const { doc } = s
  if (!doc) return null
  if (s.selectedObjectId) {
    const obj = doc.objects.find((o) => o.id === s.selectedObjectId)
    if (!obj) return null
    if (obj.type === 'field') return `Field “${obj.name}” selected`
    if (obj.type === 'line' && obj.arrowEnd) return 'Arrow selected'
    return `${OBJECT_LABELS[obj.type] ?? 'Object'} selected`
  }
  const el = s.selectedElement
  if (!el) return null
  switch (el.kind) {
    case 'content':
      return 'Page content selected'
    case 'annotation': {
      const page = doc.pages.find((p) => p.id === el.pageId)
      const info =
        page?.source.kind === 'source'
          ? doc.sources[page.source.sourceId]?.pageInfo?.[page.source.pageIndex]?.annotations?.find((a) => a.id === el.annotId)
          : undefined
      return `${(info && ANNOTATION_LABELS[info.subtype]) || 'Annotation'} selected`
    }
    case 'field': {
      let name = el.fieldName
      try {
        name = getEffectiveFormFields(doc, el.sourceId).find((f) => f.originalName === el.fieldName)?.name ?? name
      } catch {
        /* keep the original name */
      }
      return `Field “${name}” selected`
    }
  }
}
