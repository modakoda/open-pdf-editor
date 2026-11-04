/**
 * In-app updates: connects UpdateController (controller.ts) to electron-updater, the windows,
 * the menu and IPC. electron-updater is loaded only when a check runs in an installed build.
 *
 * Test hooks (only with OPE_E2E=1, which otherwise disables updates):
 *   OPE_E2E_UPDATER=mock   scripted updater (mockUpdater.ts); OPE_E2E_UPDATER_MODE=notify-only
 *                          makes it behave like a build that cannot update itself
 *   OPE_E2E_UPDATER=real   electron-updater against OPE_UPDATE_FEED_URL (packaged smoke test)
 *   OPE_E2E_UPDATER_DELAY_MS  delay of the automatic check after startup
 */
import { app, ipcMain, shell, type IpcMainEvent } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { senderContext } from '../ipc'
import { PRODUCT_NAME } from '../paths'
import { windows } from '../windows'
import { STARTUP_DELAY_MS, UpdateController, type AutoUpdaterLike, type UpdaterSource } from './controller'
import { downloadPageUrl, feedOverride, readFeedConfig } from './feed'
import { detectInstallMode, readMacSignature, type InstallMode } from './installMode'
import { createMockControl, MockUpdater } from './mockUpdater'
import { UpdateSettings } from './settings'

const e2e = process.env.OPE_E2E === '1'
const testHook = e2e ? process.env.OPE_E2E_UPDATER : undefined
const useMock = testHook === 'mock'
/** Real electron-updater in an e2e run, only against a feed the test serves. */
const useRealInTest = testHook === 'real' && !!feedOverride(process.env)

let releasesPage = 'https://github.com'

async function createSource(): Promise<UpdaterSource> {
  if (useMock) return createMockSource()
  const override = feedOverride(process.env)
  const feed = override ?? readFeedConfig(process.resourcesPath)
  const downloadUrl = (version: string) => downloadPageUrl(feed, version, releasesPage)
  const mode = await detectInstallMode({
    platform: process.platform,
    isPackaged: app.isPackaged,
    e2e: e2e && !useRealInTest,
    env: process.env,
    exePath: app.getPath('exe'),
    productName: PRODUCT_NAME,
    fileExists: existsSync,
    macSignature: readMacSignature
  })
  console.info(`Updates: ${mode.kind}${'reason' in mode ? ` (${mode.reason})` : ''}`)
  if (mode.kind === 'disabled') return { mode, updater: null, downloadUrl }
  const updater = await createElectronUpdater(mode)
  if (override?.url) updater.setFeedURL({ provider: 'generic', url: override.url })
  return { mode, updater, downloadUrl }
}

async function createElectronUpdater(mode: InstallMode): Promise<AutoUpdaterLike & { setFeedURL(options: { provider: 'generic'; url: string }): void }> {
  const updaterModule = await import('electron-updater')
  if (process.platform === 'linux' && mode.kind === 'notify-only') {
    // electron-updater's Linux updater only runs inside an AppImage; deb and tar.gz builds use
    // it to check for new versions (never to download).
    class CheckOnlyUpdater extends updaterModule.AppImageUpdater {
      override isUpdaterActive(): boolean {
        return app.isPackaged
      }
    }
    return new CheckOnlyUpdater()
  }
  return updaterModule.autoUpdater
}

function createMockSource(): UpdaterSource {
  const mode: InstallMode =
    process.env.OPE_E2E_UPDATER_MODE === 'notify-only' ? { kind: 'notify-only', reason: 'e2e' } : { kind: 'in-place' }
  const updater = new MockUpdater(createMockControl(), app.getVersion(), (call) => {
    writeFileSync(join(app.getPath('userData'), 'e2e-update-install.json'), JSON.stringify(call))
    setImmediate(() => app.quit())
  })
  return { mode, updater, downloadUrl: (version) => `https://example.com/open-pdf-editor/releases/v${version}` }
}

const settings = new UpdateSettings(() => join(app.getPath('userData'), 'update-settings.json'))

export const updater = new UpdateController({
  host: {
    currentVersion: app.getVersion(),
    broadcast: (state) => {
      for (const ctx of windows.all()) windows.send(ctx, IPC.updateState, state)
    },
    quit: () => app.quit(),
    openExternal: (url) => void shell.openExternal(url)
  },
  settings,
  createSource,
  automatic: (app.isPackaged && !e2e) || useMock || useRealInTest,
  startupDelayMs: (e2e && Number(process.env.OPE_E2E_UPDATER_DELAY_MS)) || STARTUP_DELAY_MS
})

/** Help > Check for Updates… */
export function checkForUpdatesFromMenu(): void {
  // The result shows in a window (macOS keeps running without one).
  if (windows.all().length === 0) windows.create()
  void updater.check(true)
}

function onSenderMessage(channel: string, action: () => void): void {
  ipcMain.on(channel, (event: IpcMainEvent) => {
    try {
      senderContext(event)
      action()
    } catch (err) {
      console.error(`${channel}:`, err)
    }
  })
}

/** Wires IPC, quitting and the automatic checks (call when the app is ready). */
export function initUpdates(options: { onChange: () => void; projectUrl: string }): void {
  releasesPage = `${options.projectUrl}/releases/latest`
  ipcMain.handle(IPC.getUpdateState, (event) => {
    senderContext(event)
    return updater.getState()
  })
  onSenderMessage(IPC.checkForUpdates, () => void updater.check(true))
  onSenderMessage(IPC.installUpdate, () => updater.install())
  onSenderMessage(IPC.openUpdateDownload, () => updater.openDownload())

  updater.onChange(options.onChange)
  windows.onQuitCancelled(() => updater.handleQuitCancelled())
  app.on('will-quit', (event) => updater.handleWillQuit(event))
  updater.start()
}
