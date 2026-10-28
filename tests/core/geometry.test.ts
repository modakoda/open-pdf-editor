import { describe, expect, it } from 'vitest'
import {
  arrowHead,
  boundsOf,
  boxCorners,
  boxFromPoints,
  displayRotation,
  displaySize,
  intersectBoxes,
  normalizeRotation,
  overlayTransform,
  pageToPdf,
  pageToView,
  pdfToPage,
  rotatePoint,
  viewToPage,
  type Point,
  type Rotation
} from '../../src/core'

const ROTATIONS: Rotation[] = [0, 90, 180, 270]
const page = (baseRotation: Rotation, rotation: Rotation) => ({ width: 600, height: 800, baseRotation, rotation })

/** Apply a CSS transform produced by overlayTransform() to a point (transform-origin 0 0). */
function applyCss(transform: string, p: Point): Point {
  if (transform === 'none') return p
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) rotate\(([-\d.]+)deg\)/.exec(transform)
  if (!m) throw new Error(`unexpected transform ${transform}`)
  const [tx, ty, deg] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const a = (deg * Math.PI) / 180
  // CSS rotate() is clockwise on screen (y down).
  return { x: tx + p.x * Math.cos(a) - p.y * Math.sin(a), y: ty + p.x * Math.sin(a) + p.y * Math.cos(a) }
}

describe('rotation helpers', () => {
  it('normalizes rotations to 0/90/180/270', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-540)).toBe(180)
  })

  it('combines base and user rotation', () => {
    expect(displayRotation(page(90, 270))).toBe(0)
    expect(displayRotation(page(270, 180))).toBe(90)
    expect(displaySize(page(90, 0))).toEqual({ width: 800, height: 600 })
    expect(displaySize(page(90, 90))).toEqual({ width: 600, height: 800 })
  })
})

describe('pageToView / viewToPage', () => {
  const samples: Point[] = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 800 },
    { x: 0, y: 800 },
    { x: 123.5, y: 456.25 }
  ]

  for (const base of ROTATIONS) {
    for (const user of ROTATIONS) {
      it(`round-trips for base ${base} + user ${user}`, () => {
        const pg = page(base, user)
        for (const scale of [1, 1.5, 0.25]) {
          for (const p of samples) {
            const v = pageToView(p, pg, scale)
            const back = viewToPage(v, pg, scale)
            expect(back.x).toBeCloseTo(p.x, 9)
            expect(back.y).toBeCloseTo(p.y, 9)
            const { width, height } = displaySize(pg)
            expect(v.x).toBeGreaterThanOrEqual(-1e-9)
            expect(v.y).toBeGreaterThanOrEqual(-1e-9)
            expect(v.x).toBeLessThanOrEqual(width * scale + 1e-9)
            expect(v.y).toBeLessThanOrEqual(height * scale + 1e-9)
          }
        }
      })
    }
  }

  it('maps the top-left page corner like a clockwise rotation', () => {
    expect(pageToView({ x: 0, y: 0 }, page(0, 0), 1)).toEqual({ x: 0, y: 0 })
    // Rotated 90° clockwise the page's top-left corner ends up at the top-right.
    expect(pageToView({ x: 0, y: 0 }, page(0, 90), 1)).toEqual({ x: 800, y: 0 })
    expect(pageToView({ x: 0, y: 0 }, page(0, 180), 1)).toEqual({ x: 600, y: 800 })
    expect(pageToView({ x: 0, y: 0 }, page(0, 270), 1)).toEqual({ x: 0, y: 600 })
  })

  it('overlayTransform agrees with pageToView for every rotation', () => {
    for (const r of ROTATIONS) {
      const pg = page(0, r)
      for (const scale of [1, 2]) {
        const t = overlayTransform(pg, scale)
        for (const p of samples) {
          const css = applyCss(t, { x: p.x * scale, y: p.y * scale })
          const v = pageToView(p, pg, scale)
          expect(css.x).toBeCloseTo(v.x, 6)
          expect(css.y).toBeCloseTo(v.y, 6)
        }
      }
    }
  })
})

describe('pageToPdf / pdfToPage', () => {
  it('handles crop boxes that do not start at the origin', () => {
    const crop = { x: 50, y: 100, width: 500, height: 600 }
    expect(pageToPdf({ x: 0, y: 0 }, crop)).toEqual({ x: 50, y: 700 })
    expect(pageToPdf({ x: 500, y: 600 }, crop)).toEqual({ x: 550, y: 100 })
    expect(pageToPdf({ x: 10, y: 20 }, crop)).toEqual({ x: 60, y: 680 })
    for (const p of [{ x: 0, y: 0 }, { x: 33, y: 444 }, { x: 500, y: 600 }]) {
      expect(pdfToPage(pageToPdf(p, crop), crop)).toEqual(p)
    }
  })
})

describe('box helpers', () => {
  it('rotates points clockwise in y-down space', () => {
    const p = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(1)
  })

  it('computes rotated corners and bounds', () => {
    const corners = boxCorners({ x: 0, y: 0, width: 100, height: 50 }, 90)
    const b = boundsOf(corners)
    expect(b.width).toBeCloseTo(50)
    expect(b.height).toBeCloseTo(100)
    expect(b.x + b.width / 2).toBeCloseTo(50)
    expect(b.y + b.height / 2).toBeCloseTo(25)
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(boxFromPoints({ x: 10, y: 20 }, { x: 0, y: 5 })).toEqual({ x: 0, y: 5, width: 10, height: 15 })
  })

  it('intersects boxes', () => {
    expect(intersectBoxes({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 5,
      y: 5,
      width: 5,
      height: 5
    })
    expect(intersectBoxes({ x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 })).toBeNull()
  })

  it('builds an arrow head at the line end', () => {
    const head = arrowHead({ x1: 0, y1: 0, x2: 100, y2: 0, strokeWidth: 2 })!
    expect(head.tip).toEqual({ x: 100, y: 0 })
    expect(head.base.x).toBeCloseTo(92)
    expect(head.left.x).toBeCloseTo(92)
    expect(head.right.x).toBeCloseTo(92)
    expect(Math.abs(head.left.y - head.right.y)).toBeCloseTo(8)
    expect(arrowHead({ x1: 5, y1: 5, x2: 5, y2: 5, strokeWidth: 1 })).toBeNull()
    // Never longer than the line itself.
    const short = arrowHead({ x1: 0, y1: 0, x2: 3, y2: 0, strokeWidth: 1 })!
    expect(short.base.x).toBeCloseTo(0)
  })
})
