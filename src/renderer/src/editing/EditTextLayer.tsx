/**
 * "Edit existing text": hover boxes over the page's text runs (from pdf.js text content).
 * Clicking a run creates a TextObject with an opaque background that covers the original.
 */
import { useEffect, useState } from 'react'
import { pageToView, rotatePoint, type EditObject, type PageEntry, type SourceDocument, type TextObject } from '@core'
import { getPdfPage } from '@renderer/pdf/pdfjs'
import type { ToolOptions } from '@renderer/state/store'
import { round2 } from './manip'
import { makeText } from './objects'
import { safeLayout, safeMeasure } from './textLayout'
import { extractTextRuns, type PdfTextContentLike, type TextRun } from './textRuns'

const cache = new WeakMap<SourceDocument, Map<number, Promise<TextRun[]>>>()

export const EDIT_TEXT_HINT =
  'Click to replace this text. The original is covered by an editable copy on a background box — it is hidden visually, not removed from the file.'

export function loadTextRuns(source: SourceDocument, pageIndex: number): Promise<TextRun[]> {
  let perSource = cache.get(source)
  if (!perSource) {
    perSource = new Map()
    cache.set(source, perSource)
  }
  let p = perSource.get(pageIndex)
  if (!p) {
    p = (async () => {
      const pdfPage = await getPdfPage(source, pageIndex)
      const content = (await pdfPage.getTextContent()) as unknown as PdfTextContentLike
      const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 })
      const fontNameOf = (id: string): string | undefined => {
        try {
          const objs = (pdfPage as unknown as { commonObjs?: { has(id: string): boolean; get(id: string): { name?: string } } }).commonObjs
          return objs?.has(id) ? objs.get(id)?.name : undefined
        } catch {
          return undefined
        }
      }
      return extractTextRuns(content, viewport.transform as number[], fontNameOf)
    })()
    perSource.set(pageIndex, p)
    p.catch(() => perSource!.delete(pageIndex))
  }
  return p
}

export function useTextRuns(page: PageEntry, source: SourceDocument | undefined, enabled: boolean): TextRun[] {
  const [runs, setRuns] = useState<{ key: string; runs: TextRun[] } | null>(null)
  const pageIndex = page.source.kind === 'source' ? page.source.pageIndex : -1
  const key = source ? `${source.id}:${pageIndex}` : ''
  useEffect(() => {
    if (!enabled || !source || pageIndex < 0) return
    let cancelled = false
    loadTextRuns(source, pageIndex).then(
      (r) => !cancelled && setRuns({ key, runs: r }),
      () => !cancelled && setRuns({ key, runs: [] })
    )
    return () => {
      cancelled = true
    }
  }, [enabled, source, pageIndex, key])
  return enabled && runs?.key === key ? runs.runs : []
}

/** True if a text object with a background already covers the run's center. */
function isCovered(run: TextRun, objects: EditObject[]): boolean {
  const cx = run.x + run.width / 2
  const cy = run.top + run.height / 2
  return objects.some(
    (o) => o.type === 'text' && !!o.background && cx >= o.x && cx <= o.x + o.width && cy >= o.y && cy <= o.y + o.height
  )
}

export function EditTextLayer({ runs, objects, scale }: { runs: TextRun[]; objects: EditObject[]; scale: number }) {
  return (
    <div className="ed-runs">
      {runs
        .filter((r) => !isCovered(r, objects))
        .map((r) => {
          const ascentPx = (r.baseline - r.top) * scale
          return (
            <div
              key={r.key}
              className="ed-run"
              data-run-key={r.key}
              data-testid="text-run"
              title={EDIT_TEXT_HINT}
              style={{
                left: r.x * scale,
                top: r.top * scale,
                width: r.width * scale,
                height: r.height * scale,
                transform: r.angle ? `rotate(${r.angle}deg)` : undefined,
                transformOrigin: `0px ${ascentPx}px`
              }}
            />
          )
        })}
    </div>
  )
}

/** Sample the rendered page color just outside the run (via the sibling pdf.js canvas). */
export function sampleBackground(overlay: HTMLElement | null, page: PageEntry, scale: number, run: TextRun): string | null {
  try {
    const canvas = overlay?.parentElement?.querySelector('canvas')
    if (!overlay || !canvas || !canvas.width || !canvas.height) return null
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings)
    if (!ctx) return null
    const oRect = overlay.getBoundingClientRect()
    const cRect = canvas.getBoundingClientRect()
    if (!cRect.width || !cRect.height) return null
    const sx = canvas.width / cRect.width
    const sy = canvas.height / cRect.height
    const pad = Math.max(1.5, run.fontSize * 0.15)
    const midY = run.top + run.height / 2
    const samples = [
      { x: run.x - pad, y: midY },
      { x: run.x + run.width + pad, y: midY },
      { x: run.x + run.width / 2, y: run.top - pad },
      { x: run.x + run.width / 2, y: run.top + run.height + pad },
      { x: run.x - pad, y: run.top - pad },
      { x: run.x + run.width + pad, y: run.top + run.height + pad }
    ]
    const counts = new Map<string, number>()
    for (const p of samples) {
      const v = pageToView(p, page, scale)
      const px = Math.floor((v.x + oRect.left - cRect.left) * sx)
      const py = Math.floor((v.y + oRect.top - cRect.top) * sy)
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
      const d = ctx.getImageData(px, py, 1, 1).data
      if (d[3] < 128) continue
      const hex = '#' + [d[0], d[1], d[2]].map((c) => c.toString(16).padStart(2, '0')).join('')
      counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
    let best: string | null = null
    let bestN = 0
    for (const [hex, n] of counts) if (n > bestN) [best, bestN] = [hex, n]
    return best
  } catch {
    return null
  }
}

/** Text object that covers `run` and shows the same string, aligned to the original baseline. */
export function coveringTextObject(pageId: string, run: TextRun, options: ToolOptions, background: string): TextObject {
  const style = { font: run.font, bold: run.bold, italic: run.italic, fontSize: round2(run.fontSize) }
  const measured = safeMeasure(run.text, style)
  const width = round2(Math.max(run.width, measured) + Math.max(2, run.fontSize * 0.2))
  const base = makeText(
    pageId,
    { x: 0, y: 0, width, height: run.height },
    { ...options, ...style, color: '#000000', opacity: 1 },
    run.text
  )
  const layout = safeLayout(base)
  const firstBaseline = layout.lines[0]?.baseline ?? run.fontSize * 0.9
  const descentBelow = run.top + run.height - run.baseline
  const height = round2(Math.max(layout.height, firstBaseline + descentBelow + 0.5))
  // Box center in the run's rotated frame, relative to the baseline origin.
  const local = { x: width / 2, y: -firstBaseline + height / 2 }
  const c = rotatePoint({ x: run.x + local.x, y: run.baseline + local.y }, { x: run.x, y: run.baseline }, run.angle)
  return {
    ...base,
    x: round2(c.x - width / 2),
    y: round2(c.y - height / 2),
    width,
    height,
    rotation: run.angle ? round2(((run.angle % 360) + 360) % 360) : 0,
    background
  }
}
