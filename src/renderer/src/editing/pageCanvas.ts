/**
 * Access to the viewer's rendered page bitmap (the pdf.js <canvas> next to the overlay): sampling
 * the paper colour and cutting snapshots of regions for live previews of content edits.
 * Everything fails soft (returns null) when the canvas is missing or not readable.
 */
import { pageToView, type Box, type Matrix, type PageEntry, type Point } from '@core'
import { boundsOfPoints, invert, multiply, quadOfBox } from './elementGeometry'

export function findPageCanvas(overlay: HTMLElement | null): HTMLCanvasElement | null {
  const canvas = overlay?.parentElement?.querySelector('canvas') ?? null
  return canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings)
  } catch {
    return null
  }
}

/** Affine map from page space (points) to the canvas' pixel space. */
export function pageToCanvasMatrix(
  overlay: HTMLElement,
  canvas: HTMLCanvasElement,
  page: PageEntry,
  scale: number
): Matrix | null {
  const oRect = overlay.getBoundingClientRect()
  const cRect = canvas.getBoundingClientRect()
  if (!cRect.width || !cRect.height) return null
  const sx = canvas.width / cRect.width
  const sy = canvas.height / cRect.height
  const toPx = (p: Point) => {
    const v = pageToView(p, page, scale)
    return { x: (v.x + oRect.left - cRect.left) * sx, y: (v.y + oRect.top - cRect.top) * sy }
  }
  const o = toPx({ x: 0, y: 0 })
  const ex = toPx({ x: 1, y: 0 })
  const ey = toPx({ x: 0, y: 1 })
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y]
}

/** Most frequent opaque colour at the given page-space points; null if unreadable. */
export function sampleColor(overlay: HTMLElement | null, page: PageEntry, scale: number, points: Point[]): string | null {
  try {
    const canvas = findPageCanvas(overlay)
    if (!overlay || !canvas) return null
    const ctx = context(canvas)
    const m = ctx && pageToCanvasMatrix(overlay, canvas, page, scale)
    if (!ctx || !m) return null
    const counts = new Map<string, number>()
    for (const p of points) {
      const px = Math.floor(m[0] * p.x + m[2] * p.y + m[4])
      const py = Math.floor(m[1] * p.x + m[3] * p.y + m[5])
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
      const d = ctx.getImageData(px, py, 1, 1).data
      if (d[3] < 128) continue
      const hex = '#' + [d[0], d[1], d[2]].map((c) => c.toString(16).padStart(2, '0')).join('')
      counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
    let best: string | null = null
    let n = 0
    for (const [hex, c] of counts) if (c > n) [best, n] = [hex, c]
    return best
  } catch {
    return null
  }
}

/** Paper colour just outside a page-space box (default white). */
export function sampleAroundBox(overlay: HTMLElement | null, page: PageEntry, scale: number, b: Box): string {
  const pad = Math.max(1.5, Math.min(b.width, b.height) * 0.1)
  const midX = b.x + b.width / 2
  const midY = b.y + b.height / 2
  return (
    sampleColor(overlay, page, scale, [
      { x: b.x - pad, y: midY },
      { x: b.x + b.width + pad, y: midY },
      { x: midX, y: b.y - pad },
      { x: midX, y: b.y + b.height + pad },
      { x: b.x - pad, y: b.y - pad },
      { x: b.x + b.width + pad, y: b.y + b.height + pad }
    ]) ?? '#ffffff'
  )
}

export interface Snapshot {
  /** PNG data URL of the region, in page orientation (unrotated). */
  url: string
  /** Page-space region it shows. */
  region: Box
}

/** Cut a page-space region out of the rendered page, un-rotated into page orientation. */
export function captureRegion(overlay: HTMLElement | null, page: PageEntry, scale: number, region: Box): Snapshot | null {
  try {
    const canvas = findPageCanvas(overlay)
    if (!overlay || !canvas) return null
    const toPx = pageToCanvasMatrix(overlay, canvas, page, scale)
    if (!toPx) return null
    // Canvas pixels per point.
    const k = Math.hypot(toPx[0], toPx[1]) || 1
    // Snap the region to whole canvas pixels so the snapshot is not resampled (no blur).
    const corners = quadOfBox(region).map((p) => ({
      x: toPx[0] * p.x + toPx[2] * p.y + toPx[4],
      y: toPx[1] * p.x + toPx[3] * p.y + toPx[5]
    }))
    const px = boundsOfPoints(corners)
    const x0 = Math.floor(px.x)
    const y0 = Math.floor(px.y)
    const x1 = Math.ceil(px.x + px.width)
    const y1 = Math.ceil(px.y + px.height)
    const inv = invert(toPx)
    const back = quadOfBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }).map((p) => ({
      x: inv[0] * p.x + inv[2] * p.y + inv[4],
      y: inv[1] * p.x + inv[3] * p.y + inv[5]
    }))
    const snapped = boundsOfPoints(back)
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(snapped.width * k))
    out.height = Math.max(1, Math.round(snapped.height * k))
    const ctx = out.getContext('2d')
    if (!ctx) return null
    // snapshot px = k · (page − region.xy) ; page = toPx⁻¹(canvas px)
    const pageToSnap: Matrix = [k, 0, 0, k, -snapped.x * k, -snapped.y * k]
    const m = multiply(pageToSnap, inv)
    ctx.setTransform(m[0], m[1], m[2], m[3], Math.round(m[4]), Math.round(m[5]))
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(canvas, 0, 0)
    return { url: out.toDataURL('image/png'), region: snapped }
  } catch {
    return null
  }
}

/** Region (page space) to snapshot for a quad: its bounds padded by ~1pt for antialiasing. */
export function snapshotRegion(quad: Point[], pad = 1): Box {
  const b = boundsOfPoints(quad)
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
}

export { quadOfBox }
