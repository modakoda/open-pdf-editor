import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorDocument } from '@core'
import { canRedo, canUndo, useEditor, ZOOM_MAX, ZOOM_MIN } from '@renderer/state/store'
import { documentTitle, effectiveMetadata, formatWindowTitle, getTargetPageIds, windowTitle } from '@renderer/state/selectors'
import { makeDoc } from './support/fakeCore'
import { editor, loadDoc, resetStores } from './support/editor'

const withTitle = (title: string) => (d: EditorDocument): EditorDocument => ({
  ...d,
  settings: { ...d.settings, metadata: { ...d.settings.metadata, title } }
})
const dropPage = (id: string) => (d: EditorDocument): EditorDocument => ({ ...d, pages: d.pages.filter((p) => p.id !== id) })

describe('editor store', () => {
  beforeEach(() => resetStores())
  afterEach(() => vi.useRealTimers())

  it('shows important notices after the current one, and again after a newer one replaced them', () => {
    const text = () => editor().notice?.text
    editor().showNotice('info', 'Marked 2 areas for redaction.')
    editor().showNotice('info', 'Saving removes the signatures.', undefined, { important: true })
    expect(text()).toBe('Marked 2 areas for redaction.')
    editor().clearNotice()
    expect(text()).toBe('Saving removes the signatures.')
    expect(editor().notice?.important).toBe(true)
    editor().showNotice('info', 'Recognized text on 1 page.')
    expect(text()).toBe('Recognized text on 1 page.')
    editor().clearNotice()
    expect(text()).toBe('Saving removes the signatures.')
    editor().clearNotice()
    expect(editor().notice).toBeNull()
    // Plain notices still replace each other; a new document drops waiting ones.
    editor().showNotice('info', 'a')
    editor().showNotice('info', 'b')
    expect(text()).toBe('b')
    editor().showNotice('info', 'later', undefined, { important: true })
    loadDoc(makeDoc(1))
    editor().clearNotice()
    expect(editor().notice).toBeNull()
  })

  it('setDocument resets history, selection and view state', () => {
    loadDoc(makeDoc(3), { filePath: '/a.pdf', fileName: 'a.pdf' })
    editor().apply(withTitle('x'))
    editor().setSelectedPages(['p2'])
    editor().setZoom(2)
    loadDoc(makeDoc(2), { fileName: 'b.pdf' })
    const s = editor()
    expect(s.past).toHaveLength(0)
    expect(s.future).toHaveLength(0)
    expect(s.dirty).toBe(false)
    expect(s.selectedPageIds).toEqual([])
    expect(s.currentPageId).toBe('p1')
    expect(s.zoom).toBe(1)
    expect(s.fitMode).toBe('width')
    expect(s.fileName).toBe('b.pdf')
    expect(s.filePath).toBeNull()
  })

  it('apply records undo history and marks dirty; undo/redo restore snapshots', () => {
    const doc = makeDoc(3)
    loadDoc(doc)
    editor().apply(withTitle('one'))
    const afterOne = editor().doc
    editor().apply(withTitle('two'))
    expect(editor().dirty).toBe(true)
    expect(canUndo(editor())).toBe(true)
    expect(canRedo(editor())).toBe(false)

    editor().undo()
    expect(editor().doc).toBe(afterOne)
    expect(canRedo(editor())).toBe(true)
    editor().undo()
    expect(editor().doc).toBe(doc)
    // Back at the saved state: not dirty any more.
    expect(editor().dirty).toBe(false)
    editor().undo() // no-op
    expect(editor().doc).toBe(doc)

    editor().redo()
    expect(editor().doc).toBe(afterOne)
    expect(editor().dirty).toBe(true)
    editor().apply(withTitle('three'))
    expect(canRedo(editor())).toBe(false)
  })

  it('ignores no-op edits', () => {
    loadDoc(makeDoc(2))
    editor().apply((d) => d)
    expect(editor().past).toHaveLength(0)
    expect(editor().dirty).toBe(false)
  })

  it('coalesces edits with the same key within the time window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const doc = makeDoc(2)
    loadDoc(doc)
    editor().apply(withTitle('a'), { coalesceKey: 'drag' })
    vi.setSystemTime(1_000_300)
    editor().apply(withTitle('ab'), { coalesceKey: 'drag' })
    vi.setSystemTime(1_000_600)
    editor().apply(withTitle('abc'), { coalesceKey: 'drag' })
    expect(editor().past).toHaveLength(1)
    // A different key or a pause starts a new step.
    vi.setSystemTime(1_005_000)
    editor().apply(withTitle('abcd'), { coalesceKey: 'drag' })
    editor().apply(withTitle('other'), { coalesceKey: 'other' })
    expect(editor().past).toHaveLength(3)
    editor().undo()
    editor().undo()
    editor().undo()
    expect(editor().doc).toBe(doc)
  })

  it('reconciles page and object selection after edits and undo', () => {
    const doc = makeDoc(3, [
      { id: 'o1', pageId: 'p2', type: 'rect', x: 0, y: 0, width: 10, height: 10, strokeColor: '#000000', fillColor: null, strokeWidth: 1, rotation: 0 }
    ])
    loadDoc(doc)
    editor().setSelectedPages(['p2', 'p3'])
    editor().setCurrentPage('p2')
    editor().selectObject('o1')
    editor().apply((d) => ({ ...dropPage('p2')(d), objects: [] }))
    expect(editor().selectedPageIds).toEqual(['p3'])
    expect(editor().currentPageId).toBe('p1')
    expect(editor().selectedObjectId).toBeNull()
    editor().undo()
    expect(editor().doc?.pages).toHaveLength(3)
    expect(editor().selectedPageIds).toEqual(['p3'])
  })

  it('markSaved keeps the same document and history; later edits make it dirty again', () => {
    loadDoc(makeDoc(2))
    editor().apply(withTitle('x'))
    const doc = editor().doc
    editor().markSaved({ filePath: '/tmp/x.pdf', fileName: 'x.pdf' })
    expect(editor().doc).toBe(doc)
    expect(editor().dirty).toBe(false)
    expect(editor().past).toHaveLength(1)
    expect(editor().filePath).toBe('/tmp/x.pdf')
    editor().undo()
    expect(editor().dirty).toBe(true)
    editor().redo()
    expect(editor().dirty).toBe(false)
  })

  it('markSaved with an older snapshot leaves the document dirty', () => {
    loadDoc(makeDoc(2))
    editor().apply(withTitle('x'))
    const exported = editor().doc!
    editor().apply(withTitle('y'))
    editor().markSaved({ filePath: '/x.pdf', fileName: 'x.pdf' }, exported)
    expect(editor().dirty).toBe(true)
  })

  it('clamps zoom; setZoom clears fit mode, setFitZoom keeps it', () => {
    loadDoc(makeDoc(1))
    editor().setFitZoom(1.3)
    expect(editor().fitMode).toBe('width')
    expect(editor().zoom).toBe(1.3)
    editor().setZoom(100)
    expect(editor().zoom).toBe(ZOOM_MAX)
    expect(editor().fitMode).toBeNull()
    editor().setZoom(0)
    expect(editor().zoom).toBe(ZOOM_MIN)
  })

  it('goToPage sets the current page and issues a new scroll request each time', () => {
    loadDoc(makeDoc(3))
    editor().goToPage('p3')
    const first = editor().scrollRequest
    expect(editor().currentPageId).toBe('p3')
    editor().goToPage('p3', { x: 1, y: 2 })
    expect(editor().scrollRequest?.nonce).not.toBe(first?.nonce)
    expect(editor().scrollRequest?.point).toEqual({ x: 1, y: 2 })
  })

  it('docSession changes when another document is opened or closed', () => {
    const s0 = editor().docSession
    loadDoc(makeDoc(1))
    expect(editor().docSession).toBe(s0 + 1)
    editor().closeDocument()
    expect(editor().docSession).toBe(s0 + 2)
    expect(editor().doc).toBeNull()
  })

  it('notices get distinct ids', () => {
    editor().showNotice('info', 'a')
    const a = editor().notice?.id
    editor().showNotice('info', 'a')
    expect(editor().notice?.id).not.toBe(a)
    editor().clearNotice()
    expect(editor().notice).toBeNull()
  })
})

describe('existing-element selection', () => {
  beforeEach(() => resetStores())

  it('switching to Select keeps only an annotation selection', () => {
    loadDoc(makeDoc(2))
    editor().setTool('edit-content')
    editor().selectElement({ kind: 'content', pageId: 'p1', itemId: 'c1' })
    editor().setTool('select')
    expect(editor().selectedElement).toBeNull()

    editor().setTool('form-design')
    editor().selectElement({ kind: 'field', sourceId: 'src1', fieldName: 'f', widgetIndex: 0, pageId: 'p1' })
    editor().setTool('select')
    expect(editor().selectedElement).toBeNull()

    editor().selectElement({ kind: 'annotation', pageId: 'p1', annotId: 'a1' })
    editor().setTool('select')
    expect(editor().selectedElement).toEqual({ kind: 'annotation', pageId: 'p1', annotId: 'a1' })
    editor().setTool('edit-content')
    expect(editor().selectedElement).toBeNull()
  })

  it('drops a content selection when the item or a container it belongs to is deleted', () => {
    loadDoc(makeDoc(1))
    editor().selectElement({ kind: 'content', pageId: 'p1', itemId: 'x1/t3' })
    editor().apply((d) => ({ ...d, contentEdits: { p1: [{ itemId: 'x10', deleted: true }] } }))
    expect(editor().selectedElement).not.toBeNull() // "x10" is not a container of "x1/t3"
    editor().apply((d) => ({ ...d, contentEdits: { p1: [{ itemId: 'x1', deleted: true }] } }))
    expect(editor().selectedElement).toBeNull()
  })

  it('drops a field selection when its widget is deleted', () => {
    loadDoc(makeDoc(1))
    editor().selectElement({ kind: 'field', sourceId: 'src1', fieldName: 'f', widgetIndex: 1, pageId: 'p1' })
    editor().apply((d) => ({ ...d, fieldEdits: { src1: { f: { deletedWidgets: [0] } } } }))
    expect(editor().selectedElement).not.toBeNull()
    editor().apply((d) => ({ ...d, fieldEdits: { src1: { f: { deletedWidgets: [0, 1] } } } }))
    expect(editor().selectedElement).toBeNull()
  })
})

describe('selectors', () => {
  beforeEach(() => resetStores())

  it('targets the selection in document order, else the current page', () => {
    loadDoc(makeDoc(4))
    expect(getTargetPageIds(useEditor.getState())).toEqual(['p1'])
    editor().setCurrentPage('p3')
    expect(getTargetPageIds(useEditor.getState())).toEqual(['p3'])
    editor().setSelectedPages(['p4', 'p2'])
    expect(getTargetPageIds(useEditor.getState())).toEqual(['p2', 'p4'])
  })

  it('merges source metadata with overrides', () => {
    const doc = makeDoc(1)
    doc.settings.metadata = { title: 'New' }
    expect(effectiveMetadata(doc)).toMatchObject({ title: 'New', author: 'Fixture Author' })
  })

  it('builds the window title', () => {
    expect(windowTitle({ doc: null, fileName: '', dirty: false })).toBe('Open PDF Editor')
    expect(windowTitle({ doc: makeDoc(1), fileName: 'a.pdf', dirty: true })).toBe('a.pdf • — Open PDF Editor')
    expect(windowTitle({ doc: makeDoc(1), fileName: 'a.pdf', dirty: false })).toBe('a.pdf — Open PDF Editor')
  })

  it('reports the raw document name to the shell (no app name, no dirty marker)', () => {
    expect(documentTitle({ doc: null, fileName: 'a.pdf' })).toBe('')
    expect(documentTitle({ doc: makeDoc(1), fileName: 'a.pdf' })).toBe('a.pdf')
    expect(formatWindowTitle('a.pdf', true, true)).toBe('a.pdf • — Open PDF Editor')
    expect(formatWindowTitle('', false, false)).toBe('Open PDF Editor')
  })
})
