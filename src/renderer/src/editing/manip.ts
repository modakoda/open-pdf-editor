/** Pure geometry for creating and manipulating objects (page space, points). */
import { boundsOf, boxFromPoints, rotatePoint, type Box, type EditObject, type Point } from '@core'

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Direction of a handle relative to the box center (-1, 0, 1 per axis). */
export function handleDir(h: ResizeHandle): { hx: number; hy: number } {
  return {
    hx: h.includes('e') ? 1 : h.includes('w') ? -1 : 0,
    hy: h.includes('s') ? 1 : h.startsWith('n') ? -1 : 0
  }
}

/**
 * Resize a box (rotated by `rotation` degrees around its center) by dragging `handle` to
 * `pointer`. The opposite handle stays fixed in page space.
 */
export function resizeBox(
  box: Box,
  rotation: number,
  handle: ResizeHandle,
  pointer: Point,
  keepAspect: boolean,
  minSize = 2
): Box {
  const { hx, hy } = handleDir(handle)
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const anchorLocal = { x: c.x - (hx * box.width) / 2, y: c.y - (hy * box.height) / 2 }
  const anchor = rotatePoint(anchorLocal, c, rotation)
  // Pointer in the box's (unrotated) axes, relative to the anchor.
  const local = rotatePoint(pointer, anchor, -rotation)
  const dx = local.x - anchor.x
  const dy = local.y - anchor.y
  let w = hx !== 0 ? Math.max(minSize, hx * dx) : box.width
  let h = hy !== 0 ? Math.max(minSize, hy * dy) : box.height
  if (keepAspect && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height
    if (hx !== 0 && hy !== 0) {
      const s = Math.max(w / box.width, h / box.height)
      w = Math.max(minSize, box.width * s)
      h = w / ratio
    } else if (hx !== 0) {
      h = w / ratio
    } else {
      w = h * ratio
    }
  }
  const offset = rotatePoint({ x: (hx * w) / 2, y: (hy * h) / 2 }, { x: 0, y: 0 }, rotation)
  const center = { x: anchor.x + offset.x, y: anchor.y + offset.y }
  return { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h }
}

/** Normalize degrees to [0, 360). */
export function normalizeAngle(deg: number): number {
  const r = ((deg % 360) + 360) % 360
  return Math.abs(r - 360) < 1e-9 ? 0 : r
}

/** Rotation (clockwise degrees) for a rotation handle that sits above the box's top edge. */
export function rotationFromPointer(center: Point, pointer: Point, snap: boolean): number {
  const deg = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90
  const value = snap ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10
  return normalizeAngle(value)
}

/** Snap `end` so the segment start→end is a multiple of 45°, keeping its length. */
export function snapLine(start: Point, end: Point): Point {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  const step = Math.PI / 4
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len }
}

/** Box dragged from a to b; `square` forces equal sides (Shift). */
export function dragBox(a: Point, b: Point, square: boolean): Box {
  if (!square) return boxFromPoints(a, b)
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  return boxFromPoints(a, { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s })
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplifyPath(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    const a = points[s]
    const b = points[e]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    let maxD = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const p = points[i]
      const d = len === 0 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function roundPoint(p: Point): Point {
  return { x: round2(p.x), y: round2(p.y) }
}

export function inkBounds(paths: Point[][]): Box {
  return boundsOf(paths.flat())
}

/** Box shown around an ink drawing (bounds padded by half the stroke width). */
export function inkFrame(obj: { paths: Point[][]; strokeWidth: number }): Box {
  const b = inkBounds(obj.paths)
  const pad = obj.strokeWidth / 2
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
}

/** Map points from one box to another (used to scale ink drawings). */
export function mapPaths(paths: Point[][], from: Box, to: Box): Point[][] {
  const sx = from.width > 0 ? to.width / from.width : 1
  const sy = from.height > 0 ? to.height / from.height : 1
  return paths.map((path) =>
    path.map((p) => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy }))
  )
}

/** Move an object by (dx, dy) points. Returns the patch to apply. */
export function translatePatch(obj: EditObject, dx: number, dy: number): Partial<EditObject> {
  switch (obj.type) {
    case 'line':
      return { x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy }
    case 'ink':
      return { paths: obj.paths.map((path) => path.map((p) => ({ x: p.x + dx, y: p.y + dy }))) }
    default:
      return { x: obj.x + dx, y: obj.y + dy }
  }
}

export function translateObject<T extends EditObject>(obj: T, dx: number, dy: number): T {
  return { ...obj, ...translatePatch(obj, dx, dy) } as T
}

/** Fields of `next` that differ from `prev` (shallow). */
export function diffPatch(prev: EditObject, next: EditObject): Partial<EditObject> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(next) as (keyof EditObject)[]) {
    if (key === 'id' || key === 'type') continue
    if (prev[key] !== next[key]) patch[key] = next[key]
  }
  return patch as Partial<EditObject>
}

/** CSS resize cursor for a handle, given the on-screen angle of the box (degrees). */
export function handleCursor(handle: ResizeHandle, angle: number): string {
  const base: Record<ResizeHandle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }
  const a = normalizeAngle(base[handle] + angle)
  const idx = Math.round(a / 45) % 4
  return ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'][idx]
}
