/**
 * In-app updates (src/main/updates): the update state machine with a mocked electron-updater,
 * which builds update in place, notify-only fallbacks (unsigned macOS app, portable, deb, tar.gz),
 * "Restart to Update" and the persisted automatic-check setting.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/ipc'
import {
  errorMessage,
  UpdateController,
  type AutoUpdaterLike,
  type UpdaterSource
} from '../../src/main/updates/controller'
import { downloadPageUrl, feedOverride, parseAppUpdateYml } from '../../src/main/updates/feed'
import {
  detectInstallMode,
  macAppBundle,
  parseCodesignOutput,
  type InstallEnvironment,
  type InstallMode
} from '../../src/main/updates/installMode'
import { UpdateSettings } from '../../src/main/updates/settings'

/** Stand-in for electron-updater's autoUpdater: tests emit its events. */
class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async (): Promise<unknown> => ({ updateInfo: { version: '1.0.0' } }))
  quitAndInstall = vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>()

  /** Next check finds `version` (and, for in-place builds, starts downloading it). */
  offer(version: string): void {
    this.checkForUpdates.mockImplementationOnce(async () => {
      this.emit('update-available', { version })
      return { updateInfo: { version }, downloadPromise: this.autoDownload ? Promise.resolve([]) : null }
    })
  }

  upToDate(): void {
    this.checkForUpdates.mockImplementationOnce(async () => {
      this.emit('update-not-available', { version: '1.0.0' })
      return { updateInfo: { version: '1.0.0' } }
    })
  }

  /** Like electron-updater: emits 'error' and rejects. */
  failNext(message: string): void {
    this.checkForUpdates.mockImplementationOnce(async () => {
      const error = new Error(message)
      this.emit('error', error)
      throw error
    })
  }
}

interface SetupOptions {
  mode?: InstallMode
  automatic?: boolean
  autoCheck?: boolean
}

function setup(options: SetupOptions = {}) {
  const mode = options.mode ?? { kind: 'in-place' }
  const updater = new FakeUpdater()
  const states: UpdateState[] = []
  const host = {
    currentVersion: '1.0.0',
    broadcast: vi.fn((state: UpdateState) => void states.push(state)),
    quit: vi.fn(),
    openExternal: vi.fn()
  }
  const settings = { autoCheck: options.autoCheck ?? true }
  const createSource = vi.fn(
    async (): Promise<UpdaterSource> => ({
      mode,
      updater: mode.kind === 'disabled' ? null : updater,
      downloadUrl: (version) => `https://example.com/releases/v${version}`
    })
  )
  const controller = new UpdateController({
    host,
    settings,
    createSource,
    automatic: options.automatic ?? true,
    startupDelayMs: 1000,
    intervalMs: 60_000,
    installTimeoutMs: 5000
  })
  const changes = vi.fn()
  controller.onChange(changes)
  return { controller, updater, host, settings, states, createSource, changes, state: () => controller.getState() }
}

/** Brings an in-place controller to "ready" with `version` downloaded. */
async function readyToInstall(version = '2.0.0') {
  const t = setup()
  t.updater.offer(version)
  await t.controller.check(true)
  t.updater.emit('update-downloaded', { version })
  expect(t.state().status).toBe('ready')
  return t
}

const quitEvent = () => ({ preventDefault: vi.fn() })

afterEach(() => {
  vi.useRealTimers()
})

describe('update state machine', () => {
  it('manual check: checking → downloading with progress → ready', async () => {
    const { controller, updater, states, state, changes } = setup()
    expect(state()).toMatchObject({ status: 'idle', id: 0 })
    updater.offer('2.0.0')
    await controller.check(true)

    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(states.map((s) => s.status)).toEqual(['checking', 'downloading'])
    expect(state()).toMatchObject({ status: 'downloading', version: '2.0.0', percent: 0, manual: true })

    const downloadingId = state().id
    updater.emit('download-progress', { percent: 42.5 })
    updater.emit('download-progress', { percent: 180 })
    expect(states.at(-2)).toMatchObject({ status: 'downloading', percent: 42.5, id: downloadingId })
    // Progress updates keep the id: a dismissed download banner stays dismissed.
    expect(state()).toMatchObject({ status: 'downloading', percent: 100, id: downloadingId })

    updater.emit('update-downloaded', { version: '2.0.0' })
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0' })
    expect(state().id).toBeGreaterThan(downloadingId)
    // checking, downloading, ready: the menu is rebuilt on status changes only.
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it('reports "up to date" (shown only for manual checks)', async () => {
    const { controller, updater, state } = setup()
    updater.upToDate()
    await controller.check(true)
    expect(state()).toMatchObject({ status: 'up-to-date', currentVersion: '1.0.0', manual: true })

    updater.upToDate()
    await controller.check(false)
    expect(state()).toMatchObject({ status: 'up-to-date', manual: false })
  })

  it('reports errors once, and keeps automatic failures quiet', async () => {
    const { controller, updater, state } = setup()
    updater.failNext('net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper')
    await controller.check(true)
    expect(state()).toMatchObject({
      status: 'error',
      manual: true,
      message: 'Could not check for updates: net::ERR_INTERNET_DISCONNECTED'
    })
    // 'error' event + rejected promise: one state change (checking = 1, error = 2).
    expect(state().id).toBe(2)

    updater.failNext('HttpError: 404')
    await controller.check(false)
    expect(state()).toMatchObject({ status: 'error', manual: false })
  })

  it('shows a failed background download even for automatic checks', async () => {
    const { controller, updater, state } = setup()
    updater.offer('2.0.0')
    await controller.check(false)
    expect(state()).toMatchObject({ status: 'downloading', manual: false })
    updater.emit('error', new Error('sha512 checksum mismatch'))
    expect(state()).toMatchObject({
      status: 'error',
      manual: true,
      message: 'The update could not be downloaded: sha512 checksum mismatch'
    })
  })

  it('does not start a second check while one is running; a manual one shows the banner again', async () => {
    const { controller, updater, state, states } = setup()
    updater.offer('2.0.0')
    await controller.check(false)
    const before = state()
    await controller.check(false)
    expect(states.at(-1)).toBe(before)
    await controller.check(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ status: 'downloading', manual: true })
    expect(state().id).toBe(before.id + 1)
  })

  it('creates the updater once, on the first check', async () => {
    const { controller, updater, createSource } = setup()
    expect(createSource).not.toHaveBeenCalled()
    updater.upToDate()
    await controller.check(true)
    updater.upToDate()
    await controller.check(true)
    expect(createSource).toHaveBeenCalledTimes(1)
  })

  it('retries creating the updater after a failure', async () => {
    const { controller, createSource, updater, state } = setup()
    createSource.mockRejectedValueOnce(new Error('codesign timed out'))
    await controller.check(true)
    expect(state()).toMatchObject({ status: 'error', message: 'Could not check for updates: codesign timed out' })
    updater.upToDate()
    await controller.check(true)
    expect(state().status).toBe('up-to-date')
    expect(createSource).toHaveBeenCalledTimes(2)
  })

  it('explains why development builds do not update', async () => {
    const { controller, state } = setup({ mode: { kind: 'disabled', reason: 'development build' } })
    await controller.check(true)
    expect(state()).toMatchObject({
      status: 'error',
      manual: true,
      message: 'Updates are not available for this build (development build).'
    })
  })

  it('treats an inactive updater (checkForUpdates() → null) as unavailable', async () => {
    const { controller, updater, state } = setup()
    updater.checkForUpdates.mockResolvedValueOnce(null)
    await controller.check(true)
    expect(state()).toMatchObject({ status: 'error', message: 'Updates are not available for this build.' })
  })

  it('shortens updater error messages', () => {
    expect(errorMessage(new Error('\nfirst line\nsecond line'))).toBe('first line')
    const long = errorMessage(new Error('x'.repeat(1000)))
    expect(long).toHaveLength(240)
    expect(long.endsWith('…')).toBe(true)
    expect(errorMessage('plain')).toBe('plain')
  })
})

describe('builds that cannot update themselves', () => {
  it('find the new version without downloading it and link to the download page', async () => {
    const { controller, updater, host, state } = setup({ mode: { kind: 'notify-only', reason: 'ad-hoc signed build' } })
    updater.offer('2.0.0')
    await controller.check(false)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(state()).toMatchObject({
      status: 'available',
      version: '2.0.0',
      downloadUrl: 'https://example.com/releases/v2.0.0'
    })

    controller.openDownload()
    expect(host.openExternal).toHaveBeenCalledWith('https://example.com/releases/v2.0.0')
    controller.install()
    expect(host.quit).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('skip automatic re-checks once a new version is known (the banner does not come back)', async () => {
    vi.useFakeTimers()
    const { controller, updater, state } = setup({ mode: { kind: 'notify-only', reason: 'portable build' } })
    updater.offer('2.0.0')
    controller.start()
    await vi.advanceTimersByTimeAsync(1000)
    const shown = state()
    expect(shown.status).toBe('available')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(state()).toBe(shown)
    controller.dispose()
  })
})

describe('install mode detection', () => {
  const env = (overrides: Partial<InstallEnvironment>): InstallEnvironment => ({
    platform: 'darwin',
    isPackaged: true,
    e2e: false,
    env: {},
    exePath: '/Applications/Open PDF Editor.app/Contents/MacOS/Open PDF Editor',
    productName: 'Open PDF Editor',
    fileExists: () => false,
    macSignature: async () => 'signed',
    ...overrides
  })

  it('is disabled in development builds and e2e runs', async () => {
    expect(await detectInstallMode(env({ isPackaged: false }))).toEqual({ kind: 'disabled', reason: 'development build' })
    expect(await detectInstallMode(env({ e2e: true }))).toEqual({ kind: 'disabled', reason: 'test run' })
  })

  it('macOS: updates in place only when signed with a real certificate', async () => {
    const macSignature = vi.fn(async () => 'signed' as const)
    expect(await detectInstallMode(env({ macSignature }))).toEqual({ kind: 'in-place' })
    expect(macSignature).toHaveBeenCalledWith('/Applications/Open PDF Editor.app')
    expect(await detectInstallMode(env({ macSignature: async () => 'adhoc' }))).toEqual({
      kind: 'notify-only',
      reason: 'ad-hoc signed build'
    })
    expect(await detectInstallMode(env({ macSignature: async () => 'unsigned' }))).toEqual({
      kind: 'notify-only',
      reason: 'unsigned build'
    })
  })

  it('macOS: an app run from a disk image or a translocated copy only notifies', async () => {
    const macSignature = vi.fn(async () => 'signed' as const)
    for (const exePath of [
      '/Volumes/Open PDF Editor 1.0.0/Open PDF Editor.app/Contents/MacOS/Open PDF Editor',
      '/private/var/folders/x/AppTranslocation/ABC/d/Open PDF Editor.app/Contents/MacOS/Open PDF Editor'
    ]) {
      expect((await detectInstallMode(env({ exePath, macSignature }))).kind).toBe('notify-only')
    }
    expect(macSignature).not.toHaveBeenCalled()
  })

  it('classifies codesign output', () => {
    const adhoc = [
      'Executable=/x/Open PDF Editor.app/Contents/MacOS/Open PDF Editor',
      'CodeDirectory v=20400 size=300 flags=0x2(adhoc) hashes=3+3 location=embedded',
      'Signature=adhoc',
      'TeamIdentifier=not set'
    ].join('\n')
    const developerId = [
      'CodeDirectory v=20500 size=927 flags=0x10000(runtime) hashes=18+7 location=embedded',
      'Authority=Developer ID Application: Example Ltd (ABCDE12345)',
      'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA',
      'TeamIdentifier=ABCDE12345'
    ].join('\n')
    const linkerSigned = 'CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0\nTeamIdentifier=not set'
    expect(parseCodesignOutput(adhoc)).toBe('adhoc')
    expect(parseCodesignOutput(linkerSigned)).toBe('adhoc')
    expect(parseCodesignOutput(developerId)).toBe('signed')
    expect(parseCodesignOutput('/x/Open PDF Editor.app: code object is not signed at all')).toBe('unsigned')
    expect(parseCodesignOutput('')).toBe('unsigned')
  })

  it('finds the app bundle of the executable', () => {
    expect(macAppBundle('/Applications/A.app/Contents/MacOS/A')).toBe('/Applications/A.app')
    expect(macAppBundle('/usr/local/bin/a')).toBeNull()
  })

  it('Windows: NSIS installs update in place; portable and unpacked builds only notify', async () => {
    const exePath = 'C:\\Users\\me\\AppData\\Local\\Programs\\open-pdf-editor\\Open PDF Editor.exe'
    const installed = vi.fn((p: string) => p.endsWith('Uninstall Open PDF Editor.exe'))
    const win = (o: Partial<InstallEnvironment>) => env({ platform: 'win32', exePath, ...o })
    expect(await detectInstallMode(win({ fileExists: installed }))).toEqual({ kind: 'in-place' })
    expect(await detectInstallMode(win({ fileExists: installed, env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Downloads' } }))).toEqual({
      kind: 'notify-only',
      reason: 'portable build'
    })
    expect(await detectInstallMode(win({}))).toEqual({ kind: 'notify-only', reason: 'not installed with the installer' })
  })

  it('Linux: AppImages update in place; deb and tar.gz builds only notify', async () => {
    const linux = (o: Partial<InstallEnvironment>) => env({ platform: 'linux', exePath: '/opt/Open PDF Editor/open-pdf-editor', ...o })
    expect(await detectInstallMode(linux({ env: { APPIMAGE: '/home/me/Open.AppImage' } }))).toEqual({ kind: 'in-place' })
    expect(await detectInstallMode(linux({}))).toEqual({ kind: 'notify-only', reason: 'deb or tar.gz build' })
  })
})

describe('update feed', () => {
  it('reads app-update.yml and links to the GitHub release', () => {
    const feed = parseAppUpdateYml('owner: modakoda\nrepo: open-pdf-editor\nprovider: github\nupdaterCacheDirName: open-pdf-editor-updater\n')
    expect(feed).toEqual({ provider: 'github', owner: 'modakoda', repo: 'open-pdf-editor', host: undefined, url: undefined })
    expect(downloadPageUrl(feed, '1.2.0', 'fallback')).toBe('https://github.com/modakoda/open-pdf-editor/releases/tag/v1.2.0')
  })

  it('supports a generic feed (also as an OPE_UPDATE_FEED_URL override)', () => {
    const feed = parseAppUpdateYml("provider: generic\nurl: 'https://updates.example.com/ope'\n")
    expect(downloadPageUrl(feed, '1.2.0', 'fallback')).toBe('https://updates.example.com/ope')
    expect(feedOverride({ OPE_UPDATE_FEED_URL: ' http://127.0.0.1:8123/ ' })).toEqual({ provider: 'generic', url: 'http://127.0.0.1:8123/' })
    expect(feedOverride({ OPE_UPDATE_FEED_URL: 'file:///etc' })).toBeNull()
    expect(feedOverride({})).toBeNull()
    expect(downloadPageUrl(null, '1.2.0', 'https://example.com/releases')).toBe('https://example.com/releases')
    expect(parseAppUpdateYml('nonsense')).toBeNull()
  })
})

describe('Restart to Update', () => {
  it('quits the normal way, then installs and relaunches once every window has closed', async () => {
    const { controller, updater, host } = await readyToInstall()
    controller.install()
    expect(host.quit).toHaveBeenCalledTimes(1)
    // Nothing is installed while windows may still ask to save.
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    const event = quitEvent()
    controller.handleWillQuit(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('a window kept open with unsaved changes cancels the restart', async () => {
    const { controller, updater } = await readyToInstall()
    controller.install()
    controller.handleQuitCancelled()

    // A later, ordinary quit leaves installing to electron-updater (install on quit).
    const event = quitEvent()
    controller.handleWillQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('an ordinary quit does not restart', async () => {
    const { controller, updater } = await readyToInstall()
    const event = quitEvent()
    controller.handleWillQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('does nothing before an update is ready', async () => {
    const { controller, updater, host } = setup()
    updater.offer('2.0.0')
    await controller.check(true)
    controller.install()
    controller.handleWillQuit(quitEvent())
    expect(host.quit).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('finishes quitting when the updater cannot install', async () => {
    const { controller, updater, host } = await readyToInstall()
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('No update filepath provided')
    })
    controller.install()
    controller.handleWillQuit(quitEvent())
    expect(host.quit).toHaveBeenCalledTimes(2)
  })

  it('finishes quitting when the updater reports an error or never quits', async () => {
    const failing = await readyToInstall()
    failing.controller.install()
    failing.controller.handleWillQuit(quitEvent())
    failing.updater.emit('error', new Error('Squirrel could not install'))
    expect(failing.host.quit).toHaveBeenCalledTimes(2)

    vi.useFakeTimers()
    const stuck = await readyToInstall()
    stuck.controller.install()
    stuck.controller.handleWillQuit(quitEvent())
    vi.advanceTimersByTime(4999)
    expect(stuck.host.quit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(stuck.host.quit).toHaveBeenCalledTimes(2)
  })
})

describe('automatic checks', () => {
  beforeEach(() => vi.useFakeTimers())

  it('check after the startup delay and periodically while enabled', async () => {
    const { controller, updater } = setup()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '1.0.0' })
      return {}
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toMatchObject({ status: 'up-to-date', manual: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('never run when the setting is off, and follow the setting when it changes', async () => {
    const { controller, updater, settings, changes } = setup({ autoCheck: false })
    controller.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    controller.setAutoCheck(true)
    expect(settings.autoCheck).toBe(true)
    expect(changes).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    controller.setAutoCheck(false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('never run in development builds or e2e runs without the mock', async () => {
    const { controller, createSource } = setup({ automatic: false })
    controller.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(createSource).not.toHaveBeenCalled()
  })
})

describe('update settings', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ope-update-settings-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('checks automatically by default and persists the choice', () => {
    const file = join(dir, 'nested', 'update-settings.json')
    const settings = new UpdateSettings(() => file)
    expect(settings.autoCheck).toBe(true)
    settings.autoCheck = false
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoCheck: false })
    // A new instance (next launch) reads it back.
    expect(new UpdateSettings(() => file).autoCheck).toBe(false)
  })

  it('falls back to the default for a damaged file', () => {
    const file = join(dir, 'update-settings.json')
    writeFileSync(file, '{not json')
    expect(new UpdateSettings(() => file).autoCheck).toBe(true)
    writeFileSync(file, JSON.stringify({ autoCheck: 'no' }))
    expect(new UpdateSettings(() => file).autoCheck).toBe(true)
  })
})
