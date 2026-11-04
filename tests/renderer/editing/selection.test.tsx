import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getContentItems, type FieldObject } from '@core'
import { deleteSelection } from '@renderer/editing'
import { doc, loadDoc, makeDoc, makePage, makeSource, mockLayout, objects, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
vi.mock('@core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core')>()), getContentItems: vi.fn() }))

const field: FieldObject = { id: 'f1', pageId: 'p1', type: 'field', fieldType: 'text', name: 'New1', x: 10, y: 10, width: 100, height: 20 }

beforeEach(() => {
  mockLayout()
  vi.mocked(getContentItems).mockResolvedValue([{ id: 'c1', kind: 'image', bounds: { x: 0, y: 0, width: 50, height: 50 } }])
  const source = {
    ...makeSource('s', [{ name: 'name', type: 'text', value: '', readOnly: false, widgets: [{ pageIndex: 0, box: { x: 100, y: 100, width: 100, height: 20 } }] }]),
    pageInfo: [{ width: 600, height: 800, rotation: 0 as const, annotations: [{ id: 'a1', subtype: 'Square', bounds: { x: 300, y: 300, width: 50, height: 50 } }] }]
  }
  loadDoc(makeDoc({ sources: [source], pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })], objects: [field] }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('deleteSelection()', () => {
  it('returns false when nothing is selected', () => {
    expect(deleteSelection()).toBe(false)
    expect(store().past).toHaveLength(0)
  })

  it('deletes a selected object (FieldObject included)', () => {
    act(() => store().selectObject('f1'))
    let result = false
    act(() => {
      result = deleteSelection()
    })
    expect(result).toBe(true)
    expect(objects()).toHaveLength(0)
  })

  it('deletes a selected annotation and a selected form field', () => {
    act(() => store().selectElement({ kind: 'annotation', pageId: 'p1', annotId: 'a1' }))
    act(() => void deleteSelection())
    expect(doc().annotationEdits?.p1).toEqual([{ annotId: 'a1', deleted: true }])
    act(() => store().selectElement({ kind: 'field', sourceId: 's', fieldName: 'name', widgetIndex: 0, pageId: 'p1' }))
    act(() => void deleteSelection())
    expect(doc().fieldEdits?.s?.name).toEqual({ deleted: true })
    expect(store().selectedElement).toBeNull()
    expect(store().past).toHaveLength(2)
  })

  it('deletes a selected content item', async () => {
    renderPage()
    setTool('edit-content')
    await screen.findAllByTestId('content-item')
    act(() => store().selectElement({ kind: 'content', pageId: 'p1', itemId: 'c1' }))
    act(() => void deleteSelection())
    expect(doc().contentEdits?.p1).toEqual([{ itemId: 'c1', deleted: true }])
    expect(screen.queryAllByTestId('content-item')).toHaveLength(0)
  })

  it('undo brings the element back and re-validates the selection', () => {
    act(() => store().selectElement({ kind: 'annotation', pageId: 'p1', annotId: 'a1' }))
    act(() => void deleteSelection())
    act(() => store().undo())
    expect(doc().annotationEdits?.p1 ?? []).toEqual([])
  })
})
