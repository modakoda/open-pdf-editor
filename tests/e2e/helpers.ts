/**
 * Playwright harness for the Electron app.
 *
 * - `test` (extended) gives each test a `launch()` fixture that starts the built app with a fresh
 *   temporary profile (OPE_USER_DATA) and OPE_E2E=1, and cleans up afterwards.
 * - Native dialogs are replaced in the main process (`dialog.*` via electronApp.evaluate); by
 *   default every dialog is "cancelled" so a test can never hang on a real dialog.
 * - Fixture PDFs come from tests/fixtures/pdfs.ts, generated once per worker into a temp folder.
 *
 * The app must be built first (`npm run build`, or `npm run test:e2e`).
 */
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopApi, MenuAction } from '../../src/shared/ipc'
import { generateFixtures, type GeneratedFixtureName as FixtureName } from '../fixtures/generate.ts'

declare global {
  interface Window {
    desktop?: DesktopApi
    /** Scratch space for tests running code in the page. */
    __e2e?: Record<string, unknown>
  }
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js')
export const RENDERER_DIR = join(ROOT, 'out', 'renderer')

export const ALL_MENU_ACTIONS: MenuAction[] = [
  'new',
  'open',
  'save',
  'save-as',
  'close-document',
  'insert-pages',
  'extract-pages',
  'split',
  'print',
  'undo',
  'redo',
  'delete-selection',
  'select-all-pages',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'fit-width',
  'fit-page',
  'toggle-sidebar',
  'rotate-cw',
  'rotate-ccw',
  'insert-blank-page',
  'delete-pages',
  'document-properties',
  'watermark',
  'page-numbers',
  'security',
  'recognize-text',
  'find',
  'about'
]

export const DESKTOP_API_METHODS: (keyof DesktopApi)[] = [
  'openPdfDialog',
  'openImageDialog',
  'readFile',
  'writeFile',
  'saveFileDialog',
  'saveFilesToFolder',
  'getPathForFile',
  'setDocumentState',
  'openInNewWindow',
  'getRecentFiles',
  'confirmClose',
  'cancelClose',
  'newDocumentWindow',
  'showItemInFolder',
  'onMenuAction',
  'onOpenFile',
  'onSaveBeforeClose'
]

/** Fails with a clear message when the app has not been built. */
export function assertBuilt(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`The app is not built (${MAIN_ENTRY} is missing). Run "npm run build" first, or use "npm run test:e2e".`)
  }
}

// ---------------------------------------------------------------------------------------------
// Temp folders and fixtures

const tempDirs: string[] = []

/**
 * A new empty temp folder, removed when the worker exits. The path is canonical (no 8.3 short
 * names on Windows, no /var → /private/var symlink on macOS) so it compares equal to paths
 * reported by the OS.
 */
export function makeTempDir(prefix = 'ope-e2e-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* files may still be locked on Windows; the OS cleans temp eventually */
  }
}

process.on('exit', () => tempDirs.forEach(removeDir))

let fixturesDirPromise: Promise<string> | null = null

/** Folder with every generated fixture (generated once per worker). */
export function fixturesDir(): Promise<string> {
  fixturesDirPromise ??= generateFixtures(makeTempDir('ope-fixtures-'))
  return fixturesDirPromise
}

/** Absolute path of a generated fixture (read-only use: copy it before writing). */
export async function fixturePath(name: FixtureName): Promise<string> {
  return join(await fixturesDir(), name)
}

/** Copies a fixture into `dir` (default: a new temp folder) and returns the copy's path. */
export async function copyFixture(name: FixtureName, dir = makeTempDir(), as: string = name): Promise<string> {
  const target = join(dir, as)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(await fixturePath(name), target)
  return target
}

// ---------------------------------------------------------------------------------------------
// Launching

export interface LaunchOptions {
  /** Extra command-line arguments (e.g. PDF paths). */
  args?: string[]
  env?: Record<string, string>
  /** Reuse a profile folder (e.g. to test persistence across launches). */
  userDataDir?: string
  /** Keep the real dialogs (default: every dialog is mocked as cancelled). */
  realDialogs?: boolean
  /** Launch a packaged app executable instead of out/main/index.js (see packaged.spec.ts). */
  executablePath?: string
}

export interface LaunchedApp {
  app: ElectronApplication
  /** The first window. */
  page: Page
  userDataDir: string
  close(): Promise<void>
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  if (!options.executablePath) assertBuilt()
  const userDataDir = options.userDataDir ?? makeTempDir('ope-profile-')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, { OPE_USER_DATA: userDataDir, OPE_E2E: '1' }, options.env)

  const app = await electron.launch({
    ...(options.executablePath
      ? { executablePath: options.executablePath, args: options.args ?? [] }
      : { args: [MAIN_ENTRY, ...(options.args ?? [])] }),
    cwd: ROOT,
    env,
    timeout: 60_000
  })
  if (!options.realDialogs) await mockAllDialogsCancelled(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      // Skip unsaved-changes prompts and quit.
      await Promise.race([
        app.evaluate(({ BrowserWindow, app: electronApp }) => {
          for (const w of BrowserWindow.getAllWindows()) w.destroy()
          setTimeout(() => electronApp.exit(0), 50)
        }),
        new Promise((r) => setTimeout(r, 5000))
      ])
    } catch {
      /* already gone */
    }
    await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))])
    try {
      app.process().kill()
    } catch {
      /* already exited */
    }
  }
  return { app, page, userDataDir, close }
}

/** `test` with a `launch` fixture that closes every app it started. */
export const test = base.extend<{ launch: (options?: LaunchOptions) => Promise<LaunchedApp> }>({
  // eslint-disable-next-line no-empty-pattern
  launch: async ({}, use) => {
    const launched: LaunchedApp[] = []
    await use(async (options) => {
      const a = await launchApp(options)
      launched.push(a)
      return a
    })
    for (const a of launched) await a.close()
  }
})

export { expect }

// ---------------------------------------------------------------------------------------------
// Dialog mocks (main process). Calls are recorded in globalThis.__opeDialogCalls.

export interface DialogCall {
  method: string
  options: Record<string, unknown>
}

async function mockAllDialogsCancelled(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __opeDialogCalls: { method: string; options: unknown }[] }
    g.__opeDialogCalls = []
    const record = (method: string, args: unknown[]) => {
      const options = args.find((a) => a && typeof a === 'object' && !('webContents' in (a as object))) ?? {}
      g.__opeDialogCalls.push({ method, options: JSON.parse(JSON.stringify(options)) })
      return options as { cancelId?: number; buttons?: string[] }
    }
    const d = dialog as unknown as Record<string, unknown>
    d.showOpenDialog = async (...args: unknown[]) => (record('showOpenDialog', args), { canceled: true, filePaths: [] })
    d.showSaveDialog = async (...args: unknown[]) => (record('showSaveDialog', args), { canceled: true, filePath: '' })
    d.showMessageBox = async (...args: unknown[]) => {
      const o = record('showMessageBox', args)
      const response = o.cancelId ?? Math.max(0, (o.buttons?.length ?? 1) - 1)
      return { response, checkboxChecked: false }
    }
    d.showOpenDialogSync = (...args: unknown[]) => (record('showOpenDialogSync', args), undefined)
    d.showSaveDialogSync = (...args: unknown[]) => (record('showSaveDialogSync', args), undefined)
    d.showMessageBoxSync = (...args: unknown[]) => {
      const o = record('showMessageBoxSync', args)
      return o.cancelId ?? 0
    }
    d.showErrorBox = (...args: unknown[]) => void record('showErrorBox', [{ title: args[0], content: args[1] }])
  })
}

/** Next (and every following) Open dialog returns `filePaths` (null = cancelled). */
export async function mockOpenDialog(app: ElectronApplication, filePaths: string[] | null): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    const g = globalThis as unknown as { __opeDialogCalls: { method: string; options: unknown }[] }
    ;(dialog as unknown as Record<string, unknown>).showOpenDialog = async (...args: unknown[]) => {
      const options = args.find((a) => a && typeof a === 'object' && !('webContents' in (a as object))) ?? {}
      ;(g.__opeDialogCalls ??= []).push({ method: 'showOpenDialog', options: JSON.parse(JSON.stringify(options)) })
      return paths ? { canceled: false, filePaths: paths } : { canceled: true, filePaths: [] }
    }
  }, filePaths)
}

/** Save dialogs return `filePath` (null = cancelled). */
export async function mockSaveDialog(app: ElectronApplication, filePath: string | null): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    const g = globalThis as unknown as { __opeDialogCalls: { method: string; options: unknown }[] }
    ;(dialog as unknown as Record<string, unknown>).showSaveDialog = async (...args: unknown[]) => {
      const options = args.find((a) => a && typeof a === 'object' && !('webContents' in (a as object))) ?? {}
      ;(g.__opeDialogCalls ??= []).push({ method: 'showSaveDialog', options: JSON.parse(JSON.stringify(options)) })
      return path ? { canceled: false, filePath: path } : { canceled: true, filePath: '' }
    }
  }, filePath)
}

/** Message boxes answer with the button at `buttonIndex`. */
export async function mockMessageBox(app: ElectronApplication, buttonIndex: number): Promise<void> {
  await app.evaluate(({ dialog }, index) => {
    const g = globalThis as unknown as { __opeDialogCalls: { method: string; options: unknown }[] }
    ;(dialog as unknown as Record<string, unknown>).showMessageBox = async (...args: unknown[]) => {
      const options = args.find((a) => a && typeof a === 'object' && !('webContents' in (a as object))) ?? {}
      ;(g.__opeDialogCalls ??= []).push({ method: 'showMessageBox', options: JSON.parse(JSON.stringify(options)) })
      return { response: index, checkboxChecked: false }
    }
  }, buttonIndex)
}

/** Every dialog call recorded by the mocks so far. */
export async function dialogCalls(app: ElectronApplication, method?: string): Promise<DialogCall[]> {
  const calls = await app.evaluate(() => {
    const g = globalThis as unknown as { __opeDialogCalls?: unknown[] }
    return (g.__opeDialogCalls ?? []) as { method: string; options: Record<string, unknown> }[]
  })
  return method ? calls.filter((c) => c.method === method) : calls
}

// ---------------------------------------------------------------------------------------------
// Windows and menu

export async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

/** Title of the window showing `page`. */
export async function windowTitle(app: ElectronApplication, page: Page): Promise<string> {
  const win = await app.browserWindow(page)
  return win.evaluate((w) => w.getTitle())
}

/** Ids of every application menu item (recursively). */
export async function menuItemIds(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const ids: string[] = []
    const walk = (menu: ReturnType<typeof Menu.getApplicationMenu> | undefined) => {
      for (const item of menu?.items ?? []) {
        if (item.id) ids.push(item.id)
        walk(item.submenu)
      }
    }
    walk(Menu.getApplicationMenu())
    return ids
  })
}

export interface MenuItemInfo {
  id: string
  label: string
  accelerator: string | null
  enabled: boolean
  visible: boolean
}

export async function menuItem(app: ElectronApplication, id: string): Promise<MenuItemInfo | null> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) return null
    return {
      id: item.id,
      label: item.label,
      accelerator: item.accelerator ?? null,
      enabled: item.enabled,
      visible: item.visible
    }
  }, id)
}

/** Clicks an application menu item as if chosen by the user (on the focused/active window). */
export async function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  const ok = await app.evaluate(({ Menu, BrowserWindow }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) return false
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    item.click(undefined, win, win?.webContents)
    return true
  }, id)
  if (!ok) throw new Error(`Menu item ${id} not found`)
}

// ---------------------------------------------------------------------------------------------
// Renderer-side helpers

/** Starts recording onMenuAction / onOpenFile / onSaveBeforeClose events in the page. */
export async function recordDesktopEvents(page: Page, options: { confirmCloseOnSave?: boolean } = {}): Promise<void> {
  await page.evaluate((opts) => {
    const desktop = window.desktop!
    const e2e = (window.__e2e ??= {})
    if (e2e.recording) return
    e2e.recording = true
    e2e.menuActions = []
    e2e.openedFiles = []
    e2e.saveBeforeClose = 0
    desktop.onMenuAction((a) => (e2e.menuActions as string[]).push(a))
    desktop.onOpenFile((f) =>
      (e2e.openedFiles as unknown[]).push({ path: f.path, name: f.name, size: f.bytes.length, head: String.fromCharCode(...f.bytes.slice(0, 5)) })
    )
    desktop.onSaveBeforeClose(() => {
      e2e.saveBeforeClose = (e2e.saveBeforeClose as number) + 1
      if (opts.confirmCloseOnSave) desktop.confirmClose()
    })
  }, options)
}

/**
 * Records open-file / menu events in every window opened from now on, subscribing before the
 * workspace UI does (so the buffered first delivery is observed by the test).
 */
export async function recordEventsInNewWindows(app: ElectronApplication): Promise<void> {
  await app.context().addInitScript(() => {
    const desktop = window.desktop
    if (!desktop) return
    const e2e = (window.__e2e ??= {})
    e2e.recording = true
    e2e.menuActions = []
    e2e.openedFiles = []
    e2e.saveBeforeClose = 0
    desktop.onMenuAction((a) => (e2e.menuActions as string[]).push(a))
    desktop.onOpenFile((f) =>
      (e2e.openedFiles as unknown[]).push({ path: f.path, name: f.name, size: f.bytes.length, head: String.fromCharCode(...f.bytes.slice(0, 5)) })
    )
    desktop.onSaveBeforeClose(() => {
      e2e.saveBeforeClose = (e2e.saveBeforeClose as number) + 1
    })
  })
}

export async function recordedMenuActions(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__e2e?.menuActions as string[] | undefined) ?? [])
}

export interface RecordedFile {
  path: string | null
  name: string
  size: number
  head: string
}

export async function recordedOpenedFiles(page: Page): Promise<RecordedFile[]> {
  return page.evaluate(() => (window.__e2e?.openedFiles as RecordedFile[] | undefined) ?? [])
}

/** Sets the window's document state from the renderer. */
export async function setDocumentState(
  page: Page,
  state: { title: string; dirty: boolean; hasDocument: boolean; filePath: string | null }
): Promise<void> {
  await page.evaluate((s) => window.desktop!.setDocumentState(s), state)
}

/** Waits until a new window opens and returns its page. */
export async function nextWindow(app: ElectronApplication, action: () => Promise<unknown>): Promise<Page> {
  const [page] = await Promise.all([app.waitForEvent('window'), action()])
  await page.waitForLoadState('domcontentloaded')
  return page
}
