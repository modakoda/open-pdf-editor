/** Selection outline and manipulation handles (constant screen size: laid out in CSS px). */
import { isBoxObject, type EditObject } from '@core'
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

export function SelectionFrame({ obj, scale, pageRotation, outlineOnly }: SelectionFrameProps) {
  if (isBoxObject(obj)) {
    const rotation = hasRotation(obj) ? obj.rotation ?? 0 : 0
    return (
      <div
        className="ed-frame"
        data-testid="selection-frame"
        style={{
          left: obj.x * scale,
          top: obj.y * scale,
          width: obj.width * scale,
          height: obj.height * scale,
          transform: rotation ? `rotate(${rotation}deg)` : undefined
        }}
      >
        {!outlineOnly && <Handles angle={rotation + pageRotation} rotate={hasRotation(obj)} />}
      </div>
    )
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
      return (
        <div
          className="ed-frame"
          data-testid="selection-frame"
          style={{ left: b.x * scale, top: b.y * scale, width: b.width * scale, height: b.height * scale }}
        >
          {!outlineOnly && <Handles angle={pageRotation} rotate={false} />}
        </div>
      )
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
