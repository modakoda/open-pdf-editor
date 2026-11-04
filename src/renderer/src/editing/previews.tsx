/**
 * Live previews of edits to existing content and annotations. The page bitmap only shows an
 * edit after the viewer re-renders the page, so meanwhile the element's region is masked in
 * the paper colour and a snapshot of it (cut from the page canvas) is drawn at the new place.
 * The viewer dispatches `ope:page-rendered` on the page element after each render: then the
 * previews are dropped.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Box, ContentItem, EditorDocument, Matrix, PageEntry, Point } from '@core'
import { useEditor, type ElementRef } from '@renderer/state/store'
import {
  apply,
  boxToBox,
  invert,
  matrixAngle,
  multiply,
  placedQuad,
  quadOfBox,
  verticalScale
} from './elementGeometry'
import { refKey, resolveElement, type ElementChange, type ElementGeom } from './elements'
import { captureRegion, sampleAroundBox, snapshotRegion, type Snapshot } from './pageCanvas'
import { contentTextFont, measureContentText } from './textLayout'

export const PAGE_RENDERED_EVENT = 'ope:page-rendered'

export interface PreviewEntry {
  key: string
  ref: ElementRef
  snapshot: Snapshot | null
  /** Geometry/content as shown by the canvas when the entry was created. */
  base: { transform?: Matrix; box?: Box; text?: string; fontSize?: number; color?: string }
  maskQuad: Point[]
  /** Extra mask margin in points. */
  maskPad: number
  maskColor: string
}

type Host = (ref: ElementRef) => void
const hosts = new Map<string, Host>()

/** Make sure the page showing `ref` keeps a preview of it (call before editing it). */
export function ensureElementPreview(ref: ElementRef): void {
  hosts.get(ref.pageId)?.(ref)
}

function geomQuad(g: ElementGeom): Point[] {
  return g.kind === 'content' ? placedQuad(g.item, g.transform, g.edit, measureContentText) : quadOfBox(g.box)
}

export function useElementPreviews(
  rootRef: RefObject<HTMLDivElement | null>,
  page: PageEntry,
  scale: number,
  items: ContentItem[]
): { entries: PreviewEntry[]; ensure: (ref: ElementRef) => void; renderedDoc: EditorDocument | null } {
  const [entries, setEntries] = useState<PreviewEntry[]>([])
  // The document as of the last completed render of this page (what the canvas shows).
  const [renderedDoc, setRenderedDoc] = useState<EditorDocument | null>(() => useEditor.getState().doc)
  const latest = useRef({ page, scale, items, entries })
  latest.current = { page, scale, items, entries }

  const ensure = useCallback(
    (ref: ElementRef) => {
      const { page, scale, items, entries } = latest.current
      const key = refKey(ref)
      if (entries.some((e) => e.key === key)) return
      const doc = useEditor.getState().doc
      if (!doc || ref.kind === 'field') return
      const g = resolveElement(doc, ref, items)
      if (!g) return
      const quad = geomQuad(g)
      // Glyph antialiasing (and overshoot of round letters) reaches past a text item's box.
      const pad = g.kind === 'content' && g.item.kind === 'text' ? Math.max(1.5, (g.item.fontSize ?? 12) * 0.12) : 1
      const region = snapshotRegion(quad, pad)
      const entry: PreviewEntry = {
        key,
        ref,
        snapshot: captureRegion(rootRef.current, page, scale, region),
        base:
          g.kind === 'content'
            ? { transform: g.transform, text: g.edit?.text ?? g.item.text, fontSize: g.edit?.fontSize ?? g.item.fontSize, color: g.edit?.color ?? g.item.color }
            : { box: g.box },
        maskQuad: quad,
        maskPad: pad,
        maskColor: sampleAroundBox(rootRef.current, page, scale, region)
      }
      latest.current.entries = [...entries, entry]
      setEntries(latest.current.entries)
    },
    [rootRef]
  )

  useEffect(() => {
    hosts.set(page.id, ensure)
    return () => {
      if (hosts.get(page.id) === ensure) hosts.delete(page.id)
    }
  }, [page.id, ensure])

  useEffect(() => {
    const pageEl = rootRef.current?.closest('[data-testid="page"]') ?? rootRef.current?.parentElement
    if (!pageEl) return
    const onRendered = (e: Event) => {
      const detail = (e as CustomEvent<{ pageId?: string }>).detail
      if (detail?.pageId && detail.pageId !== page.id) return
      latest.current.entries = []
      setEntries([])
      setRenderedDoc(useEditor.getState().doc)
    }
    pageEl.addEventListener(PAGE_RENDERED_EVENT, onRendered)
    return () => pageEl.removeEventListener(PAGE_RENDERED_EVENT, onRendered)
  }, [rootRef, page.id])

  return { entries, ensure, renderedDoc }
}

function cssMatrix(m: Matrix, region: Box, scale: number): string {
  const [a, b, c, d, e, f] = m
  return `matrix(${a}, ${b}, ${c}, ${d}, ${scale * (a * region.x + c * region.y + e)}, ${scale * (b * region.x + d * region.y + f)})`
}

function polygon(points: Point[], pad: number): string {
  // Grow the quad slightly around its centroid so antialiased edges are covered too.
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length
  return points
    .map((p) => {
      const dx = p.x - cx
      const dy = p.y - cy
      const len = Math.hypot(dx, dy) || 1
      return `${p.x + (dx / len) * pad},${p.y + (dy / len) * pad}`
    })
    .join(' ')
}

export function PreviewsLayer({
  entries,
  doc,
  items,
  page,
  scale,
  live
}: {
  entries: PreviewEntry[]
  doc: EditorDocument
  items: ContentItem[]
  page: PageEntry
  scale: number
  /** Geometry change of the element being dragged right now. */
  live?: { ref: ElementRef; change: ElementChange } | null
}) {
  if (!entries.length) return null
  return (
    <div className="ed-previews" data-testid="element-previews">
      {entries.map((entry) => {
        const g = resolveElement(doc, entry.ref, items)
        const change = live && refKey(live.ref) === entry.key ? live.change : null
        let transform: Matrix | null = null
        let replacement: {
          text: string
          origin: Point
          angle: number
          fontSize: number
          color: string
          font: string
          weight: number
          italic: boolean
          vertical: boolean
        } | null = null
        if (g?.kind === 'content') {
          const t = change && 'transform' in change ? change.transform : g.transform
          const text = g.edit?.text ?? g.item.text
          const fontSize = g.edit?.fontSize ?? g.item.fontSize
          const color = g.edit?.color ?? g.item.color
          const changedText =
            g.item.kind === 'text' && (text !== entry.base.text || fontSize !== entry.base.fontSize || color !== entry.base.color)
          if (changedText && g.item.origin) {
            const shown = text ?? ''
            const font = contentTextFont(shown, g.item)
            replacement = {
              text: shown,
              origin: apply(t, g.item.origin),
              angle: (g.item.angle ?? 0) + matrixAngle(t),
              fontSize: (fontSize ?? 12) * verticalScale(t),
              color: color ?? '#000000',
              font: font.family,
              weight: font.weight,
              italic: font.italic,
              vertical: !!g.item.vertical
            }
          } else {
            transform = multiply(t, invert(entry.base.transform ?? [1, 0, 0, 1, 0, 0]))
          }
        } else if (g?.kind === 'annotation') {
          const box = change && 'box' in change ? change.box : g.box
          transform = boxToBox(entry.base.box ?? box, box)
        }
        const unchanged =
          g &&
          !replacement &&
          transform &&
          transform.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-6)
        if (unchanged) return null
        const snap = entry.snapshot
        return (
          <div key={entry.key} className="ed-preview" data-testid="element-preview" data-preview-key={entry.key}>
            <svg className="ed-fullpage" width={page.width * scale} height={page.height * scale} viewBox={`0 0 ${page.width} ${page.height}`} overflow="visible">
              <polygon points={polygon(entry.maskQuad, entry.maskPad)} fill={entry.maskColor} />
              {replacement && (
                <text
                  x={replacement.origin.x}
                  y={replacement.origin.y}
                  transform={replacement.angle ? `rotate(${replacement.angle} ${replacement.origin.x} ${replacement.origin.y})` : undefined}
                  fontFamily={replacement.font}
                  fontSize={replacement.fontSize}
                  fontWeight={replacement.weight}
                  fontStyle={replacement.italic ? 'italic' : 'normal'}
                  fill={replacement.color}
                  dominantBaseline={replacement.vertical ? 'central' : 'alphabetic'}
                  writingMode={replacement.vertical ? 'vertical-rl' : undefined}
                  style={{ whiteSpace: 'pre', fontKerning: 'none', ...(replacement.vertical ? { textOrientation: 'upright' } : {}) }}
                >
                  {replacement.text}
                </text>
              )}
            </svg>
            {snap && transform && (
              <img
                className="ed-preview-snapshot"
                alt=""
                draggable={false}
                src={snap.url}
                style={{
                  width: snap.region.width * scale,
                  height: snap.region.height * scale,
                  transform: cssMatrix(transform, snap.region, scale)
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

