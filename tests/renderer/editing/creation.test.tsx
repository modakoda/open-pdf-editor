import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_ICON_SIZE, type ImageObject, type InkObject, type LineObject, type NoteObject, type ShapeObject, type TextObject } from '@core'
import { useEditing } from '@renderer/editing/editingState'
import { INK_MERGE_MS } from '@renderer/editing/PageOverlay'
import {
  click,
  doc,
  drag,
  loadDoc,
  makeDoc,
  makePage,
  mockLayout,
  objects,
  pngBytes,
  pointerDown,
  pointerMove,
  pointerUp,
  renderPage,
  setTool,
  store
} from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const overlay = () => screen.getByTestId('page-overlay')

beforeEach(() => {
  mockLayout()
  loadDoc(makeDoc())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('creating objects with pointer gestures', () => {
  it('draws a rectangle by dragging, selects it and returns to the select tool', () => {
    renderPage()
    setTool('rect')
    drag(overlay(), { x: 100, y: 100 }, { x: 250, y: 200 })
    expect(objects()).toHaveLength(1)
    const r = objects()[0] as ShapeObject
    expect(r).toMatchObject({ type: 'rect', pageId: 'p1', x: 100, y: 100, width: 150, height: 100, rotation: 0 })
    expect(r.strokeColor).toBe(store().toolOptions.color)
    expect(r.strokeWidth).toBe(store().toolOptions.strokeWidth)
    expect(store().tool).toBe('select')
    expect(store().selectedObjectId).toBe(r.id)
    expect(store().past).toHaveLength(1)
    const el = screen.getByTestId('object')
    expect(el).toHaveAttribute('data-object-type', 'rect')
    expect(el).toHaveAttribute('data-selected', 'true')
  })

  it('Shift constrains rectangles to squares; drag direction does not matter', () => {
    renderPage()
    setTool('ellipse')
    drag(overlay(), { x: 300, y: 300 }, { x: 200, y: 250 }, { shiftKey: true })
    expect(objects()[0]).toMatchObject({ type: 'ellipse', x: 200, y: 200, width: 100, height: 100 })
  })

  it('previews the shape while dragging without touching the document', () => {
    renderPage()
    setTool('rect')
    pointerDown(overlay(), { x: 10, y: 10 })
    pointerMove(overlay(), { x: 60, y: 60 })
    expect(objects()).toHaveLength(0)
    expect(document.querySelector('[data-ghost]')).not.toBeNull()
    pointerUp(overlay(), { x: 60, y: 60 })
    expect(objects()).toHaveLength(1)
    expect(document.querySelector('[data-ghost]')).toBeNull()
  })

  it('creates highlights and keeps the highlight tool active', () => {
    renderPage()
    setTool('highlight')
    drag(overlay(), { x: 50, y: 50 }, { x: 150, y: 70 })
    drag(overlay(), { x: 50, y: 90 }, { x: 150, y: 110 })
    expect(objects().map((o) => o.type)).toEqual(['highlight', 'highlight'])
    expect(objects()[0]).toMatchObject({ x: 50, y: 50, width: 100, height: 20, color: store().toolOptions.highlightColor, opacity: 0.4 })
    expect(store().tool).toBe('highlight')
    // Highlights are rendered in a multiply-blended layer.
    expect(screen.getAllByTestId('object')[0].parentElement).toHaveClass('ed-layer-multiply')
  })

  it('creates a white whiteout box', () => {
    renderPage()
    setTool('whiteout')
    drag(overlay(), { x: 20, y: 20 }, { x: 80, y: 40 })
    expect(objects()[0]).toMatchObject({ type: 'whiteout', color: '#ffffff', width: 60, height: 20 })
    expect(store().tool).toBe('select')
  })

  it('ignores a tiny highlight drag but a rect click creates a default-size rect', () => {
    renderPage()
    setTool('highlight')
    click(overlay(), { x: 50, y: 50 })
    expect(objects()).toHaveLength(0)
    setTool('rect')
    click(overlay(), { x: 300, y: 300 })
    expect(objects()[0]).toMatchObject({ type: 'rect', x: 250, y: 270, width: 100, height: 60 })
  })

  it('draws lines and arrows; Shift snaps to 45°', () => {
    renderPage()
    setTool('line')
    drag(overlay(), { x: 100, y: 100 }, { x: 200, y: 110 }, { shiftKey: true })
    const l = objects()[0] as LineObject
    expect(l).toMatchObject({ type: 'line', x1: 100, y1: 100, arrowEnd: false })
    expect(l.y2).toBeCloseTo(100, 1)
    expect(l.x2).toBeCloseTo(Math.hypot(100, 10) + 100, 1)

    setTool('arrow')
    drag(overlay(), { x: 100, y: 300 }, { x: 200, y: 390 }, { shiftKey: true })
    const a = objects()[1] as LineObject
    expect(a.arrowEnd).toBe(true)
    expect(a.x2 - a.x1).toBeCloseTo(a.y2 - a.y1, 1)
    expect(store().tool).toBe('select')
    // Arrow head polygon is drawn.
    expect(screen.getAllByTestId('object')[1].querySelector('polygon')).not.toBeNull()
  })

  it('draws freehand ink, keeps the pen active and merges quick consecutive strokes', () => {
    renderPage()
    setTool('ink')
    drag(overlay(), { x: 10, y: 10 }, { x: 110, y: 60 }, {}, 10)
    expect(objects()).toHaveLength(1)
    const ink = objects()[0] as InkObject
    expect(ink.type).toBe('ink')
    expect(ink.paths).toHaveLength(1)
    // Straight drag is simplified to its end points.
    expect(ink.paths[0]).toEqual([
      { x: 10, y: 10 },
      { x: 110, y: 60 }
    ])
    expect(store().tool).toBe('ink')

    drag(overlay(), { x: 200, y: 200 }, { x: 250, y: 260 })
    expect(objects()).toHaveLength(1)
    expect((objects()[0] as InkObject).paths).toHaveLength(2)
    expect(store().past).toHaveLength(2) // one undo step per stroke

    // A stroke after the merge window starts a new drawing.
    const last = useEditing.getState().lastInk!
    act(() => useEditing.setState({ lastInk: { ...last, at: last.at - INK_MERGE_MS - 10 } }))
    drag(overlay(), { x: 300, y: 300 }, { x: 350, y: 300 })
    expect(objects()).toHaveLength(2)
  })

  it('adds a sticky note on click and opens its popover', async () => {
    const user = userEvent.setup()
    renderPage()
    setTool('note')
    click(overlay(), { x: 210, y: 110 })
    const note = objects()[0] as NoteObject
    // The icon (NOTE_ICON_SIZE pt, same as the exported annotation) is centered on the click.
    expect(note).toMatchObject({ type: 'note', x: 210 - NOTE_ICON_SIZE / 2, y: 110 - NOTE_ICON_SIZE / 2, text: '' })
    expect(screen.getByTestId('object').style.width).toBe(`${NOTE_ICON_SIZE}px`)
    expect(store().tool).toBe('select')
    const text = screen.getByTestId('note-text')
    await user.type(text, 'Check this')
    await user.type(screen.getByTestId('note-author'), 'Ann')
    expect(objects()[0]).toMatchObject({ text: 'Check this', author: 'Ann' })
    fireEvent.keyDown(text, { key: 'Escape' })
    expect(screen.queryByTestId('note-popover')).toBeNull()
    // Clicking the note again opens the popover.
    click(screen.getByTestId('object'), { x: 210, y: 110 })
    expect(screen.getByTestId('note-popover')).toBeInTheDocument()
  })

  it('places a pending image on click (≤ 40% of the page width, keeps aspect)', () => {
    renderPage()
    act(() => {
      store().setPendingImage({ data: pngBytes(1200, 600), mimeType: 'image/png', width: 1200, height: 600 })
      store().setTool('image')
    })
    pointerMove(overlay(), { x: 300, y: 400 }, { buttons: 0 })
    expect(document.querySelector('[data-ghost]')).not.toBeNull()
    click(overlay(), { x: 300, y: 400 })
    const img = objects()[0] as ImageObject
    expect(img.type).toBe('image')
    expect(img.width).toBeCloseTo(240) // 40% of 600
    expect(img.height).toBeCloseTo(120)
    expect(img.x + img.width / 2).toBeCloseTo(300)
    expect(img.y + img.height / 2).toBeCloseTo(400)
    expect(store().pendingImage).toBeNull()
    expect(store().tool).toBe('select')
    expect(store().selectedObjectId).toBe(img.id)
  })

  it('maps gestures on a 90° rotated page to page space', () => {
    loadDoc(makeDoc({ pages: [makePage('p1', { rotation: 90 })] }))
    renderPage({ scale: 2 })
    // The page-space layer is rotated to match the viewer.
    const layer = overlay().querySelector<HTMLElement>('.ed-layer')!
    expect(layer.style.transform).toBe('translate(1600px, 0px) rotate(90deg)')
    setTool('rect')
    // View (px at scale 2) → page: x = v.y / 2, y = H - v.x / 2.
    drag(overlay(), { x: 200, y: 100 }, { x: 600, y: 300 })
    expect(objects()[0]).toMatchObject({ x: 50, y: 500, width: 100, height: 200 })
  })

  it('maps gestures on 180° and 270° pages', () => {
    loadDoc(makeDoc({ pages: [makePage('a', { rotation: 180 }), makePage('b', { baseRotation: 90, rotation: 180 })] }))
    const { unmount } = renderPage({ pageIndex: 0 })
    setTool('line')
    drag(overlay(), { x: 100, y: 100 }, { x: 200, y: 150 })
    expect(objects()[0]).toMatchObject({ x1: 500, y1: 700, x2: 400, y2: 650 })
    unmount()
    renderPage({ pageIndex: 1 })
    setTool('line')
    drag(overlay(), { x: 100, y: 100 }, { x: 200, y: 150 })
    expect(objects()[1]).toMatchObject({ pageId: 'b', x1: 500, y1: 100, x2: 450, y2: 200 })
  })
})

describe('text objects', () => {
  it('click creates a text box and opens the inline editor; typing is one undo step', async () => {
    const user = userEvent.setup()
    renderPage()
    setTool('text')
    click(overlay(), { x: 100, y: 100 })
    const editor = screen.getByTestId('text-object-editor') as HTMLTextAreaElement
    expect(editor).toHaveFocus()
    const t = objects()[0] as TextObject
    expect(t).toMatchObject({ type: 'text', x: 100, text: '', fontSize: 14, font: 'sans', align: 'left' })
    expect(store().tool).toBe('select')
    await user.type(editor, 'Hello world')
    expect((objects()[0] as TextObject).text).toBe('Hello world')
    expect(store().past).toHaveLength(1)
    act(() => editor.blur())
    expect(screen.queryByTestId('text-object-editor')).toBeNull()
    // Rendered with the engine layout.
    expect(screen.getByTestId('object').querySelector('tspan')?.textContent).toBe('Hello world')
    act(() => store().undo())
    expect(objects()).toHaveLength(0)
  })

  it('removes a text object that is left empty', () => {
    renderPage()
    setTool('text')
    click(overlay(), { x: 100, y: 100 })
    expect(objects()).toHaveLength(1)
    act(() => (screen.getByTestId('text-object-editor') as HTMLTextAreaElement).blur())
    expect(objects()).toHaveLength(0)
    expect(store().selectedObjectId).toBeNull()
  })

  it('drag creates a text box of that width; the height grows with the text', async () => {
    const user = userEvent.setup()
    renderPage()
    setTool('text')
    drag(overlay(), { x: 50, y: 50 }, { x: 150, y: 60 })
    const t = objects()[0] as TextObject
    expect(t.width).toBe(100)
    expect(t.height).toBeCloseTo(14 * 1.2)
    await user.type(screen.getByTestId('text-object-editor'), 'one two three four five six seven')
    const after = objects()[0] as TextObject
    expect(after.height).toBeGreaterThan(14 * 1.2 * 2)
  })

  it('double-click edits an existing text object; clearing it deletes the object', async () => {
    const user = userEvent.setup()
    loadDoc(
      makeDoc({
        objects: [
          {
            id: 't1', pageId: 'p1', type: 'text', x: 100, y: 100, width: 200, height: 20, text: 'Hi', font: 'sans',
            bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0
          }
        ]
      })
    )
    renderPage()
    fireEvent.doubleClick(screen.getByTestId('object'))
    const editor = screen.getByTestId('text-object-editor')
    expect(editor).toHaveValue('Hi')
    await user.clear(editor)
    act(() => (editor as HTMLTextAreaElement).blur())
    expect(objects()).toHaveLength(0)
  })

  it('clicking elsewhere on the page ends editing (blur) and deselects', async () => {
    const user = userEvent.setup()
    renderPage()
    setTool('text')
    click(overlay(), { x: 100, y: 100 })
    await user.type(screen.getByTestId('text-object-editor'), 'Keep')
    click(overlay(), { x: 400, y: 600 })
    expect(screen.queryByTestId('text-object-editor')).toBeNull()
    expect(objects()).toHaveLength(1)
    expect(store().selectedObjectId).toBeNull()
  })
})

describe('hand tool', () => {
  it('does not handle pointer events', () => {
    loadDoc(makeDoc({ objects: [{ id: 'r', pageId: 'p1', type: 'rect', x: 0, y: 0, width: 50, height: 50, strokeColor: '#000000', fillColor: null, strokeWidth: 1, rotation: 0 }] }))
    renderPage()
    setTool('hand')
    expect(overlay()).toHaveAttribute('data-tool', 'hand')
    pointerDown(screen.getByTestId('object'), { x: 10, y: 10 })
    pointerUp(screen.getByTestId('object'), { x: 10, y: 10 })
    expect(store().selectedObjectId).toBeNull()
    expect(doc().objects).toHaveLength(1)
  })
})
