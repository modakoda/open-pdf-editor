/**
 * Geometry of existing page elements (content items, annotations, field widgets):
 * affine matrices in page space and rotated rectangles used for selection handles.
 */
import { rotatePoint, type Box, type ContentEdit, type ContentItem, type Matrix, type Point } from '@core'

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m1 · m2 (apply m2 first, then m1). Same convention as pdf.js Util.transform. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return IDENTITY
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det
  ]
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy]
}

/** Clockwise rotation (y-down) by `deg` around `c`. */
export function rotationAround(c: Point, deg: number): Matrix {
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return multiply(translation(c.x, c.y), multiply([cos, sin, -sin, cos, 0, 0], translation(-c.x, -c.y)))
}

/** Maps box `from` onto box `to` (scale + translate). */
export function boxToBox(from: Box, to: Box): Matrix {
  const sx = from.width ? to.width / from.width : 1
  const sy = from.height ? to.height / from.height : 1
  return [sx, 0, 0, sy, to.x - from.x * sx, to.y - from.y * sy]
}

export function isIdentity(m: Matrix | undefined, eps = 1e-6): boolean {
  if (!m) return true
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < eps)
}

export function roundMatrix(m: Matrix): Matrix {
  const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d
  return [r(m[0], 6), r(m[1], 6), r(m[2], 6), r(m[3], 6), r(m[4], 3), r(m[5], 3)]
}

/** A rectangle rotated by `angle` degrees (clockwise) around its center. */
export interface RotRect {
  cx: number
  cy: number
  width: number
  height: number
  angle: number
}

export function rectFromBox(b: Box, angle = 0): RotRect {
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, width: b.width, height: b.height, angle }
}

/** Unrotated box of a RotRect (rotation is carried separately). */
export function rectBox(r: RotRect): Box {
  return { x: r.cx - r.width / 2, y: r.cy - r.height / 2, width: r.width, height: r.height }
}

export type Quad = [Point, Point, Point, Point]

export function quadOfBox(b: Box): Quad {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height }
  ]
}

/** Best rectangle for a quad [tl, tr, br, bl] (exact for rectangles). */
export function rectFromQuad(q: Quad): RotRect {
  const width = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y)
  const height = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y)
  const angle = width > 1e-9 ? (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180) / Math.PI : 0
  return {
    cx: (q[0].x + q[2].x) / 2,
    cy: (q[0].y + q[2].y) / 2,
    width,
    height,
    angle: Math.abs(angle) < 1e-6 ? 0 : angle
  }
}

export function quadOfRect(r: RotRect): Quad {
  const c = { x: r.cx, y: r.cy }
  return quadOfBox(rectBox(r)).map((p) => rotatePoint(p, c, r.angle)) as Quad
}

export function boundsOfPoints(pts: Point[]): Box {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/**
 * Matrix that turns rectangle `from` into `to` when both share the same angle: scale along
 * the rectangle's own axes, then move its center.
 */
export function rectToRect(from: RotRect, to: RotRect): Matrix {
  const sx = from.width ? to.width / from.width : 1
  const sy = from.height ? to.height / from.height : 1
  const a = (from.angle * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const rot: Matrix = [cos, sin, -sin, cos, 0, 0]
  const unrot: Matrix = [cos, -sin, sin, cos, 0, 0]
  let m = translation(-from.cx, -from.cy)
  m = multiply(unrot, m)
  m = multiply([sx, 0, 0, sy, 0, 0], m)
  m = multiply(rot, m)
  return multiply(translation(to.cx, to.cy), m)
}

// ---- content items -------------------------------------------------------------------------

export function itemQuad(item: ContentItem): Quad {
  return item.quad ? (item.quad.map((p) => ({ ...p })) as Quad) : quadOfBox(item.bounds)
}

export function editTransform(edit: Pick<ContentEdit, 'transform'> | undefined): Matrix {
  return edit?.transform ?? IDENTITY
}

/** Width of a text run in points (injected so geometry stays free of font code). */
export type MeasureText = (text: string, item: ContentItem, fontSize: number) => number

/**
 * The item's own quad with a text edit applied: replacement text / size change the run's
 * extent along its baseline (ratio of measured widths) and its height, anchored at the origin.
 */
export function editedItemQuad(item: ContentItem, edit: Pick<ContentEdit, 'text' | 'fontSize'> | undefined, measure?: MeasureText): Quad {
  const q = itemQuad(item)
  if (item.kind !== 'text' || !edit || (edit.text === undefined && edit.fontSize === undefined) || !measure) return q
  const fs = item.fontSize || 12
  const size = edit.fontSize ?? fs
  const before = measure(item.text ?? '', item, fs)
  const after = measure(edit.text ?? item.text ?? '', item, size)
  const wr = before > 0 ? after / before : size / fs
  const hr = size / fs
  const o = item.origin ?? q[3]
  const len = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) || 1
  const u = { x: (q[1].x - q[0].x) / len, y: (q[1].y - q[0].y) / len }
  const v = { x: -u.y, y: u.x }
  return q.map((p) => {
    const a = (p.x - o.x) * u.x + (p.y - o.y) * u.y
    const b = (p.x - o.x) * v.x + (p.y - o.y) * v.y
    return { x: o.x + u.x * a * wr + v.x * b * hr, y: o.y + u.y * a * wr + v.y * b * hr }
  }) as Quad
}

/** Quad of an item at its current placement. */
export function placedQuad(item: ContentItem, transform: Matrix, edit?: ContentEdit, measure?: MeasureText): Quad {
  return editedItemQuad(item, edit, measure).map((p) => apply(transform, p)) as Quad
}

export function placedRect(item: ContentItem, transform: Matrix, edit?: ContentEdit, measure?: MeasureText): RotRect {
  return rectFromQuad(placedQuad(item, transform, edit, measure))
}

/** Scale factor of a matrix along the text's vertical direction (for font sizes). */
export function verticalScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
}

/** Rotation (clockwise degrees) of a matrix's x axis. */
export function matrixAngle(m: Matrix): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI
}
