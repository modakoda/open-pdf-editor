/**
 * Page operations (toolbar, sidebar, menu, shortcuts). They act on the sidebar selection or,
 * without one, on the current page. All edits are undoable.
 */
import {
  deletePages,
  duplicatePages,
  formatPageRanges,
  insertBlankPage,
  insertSourcePages,
  loadSource,
  movePages,
  rotatePages,
  type EditorDocument,
  type SourceDocument
} from '@core'
import type { OpenedFile } from '@shared/ipc'
import { deleteSelection as deleteEditingSelection } from '@renderer/editing'
import { platform } from '@renderer/platform'
import { confirmDialog, openDialog } from '@renderer/state/dialogs'
import { getTargetPageIds, pageIndexOf } from '@renderer/state/selectors'
import { applyEdit, editor, notifyError, notifyInfo } from './util'
import { isPdfFile, loadWithPassword, withBusy } from './fileActions'
import { deleteSelectedRedaction } from './redactActions'

function targets(): string[] {
  return getTargetPageIds(editor())
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function rotateTargetPages(delta: 90 | -90, pageIds = targets()): void {
  if (!pageIds.length) return
  applyEdit('Rotate', (doc) => rotatePages(doc, pageIds, delta))
}

export async function deleteTargetPages(pageIds = targets()): Promise<void> {
  const { doc } = editor()
  if (!doc || !pageIds.length) return
  if (pageIds.length >= doc.pages.length) {
    const ok = await confirmDialog({
      title: 'Delete all pages?',
      message: 'This removes every page from the document. You can undo this.',
      confirmLabel: 'Delete all',
      danger: true
    })
    if (!ok) return
  }
  const firstIndex = Math.min(...pageIds.map((id) => pageIndexOf(doc, id)).filter((i) => i >= 0))
  if (!applyEdit('Delete pages', (d) => deletePages(d, pageIds))) return
  const next = editor().doc
  if (!next) return
  const neighbour = next.pages[Math.min(firstIndex, next.pages.length - 1)]
  editor().setSelectedPages([])
  if (neighbour) editor().goToPage(neighbour.id)
  else editor().setCurrentPage(null)
}

/** Insert a blank page before/after `refPageId` (default: after the last target page). */
export function insertBlankPageAt(position: 'before' | 'after' = 'after', refPageId?: string): void {
  const { doc } = editor()
  if (!doc) return
  let index: number
  if (doc.pages.length === 0) index = 0
  else {
    const ids = refPageId ? [refPageId] : targets()
    const indices = ids.map((id) => pageIndexOf(doc, id)).filter((i) => i >= 0)
    if (!indices.length) index = doc.pages.length
    else index = position === 'before' ? Math.min(...indices) : Math.max(...indices) + 1
  }
  let newId: string | null = null
  const ok = applyEdit('Insert page', (d) => {
    const result = insertBlankPage(d, index)
    newId = result.page.id
    return result.doc
  })
  if (ok && newId) {
    editor().setSelectedPages([newId])
    editor().goToPage(newId)
  }
}

export function duplicateTargetPages(pageIds = targets()): void {
  if (!pageIds.length) return
  applyEdit('Duplicate pages', (doc) => duplicatePages(doc, pageIds))
}

/**
 * Move pages so they end up before the page currently at `insertionIndex` (0..pages.length,
 * counted in the list before the move). Used by thumbnail drag & drop.
 */
export function movePagesToInsertionIndex(pageIds: string[], insertionIndex: number): void {
  const { doc } = editor()
  if (!doc || !pageIds.length) return
  const moving = new Set(pageIds)
  const target = doc.pages.slice(0, insertionIndex).filter((p) => !moving.has(p.id)).length
  const ordered = doc.pages.filter((p) => moving.has(p.id)).map((p) => p.id)
  const currentFirst = doc.pages.findIndex((p) => moving.has(p.id))
  // Contiguous block dropped onto its own position: nothing to do.
  const contiguous = ordered.every((id, i) => doc.pages[currentFirst + i]?.id === id)
  if (contiguous && target === currentFirst) return
  applyEdit('Move pages', (d) => movePages(d, ordered, target))
}

export function selectAllPages(): void {
  const { doc } = editor()
  if (!doc) return
  editor().setSelectedPages(doc.pages.map((p) => p.id))
}

/**
 * Delete the selection. A redaction area selected with the Redact tool is removed; a selected
 * object or existing element (content item, annotation, form field) is deleted by the editing
 * layer; with none of these selected, the selected pages are deleted.
 */
export async function deleteSelection(): Promise<void> {
  const { doc, selectedObjectId, selectedElement, selectedPageIds } = editor()
  if (!doc) return
  if (deleteSelectedRedaction()) return
  if (selectedObjectId || selectedElement) {
    try {
      deleteEditingSelection()
    } catch (err) {
      notifyError('Delete failed', err)
    }
    return
  }
  if (selectedPageIds.length) await deleteTargetPages()
}

/** Load a PDF as an extra source, asking for its password if needed. */
async function loadInsertSource(file: OpenedFile): Promise<SourceDocument | null> {
  return loadWithPassword(file.name, (options) =>
    withBusy(`Reading ${file.name}…`, () => loadSource(file.bytes, file.name, options))
  )
}

/** Insert pages from another PDF: pick a file, then choose position and range in a dialog. */
export async function insertPagesFromFile(): Promise<void> {
  if (!editor().doc) return
  let files: OpenedFile[]
  try {
    files = await platform.openPdfDialog({ multiple: false, title: 'Insert pages from PDF' })
  } catch (err) {
    notifyError('Could not open file', err)
    return
  }
  const [file] = files
  if (!file) return
  try {
    const source = await loadInsertSource(file)
    if (!source) return
    await openDialog({ kind: 'insert', source })
  } catch (err) {
    notifyError(`Could not read ${file.name}`, err)
  }
}

/** Apply "insert pages" (used by the insert dialog). */
export function insertSourcePagesAt(source: SourceDocument, index: number, pageIndices?: number[]): boolean {
  const before = editor().doc
  if (!before) return false
  const ok = applyEdit('Insert pages', (doc) => insertSourcePages(doc, source, index, pageIndices))
  const after = editor().doc
  if (ok && after && after !== before) {
    const inserted = after.pages.slice(index, index + (after.pages.length - before.pages.length))
    if (inserted.length) {
      editor().setSelectedPages(inserted.map((p) => p.id))
      editor().goToPage(inserted[0].id)
    }
    notifyInfo(`Inserted ${plural(inserted.length, 'page')} from ${source.name}`)
  }
  return ok
}

/** PDF files dropped on the sidebar: insert all their pages at `index`. */
export async function insertDroppedFiles(list: FileList | File[], index: number): Promise<void> {
  const files = Array.from(list).filter(isPdfFile)
  if (!files.length) return
  let at = index
  for (const file of files) {
    try {
      const opened: OpenedFile = { path: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
      const source = await loadInsertSource(opened)
      if (!source) continue
      const before = editor().doc?.pages.length ?? 0
      insertSourcePagesAt(source, at)
      at += (editor().doc?.pages.length ?? 0) - before
    } catch (err) {
      notifyError(`Could not insert ${file.name}`, err)
    }
  }
}

/** Selected pages (or current page) as a 1-based range string, for dialogs. */
export function targetRangeText(doc: EditorDocument | null = editor().doc): string {
  if (!doc) return ''
  const ids = getTargetPageIds({ ...editor(), doc })
  const indices = ids.map((id) => pageIndexOf(doc, id)).filter((i) => i >= 0)
  try {
    return formatPageRanges(indices)
  } catch {
    return indices.map((i) => i + 1).join(', ')
  }
}

function requirePages(minimum: number, what: string): boolean {
  const count = editor().doc?.pages.length ?? 0
  if (!editor().doc) return false
  if (count >= minimum) return true
  editor().showNotice('error', count === 0 ? `The document has no pages to ${what}.` : `The document needs at least ${minimum} pages to ${what}.`)
  return false
}

export async function openExtractDialog(): Promise<void> {
  if (!requirePages(1, 'extract')) return
  const selected = editor().selectedPageIds.length > 0
  await openDialog({ kind: 'extract', initialRange: selected ? targetRangeText() : '' })
}

export async function openSplitDialog(): Promise<void> {
  if (!requirePages(2, 'split')) return
  await openDialog({ kind: 'split' })
}
