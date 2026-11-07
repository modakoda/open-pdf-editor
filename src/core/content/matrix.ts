/**
 * 2D affine matrices in PDF convention [a b c d e f]: p' = (a·x + c·y + e, b·x + d·y + f).
 * `mul(m1, m2)` is "m1 then m2" (PDF row-vector order: p × m1 × m2).
 */
import type { Matrix, Point } from '../model'
import type { PdfBox } from '../geometry'

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ]
}

export function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/** Transform a direction vector (no translation). */
export function applyVec(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y }
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det || !Number.isFinite(det)) return null
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}

export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty]
}

export function isFiniteMatrix(m: readonly number[]): boolean {
  return m.length === 6 && m.every((v) => typeof v === 'number' && Number.isFinite(v))
}

/** Page space (y down, origin top-left of the crop box) → PDF user space, as a matrix. */
export function pageToUserMatrix(box: PdfBox): Matrix {
  return [1, 0, 0, -1, box.x, box.y + box.height]
}

export function userToPageMatrix(box: PdfBox): Matrix {
  return [1, 0, 0, -1, -box.x, box.y + box.height]
}

/** A page-space transform expressed in PDF user space: U = P⁻¹ · T · P (row-vector order). */
export function pageTransformToUser(t: Matrix, box: PdfBox): Matrix {
  return mul(mul(userToPageMatrix(box), t), pageToUserMatrix(box))
}

/** Largest scale factor of the linear part (for line widths). */
export function maxScale(m: Matrix): number {
  const a = Math.hypot(m[0], m[1])
  const b = Math.hypot(m[2], m[3])
  return Math.max(a, b)
}

export function sameLinear(m1: Matrix, m2: Matrix, tol = 1e-3): boolean {
  const s = Math.max(1e-9, Math.abs(m1[0]) + Math.abs(m1[1]) + Math.abs(m1[2]) + Math.abs(m1[3]))
  for (let i = 0; i < 4; i++) if (Math.abs(m1[i] - m2[i]) > tol * s) return false
  return true
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function rectOfPoints(pts: Point[]): Rect | null {
  if (!pts.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1 }
}

export function transformRect(m: Matrix, r: Rect): Rect {
  return rectOfPoints([apply(m, r.x0, r.y0), apply(m, r.x1, r.y0), apply(m, r.x1, r.y1), apply(m, r.x0, r.y1)])!
}

export function intersectRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
}

export function rectIsEmpty(r: Rect): boolean {
  return !(r.x1 > r.x0) || !(r.y1 > r.y0)
}
