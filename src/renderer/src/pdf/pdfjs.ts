/**
 * pdf.js loading service. One pdf.js document per SourceDocument, cached by source id.
 * Rendering uses the original source bytes; page order/rotation come from the EditorDocument.
 */
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { SourceDocument } from '@core'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }
export type { PDFDocumentProxy, PDFPageProxy }

/** Base URL for pdf.js assets copied by scripts/copy-pdfjs-assets.mjs into public/pdfjs. */
function assetUrl(dir: string): string {
  return new URL(`pdfjs/${dir}/`, document.baseURI).href
}

type LoadingTask = ReturnType<typeof pdfjs.getDocument>

const cache = new Map<string, LoadingTask>()

/**
 * Open raw bytes with pdf.js (not cached). The bytes are copied because pdf.js transfers them
 * to its worker. Call `.destroy()` on the returned task to free it; await `.promise` for the document.
 */
export function openPdfBytes(bytes: Uint8Array, password?: string): LoadingTask {
  return pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs')
  })
}

export function getPdfDocument(source: SourceDocument): Promise<PDFDocumentProxy> {
  let task = cache.get(source.id)
  if (!task) {
    task = openPdfBytes(source.bytes, source.password)
    task.promise.catch(() => cache.delete(source.id))
    cache.set(source.id, task)
  }
  return task.promise
}

/** pdf.js page for a 0-based page index of a source. */
export async function getPdfPage(source: SourceDocument, pageIndex: number): Promise<PDFPageProxy> {
  const doc = await getPdfDocument(source)
  return doc.getPage(pageIndex + 1)
}

/** Free pdf.js resources for sources that are no longer part of any open document. */
export function releaseSources(keepIds: Iterable<string>): void {
  const keep = new Set(keepIds)
  for (const [id, task] of cache) {
    if (!keep.has(id)) {
      cache.delete(id)
      task.destroy().catch(() => undefined)
    }
  }
}
