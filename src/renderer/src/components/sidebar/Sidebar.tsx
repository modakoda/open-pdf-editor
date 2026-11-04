/**
 * Left sidebar with two tabs:
 * - Pages: thumbnails with click / shift-click / ctrl(cmd)-click selection, drag & drop
 *   reordering (and dropping PDF files to insert their pages), a context menu with page
 *   operations, and keyboard navigation (arrows, Delete).
 * - Fields: every form field of the document (FieldsPanel.tsx).
 * - Signatures: digital signatures and their verification (shown when the file is signed).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Copy, FileOutput, FilePlus, FileSignature, RotateCcw, RotateCw, Trash, type LucideIcon } from 'lucide-react'
import { displayRotation, displaySize, type PageEntry, type SourceDocument } from '@core'
import {
  deleteTargetPages,
  duplicateTargetPages,
  insertBlankPageAt,
  insertDroppedFiles,
  movePagesToInsertionIndex,
  openExtractDialog,
  rotateTargetPages
} from '@renderer/actions/pageActions'
import { isMac } from '@renderer/actions/util'
import { useNearViewport } from '@renderer/hooks/useNearViewport'
import { getPreviewPage, hasPreviewFailed, previewKeyFor } from '@renderer/pdf/previews'
import { getPreviewThumbnailUrl, getThumbnailUrl } from '@renderer/pdf/thumbnails'
import { useEditor, type SidebarTab } from '@renderer/state/store'
import { Menu, type MenuEntry } from '../common/Menu'
import { SignaturesPanel, useSignatureCount } from '../signatures/SignaturesPanel'
import { FieldsPanel, useFieldCount } from './FieldsPanel'
import './sidebar.css'

export const PAGE_DRAG_TYPE = 'application/x-ope-pages'
/** Thumbnail box size in CSS px. */
const THUMB_MAX_W = 128
const THUMB_MAX_H = 168

/** Selection after clicking `pageId` with modifiers. Pure, exported for tests. */
export function nextSelection(
  pageIds: string[],
  selected: string[],
  anchor: string | null,
  pageId: string,
  mods: { shift: boolean; toggle: boolean }
): { selected: string[]; anchor: string } {
  if (mods.shift && anchor && pageIds.includes(anchor)) {
    const a = pageIds.indexOf(anchor)
    const b = pageIds.indexOf(pageId)
    const [from, to] = a < b ? [a, b] : [b, a]
    const range = pageIds.slice(from, to + 1)
    const base = mods.toggle ? selected.filter((id) => !range.includes(id)) : []
    return { selected: [...base, ...range], anchor }
  }
  if (mods.toggle) {
    return selected.includes(pageId)
      ? { selected: selected.filter((id) => id !== pageId), anchor: pageId }
      : { selected: [...selected, pageId], anchor: pageId }
  }
  return { selected: [pageId], anchor: pageId }
}

function hasType(dt: DataTransfer | null, type: string): boolean {
  return !!dt && Array.from(dt.types ?? []).includes(type)
}

export function Sidebar() {
  const tab = useEditor((s) => s.sidebarTab)
  const setTab = useEditor((s) => s.setSidebarTab)
  const pageCount = useEditor((s) => s.doc?.pages.length ?? 0)
  const fieldCount = useFieldCount()
  const signatureCount = useSignatureCount()
  const tool = useEditor((s) => s.tool)
  // Entering Prepare form (or a field tool) shows the field list.
  const formTool = tool === 'form-design' || tool.startsWith('field-')
  useEffect(() => {
    if (formTool) useEditor.getState().setSidebarTab('fields')
  }, [formTool])
  // Tabs with an icon show it instead of the label (the sidebar is narrow).
  const tabs: { id: SidebarTab; label: string; count: number; icon?: LucideIcon }[] = [
    { id: 'pages', label: 'Pages', count: pageCount },
    { id: 'fields', label: 'Fields', count: fieldCount }
  ]
  if (signatureCount > 0 || tab === 'signatures') tabs.push({ id: 'signatures', label: 'Signatures', count: signatureCount, icon: FileSignature })
  return (
    <aside className="sidebar" data-testid="sidebar" aria-label="Sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`sidebar-tab-${t.id}`}
            className={`sidebar-tab${tab === t.id ? ' active' : ''}${t.icon ? ' sidebar-tab-icon' : ''}`}
            data-testid={`sidebar-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`sidebar-panel-${t.id}`}
            aria-label={t.icon ? `${t.label} (${t.count})` : undefined}
            title={t.icon ? t.label : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.icon ? <t.icon size={14} aria-hidden="true" /> : t.label}
            <span className="sidebar-count">{t.count}</span>
          </button>
        ))}
      </div>
      {tab === 'pages' ? <PagesPanel /> : tab === 'signatures' ? <SignaturesPanel /> : <FieldsPanel />}
    </aside>
  )
}

function PagesPanel() {
  const doc = useEditor((s) => s.doc)
  const selectedPageIds = useEditor((s) => s.selectedPageIds)
  const currentPageId = useEditor((s) => s.currentPageId)
  const listRef = useRef<HTMLDivElement>(null)
  const { near, observe } = useNearViewport(listRef, '300px 0px')
  const anchorRef = useRef<string | null>(null)
  const dragIds = useRef<string[] | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; pageId: string } | null>(null)
  const pages = doc?.pages ?? []
  const pageIds = pages.map((p) => p.id)
  const selected = new Set(selectedPageIds)

  // Keep the current page's thumbnail in view while scrolling the document.
  useEffect(() => {
    if (!currentPageId || !listRef.current) return
    const el = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-testid="thumbnail"]')).find(
      (t) => t.dataset.pageId === currentPageId
    )
    if (!el || typeof el.scrollIntoView !== 'function') return
    const list = listRef.current.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < list.top || r.bottom > list.bottom) el.scrollIntoView({ block: 'nearest' })
  }, [currentPageId])

  const selectPage = useCallback(
    (pageId: string, mods: { shift: boolean; toggle: boolean }) => {
      const s = useEditor.getState()
      const ids = s.doc?.pages.map((p) => p.id) ?? []
      const result = nextSelection(ids, s.selectedPageIds, anchorRef.current, pageId, mods)
      anchorRef.current = result.anchor
      s.selectObject(null)
      s.setSelectedPages(result.selected)
      if (!mods.toggle || result.selected.includes(pageId)) s.goToPage(pageId)
    },
    []
  )

  const onThumbClick = useCallback(
    (e: React.MouseEvent, pageId: string) => {
      selectPage(pageId, { shift: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey })
      listRef.current?.focus({ preventScroll: true })
    },
    [selectPage]
  )

  const onContextMenu = useCallback((e: React.MouseEvent, pageId: string) => {
    e.preventDefault()
    const s = useEditor.getState()
    if (!s.selectedPageIds.includes(pageId)) {
      anchorRef.current = pageId
      s.setSelectedPages([pageId])
    }
    setMenu({ x: e.clientX, y: e.clientY, pageId })
  }, [])

  // ---- Drag & drop
  const onDragStart = useCallback((e: React.DragEvent, pageId: string) => {
    const s = useEditor.getState()
    let ids = s.selectedPageIds.includes(pageId) ? s.selectedPageIds : [pageId]
    if (!s.selectedPageIds.includes(pageId)) {
      anchorRef.current = pageId
      s.setSelectedPages([pageId])
    }
    const order = s.doc?.pages.map((p) => p.id) ?? []
    ids = order.filter((id) => ids.includes(id))
    dragIds.current = ids
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try {
        e.dataTransfer.setData(PAGE_DRAG_TYPE, JSON.stringify(ids))
        e.dataTransfer.setData('text/plain', `${ids.length} page(s)`)
      } catch {
        /* ignore */
      }
    }
  }, [])

  const indexFromEvent = (e: React.DragEvent): number => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-testid="thumbnail"]')
    if (!target) return pages.length
    const index = Number(target.dataset.pageIndex)
    const rect = target.getBoundingClientRect()
    return e.clientY < rect.top + rect.height / 2 ? index : index + 1
  }

  const onDragOver = (e: React.DragEvent) => {
    const internal = dragIds.current !== null || hasType(e.dataTransfer, PAGE_DRAG_TYPE)
    const files = hasType(e.dataTransfer, 'Files')
    if (!internal && !files) return
    // Not stopping propagation: the window-level drop overlay hides itself over this list.
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
    const index = indexFromEvent(e)
    if (index !== dropIndex) setDropIndex(index)
  }

  const onDragLeave = (e: React.DragEvent) => {
    if (!listRef.current?.contains(e.relatedTarget as Node | null)) setDropIndex(null)
  }

  const onDrop = (e: React.DragEvent) => {
    const index = indexFromEvent(e)
    setDropIndex(null)
    let ids = dragIds.current
    if (!ids && hasType(e.dataTransfer, PAGE_DRAG_TYPE)) {
      try {
        ids = JSON.parse(e.dataTransfer.getData(PAGE_DRAG_TYPE)) as string[]
      } catch {
        ids = null
      }
    }
    dragIds.current = null
    if (ids && ids.length) {
      e.preventDefault()
      e.stopPropagation()
      movePagesToInsertionIndex(ids, index)
      return
    }
    const files = e.dataTransfer?.files
    if (files && files.length) {
      e.preventDefault()
      e.stopPropagation()
      void insertDroppedFiles(files, index)
    }
  }

  const onDragEnd = () => {
    dragIds.current = null
    setDropIndex(null)
  }

  // ---- Keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = useEditor.getState()
    if (!s.doc || !s.doc.pages.length) return
    const ids = s.doc.pages.map((p) => p.id)
    const focusId = anchorRef.current && ids.includes(anchorRef.current) ? anchorRef.current : s.currentPageId
    const i = Math.max(0, focusId ? ids.indexOf(focusId) : 0)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(ids.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
      if (e.shiftKey) {
        const anchor = anchorRef.current ?? ids[i]
        const result = nextSelection(ids, s.selectedPageIds, anchor, ids[next], { shift: true, toggle: false })
        s.setSelectedPages(result.selected)
        // Keep the anchor; move the focus page via current page.
        s.goToPage(ids[next])
        anchorRef.current = anchor
      } else {
        selectPage(ids[next], { shift: false, toggle: false })
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
      if (s.selectedPageIds.length) {
        e.preventDefault()
        e.stopPropagation()
        void deleteTargetPages()
      }
    } else if (e.key === 'Escape' && s.selectedPageIds.length) {
      e.stopPropagation()
      s.setSelectedPages([])
    }
  }

  const menuItems = (): MenuEntry[] => {
    const count = useEditor.getState().selectedPageIds.length || 1
    const pagesLabel = count > 1 ? `${count} pages` : 'page'
    const ref = menu?.pageId
    return [
      { id: 'rotate-ccw', label: 'Rotate left', icon: RotateCcw, onSelect: () => rotateTargetPages(-90) },
      { id: 'rotate-cw', label: 'Rotate right', icon: RotateCw, onSelect: () => rotateTargetPages(90) },
      'separator',
      { id: 'duplicate', label: `Duplicate ${pagesLabel}`, icon: Copy, onSelect: () => duplicateTargetPages() },
      { id: 'insert-before', label: 'Insert blank page before', icon: FilePlus, onSelect: () => insertBlankPageAt('before', ref) },
      { id: 'insert-after', label: 'Insert blank page after', icon: FilePlus, onSelect: () => insertBlankPageAt('after', ref) },
      { id: 'extract', label: `Extract ${pagesLabel}…`, icon: FileOutput, onSelect: () => void openExtractDialog() },
      'separator',
      { id: 'delete', label: `Delete ${pagesLabel}`, icon: Trash, danger: true, onSelect: () => void deleteTargetPages() }
    ]
  }

  return (
    <div className="sidebar-panel" role="tabpanel" id="sidebar-panel-pages" aria-labelledby="sidebar-tab-pages">
      <div
        ref={listRef}
        className="thumb-list"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Page thumbnails"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {pages.map((page, i) => (
          <Thumbnail
            key={page.id}
            page={page}
            index={i}
            source={page.source.kind === 'source' ? doc?.sources[page.source.sourceId] : undefined}
            previewKey={doc ? previewKeyFor(doc, page) : null}
            selected={selected.has(page.id)}
            current={page.id === currentPageId}
            near={near.has(page.id)}
            observe={observe}
            dropBefore={dropIndex === i}
            dropAfter={dropIndex === pages.length && i === pages.length - 1}
            onClick={onThumbClick}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
        {pageIds.length === 0 && <div className="thumb-empty">No pages</div>}
      </div>
      {menu && (
        <Menu x={menu.x} y={menu.y} items={menuItems()} label="Page actions" testId="page-context-menu" onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

interface ThumbnailProps {
  page: PageEntry
  index: number
  source: SourceDocument | undefined
  previewKey: string | null
  selected: boolean
  current: boolean
  near: boolean
  dropBefore: boolean
  dropAfter: boolean
  observe: (key: string, el: HTMLElement | null) => void
  onClick: (e: React.MouseEvent, pageId: string) => void
  onContextMenu: (e: React.MouseEvent, pageId: string) => void
  onDragStart: (e: React.DragEvent, pageId: string) => void
  onDragEnd: () => void
}

const Thumbnail = memo(function Thumbnail({
  page,
  index,
  source,
  previewKey,
  selected,
  current,
  near,
  dropBefore,
  dropAfter,
  observe,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd
}: ThumbnailProps) {
  const size = displaySize(page)
  const rotation = displayRotation(page)
  const fit = Math.min(THUMB_MAX_W / size.width, THUMB_MAX_H / size.height)
  const w = Math.round(size.width * fit)
  const h = Math.round(size.height * fit)
  const url = useThumbnail(source, page, rotation, w, near, previewKey)
  const ref = useCallback((el: HTMLElement | null) => observe(page.id, el), [observe, page.id])

  return (
    <div
      ref={ref}
      className={`thumb${selected ? ' selected' : ''}${current ? ' current' : ''}${dropBefore ? ' drop-before' : ''}${dropAfter ? ' drop-after' : ''}`}
      data-testid="thumbnail"
      data-page-id={page.id}
      data-page-index={index}
      data-selected={selected ? 'true' : 'false'}
      data-current={current ? 'true' : 'false'}
      role="option"
      aria-selected={selected}
      aria-label={`Page ${index + 1}`}
      draggable
      onClick={(e) => onClick(e, page.id)}
      onContextMenu={(e) => onContextMenu(e, page.id)}
      onDragStart={(e) => onDragStart(e, page.id)}
      onDragEnd={onDragEnd}
    >
      <div className="thumb-frame" style={{ width: w, height: h }}>
        {url ? <img src={url} alt="" draggable={false} /> : <div className="thumb-placeholder" />}
      </div>
      <div className="thumb-label">{index + 1}</div>
    </div>
  )
})

/** Debounce for thumbnails of pages whose content is being edited. */
const PREVIEW_THUMB_DELAY_MS = 250

function useThumbnail(
  source: SourceDocument | undefined,
  page: PageEntry,
  rotation: number,
  cssWidth: number,
  near: boolean,
  previewKey: string | null
): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const pageIndex = page.source.kind === 'source' ? page.source.pageIndex : -1
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1
  const pixelWidth = Math.round(cssWidth * dpr)
  const pageId = page.id
  useEffect(() => {
    if (!source || pageIndex < 0 || !near) return
    let alive = true
    const fromSource = () => getThumbnailUrl(source, pageIndex, rotation, pixelWidth)
    const load = (): Promise<string> => {
      const doc = useEditor.getState().doc
      if (!previewKey || !doc || hasPreviewFailed(previewKey)) return fromSource()
      return getPreviewThumbnailUrl(pageId, previewKey, () => getPreviewPage(doc, pageId, previewKey), rotation, pixelWidth).catch(
        (err) => {
          if (err instanceof Error && err.name === 'RenderingCancelledException') throw err
          return fromSource()
        }
      )
    }
    // The previous image stays visible until the new one is ready.
    const timer = setTimeout(
      () => {
        load()
          .then((u) => alive && setUrl(u))
          .catch((err) => {
            if (!(err instanceof Error && err.name === 'RenderingCancelledException')) console.warn('Thumbnail failed', err)
          })
      },
      previewKey ? PREVIEW_THUMB_DELAY_MS : 0
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [source, pageIndex, rotation, pixelWidth, near, previewKey, pageId])
  return url
}
