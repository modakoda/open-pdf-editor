import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_ICON_SIZE, type AnnotationInfo, type ShapeObject } from '@core'
import { click, doc, drag, loadDoc, makeDoc, makePage, makeSource, mockLayout, objectEl, renderPage, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const ANNOTS: (AnnotationInfo & { hasAppearance?: boolean })[] = [
  { id: 'a1', subtype: 'Text', bounds: { x: 400, y: 100, width: 20, height: 20 }, contents: 'Hi', author: 'Bob', color: '#ffff00', hasAppearance: false },
  { id: 'l1', subtype: 'Link', bounds: { x: 50, y: 700, width: 200, height: 20 }, uri: 'https://example.com' }
]
const rect: ShapeObject = {
  id: 'r1', pageId: 'p1', type: 'rect', x: 395, y: 95, width: 10, height: 10, strokeColor: '#000000', fillColor: null, strokeWidth: 1, rotation: 0
}

const annot = (id: string) => screen.getAllByTestId('annotation').find((el) => el.dataset.annotId === id)!
const edit = (id: string) => doc().annotationEdits?.p1?.find((e) => e.annotId === id)

function setup(objects = [] as ShapeObject[]) {
  const source = { ...makeSource('s'), pageInfo: [{ width: 600, height: 800, rotation: 0 as const, annotations: ANNOTS }] }
  loadDoc(makeDoc({ sources: [source], pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })], objects }))
  return renderPage({ panel: true })
}

beforeEach(() => mockLayout())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('existing annotations (Select tool)', () => {
  it('shows outlines and selects on click', () => {
    setup()
    expect(screen.getAllByTestId('annotation').map((e) => e.dataset.subtype)).toEqual(['Text', 'Link'])
    click(annot('a1'), { x: 410, y: 110 })
    expect(store().selectedElement).toEqual({ kind: 'annotation', pageId: 'p1', annotId: 'a1' })
    expect(annot('a1')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('element-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('handle-rotate')).toBeNull()
    click(screen.getByTestId('page-overlay'), { x: 300, y: 400 })
    expect(store().selectedElement).toBeNull()
  })

  it('objects drawn over an annotation take precedence', () => {
    const { container } = setup([rect])
    click(objectEl(container, 'r1'), { x: 400, y: 100 })
    expect(store().selectedObjectId).toBe('r1')
    expect(store().selectedElement).toBeNull()
  })

  it('drag moves and handles resize the bounds, one undo step each', () => {
    setup()
    drag(annot('a1'), { x: 410, y: 110 }, { x: 440, y: 150 })
    expect(edit('a1')?.bounds).toEqual({ x: 430, y: 140, width: 20, height: 20 })
    expect(store().past).toHaveLength(1)
    click(annot('l1'), { x: 100, y: 710 })
    drag(screen.getByTestId('handle-se'), { x: 250, y: 720 }, { x: 270, y: 750 })
    expect(edit('l1')?.bounds).toEqual({ x: 50, y: 700, width: 220, height: 50 })
    expect(store().past).toHaveLength(2)
    expect(annot('l1').style.width).toBe('220px')
    act(() => store().undo())
    expect(edit('l1')).toBeUndefined()
    expect(edit('a1')?.bounds).toEqual({ x: 430, y: 140, width: 20, height: 20 })
  })

  it('Delete removes the annotation', () => {
    setup()
    click(annot('l1'), { x: 100, y: 710 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(edit('l1')).toEqual({ annotId: 'l1', deleted: true })
    expect(screen.getAllByTestId('annotation').map((e) => e.dataset.annotId)).toEqual(['a1'])
    expect(store().selectedElement).toBeNull()
  })

  it('properties panel edits contents, author, colour and link URL; Reset restores', async () => {
    const user = userEvent.setup()
    setup()
    click(annot('a1'), { x: 410, y: 110 })
    const contents = screen.getByTestId('prop-annot-contents')
    expect(contents).toHaveValue('Hi')
    await user.type(contents, ' there')
    await user.clear(screen.getByTestId('prop-annot-author'))
    await user.type(screen.getByTestId('prop-annot-author'), 'Ann')
    fireEvent.input(screen.getByTestId('prop-annot-color'), { target: { value: '#ff0000' } })
    expect(edit('a1')).toMatchObject({ contents: 'Hi there', author: 'Ann', color: '#ff0000' })
    await user.click(screen.getByTestId('prop-reset'))
    expect(edit('a1')).toBeUndefined()

    click(annot('l1'), { x: 100, y: 710 })
    expect(screen.queryByTestId('prop-annot-contents')).toBeNull()
    const uri = screen.getByTestId('prop-annot-uri')
    await user.clear(uri)
    await user.type(uri, 'https://x.org')
    expect(edit('l1')?.uri).toBe('https://x.org')
  })

  it('annotations are only picked with the Select tool', () => {
    setup()
    act(() => store().setTool('rect'))
    expect(screen.queryAllByTestId('annotation')).toHaveLength(0)
  })

  it('draws the note icon for sticky notes without an appearance (in every tool)', () => {
    setup()
    const icon = annot('a1')
    expect(icon).toHaveAttribute('data-note-icon', 'true')
    expect(icon.style.width).toBe(`${NOTE_ICON_SIZE}px`)
    expect(icon.style.background).toBe('rgb(255, 255, 0)')
    expect(icon.title).toMatch(/Bob: Hi/)
    expect(annot('l1')).not.toHaveAttribute('data-note-icon')
    click(icon, { x: 405, y: 105 })
    expect(screen.getByTestId('prop-annot-contents')).toHaveValue('Hi')
    act(() => store().setTool('ink'))
    // Still visible, but not interactive.
    expect(screen.getAllByTestId('annotation-icon')).toHaveLength(1)
    expect(screen.queryAllByTestId('annotation')).toHaveLength(0)
  })
})
