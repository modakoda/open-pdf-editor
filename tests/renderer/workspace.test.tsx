import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)
vi.mock('@renderer/pdf/thumbnails', () => ({
  getThumbnailUrl: vi.fn(async () => 'data:image/png;base64,AAAA'),
  releaseThumbnails: vi.fn()
}))
vi.mock('@renderer/editing', async () => (await import('./support/fakeEditing')).editingModule)

import { App } from '@renderer/App'
import { resetCommandState } from '@renderer/actions/commands'
import { CSS_PX_PER_PT } from '@core'
import { computeFitZoom } from '@renderer/components/viewer/Viewer'
import { nextSelection, PAGE_DRAG_TYPE } from '@renderer/components/sidebar/Sidebar'
import { useDialogs } from '@renderer/state/dialogs'
import { coreOverrides as core, makeDoc, makePage, resetFakeCore } from './support/fakeCore'
import { fake, resetFakePlatform } from './support/fakePlatform'
import { fakePage, renderCalls } from './support/fakePdfjs'
import { editor, loadDoc, resetStores } from './support/editor'

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
  resetCommandState()
  renderCalls.length = 0
})
afterEach(() => cleanup())

const btn = (id: string) => screen.getByTestId(id)

describe('welcome screen', () => {
  it('shows open / new / recent files and drag & drop hint', async () => {
    const user = userEvent.setup()
    fake.getRecentFiles.mockResolvedValue(['/docs/recent-one.pdf', 'C:\\work\\two.pdf'])
    render(<App />)
    expect(screen.getByTestId('welcome')).toBeInTheDocument()
    expect(await screen.findByText('recent-one.pdf')).toBeInTheDocument()
    expect(screen.getByText('two.pdf')).toBeInTheDocument()
    expect(screen.getByText(/drop a PDF/i)).toBeInTheDocument()

    await user.click(btn('welcome-open'))
    expect(fake.openPdfDialog).toHaveBeenCalled()

    await user.click(screen.getByText('recent-one.pdf'))
    expect(fake.readFile).toHaveBeenCalledWith('/docs/recent-one.pdf')
    await vi.waitFor(() => expect(screen.queryByTestId('welcome')).not.toBeInTheDocument())
  })

  it('creates a blank document', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(btn('welcome-new'))
    expect(core.createBlankDocument).toHaveBeenCalled()
    expect(await screen.findAllByTestId('page')).toHaveLength(1)
    expect(btn('page-count')).toHaveTextContent('1')
  })
})

describe('toolbar', () => {
  it('disables document actions without a document', () => {
    render(<App />)
    expect(btn('btn-open')).toBeEnabled()
    for (const id of ['btn-save', 'btn-save-as', 'btn-undo', 'btn-redo', 'btn-zoom-in', 'btn-zoom-out', 'btn-fit-width', 'btn-print', 'btn-find']) {
      expect(btn(id)).toBeDisabled()
    }
    expect(screen.queryByTestId('btn-rotate-cw')).not.toBeInTheDocument()
  })

  it('enables actions with a document and reflects undo/redo availability', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(3), { filePath: '/a.pdf', fileName: 'a.pdf' })
    render(<App />)
    for (const id of ['btn-save', 'btn-save-as', 'btn-zoom-in', 'btn-rotate-cw', 'btn-rotate-ccw', 'btn-delete-pages', 'btn-insert-blank', 'btn-insert-pages', 'btn-extract', 'btn-split', 'btn-properties', 'btn-watermark', 'btn-page-numbers', 'btn-security', 'btn-print', 'btn-find']) {
      expect(btn(id)).toBeEnabled()
    }
    expect(btn('btn-undo')).toBeDisabled()
    await user.click(btn('btn-rotate-cw'))
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p1'], 90)
    expect(btn('btn-undo')).toBeEnabled()
    expect(screen.getAllByTestId('page')[0]).toHaveAttribute('data-rotation', '90')
    await user.click(btn('btn-undo'))
    expect(screen.getAllByTestId('page')[0]).toHaveAttribute('data-rotation', '0')
    expect(btn('btn-redo')).toBeEnabled()
    await user.click(btn('btn-redo'))
    expect(screen.getAllByTestId('page')[0]).toHaveAttribute('data-rotation', '90')

    await user.click(btn('btn-rotate-ccw'))
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p1'], -90)
    await user.click(btn('btn-insert-blank'))
    expect(core.insertBlankPage).toHaveBeenLastCalledWith(expect.anything(), 1)
    expect(btn('page-count')).toHaveTextContent('4')
  })

  it('zoom buttons and label', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(1))
    editor().setZoom(1)
    render(<App />)
    expect(btn('zoom-level')).toHaveTextContent('100%')
    await user.click(btn('btn-zoom-in'))
    expect(btn('zoom-level')).toHaveTextContent('110%')
    await user.click(btn('btn-zoom-out'))
    await user.click(btn('btn-zoom-out'))
    expect(btn('zoom-level')).toHaveTextContent('90%')
    await user.click(btn('btn-fit-width'))
    expect(editor().fitMode).toBe('width')
    await user.click(btn('zoom-level'))
    await user.click(screen.getByTestId('menu-zoom-200'))
    expect(btn('zoom-level')).toHaveTextContent('200%')
    expect(editor().fitMode).toBeNull()
  })

  it('split needs two pages; delete with all pages asks first', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(1))
    render(<App />)
    expect(btn('btn-split')).toBeDisabled()
    await user.click(btn('btn-delete-pages'))
    const dialog = await screen.findByTestId('dialog')
    expect(dialog).toHaveAttribute('data-dialog', 'confirm')
    await user.click(within(dialog).getByTestId('dialog-confirm'))
    expect(btn('page-count')).toHaveTextContent('0')
    expect(screen.getByText('This document has no pages.')).toBeInTheDocument()
  })

  it('document buttons open their dialogs', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(2))
    render(<App />)
    for (const [id, kind] of [
      ['btn-properties', 'properties'],
      ['btn-watermark', 'watermark'],
      ['btn-page-numbers', 'page-numbers'],
      ['btn-security', 'security'],
      ['btn-extract', 'extract'],
      ['btn-split', 'split']
    ] as const) {
      await user.click(btn(id))
      expect(await screen.findByTestId('dialog')).toHaveAttribute('data-dialog', kind)
      await user.click(btn('dialog-cancel'))
      expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    }
  })

  it('find button toggles the find bar', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(2))
    render(<App />)
    await user.click(btn('btn-find'))
    const bar = screen.getByTestId('dialog')
    expect(bar).toHaveAttribute('data-dialog', 'find')
    await user.type(within(bar).getByTestId('find-input'), 'hello{Enter}')
    await vi.waitFor(() => expect(within(bar).getByTestId('find-count')).toHaveTextContent('1 of 2'))
    expect(fakePage.getTextContent).toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
  })
})

describe('viewer', () => {
  it('renders every page with the documented attributes and an overlay', async () => {
    const doc = makeDoc(3)
    doc.pages[1] = makePage('p2', 'src1', 1, { rotation: 90 })
    doc.pages[2] = { id: 'blank', source: { kind: 'blank' }, width: 600, height: 800, baseRotation: 0, rotation: 0 }
    loadDoc(doc)
    editor().setZoom(1)
    render(<App />)
    const pages = screen.getAllByTestId('page')
    expect(pages).toHaveLength(3)
    expect(pages[1]).toHaveAttribute('data-page-id', 'p2')
    expect(pages[1]).toHaveAttribute('data-page-index', '1')
    expect(pages[1]).toHaveAttribute('data-rotation', '90')
    expect(pages[1].style.position).toBe('relative')
    // Rotated page: width/height swapped.
    expect(pages[1].style.width).toBe(`${800 * CSS_PX_PER_PT}px`)
    expect(pages[1].style.height).toBe(`${600 * CSS_PX_PER_PT}px`)
    expect(screen.getAllByTestId('page-overlay')).toHaveLength(3)
    expect(within(pages[2]).queryByRole('img', { hidden: true })).toBeNull()
    expect(pages[2].querySelector('canvas')).toBeNull()
    // pdf.js renders the source pages with the display rotation and forms excluded.
    await vi.waitFor(() => expect(renderCalls.length).toBeGreaterThanOrEqual(2))
    expect(renderCalls.map((c) => c.rotation).sort()).toEqual([0, 90])
    expect(renderCalls.every((c) => c.annotationMode === 2)).toBe(true)
    expect(screen.getByTestId('viewer')).toBeInTheDocument()
    expect(btn('current-page')).toHaveTextContent('1')
    expect(btn('page-count')).toHaveTextContent('3')
  })

  it('re-renders pages when the zoom changes', async () => {
    loadDoc(makeDoc(1))
    editor().setZoom(1)
    render(<App />)
    await vi.waitFor(() => expect(renderCalls).toHaveLength(1))
    act(() => editor().setZoom(2))
    await vi.waitFor(() => expect(renderCalls).toHaveLength(2), { timeout: 2000 })
    expect(renderCalls[1].scale).toBeCloseTo(2 * CSS_PX_PER_PT * (window.devicePixelRatio || 1))
  })

  it('previews watermark and page numbers on the pages', () => {
    const doc = makeDoc(2)
    doc.settings.watermark = { text: 'DRAFT', fontSize: 40, color: '#ff0000', opacity: 0.5, angle: 45 }
    doc.settings.pageNumbers = { format: 'Page {n} of {total}', position: 'bottom-center', fontSize: 10, color: '#000000', startAt: 1, margin: 24 }
    loadDoc(doc)
    render(<App />)
    expect(screen.getAllByTestId('watermark-preview')).toHaveLength(2)
    expect(screen.getAllByTestId('page-number-preview').map((e) => e.textContent)).toEqual(['Page 1 of 2', 'Page 2 of 2'])
  })

  it('computes fit zoom from the container size', () => {
    const pages = [{ width: 600, height: 800 }, { width: 800, height: 600 }]
    const w = computeFitZoom('width', { width: 800 * CSS_PX_PER_PT + 48, height: 500 }, pages, 0)
    expect(w).toBeCloseTo(1, 2)
    const p = computeFitZoom('page', { width: 2000, height: 400 * CSS_PX_PER_PT + 48 }, pages, 0)
    expect(p).toBeCloseTo(0.5, 2)
    expect(computeFitZoom('width', { width: 0, height: 0 }, pages, 0)).toBeNull()
  })
})

describe('thumbnails sidebar', () => {
  it('computes click / shift / toggle selection', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(nextSelection(ids, [], null, 'b', { shift: false, toggle: false })).toEqual({ selected: ['b'], anchor: 'b' })
    expect(nextSelection(ids, ['b'], 'b', 'd', { shift: true, toggle: false }).selected).toEqual(['b', 'c', 'd'])
    expect(nextSelection(ids, ['b'], 'b', 'a', { shift: true, toggle: false }).selected).toEqual(['a', 'b'])
    expect(nextSelection(ids, ['b'], 'b', 'd', { shift: false, toggle: true }).selected).toEqual(['b', 'd'])
    expect(nextSelection(ids, ['b', 'd'], 'd', 'b', { shift: false, toggle: true }).selected).toEqual(['d'])
  })

  it('selects pages with click, shift-click and ctrl/cmd-click and scrolls to them', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(5))
    render(<App />)
    const sidebar = screen.getByTestId('sidebar')
    const thumbs = () => within(sidebar).getAllByTestId('thumbnail')
    expect(thumbs()).toHaveLength(5)
    expect(thumbs()[0]).toHaveAttribute('data-page-index', '0')

    await user.click(thumbs()[1])
    expect(thumbs()[1]).toHaveAttribute('data-selected', 'true')
    expect(editor().currentPageId).toBe('p2')
    expect(editor().scrollRequest?.pageId).toBe('p2')

    await user.keyboard('{Shift>}')
    await user.click(thumbs()[3])
    await user.keyboard('{/Shift}')
    expect(thumbs().map((t) => t.getAttribute('data-selected'))).toEqual(['false', 'true', 'true', 'true', 'false'])

    fireEvent.click(thumbs()[2], { metaKey: true, ctrlKey: true })
    expect(editor().selectedPageIds.sort()).toEqual(['p2', 'p4'])

    // Page ops act on the selection.
    await user.click(btn('btn-rotate-cw'))
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p2', 'p4'], 90)
  })

  it('reorders pages by drag & drop', () => {
    loadDoc(makeDoc(3))
    render(<App />)
    const thumbs = screen.getAllByTestId('thumbnail')
    const store: Record<string, string> = {}
    const dataTransfer = {
      types: [PAGE_DRAG_TYPE],
      setData: (t: string, v: string) => (store[t] = v),
      getData: (t: string) => store[t],
      effectAllowed: 'all',
      dropEffect: 'none',
      files: [] as unknown as FileList
    }
    // Drag page 3 into the upper half of page 1 → before page 1.
    fireEvent.dragStart(thumbs[2], { dataTransfer })
    vi.spyOn(thumbs[0], 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100, bottom: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) })
    const at = (type: 'dragOver' | 'drop', el: HTMLElement, clientY: number) => {
      const ev = createEvent[type](el, { dataTransfer })
      Object.defineProperty(ev, 'clientY', { value: clientY })
      fireEvent(el, ev)
    }
    at('dragOver', thumbs[0], 10)
    expect(thumbs[0].className).toContain('drop-before')
    at('drop', thumbs[0], 10)
    expect(core.movePages).toHaveBeenLastCalledWith(expect.anything(), ['p3'], 0)
    expect(screen.getAllByTestId('thumbnail').map((t) => t.getAttribute('data-page-id'))).toEqual(['p3', 'p1', 'p2'])
    expect(screen.getAllByTestId('page').map((t) => t.getAttribute('data-page-id'))).toEqual(['p3', 'p1', 'p2'])
  })

  it('context menu offers page operations', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(3))
    render(<App />)
    fireEvent.contextMenu(screen.getAllByTestId('thumbnail')[1])
    expect(editor().selectedPageIds).toEqual(['p2'])
    const menu = await screen.findByTestId('page-context-menu')
    await user.click(within(menu).getByTestId('menu-duplicate'))
    expect(core.duplicatePages).toHaveBeenCalledWith(expect.anything(), ['p2'])
    fireEvent.contextMenu(screen.getAllByTestId('thumbnail')[0])
    await user.click(within(await screen.findByTestId('page-context-menu')).getByTestId('menu-insert-before'))
    expect(core.insertBlankPage).toHaveBeenLastCalledWith(expect.anything(), 0)
    fireEvent.contextMenu(screen.getAllByTestId('thumbnail')[0])
    await user.click(within(await screen.findByTestId('page-context-menu')).getByTestId('menu-extract'))
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('extract'))
  })

  it('deletes selected pages with the Delete key', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(3))
    render(<App />)
    await user.click(screen.getAllByTestId('thumbnail')[0])
    await user.keyboard('{Delete}')
    expect(core.deletePages).toHaveBeenCalledWith(expect.anything(), ['p1'])
    expect(btn('page-count')).toHaveTextContent('2')
  })

  it('can be hidden', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(1))
    render(<App />)
    await user.click(btn('btn-toggle-sidebar'))
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
  })
})

describe('notices', () => {
  it('shows info and error notices with their kind', () => {
    render(<App />)
    act(() => editor().showNotice('error', 'Something failed'))
    expect(btn('notice')).toHaveAttribute('data-kind', 'error')
    expect(btn('notice')).toHaveTextContent('Something failed')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('notice')).not.toBeInTheDocument()
  })
})
