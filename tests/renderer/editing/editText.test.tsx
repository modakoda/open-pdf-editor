import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layoutText, type TextObject } from '@core'
import { getPdfPage } from '@renderer/pdf/pdfjs'
import { useEditing } from '@renderer/editing/editingState'
import { click, loadDoc, makeDoc, makePage, makeSource, mockLayout, objects, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const H = 800
const textContent = {
  items: [
    // "Hello" and "world" are separate items on one line, followed by an EOL marker.
    { str: 'Hello', transform: [12, 0, 0, 12, 72, H - 120], width: 28, height: 12, fontName: 'f1', hasEOL: false, dir: 'ltr' },
    { str: 'world', transform: [12, 0, 0, 12, 103.5, H - 120], width: 30, height: 12, fontName: 'f1', hasEOL: true, dir: 'ltr' },
    { str: '', transform: [12, 0, 0, 12, 0, 0], width: 0, height: 0, fontName: 'f1', hasEOL: true, dir: 'ltr' },
    { str: 'Bold title', transform: [24, 0, 0, 24, 72, H - 72], width: 120, height: 24, fontName: 'f2', hasEOL: true, dir: 'ltr' }
  ],
  styles: {
    f1: { ascent: 0.75, descent: -0.25, vertical: false, fontFamily: 'sans-serif' },
    f2: { ascent: 0.75, descent: -0.25, vertical: false, fontFamily: 'serif' }
  }
}
const fontNames: Record<string, string> = { f1: 'ABCDEF+Helvetica', f2: 'Times-Bold' }

beforeEach(() => {
  mockLayout()
  vi.mocked(getPdfPage).mockResolvedValue({
    getTextContent: async () => textContent,
    getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => {
      expect(scale).toBe(1)
      expect(rotation).toBe(0)
      return { transform: [1, 0, 0, -1, 0, H] }
    },
    commonObjs: { has: (id: string) => id in fontNames, get: (id: string) => ({ name: fontNames[id] }) }
  } as never)
  loadDoc(
    makeDoc({
      sources: [makeSource('s')],
      pages: [makePage('p1', { source: { kind: 'source', sourceId: 's', pageIndex: 0 } })]
    })
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('edit existing text', () => {
  it('shows hover boxes for merged text runs', async () => {
    renderPage()
    setTool('edit-text')
    const runs = await screen.findAllByTestId('text-run')
    expect(runs).toHaveLength(2)
    expect(runs[0].title).toMatch(/covered/i)
    expect(getPdfPage).toHaveBeenCalledWith(expect.objectContaining({ id: 's' }), 0)
  })

  it('clicking a run creates a covering, prefilled text object aligned to the original baseline', async () => {
    const user = userEvent.setup()
    renderPage()
    setTool('edit-text')
    const runs = await screen.findAllByTestId('text-run')
    click(runs[0], { x: 80, y: 115 })
    expect(objects()).toHaveLength(1)
    const t = objects()[0] as TextObject
    expect(t).toMatchObject({
      type: 'text',
      text: 'Hello world',
      fontSize: 12,
      font: 'sans',
      bold: false,
      color: '#000000',
      background: '#ffffff',
      rotation: 0
    })
    expect(t.x).toBeCloseTo(72)
    expect(t.width).toBeGreaterThanOrEqual(61.5)
    const first = layoutText({ ...t }).lines[0]
    expect(t.y + first.baseline).toBeCloseTo(120, 1)
    // Covers the original glyph box (ascent 9pt above, descent 3pt below the baseline).
    expect(t.y).toBeLessThanOrEqual(120 - 9 + 0.01)
    expect(t.y + t.height).toBeGreaterThanOrEqual(120 + 3 - 0.01)

    expect(store().selectedObjectId).toBe(t.id)
    expect(useEditing.getState().editingTextId).toBe(t.id)
    const editor = screen.getByTestId('text-object-editor')
    expect(editor).toHaveValue('Hello world')
    await user.type(editor, '! More words here')
    const typed = objects()[0] as TextObject
    expect(typed.text).toBe('Hello world! More words here')
    // A covering object widens instead of wrapping the replaced line.
    expect(typed.width).toBeGreaterThan(t.width)
    expect(layoutText({ ...typed }).lines).toHaveLength(1)
    expect(store().past).toHaveLength(1)
    // The replaced run no longer shows a hover box.
    act(() => (editor as HTMLTextAreaElement).blur())
    expect(screen.getAllByTestId('text-run')).toHaveLength(1)
  })

  it('detects bold serif fonts from the PDF font name', async () => {
    renderPage()
    setTool('edit-text')
    const runs = await screen.findAllByTestId('text-run')
    click(runs[1], { x: 100, y: 60 })
    expect(objects()[0]).toMatchObject({ text: 'Bold title', font: 'serif', bold: true, italic: false, fontSize: 24 })
  })

  it('clicking an existing text object edits it instead of creating a new one', async () => {
    renderPage()
    setTool('edit-text')
    const runs = await screen.findAllByTestId('text-run')
    click(runs[0], { x: 80, y: 115 })
    act(() => (screen.getByTestId('text-object-editor') as HTMLTextAreaElement).blur())
    click(screen.getByTestId('object'), { x: 80, y: 115 })
    expect(objects()).toHaveLength(1)
    expect(screen.getByTestId('text-object-editor')).toBeInTheDocument()
  })
})
