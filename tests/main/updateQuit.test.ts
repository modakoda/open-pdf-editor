/**
 * "Restart to Update" through the real window manager (src/main/windows.ts, with a fake Electron):
 * windows with unsaved changes ask to save first, and keeping one open blocks the install.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateController, type AutoUpdaterLike } from '../../src/main/updates/controller'

vi.mock('electron', async () => (await import('./support/fakeElectron')).electronModule)
vi.mock('../../src/main/paths', () => ({
  PRODUCT_NAME: 'Open PDF Editor',
  iconPath: '',
  preloadPath: '',
  startUrl: 'app://bundle/index.html'
}))
vi.mock('../../src/main/windowState', () => ({
  nextWindowBounds: () => ({ x: 0, y: 0, width: 800, height: 600, maximized: false }),
  saveWindowState: vi.fn()
}))

type Windows = (typeof import('../../src/main/windows'))['windows']
type FakeElectron = typeof import('./support/fakeElectron')

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => {
    this.emit('update-available', { version: '2.0.0' })
    this.emit('update-downloaded', { version: '2.0.0' })
    return {}
  })
  quitAndInstall = vi.fn()
}

let windows: Windows
/** The fake Electron the freshly imported window manager uses. */
let fakeApp: FakeElectron['fakeApp']
let fakeDialog: FakeElectron['fakeDialog']
let updater: FakeUpdater
let controller: UpdateController

/** What Electron does for app.quit(): before-quit, then (unless prevented) close windows and will-quit. */
function quitApp(): { prevented: boolean } {
  const beforeQuit = { defaultPrevented: false, preventDefault: () => void (beforeQuit.defaultPrevented = true) }
  windows.handleBeforeQuit(beforeQuit as unknown as Electron.Event)
  if (beforeQuit.defaultPrevented) return { prevented: true }
  for (const ctx of windows.all()) ctx.win.close()
  if (windows.all().length > 0) return { prevented: true }
  const willQuit = { preventDefault: vi.fn() }
  controller.handleWillQuit(willQuit)
  return { prevented: willQuit.preventDefault.mock.calls.length > 0 }
}

function openWindow(dirty: boolean) {
  const ctx = windows.create()
  windows.setDocumentState(ctx, { title: dirty ? 'draft.pdf' : 'saved.pdf', dirty, hasDocument: true, filePath: null })
  return ctx
}

/** Lets dialogs resolve and setImmediate callbacks (the quit sequence) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  // A fresh window manager (and fake Electron) per test.
  vi.resetModules()
  ;({ windows } = await import('../../src/main/windows'))
  // The mocked module may outlive resetModules: use the instance the window manager got.
  const electron = (await import('electron')) as unknown as FakeElectron['electronModule']
  electron.reset()
  ;({ app: fakeApp, dialog: fakeDialog } = electron)
  updater = new FakeUpdater()
  controller = new UpdateController({
    host: { currentVersion: '1.0.0', broadcast: () => undefined, quit: () => fakeApp.quit(), openExternal: () => undefined },
    settings: { autoCheck: false },
    createSource: async () => ({ mode: { kind: 'in-place' }, updater, downloadUrl: () => '' }),
    automatic: false
  })
  windows.onQuitCancelled(() => controller.handleQuitCancelled())
  // app.quit() runs the quit sequence (like Electron's before-quit / will-quit events).
  fakeApp.quit.mockImplementation(() => void quitApp())
  await controller.check(true)
  expect(controller.getState().status).toBe('ready')
})

afterEach(() => controller.dispose())

describe('Restart to Update with open windows', () => {
  it('installs right away when no window has unsaved changes', () => {
    openWindow(false)
    openWindow(false)
    controller.install()
    expect(fakeDialog.showMessageBox).not.toHaveBeenCalled()
    expect(windows.all()).toHaveLength(0)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('asks to save unsaved changes; Cancel keeps the window and blocks the install', async () => {
    openWindow(false)
    const dirty = openWindow(true)
    fakeDialog.response = 2 // Cancel
    controller.install()
    await settle()

    expect(fakeDialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(fakeDialog.showMessageBox.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('draft.pdf') })])
    )
    expect(windows.all()).toContain(dirty)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    // The restart is off: a later quit after saving does not relaunch into the update.
    windows.setDocumentState(dirty, { ...dirty.state, dirty: false })
    expect(quitApp().prevented).toBe(false)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs after the user saves', async () => {
    const dirty = openWindow(true)
    fakeDialog.response = 0 // Save
    controller.install()
    await settle()
    expect(dirty.win.webContents.send).toHaveBeenCalledWith('event:save-before-close')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    // The renderer saved: the window closes and the quit continues.
    windows.setDocumentState(dirty, { ...dirty.state, dirty: false })
    windows.confirmClose(dirty)
    await settle()
    expect(windows.all()).toHaveLength(0)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('does not install when saving fails', async () => {
    const dirty = openWindow(true)
    fakeDialog.response = 0 // Save
    controller.install()
    await settle()
    windows.cancelClose(dirty)
    await settle()
    expect(windows.all()).toContain(dirty)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("installs after Don't Save", async () => {
    openWindow(true)
    fakeDialog.response = 1 // Don't Save
    controller.install()
    await settle()
    expect(windows.all()).toHaveLength(0)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
