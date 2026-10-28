import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  addObject,
  boxCenter,
  clamp,
  displayRotation,
  getObjectsForPage,
  isBoxObject,
  overlayTransform,
  updateObject,
  viewToPage,
  type Box,
  type BoxObject,
  type EditObject,
  type ImageObject,
  type InkObject,
  type LineObject,
  type PageEntry,
  type Point,
  type ShapeObject,
  type TextObject
} from '@core'
import { useEditor } from '@renderer/state/store'
import { useEditing } from './editingState'
import { EditTextLayer, coveringTextObject, sampleBackground, useTextRuns } from './EditTextLayer'
import { FormFieldsLayer } from './FormFieldsLayer'
import {
  diffPatch,
  dragBox,
  inkFrame,
  mapPaths,
  RESIZE_HANDLES,
  resizeBox,
  rotationFromPointer,
  round2,
  roundPoint,
  simplifyPath,
  snapLine,
  translateObject,
  translatePatch,
  type ResizeHandle
} from './manip'
import { NotePopover } from './NotePopover'
import { ObjectView, inkPathD } from './ObjectView'
import {
  DEFAULT_TEXT_WIDTH,
  findObject,
  fitText,
  hasRotation,
  makeImage,
  makeLine,
  makeNote,
  makeShape,
  makeText,
  newObjectId,
  NOTE_SIZE,
  placedImageBox
} from './objects'
import { SelectionFrame } from './SelectionFrame'
import { TextEditor, textCoalesceKey } from './TextEditor'
import { ONE_SHOT_TOOLS } from './tools'
import './PageOverlay.css'

export interface PageOverlayProps {
  page: PageEntry
  /** 0-based index of the page in the document. */
  pageIndex: number
  /** CSS px per PDF point (zoom * CSS_PX_PER_PT). */
  scale: number
}

/** Pointer travel (CSS px) before a press becomes a drag. */
const DRAG_THRESHOLD = 3
/** A new ink stroke started within this time after the previous one joins the same object. */
export const INK_MERGE_MS = 1200

type BoxTool = 'rect' | 'ellipse' | 'highlight' | 'whiteout' | 'text'

interface GestureBase {
  pointerId: number
  startClient: Point
  start: Point
  moved: boolean
  startedAt: number
}

type Gesture =
  | (GestureBase & { kind: 'create-box'; tool: BoxTool; previewId: string })
  | (GestureBase & { kind: 'create-line'; arrow: boolean; previewId: string })
  | (GestureBase & { kind: 'ink'; points: Point[] })
  | (GestureBase & { kind: 'move'; obj: EditObject; wasSelected: boolean })
  | (GestureBase & { kind: 'resize'; obj: EditObject; handle: ResizeHandle })
  | (GestureBase & { kind: 'rotate'; obj: TextObject | ImageObject | ShapeObject })
  | (GestureBase & { kind: 'endpoint'; obj: LineObject; which: 1 | 2 })

type Preview =
  | { kind: 'object'; obj: EditObject; isNew: boolean }
  | { kind: 'ink'; points: Point[] }
  | { kind: 'draft-box'; box: Box }

function blurEditable(): void {
  const el = document.activeElement as HTMLElement | null
  if (el && el !== document.body && el.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
    el.blur()
  }
}

/**
 * Interactive layer drawn over one rendered page: existing EditObjects, form fields, and
 * pointer handling for the active tool. Absolutely positioned to cover the displayed page.
 */
export function PageOverlay({ page, pageIndex, scale }: PageOverlayProps) {
  const doc = useEditor((s) => s.doc)
  const tool = useEditor((s) => s.tool)
  const selectedId = useEditor((s) => s.selectedObjectId)
  const pendingImage = useEditor((s) => s.pendingImage)
  const editingTextId = useEditing((s) => s.editingTextId)
  const openNoteId = useEditing((s) => s.openNoteId)
  const cancelToken = useEditing((s) => s.cancelToken)

  const rootRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [ghostAt, setGhostAt] = useState<Point | null>(null)

  const objects = useMemo(() => (doc ? getObjectsForPage(doc, page.id) : []), [doc, page.id])
  const source = doc && page.source.kind === 'source' ? doc.sources[page.source.sourceId] : undefined
  const runs = useTextRuns(page, source, tool === 'edit-text')

  // ---- coordinate helpers -------------------------------------------------------------
  const toPage = (clientX: number, clientY: number): Point => {
    const r = rootRef.current!.getBoundingClientRect()
    return viewToPage({ x: clientX - r.left, y: clientY - r.top }, page, scale)
  }
  const clampToPage = (p: Point): Point => ({ x: clamp(p.x, 0, page.width), y: clamp(p.y, 0, page.height) })

  // ---- gesture plumbing ---------------------------------------------------------------
  const handlers = useRef({
    move: (_e: PointerEvent) => {},
    up: (_e: PointerEvent) => {},
    cancel: (_e: PointerEvent) => {}
  })
  const onWinMove = useCallback((e: PointerEvent) => handlers.current.move(e), [])
  const onWinUp = useCallback((e: PointerEvent) => handlers.current.up(e), [])
  const onWinCancel = useCallback((e: PointerEvent) => handlers.current.cancel(e), [])

  const stopListening = useCallback(() => {
    window.removeEventListener('pointermove', onWinMove)
    window.removeEventListener('pointerup', onWinUp)
    window.removeEventListener('pointercancel', onWinCancel)
  }, [onWinMove, onWinUp, onWinCancel])

  const endGesture = useCallback(() => {
    const g = gestureRef.current
    gestureRef.current = null
    stopListening()
    if (g) {
      try {
        rootRef.current?.releasePointerCapture?.(g.pointerId)
      } catch {
        /* not captured */
      }
    }
  }, [stopListening])

  useEffect(() => () => stopListening(), [stopListening])

  // Escape (or a tool change) cancels the gesture in progress.
  useEffect(() => {
    endGesture()
    setPreview(null)
  }, [cancelToken, tool, endGesture])

  const startGesture = (g: Gesture) => {
    endGesture()
    gestureRef.current = g
    try {
      rootRef.current?.setPointerCapture?.(g.pointerId)
    } catch {
      /* e.g. synthetic events */
    }
    window.addEventListener('pointermove', onWinMove)
    window.addEventListener('pointerup', onWinUp)
    window.addEventListener('pointercancel', onWinCancel)
  }

  const computePreview = (g: Gesture, p: Point, shift: boolean): Preview | null => {
    const options = useEditor.getState().toolOptions
    switch (g.kind) {
      case 'create-box': {
        const box = dragBox(g.start, clampToPage(p), shift)
        if (g.tool === 'text') return { kind: 'draft-box', box }
        return { kind: 'object', obj: { ...makeShape(g.tool, page.id, box, options), id: g.previewId }, isNew: true }
      }
      case 'create-line': {
        const q = clampToPage(p)
        const end = shift ? snapLine(g.start, q) : q
        return { kind: 'object', obj: { ...makeLine(page.id, g.start, end, g.arrow, options), id: g.previewId }, isNew: true }
      }
      case 'ink':
        return { kind: 'ink', points: g.points.slice() }
      case 'move':
        return { kind: 'object', obj: translateObject(g.obj, p.x - g.start.x, p.y - g.start.y), isNew: false }
      case 'resize': {
        const obj = g.obj
        const minSize = 4 / scale
        if (isBoxObject(obj)) {
          const keepAspect = obj.type === 'image' ? !shift : shift
          const nb = resizeBox(obj, hasRotation(obj) ? obj.rotation ?? 0 : 0, g.handle, p, keepAspect, minSize)
          let next = { ...obj, ...nb } as BoxObject
          if (next.type === 'text') next = fitText(next)
          return { kind: 'object', obj: next, isNew: false }
        }
        if (obj.type === 'ink') {
          const from = inkFrame(obj)
          const to = resizeBox(from, 0, g.handle, p, shift, minSize)
          return { kind: 'object', obj: { ...obj, paths: mapPaths(obj.paths, from, to) }, isNew: false }
        }
        return null
      }
      case 'rotate':
        return { kind: 'object', obj: { ...g.obj, rotation: rotationFromPointer(boxCenter(g.obj), p, shift) }, isNew: false }
      case 'endpoint': {
        const o = g.obj
        const other = g.which === 1 ? { x: o.x2, y: o.y2 } : { x: o.x1, y: o.y1 }
        const q = shift ? snapLine(other, p) : p
        const patch = g.which === 1 ? { x1: q.x, y1: q.y } : { x2: q.x, y2: q.y }
        return { kind: 'object', obj: { ...o, ...patch }, isNew: false }
      }
    }
  }

  const afterCreate = (obj: EditObject) => {
    const s = useEditor.getState()
    if (ONE_SHOT_TOOLS.has(s.tool)) {
      s.setTool('select')
      useEditor.getState().selectObject(obj.id)
    }
  }

  const createText = (drag: Box | null, at: Point) => {
    const s = useEditor.getState()
    const o = s.toolOptions
    const lh = o.fontSize * 1.2
    const box: Box = drag
      ? { x: drag.x, y: drag.y, width: Math.max(drag.width, 20), height: Math.max(drag.height, lh) }
      : {
          x: at.x,
          y: Math.max(0, at.y - lh / 2),
          width: Math.max(40, Math.min(DEFAULT_TEXT_WIDTH, page.width - at.x - 4)),
          height: lh
        }
    const obj = fitText(makeText(page.id, roundBox(box), o))
    s.apply((d) => addObject(d, obj), { coalesceKey: textCoalesceKey(obj.id) })
    s.setTool('select')
    useEditor.getState().selectObject(obj.id)
    useEditing.getState().startTextEdit(obj.id)
  }

  const commitInk = (g: Gesture & { kind: 'ink' }) => {
    const s = useEditor.getState()
    const editing = useEditing.getState()
    const o = s.toolOptions
    const pts = simplifyPath(g.points, 0.5 / scale).map(roundPoint)
    if (!pts.length) return
    const path = pts.length === 1 ? [pts[0], { ...pts[0] }] : pts
    const last = editing.lastInk
    const prev =
      last && last.pageId === page.id && g.startedAt - last.at < INK_MERGE_MS ? findObject(s.doc, last.id) : undefined
    const now = Date.now()
    if (
      prev?.type === 'ink' &&
      prev.color === o.color &&
      prev.strokeWidth === o.strokeWidth &&
      (prev.opacity ?? 1) === o.opacity
    ) {
      s.apply((d) => updateObject(d, prev.id, { paths: [...prev.paths, path] }))
      editing.setLastInk({ id: prev.id, pageId: page.id, at: now })
      return
    }
    const obj: InkObject = {
      id: newObjectId(),
      pageId: page.id,
      type: 'ink',
      paths: [path],
      color: o.color,
      strokeWidth: o.strokeWidth,
      ...(o.opacity < 1 ? { opacity: o.opacity } : {})
    }
    s.apply((d) => addObject(d, obj))
    editing.setLastInk({ id: obj.id, pageId: page.id, at: now })
  }

  const commit = (g: Gesture, p: Point, shift: boolean) => {
    const s = useEditor.getState()
    if (g.kind === 'ink') {
      commitInk(g)
      return
    }
    const pv = g.moved ? computePreview(g, p, shift) : null
    switch (g.kind) {
      case 'create-box': {
        if (g.tool === 'text') {
          const box = pv?.kind === 'draft-box' && pv.box.width * scale >= 12 ? pv.box : null
          createText(box, g.start)
          return
        }
        let obj: EditObject | null = pv?.kind === 'object' ? pv.obj : null
        if (!obj || (isBoxObject(obj) && obj.width * scale < 2 && obj.height * scale < 2)) {
          if (g.tool !== 'rect' && g.tool !== 'ellipse') return
          const w = 100
          const h = 60
          const box = {
            x: clamp(g.start.x - w / 2, 0, Math.max(0, page.width - w)),
            y: clamp(g.start.y - h / 2, 0, Math.max(0, page.height - h)),
            width: w,
            height: h
          }
          obj = { ...makeShape(g.tool, page.id, box, s.toolOptions), id: g.previewId }
        }
        const final = isBoxObject(obj) ? ({ ...obj, ...roundBox(obj) } as EditObject) : obj
        s.apply((d) => addObject(d, final))
        afterCreate(final)
        return
      }
      case 'create-line': {
        if (!pv || pv.kind !== 'object' || pv.obj.type !== 'line') return
        const l = pv.obj
        if (Math.hypot(l.x2 - l.x1, l.y2 - l.y1) * scale < 4) return
        const final: LineObject = { ...l, x1: round2(l.x1), y1: round2(l.y1), x2: round2(l.x2), y2: round2(l.y2) }
        s.apply((d) => addObject(d, final))
        afterCreate(final)
        return
      }
      case 'move': {
        if (!g.moved) {
          // Plain click on an object.
          if (g.obj.type === 'note') {
            const editing = useEditing.getState()
            editing.openNote(editing.openNoteId === g.obj.id ? null : g.obj.id)
          } else if (g.obj.type === 'text' && g.wasSelected) {
            useEditing.getState().startTextEdit(g.obj.id)
          }
          return
        }
        const dx = round2(p.x - g.start.x)
        const dy = round2(p.y - g.start.y)
        if (!dx && !dy) return
        s.apply((d) => updateObject(d, g.obj.id, translatePatch(g.obj, dx, dy)))
        return
      }
      case 'resize':
      case 'rotate':
      case 'endpoint': {
        if (!pv || pv.kind !== 'object') return
        const patch = diffPatch(g.obj, pv.obj)
        if (!Object.keys(patch).length) return
        s.apply((d) => updateObject(d, g.obj.id, patch))
        return
      }
    }
  }

  handlers.current.move = (e: PointerEvent) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    if (!g.moved && Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < DRAG_THRESHOLD) {
      if (g.kind !== 'ink') return
    }
    g.moved = true
    const p = toPage(e.clientX, e.clientY)
    if (g.kind === 'ink') {
      const q = clampToPage(p)
      const last = g.points[g.points.length - 1]
      if (Math.hypot(q.x - last.x, q.y - last.y) * scale < 1) return
      g.points.push(q)
    }
    setPreview(computePreview(g, p, e.shiftKey))
  }
  handlers.current.up = (e: PointerEvent) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    endGesture()
    setPreview(null)
    commit(g, toPage(e.clientX, e.clientY), e.shiftKey)
  }
  handlers.current.cancel = (e: PointerEvent) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    endGesture()
    setPreview(null)
  }

  // ---- pointer down: dispatch on the active tool -------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || tool === 'hand') return
    const target = e.target as Element
    if (target.closest('[data-overlay-control]')) return
    blurEditable()
    e.preventDefault()
    const p = toPage(e.clientX, e.clientY)
    const base: GestureBase = {
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      start: p,
      moved: false,
      startedAt: Date.now()
    }
    // Read state after blur(): finishing a text edit may have changed the document.
    const s = useEditor.getState()
    const editing = useEditing.getState()
    const objEl = target.closest('[data-object-id]') as HTMLElement | null
    const hit = objEl ? findObject(s.doc, objEl.dataset.objectId ?? null) : undefined

    switch (tool) {
      case 'select': {
        const handle = (target.closest('[data-handle]') as HTMLElement | null)?.dataset.handle
        const sel = findObject(s.doc, s.selectedObjectId)
        if (handle && sel && sel.pageId === page.id) {
          if (handle === 'rotate' && hasRotation(sel)) startGesture({ ...base, kind: 'rotate', obj: sel })
          else if ((handle === 'p1' || handle === 'p2') && sel.type === 'line')
            startGesture({ ...base, kind: 'endpoint', obj: sel, which: handle === 'p1' ? 1 : 2 })
          else if ((RESIZE_HANDLES as string[]).includes(handle))
            startGesture({ ...base, kind: 'resize', obj: sel, handle: handle as ResizeHandle })
          return
        }
        if (hit) {
          const wasSelected = s.selectedObjectId === hit.id
          if (!wasSelected) s.selectObject(hit.id)
          if (editing.openNoteId && editing.openNoteId !== hit.id) editing.openNote(null)
          startGesture({ ...base, kind: 'move', obj: hit, wasSelected })
          return
        }
        s.selectObject(null)
        editing.openNote(null)
        return
      }
      case 'edit-text': {
        if (hit?.type === 'text') {
          s.selectObject(hit.id)
          editing.startTextEdit(hit.id)
          return
        }
        const runEl = target.closest('[data-run-key]') as HTMLElement | null
        const run = runEl ? runs.find((r) => r.key === runEl.dataset.runKey) : undefined
        if (run) {
          const bg = sampleBackground(rootRef.current, page, scale, run) ?? '#ffffff'
          const obj = coveringTextObject(page.id, run, s.toolOptions, bg)
          s.apply((d) => addObject(d, obj), { coalesceKey: textCoalesceKey(obj.id) })
          useEditor.getState().selectObject(obj.id)
          editing.startTextEdit(obj.id)
          return
        }
        s.selectObject(null)
        return
      }
      case 'text':
      case 'rect':
      case 'ellipse':
      case 'highlight':
      case 'whiteout':
        startGesture({ ...base, start: clampToPage(p), kind: 'create-box', tool, previewId: newObjectId() })
        return
      case 'line':
      case 'arrow':
        startGesture({ ...base, start: clampToPage(p), kind: 'create-line', arrow: tool === 'arrow', previewId: newObjectId() })
        return
      case 'ink': {
        const q = clampToPage(p)
        startGesture({ ...base, start: q, kind: 'ink', points: [q] })
        setPreview({ kind: 'ink', points: [q] })
        return
      }
      case 'note': {
        const at = {
          x: round2(clamp(p.x - NOTE_SIZE / 2, 0, page.width - NOTE_SIZE)),
          y: round2(clamp(p.y - NOTE_SIZE / 2, 0, page.height - NOTE_SIZE))
        }
        const obj = makeNote(page.id, at)
        s.apply((d) => addObject(d, obj))
        s.setTool('select')
        useEditor.getState().selectObject(obj.id)
        editing.openNote(obj.id)
        return
      }
      case 'image':
      case 'signature': {
        const img = s.pendingImage
        if (!img) return
        const obj = makeImage(page.id, roundBox(placedImageBox(page, img, clampToPage(p))), img)
        s.apply((d) => addObject(d, obj))
        s.setPendingImage(null)
        s.clearNotice()
        s.setTool('select')
        useEditor.getState().selectObject(obj.id)
        setGhostAt(null)
        return
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current) return
    if (pendingImage && (tool === 'image' || tool === 'signature')) setGhostAt(toPage(e.clientX, e.clientY))
    else if (ghostAt) setGhostAt(null)
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== 'select') return
    const target = e.target as Element
    if (target.closest('[data-overlay-control]')) return
    const objEl = target.closest('[data-object-id]') as HTMLElement | null
    const obj = objEl ? findObject(useEditor.getState().doc, objEl.dataset.objectId ?? null) : undefined
    if (obj?.type === 'text') {
      useEditor.getState().selectObject(obj.id)
      useEditing.getState().startTextEdit(obj.id)
    } else if (obj?.type === 'note') {
      useEditing.getState().openNote(obj.id)
    }
  }

  // ---- render ---------------------------------------------------------------------------
  const layerStyle: CSSProperties = {
    width: page.width * scale,
    height: page.height * scale,
    transform: overlayTransform(page, scale)
  }
  const shown = objects.map((o) =>
    preview?.kind === 'object' && !preview.isNew && preview.obj.id === o.id ? preview.obj : o
  )
  const selected = selectedId ? shown.find((o) => o.id === selectedId) : undefined
  const editingObj = editingTextId
    ? (shown.find((o) => o.id === editingTextId && o.type === 'text') as TextObject | undefined)
    : undefined
  const openNote = openNoteId ? shown.find((o) => o.id === openNoteId && o.type === 'note') : undefined
  const ghost =
    ghostAt && pendingImage && (tool === 'image' || tool === 'signature')
      ? makeImage(page.id, placedImageBox(page, pendingImage, clampToPage(ghostAt)), pendingImage)
      : null
  const pageRotation = displayRotation(page)

  return (
    <div
      ref={rootRef}
      className={`ed-overlay ed-tool-${tool}`}
      data-testid="page-overlay"
      data-page-id={page.id}
      data-page-index={pageIndex}
      data-tool={tool}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => ghostAt && setGhostAt(null)}
      onDoubleClick={onDoubleClick}
      onMouseDown={(e) => {
        if (!(e.target as Element).closest('[data-overlay-control]') && tool !== 'hand') e.preventDefault()
      }}
    >
      {shown.map((o) => (
        <div key={o.id} className={`ed-layer${o.type === 'highlight' ? ' ed-layer-multiply' : ''}`} style={layerStyle}>
          <ObjectView
            obj={o}
            page={page}
            scale={scale}
            selected={o.id === selectedId}
            editing={o.id === editingObj?.id}
            pageRotation={pageRotation}
          />
        </div>
      ))}
      {preview && (
        <div
          className={`ed-layer ed-layer-preview${preview.kind === 'object' && preview.obj.type === 'highlight' ? ' ed-layer-multiply' : ''}`}
          style={layerStyle}
        >
          {preview.kind === 'object' && preview.isNew && (
            <ObjectView obj={preview.obj} page={page} scale={scale} selected={false} ghost />
          )}
          {preview.kind === 'draft-box' && (
            <div
              className="ed-draft-box"
              style={{
                left: preview.box.x * scale,
                top: preview.box.y * scale,
                width: preview.box.width * scale,
                height: preview.box.height * scale
              }}
            />
          )}
          {preview.kind === 'ink' && (
            <InkPreview points={preview.points} page={page} scale={scale} />
          )}
        </div>
      )}
      {tool === 'edit-text' && runs.length > 0 && (
        <div className="ed-layer" style={layerStyle}>
          <EditTextLayer runs={runs} objects={shown} scale={scale} />
        </div>
      )}
      <div className="ed-layer" style={layerStyle}>
        <FormFieldsLayer page={page} scale={scale} interactive={tool === 'select'} />
      </div>
      {selected && (tool === 'select' || selected.id === editingObj?.id) && (
        <div className="ed-layer ed-layer-ui" style={layerStyle}>
          <SelectionFrame obj={selected} scale={scale} pageRotation={pageRotation} outlineOnly={selected.id === editingObj?.id} />
        </div>
      )}
      {editingObj && (
        <div className="ed-layer ed-layer-ui" style={layerStyle}>
          <TextEditor obj={editingObj} scale={scale} maxWidth={page.width - editingObj.x} />
        </div>
      )}
      {ghost && (
        <div className="ed-layer ed-layer-preview" style={layerStyle}>
          <ObjectView obj={ghost} page={page} scale={scale} selected={false} ghost />
        </div>
      )}
      {openNote?.type === 'note' && !preview && <NotePopover note={openNote} page={page} scale={scale} />}
    </div>
  )
}

function InkPreview({ points, page, scale }: { points: Point[]; page: PageEntry; scale: number }) {
  const o = useEditor((s) => s.toolOptions)
  return (
    <svg
      className="ed-fullpage"
      width={page.width * scale}
      height={page.height * scale}
      viewBox={`0 0 ${page.width} ${page.height}`}
      overflow="visible"
      style={{ opacity: o.opacity }}
    >
      <path d={inkPathD(points)} fill="none" stroke={o.color} strokeWidth={o.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function roundBox<T extends Box>(b: T): T {
  return { ...b, x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) }
}
