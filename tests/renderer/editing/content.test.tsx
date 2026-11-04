import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addObject, getContentItems, type ContentItem, type Matrix, type Point } from '@core'
import { apply as applyM } from '@renderer/editing/elementGeometry'
import { makeShape } from '@renderer/editing/objects'
import { PAGE_RENDERED_EVENT } from '@renderer/editing/previews'
import { click, doc, drag, loadDoc, makeDoc, makePage, makeSource, mockLayout, objectEl, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
vi.mock('@core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core')>()), getContentItems: vi.fn() }))

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const quadOf = (b: ReturnType<typeof box>): [Point, Point, Point, Point] => [
  { x: b.x, y: b.y },
  { x: b.x + b.width, y: b.y },
  { x: b.x + b.width, y: b.y + b.height },
  { x: b.x, y: b.y + b.height }
]

const ITEMS: ContentItem[] = [
  {
    id: 't1', kind: 'text', bounds: box(100, 100, 80, 14), quad: quadOf(box(100, 100, 80, 14)), text: 'Hello world',
    fontSize: 12, fontName: 'Helvetica', fontFamily: 'sans', color: '#000000', origin: { x: 100, y: 111 }, angle: 0, editableInPlace: true
  },
  { id: 'img', kind: 'image', bounds: box(300, 300, 100, 50) },
  { id: 'p1', kind: 'path', bounds: box(50, 500, 200, 10), color: '#ff0000' },
  {
    id: 't2', kind: 'text', bounds: box(100, 200, 60, 14), text: 'Ūnicode', fontSize: 12, fontFamily: 'serif',
    origin: { x: 100, y: 211 }, angle: 0, editableInPlace: false
  }
]

const overlay = () => screen.getByTestId('page-overlay')
const item = (id: string) => screen.getAllByTestId('content-item').find((el) => el.dataset.contentId === id)!
const edit = (id: string) => doc().contentEdits?.p1?.find((e) => e.itemId === id)
const t = (id: string): Matrix => edit(id)?.transform ?? [1, 0, 0, 1, 0, 0]

function setup(rotation: 0 | 90 = 0) {
  loadDoc(
    makeDoc({
      sources: [makeSource('s')],
      pages: [makePage('p1', { rotation, source: { kind: 'source', sourceId: 's', pageIndex: 0 } })]
    })
  )
  const r = renderPage({ panel: true })
  setTool('edit-content')
  return r
}

beforeEach(() => {
  mockLayout()
  vi.mocked(getContentItems).mockReset()
  vi.mocked(getContentItems).mockResolvedValue(ITEMS)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('content inside a form XObject', () => {
  const NESTED: ContentItem[] = [
    { id: 'x1', kind: 'xobject', bounds: box(0, 0, 600, 800) },
    { id: 'x1/t3', kind: 'text', bounds: box(72, 60, 120, 20), text: 'Wrapped title', fontSize: 20, fontFamily: 'serif', origin: { x: 72, y: 76 }, angle: 0, editableInPlace: true },
    { id: 'x1/p7', kind: 'path', bounds: box(72, 160, 120, 40), color: '#009900' }
  ]

  it('moving the container moves its edited items too; unedited ones follow on screen; Reset brings both back', async () => {
    vi.mocked(getContentItems).mockResolvedValue(NESTED)
    setup()
    await screen.findAllByTestId('content-item')
    // Retype the nested title first (it is then redrawn on its own by the engine).
    fireEvent.doubleClick(item('x1/t3'))
    const editor = screen.getByTestId('content-text-editor')
    fireEvent.change(editor, { target: { value: 'New title' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(edit('x1/t3')).toMatchObject({ text: 'New title' })
    // Drag the container by an empty spot.
    drag(item('x1'), { x: 400, y: 600 }, { x: 430, y: 620 })
    expect(t('x1')).toEqual([1, 0, 0, 1, 30, 20])
    expect(t('x1/t3')).toEqual([1, 0, 0, 1, 30, 20])
    expect(edit('x1/p7')).toBeUndefined()
    expect(item('x1/p7').style.left).toBe('102px')
    // Editing an unedited item inside the moved container records its placement.
    click(item('x1/p7'), { x: 150, y: 200 })
    fireEvent.input(screen.getByTestId('prop-content-color'), { target: { value: '#123456' } })
    expect(edit('x1/p7')).toMatchObject({ color: '#123456', transform: [1, 0, 0, 1, 30, 20] })
    // Reset the container: the items it carried move back.
    click(item('x1'), { x: 500, y: 700 })
    await userEvent.setup().click(screen.getByTestId('prop-reset'))
    expect(edit('x1')).toBeUndefined()
    expect(t('x1/t3')).toEqual([1, 0, 0, 1, 0, 0])
    expect(edit('x1/t3')?.transform).toBeUndefined()
    expect(edit('x1/p7')).toEqual({ itemId: 'x1/p7', color: '#123456' })
  })
})

describe('Edit content', () => {
  it('loads the page content once and shows a hit target per item', async () => {
    setup()
    const els = await screen.findAllByTestId('content-item')
    expect(els.map((e) => e.dataset.kind)).toEqual(['text', 'image', 'path', 'text'])
    expect(getContentItems).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getContentItems).mock.calls[0][1]).toBe('p1')
    expect(parseFloat(item('t1').style.left)).toBeCloseTo(100)
    expect(item('t1').title).toMatch(/double-click/i)
    setTool('select')
    expect(screen.queryAllByTestId('content-item')).toHaveLength(0)
    setTool('edit-content')
    await screen.findAllByTestId('content-item')
    expect(getContentItems).toHaveBeenCalledTimes(1) // cached
  })

  it('click selects an item, empty space deselects', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    click(item('t1'), { x: 120, y: 105 })
    expect(store().selectedElement).toEqual({ kind: 'content', pageId: 'p1', itemId: 't1' })
    expect(screen.getByTestId('element-frame')).toBeInTheDocument()
    expect(screen.getByTestId('handle-rotate')).toBeInTheDocument()
    expect(screen.getByTestId('properties-panel')).toHaveAttribute('data-element-kind', 'content')
    click(overlay(), { x: 500, y: 700 })
    expect(store().selectedElement).toBeNull()
    expect(store().past).toHaveLength(0)
  })

  it('drag moves an item as one undo step (total transform from the original)', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    drag(item('t1'), { x: 120, y: 105 }, { x: 150, y: 125 }, {}, 6)
    expect(t('t1')).toEqual([1, 0, 0, 1, 30, 20])
    expect(store().past).toHaveLength(1)
    expect(item('t1').style.left).toBe('130px')
    // A second move is relative to the current placement but stored as the total.
    drag(item('t1'), { x: 150, y: 125 }, { x: 160, y: 125 })
    expect(t('t1')).toEqual([1, 0, 0, 1, 40, 20])
    act(() => store().undo())
    expect(t('t1')).toEqual([1, 0, 0, 1, 30, 20])
  })

  it('resizes images around the opposite corner, keeping the aspect ratio', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    click(item('img'), { x: 350, y: 325 })
    drag(screen.getByTestId('handle-se'), { x: 400, y: 350 }, { x: 500, y: 360 })
    const m = t('img')
    expect(applyM(m, { x: 300, y: 300 })).toEqual({ x: 300, y: 300 })
    const se = applyM(m, { x: 400, y: 350 })
    expect(se.x).toBeCloseTo(500)
    expect(se.y).toBeCloseTo(400)
    expect(store().past).toHaveLength(1)
  })

  it('rotates around the center with the rotation handle (Shift snaps)', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    click(item('t1'), { x: 120, y: 105 })
    drag(screen.getByTestId('handle-rotate'), { x: 140, y: 83 }, { x: 240, y: 110 }, { shiftKey: true })
    const m = t('t1')
    // 90° clockwise around (140, 107).
    expect(m[0]).toBeCloseTo(0)
    expect(m[1]).toBeCloseTo(1)
    const c = applyM(m, { x: 140, y: 107 })
    expect(c.x).toBeCloseTo(140)
    expect(c.y).toBeCloseTo(107)
    expect(store().past).toHaveLength(1)
  })

  it('Delete removes the item; a live preview masks it until the page re-renders', async () => {
    const { container } = setup()
    await screen.findAllByTestId('content-item')
    click(item('t1'), { x: 120, y: 105 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(edit('t1')).toEqual({ itemId: 't1', deleted: true })
    expect(store().selectedElement).toBeNull()
    expect(screen.getAllByTestId('content-item').map((e) => e.dataset.contentId)).not.toContain('t1')
    const preview = screen.getByTestId('element-preview')
    expect(preview.querySelector('polygon')).not.toBeNull()
    const pageEl = container.querySelector('[data-testid="page"]')!
    act(() => {
      pageEl.dispatchEvent(new CustomEvent(PAGE_RENDERED_EVENT, { bubbles: true, detail: { pageId: 'p1' } }))
    })
    expect(screen.queryByTestId('element-preview')).toBeNull()
  })

  it('shows a preview of a moved item while dragging and after the commit', async () => {
    const { container } = setup()
    await screen.findAllByTestId('content-item')
    const el = item('t1')
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 120, clientY: 105 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 140, clientY: 105 })
    expect(screen.getByTestId('element-preview')).toBeInTheDocument()
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 140, clientY: 105 })
    expect(screen.getByTestId('element-preview')).toBeInTheDocument()
    act(() => {
      container.querySelector('[data-testid="page"]')!.dispatchEvent(new CustomEvent(PAGE_RENDERED_EVENT, { bubbles: true, detail: { pageId: 'p1' } }))
    })
    expect(screen.queryByTestId('element-preview')).toBeNull()
  })

  it('arrow keys nudge the selected item as one coalesced step', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    click(item('img'), { x: 350, y: 325 })
    for (let i = 0; i < 3; i++) fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true })
    expect(t('img')).toEqual([1, 0, 0, 1, 3, -10])
    expect(store().past).toHaveLength(1)
  })

  it('double-click retypes a text item inline (one undo step)', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findAllByTestId('content-item')
    fireEvent.doubleClick(item('t1'))
    const editor = screen.getByTestId('content-text-editor') as HTMLTextAreaElement
    expect(editor).toHaveValue('Hello world')
    expect(editor).toHaveFocus()
    expect(editor.style.fontSize).toBe('12px')
    await user.clear(editor)
    await user.type(editor, 'Goodbye{Enter}')
    expect(edit('t1')).toMatchObject({ text: 'Goodbye' })
    expect(screen.queryByTestId('content-text-editor')).toBeNull()
    // The hit target follows the shorter replacement text (anchored at the baseline start).
    expect(parseFloat(item('t1').style.width)).toBeLessThan(80)
    expect(parseFloat(item('t1').style.left)).toBeCloseTo(100)
    expect(store().past).toHaveLength(1)
    // Escape cancels without changes.
    fireEvent.doubleClick(item('t1'))
    await user.type(screen.getByTestId('content-text-editor'), 'xyz{Escape}')
    expect(edit('t1')?.text).toBe('Goodbye')
    expect(store().past).toHaveLength(1)
  })

  it('double-click works when the overlay holds pointer capture (event retargeted to the overlay)', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    const target = item('t1')
    const spy = vi.fn(() => [target, overlay()])
    Object.defineProperty(document, 'elementsFromPoint', { value: spy, configurable: true })
    try {
      fireEvent.doubleClick(overlay(), { clientX: 120, clientY: 105 })
      expect(spy).toHaveBeenCalledWith(120, 105)
      expect(screen.getByTestId('content-text-editor')).toBeInTheDocument()
    } finally {
      delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
    }
  })

  it('warns that a similar font is used when the original font cannot be reused', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    fireEvent.doubleClick(item('t2'))
    expect(store().notice?.text).toMatch(/similar font/i)
  })

  it('Enter on a selected text item opens the inline editor', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    click(item('t1'), { x: 120, y: 105 })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByTestId('content-text-editor')).toBeInTheDocument()
  })

  it('maps drags on a 90° page to page space', async () => {
    setup(90)
    await screen.findAllByTestId('content-item')
    // Image center (350, 325) → view (800 − 325, 350) = (475, 350). Screen right = page up.
    drag(item('img'), { x: 475, y: 350 }, { x: 495, y: 360 })
    expect(t('img')).toEqual([1, 0, 0, 1, 10, -20])
  })

  it('properties panel edits text, size and colour; Reset removes the edit', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findAllByTestId('content-item')
    click(item('t1'), { x: 120, y: 105 })
    const panel = screen.getByTestId('properties-panel')
    const text = within(panel).getByTestId('prop-content-text')
    await user.clear(text)
    await user.type(text, 'New text{Enter}')
    expect(edit('t1')?.text).toBe('New text')
    const size = within(panel).getByTestId('prop-content-fontSize')
    await user.clear(size)
    await user.type(size, '18')
    expect(edit('t1')?.fontSize).toBe(18)
    fireEvent.input(within(panel).getByTestId('prop-content-color'), { target: { value: '#00ff00' } })
    expect(edit('t1')?.color).toBe('#00ff00')
    // Replacement text is previewed in SVG until the page re-renders.
    expect(screen.getByTestId('element-preview').querySelector('text')?.textContent).toBe('New text')
    await user.click(within(panel).getByTestId('prop-reset'))
    expect(edit('t1')).toBeUndefined()
  })

  it('properties panel: path fill colour, image position/size, delete', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findAllByTestId('content-item')
    click(item('p1'), { x: 150, y: 505 })
    fireEvent.input(screen.getByTestId('prop-content-color'), { target: { value: '#0000ff' } })
    expect(edit('p1')?.color).toBe('#0000ff')
    click(item('img'), { x: 350, y: 325 })
    expect(screen.queryByTestId('prop-content-color')).toBeNull()
    const x = screen.getByTestId('prop-x')
    await user.clear(x)
    await user.type(x, '320')
    // Geometry is applied on Enter / blur, not per digit.
    expect(t('img')[4]).toBeCloseTo(0)
    await user.keyboard('{Enter}')
    expect(t('img')[4]).toBeCloseTo(20)
    expect(t('img')[5]).toBeCloseTo(0)
    await user.click(screen.getByTestId('prop-delete'))
    expect(edit('img')?.deleted).toBe(true)
  })
})

describe('double-click on existing text in Select', () => {
  /** Text running down the page (90° clockwise), center (407, 140). */
  const ROTATED: ContentItem = {
    id: 'r1', kind: 'text', bounds: box(400, 100, 14, 80),
    quad: [{ x: 414, y: 100 }, { x: 414, y: 180 }, { x: 400, y: 180 }, { x: 400, y: 100 }], text: 'Sideways',
    fontSize: 12, fontFamily: 'sans', origin: { x: 403, y: 100 }, angle: 90, editableInPlace: true
  }
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

  function setupSelect() {
    loadDoc(makeDoc({ sources: [makeSource('s')], pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })] }))
    return renderPage({ panel: true })
  }

  it('switches to Edit content and retypes the text under the pointer', async () => {
    const user = userEvent.setup()
    setupSelect()
    expect(getContentItems).not.toHaveBeenCalled()
    fireEvent.doubleClick(overlay(), { clientX: 120, clientY: 105 })
    const editor = await screen.findByTestId('content-text-editor')
    expect(store().tool).toBe('edit-content')
    expect(store().selectedElement).toEqual({ kind: 'content', pageId: 'p1', itemId: 't1' })
    expect(editor).toHaveValue('Hello world')
    expect(editor).toHaveFocus()
    await user.clear(editor)
    await user.type(editor, 'Goodbye{Enter}')
    expect(edit('t1')).toMatchObject({ text: 'Goodbye' })
    expect(store().past).toHaveLength(1)
    expect(getContentItems).toHaveBeenCalledTimes(1)
  })

  it('ignores images, graphics, empty space, deleted and read-only text', async () => {
    vi.mocked(getContentItems).mockResolvedValue([...ITEMS, { ...ITEMS[3], id: 't3', bounds: box(300, 600, 60, 14), origin: { x: 300, y: 611 }, readOnly: true }])
    setupSelect()
    act(() => store().apply((d) => ({ ...d, contentEdits: { p1: [{ itemId: 't1', deleted: true }] } })))
    for (const p of [{ x: 350, y: 325 }, { x: 100, y: 505 }, { x: 500, y: 700 }, { x: 120, y: 105 }, { x: 320, y: 606 }]) {
      fireEvent.doubleClick(overlay(), { clientX: p.x, clientY: p.y })
    }
    await settle()
    expect(store().tool).toBe('select')
    expect(screen.queryByTestId('content-text-editor')).toBeNull()
  })

  it('hit-tests rotated text by its own box, not its bounds', async () => {
    vi.mocked(getContentItems).mockResolvedValue([...ITEMS, ROTATED])
    setupSelect()
    fireEvent.doubleClick(overlay(), { clientX: 440, clientY: 140 })
    await settle()
    expect(store().tool).toBe('select')
    fireEvent.doubleClick(overlay(), { clientX: 407, clientY: 170 })
    expect(await screen.findByTestId('content-text-editor')).toHaveValue('Sideways')
  })

  it('an object added on top keeps the double-click', async () => {
    const { container } = setupSelect()
    const rect = makeShape('rect', 'p1', box(90, 90, 120, 40), store().toolOptions)
    act(() => store().apply((d) => addObject(d, rect)))
    fireEvent.doubleClick(objectEl(container, rect.id), { clientX: 120, clientY: 105 })
    await settle()
    expect(getContentItems).not.toHaveBeenCalled()
    expect(store().tool).toBe('select')
  })
})
