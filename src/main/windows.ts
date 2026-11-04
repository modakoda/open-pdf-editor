/**
 * Window management: one document per window. Tracks each window's document state, the file
 * paths the user granted to it, messages queued until its renderer has loaded, the close
 * confirmation for unsaved changes and the quit sequence across several dirty windows.
 */
import { app, BrowserWindow, dialog, nativeTheme } from 'electron'
import { IPC, type DocumentState } from '@shared/ipc'
import { pathKey, samePath } from './files'
import { iconPath, preloadPath, PRODUCT_NAME, startUrl } from './paths'
import { nextWindowBounds, saveWindowState } from './windowState'

/** How long a window counts as "busy opening a file" after one was sent to it. */
const PENDING_OPEN_MS = 10_000
/** Test runs: never show windows on screen (see tests/e2e/helpers.ts). */
const HEADLESS = process.env.OPE_HEADLESS === '1'

export interface WindowContext {
  readonly id: number
  readonly win: BrowserWindow
  state: DocumentState
  /** The current page fired did-finish-load (messages can be delivered). */
  loaded: boolean
  /** Messages waiting for the renderer to load. */
  outbox: Array<{ channel: string; args: unknown[] }>
  /** Paths this window may read/write (pathKey → absolute path). */
  granted: Map<string, string>
  /** A file is on its way to this window (sent by us or being loaded by the renderer). */
  pendingOpenUntil: number
  /** Path of that file, when known. */
  pendingOpenPath: string | null
  /** Close without asking (user already decided). */
  allowClose: boolean
  /** saveBeforeClose was sent; waiting for confirmClose(). */
  awaitingSave: boolean
  /** The close was started by the quit sequence. */
  closeIntent: 'quit' | null
  /** The close confirmation dialog is showing. */
  prompting: boolean
}

const EMPTY_STATE: DocumentState = { title: PRODUCT_NAME, dirty: false, hasDocument: false, filePath: null }

/** Name of the window's document for titles and prompts ("Untitled" if the renderer sent none). */
export function documentName(state: DocumentState): string {
  return state.title.trim() || 'Untitled'
}

/**
 * Window title from the renderer's raw document name: "report.pdf" on macOS (the edited state
 * is the close-button dot), "*report.pdf - Open PDF Editor" on Windows/Linux.
 */
export function windowTitle(state: DocumentState, platform = process.platform): string {
  if (!state.hasDocument) return PRODUCT_NAME
  const name = documentName(state)
  if (platform === 'darwin') return name
  return `${state.dirty ? '*' : ''}${name} - ${PRODUCT_NAME}`
}

type ChangeListener = () => void

class WindowManager {
  private contexts = new Map<number, WindowContext>()
  /** Window ids, least recently focused first. */
  private focusOrder: number[] = []
  private listeners = new Set<ChangeListener>()
  private quitCancelListeners = new Set<ChangeListener>()
  private quitSequence = false
  private quitConfirmed = false

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(): void {
    for (const l of this.listeners) l()
  }

  /** Called when quitting stops because the user kept a window with unsaved changes open. */
  onQuitCancelled(listener: ChangeListener): () => void {
    this.quitCancelListeners.add(listener)
    return () => this.quitCancelListeners.delete(listener)
  }

  private cancelQuitSequence(): void {
    if (!this.quitSequence) return
    this.quitSequence = false
    for (const l of this.quitCancelListeners) l()
  }

  all(): WindowContext[] {
    return [...this.contexts.values()].filter((c) => !c.win.isDestroyed())
  }

  get(win: BrowserWindow | null | undefined): WindowContext | undefined {
    if (!win || win.isDestroyed()) return undefined
    return this.contexts.get(win.id)
  }

  fromWebContents(contents: Electron.WebContents): WindowContext | undefined {
    return this.get(BrowserWindow.fromWebContents(contents))
  }

  /** The focused window, else the most recently focused one, else the newest. */
  active(): WindowContext | undefined {
    const focused = this.get(BrowserWindow.getFocusedWindow())
    if (focused) return focused
    for (let i = this.focusOrder.length - 1; i >= 0; i--) {
      const ctx = this.contexts.get(this.focusOrder[i])
      if (ctx && !ctx.win.isDestroyed()) return ctx
    }
    return this.all().at(-1)
  }

  /** The window has a document or is about to receive one. */
  isOccupied(ctx: WindowContext): boolean {
    return ctx.state.hasDocument || this.isPendingOpen(ctx)
  }

  private isPendingOpen(ctx: WindowContext): boolean {
    return ctx.pendingOpenUntil > Date.now()
  }

  /**
   * A file is being opened in this window (sent from here, or read by the renderer through a
   * dialog / readFile) — until the renderer reports a document, OS opens go elsewhere.
   */
  markPendingOpen(ctx: WindowContext, path: string | null = null): void {
    ctx.pendingOpenUntil = Date.now() + PENDING_OPEN_MS
    ctx.pendingOpenPath = path
  }

  /** The window that shows (or is about to show) `path`, if any. */
  findByPath(path: string): WindowContext | undefined {
    return this.all().find((ctx) => {
      if (ctx.state.hasDocument && ctx.state.filePath && samePath(ctx.state.filePath, path)) return true
      return this.isPendingOpen(ctx) && !!ctx.pendingOpenPath && samePath(ctx.pendingOpenPath, path)
    })
  }

  create(): WindowContext {
    const active = this.active()
    const bounds = nextWindowBounds(active?.win.getBounds())
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: 640,
      minHeight: 480,
      show: false,
      // OPE_HEADLESS=1 (e2e tests): windows stay hidden, so hidden pages must not be throttled.
      ...(HEADLESS ? { paintWhenInitiallyHidden: true } : {}),
      title: PRODUCT_NAME,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
      ...(process.platform === 'linux' ? { icon: iconPath } : {}),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        backgroundThrottling: !HEADLESS
      }
    })
    const ctx: WindowContext = {
      id: win.id,
      win,
      state: { ...EMPTY_STATE },
      loaded: false,
      outbox: [],
      granted: new Map(),
      pendingOpenUntil: 0,
      pendingOpenPath: null,
      allowClose: false,
      awaitingSave: false,
      closeIntent: null,
      prompting: false
    }
    this.contexts.set(win.id, ctx)
    this.focusOrder.push(win.id)
    if (bounds.maximized) win.maximize()

    let shown = false
    const show = () => {
      if (shown || win.isDestroyed()) return
      shown = true
      if (!HEADLESS) win.show()
    }
    win.once('ready-to-show', show)
    setTimeout(show, 3000)

    const contents = win.webContents
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        ctx.loaded = false
        // A reload discards the renderer's document and any save it was doing for a close.
        this.resetDocument(ctx)
      }
    })
    contents.on('did-finish-load', () => {
      ctx.loaded = true
      const queued = ctx.outbox.splice(0)
      for (const m of queued) contents.send(m.channel, ...m.args)
    })
    // The window title is driven by setDocumentState, not by <title>.
    win.on('page-title-updated', (e) => e.preventDefault())
    // Our own dialog replaces beforeunload prompts.
    contents.on('will-prevent-unload', (e) => e.preventDefault())
    contents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      this.resetDocument(ctx)
      void this.handleCrash(ctx, details.reason)
    })

    win.on('focus', () => {
      this.focusOrder = [...this.focusOrder.filter((id) => id !== win.id), win.id]
      this.emitChange()
    })

    let saveTimer: NodeJS.Timeout | undefined
    const rememberBounds = () => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
      saveWindowState({ ...win.getNormalBounds(), maximized: win.isMaximized() })
    }
    const scheduleSave = () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(rememberBounds, 400)
    }
    win.on('resize', scheduleSave)
    win.on('move', scheduleSave)
    win.on('maximize', scheduleSave)
    win.on('unmaximize', scheduleSave)

    win.on('close', (event) => {
      const intent = ctx.closeIntent
      ctx.closeIntent = null
      // A close the user started themselves (not part of quitting) cancels a pending quit.
      if (intent !== 'quit') this.cancelQuitSequence()
      if (ctx.allowClose || !ctx.state.dirty) {
        clearTimeout(saveTimer)
        rememberBounds()
        return
      }
      event.preventDefault()
      void this.confirmCloseDirty(ctx, intent === 'quit')
    })

    win.on('closed', () => {
      clearTimeout(saveTimer)
      this.contexts.delete(ctx.id)
      this.focusOrder = this.focusOrder.filter((id) => id !== ctx.id)
      this.emitChange()
      if (this.quitSequence) setImmediate(() => this.closeNextForQuit())
    })

    void win.loadURL(startUrl)
    this.emitChange()
    return ctx
  }

  /** Sends a message now, or when the renderer has finished loading. */
  send(ctx: WindowContext, channel: string, ...args: unknown[]): void {
    if (ctx.win.isDestroyed()) return
    if (ctx.loaded) ctx.win.webContents.send(channel, ...args)
    else ctx.outbox.push({ channel, args })
  }

  grant(ctx: WindowContext, path: string): void {
    ctx.granted.set(pathKey(path), path)
  }

  isGranted(ctx: WindowContext, path: string): boolean {
    return ctx.granted.has(pathKey(path))
  }

  focus(ctx: WindowContext): void {
    const { win } = ctx
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (HEADLESS) return
    if (!win.isVisible()) win.show()
    win.focus()
  }

  setDocumentState(ctx: WindowContext, state: DocumentState): void {
    const hadDocument = ctx.state.hasDocument
    ctx.state = state
    if (state.hasDocument) {
      ctx.pendingOpenUntil = 0
      ctx.pendingOpenPath = null
    }
    this.applyState(ctx)
    if (hadDocument !== state.hasDocument) this.emitChange()
  }

  private applyState(ctx: WindowContext): void {
    const { win, state } = ctx
    if (win.isDestroyed()) return
    win.setTitle(windowTitle(state))
    if (process.platform === 'darwin') {
      win.setDocumentEdited(state.hasDocument && state.dirty)
      const represented = state.filePath && this.isGranted(ctx, state.filePath) ? state.filePath : ''
      win.setRepresentedFilename(represented)
    }
  }

  /** The renderer's document is gone (reload, crash): forget its state and pending close. */
  private resetDocument(ctx: WindowContext): void {
    if (ctx.awaitingSave) this.cancelQuitSequence()
    ctx.awaitingSave = false
    ctx.state = { ...EMPTY_STATE }
    ctx.pendingOpenUntil = 0
    ctx.pendingOpenPath = null
    this.applyState(ctx)
    this.emitChange()
  }

  /** Close dialog for a window with unsaved changes. */
  private async confirmCloseDirty(ctx: WindowContext, forQuit: boolean): Promise<void> {
    if (ctx.prompting) return
    // A close requested while an earlier "Save" is still unanswered asks again, so a renderer
    // that never confirms or cancels cannot keep the window open forever.
    ctx.awaitingSave = false
    ctx.prompting = true
    const name = documentName(ctx.state)
    let response = 2
    try {
      this.focus(ctx)
      const result = await dialog.showMessageBox(ctx.win, {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: PRODUCT_NAME,
        message: `Do you want to save the changes you made to “${name}”?`,
        detail: "Your changes will be lost if you don't save them."
      })
      response = result.response
    } catch (err) {
      console.error('Close confirmation failed', err)
    } finally {
      ctx.prompting = false
    }
    if (ctx.win.isDestroyed()) return
    if (response === 0) {
      ctx.awaitingSave = true
      if (forQuit) this.quitSequence = true
      this.send(ctx, IPC.saveBeforeClose)
    } else if (response === 1) {
      if (forQuit) this.quitSequence = true
      ctx.allowClose = true
      if (forQuit) ctx.closeIntent = 'quit'
      ctx.win.close()
    } else {
      this.cancelQuitSequence()
    }
  }

  /** The renderer saved after saveBeforeClose: close the window now. */
  confirmClose(ctx: WindowContext): void {
    if (!ctx.awaitingSave) return
    const forQuit = this.quitSequence
    ctx.awaitingSave = false
    ctx.allowClose = true
    if (forQuit) ctx.closeIntent = 'quit'
    ctx.win.close()
  }

  /** The save after saveBeforeClose failed or was cancelled: keep the window, stop quitting. */
  cancelClose(ctx: WindowContext): void {
    if (!ctx.awaitingSave) return
    ctx.awaitingSave = false
    this.cancelQuitSequence()
  }

  /** app 'before-quit': ask about every window with unsaved changes, one at a time. */
  handleBeforeQuit(event: Electron.Event): void {
    if (this.quitConfirmed) return
    const dirty = this.all().filter((c) => c.state.dirty && !c.allowClose)
    if (dirty.length === 0) {
      this.quitConfirmed = true
      return
    }
    event.preventDefault()
    if (this.quitSequence) return
    this.quitSequence = true
    this.closeNextForQuit()
  }

  private closeNextForQuit(): void {
    if (!this.quitSequence) return
    const next = this.all().find((c) => c.state.dirty && !c.allowClose)
    if (!next) {
      this.quitSequence = false
      this.quitConfirmed = true
      app.quit()
      return
    }
    if (next.prompting || next.awaitingSave) return
    next.closeIntent = 'quit'
    next.win.close()
  }

  private async handleCrash(ctx: WindowContext, reason: string): Promise<void> {
    if (ctx.win.isDestroyed()) return
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'error',
      buttons: ['Reload', 'Close Window'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: PRODUCT_NAME,
      message: 'This window stopped working.',
      detail: `Reason: ${reason}. Unsaved changes in this window were lost.`
    })
    if (ctx.win.isDestroyed()) return
    this.resetDocument(ctx)
    if (response === 0) ctx.win.webContents.reload()
    else {
      ctx.allowClose = true
      ctx.win.close()
    }
  }
}

export const windows = new WindowManager()
