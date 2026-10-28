/**
 * Continuous vertical page viewer (data-testid="viewer" is the scroll container).
 *
 * - Pages are laid out at their final size immediately (placeholders), rendered lazily.
 * - Zoom keeps the point under the cursor (wheel/pinch) or the viewport center fixed.
 * - Fit width / fit page recompute the zoom when the container or the pages change.
 * - The current page follows the scroll position; scroll requests come from the store.
 * - Hand tool (or holding Space, or the middle mouse button) pans by dragging.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CSS_PX_PER_PT, displaySize, pageToView } from '@core'
import { FilePlus } from 'lucide-react'
import { insertBlankPageAt } from '@renderer/actions/pageActions'
import { isEditableTarget } from '@renderer/actions/util'
import { useNearViewport } from '@renderer/hooks/useNearViewport'
import { useEditor, ZOOM_MAX, ZOOM_MIN } from '@renderer/state/store'
import { PageView } from './PageView'
import './viewer.css'

/** Must match .viewer-pages padding / gap in viewer.css. */
export const VIEWER_PADDING = 24
export const PAGE_GAP = 16
/** Pages within this distance of the viewport are rendered. */
const NEAR_MARGIN = '150% 0px'

interface ZoomAnchor {
  pageIndex: number
  /** Position inside the page, as a fraction of its size. */
  fx: number
  fy: number
  /** Position of the anchor in the viewport (px from the scroll container's top-left). */
  vx: number
  vy: number
}

export function computeFitZoom(
  mode: 'width' | 'page',
  container: { width: number; height: number },
  pages: { width: number; height: number }[],
  currentIndex: number
): number | null {
  if (!pages.length || container.width <= 0) return null
  const availW = container.width - VIEWER_PADDING * 2
  const availH = container.height - VIEWER_PADDING * 2
  if (mode === 'width') {
    const maxW = Math.max(...pages.map((p) => p.width))
    return clampZoom(availW / (maxW * CSS_PX_PER_PT))
  }
  const p = pages[Math.min(Math.max(0, currentIndex), pages.length - 1)]
  return clampZoom(Math.min(availW / (p.width * CSS_PX_PER_PT), availH / (p.height * CSS_PX_PER_PT)))
}

function scrollToPosition(root: HTMLElement, top: number, left: number): void {
  root.scrollTop = Math.max(0, top)
  root.scrollLeft = Math.max(0, left)
}

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor(z * 1000) / 1000))
}

export function Viewer() {
  const doc = useEditor((s) => s.doc)
  const zoom = useEditor((s) => s.zoom)
  const fitMode = useEditor((s) => s.fitMode)
  const tool = useEditor((s) => s.tool)
  const scale = zoom * CSS_PX_PER_PT
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageEls = useRef(new Map<string, HTMLDivElement>())
  const { near, observe } = useNearViewport(scrollRef, NEAR_MARGIN)
  const anchorRef = useRef<ZoomAnchor | null>(null)
  const cursorAnchor = useRef<{ x: number; y: number } | null>(null)
  const suppressScrollTracking = useRef(0)
  const [spacePan, setSpacePan] = useState(false)
  const [panning, setPanning] = useState(false)

  const registerElement = useCallback((pageId: string, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(pageId, el)
    else pageEls.current.delete(pageId)
  }, [])

  const pages = doc?.pages ?? []

  // --- Zoom anchoring: capture the anchor before React re-renders with the new zoom.
  useEffect(() => {
    return useEditor.subscribe((s, prev) => {
      if (s.zoom === prev.zoom || !s.doc) return
      const root = scrollRef.current
      if (!root) return
      const rootRect = root.getBoundingClientRect()
      const cursor = cursorAnchor.current
      cursorAnchor.current = null
      // At the very top (e.g. right after opening) stay at the top instead of anchoring.
      if (!cursor && root.scrollTop <= 0) {
        anchorRef.current = null
        return
      }
      // Fit page: show the whole current page.
      if (!cursor && s.fitMode === 'page') {
        const index = Math.max(0, s.doc.pages.findIndex((p) => p.id === s.currentPageId))
        anchorRef.current = { pageIndex: index, fx: 0.5, fy: 0, vx: root.clientWidth / 2, vy: VIEWER_PADDING / 2 }
        return
      }
      const vx = cursor ? cursor.x - rootRect.left : root.clientWidth / 2
      const vy = cursor ? cursor.y - rootRect.top : root.clientHeight / 2
      const contentY = root.scrollTop + vy
      const contentX = root.scrollLeft + vx
      const list = prev.doc?.pages ?? s.doc.pages
      let best: ZoomAnchor | null = null
      for (let i = 0; i < list.length; i++) {
        const el = pageEls.current.get(list[i].id)
        if (!el) continue
        const top = el.offsetTop
        const h = el.offsetHeight || 1
        if (contentY < top + h + PAGE_GAP / 2 || i === list.length - 1) {
          const index = s.doc.pages.findIndex((p) => p.id === list[i].id)
          if (index < 0) break
          best = {
            pageIndex: index,
            fx: (contentX - el.offsetLeft) / (el.offsetWidth || 1),
            fy: (contentY - top) / h,
            vx,
            vy
          }
          break
        }
      }
      anchorRef.current = best
    })
  }, [])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const root = scrollRef.current
    anchorRef.current = null
    if (!anchor || !root || !doc) return
    const page = doc.pages[anchor.pageIndex]
    const el = page && pageEls.current.get(page.id)
    if (!el) return
    suppressScrollTracking.current = performance.now() + 100
    root.scrollTop = el.offsetTop + anchor.fy * el.offsetHeight - anchor.vy
    root.scrollLeft = el.offsetLeft + anchor.fx * el.offsetWidth - anchor.vx
  }, [scale, doc])

  // --- Fit width / fit page.
  const currentPageId = useEditor((s) => s.currentPageId)
  const fitPageIndex = fitMode === 'page' ? Math.max(0, pages.findIndex((p) => p.id === currentPageId)) : 0
  const sizes = pages.map(displaySize)
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  const sizesKey = sizes.map((s) => `${s.width}x${s.height}`).join(',')
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root || !fitMode || !sizesKey) return
    const update = () => {
      const z = computeFitZoom(
        fitMode,
        { width: root.clientWidth, height: root.clientHeight },
        sizesRef.current,
        fitPageIndex
      )
      if (z !== null && Math.abs(z - useEditor.getState().zoom) > 0.001) useEditor.getState().setFitZoom(z)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => update())
    ro.observe(root)
    return () => ro.disconnect()
  }, [fitMode, sizesKey, fitPageIndex])

  // --- Scroll requests (thumbnail clicks, page navigation, find).
  const scrollRequest = useEditor((s) => s.scrollRequest)
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!scrollRequest || !root || !doc) return
    const el = pageEls.current.get(scrollRequest.pageId)
    const page = doc.pages.find((p) => p.id === scrollRequest.pageId)
    if (!el || !page) return
    suppressScrollTracking.current = performance.now() + 150
    if (scrollRequest.point) {
      const v = pageToView(scrollRequest.point, page, scale)
      // Only scroll when the point is not comfortably visible already.
      const y = el.offsetTop + v.y
      const x = el.offsetLeft + v.x
      const margin = 60
      const visibleY = y > root.scrollTop + margin && y < root.scrollTop + root.clientHeight - margin
      const visibleX = x > root.scrollLeft + margin && x < root.scrollLeft + root.clientWidth - margin
      if (!visibleY || !visibleX) {
        scrollToPosition(
          root,
          visibleY ? root.scrollTop : y - root.clientHeight / 2,
          visibleX ? root.scrollLeft : x - root.clientWidth / 2
        )
      }
    } else {
      scrollToPosition(root, el.offsetTop - PAGE_GAP / 2, root.scrollLeft)
    }
  }, [scrollRequest?.nonce])

  // --- Current page from scroll position.
  const frame = useRef(0)
  const updateCurrentPage = useCallback(() => {
    frame.current = 0
    const root = scrollRef.current
    const s = useEditor.getState()
    if (!root || !s.doc || !s.doc.pages.length) return
    if (performance.now() < suppressScrollTracking.current) return
    const list = s.doc.pages
    const atBottom = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2
    let current = list[list.length - 1].id
    if (!atBottom) {
      const probe = root.scrollTop + root.clientHeight * 0.35
      let lo = 0
      let hi = list.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        const el = pageEls.current.get(list[mid].id)
        const bottom = el ? el.offsetTop + el.offsetHeight + PAGE_GAP / 2 : 0
        if (bottom < probe) lo = mid + 1
        else hi = mid
      }
      current = list[lo].id
    }
    if (current !== s.currentPageId) s.setCurrentPage(current)
  }, [])

  const onScroll = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(updateCurrentPage)
  }, [updateCurrentPage])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // --- Ctrl/Cmd + wheel and trackpad pinch (ctrlKey wheel events) zoom around the cursor.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const s = useEditor.getState()
      if (!s.doc) return
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      // Mouse wheel notches (~100px) are clamped to ~20% per step; trackpad pinch sends small deltas.
      const delta = Math.max(-25, Math.min(25, e.deltaY * unit))
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.zoom * Math.exp(-delta * 0.008)))
      if (Math.abs(next - s.zoom) < 0.0005) return
      cursorAnchor.current = { x: e.clientX, y: e.clientY }
      s.setZoom(next)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [])

  // --- Panning: hand tool, Space + drag, middle mouse button.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as Node | null
      const inViewer = !!target && !!scrollRef.current?.contains(target)
      if (!(target === document.body || inViewer) || isEditableTarget(e.target)) return
      if (useEditor.getState().doc) {
        e.preventDefault()
        setSpacePan(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePan(false)
    }
    const blur = () => setSpacePan(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const onPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = scrollRef.current
    if (!root) return
    const handTool = tool === 'hand' && e.button === 0
    const middle = e.button === 1
    if (!handTool && !middle && !(spacePan && e.button === 0)) return
    e.preventDefault()
    if (!handTool) e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, left: root.scrollLeft, top: root.scrollTop }
    const id = e.pointerId
    try {
      root.setPointerCapture(id)
    } catch {
      /* not supported (tests) */
    }
    setPanning(true)
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      root.scrollLeft = start.left - (ev.clientX - start.x)
      root.scrollTop = start.top - (ev.clientY - start.y)
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      setPanning(false)
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerup', end)
      root.removeEventListener('pointercancel', end)
    }
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerup', end)
    root.addEventListener('pointercancel', end)
  }

  const panMode = tool === 'hand' || spacePan

  return (
    <div
      ref={scrollRef}
      className={`viewer${panMode ? ' pan-mode' : ''}${panning ? ' panning' : ''}`}
      data-testid="viewer"
      data-tool={tool}
      tabIndex={-1}
      onScroll={onScroll}
      onPointerDownCapture={onPointerDownCapture}
    >
      {doc && pages.length === 0 && (
        <div className="viewer-empty">
          <p>This document has no pages.</p>
          <button className="btn btn-primary" onClick={() => insertBlankPageAt('after')}>
            <FilePlus size={16} aria-hidden="true" /> Insert a blank page
          </button>
        </div>
      )}
      <div className="viewer-pages">
        {doc &&
          pages.map((page, i) => (
            <PageView
              key={page.id}
              page={page}
              index={i}
              scale={scale}
              source={page.source.kind === 'source' ? doc.sources[page.source.sourceId] : undefined}
              near={near.has(page.id)}
              observe={observe}
              registerElement={registerElement}
            />
          ))}
      </div>
    </div>
  )
}
