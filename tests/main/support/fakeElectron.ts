/**
 * Minimal stand-in for the parts of Electron that src/main/windows.ts uses, so the real window
 * manager (close confirmation, quit sequence) runs in unit tests. Use with:
 *   vi.mock('electron', async () => (await import('./support/fakeElectron')).electronModule)
 * and take the fakes from `await import('electron')` (the instance the code under test got).
 */
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

class FakeWebContents extends EventEmitter {
  send = vi.fn()
  reload = vi.fn()
}

export class FakeBrowserWindow extends EventEmitter {
  static nextId = 1
  static all = new Set<FakeBrowserWindow>()
  static focused: FakeBrowserWindow | null = null

  readonly id = FakeBrowserWindow.nextId++
  readonly webContents = new FakeWebContents()
  private destroyed = false

  constructor(readonly options: Record<string, unknown> = {}) {
    super()
    FakeBrowserWindow.all.add(this)
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return [...FakeBrowserWindow.all]
  }

  static getFocusedWindow(): FakeBrowserWindow | null {
    return FakeBrowserWindow.focused
  }

  static fromWebContents(contents: unknown): FakeBrowserWindow | null {
    return [...FakeBrowserWindow.all].find((w) => w.webContents === contents) ?? null
  }

  loadURL = vi.fn(async () => {
    this.webContents.emit('did-finish-load')
  })
  show = vi.fn()
  focus = vi.fn()
  restore = vi.fn()
  maximize = vi.fn()
  setTitle = vi.fn()
  setDocumentEdited = vi.fn()
  setRepresentedFilename = vi.fn()
  isDestroyed = () => this.destroyed
  isMinimized = () => false
  isVisible = () => true
  isFullScreen = () => false
  isMaximized = () => false
  getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
  getNormalBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })

  /** Like BrowserWindow.close(): 'close' can be prevented; otherwise the window is destroyed. */
  close(): void {
    if (this.destroyed) return
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    this.emit('close', event)
    if (!event.defaultPrevented) this.destroy()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    FakeBrowserWindow.all.delete(this)
    this.emit('closed')
  }
}

export const fakeApp = {
  quit: vi.fn(),
  getVersion: () => '1.0.0',
  getPath: () => '/tmp/ope-test',
  isPackaged: false
}

export const fakeDialog = {
  /** Answers with the button index set by tests (default: Cancel = 2). */
  response: 2,
  showMessageBox: vi.fn(async () => ({ response: fakeDialog.response, checkboxChecked: false }))
}

function resetFakeElectron(): void {
  for (const w of [...FakeBrowserWindow.all]) w.destroy()
  FakeBrowserWindow.focused = null
  fakeApp.quit.mockReset()
  fakeDialog.response = 2
  fakeDialog.showMessageBox.mockClear()
}

export const electronModule = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  dialog: fakeDialog,
  nativeTheme: { shouldUseDarkColors: false },
  screen: {},
  /** Test helper (not Electron API): closes every window and clears the mocks. */
  reset: resetFakeElectron
}
