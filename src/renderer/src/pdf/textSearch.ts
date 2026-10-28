/**
 * Text extraction for Find. Builds a searchable string per source page from pdf.js
 * getTextContent() and maps matches back to rectangles in page space (points, unrotated,
 * top-left origin — see src/core/model.ts).
 */
import type { Box, SourceDocument } from '@core'
import { getPdfPage } from './pdfjs'

interface IndexedItem {
  str: string
  start: number
  end: number
  /** Baseline origin in page space. */
  origin: [number, number]
  /** Vector along the baseline for the whole item, in page space. */
  advance: [number, number]
  /** Vector from the baseline up to the top of the glyphs, in page space. */
  up: [number, number]
}

export interface PageTextIndex {
  text: string
  items: IndexedItem[]
}

interface RawTextItem {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

const cache = new Map<string, Promise<PageTextIndex>>()

type TextPage = Awaited<ReturnType<typeof getPdfPage>>

function indexFor(key: string, load: () => Promise<TextPage>): Promise<PageTextIndex> {
  let entry = cache.get(key)
  if (!entry) {
    entry = (async () => {
      const page = await load()
      const viewport = page.getViewport({ scale: 1, rotation: 0 })
      const content = await page.getTextContent()
      return buildIndex(content.items as unknown as RawTextItem[], (x, y) => {
        const [vx, vy] = viewport.convertToViewportPoint(x, y)
        return [vx, vy]
      })
    })()
    entry.catch(() => cache.delete(key))
    cache.set(key, entry)
  }
  return entry
}

export function getPageTextIndex(source: SourceDocument, pageIndex: number): Promise<PageTextIndex> {
  return indexFor(`${source.id}|${pageIndex}`, () => getPdfPage(source, pageIndex))
}

/** Text of a page shown from its preview document (only the latest state per page is cached). */
export function getPreviewTextIndex(pageId: string, previewKey: string, load: () => Promise<TextPage>): Promise<PageTextIndex> {
  const prefix = `preview|${pageId}|`
  for (const k of cache.keys()) if (k.startsWith(prefix) && k !== prefix + previewKey) cache.delete(k)
  return indexFor(prefix + previewKey, load)
}

export function buildIndex(
  rawItems: RawTextItem[],
  toPage: (x: number, y: number) => [number, number]
): PageTextIndex {
  let text = ''
  const items: IndexedItem[] = []
  for (const item of rawItems) {
    if (typeof item.str !== 'string') continue
    const [a, b, c, d, e, f] = item.transform
    const dirLen = Math.hypot(a, b) || 1
    const fontHeight = Math.hypot(c, d) || item.height || 10
    const ux = a / dirLen
    const uy = b / dirLen
    const vx = (c / (Math.hypot(c, d) || 1)) * fontHeight
    const vy = (d / (Math.hypot(c, d) || 1)) * fontHeight
    const o = toPage(e, f)
    const end = toPage(e + ux * item.width, f + uy * item.width)
    const top = toPage(e + vx, f + vy)
    const start = text.length
    text += item.str
    if (item.str.length) {
      items.push({
        str: item.str,
        start,
        end: text.length,
        origin: o,
        advance: [end[0] - o[0], end[1] - o[1]],
        up: [top[0] - o[0], top[1] - o[1]]
      })
    }
    if (item.hasEOL) text += ' '
  }
  return { text, items }
}

let measureCtx: CanvasRenderingContext2D | null | undefined

/**
 * Fractions [s, t] of an item's advance covered by characters [from, to). Uses canvas text
 * metrics of a generic sans-serif font (much closer than character counts), falling back to
 * proportional positions when no canvas is available.
 */
function rangeFractions(str: string, from: number, to: number): [number, number] {
  const len = str.length || 1
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    } catch {
      measureCtx = null
    }
  }
  if (measureCtx) {
    measureCtx.font = '100px Helvetica, Arial, sans-serif'
    const total = measureCtx.measureText(str).width
    if (total > 0) {
      return [measureCtx.measureText(str.slice(0, from)).width / total, measureCtx.measureText(str.slice(0, to)).width / total]
    }
  }
  return [from / len, to / len]
}

/** Rectangles (page space) covering text[start, end). */
export function rectsForRange(index: PageTextIndex, start: number, end: number): Box[] {
  const rects: Box[] = []
  for (const item of index.items) {
    if (item.end <= start || item.start >= end) continue
    const [s, t] = rangeFractions(item.str, Math.max(start, item.start) - item.start, Math.min(end, item.end) - item.start)
    const p0: [number, number] = [item.origin[0] + item.advance[0] * s, item.origin[1] + item.advance[1] * s]
    const p1: [number, number] = [item.origin[0] + item.advance[0] * t, item.origin[1] + item.advance[1] * t]
    const down: [number, number] = [-item.up[0] * 0.25, -item.up[1] * 0.25]
    const up: [number, number] = [item.up[0] * 0.85, item.up[1] * 0.85]
    const pts = [
      [p0[0] + down[0], p0[1] + down[1]],
      [p1[0] + down[0], p1[1] + down[1]],
      [p1[0] + up[0], p1[1] + up[1]],
      [p0[0] + up[0], p0[1] + up[1]]
    ]
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    rects.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y })
  }
  return rects
}

/** Offsets of every case-insensitive occurrence of `query` in `text`. */
export function findAll(text: string, query: string): { start: number; end: number }[] {
  const q = query.toLocaleLowerCase()
  if (!q) return []
  const hay = text.toLocaleLowerCase()
  const out: { start: number; end: number }[] = []
  let from = 0
  for (;;) {
    const i = hay.indexOf(q, from)
    if (i < 0) break
    out.push({ start: i, end: i + q.length })
    from = i + Math.max(1, q.length)
  }
  return out
}

export function releaseTextIndexes(keepSourceIds: Iterable<string>): void {
  const keep = new Set(keepSourceIds)
  for (const key of cache.keys()) {
    if (!keep.has(key.split('|')[0])) cache.delete(key)
  }
}
