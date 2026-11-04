/**
 * Editing existing content, annotations and fields against the real engine (no @core mocks).
 * Export round-trips are not run here: in jsdom, pdf-lib rejects Uint8Arrays from Node's realm.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEffectiveFormFields, getPageAnnotations, openDocument, type ContentItem } from '@core'
import { loadContentItems } from '@renderer/editing/contentItems'
import { activateTool } from '@renderer/editing/tools'
import { makeAnnotatedPdf, makeFormPdf, makeTextPdf } from '../../fixtures/pdfs'
import { click, doc, drag, loadDoc, mockLayout, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

beforeEach(() => mockLayout())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

describe('real engine', () => {
  it('moves, retypes and deletes existing text', async () => {
    const user = userEvent.setup()
    const d = await openDocument(await makeTextPdf(1), 'text.pdf')
    loadDoc(d)
    renderPage()
    setTool('edit-content')
    const els = await screen.findAllByTestId('content-item', {}, { timeout: 10000 })
    const items: ContentItem[] = await loadContentItems(doc(), doc().pages[0])
    const title = items.find((i) => i.kind === 'text' && i.text?.includes('Page 1'))!
    expect(title).toBeTruthy()
    expect(els.length).toBe(items.length)
    const el = els.find((e) => e.dataset.contentId === title.id)!
    const c = center(title.bounds)
    drag(el, c, { x: c.x + 50, y: c.y + 30 })
    const edit = () => doc().contentEdits?.[doc().pages[0].id]?.find((e) => e.itemId === title.id)
    expect(edit()?.transform).toEqual([1, 0, 0, 1, 50, 30])

    fireEvent.doubleClick(el)
    const editor = screen.getByTestId('content-text-editor')
    await user.clear(editor)
    await user.type(editor, 'Chapter 1{Enter}')
    expect(edit()).toMatchObject({ text: 'Chapter 1', transform: [1, 0, 0, 1, 50, 30] })

    const body = items.find((i) => i.kind === 'text' && i.text?.includes('Lorem'))!
    click(els.find((e) => e.dataset.contentId === body.id)!, center(body.bounds))
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(doc().contentEdits?.[doc().pages[0].id]?.find((e) => e.itemId === body.id)?.deleted).toBe(true)
    expect(store().past).toHaveLength(3)
  })

  it('moves and deletes existing annotations', async () => {
    const d = await openDocument(await makeAnnotatedPdf(), 'annotated.pdf')
    loadDoc(d)
    renderPage()
    const annots = getPageAnnotations(doc(), doc().pages[0].id)
    expect(annots.length).toBeGreaterThanOrEqual(2)
    const el = screen.getAllByTestId('annotation')[0]
    const a = annots.find((x) => x.id === el.dataset.annotId)!
    const c = center(a.bounds)
    drag(el, c, { x: c.x + 10, y: c.y + 20 })
    const moved = getPageAnnotations(doc(), doc().pages[0].id).find((x) => x.id === a.id)!
    expect(moved.bounds.x).toBeCloseTo(a.bounds.x + 10)
    expect(moved.bounds.y).toBeCloseTo(a.bounds.y + 20)
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(getPageAnnotations(doc(), doc().pages[0].id).some((x) => x.id === a.id)).toBe(false)
  })

  it('renames fields of a real form and adds new ones', async () => {
    const user = userEvent.setup()
    const d = await openDocument(await makeFormPdf(), 'form.pdf')
    loadDoc(d)
    renderPage({ panel: true })
    setTool('form-design')
    const sourceId = doc().primarySourceId!
    const box = screen.getAllByTestId('field-box').find((b) => b.dataset.originalName === 'name')!
    click(box, { x: parseFloat(box.style.left) + 5, y: parseFloat(box.style.top) + 5 })
    const input = screen.getByTestId('prop-field-name')
    await user.clear(input)
    await user.type(input, 'email{Enter}')
    expect(screen.getByTestId('prop-field-name-error')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'fullName{Enter}')
    expect(getEffectiveFormFields(doc(), sourceId).map((f) => f.name)).toContain('fullName')

    act(() => activateTool('field-checkbox'))
    click(screen.getByTestId('page-overlay'), { x: 450, y: 700 })
    const obj = doc().objects[0]
    expect(obj).toMatchObject({ type: 'field', fieldType: 'checkbox', name: 'Check1' })
    // Fill mode: the renamed field shows its new name; values stay keyed by the original.
    setTool('select')
    const filled = screen.getAllByTestId('form-field').find((e) => e.dataset.fieldName === 'fullName')!
    await user.type(filled, 'Ada')
    expect(doc().formValues[sourceId]?.name).toBe('Ada')
  })
})
