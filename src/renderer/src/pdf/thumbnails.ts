/**
 * Small page renders for the sidebar. Rendered with pdf.js into an offscreen canvas and kept as
 * blob URLs, cached per (source, page, rotation, size). Renders run through a small queue so
 * thumbnails never starve the main viewer of pdf.js worker time.
 */
import type { SourceDocument } from '@core'
import { getPdfPage, pdfjs } from './pdfjs'

const cache = new Map<string, Promise<string>>()
const MAX_CONCURRENT = 2
let running = 0
const queue: (() => void)[] = []

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++
      job()
        .then(resolve, reject)
        .finally(() => {
          running--
          queue.shift()?.()
        })
    }
    if (running < MAX_CONCURRENT) run()
    else queue.push(run)
  })
}

function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(canvas.toDataURL())
      return
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(URL.createObjectURL(blob))
      else reject(new Error('Could not create thumbnail image'))
    }, 'image/png')
  })
}

export function thumbnailKey(sourceId: string, pageIndex: number, rotation: number, pixelWidth: number): string {
  return `${sourceId}|${pageIndex}|${rotation}|${pixelWidth}`
}

/**
 * Blob URL of a thumbnail `pixelWidth` device pixels wide (height follows the aspect ratio of
 * the page displayed with `rotation`).
 */
export function getThumbnailUrl(
  source: SourceDocument,
  pageIndex: number,
  rotation: number,
  pixelWidth: number
): Promise<string> {
  const key = thumbnailKey(source.id, pageIndex, rotation, pixelWidth)
  let entry = cache.get(key)
  if (!entry) {
    entry = schedule(async () => {
      const page = await getPdfPage(source, pageIndex)
      const base = page.getViewport({ scale: 1, rotation })
      const viewport = page.getViewport({ scale: pixelWidth / base.width, rotation })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise
      const url = await canvasToUrl(canvas)
      canvas.width = 0
      canvas.height = 0
      return url
    })
    entry.catch(() => cache.delete(key))
    cache.set(key, entry)
  }
  return entry
}

/** Drop cached thumbnails of sources that are not in `keepSourceIds`. */
export function releaseThumbnails(keepSourceIds: Iterable<string>): void {
  const keep = new Set(keepSourceIds)
  for (const [key, entry] of cache) {
    const sourceId = key.split('|')[0]
    if (!keep.has(sourceId)) {
      cache.delete(key)
      entry.then((url) => url.startsWith('blob:') && URL.revokeObjectURL(url)).catch(() => undefined)
    }
  }
}
