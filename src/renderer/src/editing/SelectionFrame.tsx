/** Selection outline and manipulation handles (constant screen size: laid out in CSS px). */
import { isBoxObject, type EditObject } from '@core'
import type { RotRect } from './elementGeometry'
import { handleCursor, inkFrame, RESIZE_HANDLES, type ResizeHandle } from './manip'
import { hasRotation, NOTE_SIZE } from './objects'

const POS: Record<ResizeHandle, [string, string]> = {
  nw: ['0%', '0%'],
  n: ['50%', '0%'],
  ne: ['100%', '0%'],
  e: ['100%', '50%'],
  se: ['100%', '100%'],
  s: ['50%', '100%'],
  sw: ['0%', '100%'],
  w: ['0%', '50%']
}

export interface SelectionFrameProps {
  obj: EditObject
  scale: number
  /** On-screen rotation of the page (degrees), used to pick resize cursors. */
  pageRotation: number
  /** Show only the outline (e.g. while the text editor is open). */
  outlineOnly?: boolean
}

function Handles({ angle, rotate }: { angle: number; rotate: boolean }) {
  return (
    <>
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h}
          className="ed-handle"
          data-handle={h}
          data-testid={`handle-${h}`}
          style={{ left: POS[h][0], top: POS[h][1], cursor: handleCursor(h, angle) }}
        />
      ))}
      {rotate && (
        <>
          <div className="ed-rotate-stem" />
          <div className="ed-handle ed-rotate" data-handle="rotate" data-testid="handle-rotate" title="Rotate (Shift: 15° steps)" />
        </>
      )}
    </>
  )
}

/** Frame with 8 resize handles (and optionally a rotation handle) around a rotated rectangle. */
export function RectFrame({
  rect,
  scale,
  pageRotation,
  rotate,
  outlineOnly,
  testId = 'selection-frame'
}: {
  rect: RotRect
  scale: number
  pageRotation: number
  rotate: boolean
  outlineOnly?: boolean
  testId?: string
}) {
  return (
    <div
      className="ed-frame"
      data-testid={testId}
      style={{
        left: (rect.cx - rect.width / 2) * scale,
        top: (rect.cy - rect.height / 2) * scale,
        width: rect.width * scale,
        height: rect.height * scale,
        transform: rect.angle ? `rotate(${rect.angle}deg)` : undefined
      }}
    >
      {!outlineOnly && <Handles angle={rect.angle + pageRotation} rotate={rotate} />}
    </div>
  )
}

export function SelectionFrame({ obj, scale, pageRotation, outlineOnly }: SelectionFrameProps) {
  if (isBoxObject(obj) || obj.type === 'field') {
    const rotation = hasRotation(obj) ? obj.rotation ?? 0 : 0
    const rect = { cx: obj.x + obj.width / 2, cy: obj.y + obj.height / 2, width: obj.width, height: obj.height, angle: rotation }
    return <RectFrame rect={rect} scale={scale} pageRotation={pageRotation} rotate={hasRotation(obj)} outlineOnly={outlineOnly} />
  }
  switch (obj.type) {
    case 'line': {
      const s = scale
      return (
        <>
          <div className="ed-handle ed-endpoint" data-handle="p1" data-testid="handle-p1" style={{ left: obj.x1 * s, top: obj.y1 * s }} />
          <div className="ed-handle ed-endpoint" data-handle="p2" data-testid="handle-p2" style={{ left: obj.x2 * s, top: obj.y2 * s }} />
        </>
      )
    }
    case 'ink': {
      const b = inkFrame(obj)
      const rect = { cx: b.x + b.width / 2, cy: b.y + b.height / 2, width: b.width, height: b.height, angle: 0 }
      return <RectFrame rect={rect} scale={scale} pageRotation={pageRotation} rotate={false} outlineOnly={outlineOnly} />
    }
    case 'note':
      return (
        <div
          className="ed-frame"
          data-testid="selection-frame"
          style={{ left: obj.x * scale, top: obj.y * scale, width: NOTE_SIZE * scale, height: NOTE_SIZE * scale }}
        />
      )
  }
}
