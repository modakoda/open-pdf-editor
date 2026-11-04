import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditObject, LineObject, ShapeObject, TextObject } from '@core'
import { PropertiesPanel } from '@renderer/editing/PropertiesPanel'
import { loadDoc, makeDoc, objects, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const text: TextObject = {
  id: 't1', pageId: 'p1', type: 'text', x: 100, y: 100, width: 200, height: 20, text: 'Hello', font: 'sans',
  bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0
}
const rect: ShapeObject = {
  id: 'r1', pageId: 'p1', type: 'rect', x: 10, y: 10, width: 100, height: 50,
  strokeColor: '#000000', fillColor: null, strokeWidth: 2, rotation: 0
}
const line: LineObject = { id: 'l1', pageId: 'p1', type: 'line', x1: 0, y1: 0, x2: 50, y2: 50, color: '#000000', strokeWidth: 2, arrowEnd: false }

const get = (id: string) => objects().find((o) => o.id === id) as EditObject

function setup(objs: EditObject[], select?: string) {
  loadDoc(makeDoc({ objects: objs }))
  if (select) act(() => store().selectObject(select))
  return render(<PropertiesPanel />)
}

beforeEach(() => undefined)
afterEach(() => cleanup())

describe('PropertiesPanel', () => {
  it('renders nothing without a selection when the tool has no options', () => {
    setup([text])
    expect(screen.queryByTestId('properties-panel')).toBeNull()
    act(() => store().setTool('whiteout'))
    expect(screen.queryByTestId('properties-panel')).toBeNull()
  })

  it('edits text properties; typing a size is one undo step', async () => {
    const user = userEvent.setup()
    setup([text], 't1')
    const panel = screen.getByTestId('properties-panel')
    expect(panel).toHaveAttribute('data-object-type', 'text')
    const size = screen.getByTestId('prop-fontSize')
    await user.clear(size)
    await user.type(size, '24')
    expect(get('t1')).toMatchObject({ fontSize: 24 })
    // Height grows to fit the larger text.
    expect((get('t1') as TextObject).height).toBeCloseTo(24 * 1.2)
    expect(store().past).toHaveLength(1)

    await user.click(screen.getByTestId('prop-bold'))
    await user.click(screen.getByTestId('prop-italic'))
    await user.selectOptions(screen.getByTestId('prop-font'), 'serif')
    await user.click(screen.getByTestId('prop-align-center'))
    fireEvent.input(screen.getByTestId('prop-color'), { target: { value: '#ff0000' } })
    expect(get('t1')).toMatchObject({ bold: true, italic: true, font: 'serif', align: 'center', color: '#ff0000' })

    await user.click(screen.getByTestId('prop-background-none'))
    expect((get('t1') as TextObject).background).toBe('#ffffff')
    await user.click(screen.getByTestId('prop-background-none'))
    expect((get('t1') as TextObject).background).toBeNull()

    const rot = screen.getByTestId('prop-rotation')
    await user.clear(rot)
    await user.type(rot, '45')
    expect(get('t1')).toMatchObject({ rotation: 45 })
  })

  it('edits shape stroke/fill (with "none"), width and opacity', async () => {
    const user = userEvent.setup()
    setup([rect], 'r1')
    await user.click(screen.getByTestId('prop-strokeColor-none'))
    expect((get('r1') as ShapeObject).strokeColor).toBeNull()
    await user.click(screen.getByTestId('prop-fillColor-none'))
    expect((get('r1') as ShapeObject).fillColor).toBe('#ffffff')
    fireEvent.input(screen.getByTestId('prop-fillColor'), { target: { value: '#00ff00' } })
    expect((get('r1') as ShapeObject).fillColor).toBe('#00ff00')
    const w = screen.getByTestId('prop-strokeWidth')
    await user.clear(w)
    await user.type(w, '5')
    expect((get('r1') as ShapeObject).strokeWidth).toBe(5)
    fireEvent.change(screen.getByTestId('prop-opacity'), { target: { value: '50' } })
    expect((get('r1') as ShapeObject).opacity).toBe(0.5)
  })

  it('toggles the arrow head of a line', async () => {
    const user = userEvent.setup()
    setup([line], 'l1')
    await user.click(screen.getByTestId('prop-arrowEnd'))
    expect((get('l1') as LineObject).arrowEnd).toBe(true)
  })

  it('reorders, duplicates and deletes', async () => {
    const user = userEvent.setup()
    setup([rect, text], 'r1')
    await user.click(screen.getByTestId('prop-front'))
    expect(objects().map((o) => o.id)).toEqual(['t1', 'r1'])
    await user.click(screen.getByTestId('prop-back'))
    expect(objects().map((o) => o.id)).toEqual(['r1', 't1'])
    await user.click(screen.getByTestId('prop-duplicate'))
    expect(objects()).toHaveLength(3)
    const copy = objects()[2]
    expect(copy).toMatchObject({ type: 'rect', x: 20, y: 20 })
    expect(store().selectedObjectId).toBe(copy.id)
    await user.click(screen.getByTestId('prop-delete'))
    expect(objects()).toHaveLength(2)
    expect(screen.queryByTestId('properties-panel')).toBeNull()
  })

  it('edits note text and author', async () => {
    const user = userEvent.setup()
    setup([{ id: 'n', pageId: 'p1', type: 'note', x: 0, y: 0, text: '', color: '#facc15' }], 'n')
    await user.type(screen.getByTestId('prop-text'), 'Hi')
    await user.type(screen.getByTestId('prop-author'), 'Me')
    expect(get('n')).toMatchObject({ text: 'Hi', author: 'Me' })
  })

  it('shows and edits the active tool defaults when nothing is selected', async () => {
    const user = userEvent.setup()
    setup([])
    act(() => store().setTool('rect'))
    const panel = screen.getByTestId('properties-panel')
    expect(panel).toHaveAttribute('data-mode', 'tool')
    const w = screen.getByTestId('prop-strokeWidth')
    await user.clear(w)
    await user.type(w, '4')
    expect(store().toolOptions.strokeWidth).toBe(4)
    await user.click(screen.getByTestId('prop-fillColor-none'))
    expect(store().toolOptions.fillColor).toBe('#ffffff')
    expect(store().past).toHaveLength(0)

    act(() => store().setTool('text'))
    await user.selectOptions(screen.getByTestId('prop-font'), 'mono')
    expect(store().toolOptions.font).toBe('mono')
    act(() => store().setTool('highlight'))
    fireEvent.input(screen.getByTestId('prop-highlightColor'), { target: { value: '#00ffff' } })
    expect(store().toolOptions.highlightColor).toBe('#00ffff')
  })
})
