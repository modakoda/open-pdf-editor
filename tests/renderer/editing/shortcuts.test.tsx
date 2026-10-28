import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShapeObject } from '@core'
import { useEditing } from '@renderer/editing/editingState'
import { useEditingShortcuts } from '@renderer/editing/useEditingShortcuts'
import { loadDoc, makeDoc, makePage, mockLayout, objects, pngBytes, renderPage, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
const openImageDialog = vi.fn()
vi.mock('@renderer/platform', () => ({ platform: { openImageDialog: (...a: unknown[]) => openImageDialog(...a) } }))

const rect: ShapeObject = {
  id: 'r1', pageId: 'p1', type: 'rect', x: 100, y: 100, width: 100, height: 50,
  strokeColor: '#000000', fillColor: null, strokeWidth: 2, rotation: 0
}

const key = (k: string, init: Record<string, unknown> = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: k, ...init })

function setup(page = makePage('p1')) {
  loadDoc(makeDoc({ pages: [page], objects: [rect] }))
  act(() => store().selectObject('r1'))
  return renderPage()
}

beforeEach(() => {
  mockLayout()
  openImageDialog.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('editing shortcuts', () => {
  it('Delete and Backspace remove the selected object', () => {
    setup()
    key('Delete')
    expect(objects()).toHaveLength(0)
    expect(store().selectedObjectId).toBeNull()
    act(() => store().undo())
    act(() => store().selectObject('r1'))
    key('Backspace')
    expect(objects()).toHaveLength(0)
  })

  it('arrow keys nudge by 1pt (Shift: 10pt) as one coalesced undo step', () => {
    setup()
    key('ArrowRight')
    key('ArrowRight')
    key('ArrowDown', { shiftKey: true })
    expect(objects()[0]).toMatchObject({ x: 102, y: 110 })
    expect(store().past).toHaveLength(1)
    act(() => store().undo())
    expect(objects()[0]).toMatchObject({ x: 100, y: 100 })
  })

  it('nudges follow the screen direction on rotated pages', () => {
    setup(makePage('p1', { rotation: 90 }))
    key('ArrowRight')
    // On a 90° page screen-right is page-up.
    expect(objects()[0]).toMatchObject({ x: 100, y: 99 })
  })

  it('Ctrl/Cmd+D duplicates with an offset and selects the copy', () => {
    setup()
    const ev = key('d', { ctrlKey: true })
    expect(ev).toBe(false) // default prevented
    expect(objects()).toHaveLength(2)
    const copy = objects()[1]
    expect(copy.id).not.toBe('r1')
    expect(copy).toMatchObject({ x: 110, y: 110, width: 100 })
    expect(store().selectedObjectId).toBe(copy.id)
    key('d', { metaKey: true })
    expect(objects()).toHaveLength(3)
  })

  it('single-letter hotkeys switch tools', () => {
    setup()
    const map: Record<string, string> = {
      v: 'select', h: 'hand', t: 'text', e: 'edit-content', f: 'form-design', r: 'rect', o: 'ellipse', l: 'line',
      a: 'arrow', p: 'ink', m: 'highlight', w: 'whiteout', n: 'note'
    }
    for (const [k, tool] of Object.entries(map)) {
      key(k)
      expect(store().tool).toBe(tool)
    }
    key('R', { shiftKey: true })
    expect(store().tool).toBe('note') // modifiers: ignored
    key('r', { ctrlKey: true })
    expect(store().tool).toBe('note')
  })

  it('S opens the signature dialog and I opens the image picker', async () => {
    openImageDialog.mockResolvedValue({ path: null, name: 'a.png', bytes: pngBytes(40, 20) })
    setup()
    key('s')
    expect(useEditing.getState().signatureOpen).toBe(true)
    act(() => useEditing.getState().setSignatureOpen(false))
    key('i')
    expect(openImageDialog).toHaveBeenCalled()
    await vi.waitFor(() => expect(store().pendingImage).not.toBeNull())
    expect(store().pendingImage).toMatchObject({ mimeType: 'image/png', width: 40, height: 20 })
    expect(store().tool).toBe('image')
  })

  it('Escape cancels the pending image, deselects and returns to the select tool', () => {
    setup()
    act(() => {
      store().setPendingImage({ data: pngBytes(10, 10), mimeType: 'image/png', width: 10, height: 10 })
      store().setTool('image')
    })
    key('Escape')
    expect(store().pendingImage).toBeNull()
    expect(store().tool).toBe('select')
    act(() => store().selectObject('r1'))
    key('Escape')
    expect(store().selectedObjectId).toBeNull()
  })

  it('ignores events from inputs, textareas, selects and contenteditables', () => {
    loadDoc(makeDoc({ objects: [rect] }))
    act(() => store().selectObject('r1'))
    function Harness() {
      useEditingShortcuts()
      return (
        <div>
          <input data-testid="in" />
          <textarea data-testid="ta" />
          <select data-testid="sel">
            <option>a</option>
          </select>
          <div data-testid="ce" contentEditable suppressContentEditableWarning>
            x
          </div>
        </div>
      )
    }
    render(<Harness />)
    for (const id of ['in', 'ta', 'sel', 'ce']) {
      const el = screen.getByTestId(id)
      key('Delete', {}, el)
      key('r', {}, el)
      key('ArrowLeft', {}, el)
      key('Escape', {}, el)
    }
    expect(objects()).toHaveLength(1)
    expect(objects()[0]).toMatchObject({ x: 100 })
    expect(store().tool).toBe('select')
    expect(store().selectedObjectId).toBe('r1')
  })

  it('does not handle undo/save/open shortcuts', () => {
    setup()
    expect(key('z', { ctrlKey: true })).toBe(true)
    expect(key('s', { metaKey: true })).toBe(true)
    expect(key('o', { ctrlKey: true })).toBe(true)
    expect(useEditing.getState().signatureOpen).toBe(false)
    expect(store().tool).toBe('select')
  })
})
