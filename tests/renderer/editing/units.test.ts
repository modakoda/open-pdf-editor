import { describe, expect, it } from 'vitest'
import { detectImageMime, readImageSizeFromHeader } from '@renderer/editing/images'
import { mapPaths, normalizeAngle, resizeBox, rotationFromPointer, simplifyPath, snapLine } from '@renderer/editing/manip'
import { screenDeltaToPage } from '@renderer/editing/useEditingShortcuts'
import { placedImageBox } from '@renderer/editing/objects'
import { makePage, pngBytes } from './helpers'

describe('manip geometry', () => {
  const box = { x: 0, y: 0, width: 100, height: 50 }

  it('resizes from each handle keeping the opposite side fixed', () => {
    expect(resizeBox(box, 0, 'se', { x: 150, y: 80 }, false)).toEqual({ x: 0, y: 0, width: 150, height: 80 })
    expect(resizeBox(box, 0, 'w', { x: -50, y: 999 }, false)).toEqual({ x: -50, y: 0, width: 150, height: 50 })
    const n = resizeBox(box, 0, 'n', { x: 0, y: -50 }, true)
    expect(n.height).toBeCloseTo(100)
    expect(n.width).toBeCloseTo(200)
    expect(n.x + n.width / 2).toBeCloseTo(50) // stays centered horizontally
    expect(n.y + n.height).toBeCloseTo(50)
  })

  it('clamps to a minimum size instead of flipping', () => {
    expect(resizeBox(box, 0, 'se', { x: -100, y: -100 }, false, 5)).toMatchObject({ width: 5, height: 5 })
  })

  it('computes rotation from the pointer with optional 15° snapping', () => {
    const c = { x: 0, y: 0 }
    expect(rotationFromPointer(c, { x: 0, y: -10 }, false)).toBe(0)
    expect(rotationFromPointer(c, { x: 10, y: 0 }, false)).toBe(90)
    expect(rotationFromPointer(c, { x: -10, y: 0 }, false)).toBe(270)
    expect(rotationFromPointer(c, { x: 10, y: -9 }, true)).toBe(45)
    expect(normalizeAngle(-90)).toBe(270)
  })

  it('snaps lines to 45° and simplifies paths', () => {
    const s = snapLine({ x: 0, y: 0 }, { x: 10, y: 9 })
    expect(s.x).toBeCloseTo(s.y)
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: i % 2 ? 0.1 : 0 }))
    expect(simplifyPath(pts, 0.5)).toEqual([pts[0], pts[10]])
    expect(simplifyPath([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }], 0.5)).toHaveLength(3)
  })

  it('maps ink points between boxes', () => {
    expect(mapPaths([[{ x: 0, y: 0 }, { x: 10, y: 10 }]], { x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 20, height: 40 })).toEqual([
      [{ x: 5, y: 5 }, { x: 25, y: 45 }]
    ])
  })

  it('converts screen nudges to page deltas for each rotation', () => {
    expect(screenDeltaToPage(makePage('a'), { x: 1, y: 0 })).toEqual({ x: 1, y: 0 })
    expect(screenDeltaToPage(makePage('a', { rotation: 90 }), { x: 1, y: 0 })).toEqual({ x: 0, y: -1 })
    expect(screenDeltaToPage(makePage('a', { rotation: 180 }), { x: 1, y: 0 })).toEqual({ x: -1, y: 0 })
    expect(screenDeltaToPage(makePage('a', { rotation: 270 }), { x: 1, y: 0 })).toEqual({ x: 0, y: 1 })
  })
})

describe('images', () => {
  it('sniffs PNG/JPEG and reads header sizes', () => {
    const png = pngBytes(640, 480)
    expect(detectImageMime(png)).toBe('image/png')
    expect(readImageSizeFromHeader(png, 'image/png')).toEqual({ width: 640, height: 480 })
    // JPEG: SOI, APP0 (len 16), SOF0 with height 300, width 200.
    const jpg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0),
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, ...new Array(9).fill(0)
    ])
    expect(detectImageMime(jpg)).toBe('image/jpeg')
    expect(readImageSizeFromHeader(jpg, 'image/jpeg')).toEqual({ width: 200, height: 300 })
    expect(detectImageMime(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('places images at natural size (px→pt) capped to 40% of the page width', () => {
    const page = { width: 600, height: 800 }
    const small = placedImageBox(page, { data: new Uint8Array(), mimeType: 'image/png', width: 100, height: 50 }, { x: 300, y: 400 })
    expect(small).toEqual({ x: 262.5, y: 381.25, width: 75, height: 37.5 })
    const big = placedImageBox(page, { data: new Uint8Array(), mimeType: 'image/png', width: 4000, height: 1000 }, { x: 0, y: 0 })
    expect(big).toMatchObject({ x: 0, y: 0, width: 240, height: 60 })
  })
})
