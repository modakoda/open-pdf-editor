/**
 * Text recognition in the workspace with a fake OCR engine: the Recognize text dialog (scope,
 * languages, progress, cancel), storing results as one undo step, the scanned-document offer
 * after opening a file, and Find over recognized text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides,
  getContentItems: vi.fn(async () => [])
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)
vi.mock('@renderer/editing', async () => (await import('./support/fakeEditing')).editingModule)
vi.mock('@renderer/pdf/thumbnails', () => ({
  getThumbnailUrl: vi.fn(async () => 'blob:source'),
  getPreviewThumbnailUrl: vi.fn(async () => 'blob:preview'),
  releaseThumbnails: vi.fn()
}))

import { getContentItems, type ContentItem, type EditorDocument, type OcrPageResult, type RecognizedLine } from '@core'
import { App } from '@renderer/App'
import { resetCommandState, runCommand } from '@renderer/actions/commands'
import { openFileHere } from '@renderer/actions/fileActions'
import { runFind } from '@renderer/actions/find'
import { recognizePages } from '@renderer/actions/ocr'
import { abortError, setOcrEngine, type OcrEngine, type RecognizeOptions } from '@renderer/ocr/engine'
import { OCR_DPI } from '@renderer/ocr/render'
import { useFind } from '@renderer/state/find'
import { makeDoc, resetFakeCore } from './support/fakeCore'
import { renderCalls } from './support/fakePdfjs'
import { resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

/** Pixels per point of the page images (the fake pdf.js page is 600 × 800 pt). */
const S = Math.round(600 * (OCR_DPI / 72)) / 600

const px = (x: number, y: number, w: number, h: number) => ({ x0: x * S, y0: y * S, x1: (x + w) * S, y1: (y + h) * S })

/** One line "Invoice 42" at page (100, 200), 20 pt high, baseline 16 pt below its top. */
function invoiceLine(): RecognizedLine {
  return {
    bbox: px(100, 200, 150, 20),
    baseline: { x0: 100 * S, y0: 216 * S, x1: 250 * S, y1: 216 * S },
    words: [
      { text: 'Invoice', confidence: 95, bbox: px(100, 200, 80, 20) },
      { text: '42', confidence: 88, bbox: px(190, 200, 60, 20) }
    ]
  }
}

interface Pending {
  languages: string[]
  options: RecognizeOptions
  resolve(lines: RecognizedLine[]): void
  reject(err: unknown): void
}

/** Engine whose jobs finish when the test says so (or immediately with `auto`). */
function fakeEngine(auto?: () => RecognizedLine[]) {
  const pending: Pending[] = []
  const engine: OcrEngine & { recognize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } = {
    recognize: vi.fn((_canvas: HTMLCanvasElement, languages: string[], options: RecognizeOptions = {}) => {
      options.onProgress?.({ stage: 'loading', progress: 0.5 })
      if (auto) {
        options.onProgress?.({ stage: 'recognizing', progress: 1 })
        return Promise.resolve(auto())
      }
      return new Promise<RecognizedLine[]>((resolve, reject) => {
        pending.push({ languages, options, resolve, reject })
        options.signal?.addEventListener('abort', () => reject(abortError()))
      })
    }),
    dispose: vi.fn(async () => undefined)
  }
  return { engine, pending }
}

const ocrDialog = () => screen.getByTestId('dialog')

async function openOcrDialogFromToolbar(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('btn-ocr'))
  const dialog = await screen.findByTestId('dialog')
  expect(dialog).toHaveAttribute('data-dialog', 'ocr')
  return dialog
}

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
  resetCommandState()
  renderCalls.length = 0
  localStorage.clear()
  vi.mocked(getContentItems).mockReset()
  vi.mocked(getContentItems).mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  setOcrEngine(null)
})

describe('Recognize text dialog', () => {
  it('recognizes the current page with progress, stores the result as one undo step', async () => {
    const { engine, pending } = fakeEngine()
    setOcrEngine(engine)
    loadDoc(makeDoc(2))
    act(() => editor().setCurrentPage('p2'))
    render(<App />)
    const dialog = await openOcrDialogFromToolbar()
    fireEvent.click(within(dialog).getByTestId('ocr-scope-current'))
    expect(within(dialog).queryByTestId('ocr-skip-text')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('ocr-lang-lit'))
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'))

    await waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].languages).toEqual(['eng', 'lit'])
    // The page is rendered upright at the OCR resolution without annotations.
    expect(renderCalls.at(-1)).toMatchObject({ rotation: 0, annotationMode: 0 })
    expect(renderCalls.at(-1)!.scale).toBeCloseTo(OCR_DPI / 72)
    expect(screen.getByTestId('ocr-progress')).toHaveTextContent('Page 2 (1 of 1): preparing')
    act(() => pending[0].options.onProgress?.({ stage: 'recognizing', progress: 0.4 }))
    expect(screen.getByTestId('ocr-progress')).toHaveTextContent('recognizing text… 40%')
    expect((screen.getByTestId('ocr-progress-bar') as HTMLProgressElement).value).toBe(40)
    expect(within(dialog).getByTestId('dialog-confirm')).toBeDisabled()

    await act(async () => pending[0].resolve([invoiceLine()]))
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull())
    const result = editor().doc!.ocr?.p2 as OcrPageResult
    expect(result.languages).toEqual(['eng', 'lit'])
    expect(result.lines[0].words.map((w) => w.text)).toEqual(['Invoice', '42'])
    expect(result.lines[0].words[0].box.x).toBeCloseTo(100)
    expect(result.lines[0].baseline).toBeCloseTo(16)
    expect(editor().doc!.ocr?.p1).toBeUndefined()
    expect(screen.getByTestId('notice')).toHaveTextContent('Recognized text on 1 page')
    expect(editor().dirty).toBe(true)
    // The languages are remembered for next time.
    expect(JSON.parse(localStorage.getItem('ope.ocr.languages')!)).toEqual(['eng', 'lit'])

    act(() => editor().undo())
    expect(editor().doc!.ocr?.p2).toBeUndefined()
    act(() => editor().redo())
    expect(editor().doc!.ocr?.p2).toBe(result)
  })

  it('runs from the Document menu command for all pages, skipping pages that already have text', async () => {
    const { engine } = fakeEngine(() => [invoiceLine()])
    setOcrEngine(engine)
    vi.mocked(getContentItems).mockImplementation(async (_doc: EditorDocument, pageId: string): Promise<ContentItem[]> =>
      pageId === 'p2' ? [{ id: 't1', kind: 'text', bounds: { x: 0, y: 0, width: 10, height: 10 }, text: 'Real text' }] : []
    )
    loadDoc(makeDoc(3))
    render(<App />)
    act(() => runCommand('recognize-text', 'menu'))
    const dialog = await screen.findByTestId('dialog')
    expect(within(dialog).getByTestId('ocr-scope-all')).toBeChecked()
    expect(within(dialog).getByTestId('ocr-skip-text')).toBeChecked()
    expect(within(dialog).getByTestId('ocr-lang-eng')).toBeChecked()
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'))
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull())
    expect(Object.keys(editor().doc!.ocr!).sort()).toEqual(['p1', 'p3'])
    expect(engine.recognize).toHaveBeenCalledTimes(2)
    expect(editor().past).toHaveLength(1)
  })

  it('needs a language', async () => {
    loadDoc(makeDoc(1))
    render(<App />)
    const dialog = await openOcrDialogFromToolbar()
    fireEvent.click(within(dialog).getByTestId('ocr-lang-eng'))
    expect(within(dialog).getByTestId('dialog-confirm')).toBeDisabled()
    expect(dialog).toHaveTextContent('Choose at least one language')
  })

  it('cancel stops the work and keeps the pages finished so far', async () => {
    const { engine, pending } = fakeEngine()
    setOcrEngine(engine)
    loadDoc(makeDoc(3))
    render(<App />)
    const dialog = await openOcrDialogFromToolbar()
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'))
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => pending[0].resolve([invoiceLine()]))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(screen.getByTestId('ocr-progress')).toHaveTextContent('Page 2 (2 of 3)')

    fireEvent.click(within(ocrDialog()).getByTestId('dialog-cancel'))
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull())
    expect(pending[1].options.signal?.aborted).toBe(true)
    expect(pending).toHaveLength(2) // page 3 was never started
    expect(Object.keys(editor().doc!.ocr!)).toEqual(['p1'])
    expect(screen.getByTestId('notice')).toHaveTextContent('Text recognition cancelled. Text was recognized on 1 page.')
  })

  it('Escape while nothing runs just closes the dialog', async () => {
    loadDoc(makeDoc(1))
    render(<App />)
    const dialog = await openOcrDialogFromToolbar()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull())
    expect(editor().doc!.ocr).toBeUndefined()
  })

  it('reports engine errors and keeps finished pages', async () => {
    const { engine, pending } = fakeEngine()
    setOcrEngine(engine)
    loadDoc(makeDoc(2))
    render(<App />)
    const dialog = await openOcrDialogFromToolbar()
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'))
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => pending[0].resolve([invoiceLine()]))
    await waitFor(() => expect(pending).toHaveLength(2))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => pending[1].reject(new Error('worker crashed')))
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull())
    expect(screen.getByTestId('notice')).toHaveAttribute('data-kind', 'error')
    expect(screen.getByTestId('notice')).toHaveTextContent('Text recognition failed: worker crashed')
    expect(Object.keys(editor().doc!.ocr!)).toEqual(['p1'])
  })

  it('drops results when another document was opened meanwhile', async () => {
    const { engine, pending } = fakeEngine()
    setOcrEngine(engine)
    loadDoc(makeDoc(1))
    const run = recognizePages({ pageIds: ['p1'], languages: ['eng'] })
    await waitFor(() => expect(pending).toHaveLength(1))
    loadDoc(makeDoc(1))
    pending[0].resolve([invoiceLine()])
    expect(await run).toMatchObject({ recognized: 1, cancelled: false })
    expect(editor().doc!.ocr).toBeUndefined()
  })
})

describe('scanned documents', () => {
  const scanItems: ContentItem[] = [{ id: 'i1', kind: 'image', bounds: { x: 0, y: 0, width: 600, height: 800 } }]

  it('offers text recognition after opening a scanned file', async () => {
    vi.mocked(getContentItems).mockResolvedValue(scanItems)
    render(<App />)
    await act(async () => {
      await openFileHere({ path: '/scan.pdf', name: 'scan.pdf', bytes: new Uint8Array([1]) })
    })
    const notice = await screen.findByTestId('notice')
    await waitFor(() => expect(notice).toHaveTextContent('This document looks scanned'))
    fireEvent.click(screen.getByTestId('notice-action'))
    const dialog = await screen.findByTestId('dialog')
    expect(dialog).toHaveAttribute('data-dialog', 'ocr')
    expect(within(dialog).getByTestId('ocr-scope-all')).toBeChecked()
    expect(screen.queryByTestId('notice')).toBeNull()
  })

  it('says how many pages look scanned in a mixed document, and nothing for text documents', async () => {
    vi.mocked(getContentItems).mockImplementation(async (_d: EditorDocument, pageId: string) =>
      pageId === 'p2' ? scanItems : [{ id: 't', kind: 'text', bounds: { x: 0, y: 0, width: 5, height: 5 }, text: 'x' }]
    )
    render(<App />)
    await act(async () => {
      await openFileHere({ path: '/mixed.pdf', name: 'mixed.pdf', bytes: new Uint8Array([1]) })
    })
    await waitFor(() => expect(screen.getByTestId('notice')).toHaveTextContent('1 page looks scanned'))

    vi.mocked(getContentItems).mockResolvedValue([{ id: 't', kind: 'text', bounds: { x: 0, y: 0, width: 5, height: 5 }, text: 'x' }])
    act(() => editor().clearNotice())
    await act(async () => {
      await openFileHere({ path: '/text.pdf', name: 'text.pdf', bytes: new Uint8Array([1]) })
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('notice-action')).toBeNull()
  })
})

describe('Find in recognized text', () => {
  it('finds words recognized by OCR, with rectangles on the scanned words', async () => {
    const { engine } = fakeEngine(() => [invoiceLine()])
    setOcrEngine(engine)
    loadDoc(makeDoc(2))
    await recognizePages({ pageIds: ['p2'], languages: ['eng'] })
    await runFind('invoice 4')
    const { matches } = useFind.getState()
    expect(matches).toHaveLength(1)
    expect(matches[0].pageId).toBe('p2')
    const [first, second] = matches[0].rects
    // "Invoice" spans its word box; the baseline is 216 pt from the top of the page.
    expect(first.x).toBeCloseTo(100, 0)
    expect(first.width).toBeCloseTo(80, 0)
    expect(first.y).toBeCloseTo(200, 0)
    expect(first.y + first.height).toBeGreaterThan(216)
    expect(second.x).toBeGreaterThanOrEqual(190)
    expect(second.x).toBeLessThan(250)
    // The pages' own text is still searched as well.
    await runFind('hello world')
    expect(useFind.getState().matches.map((m) => m.pageId)).toEqual(['p1', 'p2'])
  })

  it('finds recognized text on a page displayed rotated', async () => {
    const { engine } = fakeEngine(() => [invoiceLine()])
    setOcrEngine(engine)
    const doc = makeDoc(1)
    doc.pages[0] = { ...doc.pages[0], rotation: 90 }
    loadDoc(doc)
    await recognizePages({ pageIds: ['p1'], languages: ['eng'] })
    expect(editor().doc!.ocr!.p1.rotation).toBe(90)
    await runFind('Invoice')
    const [rect] = useFind.getState().matches[0].rects
    // Upright (reading) x 100..180 on a page shown at 90° is page y 800-180..800-100.
    expect(rect.y).toBeCloseTo(620, 0)
    expect(rect.height).toBeCloseTo(80, 0)
    expect(rect.x).toBeCloseTo(200, 0)
  })
})
