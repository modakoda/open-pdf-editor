/**
 * Application state (zustand). The EditorDocument is immutable; every edit goes through
 * `apply()` which records an undo snapshot. View state (zoom, tool, selection) is not undoable.
 */
import { create } from 'zustand'
import type { Color, EditorDocument, FontFamily, Point } from '@core'

export type ToolId =
  | 'select'
  | 'hand'
  | 'text'
  /** Select, move, resize, delete and retype content that already exists in the page. */
  | 'edit-content'
  /** Prepare form: move/resize/rename/delete existing form fields and place new ones. */
  | 'form-design'
  | 'field-text'
  | 'field-checkbox'
  | 'field-radio'
  | 'field-dropdown'
  | 'field-list'
  | 'field-signature'
  | 'image'
  | 'signature'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'ink'
  | 'highlight'
  | 'whiteout'
  /** Mark areas whose content is removed from the file on save. */
  | 'redact'
  | 'note'

/** Something that already exists in the PDF and is selected (see also selectedObjectId). */
export type ElementRef =
  | { kind: 'content'; pageId: string; itemId: string }
  | { kind: 'annotation'; pageId: string; annotId: string }
  /** fieldName is the field's ORIGINAL name; widgetIndex indexes FormFieldInfo.widgets. */
  | { kind: 'field'; sourceId: string; fieldName: string; widgetIndex: number; pageId: string }

export interface ToolOptions {
  /** Stroke / text / ink color. */
  color: Color
  /** Fill for rectangles and ellipses (null = no fill). */
  fillColor: Color | null
  strokeWidth: number
  highlightColor: Color
  font: FontFamily
  fontSize: number
  bold: boolean
  italic: boolean
  opacity: number
}

/** An image waiting to be placed on a page (picked from disk or created by the signature pad). */
export interface PendingImage {
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  /** Natural size in CSS px, used for the initial aspect ratio. */
  width: number
  height: number
}

export type FitMode = 'width' | 'page' | null

/** A button on a notice (e.g. "Recognize text…" when a scanned document was opened). */
export interface NoticeAction {
  label: string
  run: () => void
}

/** A toast message (see showNotice). */
export interface NoticeData {
  kind: 'info' | 'error'
  text: string
  id?: number
  action?: NoticeAction
  /** Must not be missed: see NoticeOptions.important. */
  important?: boolean
}

export interface NoticeOptions {
  /**
   * A notice the user must not miss (e.g. "saving removes the signatures"): shown after the
   * current notice instead of replacing it, and shown again after a newer notice replaced it.
   */
  important?: boolean
}

/** Which list the left sidebar shows. */
export type SidebarTab = 'pages' | 'fields' | 'signatures'

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 5
const HISTORY_LIMIT = 100
/** Edits with the same coalesce key within this window merge into one undo step. */
const COALESCE_MS = 1000

interface HistoryEntry {
  doc: EditorDocument
  key?: string
  at: number
}

export interface EditorState {
  doc: EditorDocument | null
  /** Where Save writes to. Null for untitled documents (Save behaves like Save As). */
  filePath: string | null
  /** Display name, e.g. "report.pdf" or "Untitled.pdf". */
  fileName: string
  dirty: boolean
  past: HistoryEntry[]
  future: EditorDocument[]

  /** Zoom factor; 1 = 100% (1 pt = 96/72 CSS px). */
  zoom: number
  fitMode: FitMode
  sidebarOpen: boolean
  sidebarTab: SidebarTab
  currentPageId: string | null
  /** Pages selected in the thumbnail sidebar (targets of page operations). */
  selectedPageIds: string[]
  tool: ToolId
  toolOptions: ToolOptions
  selectedObjectId: string | null
  /** Selected existing element. Mutually exclusive with selectedObjectId. */
  selectedElement: ElementRef | null
  pendingImage: PendingImage | null
  /** Transient status message shown in the status bar / toast. */
  notice: NoticeData | null
  /** Important notices waiting for the current one to go away (shown in order). */
  noticeQueue: NoticeData[]
  /** Document snapshot that matches the file on disk (dirty = doc !== savedDoc). */
  savedDoc: EditorDocument | null
  /** Long-running operation in progress (saving, exporting…); shown in the status bar. */
  busy: string | null
  /**
   * Request for the viewer to scroll a page into view (nonce changes on every request).
   * With `point` (page space), that point is centered instead of showing the page top.
   */
  scrollRequest: { pageId: string; nonce: number; point?: Point } | null
  /** Incremented whenever a different document is opened, created or closed in this window. */
  docSession: number

  setDocument(doc: EditorDocument, file: { filePath: string | null; fileName: string }): void
  closeDocument(): void
  /** Apply an edit. Records undo history and marks the document dirty. */
  apply(mutator: (doc: EditorDocument) => EditorDocument, options?: { coalesceKey?: string }): void
  undo(): void
  redo(): void
  /**
   * The document was written to `file`. `savedDoc` is the snapshot that was exported (defaults
   * to the current document); if the document changed while saving it stays dirty.
   */
  markSaved(file: { filePath: string; fileName: string }, savedDoc?: EditorDocument): void

  setZoom(zoom: number): void
  /** Zoom computed by the viewer for the active fit mode (keeps fitMode). */
  setFitZoom(zoom: number): void
  setFitMode(mode: FitMode): void
  setSidebarOpen(open: boolean): void
  setSidebarTab(tab: SidebarTab): void
  setCurrentPage(pageId: string | null): void
  /** Make `pageId` the current page and scroll the viewer to it (optionally to a point on it). */
  goToPage(pageId: string, point?: Point): void
  setSelectedPages(pageIds: string[]): void
  setTool(tool: ToolId): void
  setToolOptions(patch: Partial<ToolOptions>): void
  selectObject(id: string | null): void
  selectElement(ref: ElementRef | null): void
  setPendingImage(image: PendingImage | null): void
  showNotice(kind: 'info' | 'error', text: string, action?: NoticeAction, options?: NoticeOptions): void
  clearNotice(): void
  setBusy(busy: string | null): void
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  color: '#1f2937',
  fillColor: null,
  strokeWidth: 2,
  highlightColor: '#facc15',
  font: 'sans',
  fontSize: 14,
  bold: false,
  italic: false,
  opacity: 1
}

const initialView = {
  zoom: 1,
  fitMode: 'width' as FitMode,
  currentPageId: null,
  selectedPageIds: [],
  selectedObjectId: null,
  selectedElement: null,
  pendingImage: null,
  scrollRequest: null
}

let noticeCounter = 0
let scrollCounter = 0

export const useEditor = create<EditorState>()((set, get) => ({
  doc: null,
  filePath: null,
  fileName: '',
  dirty: false,
  past: [],
  future: [],
  sidebarOpen: true,
  sidebarTab: 'pages',
  tool: 'select',
  toolOptions: DEFAULT_TOOL_OPTIONS,
  notice: null,
  noticeQueue: [],
  savedDoc: null,
  busy: null,
  docSession: 0,
  ...initialView,

  setDocument(doc, file) {
    set({
      doc,
      filePath: file.filePath,
      fileName: file.fileName,
      dirty: false,
      savedDoc: doc,
      docSession: get().docSession + 1,
      noticeQueue: [],
      past: [],
      future: [],
      tool: 'select',
      ...initialView,
      currentPageId: doc.pages[0]?.id ?? null
    })
  },

  closeDocument() {
    set({
      doc: null,
      filePath: null,
      fileName: '',
      dirty: false,
      savedDoc: null,
      docSession: get().docSession + 1,
      noticeQueue: [],
      past: [],
      future: [],
      ...initialView
    })
  },

  apply(mutator, options) {
    const { doc, past } = get()
    if (!doc) return
    const next = mutator(doc)
    if (next === doc) return
    const now = Date.now()
    const last = past[past.length - 1]
    const key = options?.coalesceKey
    const coalesce = key !== undefined && last?.key === key && now - last.at < COALESCE_MS
    const nextPast = coalesce
      ? [...past.slice(0, -1), { ...last, at: now }]
      : [...past, { doc, key, at: now }].slice(-HISTORY_LIMIT)
    set({ doc: next, past: nextPast, future: [], dirty: next !== get().savedDoc })
    reconcileSelection(set, get)
  },

  undo() {
    const { doc, past, future } = get()
    const prev = past[past.length - 1]
    if (!doc || !prev) return
    set({ doc: prev.doc, past: past.slice(0, -1), future: [doc, ...future], dirty: prev.doc !== get().savedDoc })
    reconcileSelection(set, get)
  },

  redo() {
    const { doc, past, future } = get()
    const [next, ...rest] = future
    if (!doc || !next) return
    set({ doc: next, past: [...past, { doc, at: 0 }], future: rest, dirty: next !== get().savedDoc })
    reconcileSelection(set, get)
  },

  markSaved(file, savedDoc) {
    const saved = savedDoc ?? get().doc
    set({ dirty: get().doc !== saved, savedDoc: saved, filePath: file.filePath, fileName: file.fileName })
  },

  setZoom(zoom) {
    set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)), fitMode: null })
  },
  setFitZoom(zoom) {
    set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) })
  },
  setFitMode(fitMode) {
    set({ fitMode })
  },
  setSidebarOpen(sidebarOpen) {
    set({ sidebarOpen })
  },
  setSidebarTab(sidebarTab) {
    set({ sidebarTab })
  },
  setCurrentPage(currentPageId) {
    set({ currentPageId })
  },
  goToPage(pageId, point) {
    set({ currentPageId: pageId, scrollRequest: { pageId, nonce: ++scrollCounter, point } })
  },
  setSelectedPages(selectedPageIds) {
    set({ selectedPageIds })
  },
  setTool(tool) {
    // Each tool only shows (and acts on) its own kind of selection: objects and annotations in
    // Select, content items in Edit content, fields in Prepare form.
    const element = get().selectedElement
    set({
      tool,
      selectedObjectId: tool === 'select' ? get().selectedObjectId : null,
      selectedElement: element && element.kind === toolElementKind(tool) ? element : null
    })
  },
  setToolOptions(patch) {
    set({ toolOptions: { ...get().toolOptions, ...patch } })
  },
  selectObject(selectedObjectId) {
    set(selectedObjectId ? { selectedObjectId, selectedElement: null } : { selectedObjectId })
  },
  selectElement(selectedElement) {
    set(selectedElement ? { selectedElement, selectedObjectId: null } : { selectedElement })
  },
  setPendingImage(pendingImage) {
    set({ pendingImage })
  },
  showNotice(kind, text, action, options) {
    const next: NoticeData = { kind, text, id: ++noticeCounter, ...(action ? { action } : {}), ...(options?.important ? { important: true } : {}) }
    const { notice: current, noticeQueue } = get()
    const queue = noticeQueue.filter((n) => n.text !== text)
    if (!current || current.text === text) set({ notice: next, noticeQueue: queue })
    else if (next.important) set({ noticeQueue: [...queue, next] })
    else if (current.important) set({ notice: next, noticeQueue: [current, ...queue] })
    else set({ notice: next, noticeQueue: queue })
  },
  clearNotice() {
    const [next, ...rest] = get().noticeQueue
    set({ notice: next ? { ...next, id: ++noticeCounter } : null, noticeQueue: rest })
  },
  setBusy(busy) {
    set({ busy })
  }
}))

/** Drop selections that refer to pages/objects that no longer exist. */
function reconcileSelection(
  set: (s: Partial<EditorState>) => void,
  get: () => EditorState
): void {
  const { doc, selectedObjectId, selectedElement, currentPageId, selectedPageIds } = get()
  if (!doc) return
  const state: Partial<EditorState> = {}
  if (selectedObjectId && !doc.objects.some((o) => o.id === selectedObjectId)) state.selectedObjectId = null
  const pageIds = new Set(doc.pages.map((p) => p.id))
  if (selectedElement && !elementExists(doc, selectedElement, pageIds)) state.selectedElement = null
  if (currentPageId && !pageIds.has(currentPageId)) state.currentPageId = doc.pages[0]?.id ?? null
  if (selectedPageIds.some((id) => !pageIds.has(id))) state.selectedPageIds = selectedPageIds.filter((id) => pageIds.has(id))
  set(state)
}

/** Which existing elements a tool selects: annotations in Select, content in Edit content, fields in Prepare form. */
function toolElementKind(tool: ToolId): ElementRef['kind'] | null {
  if (tool === 'select') return 'annotation'
  if (tool === 'edit-content') return 'content'
  if (tool === 'form-design') return 'field'
  return null
}

function elementExists(doc: EditorDocument, ref: ElementRef, pageIds: Set<string>): boolean {
  if (!pageIds.has(ref.pageId)) return false
  switch (ref.kind) {
    case 'content':
      // Deleting a container (e.g. "x1") deletes the items inside it ("x1/t3").
      return !doc.contentEdits?.[ref.pageId]?.some(
        (e) => e.deleted && (e.itemId === ref.itemId || ref.itemId.startsWith(`${e.itemId}/`))
      )
    case 'annotation':
      return !doc.annotationEdits?.[ref.pageId]?.some((e) => e.annotId === ref.annotId && e.deleted)
    case 'field': {
      const edit = doc.fieldEdits?.[ref.sourceId]?.[ref.fieldName]
      return !edit?.deleted && !edit?.deletedWidgets?.includes(ref.widgetIndex)
    }
  }
}

export const canUndo = (s: EditorState): boolean => s.past.length > 0
export const canRedo = (s: EditorState): boolean => s.future.length > 0
