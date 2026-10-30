/** Regression tests for review findings on existing-content editing. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getContentItems, type ContentItem, type Matrix } from '@core'
import { apply as applyM, boundsOfPoints, quadOfBox } from '@renderer/editing/elementGeometry'
import { PAGE_RENDERED_EVENT } from '@renderer/editing/previews'
import { click, doc, drag, loadDoc, makeDoc, makePage, makeSource, mockLayout, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
vi.mock('@core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core')>()), getContentItems: vi.fn() }))

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const ITEMS: ContentItem[] = [
  { id: 'i1', kind: 'image', bounds: box(100, 100, 100, 50) },
  { id: 'x1', kind: 'xobject', bounds: box(0, 0, 600, 800) },
  { id: 'x1/t3', kind: 'text', bounds: box(72, 400, 120, 20), text: 'Wrapped', fontSize: 20, origin: { x: 72, y: 416 }, angle: 0, editableInPlace: true },
  { id: 'x1/p7', kind: 'path', bounds: box(72, 500, 120, 40), color: '#009900' }
]

const item = (id: string) => screen.getAllByTestId('content-item').find((el) => el.dataset.contentId === id)
const edit = (id: string) => doc().contentEdits?.p1?.find((e) => e.itemId === id)
const t = (id: string): Matrix => edit(id)?.transform ?? [1, 0, 0, 1, 0, 0]
const placedBounds = (id: string) => {
  const it = ITEMS.find((i) => i.id === id)!
  return boundsOfPoints(quadOfBox(it.bounds).map((p) => applyM(t(id), p)))
}
const rendered = () =>
  act(() => {
    screen.getByTestId('page').dispatchEvent(new CustomEvent(PAGE_RENDERED_EVENT, { bubbles: true, detail: { pageId: 'p1' } }))
  })

beforeEach(async () => {
  mockLayout()
  vi.mocked(getContentItems).mockResolvedValue(ITEMS)
  loadDoc(makeDoc({ sources: [makeSource('s')], pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })] }))
  renderPage({ panel: true })
  setTool('edit-content')
  await screen.findAllByTestId('content-item')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('X/Y/W/H of rotated content (#2)', () => {
  async function rotateImage() {
    click(item('i1')!, { x: 150, y: 125 })
    // Rotate by 30° (Shift snaps to 15° steps) with the rotation handle.
    const c = { x: 150, y: 125 }
    const a = (30 * Math.PI) / 180
    drag(screen.getByTestId('handle-rotate'), { x: 150, y: 76 }, { x: c.x + Math.sin(a) * 60, y: c.y - Math.cos(a) * 60 }, { shiftKey: true })
    expect(Math.atan2(t('i1')[1], t('i1')[0]) * (180 / Math.PI)).toBeCloseTo(30)
  }

  it('X moves only horizontally and typing is applied once (no per-digit drift)', async () => {
    const user = userEvent.setup()
    await rotateImage()
    const before = placedBounds('i1')
    expect(Number((screen.getByTestId('prop-x') as HTMLInputElement).value)).toBeCloseTo(before.x, 1)
    const x = screen.getByTestId('prop-x')
    await user.clear(x)
    await user.type(x, '150{Enter}')
    const after = placedBounds('i1')
    expect(after.x).toBeCloseTo(150)
    expect(after.y).toBeCloseTo(before.y)
    expect(after.width).toBeCloseTo(before.width)
    expect(Number((screen.getByTestId('prop-y') as HTMLInputElement).value)).toBeCloseTo(before.y, 1)
    // Still rotated by 30°.
    expect(Math.atan2(t('i1')[1], t('i1')[0]) * (180 / Math.PI)).toBeCloseTo(30)
  })

  it('W scales a rotated item uniformly, keeping the top-left of its bounds', async () => {
    const user = userEvent.setup()
    await rotateImage()
    const before = placedBounds('i1')
    const w = screen.getByTestId('prop-width')
    await user.clear(w)
    await user.type(w, String(Math.round(before.width * 2)) + '{Enter}')
    const after = placedBounds('i1')
    const f = Math.round(before.width * 2) / before.width
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(after.width).toBeCloseTo(before.width * f)
    expect(after.height).toBeCloseTo(before.height * f)
  })
})

describe('children of a deleted container (#3)', () => {
  it('have no hit boxes and cannot be resolved or edited', () => {
    click(item('x1')!, { x: 400, y: 700 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(edit('x1')?.deleted).toBe(true)
    expect(item('x1')).toBeUndefined()
    expect(item('x1/t3')).toBeUndefined()
    expect(item('x1/p7')).toBeUndefined()
    // A stale selection of a child does nothing.
    act(() => store().selectElement({ kind: 'content', pageId: 'p1', itemId: 'x1/t3' }))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(edit('x1/t3')).toBeUndefined()
    expect(screen.queryByTestId('element-frame')).toBeNull()
    // Undo brings the container and its children back.
    act(() => store().undo())
    expect(item('x1/t3')).toBeDefined()
  })
})

describe('live preview during a drag (#9)', () => {
  it('survives a render that completes mid-drag and stays after the drop', () => {
    const el = item('i1')!
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 150, clientY: 125 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 160, clientY: 135 })
    expect(screen.getByTestId('element-preview')).toBeInTheDocument()
    // A render of an earlier edit finishes while dragging: previews are dropped…
    rendered()
    expect(screen.queryByTestId('element-preview')).toBeNull()
    // …and the next move brings the dragged item's preview back.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 170, clientY: 145 })
    expect(screen.getByTestId('element-preview')).toBeInTheDocument()
    rendered()
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 170, clientY: 145 })
    // Committed: the preview is kept until the page shows the edit.
    expect(t('i1')).toEqual([1, 0, 0, 1, 20, 20])
    expect(screen.getByTestId('element-preview')).toBeInTheDocument()
  })
})
