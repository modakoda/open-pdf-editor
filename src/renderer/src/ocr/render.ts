/**
 * Page images for text recognition: the page as displayed (its displayed rotation, content
 * edits applied through its preview document), rendered with pdf.js at OCR_DPI.
 */
import { displayRotation, type Color, type EditorDocument, type PageEntry, type RecognizedLine } from '@core'
import { getPdfPage, pdfjs } from '@renderer/pdf/pdfjs'
import { getPreviewPage, hasPreviewFailed, previewKeyFor } from '@renderer/pdf/previews'

/** Resolution of the page images (Tesseract works best around 300 dpi). */
export const OCR_DPI = 300
/** Upper bound for very large pages. */
const MAX_PIXELS = 40_000_000

export interface OcrImage {
  canvas: HTMLCanvasElement
  /** Pixels per point. */
  scale: number
}

/** Render a page for recognition, or null for pages without content (blank pages). */
export async function renderPageForOcr(doc: EditorDocument, page: PageEntry): Promise<OcrImage | null> {
  if (page.source.kind !== 'source') return null
  const source = doc.sources[page.source.sourceId]
  if (!source) return null
  const key = previewKeyFor(doc, page)
  const pdfPage =
    key && !hasPreviewFailed(key) ? await getPreviewPage(doc, page.id, key) : await getPdfPage(source, page.source.pageIndex)
  const rotation = displayRotation(page)
  const base = pdfPage.getViewport({ scale: 1, rotation })
  let scale = OCR_DPI / 72
  const pixels = base.width * base.height * scale * scale
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels)
  const viewport = pdfPage.getViewport({ scale, rotation })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  await pdfPage.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE, background: '#ffffff' }).promise
  return { canvas, scale: canvas.width / base.width }
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

/**
 * Background (the light pixels) and ink color (the dark pixels) around each line, so a line
 * turned into editable text can be covered in the scan's own paper color.
 */
export function sampleLineColors(canvas: HTMLCanvasElement, lines: RecognizedLine[]): RecognizedLine[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !lines.length) return lines
  return lines.map((line) => {
    const pad = Math.max(2, Math.round((line.bbox.y1 - line.bbox.y0) * 0.15))
    const x0 = Math.max(0, Math.floor(line.bbox.x0 - pad))
    const y0 = Math.max(0, Math.floor(line.bbox.y0 - pad))
    const x1 = Math.min(canvas.width, Math.ceil(line.bbox.x1 + pad))
    const y1 = Math.min(canvas.height, Math.ceil(line.bbox.y1 + pad))
    if (x1 - x0 < 2 || y1 - y0 < 2) return line
    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
    } catch {
      return line
    }
    const step = Math.max(1, Math.floor(Math.sqrt(data.length / 4 / 20000)))
    const samples: [number, number, number, number][] = []
    const width = x1 - x0
    for (let y = 0; y < y1 - y0; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        samples.push([0.299 * r + 0.587 * g + 0.114 * b, r, g, b])
      }
    }
    if (samples.length < 4) return line
    samples.sort((a, b) => a[0] - b[0])
    const mean = (from: number, to: number): Color => {
      const part = samples.slice(Math.floor(from * samples.length), Math.max(Math.floor(from * samples.length) + 1, Math.floor(to * samples.length)))
      const sum = part.reduce((acc, s) => [acc[0] + s[1], acc[1] + s[2], acc[2] + s[3]], [0, 0, 0])
      return hex(sum[0] / part.length, sum[1] / part.length, sum[2] / part.length)
    }
    const background = mean(0.6, 1)
    return { ...line, background: background === '#fefefe' || background === '#fdfdfd' ? '#ffffff' : background, color: mean(0, 0.05) }
  })
}
