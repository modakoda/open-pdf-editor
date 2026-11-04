/**
 * In-app update state machine, driven by electron-updater (or the e2e mock):
 *
 *   idle → checking → up-to-date | error
 *                   → available             (notify-only builds: link to the download page)
 *                   → downloading → ready   (in-place builds; installs when the app quits)
 *
 * Checks run after startup and every few hours while "Check for Updates Automatically" is on,
 * and from Help > Check for Updates…. Automatic checks stay silent unless they find an update.
 * "Restart to Update" quits the normal way, so every window with unsaved changes asks to save
 * first; only once all windows have closed (app 'will-quit') does it install and relaunch.
 * Free of Electron imports so it can be unit tested with a mocked updater.
 */
import type { UpdateState, UpdateStatus } from '@shared/ipc'
import type { InstallMode } from './installMode'

export interface UpdateInfoLike {
  version: string
}

/** The part of electron-updater's AppUpdater used here (the e2e mock implements it too). */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdaterSource {
  mode: InstallMode
  /** null when updates are disabled for this build. */
  updater: AutoUpdaterLike | null
  /** Page where users download `version` themselves (notify-only builds). */
  downloadUrl(version: string): string
}

export interface UpdateHost {
  readonly currentVersion: string
  /** Sends the state to every window. */
  broadcast(state: UpdateState): void
  /** Quits the app the normal way: each window with unsaved changes asks to save first. */
  quit(): void
  openExternal(url: string): void
}

export interface UpdateControllerOptions {
  host: UpdateHost
  settings: { autoCheck: boolean }
  /** Resolves the install mode and creates the updater (once, on the first check). */
  createSource(): Promise<UpdaterSource>
  /** Automatic checks may run (installed builds, or the e2e mock). */
  automatic: boolean
  startupDelayMs?: number
  intervalMs?: number
  /** How long "Restart to Update" waits for the updater to quit before quitting normally. */
  installTimeoutMs?: number
}

export const STARTUP_DELAY_MS = 8_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const INSTALL_TIMEOUT_MS = 15_000
const MAX_MESSAGE_LENGTH = 240

type Timer = ReturnType<typeof setTimeout>

/** First line of an updater error, shortened (HTTP errors include whole responses). */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? 'Unknown error'
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : line
}

function versionOf(status: UpdateStatus): string | undefined {
  return 'version' in status ? status.version : undefined
}

function downloadPromiseOf(result: unknown): Promise<unknown> | null {
  const p = (result as { downloadPromise?: unknown } | null)?.downloadPromise
  return p instanceof Promise ? p : null
}

export class UpdateController {
  private state: UpdateState = { status: 'idle', id: 0, manual: false }
  private source: Promise<UpdaterSource> | null = null
  private mode: InstallMode | null = null
  private updater: AutoUpdaterLike | null = null
  private downloadUrl: (version: string) => string = () => ''
  /** The current check (and the download it started) was asked for by the user. */
  private manual = false
  /** "Restart to Update" is waiting for every window to close. */
  private restartPending = false
  /** quitAndInstall() was called. */
  private installing = false
  private installTimer: Timer | undefined
  private startupTimer: Timer | undefined
  private intervalTimer: ReturnType<typeof setInterval> | undefined
  private listeners = new Set<() => void>()

  constructor(private readonly options: UpdateControllerOptions) {}

  getState(): UpdateState {
    return this.state
  }

  private status(): UpdateState['status'] {
    return this.state.status
  }

  /** Called when the status or the automatic-check setting changes (menu refresh). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(): void {
    for (const l of this.listeners) l()
  }

  get autoCheck(): boolean {
    return this.options.settings.autoCheck
  }

  setAutoCheck(enabled: boolean): void {
    this.options.settings.autoCheck = enabled
    this.schedule()
    this.emitChange()
  }

  /** Schedules the automatic checks (startup + periodic) if they are enabled. */
  start(): void {
    this.schedule()
  }

  dispose(): void {
    clearTimeout(this.startupTimer)
    clearInterval(this.intervalTimer)
    clearTimeout(this.installTimer)
  }

  private schedule(): void {
    clearTimeout(this.startupTimer)
    clearInterval(this.intervalTimer)
    this.startupTimer = this.intervalTimer = undefined
    if (!this.options.automatic || !this.autoCheck) return
    const automaticCheck = () => {
      // Nothing new to learn while an update is on its way or already known.
      if (['checking', 'downloading', 'ready', 'available'].includes(this.state.status)) return
      void this.check(false)
    }
    this.startupTimer = setTimeout(automaticCheck, this.options.startupDelayMs ?? STARTUP_DELAY_MS)
    this.intervalTimer = setInterval(automaticCheck, this.options.intervalMs ?? CHECK_INTERVAL_MS)
  }

  async check(manual = false): Promise<void> {
    const { status } = this.state
    if (status === 'checking' || status === 'downloading' || status === 'ready') {
      // Already on its way: show the banner again when the user asks.
      if (manual) {
        this.manual = true
        this.publish({ ...this.state, id: this.state.id + 1, manual: true })
      }
      return
    }
    this.manual = manual
    this.update({ status: 'checking' })

    let source: UpdaterSource
    try {
      source = await this.ensureSource()
    } catch (err) {
      this.fail(err)
      return
    }
    const { updater, mode } = source
    if (!updater || mode.kind === 'disabled') {
      const reason = mode.kind === 'disabled' ? ` (${mode.reason})` : ''
      this.update({ status: 'error', message: `Updates are not available for this build${reason}.` })
      return
    }
    try {
      const result = await updater.checkForUpdates()
      // A failed background download is reported through the 'error' event.
      downloadPromiseOf(result)?.catch(() => undefined)
      if (result === null && this.status() === 'checking') {
        this.update({ status: 'error', message: 'Updates are not available for this build.' })
      }
    } catch (err) {
      this.fail(err)
    }
  }

  private ensureSource(): Promise<UpdaterSource> {
    if (!this.source) {
      this.source = this.options.createSource().then((source) => {
        this.mode = source.mode
        this.downloadUrl = source.downloadUrl
        if (source.updater && source.mode.kind !== 'disabled') {
          const inPlace = source.mode.kind === 'in-place'
          source.updater.autoDownload = inPlace
          source.updater.autoInstallOnAppQuit = inPlace
          this.attach(source.updater)
          this.updater = source.updater
        }
        return source
      })
      // Try again on the next check if creating the updater failed.
      this.source.catch(() => (this.source = null))
    }
    return this.source
  }

  private attach(updater: AutoUpdaterLike): void {
    updater.on('update-available', (info) => {
      if (this.mode?.kind === 'in-place') this.update({ status: 'downloading', version: info.version, percent: 0 })
      else this.update({ status: 'available', version: info.version, downloadUrl: this.downloadUrl(info.version) })
    })
    updater.on('update-not-available', () => {
      this.update({ status: 'up-to-date', currentVersion: this.options.host.currentVersion })
    })
    updater.on('download-progress', (progress) => {
      if (this.state.status !== 'downloading') return
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0))
      this.update({ status: 'downloading', version: this.state.version, percent })
    })
    updater.on('update-downloaded', (info) => this.update({ status: 'ready', version: info.version }))
    updater.on('error', (err) => this.fail(err))
  }

  private fail(err: unknown): void {
    if (this.installing) {
      this.abandonInstall(err)
      return
    }
    console.error('Update failed:', err)
    const { status } = this.state
    const what =
      status === 'downloading'
        ? 'The update could not be downloaded'
        : status === 'ready'
          ? 'The update could not be installed'
          : 'Could not check for updates'
    // Background failures stay quiet unless the user asked or the banner shows an update.
    const visible = this.manual || status === 'downloading' || status === 'ready'
    this.update({ status: 'error', message: `${what}: ${errorMessage(err)}` }, visible)
  }

  private update(status: UpdateStatus, manual = this.manual): void {
    const prev = this.state
    const changed = status.status !== prev.status || versionOf(status) !== versionOf(prev)
    this.publish({ ...status, id: changed ? prev.id + 1 : prev.id, manual })
    if (status.status !== prev.status) this.emitChange()
  }

  private publish(state: UpdateState): void {
    this.state = state
    this.options.host.broadcast(state)
  }

  /** "Restart to Update". */
  install(): void {
    if (this.state.status !== 'ready' || !this.updater || this.installing) return
    this.restartPending = true
    this.options.host.quit()
  }

  /** Opens the download page of the available version (notify-only builds). */
  openDownload(): void {
    if (this.state.status === 'available') this.options.host.openExternal(this.state.downloadUrl)
  }

  /** A window with unsaved changes stayed open when quitting: no restart. */
  handleQuitCancelled(): void {
    this.restartPending = false
  }

  /** app 'will-quit': every window has closed, so the update may install now. */
  handleWillQuit(event: { preventDefault(): void }): void {
    if (!this.restartPending) return
    this.restartPending = false
    const updater = this.updater
    if (!updater || this.state.status !== 'ready') return
    // The updater quits the app itself once the installer is on its way.
    event.preventDefault()
    this.installing = true
    this.installTimer = setTimeout(
      () => this.abandonInstall(new Error('The updater did not quit the app')),
      this.options.installTimeoutMs ?? INSTALL_TIMEOUT_MS
    )
    try {
      // Silent install, then start the new version.
      updater.quitAndInstall(true, true)
    } catch (err) {
      this.abandonInstall(err)
    }
  }

  private abandonInstall(err: unknown): void {
    if (!this.installing) return
    this.installing = false
    clearTimeout(this.installTimer)
    console.error('Could not install the update:', err)
    // The windows are closed already: finish quitting.
    this.options.host.quit()
  }
}
