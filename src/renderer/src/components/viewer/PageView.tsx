/**
 * One page in the continuous viewer: a white box sized to the displayed page, the pdf.js canvas
 * (rendered lazily when near the viewport), find highlights and the editing overlay.
 *
 * Re-renders (zoom/rotation/edits) draw into an offscreen canvas and are copied over the visible
 * one only when complete, so the old bitmap (stretched by CSS) stays visible meanwhile: no flicker.
 * Pages with edits to their existing content are drawn from a preview document (pdf/previews.ts).
 * After every completed render 'ope:page-rendered' is dispatched on the page element.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { displayRotation, displaySize, pageToView, type Box, type PageEntry, type SourceDocument } from '@core'
import { PageOverlay } from '@renderer/editing'
import { getPdfPage, pdfjs } from '@renderer/pdf/pdfjs'
import { getPreviewPage, hasPreviewFailed, markPreviewFailed, shouldNotifyPreviewFailure } from '@renderer/pdf/previews'
import { useFind } from '@renderer/state/find'
import { useEditor } from '@renderer/state/store'
import { SignaturePlacementLayer } from '../signatures/SignaturePlacementLayer'
import { Decorations } from './Decorations'

/** Upper bound for canvas size (device pixels); larger renders are done at a lower resolution. */
const MAX_CANVAS_PIXELS = 24_000_000
const RERENDER_DELAY_MS = 80
/** Debounce for re-rendering a page from a new preview after its content was edited. */
const PREVIEW_DELAY_MS = 100

export interface PageViewProps {
  page: PageEntry
  index: number
  scale: number
  source: SourceDocument | undefined
  /** Fingerprint of the page's edits when it is shown from a preview document (pdf/previews.ts). */
  previewKey?: string | null
  near: boolean
  observe: (key: string, el: HTMLElement | null) => void
  registerElement: (pageId: string, el: HTMLDivElement | null) => void
}

/** Dispatched on the page element after every completed canvas render. */
export const PAGE_RENDERED_EVENT = 'ope:page-rendered'

function isCancelled(err: unknown): boolean {
  return err instanceof Error && (err.name === 'RenderingCancelledException' || /cancel/i.test(err.message))
}

type PdfPage = Awaited<ReturnType<typeof getPdfPage>>

/**
 * The pdf.js page to draw: the preview document for edited pages, else the source page.
 * A failing preview falls back to the source page (with a one-time notice).
 */
async function loadDisplayPage(
  pageId: string,
  source: SourceDocument,
  sourcePage: number,
  previewKey: string | null | undefined,
  isStale: () => boolean
): Promise<PdfPage> {
  const doc = useEditor.getState().doc
  if (previewKey && doc && !hasPreviewFailed(previewKey)) {
    try {
      return await getPreviewPage(doc, pageId, previewKey)
    } catch (err) {
      if (isStale() || isCancelled(err)) throw err
      console.error('Page preview failed', err)
      markPreviewFailed(previewKey)
      if (shouldNotifyPreviewFailure()) {
        useEditor.getState().showNotice('error', 'Some edits could not be previewed; the original page is shown instead.')
      }
    }
  }
  return getPdfPage(source, sourcePage)
}

export const PageView = memo(function PageView({ page, index, scale, source, previewKey = null, near, observe, registerElement }: PageViewProps) {
  const size = displaySize(page)
  const rotation = displayRotation(page)
  const width = size.width * scale
  const height = size.height * scale
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pageElRef = useRef<HTMLDivElement | null>(null)
  const renderedKey = useRef<string | null>(null)
  const renderedPreview = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState(false)

  const sourcePage = page.source.kind === 'source' ? page.source.pageIndex : -1
  const isBlank = page.source.kind === 'blank'

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      pageElRef.current = el
      observe(page.id, el)
      registerElement(page.id, el)
    },
    [observe, registerElement, page.id]
  )

  useEffect(() => {
    if (isBlank) return
    const canvas = canvasRef.current
    if (!near) {
      // Free the bitmap of pages far from the viewport.
      if (canvas && renderedKey.current) {
        canvas.width = 0
        canvas.height = 0
        renderedKey.current = null
        renderedPreview.current = null
        setRendered(false)
      }
      return
    }
    if (!source) {
      setError('Source document is missing')
      return
    }
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const key = `${source.id}|${sourcePage}|${rotation}|${scale}|${dpr}|${previewKey ?? ''}`
    if (renderedKey.current === key) return

    let cancelled = false
    let task: { cancel(): void; promise: Promise<unknown> } | null = null
    const run = async () => {
      try {
        const pdfPage = await loadDisplayPage(page.id, source, sourcePage, previewKey, () => cancelled)
        if (cancelled) return
        const base = pdfPage.getViewport({ scale: 1, rotation })
        let renderScale = scale * dpr
        const pixels = base.width * base.height * renderScale * renderScale
        if (pixels > MAX_CANVAS_PIXELS) renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels)
        const viewport = pdfPage.getViewport({ scale: renderScale, rotation })
        const offscreen = document.createElement('canvas')
        offscreen.width = Math.max(1, Math.round(viewport.width))
        offscreen.height = Math.max(1, Math.round(viewport.height))
        task = pdfPage.render({
          canvas: offscreen,
          viewport,
          annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS
        })
        await task.promise
        if (cancelled) return
        const target = canvasRef.current
        if (target) {
          target.width = offscreen.width
          target.height = offscreen.height
          target.getContext('2d')?.drawImage(offscreen, 0, 0)
        }
        offscreen.width = 0
        offscreen.height = 0
        renderedKey.current = key
        renderedPreview.current = previewKey
        setRendered(true)
        setError(null)
        pageElRef.current?.dispatchEvent(new CustomEvent(PAGE_RENDERED_EVENT, { bubbles: true, detail: { pageId: page.id } }))
      } catch (err) {
        if (cancelled || isCancelled(err)) return
        console.error('Page render failed', err)
        setError('This page could not be displayed')
      }
    }
    // First render immediately; re-renders are debounced (zoom bursts, edits while dragging).
    const delay = !renderedKey.current ? 0 : renderedPreview.current !== previewKey ? PREVIEW_DELAY_MS : RERENDER_DELAY_MS
    const timer = setTimeout(run, delay)
    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
    }
  }, [near, source, sourcePage, rotation, scale, isBlank, previewKey, page.id])

  return (
    <div
      ref={ref}
      className="page"
      data-testid="page"
      data-page-id={page.id}
      data-page-index={index}
      data-rotation={rotation}
      data-rendered={isBlank || rendered ? 'true' : 'false'}
      style={{ position: 'relative', width, height }}
    >
      {!isBlank && <canvas ref={canvasRef} className="page-canvas" aria-hidden="true" />}
      {error && <div className="page-error">{error}</div>}
      <Decorations index={index} scale={scale} />
      <FindHighlights page={page} scale={scale} />
      <PageOverlay page={page} pageIndex={index} scale={scale} />
      <SignaturePlacementLayer page={page} scale={scale} />
    </div>
  )
})

function FindHighlights({ page, scale }: { page: PageEntry; scale: number }) {
  const matches = useFind((s) => s.matches)
  const activeMatch = useFind((s) => (s.active >= 0 ? s.matches[s.active] : undefined))
  const rects = useMemo(() => {
    const out: { box: Box; active: boolean }[] = []
    for (const m of matches) {
      if (m.pageId !== page.id) continue
      for (const r of m.rects) out.push({ box: r, active: m === activeMatch })
    }
    return out
  }, [matches, activeMatch, page.id])
  if (!rects.length) return null
  return (
    <div className="find-highlights" aria-hidden="true">
      {rects.map(({ box, active }, i) => {
        const a = pageToView({ x: box.x, y: box.y }, page, scale)
        const b = pageToView({ x: box.x + box.width, y: box.y + box.height }, page, scale)
        return (
          <div
            key={i}
            className={`find-highlight${active ? ' active' : ''}`}
            style={{
              left: Math.min(a.x, b.x),
              top: Math.min(a.y, b.y),
              width: Math.abs(b.x - a.x),
              height: Math.abs(b.y - a.y)
            }}
          />
        )
      })}
    </div>
  )
}
