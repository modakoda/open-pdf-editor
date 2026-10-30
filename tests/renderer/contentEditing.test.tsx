/**
 * Workspace side of editing existing content: page previews, the ope:page-rendered event,
 * the Fields sidebar tab, delete-selection routing and the selection status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)
vi.mock('@renderer/editing', async () => (await import('./support/fakeEditing')).editingModule)
const thumbs = vi.hoisted(() => ({
  getThumbnailUrl: vi.fn(async () => 'blob:source'),
  getPreviewThumbnailUrl: vi.fn(async (_pageId: string, _key: string, load: () => Promise<unknown>) => {
    await load()
    return 'blob:preview'
  }),
  releaseThumbnails: vi.fn()
}))
vi.mock('@renderer/pdf/thumbnails', () => thumbs)

import type { ContentEdit, EditorDocument, FieldObject, FormFieldInfo } from '@core'
import { App } from '@renderer/App'
import { resetCommandState, runCommand } from '@renderer/actions/commands'
import { runFind } from '@renderer/actions/find'
import { collectFields, fieldNamesClash, summarizeValue, validateFieldName } from '@renderer/components/sidebar/FieldsPanel'
import { PAGE_RENDERED_EVENT } from '@renderer/components/viewer/PageView'
import { previewKeyFor, releasePreviews } from '@renderer/pdf/previews'
import { selectionLabel } from '@renderer/state/selectors'
import { useFind } from '@renderer/state/find'
import { useEditor } from '@renderer/state/store'
import { coreOverrides as core, makeDoc, resetFakeCore } from './support/fakeCore'
import { deleteSelectionSpy } from './support/fakeEditing'
import { fakePage, fakePreviewPage, openedTasks, renderCalls } from './support/fakePdfjs'
import { resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

const move = (dx: number): ContentEdit => ({ itemId: 'c1', transform: [1, 0, 0, 1, dx, 0] })

function withContentEdits(doc: EditorDocument, pageId: string, edits: ContentEdit[]): EditorDocument {
  return { ...doc, contentEdits: { ...doc.contentEdits, [pageId]: edits } }
}

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
  resetCommandState()
  releasePreviews()
  renderCalls.length = 0
  openedTasks.length = 0
  deleteSelectionSpy.mockClear()
  thumbs.getThumbnailUrl.mockClear()
  thumbs.getPreviewThumbnailUrl.mockClear()
})
afterEach(() => cleanup())

describe('page previews', () => {
  it('fingerprints only pages that need a preview', () => {
    const doc = withContentEdits(makeDoc(2), 'p2', [move(5)])
    expect(previewKeyFor(doc, doc.pages[0])).toBeNull()
    const key = previewKeyFor(doc, doc.pages[1])
    expect(key).toEqual(expect.any(String))
    expect(previewKeyFor(withContentEdits(doc, 'p2', [move(5)]), doc.pages[1])).toBe(key)
    expect(previewKeyFor(withContentEdits(doc, 'p2', [move(6)]), doc.pages[1])).not.toBe(key)
    const annotated = { ...makeDoc(1), annotationEdits: { p1: [{ annotId: 'a1', deleted: true }] } }
    expect(previewKeyFor(annotated, annotated.pages[0])).not.toBeNull()
    const restored = makeDoc(1)
    restored.sources.src1 = { ...restored.sources.src1, pageInfo: [{ width: 600, height: 800, rotation: 0, restoredObjectIds: ['o1'] }] }
    expect(previewKeyFor(restored, restored.pages[0])).not.toBeNull()
  })

  it('includes widget moves / deletions of this page in the fingerprint', () => {
    const base = formDoc() // fields "name"/"email" on source page 0, "agree" on page 1
    const withField = (edits: NonNullable<EditorDocument['fieldEdits']>['string']): EditorDocument => ({
      ...base,
      fieldEdits: { src1: edits }
    })
    const box = (y: number) => ({ x: 50, y, width: 100, height: 20 })
    const moved1 = withField({ name: { widgetBoxes: [box(150)] } })
    const moved2 = withField({ name: { widgetBoxes: [box(300)] } })
    const k1 = previewKeyFor(moved1, moved1.pages[0])
    const k2 = previewKeyFor(moved2, moved2.pages[0])
    expect(k1).not.toBeNull()
    expect(k2).not.toBeNull()
    expect(k2).not.toBe(k1)
    // Further edits after the first one also change the key (deleting the widget, the field).
    const removed = withField({ name: { widgetBoxes: [box(300)], deletedWidgets: [0] } })
    expect(previewKeyFor(removed, removed.pages[0])).not.toBe(k2)
    const deleted = withField({ name: { widgetBoxes: [box(300)], deleted: true } })
    expect(previewKeyFor(deleted, deleted.pages[0])).not.toBe(k2)
    // Edits of a field on another page do not change this page's key.
    const other = withField({ name: { widgetBoxes: [box(300)] }, agree: { widgetBoxes: [box(10)] } })
    expect(previewKeyFor(other, other.pages[0])).toBe(k2)
    // Renames / option changes do not affect the painted page.
    const renamed = withField({ name: { widgetBoxes: [box(300)], name: 'full' } })
    expect(previewKeyFor(renamed, renamed.pages[0])).toBe(k2)
  })

  it('renders edited pages from renderPagePreview and the others from their source', async () => {
    const doc = withContentEdits(makeDoc(3), 'p2', [move(5)])
    loadDoc(doc)
    render(<App />)
    await vi.waitFor(() => expect(renderCalls).toHaveLength(3))
    expect(core.renderPagePreview).toHaveBeenCalledTimes(1)
    expect(core.renderPagePreview).toHaveBeenCalledWith(doc, 'p2')
    expect(new TextDecoder().decode(openedTasks[0].bytes)).toBe('preview:p2')
    expect(renderCalls.filter((c) => c.preview)).toHaveLength(1)
    expect(fakePreviewPage.render).toHaveBeenCalledTimes(1)
    expect(renderCalls.every((c) => c.annotationMode === 2)).toBe(true)
  })

  it('re-renders after the page edits change, freeing the old preview', async () => {
    loadDoc(withContentEdits(makeDoc(1), 'p1', [move(5)]))
    render(<App />)
    await vi.waitFor(() => expect(fakePreviewPage.render).toHaveBeenCalledTimes(1))
    const pageEl = screen.getByTestId('page')
    const rendered = vi.fn()
    pageEl.addEventListener(PAGE_RENDERED_EVENT, (e) => rendered((e as CustomEvent).detail))

    act(() => editor().apply((d) => withContentEdits(d, 'p1', [move(9)])))
    // Debounced: nothing happens immediately.
    expect(core.renderPagePreview).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(core.renderPagePreview).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledWith({ pageId: 'p1' }))
    expect(openedTasks[0].destroy).toHaveBeenCalled()

    // Undo back to the first state renders that state again.
    act(() => editor().undo())
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(2))
    expect(core.renderPagePreview).toHaveBeenCalledTimes(3)

    // Removing all edits goes back to the source page.
    fakePage.render.mockClear()
    act(() => editor().apply((d) => withContentEdits(d, 'p1', [])))
    await vi.waitFor(() => expect(fakePage.render).toHaveBeenCalledTimes(1))
  })

  it('falls back to the source page and shows a notice once', async () => {
    core.renderPagePreview.mockRejectedValue(new Error('engine not ready'))
    const doc = withContentEdits(withContentEdits(makeDoc(2), 'p1', [move(1)]), 'p2', [move(2)])
    loadDoc(doc)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let notices = 0
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.notice && s.notice !== prev.notice) notices++
    })
    render(<App />)
    await vi.waitFor(() => expect(fakePage.render).toHaveBeenCalledTimes(2))
    unsubscribe()
    expect(core.renderPagePreview).toHaveBeenCalledTimes(2)
    expect(renderCalls.filter((c) => c.preview)).toHaveLength(0)
    expect(screen.getByTestId('notice')).toHaveAttribute('data-kind', 'error')
    expect(notices).toBe(1)
    expect(screen.queryByText('This page could not be displayed')).not.toBeInTheDocument()
  })

  it('dispatches ope:page-rendered after every completed render', async () => {
    const seen: string[] = []
    const onRendered = (e: Event) => seen.push((e as CustomEvent<{ pageId: string }>).detail.pageId)
    document.addEventListener(PAGE_RENDERED_EVENT, onRendered)
    loadDoc(withContentEdits(makeDoc(2), 'p2', [move(3)]))
    editor().setZoom(1)
    render(<App />)
    await vi.waitFor(() => expect(seen.sort()).toEqual(['p1', 'p2']))
    act(() => editor().setZoom(2))
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    document.removeEventListener(PAGE_RENDERED_EVENT, onRendered)
  })

  it('thumbnails of edited pages come from the preview', async () => {
    loadDoc(withContentEdits(makeDoc(2), 'p2', [move(3)]))
    render(<App />)
    await vi.waitFor(() => expect(thumbs.getPreviewThumbnailUrl).toHaveBeenCalled())
    expect(thumbs.getPreviewThumbnailUrl.mock.calls[0][0]).toBe('p2')
    expect(thumbs.getThumbnailUrl).toHaveBeenCalledTimes(1)
  })

  it('find searches the preview text of edited pages', async () => {
    loadDoc(withContentEdits(makeDoc(2), 'p2', [move(3)]))
    await runFind('edited')
    expect(useFind.getState().matches.map((m) => m.pageId)).toEqual(['p2'])
    await runFind('hello')
    expect(useFind.getState().matches.map((m) => m.pageId)).toEqual(['p1'])
  })
})

// ---------------------------------------------------------------------------------------------

function field(name: string, type: FormFieldInfo['type'], pageIndex: number, y: number, value: FormFieldInfo['value']): FormFieldInfo {
  return { name, type, value, readOnly: false, widgets: [{ pageIndex, box: { x: 50, y, width: 100, height: 20 } }] }
}

function fieldObject(id: string, name: string, extra: Partial<FieldObject> = {}): FieldObject {
  return { id, pageId: 'p2', type: 'field', fieldType: 'text', name, x: 10, y: 300, width: 80, height: 20, ...extra }
}

function formDoc(): EditorDocument {
  const doc = makeDoc(2)
  doc.sources.src1 = {
    ...doc.sources.src1,
    formFields: [field('email', 'text', 0, 200, 'a@b.c'), field('name', 'text', 0, 100, ''), field('agree', 'checkbox', 1, 50, true)]
  }
  doc.objects = [
    fieldObject('f1', 'notes', { value: 'Hello there' }),
    fieldObject('r1', 'color', { fieldType: 'radio', exportValue: 'red', y: 400 }),
    fieldObject('r2', 'color', { fieldType: 'radio', exportValue: 'blue', y: 420, value: 'blue' })
  ]
  return doc
}

describe('fields tab', () => {
  it('collects existing fields and FieldObjects in page order with value summaries', () => {
    const doc = formDoc()
    const entries = collectFields(doc)
    expect(entries.map((e) => [e.name, e.pageIndex + 1, e.origin])).toEqual([
      ['name', 1, 'existing'],
      ['email', 1, 'existing'],
      ['agree', 2, 'existing'],
      ['notes', 2, 'new'],
      ['color', 2, 'new']
    ])
    expect(entries.map(summarizeValue)).toEqual(['Empty', '“a@b.c”', 'Checked', '“Hello there”', 'blue'])
    expect(entries[4].widgetCount).toBe(2)
    expect(validateFieldName(doc, entries[0], 'email')).toMatch(/already exists/)
    expect(validateFieldName(doc, entries[0], 'notes')).toMatch(/already exists/) // a FieldObject
    expect(validateFieldName(doc, entries[0], '  ')).toMatch(/Enter/)
    expect(validateFieldName(doc, entries[0], 'a..b')).toMatch(/“\.\.”/)
    expect(validateFieldName(doc, entries[0], 'name')).toBeNull()
    expect(validateFieldName(doc, entries[0], 'person.first')).toBeNull()
    // Radio buttons of the group being renamed do not clash with each other.
    expect(validateFieldName(doc, entries[4], 'colour')).toBeNull()
  })

  it('rejects names that are a dotted prefix of another field (or the other way round)', () => {
    const doc = formDoc()
    doc.sources.src1 = { ...doc.sources.src1, formFields: [...doc.sources.src1.formFields, field('person.first', 'text', 0, 500, '')] }
    const entries = collectFields(doc)
    const name = entries.find((e) => e.name === 'name')!
    expect(fieldNamesClash('a', 'a.b')).toBe(true)
    expect(fieldNamesClash('a.b', 'a')).toBe(true)
    expect(fieldNamesClash('a', 'ab')).toBe(false)
    expect(validateFieldName(doc, name, 'person')).toMatch(/conflicts with the field “person\.first”/)
    expect(validateFieldName(doc, name, 'person.first.middle')).toMatch(/conflicts/)
    expect(validateFieldName(doc, name, 'email.work')).toMatch(/conflicts with the field “email”/)
    expect(validateFieldName(doc, name, 'notes.extra')).toMatch(/conflicts/)
    expect(validateFieldName(doc, name, 'personal')).toBeNull()
    // Hidden fields (pages not in the document) still reserve their names.
    doc.sources.src1.formFields.push(field('hidden', 'text', 7, 0, ''))
    expect(validateFieldName(doc, name, 'hidden')).toMatch(/already exists/)
  })

  it('lists fields with type, page and value; clicking selects and scrolls to it', async () => {
    const user = userEvent.setup()
    loadDoc(formDoc())
    render(<App />)
    await user.click(screen.getByTestId('sidebar-tab-fields'))
    const panel = screen.getByTestId('fields-panel')
    const rows = within(panel).getAllByTestId('field-row')
    expect(rows.map((r) => r.getAttribute('data-field-name'))).toEqual(['name', 'email', 'agree', 'notes', 'color'])
    expect(rows[1]).toHaveTextContent('p. 1')
    expect(rows[2]).toHaveTextContent('p. 2')
    expect(rows[1]).toHaveTextContent('a@b.c')
    expect(screen.getByTestId('sidebar-tab-fields')).toHaveTextContent('5')

    await user.click(within(rows[2]).getByTitle(/Checkbox/))
    expect(editor().tool).toBe('form-design')
    expect(editor().selectedElement).toEqual({ kind: 'field', sourceId: 'src1', fieldName: 'agree', widgetIndex: 0, pageId: 'p2' })
    expect(editor().scrollRequest).toMatchObject({ pageId: 'p2', point: { x: 100, y: 60 } })
    expect(within(panel).getAllByTestId('field-row')[2]).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('selection-status')).toHaveTextContent('Field “agree” selected')

    await user.click(within(within(panel).getAllByTestId('field-row')[4]).getByTitle(/Radio/))
    expect(editor().selectedObjectId).toBe('r1')
    expect(editor().selectedElement).toBeNull()
  })

  it('renames existing fields with validation (undoable)', async () => {
    const user = userEvent.setup()
    loadDoc(formDoc())
    render(<App />)
    await user.click(screen.getByTestId('sidebar-tab-fields'))
    const row = () => screen.getAllByTestId('field-row')[0]
    await user.click(within(row()).getByTestId('field-rename'))
    const input = screen.getByTestId('field-name-input')
    await user.clear(input)
    await user.type(input, 'email{Enter}')
    expect(screen.getByTestId('field-rename-error')).toHaveTextContent('already exists')
    expect(editor().doc?.fieldEdits).toBeUndefined()

    await user.clear(input)
    await user.type(input, 'fullName{Enter}')
    expect(editor().doc?.fieldEdits?.src1?.name).toEqual({ name: 'fullName' })
    expect(screen.getAllByTestId('field-row').map((r) => r.getAttribute('data-field-name'))).toContain('fullName')
    act(() => editor().undo())
    expect(screen.getAllByTestId('field-row')[0]).toHaveAttribute('data-field-name', 'name')

    // Escape cancels.
    await user.click(within(row()).getByTestId('field-rename'))
    await user.type(screen.getByTestId('field-name-input'), 'xyz{Escape}')
    expect(screen.queryByTestId('field-name-input')).not.toBeInTheDocument()
    expect(editor().past).toHaveLength(0)
  })

  it('renames and deletes new FieldObjects (radio groups as a whole)', async () => {
    const user = userEvent.setup()
    loadDoc(formDoc())
    render(<App />)
    await user.click(screen.getByTestId('sidebar-tab-fields'))
    const colorRow = () => screen.getAllByTestId('field-row').find((r) => r.dataset.fieldName === 'color' || r.dataset.fieldName === 'colour')!
    await user.click(within(colorRow()).getByTestId('field-rename'))
    const input = screen.getByTestId('field-name-input')
    await user.clear(input)
    await user.type(input, 'colour{Enter}')
    expect(editor().doc?.objects.filter((o) => o.type === 'field' && o.name === 'colour').map((o) => o.id)).toEqual(['r1', 'r2'])

    await user.click(within(colorRow()).getByTestId('field-delete'))
    expect(editor().doc?.objects.map((o) => o.id)).toEqual(['f1'])
    expect(core.removeObject).toHaveBeenCalledTimes(2)
  })

  it('deletes existing fields and clears their selection', async () => {
    const user = userEvent.setup()
    loadDoc(formDoc())
    render(<App />)
    await user.click(screen.getByTestId('sidebar-tab-fields'))
    const agree = screen.getAllByTestId('field-row')[2]
    await user.click(within(agree).getByTitle(/Checkbox/))
    expect(editor().selectedElement).not.toBeNull()
    await user.click(within(screen.getAllByTestId('field-row')[2]).getByTestId('field-delete'))
    expect(editor().doc?.fieldEdits?.src1?.agree).toEqual({ deleted: true })
    expect(screen.getAllByTestId('field-row').map((r) => r.dataset.fieldName)).not.toContain('agree')
    expect(editor().selectedElement).toBeNull()
  })

  it('shows an empty state and switches to the field list in Prepare form mode', async () => {
    const user = userEvent.setup()
    loadDoc(makeDoc(1))
    render(<App />)
    await user.click(screen.getByTestId('sidebar-tab-fields'))
    expect(screen.getByTestId('fields-empty')).toHaveTextContent('No form fields')
    await user.click(within(screen.getByTestId('fields-empty')).getByRole('button', { name: 'Prepare form' }))
    expect(editor().tool).toBe('form-design')

    await user.click(screen.getByTestId('sidebar-tab-pages'))
    expect(screen.getAllByTestId('thumbnail')).toHaveLength(1)
    act(() => editor().setTool('select'))
    act(() => editor().setTool('field-text'))
    expect(screen.getByTestId('fields-panel')).toBeInTheDocument()
  })
})

describe('delete-selection routing', () => {
  it('sends selected objects and existing elements to the editing layer deleteSelection()', async () => {
    loadDoc(makeDoc(2, [{ id: 'o1', pageId: 'p1', type: 'note', x: 1, y: 1, text: 'hi', color: '#ffcc00' }]))
    editor().setSelectedPages(['p2'])
    editor().selectObject('o1')
    runCommand('delete-selection', 'menu')
    await vi.waitFor(() => expect(deleteSelectionSpy).toHaveBeenCalledTimes(1))

    for (const ref of [
      { kind: 'content' as const, pageId: 'p1', itemId: 'c1' },
      { kind: 'annotation' as const, pageId: 'p2', annotId: 'a1' },
      { kind: 'field' as const, sourceId: 'src1', fieldName: 'f', widgetIndex: 0, pageId: 'p1' }
    ]) {
      resetCommandState()
      editor().selectElement(ref)
      runCommand('delete-selection', 'menu')
    }
    await vi.waitFor(() => expect(deleteSelectionSpy).toHaveBeenCalledTimes(4))
    // The page selection was not touched by object / element deletion.
    expect(core.deletePages).not.toHaveBeenCalled()
  })

  it('deletes the selected pages when no object or element is selected', async () => {
    loadDoc(makeDoc(3))
    editor().setSelectedPages(['p2'])
    runCommand('delete-selection', 'menu')
    await vi.waitFor(() => expect(core.deletePages).toHaveBeenCalledWith(expect.anything(), ['p2']))
    expect(deleteSelectionSpy).not.toHaveBeenCalled()
  })

  it('reports errors from the editing layer as a notice', async () => {
    deleteSelectionSpy.mockImplementationOnce(() => {
      throw new Error('cannot delete')
    })
    loadDoc(makeDoc(1))
    editor().selectElement({ kind: 'content', pageId: 'p1', itemId: 'c1' })
    runCommand('delete-selection', 'menu')
    await vi.waitFor(() => expect(editor().notice?.text).toContain('cannot delete'))
  })

  it('describes the selection for the status bar', () => {
    const doc = makeDoc(1, [{ id: 't1', pageId: 'p1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'x', font: 'sans', bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.2, rotation: 0 }])
    doc.sources.src1 = { ...doc.sources.src1, pageInfo: [{ width: 600, height: 800, rotation: 0, annotations: [{ id: 'a1', subtype: 'Text', bounds: { x: 0, y: 0, width: 1, height: 1 } }] }] }
    expect(selectionLabel({ doc, selectedObjectId: 't1', selectedElement: null })).toBe('Text selected')
    expect(selectionLabel({ doc, selectedObjectId: null, selectedElement: { kind: 'annotation', pageId: 'p1', annotId: 'a1' } })).toBe('Comment selected')
    expect(selectionLabel({ doc, selectedObjectId: null, selectedElement: { kind: 'content', pageId: 'p1', itemId: 'c' } })).toBe('Page content selected')
    expect(selectionLabel({ doc, selectedObjectId: null, selectedElement: null })).toBeNull()
  })
})
