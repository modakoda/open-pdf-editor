/**
 * Scripted stand-in for electron-updater in e2e runs (OPE_E2E=1 and OPE_E2E_UPDATER=mock): no
 * network, no installer. Tests steer it through globalThis.__opeMockUpdater (app.evaluate):
 *   result    outcome of the next checks: 'update' (default), 'none' or 'error'
 *   version   the version offered (default 99.0.0)
 *   stepMs    delay between steps (default 150)
 *   checks    number of checks so far
 *   installs  quitAndInstall() calls
 */
import { EventEmitter } from 'node:events'
import type { AutoUpdaterLike, UpdateInfoLike } from './controller'

export interface MockUpdaterControl {
  result: 'update' | 'none' | 'error'
  version: string
  stepMs: number
  checks: number
  installs: Array<{ isSilent: boolean; isForceRunAfter: boolean }>
}

export function createMockControl(): MockUpdaterControl {
  const g = globalThis as unknown as { __opeMockUpdater?: MockUpdaterControl }
  g.__opeMockUpdater ??= { result: 'update', version: '99.0.0', stepMs: 150, checks: 0, installs: [] }
  return g.__opeMockUpdater
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class MockUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true

  constructor(
    private readonly control: MockUpdaterControl,
    private readonly currentVersion: string,
    /** Records the install and quits, like electron-updater after starting the installer. */
    private readonly onInstall: (call: { isSilent: boolean; isForceRunAfter: boolean; version: string }) => void
  ) {
    super()
  }

  async checkForUpdates(): Promise<unknown> {
    this.control.checks++
    this.emit('checking-for-update')
    await delay(this.control.stepMs)
    if (this.control.result === 'error') {
      const error = new Error('Mock update server is unavailable')
      this.emit('error', error)
      throw error
    }
    if (this.control.result === 'none') {
      const info: UpdateInfoLike = { version: this.currentVersion }
      this.emit('update-not-available', info)
      return { updateInfo: info, downloadPromise: null }
    }
    const info: UpdateInfoLike = { version: this.control.version }
    this.emit('update-available', info)
    return { updateInfo: info, downloadPromise: this.autoDownload ? this.download(info) : null }
  }

  private async download(info: UpdateInfoLike): Promise<string[]> {
    for (const percent of [10, 45, 80, 100]) {
      await delay(this.control.stepMs)
      this.emit('download-progress', { percent, transferred: percent, total: 100, bytesPerSecond: 1000, delta: 1 })
    }
    this.emit('update-downloaded', info)
    return []
  }

  quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    this.control.installs.push({ isSilent, isForceRunAfter })
    this.onInstall({ isSilent, isForceRunAfter, version: this.control.version })
  }
}
