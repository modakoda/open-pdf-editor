import type { Box, PageEntry, Point, Rotation } from './model'

/** CSS pixels per PDF point at 100% zoom (96 dpi screen / 72 pt per inch). */
export const CSS_PX_PER_PT = 96 / 72

export function normalizeRotation(degrees: number): Rotation {
  const r = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360
  return r as Rotation
}

/** Rotation the page is displayed with: its own /Rotate plus the user's rotation. */
export function displayRotation(page: Pick<PageEntry, 'baseRotation' | 'rotation'>): Rotation {
  return normalizeRotation(page.baseRotation + page.rotation)
}

/** Size of the page as displayed (width/height swap for 90° and 270°), in points. */
export function displaySize(page: Pick<PageEntry, 'width' | 'height' | 'baseRotation' | 'rotation'>): {
  width: number
  height: number
} {
  const r = displayRotation(page)
  return r === 90 || r === 270
    ? { width: page.height, height: page.width }
    : { width: page.width, height: page.height }
}

type PageGeom = Pick<PageEntry, 'width' | 'height' | 'baseRotation' | 'rotation'>

/**
 * Page space (points, unrotated, top-left origin) → view space (CSS px of the displayed,
 * rotated page, top-left origin) at `scale` px per point.
 */
export function pageToView(p: Point, page: PageGeom, scale: number): Point {
  const W = page.width
  const H = page.height
  let x: number
  let y: number
  switch (displayRotation(page)) {
    case 0:
      x = p.x
      y = p.y
      break
    case 90:
      x = H - p.y
      y = p.x
      break
    case 180:
      x = W - p.x
      y = H - p.y
      break
    case 270:
      x = p.y
      y = W - p.x
      break
  }
  return { x: x * scale, y: y * scale }
}

/** Inverse of {@link pageToView}. */
export function viewToPage(v: Point, page: PageGeom, scale: number): Point {
  const W = page.width
  const H = page.height
  const u = v.x / scale
  const w = v.y / scale
  switch (displayRotation(page)) {
    case 0:
      return { x: u, y: w }
    case 90:
      return { x: w, y: H - u }
    case 180:
      return { x: W - u, y: H - w }
    case 270:
      return { x: W - w, y: u }
  }
}

/**
 * CSS transform for an overlay element that is laid out in unrotated page space
 * (size width*scale × height*scale, `transform-origin: 0 0`) so that it lines up with the
 * rotated page as rendered by pdf.js.
 */
export function overlayTransform(page: PageGeom, scale: number): string {
  const W = page.width * scale
  const H = page.height * scale
  switch (displayRotation(page)) {
    case 0:
      return 'none'
    case 90:
      return `translate(${H}px, 0px) rotate(90deg)`
    case 180:
      return `translate(${W}px, ${H}px) rotate(180deg)`
    case 270:
      return `translate(0px, ${W}px) rotate(270deg)`
  }
}

/** Visible box of a page in PDF user space (bottom-left origin), e.g. from pdf-lib's getCropBox(). */
export interface PdfBox {
  x: number
  y: number
  width: number
  height: number
}

/** Page space → PDF user space of the page. */
export function pageToPdf(p: Point, cropBox: PdfBox): Point {
  return { x: cropBox.x + p.x, y: cropBox.y + cropBox.height - p.y }
}

/** PDF user space → page space. */
export function pdfToPage(p: Point, cropBox: PdfBox): Point {
  return { x: p.x - cropBox.x, y: cropBox.y + cropBox.height - p.y }
}

export function boxCenter(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Rotate `p` around `center` by `degrees`, clockwise in a y-down coordinate system. */
export function rotatePoint(p: Point, center: Point, degrees: number): Point {
  if (!degrees) return { x: p.x, y: p.y }
  const a = (degrees * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}

/** Corners of a box rotated around its center: [top-left, top-right, bottom-right, bottom-left]. */
export function boxCorners(box: Box, rotation = 0): [Point, Point, Point, Point] {
  const c = boxCenter(box)
  const pts: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ]
  return pts.map((p) => rotatePoint(p, c, rotation)) as [Point, Point, Point, Point]
}

/** Axis-aligned bounds of a set of points. */
export function boundsOf(points: Point[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Normalize a box drawn by dragging from (x1,y1) to (x2,y2) in any direction. */
export function boxFromPoints(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y)
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Size (points, page space) of a sticky-note icon; the exported /Text annotation's Rect is
 * NOTE_ICON_SIZE × NOTE_ICON_SIZE with its top-left corner at the note's (x, y).
 * 22 matches the icon size pdf.js uses when it renders text annotations. */
export const NOTE_ICON_SIZE = 22

export interface ArrowHead {
  /** Tip of the arrow (= the line's end point). */
  tip: Point
  /** The two back corners of the head triangle. */
  left: Point
  right: Point
  /** Point where the shaft should end (center of the head's back edge). */
  base: Point
}

/**
 * Geometry of the arrow head drawn at (x2, y2) of a line (page space). Shared by the overlay
 * and the exporter so both draw the same triangle. Returns null for zero-length lines.
 */
export function arrowHead(
  line: { x1: number; y1: number; x2: number; y2: number; strokeWidth: number }
): ArrowHead | null {
  const dx = line.x2 - line.x1
  const dy = line.y2 - line.y1
  const len = Math.hypot(dx, dy)
  if (!len) return null
  const ux = dx / len
  const uy = dy / len
  const length = Math.min(Math.max(8, line.strokeWidth * 4), len)
  const half = length * 0.5
  const base = { x: line.x2 - ux * length, y: line.y2 - uy * length }
  return {
    tip: { x: line.x2, y: line.y2 },
    left: { x: base.x - uy * half, y: base.y + ux * half },
    right: { x: base.x + uy * half, y: base.y - ux * half },
    base
  }
}

/** Intersection of two boxes (any coordinate system); null if they do not overlap. */
export function intersectBoxes(a: Box, b: Box): Box | null {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}
