import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)

import { InvalidPasswordError, PasswordRequiredError, PdfLoadError } from '@core'
import type { DesktopApi } from '@shared/ipc'
import {
  closeCurrentDocument,
  newBlankDocument,
  openDroppedFiles,
  openFiles,
  openWithDialog,
  save,
  saveAs,
  saveBeforeClose
} from '@renderer/actions/fileActions'
import { DialogHost } from '@renderer/dialogs/DialogHost'
import { closeDialog, useDialogs } from '@renderer/state/dialogs'
import { coreOverrides as core, makeDoc, resetFakeCore } from './support/fakeCore'
import { fake, fakeState, resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

const flush = () => new Promise((r) => setTimeout(r, 0))
const file = (name = 'a.pdf', path: string | null = null) => ({ path, name, bytes: new Uint8Array([1, 2]) })

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
})
afterEach(() => cleanup())

describe('opening documents', () => {
  it('opens the file chosen in the Open dialog', async () => {
    fake.openPdfDialog.mockResolvedValueOnce([file('report.pdf', '/docs/report.pdf')])
    await openWithDialog()
    expect(core.openDocument).toHaveBeenCalledWith(expect.any(Uint8Array), 'report.pdf', undefined)
    expect(editor().doc?.pages).toHaveLength(3)
    expect(editor().fileName).toBe('report.pdf')
    expect(editor().filePath).toBe('/docs/report.pdf')
  })

  it('does nothing when the Open dialog is cancelled', async () => {
    await openWithDialog()
    expect(core.openDocument).not.toHaveBeenCalled()
    expect(editor().doc).toBeNull()
  })

  it('asks for a password and retries after a wrong password', async () => {
    const user = userEvent.setup()
    core.openDocument.mockImplementation(async (_b: Uint8Array, name: string, opts?: { password?: string }) => {
      if (opts?.password === undefined) throw new PasswordRequiredError()
      if (opts.password !== 'secret') throw new InvalidPasswordError()
      const doc = makeDoc(2)
      doc.sources.src1 = { ...doc.sources.src1, name }
      return doc
    })
    render(<DialogHost />)
    const opening = openFiles([file('locked.pdf')])

    const input = await screen.findByTestId('password-input')
    expect(screen.getByTestId('dialog')).toHaveAttribute('data-dialog', 'password')
    expect(screen.getByText(/locked\.pdf/)).toBeInTheDocument()
    await user.type(input, 'wrong')
    await user.click(screen.getByTestId('dialog-confirm'))
    expect(await screen.findByText(/incorrect password/i)).toBeInTheDocument()
    expect(editor().doc).toBeNull()

    await user.type(screen.getByTestId('password-input'), 'secret')
    await user.keyboard('{Enter}')
    await opening
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    expect(core.openDocument).toHaveBeenLastCalledWith(expect.any(Uint8Array), 'locked.pdf', { password: 'secret' })
    expect(editor().doc?.pages).toHaveLength(2)
  })

  it('cancelling the password dialog leaves the window empty', async () => {
    core.openDocument.mockRejectedValue(new PasswordRequiredError())
    const opening = openFiles([file('locked.pdf')])
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('password'))
    closeDialog(null)
    await opening
    expect(editor().doc).toBeNull()
    expect(editor().notice).toBeNull()
  })

  it('shows an error notice for files that cannot be parsed', async () => {
    core.openDocument.mockRejectedValueOnce(new PdfLoadError('Not a PDF'))
    await openFiles([file('broken.pdf')])
    expect(editor().doc).toBeNull()
    expect(editor().notice).toMatchObject({ kind: 'error' })
    expect(editor().notice?.text).toContain('Not a PDF')
  })

  it('opens files with a path in a new window when a document is already open (desktop)', async () => {
    fakeState.desktop = true
    loadDoc(makeDoc(1))
    await openFiles([file('b.pdf', '/x/b.pdf')])
    expect(fake.openInNewWindow).toHaveBeenCalledWith('/x/b.pdf')
    expect(core.openDocument).not.toHaveBeenCalled()
  })

  it('replaces the current document after confirming unsaved changes (browser)', async () => {
    loadDoc(makeDoc(1))
    editor().apply((d) => ({ ...d, objects: [] }))
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    expect(editor().dirty).toBe(true)

    const first = openFiles([file('b.pdf')])
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('confirm'))
    closeDialog(null) // cancel
    await first
    expect(core.openDocument).not.toHaveBeenCalled()

    const second = openFiles([file('b.pdf')])
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('confirm'))
    closeDialog('confirm')
    await second
    expect(editor().fileName).toBe('b.pdf')
    expect(editor().dirty).toBe(false)
  })

  it('uses the dropped file path when available, else reads the File', async () => {
    fakeState.desktop = true
    fake.getPathForFile.mockReturnValueOnce('/drop/c.pdf')
    const dropped = new File([new Uint8Array([1])], 'c.pdf', { type: 'application/pdf' })
    await openDroppedFiles([dropped])
    expect(fake.readFile).toHaveBeenCalledWith('/drop/c.pdf')
    expect(editor().filePath).toBe('/drop/c.pdf')

    resetStores()
    fakeState.desktop = false
    const other = new File([new Uint8Array([1])], 'd.pdf', { type: 'application/pdf' })
    Object.defineProperty(other, 'arrayBuffer', { value: async () => new Uint8Array([7]).buffer })
    await openDroppedFiles([other, new File(['x'], 'notes.txt', { type: 'text/plain' })])
    expect(editor().fileName).toBe('d.pdf')
    expect(editor().filePath).toBeNull()
  })

  it('creates a new blank document', async () => {
    await newBlankDocument()
    expect(core.createBlankDocument).toHaveBeenCalled()
    expect(editor().fileName).toBe('Untitled.pdf')
    expect(editor().filePath).toBeNull()
    expect(editor().doc?.pages).toHaveLength(1)
  })

  it('New in a desktop window that shows a document opens a new window instead', async () => {
    fakeState.desktop = true
    loadDoc(makeDoc(2), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    const api = fake as DesktopApi
    api.newDocumentWindow = vi.fn(async () => undefined)
    await newBlankDocument()
    expect(api.newDocumentWindow).toHaveBeenCalledTimes(1)
    expect(core.createBlankDocument).not.toHaveBeenCalled()
    expect(editor().fileName).toBe('a.pdf')
    expect(editor().doc?.pages).toHaveLength(2)
    // Older shells without newDocumentWindow: an empty new window.
    delete api.newDocumentWindow
    await newBlankDocument()
    expect(fake.openInNewWindow).toHaveBeenCalledWith(null)
    expect(editor().fileName).toBe('a.pdf')
    // An empty desktop window creates the document in place.
    editor().closeDocument()
    await newBlankDocument()
    expect(editor().fileName).toBe('Untitled.pdf')
  })

  it('a file arriving while another one is still loading opens in a new window (desktop)', async () => {
    fakeState.desktop = true
    let finish: () => void = () => undefined
    const original = core.openDocument.getMockImplementation()!
    core.openDocument.mockImplementationOnce(
      (bytes: Uint8Array, name: string) => new Promise((resolve) => (finish = () => resolve(original(bytes, name))))
    )
    const first = openFiles([file('first.pdf', '/docs/first.pdf')])
    await vi.waitFor(() => expect(core.openDocument).toHaveBeenCalledTimes(1))
    // e.g. sent by the OS while the Open dialog's file is still being parsed
    const second = openFiles([file('second.pdf', '/docs/second.pdf')])
    await flush()
    expect(fake.openInNewWindow).not.toHaveBeenCalled()
    finish()
    await Promise.all([first, second])
    expect(editor().fileName).toBe('first.pdf')
    expect(fake.openInNewWindow).toHaveBeenCalledWith('/docs/second.pdf')
  })

  it('closes the document', async () => {
    loadDoc(makeDoc(1))
    expect(await closeCurrentDocument()).toBe(true)
    expect(editor().doc).toBeNull()
  })
})

describe('saving', () => {
  it('Save writes to the current path and keeps the same document (undo still works)', async () => {
    loadDoc(makeDoc(2), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d, pages: d.pages.slice(0, 1) }))
    const doc = editor().doc
    expect(await save()).toBe(true)
    expect(core.exportDocument).toHaveBeenCalledWith(doc, { onWarning: expect.any(Function) })
    expect(fake.writeFile).toHaveBeenCalledWith('/docs/a.pdf', new Uint8Array([1, 2, 3]))
    expect(fake.saveFileDialog).not.toHaveBeenCalled()
    expect(editor().doc).toBe(doc)
    expect(editor().dirty).toBe(false)
    expect(editor().notice).toMatchObject({ kind: 'info' })
    editor().undo()
    expect(editor().doc?.pages).toHaveLength(2)
    expect(editor().dirty).toBe(true)
  })

  it('Save on an untitled document behaves like Save As with the file name', async () => {
    loadDoc(makeDoc(1), { filePath: null, fileName: 'Untitled.pdf' })
    expect(await save()).toBe(true)
    expect(fake.saveFileDialog).toHaveBeenCalledWith({ defaultPath: 'Untitled.pdf', bytes: expect.any(Uint8Array) })
    expect(fake.writeFile).not.toHaveBeenCalled()
    expect(editor().filePath).toBe('/saved/Untitled.pdf')
    expect(editor().fileName).toBe('Untitled.pdf')
    expect(editor().dirty).toBe(false)
  })

  it('Save As that is cancelled keeps the document dirty', async () => {
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    fake.saveFileDialog.mockResolvedValueOnce(null)
    expect(await saveAs()).toBe(false)
    expect(editor().dirty).toBe(true)
    expect(editor().filePath).toBe('/docs/a.pdf')
  })

  it('mentions what the engine had to change while saving', async () => {
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    core.exportDocument.mockImplementationOnce(async (_doc, opts) => {
      const warn = (opts as { onWarning?: (w: { code: string; message: string }) => void } | undefined)?.onWarning
      warn?.({ code: 'pdfa-claim-removed', message: 'The PDF/A claim was removed.' })
      return new Uint8Array([1, 2, 3])
    })
    expect(await save()).toBe(true)
    expect(editor().notice).toMatchObject({ kind: 'info', text: 'Saved a.pdf. The PDF/A claim was removed.' })
  })

  it('reports export errors and stays dirty', async () => {
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    core.exportDocument.mockRejectedValueOnce(new Error('disk full'))
    expect(await save()).toBe(false)
    expect(editor().dirty).toBe(true)
    expect(editor().notice?.text).toContain('disk full')
    expect(editor().busy).toBeNull()
  })

  it('refuses to save a document without pages and explains why', async () => {
    const empty = makeDoc(1)
    empty.pages = []
    loadDoc(empty, { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    expect(await save()).toBe(false)
    expect(await saveAs()).toBe(false)
    expect(core.exportDocument).not.toHaveBeenCalled()
    expect(fake.writeFile).not.toHaveBeenCalled()
    expect(fake.saveFileDialog).not.toHaveBeenCalled()
    expect(editor().notice).toMatchObject({ kind: 'error' })
    expect(editor().notice?.text).toMatch(/no pages/i)
  })

  it('save-before-close saves then confirms the close', async () => {
    const api = fake as DesktopApi
    api.cancelClose = vi.fn()
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    await saveBeforeClose()
    expect(fake.writeFile).toHaveBeenCalled()
    expect(fake.confirmClose).toHaveBeenCalled()
    expect(api.cancelClose).not.toHaveBeenCalled()

    // A failed save keeps the window open — and says so, so the shell can close it later.
    fake.confirmClose.mockClear()
    fake.writeFile.mockRejectedValueOnce(new Error('denied'))
    await saveBeforeClose()
    expect(fake.confirmClose).not.toHaveBeenCalled()
    expect(api.cancelClose).toHaveBeenCalledTimes(1)

    // So does a cancelled Save As of an untitled document.
    loadDoc(makeDoc(1), { filePath: null, fileName: 'Untitled.pdf' })
    fake.saveFileDialog.mockResolvedValueOnce(null)
    await saveBeforeClose()
    expect(fake.confirmClose).not.toHaveBeenCalled()
    expect(api.cancelClose).toHaveBeenCalledTimes(2)
    delete api.cancelClose
  })

  it('save-before-close waits for a save that is already running', async () => {
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    let release: () => void = () => undefined
    fake.writeFile.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    const running = save()
    await vi.waitFor(() => expect(fake.writeFile).toHaveBeenCalledTimes(1))
    const closing = saveBeforeClose()
    await flush()
    expect(fake.confirmClose).not.toHaveBeenCalled()
    release()
    expect(await running).toBe(true)
    await closing
    expect(fake.confirmClose).toHaveBeenCalledTimes(1)
    // The running save already wrote the current state: no second write.
    expect(fake.writeFile).toHaveBeenCalledTimes(1)
  })

  it('a save requested during another save writes the newer changes afterwards', async () => {
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    let release: () => void = () => undefined
    fake.writeFile.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    const first = save()
    await vi.waitFor(() => expect(fake.writeFile).toHaveBeenCalledTimes(1))
    editor().apply((d) => ({ ...d, pages: [...d.pages] })) // edited while saving
    const second = save()
    release()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(fake.writeFile).toHaveBeenCalledTimes(2)
    expect(editor().dirty).toBe(false)
  })

  it('offers to save before discarding changes', async () => {
    loadDoc(makeDoc(1), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    const closing = closeCurrentDocument()
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe('confirm'))
    closeDialog('alt') // "Save…"
    expect(await closing).toBe(true)
    await waitFor(() => expect(fake.writeFile).toHaveBeenCalled())
    expect(editor().doc).toBeNull()
  })
})
