/** Stacking order of existing content: properties panel Arrange buttons, Ctrl/Cmd+] / [ shortcuts. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getContentItems, type ContentItem, type EditorDocument } from '@core'
import { canReorderContent, contentContainer, reorderContent } from '@renderer/editing/elements'
import { click, doc, loadDoc, makeDoc, makePage, makeSource, mockLayout, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
vi.mock('@core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core')>()), getContentItems: vi.fn() }))

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

// p1 and p2 overlap, p3 is apart, p4 overlaps both p1 and p2.
const ITEMS: ContentItem[] = [
  { id: 'p1', kind: 'path', bounds: box(100, 100, 100, 100), color: '#ff0000' },
  { id: 'p2', kind: 'path', bounds: box(150, 150, 100, 100), color: '#00ff00' },
  { id: 'p3', kind: 'path', bounds: box(400, 400, 50, 50), color: '#0000ff' },
  { id: 'p4', kind: 'path', bounds: box(120, 120, 50, 50), color: '#000000' }
]

const item = (id: string) => screen.getAllByTestId('content-item').find((el) => el.dataset.contentId === id)!
const z = (id: string) => doc().contentEdits?.p1?.find((e) => e.itemId === id)?.z
const key = (k: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key: k, ...init })

async function setup() {
  loadDoc(
    makeDoc({
      sources: [makeSource('s')],
      pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })]
    })
  )
  renderPage({ panel: true })
  setTool('edit-content')
  await screen.findAllByTestId('content-item')
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

describe('re-ordering existing content', () => {
  it('Arrange buttons bring an item forward / to the front and send it backward / to the back, one undo step each', async () => {
    const user = userEvent.setup()
    await setup()
    click(item('p1'), { x: 105, y: 105 })
    expect(screen.getByTestId('prop-back')).toBeDisabled()
    expect(screen.getByTestId('prop-backward')).toBeDisabled()
    expect(screen.getByTestId('prop-forward')).toHaveAttribute('title', 'Bring forward (Ctrl/Cmd+])')
    // Forward: above the next item it overlaps (p2), below the following one.
    await user.click(screen.getByTestId('prop-forward'))
    expect(z('p1')).toBe(1.5)
    // Again: p3 does not overlap, so above p4 (the last one).
    await user.click(screen.getByTestId('prop-forward'))
    expect(z('p1')).toBe(4)
    expect(screen.getByTestId('prop-front')).toBeDisabled()
    expect(screen.getByTestId('prop-forward')).toBeDisabled()
    await user.click(screen.getByTestId('prop-back'))
    expect(z('p1')).toBe(0)
    expect(store().past).toHaveLength(3)
    act(() => store().undo())
    expect(z('p1')).toBe(4)
    // Backward: below the next item down it overlaps (p4), above p3.
    await user.click(screen.getByTestId('prop-backward'))
    expect(z('p1')).toBe(2.5)
    // Reset removes the re-ordering too.
    await user.click(screen.getByTestId('prop-reset'))
    expect(z('p1')).toBeUndefined()
  })

  it('Ctrl/Cmd+] and [ re-order the selected item; with Shift to the front / back', async () => {
    await setup()
    click(item('p2'), { x: 240, y: 240 })
    expect(key(']', { ctrlKey: true })).toBe(false) // handled
    expect(z('p2')).toBe(4) // above p4, the last item
    key('[', { metaKey: true })
    expect(z('p2')).toBe(2.5) // below p4 again, above p3
    key('{', { metaKey: true, shiftKey: true })
    expect(z('p2')).toBe(-1)
    key('}', { ctrlKey: true, shiftKey: true })
    expect(z('p2')).toBe(4)
    expect(store().past).toHaveLength(4)
    // Nothing to do: no undo step, still handled.
    expect(key('}', { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(store().past).toHaveLength(4)
    // Without Ctrl/Cmd, or with focus in a text field, brackets are left alone.
    expect(key('[')).toBe(true)
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(fireEvent.keyDown(input, { key: '[', ctrlKey: true })).toBe(true)
    input.remove()
    expect(z('p2')).toBe(4)
  })

  it('shortcuts do nothing without a selected content item', async () => {
    await setup()
    expect(key(']', { ctrlKey: true })).toBe(true)
    expect(store().past).toHaveLength(0)
  })
})

describe('reorderContent', () => {
  const base = (): EditorDocument =>
    makeDoc({ sources: [makeSource('s')], pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })] })

  it('finds the container of an item', () => {
    expect(contentContainer('t3')).toBe('')
    expect(contentContainer('x1/t3')).toBe('x1')
    expect(contentContainer('x1/x5/p2')).toBe('x1/x5')
    expect(contentContainer('@obj_a/t7')).toBe('')
    expect(contentContainer('x2/@obj/t3')).toBe('x2')
  })

  it('re-orders only among the items of the same form XObject', () => {
    const items: ContentItem[] = [
      { id: 'p0', kind: 'path', bounds: box(0, 0, 500, 500) },
      { id: 'x1', kind: 'xobject', bounds: box(0, 0, 500, 500) },
      { id: 'x1/p2', kind: 'path', bounds: box(10, 10, 50, 50) },
      { id: 'x1/p6', kind: 'path', bounds: box(20, 20, 50, 50) },
      { id: 'p9', kind: 'path', bounds: box(0, 0, 500, 500) }
    ]
    let d = base()
    expect(canReorderContent(d, 'p1', items, 'x1/p6', 'front')).toBe(false)
    d = reorderContent(d, 'p1', items, 'x1/p2', 'front')
    expect(d.contentEdits?.p1).toEqual([{ itemId: 'x1/p2', z: 4 }])
    expect(canReorderContent(d, 'p1', items, 'x1/p6', 'front')).toBe(true)
    expect(canReorderContent(d, 'p1', items, 'x1/p6', 'back')).toBe(false)
    // Page-level items skip the form's inner items.
    expect(reorderContent(base(), 'p1', items, 'p9', 'backward').contentEdits?.p1).toEqual([{ itemId: 'p9', z: 0.5 }])
    // Moved container: the edit records the placement like other edits of inner items.
    const moved = { ...base(), contentEdits: { p1: [{ itemId: 'x1', transform: [1, 0, 0, 1, 5, 0] as [number, number, number, number, number, number] }] } }
    expect(reorderContent(moved, 'p1', items, 'x1/p6', 'back').contentEdits?.p1?.[1]).toEqual({ itemId: 'x1/p6', z: 1, transform: [1, 0, 0, 1, 5, 0] })
  })

  it('ignores deleted and read-only items and uses placed bounds', () => {
    const items: ContentItem[] = [
      { id: 'a', kind: 'path', bounds: box(0, 0, 10, 10) },
      { id: 'b', kind: 'path', bounds: box(100, 0, 10, 10) },
      { id: 'c', kind: 'path', bounds: box(0, 0, 10, 10), readOnly: true }
    ]
    let d = base()
    // a and b do not overlap: forward passes b only once b is moved onto a.
    expect(canReorderContent(d, 'p1', items, 'a', 'forward')).toBe(true) // c overlaps
    d = { ...d, contentEdits: { p1: [{ itemId: 'c', deleted: true }] } }
    expect(canReorderContent(d, 'p1', items, 'a', 'forward')).toBe(false)
    d = { ...d, contentEdits: { p1: [...d.contentEdits!.p1, { itemId: 'b', transform: [1, 0, 0, 1, -95, 0] }] } }
    expect(reorderContent(d, 'p1', items, 'a', 'forward').contentEdits?.p1?.find((e) => e.itemId === 'a')).toEqual({ itemId: 'a', z: 2 })
    expect(canReorderContent(base(), 'p1', items, 'c', 'back')).toBe(false)
  })
})
