/**
 * While a signing request waits for its box (state/signing.ts `placing`), each page shows this
 * layer: drag a rectangle (or click for a default-size box) to place the signature; Esc cancels.
 */
import { useEffect, useRef, useState } from 'react'
import { viewToPage, type Box, type PageEntry, type Point } from '@core'
import { cancelPlacement, completePlacement } from '@renderer/actions/signActions'
import { releaseFocusForPage } from '@renderer/editing/focus'
import { isEditableTarget } from '@renderer/actions/util'
import { isDialogOpen } from '@renderer/state/dialogs'
import { useSigning } from '@renderer/state/signing'

/** Default signature box (points) for a click without dragging. */
const DEFAULT_SIZE = { width: 180, height: 54 }
/** Drags smaller than this (CSS px) count as a click. */
const MIN_DRAG = 8

export function SignaturePlacementLayer({ page, scale }: { page: PageEntry; scale: number }) {
  const placing = useSigning((s) => !!s.placing)
  const [drag, setDrag] = useState<{ start: Point; end: Point; pointerId: number } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!placing) return
    const onKey = (e: KeyboardEvent) => {
      // Escape in a field, the find bar or a dialog belongs to them.
      if (e.key !== 'Escape' || isEditableTarget(e.target) || isDialogOpen()) return
      e.preventDefault()
      e.stopPropagation()
      cancelPlacement()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [placing])

  if (!placing) return null

  const local = (e: React.PointerEvent): Point => {
    const r = layerRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const finish = (start: Point, end: Point) => {
    let box: Box
    if (Math.abs(end.x - start.x) < MIN_DRAG || Math.abs(end.y - start.y) < MIN_DRAG) {
      const c = viewToPage(start, page, scale)
      box = { x: c.x - DEFAULT_SIZE.width / 2, y: c.y - DEFAULT_SIZE.height / 2, ...DEFAULT_SIZE }
      // A box that is upright on screen: swap the size on pages shown sideways.
      const rotation = (page.baseRotation + page.rotation) % 360
      if (rotation === 90 || rotation === 270) box = { x: c.x - DEFAULT_SIZE.height / 2, y: c.y - DEFAULT_SIZE.width / 2, width: DEFAULT_SIZE.height, height: DEFAULT_SIZE.width }
    } else {
      const a = viewToPage(start, page, scale)
      const b = viewToPage(end, page, scale)
      box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
    }
    // Keep the box on the page.
    box.x = Math.max(0, Math.min(box.x, page.width - box.width))
    box.y = Math.max(0, Math.min(box.y, page.height - box.height))
    void completePlacement(page.id, box)
  }

  const rect = drag && {
    left: Math.min(drag.start.x, drag.end.x),
    top: Math.min(drag.start.y, drag.end.y),
    width: Math.abs(drag.end.x - drag.start.x),
    height: Math.abs(drag.end.y - drag.start.y)
  }

  return (
    <div
      ref={layerRef}
      className="signature-placement"
      data-testid="signature-placement"
      title="Drag to place the signature (Esc to cancel)"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        releaseFocusForPage()
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId)
        } catch {
          /* ignore */
        }
        const p = local(e)
        setDrag({ start: p, end: p, pointerId: e.pointerId })
      }}
      onPointerMove={(e) => {
        if (!drag || drag.pointerId !== e.pointerId) return
        setDrag({ ...drag, end: local(e) })
      }}
      onPointerUp={(e) => {
        if (!drag || drag.pointerId !== e.pointerId) return
        const end = local(e)
        setDrag(null)
        finish(drag.start, end)
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {rect && <div className="signature-placement-box" style={rect} />}
    </div>
  )
}
