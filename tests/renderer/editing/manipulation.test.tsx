import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditObject, ImageObject, InkObject, LineObject, ShapeObject, TextObject } from '@core'
import {
  click,
  drag,
  loadDoc,
  makeDoc,
  makePage,
  mockLayout,
  objectEl,
  objects,
  pointerDown,
  pointerMove,
  pointerUp,
  renderPage,
  store
} from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const rect: ShapeObject = {
  id: 'r1', pageId: 'p1', type: 'rect', x: 100, y: 100, width: 100, height: 50,
  strokeColor: '#000000', fillColor: null, strokeWidth: 2, rotation: 0
}
const line: LineObject = { id: 'l1', pageId: 'p1', type: 'line', x1: 50, y1: 400, x2: 150, y2: 400, color: '#000000', strokeWidth: 2, arrowEnd: false }
const ink: InkObject = {
  id: 'i1', pageId: 'p1', type: 'ink', color: '#000000', strokeWidth: 0,
  paths: [[{ x: 300, y: 300 }, { x: 400, y: 350 }]]
}
const image: ImageObject = {
  id: 'img', pageId: 'p1', type: 'image', x: 300, y: 500, width: 100, height: 50,
  data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', rotation: 0
}

const overlay = () => screen.getByTestId('page-overlay')
const get = (id: string) => objects().find((o) => o.id === id) as EditObject

function setup(objs: EditObject[], page = makePage('p1'), scale = 1) {
  loadDoc(makeDoc({ pages: [page], objects: objs }))
  return renderPage({ scale })
}

beforeEach(() => mockLayout())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('selection', () => {
  it('click selects, click on empty space deselects', () => {
    const { container } = setup([rect])
    click(objectEl(container, 'r1'), { x: 150, y: 120 })
    expect(store().selectedObjectId).toBe('r1')
    expect(objectEl(container, 'r1')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('selection-frame')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^handle-/)).toHaveLength(9) // 8 resize + rotate
    click(overlay(), { x: 500, y: 700 })
    expect(store().selectedObjectId).toBeNull()
    expect(store().past).toHaveLength(0)
  })

  it('handles keep a constant screen size while the frame scales with zoom', () => {
    const { container } = setup([rect], makePage('p1'), 2)
    click(objectEl(container, 'r1'), { x: 300, y: 240 })
    const frame = screen.getByTestId('selection-frame')
    expect(frame.style.width).toBe('200px')
    expect(frame.style.left).toBe('200px')
    // Handle size comes from CSS (px), not from the scale.
    expect(screen.getByTestId('handle-se').style.width).toBe('')
  })
})

describe('moving', () => {
  it('drag moves the object as a single undo step', () => {
    const { container } = setup([rect])
    drag(objectEl(container, 'r1'), { x: 150, y: 120 }, { x: 180, y: 160 }, {}, 6)
    expect(get('r1')).toMatchObject({ x: 130, y: 140, width: 100, height: 50 })
    expect(store().past).toHaveLength(1)
    act(() => store().undo())
    expect(get('r1')).toMatchObject({ x: 100, y: 100 })
  })

  it('shows a live preview while dragging without committing', () => {
    const { container } = setup([rect])
    const el = objectEl(container, 'r1')
    pointerDown(el, { x: 150, y: 120 })
    pointerMove(el, { x: 170, y: 130 })
    expect(objectEl(container, 'r1').style.left).toBe('120px')
    expect(get('r1')).toMatchObject({ x: 100, y: 100 })
    expect(store().past).toHaveLength(0)
    pointerUp(el, { x: 170, y: 130 })
    expect(get('r1')).toMatchObject({ x: 120, y: 110 })
  })

  it('Escape cancels a drag in progress', () => {
    const { container } = setup([rect])
    const el = objectEl(container, 'r1')
    pointerDown(el, { x: 150, y: 120 })
    pointerMove(el, { x: 190, y: 160 })
    fireEvent.keyDown(window, { key: 'Escape' })
    pointerUp(el, { x: 190, y: 160 })
    expect(get('r1')).toMatchObject({ x: 100, y: 100 })
    expect(objectEl(container, 'r1').style.left).toBe('100px')
    expect(store().past).toHaveLength(0)
  })

  it('moves lines, ink and notes by all their points', () => {
    const note: EditObject = { id: 'n', pageId: 'p1', type: 'note', x: 500, y: 50, text: '', color: '#facc15' }
    const { container } = setup([line, ink, note])
    drag(objectEl(container, 'l1'), { x: 100, y: 400 }, { x: 110, y: 420 })
    expect(get('l1')).toMatchObject({ x1: 60, y1: 420, x2: 160, y2: 420 })
    drag(objectEl(container, 'i1'), { x: 350, y: 325 }, { x: 340, y: 335 })
    expect((get('i1') as InkObject).paths[0]).toEqual([{ x: 290, y: 310 }, { x: 390, y: 360 }])
    drag(objectEl(container, 'n'), { x: 510, y: 60 }, { x: 520, y: 80 })
    expect(get('n')).toMatchObject({ x: 510, y: 70 })
    expect(store().past).toHaveLength(3)
  })

  it('on a 90° page a screen drag to the right moves the object up in page space', () => {
    const { container } = setup([rect], makePage('p1', { rotation: 90 }))
    // rect center (150,125) is at view (800-125, 150) = (675, 150).
    drag(objectEl(container, 'r1'), { x: 675, y: 150 }, { x: 695, y: 150 })
    expect(get('r1')).toMatchObject({ x: 100, y: 80 })
  })
})

describe('resizing', () => {
  it('dragging the south-east handle resizes as one undo step', () => {
    const { container } = setup([rect])
    click(objectEl(container, 'r1'), { x: 150, y: 120 })
    drag(screen.getByTestId('handle-se'), { x: 200, y: 150 }, { x: 260, y: 190 })
    expect(get('r1')).toMatchObject({ x: 100, y: 100, width: 160, height: 90 })
    expect(store().past).toHaveLength(1)
  })

  it('north-west handle keeps the opposite corner fixed; Shift keeps the aspect ratio', () => {
    const { container } = setup([rect])
    click(objectEl(container, 'r1'), { x: 150, y: 120 })
    drag(screen.getByTestId('handle-nw'), { x: 100, y: 100 }, { x: 0, y: 90 }, { shiftKey: true })
    const r = get('r1') as ShapeObject
    expect(r.x + r.width).toBeCloseTo(200)
    expect(r.y + r.height).toBeCloseTo(150)
    expect(r.width / r.height).toBeCloseTo(2)
    expect(r.width).toBeCloseTo(200)
  })

  it('images keep their aspect ratio by default', () => {
    const { container } = setup([image])
    click(objectEl(container, 'img'), { x: 350, y: 525 })
    drag(screen.getByTestId('handle-e'), { x: 400, y: 525 }, { x: 500, y: 525 })
    expect(get('img')).toMatchObject({ x: 300, width: 200, height: 100 })
  })

  it('resizes rotated objects around the fixed opposite edge', () => {
    const rotated = { ...rect, rotation: 90 }
    const { container } = setup([rotated])
    click(objectEl(container, 'r1'), { x: 150, y: 125 })
    // Rotated 90° cw around (150,125): the local east edge midpoint is at (150, 175).
    drag(screen.getByTestId('handle-e'), { x: 150, y: 175 }, { x: 150, y: 225 })
    const r = get('r1') as ShapeObject
    expect(r.width).toBeCloseTo(150)
    expect(r.height).toBeCloseTo(50)
    // The west edge (at page y = 75) stays put: new center y = 75 + 150/2.
    expect(r.y + r.height / 2).toBeCloseTo(150)
    expect(r.x + r.width / 2).toBeCloseTo(150)
  })

  it('works on a 270° page through viewToPage', () => {
    const { container } = setup([rect], makePage('p1', { rotation: 270 }))
    // 270°: view = (p.y, W - p.x). Rect se corner (200,150) → view (150, 400).
    click(objectEl(container, 'r1'), { x: 125, y: 450 })
    drag(screen.getByTestId('handle-se'), { x: 150, y: 400 }, { x: 170, y: 380 })
    expect(get('r1')).toMatchObject({ x: 100, y: 100, width: 120, height: 70 })
  })

  it('scales ink drawings by transforming their points', () => {
    const { container } = setup([ink])
    click(objectEl(container, 'i1'), { x: 350, y: 325 })
    expect(screen.queryByTestId('handle-rotate')).toBeNull()
    drag(screen.getByTestId('handle-se'), { x: 400, y: 350 }, { x: 500, y: 400 })
    expect((get('i1') as InkObject).paths[0]).toEqual([{ x: 300, y: 300 }, { x: 500, y: 400 }])
    expect(store().past).toHaveLength(1)
  })

  it('text boxes never shrink below their text height', () => {
    const text: TextObject = {
      id: 't', pageId: 'p1', type: 'text', x: 100, y: 100, width: 200, height: 40, text: 'Some text that wraps',
      font: 'sans', bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0
    }
    const { container } = setup([text])
    click(objectEl(container, 't'), { x: 150, y: 110 })
    drag(screen.getByTestId('handle-s'), { x: 200, y: 140 }, { x: 200, y: 101 })
    expect((get('t') as TextObject).height).toBeCloseTo(14.4)
  })
})

describe('rotating', () => {
  it('rotation handle rotates clockwise around the center; Shift snaps to 15°', () => {
    const { container } = setup([rect])
    click(objectEl(container, 'r1'), { x: 150, y: 125 })
    drag(screen.getByTestId('handle-rotate'), { x: 150, y: 76 }, { x: 250, y: 125 })
    expect((get('r1') as ShapeObject).rotation).toBeCloseTo(90)
    expect(store().past).toHaveLength(1)
    drag(screen.getByTestId('handle-rotate'), { x: 250, y: 125 }, { x: 150 + 100, y: 125 + 20 }, { shiftKey: true })
    expect((get('r1') as ShapeObject).rotation).toBe(105)
    expect(store().past).toHaveLength(2)
  })
})

describe('line endpoints', () => {
  it('drags an endpoint; Shift snaps to 45°', () => {
    const { container } = setup([line])
    click(objectEl(container, 'l1'), { x: 100, y: 400 })
    expect(screen.getByTestId('handle-p2')).toBeInTheDocument()
    drag(screen.getByTestId('handle-p2'), { x: 150, y: 400 }, { x: 150, y: 300 })
    expect(get('l1')).toMatchObject({ x1: 50, y1: 400, x2: 150, y2: 300 })
    // p1 is dragged relative to p2 = (150, 300): direction ~123° snaps to 135°.
    drag(screen.getByTestId('handle-p1'), { x: 50, y: 400 }, { x: 52, y: 450 }, { shiftKey: true })
    const l = get('l1') as LineObject
    expect(l.x1 - 150).toBeCloseTo(-(l.y1 - 300), 1)
    expect(l.y1).toBeGreaterThan(400)
    expect(store().past).toHaveLength(2)
  })
})
