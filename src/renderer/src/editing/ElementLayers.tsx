/** Hit targets for existing page content and annotations, and the inline editor for existing text. */
import { useEffect, useRef, useState } from 'react'
import { StickyNote } from 'lucide-react'
import {
  NOTE_ICON_SIZE,
  rotatePoint,
  type AnnotationInfo,
  type ContentItem,
  type EditorDocument,
  type PageEntry,
  type Point
} from '@core'
import { isImeComposing } from '@renderer/actions/util'
import { useFallbackFonts } from '@renderer/fonts/systemFonts'
import { useEditor, type ElementRef } from '@renderer/state/store'
import { apply as applyMatrix, invert, matrixAngle, multiply, placedRect, verticalScale, type RotRect } from './elementGeometry'
import { CONTENT_KIND_LABELS, editContent, effectiveTransform, isContentDeleted, refKey, type ElementChange } from './elements'
import { ensureElementPreview } from './previews'
import { contentTextFont, measureContentText } from './textLayout'

/** Minimum on-screen size (px) of a hit target, so thin lines can be picked. */
const MIN_HIT_PX = 6

function rectStyle(r: RotRect, scale: number) {
  const w = Math.max(r.width * scale, MIN_HIT_PX)
  const h = Math.max(r.height * scale, MIN_HIT_PX)
  return {
    left: r.cx * scale - w / 2,
    top: r.cy * scale - h / 2,
    width: w,
    height: h,
    transform: r.angle ? `rotate(${r.angle}deg)` : undefined
  }
}

export function contentItemRect(
  doc: EditorDocument,
  pageId: string,
  item: ContentItem,
  live?: { ref: ElementRef; change: ElementChange } | null
): RotRect | null {
  if (isContentDeleted(doc, pageId, item.id)) return null
  const edit = doc.contentEdits?.[pageId]?.find((e) => e.itemId === item.id)
  let t = effectiveTransform(doc, pageId, item.id)
  if (live?.ref.kind === 'content' && 'transform' in live.change) {
    if (live.ref.itemId === item.id) t = live.change.transform
    else if (item.id.startsWith(live.ref.itemId + '/')) {
      // Items inside a container being dragged follow it.
      const m = multiply(live.change.transform, invert(effectiveTransform(doc, pageId, live.ref.itemId)))
      t = multiply(m, t)
    }
  }
  return placedRect(item, t, edit, measureContentText)
}

/** Topmost editable text item whose hit target contains a page-space point (when the layer is not shown). */
export function contentTextAt(
  doc: EditorDocument,
  pageId: string,
  items: ContentItem[],
  p: Point,
  scale: number
): ContentItem | undefined {
  const min = MIN_HIT_PX / scale
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'text' || item.readOnly) continue
    const r = contentItemRect(doc, pageId, item)
    if (!r) continue
    const q = rotatePoint(p, { x: r.cx, y: r.cy }, -r.angle)
    if (Math.abs(q.x - r.cx) <= Math.max(r.width, min) / 2 && Math.abs(q.y - r.cy) <= Math.max(r.height, min) / 2) return item
  }
  return undefined
}

export function ContentItemsLayer({
  doc,
  page,
  items,
  scale,
  selected,
  live
}: {
  doc: EditorDocument
  page: PageEntry
  items: ContentItem[]
  scale: number
  selected: ElementRef | null
  live?: { ref: ElementRef; change: ElementChange } | null
}) {
  return (
    <div className="ed-elements ed-content-items">
      {items.map((item) => {
        const r = contentItemRect(doc, page.id, item, live)
        if (!r) return null
        const isSel = selected?.kind === 'content' && selected.itemId === item.id && selected.pageId === page.id
        const label = CONTENT_KIND_LABELS[item.kind]
        return (
          <div
            key={item.id}
            className={`ed-element ed-content-item ed-kind-${item.kind}`}
            data-testid="content-item"
            data-content-id={item.id}
            data-kind={item.kind}
            data-selected={isSel ? 'true' : 'false'}
            title={item.kind === 'text' ? `${label}: “${item.text ?? ''}” — double-click to edit` : label}
            style={rectStyle(r, scale)}
          />
        )
      })}
    </div>
  )
}

/** Text (sticky note) annotations without an appearance stream are not painted by pdf.js. */
export function needsNoteIcon(a: AnnotationInfo): boolean {
  return a.subtype === 'Text' && a.hasAppearance === false
}

/**
 * Existing annotations: invisible hit boxes in the Select tool, plus the standard note icon for
 * sticky notes the canvas cannot show (drawn in every tool, upright like in PDF viewers).
 */
export function AnnotationsLayer({
  annotations,
  page,
  scale,
  selected,
  live,
  interactive,
  pageRotation
}: {
  annotations: AnnotationInfo[]
  page: PageEntry
  scale: number
  selected: ElementRef | null
  live?: { ref: ElementRef; change: ElementChange } | null
  interactive: boolean
  pageRotation: number
}) {
  return (
    <div className="ed-elements ed-annotations">
      {annotations.map((a) => {
        const ref: ElementRef = { kind: 'annotation', pageId: page.id, annotId: a.id }
        const change = live && refKey(live.ref) === refKey(ref) ? live.change : null
        const box = change && 'box' in change ? change.box : a.bounds
        const isSel = selected?.kind === 'annotation' && selected.annotId === a.id && selected.pageId === page.id
        const icon = needsNoteIcon(a)
        if (!interactive && !icon) return null
        const title = `${a.subtype} annotation${a.author ? ` by ${a.author}` : ''}${a.contents ? `: ${a.contents}` : ''}`
        const hit = interactive
          ? { 'data-testid': 'annotation', 'data-annot-id': a.id, 'data-subtype': a.subtype, 'data-selected': isSel ? 'true' : 'false' }
          : { 'data-testid': 'annotation-icon', 'aria-hidden': true }
        if (icon) {
          const size = NOTE_ICON_SIZE * scale
          return (
            <div
              key={a.id}
              className={`ed-element ed-annotation ed-annot-note${interactive ? '' : ' ed-inert'}`}
              {...hit}
              data-note-icon="true"
              title={title}
              style={{
                left: box.x * scale,
                top: box.y * scale,
                width: size,
                height: size,
                background: a.color ?? '#facc15',
                transform: pageRotation ? `rotate(${-pageRotation}deg)` : undefined
              }}
            >
              <StickyNote size={size * 0.7} strokeWidth={2} aria-hidden="true" />
            </div>
          )
        }
        return (
          <div
            key={a.id}
            className="ed-element ed-annotation"
            {...hit}
            title={title}
            style={rectStyle({ cx: box.x + box.width / 2, cy: box.y + box.height / 2, width: box.width, height: box.height, angle: 0 }, scale)}
          />
        )
      })}
    </div>
  )
}

/** Approximate distance from the top of a CSS line box (line-height 1.2) to the baseline, in em. */
const BASELINE_EM = 0.87

/** Inline editor for an existing text item, placed on its baseline. Enter/blur commits, Escape cancels. */
export function ContentTextEditor({
  doc,
  page,
  item,
  scale,
  background,
  onDone
}: {
  doc: EditorDocument
  page: PageEntry
  item: ContentItem
  scale: number
  background: string
  onDone(): void
}) {
  const edit = doc.contentEdits?.[page.id]?.find((e) => e.itemId === item.id)
  const initial = edit?.text ?? item.text ?? ''
  const [value, setValue] = useState(initial)
  // Re-render with the fallback font once it is loaded for the typed text.
  useFallbackFonts((s) => s.version)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
    if (item.editableInPlace === false) {
      useEditor.getState().showNotice('info', 'The original font cannot be reused for new text: a similar font will be used.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const t = effectiveTransform(doc, page.id, item.id)
  const rect = placedRect(item, t)
  const origin = item.origin ? applyMatrix(t, item.origin) : { x: rect.cx - rect.width / 2, y: rect.cy + rect.height * 0.3 }
  const angle = (item.angle ?? 0) + matrixAngle(t)
  const fs = (edit?.fontSize ?? item.fontSize ?? 12) * verticalScale(t)
  const color = edit?.color ?? item.color ?? '#000000'
  const top = origin.y - fs * BASELINE_EM
  const font = contentTextFont(value, item)

  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit && value !== initial) {
      const ref: ElementRef = { kind: 'content', pageId: page.id, itemId: item.id }
      ensureElementPreview(ref)
      useEditor.getState().apply((d) => editContent(d, page.id, item.id, { text: value }))
    }
    onDone()
  }

  return (
    <textarea
      ref={ref}
      className="ed-content-editor"
      data-testid="content-text-editor"
      data-overlay-control=""
      aria-label="Edit text"
      rows={1}
      wrap="off"
      spellCheck
      value={value}
      style={{
        ...(item.vertical
          ? {
              // A column centered on the text, from the top of its first character.
              left: (origin.x - fs * 0.6) * scale,
              top: origin.y * scale,
              minHeight: Math.max(rect.height * scale, 24),
              width: fs * 1.2 * scale,
              writingMode: 'vertical-rl',
              textOrientation: 'upright',
              transformOrigin: `${fs * 0.6 * scale}px 0px`
            }
          : {
              left: origin.x * scale,
              top: top * scale,
              minWidth: Math.max(rect.width * scale, 24),
              height: fs * 1.2 * scale,
              transformOrigin: `0px ${fs * BASELINE_EM * scale}px`
            }),
        fontSize: fs * scale,
        lineHeight: `${fs * 1.2 * scale}px`,
        fontFamily: font.family,
        fontWeight: font.weight,
        fontStyle: font.italic ? 'italic' : 'normal',
        color,
        background,
        transform: angle ? `rotate(${angle}deg)` : undefined
      }}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ' '))}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
