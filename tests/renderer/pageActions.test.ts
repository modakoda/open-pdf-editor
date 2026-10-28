import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)
vi.mock('@renderer/editing', async () => (await import('./support/fakeEditing')).editingModule)

import {
  deleteSelection,
  deleteTargetPages,
  duplicateTargetPages,
  insertBlankPageAt,
  insertPagesFromFile,
  insertSourcePagesAt,
  movePagesToInsertionIndex,
  openExtractDialog,
  openSplitDialog,
  rotateTargetPages,
  selectAllPages
} from '@renderer/actions/pageActions'
import { closeDialog, useDialogs } from '@renderer/state/dialogs'
import { coreOverrides as core, makeDoc, makeSource, resetFakeCore } from './support/fakeCore'
import { deleteSelectionSpy } from './support/fakeEditing'
import { fake, resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

const pageIds = () => editor().doc!.pages.map((p) => p.id)

describe('page operations', () => {
  beforeEach(() => {
    resetStores()
    resetFakeCore()
    resetFakePlatform()
    loadDoc(makeDoc(4))
  })

  it('rotates the selected pages, or the current page without a selection', () => {
    rotateTargetPages(90)
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p1'], 90)
    editor().setSelectedPages(['p3', 'p2'])
    rotateTargetPages(-90)
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p2', 'p3'], -90)
    expect(editor().doc!.pages.map((p) => p.rotation)).toEqual([90, 270, 270, 0])
    editor().undo()
    expect(editor().doc!.pages[1].rotation).toBe(0)
  })

  it('deletes target pages and moves to the neighbouring page', async () => {
    editor().setSelectedPages(['p2'])
    await deleteTargetPages()
    expect(pageIds()).toEqual(['p1', 'p3', 'p4'])
    expect(editor().selectedPageIds).toEqual([])
    expect(editor().currentPageId).toBe('p3')
  })

  it('asks before deleting every page', async () => {
    selectAllPages()
    expect(editor().selectedPageIds).toEqual(['p1', 'p2', 'p3', 'p4'])
    const pending = deleteTargetPages()
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('confirm'))
    closeDialog(null)
    await pending
    expect(pageIds()).toHaveLength(4)

    const again = deleteTargetPages()
    await vi.waitFor(() => expect(useDialogs.getState().current).not.toBeNull())
    closeDialog('confirm')
    await again
    expect(pageIds()).toHaveLength(0)
    expect(editor().currentPageId).toBeNull()
  })

  it('inserts a blank page after / before the target and selects it', () => {
    editor().setSelectedPages(['p2'])
    insertBlankPageAt('after')
    expect(core.insertBlankPage).toHaveBeenLastCalledWith(expect.anything(), 2)
    const inserted = editor().doc!.pages[2].id
    expect(editor().selectedPageIds).toEqual([inserted])
    expect(editor().currentPageId).toBe(inserted)
    insertBlankPageAt('before', 'p1')
    expect(core.insertBlankPage).toHaveBeenLastCalledWith(expect.anything(), 0)
  })

  it('duplicates target pages', () => {
    editor().setSelectedPages(['p1', 'p4'])
    duplicateTargetPages()
    expect(core.duplicatePages).toHaveBeenCalledWith(expect.anything(), ['p1', 'p4'])
    expect(pageIds()).toHaveLength(6)
  })

  it('maps a drop insertion index to movePages target index', () => {
    // Drag p4 before p1.
    movePagesToInsertionIndex(['p4'], 0)
    expect(core.movePages).toHaveBeenLastCalledWith(expect.anything(), ['p4'], 0)
    expect(pageIds()).toEqual(['p4', 'p1', 'p2', 'p3'])
    // Drag p4 (now first) to the end.
    movePagesToInsertionIndex(['p4'], 4)
    expect(core.movePages).toHaveBeenLastCalledWith(expect.anything(), ['p4'], 3)
    expect(pageIds()).toEqual(['p1', 'p2', 'p3', 'p4'])
    // Drag p1 + p3 between p3 and p4 (insertion index 3): two pages remain before it (p2... and p1/p3 excluded).
    movePagesToInsertionIndex(['p3', 'p1'], 3)
    expect(core.movePages).toHaveBeenLastCalledWith(expect.anything(), ['p1', 'p3'], 1)
    expect(pageIds()).toEqual(['p2', 'p1', 'p3', 'p4'])
  })

  it('ignores drops of a contiguous block onto its own position', () => {
    movePagesToInsertionIndex(['p2'], 1)
    movePagesToInsertionIndex(['p2'], 2)
    movePagesToInsertionIndex(['p2', 'p3'], 3)
    expect(core.movePages).not.toHaveBeenCalled()
    expect(editor().past).toHaveLength(0)
  })

  it('delete-selection deletes the selected object via the editing layer, else selected pages', async () => {
    loadDoc(
      makeDoc(2, [
        { id: 'o1', pageId: 'p1', type: 'highlight', x: 0, y: 0, width: 5, height: 5, color: '#ffff00' }
      ])
    )
    deleteSelectionSpy.mockClear()
    editor().selectObject('o1')
    editor().setSelectedPages(['p2'])
    await deleteSelection()
    expect(deleteSelectionSpy).toHaveBeenCalledTimes(1)
    expect(pageIds()).toEqual(['p1', 'p2'])
    await deleteSelection()
    expect(pageIds()).toEqual(['p1'])
    expect(deleteSelectionSpy).toHaveBeenCalledTimes(1)
    // Nothing selected: nothing happens.
    await deleteSelection()
    expect(pageIds()).toEqual(['p1'])
  })

  it('does not open extract / split for documents without enough pages', async () => {
    loadDoc({ ...makeDoc(1), pages: [] })
    await openExtractDialog()
    expect(useDialogs.getState().current).toBeNull()
    expect(editor().notice?.text).toMatch(/no pages/)
    loadDoc(makeDoc(1))
    await openSplitDialog()
    expect(useDialogs.getState().current).toBeNull()
    expect(editor().notice?.kind).toBe('error')
  })

  it('reports engine failures as error notices instead of throwing', () => {
    core.rotatePages.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    rotateTargetPages(90)
    expect(editor().notice).toMatchObject({ kind: 'error' })
    expect(editor().notice?.text).toContain('boom')
  })

  it('inserts pages from a file after choosing position and range', async () => {
    fake.openPdfDialog.mockResolvedValueOnce([{ path: null, name: 'other.pdf', bytes: new Uint8Array([1]) }])
    const pending = insertPagesFromFile()
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('insert'))
    const req = useDialogs.getState().current!.request
    expect(req.kind === 'insert' && req.source.name).toBe('other.pdf')
    closeDialog(null)
    await pending
    expect(core.insertSourcePages).not.toHaveBeenCalled()

    const source = makeSource('extra', 3, 'extra.pdf')
    expect(insertSourcePagesAt(source, 1, [0, 2])).toBe(true)
    expect(core.insertSourcePages).toHaveBeenCalledWith(expect.anything(), source, 1, [0, 2])
    expect(pageIds()).toHaveLength(6)
    expect(editor().selectedPageIds).toEqual(pageIds().slice(1, 3))
  })
})
