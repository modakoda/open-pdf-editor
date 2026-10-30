import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addRedactions, makeRedaction, type RedactionArea } from '@core'
import { redactAllMatches } from '@renderer/actions/redactActions'
import { FindBar } from '@renderer/components/find/FindBar'
import { RedactOptions } from '@renderer/editing/RedactOptions'
import { useRedaction } from '@renderer/editing/redactionState'
import { ToolPalette } from '@renderer/editing/ToolPalette'
import { useFind } from '@renderer/state/find'
import { click, doc, drag, loadDoc, makeDoc, makePage, mockLayout, pointerDown, pointerUp, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const layer = () => screen.getByTestId('redactions-layer')
const areas = () => doc().redactions ?? []
const areaEl = (id: string) => document.querySelector<HTMLElement>(`[data-testid="redaction"][data-redaction-id="${id}"]`)!

function withArea(box = { x: 100, y: 100, width: 150, height: 40 }, extra: Partial<RedactionArea> = {}): RedactionArea {
  const area = { ...makeRedaction('p1', box), ...extra }
  loadDoc(addRedactions(makeDoc(), [area]))
  return area
}

beforeEach(() => {
  mockLayout()
  loadDoc(makeDoc())
  useRedaction.setState({ selectedId: null, fillColor: '#000000', overlayText: '' })
  useFind.setState({ open: false, query: '', matches: [], active: -1, searching: false })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the Redact tool', () => {
  it('marks an area by dragging, selects it and stays active', () => {
    renderPage()
    setTool('redact')
    drag(layer(), { x: 100, y: 100 }, { x: 250, y: 140 })
    expect(areas()).toEqual([expect.objectContaining({ pageId: 'p1', x: 100, y: 100, width: 150, height: 40, fillColor: '#000000' })])
    const el = areaEl(areas()[0].id)
    expect(el).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('redaction-frame')).toBeInTheDocument()
    expect(store().tool).toBe('redact')
    expect(store().past).toHaveLength(1)
    expect(store().dirty).toBe(true)
  })

  it('uses the chosen fill and overlay text for new areas', () => {
    useRedaction.setState({ fillColor: null, overlayText: 'REDACTED' })
    renderPage()
    setTool('redact')
    drag(layer(), { x: 10, y: 10 }, { x: 60, y: 30 })
    expect(areas()[0]).toMatchObject({ fillColor: null, overlayText: 'REDACTED' })
    expect(areaEl(areas()[0].id)).toHaveTextContent('REDACTED')
  })

  it('ignores clicks and tiny drags, and a click on the page clears the selection', () => {
    const area = withArea()
    useRedaction.setState({ selectedId: area.id })
    renderPage()
    setTool('redact')
    click(layer(), { x: 400, y: 400 })
    drag(layer(), { x: 400, y: 400 }, { x: 401, y: 401 })
    expect(areas()).toHaveLength(1)
    expect(useRedaction.getState().selectedId).toBeNull()
  })

  it('moves an area by dragging it and resizes it with the handles (undoable)', () => {
    const area = withArea()
    renderPage()
    setTool('redact')
    drag(areaEl(area.id), { x: 120, y: 110 }, { x: 170, y: 160 })
    expect(areas()[0]).toMatchObject({ x: 150, y: 150, width: 150, height: 40 })
    expect(useRedaction.getState().selectedId).toBe(area.id)
    drag(screen.getByTestId('handle-se'), { x: 300, y: 190 }, { x: 350, y: 230 })
    expect(areas()[0]).toMatchObject({ x: 150, y: 150, width: 200, height: 80 })
    act(() => store().undo())
    expect(areas()[0]).toMatchObject({ x: 150, y: 150, width: 150, height: 40 })
    act(() => store().undo())
    expect(areas()[0]).toMatchObject({ x: 100, y: 100 })
  })

  it('keeps moved areas on the page', () => {
    const area = withArea()
    renderPage()
    setTool('redact')
    drag(areaEl(area.id), { x: 120, y: 110 }, { x: 1200, y: -500 })
    expect(areas()[0]).toMatchObject({ x: 600 - 150, y: 0 })
  })

  it('removes the selected area with Delete, deselects with Escape and nudges with arrows', () => {
    const area = withArea()
    renderPage()
    setTool('redact')
    click(areaEl(area.id), { x: 120, y: 110 })
    expect(useRedaction.getState().selectedId).toBe(area.id)
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    expect(areas()[0].x).toBe(110)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useRedaction.getState().selectedId).toBeNull()
    expect(store().tool).toBe('redact')
    click(areaEl(area.id), { x: 120, y: 110 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(areas()).toHaveLength(0)
    act(() => store().undo())
    expect(areas()).toHaveLength(1)
  })

  it('shows marked areas with other tools without reacting to them', () => {
    const area = withArea()
    renderPage()
    expect(areaEl(area.id)).toBeInTheDocument()
    expect(layer()).not.toHaveClass('active')
    pointerDown(areaEl(area.id), { x: 120, y: 110 })
    pointerUp(areaEl(area.id), { x: 120, y: 110 })
    expect(useRedaction.getState().selectedId).toBeNull()
    expect(screen.queryByTestId('redaction-frame')).toBeNull()
  })

  it('renders nothing for pages without areas unless the tool is active', () => {
    renderPage()
    expect(screen.queryByTestId('redactions-layer')).toBeNull()
    setTool('redact')
    expect(screen.getByTestId('redactions-layer')).toHaveClass('active')
  })
})

describe('redaction options', () => {
  it('is shown in the palette for the Redact tool, which the X key also activates', async () => {
    render(<ToolPalette />)
    expect(screen.queryByTestId('redact-apply')).toBeNull()
    await userEvent.click(screen.getByTestId('tool-redact'))
    expect(store().tool).toBe('redact')
    expect(screen.getByTestId('redact-count')).toHaveTextContent('0 areas')
    expect(screen.getByTestId('redact-apply')).toBeDisabled()
    act(() => store().setTool('select'))
    renderPage()
    fireEvent.keyDown(window, { key: 'x' })
    expect(store().tool).toBe('redact')
  })

  it('edits the selected area (one undo step while typing) and the defaults for new ones', async () => {
    const area = withArea()
    setTool('redact')
    act(() => useRedaction.getState().select(area.id))
    render(<RedactOptions />)
    expect(screen.getByTestId('redact-count')).toHaveTextContent('1 area')
    await userEvent.type(screen.getByTestId('redact-overlay-text'), 'Name')
    expect(areas()[0].overlayText).toBe('Name')
    expect(store().past).toHaveLength(1)
    await userEvent.click(screen.getByTestId('redact-fill-enabled'))
    expect(areas()[0].fillColor).toBeNull()
    expect(screen.getByTestId('redact-fill')).toBeDisabled()
    expect(useRedaction.getState()).toMatchObject({ fillColor: null, overlayText: 'Name' })
    act(() => useRedaction.getState().select(null))
    await userEvent.click(screen.getByTestId('redact-fill-enabled'))
    expect(useRedaction.getState().fillColor).toBe('#000000')
    expect(areas()[0].fillColor).toBeNull()
  })
})

describe('redacting all matches of a search', () => {
  it('marks every match as one undo step and switches to the Redact tool', async () => {
    loadDoc(makeDoc({ pages: [makePage('p1'), makePage('p2')] }))
    useFind.setState({ open: true, query: 'secret' })
    render(<FindBar />)
    // The bar searches again when it opens; the matches arrive afterwards.
    await vi.waitFor(() => expect(useFind.getState().searching).toBe(false))
    act(() =>
      useFind.setState({
        matches: [
          { pageId: 'p1', rects: [{ x: 10, y: 20, width: 30, height: 12 }] },
          { pageId: 'p2', rects: [{ x: 50, y: 60, width: 25, height: 12 }, { x: 5, y: 80, width: 10, height: 12 }] }
        ],
        active: 0
      })
    )
    await userEvent.click(screen.getByTestId('find-redact-all'))
    await vi.waitFor(() => expect(areas()).toHaveLength(3))
    expect(areas().map((a) => [a.pageId, a.x, a.y, a.width, a.height])).toEqual([
      ['p1', 10, 20, 30, 12],
      ['p2', 50, 60, 25, 12],
      ['p2', 5, 80, 10, 12]
    ])
    expect(store().past).toHaveLength(1)
    expect(store().tool).toBe('redact')
    expect(store().notice?.text).toMatch(/Marked 3 areas/)
  })

  it('does nothing without matches', async () => {
    expect(await redactAllMatches()).toBe(0)
    render(<FindBar />)
    expect(screen.queryByTestId('find-redact-all')).toBeNull()
    act(() => useFind.setState({ open: true, query: 'x', matches: [] }))
    expect(screen.getByTestId('find-redact-all')).toBeDisabled()
  })
})
