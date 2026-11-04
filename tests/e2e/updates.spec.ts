/**
 * In-app updates end to end: Help menu items, the update IPC flow and the banner. e2e runs never
 * contact an update server: OPE_E2E_UPDATER=mock swaps electron-updater for a scripted updater
 * (src/main/updates/mockUpdater.ts) that tests steer through globalThis.__opeMockUpdater.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { UpdateState } from '../../src/shared/ipc'
import { clickMenuItem, dialogCalls, expect, menuItem, setDocumentState, test, type LaunchOptions } from './helpers'

const MOCK = { OPE_E2E_UPDATER: 'mock' }

async function menuChecked(app: ElectronApplication, id: string): Promise<boolean | null> {
  return app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.checked ?? null, id)
}

async function mockStats(app: ElectronApplication): Promise<{ checks: number; installs: unknown[] } | null> {
  return app.evaluate(() => {
    const m = (globalThis as Record<string, unknown>).__opeMockUpdater as { checks: number; installs: unknown[] } | undefined
    return m ? { checks: m.checks, installs: m.installs } : null
  })
}

/** Records every update state the page receives (window.__e2e.updateStates). */
async function recordUpdateStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const e2e = (window.__e2e ??= {})
    e2e.updateStates = []
    window.desktop!.onUpdateState!((s) => (e2e.updateStates as UpdateState[]).push(s))
  })
}

async function recordedUpdateStates(page: Page): Promise<UpdateState[]> {
  return page.evaluate(() => (window.__e2e?.updateStates as UpdateState[] | undefined) ?? [])
}

const banner = (page: Page) => page.getByTestId('update-banner')

/** Waits until the app process has exited (after "Restart to Update"). */
async function waitForExit(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  if (proc.exitCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

function installRecord(userDataDir: string): unknown {
  const file = join(userDataDir, 'e2e-update-install.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

test.describe('in-app updates', () => {
  test('Help menu offers Check for Updates… and the automatic-check setting', async ({ launch }) => {
    const { app, page } = await launch()
    expect(await menuItem(app, 'menu:check-for-updates')).toMatchObject({ label: 'Check for Updates…', enabled: true, visible: true })
    expect(await menuItem(app, 'menu:auto-check-updates')).toMatchObject({ label: 'Check for Updates Automatically', enabled: true })
    expect(await menuChecked(app, 'menu:auto-check-updates')).toBe(true)
    expect(await menuItem(app, 'menu:install-update')).toBeNull()

    const api = await page.evaluate(() => {
      const d = window.desktop as unknown as Record<string, unknown>
      return ['getUpdateState', 'checkForUpdates', 'installUpdate', 'openUpdateDownload', 'onUpdateState'].map((k) => typeof d[k])
    })
    expect(api).toEqual(['function', 'function', 'function', 'function', 'function'])

    // Without the mock, e2e runs (unpackaged builds) never contact an update server.
    expect(await page.evaluate(() => window.desktop!.getUpdateState!())).toMatchObject({ status: 'idle' })
    await clickMenuItem(app, 'menu:check-for-updates')
    await expect(banner(page)).toHaveAttribute('data-status', 'error')
    await expect(banner(page)).toContainText('Updates are not available for this build')
  })

  test('Check for Updates… downloads in the background; Restart to Update installs', async ({ launch }) => {
    const { app, page, userDataDir } = await launch({ env: MOCK })
    await recordUpdateStates(page)
    await clickMenuItem(app, 'menu:check-for-updates')

    await expect(banner(page)).toHaveAttribute('data-status', 'downloading')
    await expect(page.getByTestId('update-progress')).toBeVisible()
    await expect(banner(page)).toHaveAttribute('data-status', 'ready')
    await expect(banner(page)).toContainText('Version 99.0.0 is ready')

    const states = await recordedUpdateStates(page)
    expect([...new Set(states.map((s) => s.status))]).toEqual(['checking', 'downloading', 'ready'])
    expect(states.filter((s) => s.status === 'downloading').map((s) => (s as { percent: number }).percent)).toEqual([0, 10, 45, 80, 100])
    expect(await page.evaluate(() => window.desktop!.getUpdateState!())).toMatchObject({ status: 'ready', version: '99.0.0', manual: true })
    await expect.poll(() => menuItem(app, 'menu:install-update')).toMatchObject({ label: 'Restart to Update' })

    await page.getByTestId('update-restart').click()
    await waitForExit(app)
    expect(installRecord(userDataDir)).toEqual({ isSilent: true, isForceRunAfter: true, version: '99.0.0' })
  })

  test('Restart to Update asks to save unsaved changes first', async ({ launch }) => {
    const { app, page, userDataDir } = await launch({ env: MOCK })
    await clickMenuItem(app, 'menu:check-for-updates')
    await expect(banner(page)).toHaveAttribute('data-status', 'ready')
    await setDocumentState(page, { title: 'contract.pdf', dirty: true, hasDocument: true, filePath: null })

    // The dialog mock answers Cancel: the window stays and nothing is installed.
    await page.getByTestId('update-restart').click()
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    const [prompt] = await dialogCalls(app, 'showMessageBox')
    expect(prompt.options.message).toContain('contract.pdf')
    await page.waitForTimeout(500)
    expect(await mockStats(app)).toMatchObject({ installs: [] })
    expect(installRecord(userDataDir)).toBeNull()
    await expect(banner(page)).toHaveAttribute('data-status', 'ready')

    // Saved: the restart goes ahead.
    await setDocumentState(page, { title: 'contract.pdf', dirty: false, hasDocument: true, filePath: null })
    await page.getByTestId('update-restart').click()
    await waitForExit(app)
    expect(installRecord(userDataDir)).toMatchObject({ isForceRunAfter: true })
  })

  test('builds that cannot update themselves link to the download page', async ({ launch }) => {
    const { app, page } = await launch({ env: { ...MOCK, OPE_E2E_UPDATER_MODE: 'notify-only' } })
    await app.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      g.__opeExternal = []
      ;(shell as unknown as Record<string, unknown>).openExternal = async (url: string) => void (g.__opeExternal as string[]).push(url)
    })
    await clickMenuItem(app, 'menu:check-for-updates')
    await expect(banner(page)).toHaveAttribute('data-status', 'available')
    await expect(banner(page)).toContainText('A new version (99.0.0) is available — download it')
    await page.getByTestId('update-download').click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__opeExternal))
      .toEqual(['https://example.com/open-pdf-editor/releases/v99.0.0'])
    expect(await menuItem(app, 'menu:install-update')).toBeNull()
  })

  test('manual checks report "up to date" and errors', async ({ launch }) => {
    const { app, page } = await launch({ env: MOCK })
    await app.evaluate(() => {
      ;(globalThis as Record<string, unknown>).__opeMockUpdater = { result: 'none', version: '99.0.0', stepMs: 50, checks: 0, installs: [] }
    })
    await clickMenuItem(app, 'menu:check-for-updates')
    await expect(banner(page)).toHaveAttribute('data-status', 'up-to-date')
    await expect(banner(page)).toContainText('up to date')

    await app.evaluate(() => {
      ;((globalThis as Record<string, unknown>).__opeMockUpdater as { result: string }).result = 'error'
    })
    await page.evaluate(() => window.desktop!.checkForUpdates!())
    await expect(banner(page)).toHaveAttribute('data-status', 'error')
    await expect(banner(page)).toContainText('Could not check for updates: Mock update server is unavailable')
    await page.getByTestId('update-dismiss').click()
    await expect(banner(page)).toHaveCount(0)
  })

  test('checks automatically after startup unless turned off (setting persists)', async ({ launch }) => {
    const env = { ...MOCK, OPE_E2E_UPDATER_DELAY_MS: '300' }
    const first = await launch({ env })
    // Automatic checks show only what they found: the download, then "Restart to Update".
    await expect(banner(first.page)).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
    expect(await mockStats(first.app)).toMatchObject({ checks: 1 })

    await clickMenuItem(first.app, 'menu:auto-check-updates')
    await expect.poll(() => menuChecked(first.app, 'menu:auto-check-updates')).toBe(false)
    const settingsFile = join(first.userDataDir, 'update-settings.json')
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ autoCheck: false })
    await first.close()

    const options: LaunchOptions = { env, userDataDir: first.userDataDir }
    const second = await launch(options)
    expect(await menuChecked(second.app, 'menu:auto-check-updates')).toBe(false)
    await second.page.waitForTimeout(2000)
    expect(await mockStats(second.app)).toBeNull()
    await expect(banner(second.page)).toHaveCount(0)

    // Turning it back on checks soon.
    await clickMenuItem(second.app, 'menu:auto-check-updates')
    await expect(banner(second.page)).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ autoCheck: true })
  })
})
