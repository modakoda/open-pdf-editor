/**
 * Path geometry: segments in user space, tight bounds (Bézier extrema), re-emission.
 */
import type { Matrix } from '../model'
import { apply, type Rect } from './matrix'
import { fmt } from './serialize'

/** Path segment with absolute coordinates (m/l: 2 numbers, c: 6, h: none). */
export interface Seg {
  op: 'm' | 'l' | 'c' | 'h'
  pts: number[]
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number, out: number[]): void {
  // derivative: a t² + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const push = (t: number) => {
    if (t > 0 && t < 1) {
      const mt = 1 - t
      out.push(mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3)
    }
  }
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) push(-c / b)
    return
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return
  const sq = Math.sqrt(disc)
  push((-b + sq) / (2 * a))
  push((-b - sq) / (2 * a))
}

/** Tight bounds of the segments after applying `m` (identity if omitted). */
export function pathBounds(segs: Seg[], m?: Matrix): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  const tr = (x: number, y: number) => (m ? apply(m, x, y) : { x, y })
  let cur = { x: 0, y: 0 }
  for (const s of segs) {
    if (s.op === 'h') continue
    if (s.op === 'm' || s.op === 'l') {
      cur = tr(s.pts[0], s.pts[1])
      add(cur.x, cur.y)
      continue
    }
    const p1 = tr(s.pts[0], s.pts[1])
    const p2 = tr(s.pts[2], s.pts[3])
    const p3 = tr(s.pts[4], s.pts[5])
    add(p3.x, p3.y)
    const xs: number[] = []
    const ys: number[] = []
    cubicExtrema(cur.x, p1.x, p2.x, p3.x, xs)
    cubicExtrema(cur.y, p1.y, p2.y, p3.y, ys)
    for (const x of xs) add(x, cur.y)
    for (const y of ys) add(cur.x, y)
    // xs/ys only extend one axis each; the other coordinate is within the endpoints' range.
    cur = p3
  }
  if (x0 === Infinity) return null
  return { x0, y0, x1, y1 }
}

/** Path construction operators for the segments, coordinates transformed by `m`. */
export function writePath(segs: Seg[], m: Matrix): string {
  const parts: string[] = []
  for (const s of segs) {
    if (s.op === 'h') {
      parts.push('h')
      continue
    }
    const coords: string[] = []
    for (let i = 0; i < s.pts.length; i += 2) {
      const p = apply(m, s.pts[i], s.pts[i + 1])
      coords.push(fmt(p.x, 4), fmt(p.y, 4))
    }
    parts.push(coords.join(' ') + ' ' + s.op)
  }
  return parts.join('\n')
}
