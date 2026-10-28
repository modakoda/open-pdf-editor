import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)

const spies = vi.hoisted(() => ({
  printDocument: vi.fn(async () => undefined)
}))
vi.mock('@renderer/actions/print', () => ({ printDocument: spies.printDocument }))

import type { DesktopApi, MenuAction } from '@shared/ipc'
import { resetCommandState, runCommand } from '@renderer/actions/commands'
import { handleShortcutKeyDown, shortcutAction } from '@renderer/hooks/useKeyboardShortcuts'
import { useDesktopIntegration } from '@renderer/hooks/useDesktopIntegration'
import { isMac } from '@renderer/actions/util'
import { useDialogs } from '@renderer/state/dialogs'
import { useFind } from '@renderer/state/find'
import { coreOverrides as core, makeDoc, resetFakeCore } from './support/fakeCore'
import { emitMenu, fake, fakeState, listeners, resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

const flush = () => new Promise((r) => setTimeout(r, 0))
const mod = isMac ? { metaKey: true } : { ctrlKey: true }

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
  resetCommandState()
  spies.printDocument.mockClear()
  loadDoc(makeDoc(3), { filePath: '/a.pdf', fileName: 'a.pdf' })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('menu action routing', () => {
  const dialogActions: [MenuAction, string][] = [
    ['document-properties', 'properties'],
    ['watermark', 'watermark'],
    ['page-numbers', 'page-numbers'],
    ['security', 'security'],
    ['extract-pages', 'extract'],
    ['split', 'split'],
    ['about', 'about']
  ]
  it.each(dialogActions)('%s opens the %s dialog', async (action, kind) => {
    runCommand(action, 'menu')
    await vi.waitFor(() => expect(useDialogs.getState().current?.request.kind).toBe(kind))
  })

  it('routes page operations to the engine', async () => {
    runCommand('rotate-cw', 'menu')
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p1'], 90)
    resetCommandState()
    runCommand('rotate-ccw', 'menu')
    expect(core.rotatePages).toHaveBeenLastCalledWith(expect.anything(), ['p1'], -90)
    runCommand('insert-blank-page', 'menu')
    expect(core.insertBlankPage).toHaveBeenCalled()
    runCommand('select-all-pages', 'menu')
    expect(editor().selectedPageIds).toHaveLength(4)
    editor().setSelectedPages(['p2'])
    runCommand('delete-pages', 'menu')
    await flush()
    expect(core.deletePages).toHaveBeenCalledWith(expect.anything(), ['p2'])
  })

  it('routes undo/redo, zoom, fit, sidebar and find', () => {
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    runCommand('undo', 'menu')
    expect(editor().past).toHaveLength(0)
    runCommand('redo', 'menu')
    expect(editor().past).toHaveLength(1)
    editor().setZoom(1)
    runCommand('zoom-in', 'menu')
    expect(editor().zoom).toBeGreaterThan(1)
    runCommand('zoom-out', 'menu')
    resetCommandState()
    runCommand('zoom-out', 'keyboard')
    expect(editor().zoom).toBeLessThan(1)
    runCommand('zoom-reset', 'menu')
    expect(editor().zoom).toBe(1)
    runCommand('fit-page', 'menu')
    expect(editor().fitMode).toBe('page')
    runCommand('fit-width', 'menu')
    expect(editor().fitMode).toBe('width')
    runCommand('toggle-sidebar', 'menu')
    expect(editor().sidebarOpen).toBe(false)
    runCommand('find', 'menu')
    expect(useFind.getState().open).toBe(true)
  })

  it('routes file commands', async () => {
    runCommand('save', 'menu')
    await vi.waitFor(() => expect(fake.writeFile).toHaveBeenCalledWith('/a.pdf', expect.any(Uint8Array)))
    runCommand('save-as', 'menu')
    await vi.waitFor(() => expect(fake.saveFileDialog).toHaveBeenCalled())
    runCommand('open', 'menu')
    await vi.waitFor(() => expect(fake.openPdfDialog).toHaveBeenCalled())
    runCommand('insert-pages', 'menu')
    await vi.waitFor(() => expect(fake.openPdfDialog).toHaveBeenCalledTimes(2))
    runCommand('print', 'menu')
    expect(spies.printDocument).toHaveBeenCalled()
    runCommand('close-document', 'menu')
    await vi.waitFor(() => expect(editor().doc).toBeNull())
    runCommand('new', 'menu')
    await vi.waitFor(() => expect(editor().fileName).toBe('Untitled.pdf'))
  })

  it('delete-selection removes the selected object', async () => {
    loadDoc(makeDoc(1, [{ id: 'o1', pageId: 'p1', type: 'whiteout', x: 0, y: 0, width: 1, height: 1, color: '#ffffff' }]))
    editor().selectObject('o1')
    runCommand('delete-selection', 'menu')
    await flush()
    expect(core.removeObject).toHaveBeenCalledWith(expect.anything(), 'o1')
    expect(editor().doc?.objects).toHaveLength(0)
  })

  it('ignores document commands without a document', () => {
    editor().closeDocument()
    runCommand('rotate-cw', 'menu')
    runCommand('watermark', 'menu')
    expect(core.rotatePages).not.toHaveBeenCalled()
    expect(useDialogs.getState().current).toBeNull()
  })

  it('performs native text editing when a text field has focus', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const exec = vi.fn(() => true)
    document.execCommand = exec
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    runCommand('undo', 'menu')
    expect(exec).toHaveBeenCalledWith('undo')
    expect(editor().past).toHaveLength(1)
    runCommand('select-all-pages', 'menu')
    expect(exec).toHaveBeenCalledWith('selectAll')
    expect(editor().selectedPageIds).toEqual([])
  })

  it('dedupes the same action arriving as keydown and menu accelerator', () => {
    editor().setZoom(1)
    runCommand('zoom-in', 'keyboard')
    const z = editor().zoom
    runCommand('zoom-in', 'menu')
    expect(editor().zoom).toBe(z)
    runCommand('zoom-in', 'keyboard')
    expect(editor().zoom).toBeGreaterThan(z)
  })

  it('ignores menu commands while a modal dialog is open', async () => {
    runCommand('watermark', 'menu')
    await vi.waitFor(() => expect(useDialogs.getState().current).not.toBeNull())
    runCommand('rotate-cw', 'menu')
    expect(core.rotatePages).not.toHaveBeenCalled()
  })
})

describe('desktop integration', () => {
  function Harness() {
    useDesktopIntegration()
    return null
  }

  it('subscribes to menu actions, OS files and save-before-close', async () => {
    const { unmount } = render(<Harness />)
    expect(listeners.menu.size).toBe(1)
    emitMenu('rotate-cw')
    expect(core.rotatePages).toHaveBeenCalled()
    editor().markSaved({ filePath: '/a.pdf', fileName: 'a.pdf' })

    for (const l of listeners.openFile) l({ path: null, name: 'os.pdf', bytes: new Uint8Array([1]) })
    // Document is clean, so it is replaced without asking.
    await vi.waitFor(() => expect(editor().fileName).toBe('os.pdf'))

    editor().markSaved({ filePath: '/os.pdf', fileName: 'os.pdf' })
    for (const l of listeners.saveBeforeClose) l()
    await vi.waitFor(() => expect(fake.confirmClose).toHaveBeenCalled())
    unmount()
    expect(listeners.menu.size).toBe(0)
  })

  it('reports document state changes with the raw document name as title', () => {
    render(<Harness />)
    // The shell formats the window title and close prompt itself (DocumentState contract).
    expect(fake.setDocumentState).toHaveBeenLastCalledWith({
      title: 'a.pdf',
      dirty: false,
      hasDocument: true,
      filePath: '/a.pdf'
    })
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    expect(fake.setDocumentState).toHaveBeenLastCalledWith({
      title: 'a.pdf',
      dirty: true,
      hasDocument: true,
      filePath: '/a.pdf'
    })
    const calls = fake.setDocumentState.mock.calls.length
    editor().setZoom(2) // unrelated change: not reported again
    expect(fake.setDocumentState.mock.calls.length).toBe(calls)
    editor().closeDocument()
    expect(fake.setDocumentState).toHaveBeenLastCalledWith({
      title: '',
      dirty: false,
      hasDocument: false,
      filePath: null
    })
  })

  it('tells the shell to keep the window open when the save before closing fails', async () => {
    const api = fake as DesktopApi
    api.cancelClose = vi.fn()
    render(<Harness />)
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    fake.writeFile.mockRejectedValueOnce(new Error('read-only'))
    for (const l of listeners.saveBeforeClose) l()
    await vi.waitFor(() => expect(api.cancelClose).toHaveBeenCalledTimes(1))
    expect(fake.confirmClose).not.toHaveBeenCalled()
    delete api.cancelClose
  })
})

describe('keyboard shortcuts', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
    ({ key: k, code: '', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mod, ...extra }) as KeyboardEvent

  it('maps platform shortcuts to commands', () => {
    expect(shortcutAction(key('o'))).toBe('open')
    expect(shortcutAction(key('s'))).toBe('save')
    expect(shortcutAction(key('S', { shiftKey: true }))).toBe('save-as')
    expect(shortcutAction(key('z'))).toBe('undo')
    expect(shortcutAction(key('Z', { shiftKey: true }))).toBe('redo')
    expect(shortcutAction(key('='))).toBe('zoom-in')
    expect(shortcutAction(key('+', { shiftKey: true }))).toBe('zoom-in')
    expect(shortcutAction(key('-'))).toBe('zoom-out')
    expect(shortcutAction(key('0'))).toBe('zoom-reset')
    expect(shortcutAction(key('f'))).toBe('find')
    expect(shortcutAction(key('p'))).toBe('print')
    expect(shortcutAction(key('o', { metaKey: false, ctrlKey: false }))).toBeNull()
    if (!isMac) expect(shortcutAction(key('y'))).toBe('redo')
  })

  it('undo/redo in a text field edit the text, exactly once, not the document', () => {
    editor().apply((d) => ({ ...d, pages: [...d.pages] }))
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    const exec = vi.fn(() => true)
    document.execCommand = exec
    const ev = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...mod })
    handleShortcutKeyDown(Object.defineProperty(ev, 'target', { value: textarea }))
    // Handled here on every platform (on macOS the keydown alone would do nothing)…
    expect(ev.defaultPrevented).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenLastCalledWith('undo')
    expect(editor().past).toHaveLength(1)
    // …and the Edit > Undo accelerator that follows the keydown on macOS is not applied again.
    runCommand('undo', 'menu')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(editor().past).toHaveLength(1)

    // Edit > Undo chosen from the menu (no keydown) undoes in the field.
    resetCommandState()
    runCommand('undo', 'menu')
    expect(exec).toHaveBeenCalledTimes(2)

    const redo = new KeyboardEvent('keydown', { key: 'Z', shiftKey: true, bubbles: true, cancelable: true, ...mod })
    handleShortcutKeyDown(Object.defineProperty(redo, 'target', { value: textarea }))
    expect(exec).toHaveBeenLastCalledWith('redo')
    expect(editor().past).toHaveLength(1)

    // Select-all stays native in text fields.
    const all = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, ...mod })
    handleShortcutKeyDown(Object.defineProperty(all, 'target', { value: textarea }))
    expect(all.defaultPrevented).toBe(false)
    expect(editor().selectedPageIds).toEqual([])
    textarea.blur()

    const onBody = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...mod })
    Object.defineProperty(onBody, 'target', { value: document.body })
    handleShortcutKeyDown(onBody)
    expect(onBody.defaultPrevented).toBe(true)
    expect(editor().past).toHaveLength(0)
  })

  it('Cmd/Ctrl+N is left to the app menu in the desktop app', async () => {
    fakeState.desktop = true
    const ev = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, ...mod })
    Object.defineProperty(ev, 'target', { value: document.body })
    handleShortcutKeyDown(ev)
    // Not handled: the menu accelerator routes it in the main process (new window).
    expect(ev.defaultPrevented).toBe(false)
    await flush()
    expect(core.createBlankDocument).not.toHaveBeenCalled()
    expect(editor().fileName).toBe('a.pdf')
  })

  it('Cmd/Ctrl+N creates a document in the browser build', async () => {
    const ev = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, ...mod })
    Object.defineProperty(ev, 'target', { value: document.body })
    handleShortcutKeyDown(ev)
    expect(ev.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(editor().fileName).toBe('Untitled.pdf'))
  })

  it('navigates pages with PageDown / PageUp / Home / End', () => {
    const press = (k: string) => {
      const ev = new KeyboardEvent('keydown', { key: k, cancelable: true })
      Object.defineProperty(ev, 'target', { value: document.body })
      handleShortcutKeyDown(ev)
    }
    press('PageDown')
    expect(editor().currentPageId).toBe('p2')
    press('End')
    expect(editor().currentPageId).toBe('p3')
    press('PageUp')
    expect(editor().currentPageId).toBe('p2')
    press('Home')
    expect(editor().currentPageId).toBe('p1')
  })
})
