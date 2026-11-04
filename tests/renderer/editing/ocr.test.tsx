/** Recognized text (OCR) lines in Edit content: selecting a line, Make editable, copying. */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getContentItems, type OcrPageResult, type TextObject } from '@core'
import { useEditing } from '@renderer/editing/editingState'
import { useOcrUi } from '@renderer/state/ocr'
import { click, doc, loadDoc, makeDoc, makePage, makeSource, mockLayout, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
vi.mock('@core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core')>()), getContentItems: vi.fn() }))

const RESULT: OcrPageResult = {
  languages: ['eng'],
  rotation: 0,
  lines: [
    {
      id: 'l0',
      box: { x: 100, y: 100, width: 200, height: 20 },
      baseline: 16,
      background: '#f4f1e8',
      color: '#1d1d24',
      words: [
        { text: 'Scanned', confidence: 96, box: { x: 100, y: 100, width: 90, height: 20 } },
        { text: 'title', confidence: 90, box: { x: 200, y: 100, width: 100, height: 20 } }
      ]
    },
    {
      id: 'l1',
      box: { x: 100, y: 200, width: 150, height: 14 },
      baseline: 11,
      words: [{ text: 'Second', confidence: 80, box: { x: 100, y: 200, width: 150, height: 14 } }]
    }
  ]
}

const line = (id: string) => screen.getAllByTestId('ocr-line').find((el) => el.dataset.ocrLineId === id)!

function setup(rotation: 0 | 90 = 0) {
  loadDoc({
    ...makeDoc({
      sources: [makeSource('s')],
      pages: [makePage('p1', { rotation, source: { kind: 'source', sourceId: 's', pageIndex: 0 } })]
    }),
    ocr: { p1: RESULT }
  })
  const r = renderPage({ panel: true, scale: 2 })
  setTool('edit-content')
  return r
}

beforeEach(() => {
  mockLayout()
  vi.mocked(getContentItems).mockReset()
  vi.mocked(getContentItems).mockResolvedValue([{ id: 'img', kind: 'image', bounds: { x: 0, y: 0, width: 600, height: 800 } }])
  act(() => useOcrUi.setState({ selectedLine: null }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('recognized lines in Edit content', () => {
  it('shows a hit target per line, only in Edit content', async () => {
    loadDoc({
      ...makeDoc({ sources: [makeSource('s')], pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })] }),
      ocr: { p1: RESULT }
    })
    renderPage({ panel: true, scale: 2 })
    expect(screen.queryAllByTestId('ocr-line')).toHaveLength(0)
    setTool('edit-content')
    await screen.findAllByTestId('content-item')
    expect(screen.getAllByTestId('ocr-line')).toHaveLength(2)
    expect(line('l0').style).toMatchObject({ left: '200px', top: '200px', width: '400px', height: '40px' })
    expect(line('l0').title).toContain('Scanned title')
  })

  it('selects a line, shows its text and makes it editable in one undo step', async () => {
    setup()
    await screen.findAllByTestId('content-item')
    click(line('l0'), { x: 250, y: 210 })
    expect(line('l0')).toHaveAttribute('data-selected', 'true')
    const panel = screen.getByTestId('properties-panel')
    expect(panel).toHaveAttribute('data-element-kind', 'ocr-line')
    expect(within(panel).getByTestId('ocr-line-text')).toHaveTextContent('Scanned title')
    expect(panel).toHaveTextContent('Confidence 93%')

    const before = doc()
    fireEvent.click(within(panel).getByTestId('ocr-make-editable'))
    const [cover, text] = doc().objects
    expect(cover).toMatchObject({ type: 'whiteout', color: '#f4f1e8' })
    expect(text).toMatchObject({ type: 'text', text: 'Scanned title', color: '#1d1d24', rotation: 0 })
    expect(doc().ocr!.p1.lines.map((l) => l.id)).toEqual(['l1'])
    expect(store().tool).toBe('select')
    expect(store().selectedObjectId).toBe(text.id)
    expect(useOcrUi.getState().selectedLine).toBeNull()

    act(() => store().undo())
    expect(doc()).toBe(before)
  })

  it('double-click makes the line editable and starts typing', async () => {
    setup(90)
    await screen.findAllByTestId('content-item')
    fireEvent.doubleClick(line('l1'))
    const text = doc().objects.find((o) => o.type === 'text') as TextObject
    expect(text.text).toBe('Second')
    // The page shows rotated by 90°, but the text was recognized upright (rotation 0 here).
    expect(text.rotation).toBe(0)
    expect(useEditing.getState().editingTextId).toBe(text.id)
  })

  it('copies a line and clears the selection when clicking elsewhere', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    setup()
    await screen.findAllByTestId('content-item')
    click(line('l1'), { x: 250, y: 410 })
    fireEvent.click(screen.getByTestId('ocr-copy'))
    expect(writeText).toHaveBeenCalledWith('Second')
    await act(async () => undefined)
    expect(store().notice?.text).toContain('Copied')

    click(screen.getByTestId('page-overlay'), { x: 1000, y: 1500 })
    expect(useOcrUi.getState().selectedLine).toBeNull()
    expect(screen.queryByTestId('ocr-line-text')).toBeNull()
  })
})
