/**
 * Redaction areas of one page: always shown (red outline), editable with the Redact tool —
 * drag on the page to mark an area, click to select, drag to move, handles to resize,
 * Delete to remove (see redactionActions.ts for keyboard handling). Every change is undoable.
 */
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  addRedactions,
  clamp,
  displayRotation,
  getRedactionsForPage,
  makeRedaction,
  updateRedaction,
  viewToPage,
  type Box,
  type PageEntry,
  type Point,
  type RedactionArea
} from '@core'
import { useEditor } from '@renderer/state/store'
import { rectFromBox } from './elementGeometry'
import { dragBox, RESIZE_HANDLES, resizeBox, round2, type ResizeHandle } from './manip'
import { useRedaction } from './redactionState'
import { RectFrame } from './SelectionFrame'
import './RedactionsLayer.css'

/** Pointer travel (CSS px) before a press becomes a drag. */
const DRAG_THRESHOLD = 3

type Gesture = {
  pointerId: number
  startClient: Point
  start: Point
  moved: boolean
} & ({ kind: 'create' } | { kind: 'move'; area: RedactionArea } | { kind: 'resize'; area: RedactionArea; handle: ResizeHandle })

function roundBox(b: Box): Box {
  return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) }
}

export function RedactionsLayer({ page, scale, style }: { page: PageEntry; scale: number; style: CSSProperties }) {
  const doc = useEditor((s) => s.doc)
  const tool = useEditor((s) => s.tool)
  const selectedId = useRedaction((s) => s.selectedId)
  const rootRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<{ id: string | null; box: Box } | null>(null)
  const areas = useMemo(() => (doc ? getRedactionsForPage(doc, page.id) : []), [doc, page.id])
  const active = tool === 'redact'
  if (!areas.length && !active) return null

  const toPage = (clientX: number, clientY: number): Point => {
    const r = (rootRef.current?.parentElement ?? rootRef.current)!.getBoundingClientRect()
    return viewToPage({ x: clientX - r.left, y: clientY - r.top }, page, scale)
  }
  const clampPoint = (p: Point): Point => ({ x: clamp(p.x, 0, page.width), y: clamp(p.y, 0, page.height) })

  const boxFor = (g: Gesture, p: Point): Box => {
    if (g.kind === 'create') return dragBox(g.start, clampPoint(p), false)
    if (g.kind === 'move') {
      const a = g.area
      return {
        x: clamp(a.x + p.x - g.start.x, 0, Math.max(0, page.width - a.width)),
        y: clamp(a.y + p.y - g.start.y, 0, Math.max(0, page.height - a.height)),
        width: a.width,
        height: a.height
      }
    }
    const b = resizeBox(g.area, 0, g.handle, clampPoint(p), false, 2)
    return b
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const target = e.target as Element
    const p = toPage(e.clientX, e.clientY)
    const base = { pointerId: e.pointerId, startClient: { x: e.clientX, y: e.clientY }, start: p, moved: false }
    const handle = (target.closest('[data-handle]') as HTMLElement | null)?.dataset.handle as ResizeHandle | undefined
    const selected = areas.find((a) => a.id === selectedId)
    const hitEl = target.closest('[data-redaction-id]') as HTMLElement | null
    const hit = hitEl ? areas.find((a) => a.id === hitEl.dataset.redactionId) : undefined
    if (handle && selected && RESIZE_HANDLES.includes(handle)) {
      gesture.current = { ...base, kind: 'resize', area: selected, handle }
    } else if (hit) {
      useRedaction.getState().select(hit.id)
      gesture.current = { ...base, kind: 'move', area: hit }
    } else {
      gesture.current = { ...base, kind: 'create', start: clampPoint(p) }
    }
    try {
      rootRef.current?.setPointerCapture?.(e.pointerId)
    } catch {
      /* synthetic events */
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointerId !== e.pointerId) return
    if (!g.moved && Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < DRAG_THRESHOLD) return
    g.moved = true
    setPreview({ id: g.kind === 'create' ? null : g.area.id, box: boxFor(g, toPage(e.clientX, e.clientY)) })
  }

  const finish = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const g = gesture.current
    if (!g || g.pointerId !== e.pointerId) return
    gesture.current = null
    setPreview(null)
    try {
      rootRef.current?.releasePointerCapture?.(e.pointerId)
    } catch {
      /* not captured */
    }
    if (!commit) return
    const s = useEditor.getState()
    const ui = useRedaction.getState()
    if (!g.moved) {
      if (g.kind === 'create') ui.select(null)
      return
    }
    const box = roundBox(boxFor(g, toPage(e.clientX, e.clientY)))
    if (g.kind === 'create') {
      if (box.width * scale < 3 || box.height * scale < 3) return
      const area = makeRedaction(page.id, box, { fillColor: ui.fillColor, overlayText: ui.overlayText })
      s.apply((d) => addRedactions(d, [area]))
      ui.select(area.id)
      return
    }
    s.apply((d) => updateRedaction(d, g.area.id, box))
  }

  const shown = areas.map((a) => (preview?.id === a.id ? { ...a, ...preview.box } : a))
  const selected = active ? shown.find((a) => a.id === selectedId) : undefined
  const pageRotation = displayRotation(page)

  return (
    <div
      ref={rootRef}
      className={`ed-layer ed-layer-ui ed-redactions${active ? ' active' : ''}`}
      style={style}
      data-testid="redactions-layer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
    >
      {shown.map((a) => (
        <div
          key={a.id}
          className="ed-redaction"
          data-testid="redaction"
          data-redaction-id={a.id}
          data-selected={a.id === selected?.id ? 'true' : 'false'}
          title={a.overlayText ? `Redaction: “${a.overlayText}”` : 'Redaction'}
          style={{
            left: a.x * scale,
            top: a.y * scale,
            width: a.width * scale,
            height: a.height * scale,
            ['--redact-fill' as string]: a.fillColor === null ? 'transparent' : (a.fillColor ?? '#000000')
          }}
        >
          {a.overlayText && (
            <span className="ed-redaction-text" style={{ fontSize: Math.max(8, Math.min(14, a.height * scale * 0.6)) }}>
              {a.overlayText}
            </span>
          )}
        </div>
      ))}
      {preview && preview.id === null && (
        <div
          className="ed-redaction ed-redaction-draft"
          data-testid="redaction-draft"
          style={{ left: preview.box.x * scale, top: preview.box.y * scale, width: preview.box.width * scale, height: preview.box.height * scale }}
        />
      )}
      {selected && <RectFrame rect={rectFromBox(selected)} scale={scale} pageRotation={pageRotation} rotate={false} testId="redaction-frame" />}
    </div>
  )
}
