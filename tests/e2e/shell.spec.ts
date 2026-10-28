/**
 * Shell-level e2e tests: window, preload API, custom protocol, security, menu.
 * They do not depend on the workspace UI.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ALL_MENU_ACTIONS,
  DESKTOP_API_METHODS,
  RENDERER_DIR,
  clickMenuItem,
  copyFixture,
  dialogCalls,
  mockMessageBox,
  expect,
  menuItem,
  menuItemIds,
  nextWindow,
  recordDesktopEvents,
  recordEventsInNewWindows,
  recordedMenuActions,
  setDocumentState,
  test,
  windowCount,
  windowTitle
} from './helpers'

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

/** URL path (relative to app://bundle/) of the first built renderer file matching `re`. */
function rendererAsset(re: RegExp): { url: string; size: number } | null {
  const file = listFiles(RENDERER_DIR).find((f) => re.test(f))
  if (!file) return null
  return { url: relative(RENDERER_DIR, file).split(/[\\/]/).map(encodeURIComponent).join('/'), size: statSync(file).size }
}

test.describe('app shell', () => {
  test('launches with one window titled "Open PDF Editor"', async ({ launch }) => {
    const { app, page } = await launch()
    expect(await windowCount(app)).toBe(1)
    await expect.poll(() => windowTitle(app, page)).toBe('Open PDF Editor')
    expect(page.url()).toBe('app://bundle/index.html')
    const win = await app.browserWindow(page)
    expect(await win.evaluate((w) => w.isVisible())).toBe(true)
  })

  test('window.desktop exposes every DesktopApi member', async ({ launch }) => {
    const { app, page } = await launch()
    const shape = await page.evaluate(() => {
      const d = window.desktop as unknown as Record<string, unknown> | undefined
      if (!d) return null
      return Object.fromEntries(Object.keys(d).map((k) => [k, typeof d[k]]))
    })
    expect(shape).not.toBeNull()
    for (const method of DESKTOP_API_METHODS) expect(shape![method], method).toBe('function')
    const platform = await app.evaluate(() => process.platform)
    expect(await page.evaluate(() => window.desktop!.platform)).toBe(platform)
    // Listeners return unsubscribe functions.
    expect(
      await page.evaluate(() => {
        const d = window.desktop!
        const offs = [d.onMenuAction(() => {}), d.onOpenFile(() => {}), d.onSaveBeforeClose(() => {})]
        offs.forEach((off) => off())
        return offs.map((o) => typeof o)
      })
    ).toEqual(['function', 'function', 'function'])
  })

  test('renderer is sandboxed and isolated', async ({ launch }) => {
    const { app, page } = await launch()
    const globals = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      ipc: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer
    }))
    expect(globals).toEqual({ require: 'undefined', process: 'undefined', ipc: 'undefined' })
    const prefs = await (await app.browserWindow(page)).evaluate((w) => {
      const p = w.webContents.getLastWebPreferences()
      return { contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration, webSecurity: p?.webSecurity }
    })
    expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
  })

  test('window.open and navigation away from the app are blocked', async ({ launch }) => {
    const { app, page } = await launch()
    // Do not actually open the user's browser.
    await app.evaluate(({ shell }) => {
      ;(shell as unknown as Record<string, unknown>).openExternal = async (url: string) => {
        ;((globalThis as Record<string, unknown>).__opeExternal ??= [] as string[]) as string[]
        ;((globalThis as Record<string, unknown>).__opeExternal as string[]).push(url)
      }
    })
    const opened = await page.evaluate(() => window.open('https://example.com/') === null)
    expect(opened).toBe(true)
    await page.evaluate(() => {
      location.href = 'https://example.org/'
    })
    await page.waitForTimeout(500)
    expect(page.url()).toBe('app://bundle/index.html')
    expect(await windowCount(app)).toBe(1)
    const external = await app.evaluate(() => (globalThis as Record<string, unknown>).__opeExternal as string[] | undefined)
    expect(external).toEqual(['https://example.com/', 'https://example.org/'])
  })

  test('permission requests are denied', async ({ launch }) => {
    const { page } = await launch()
    const result = await page.evaluate(async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true })
        return 'granted'
      } catch (e) {
        return (e as Error).name
      }
    })
    expect(result).not.toBe('granted')
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
  })
})

test.describe('app:// protocol', () => {
  test('serves renderer assets with correct MIME types', async ({ launch }) => {
    const { page } = await launch()
    const assets: { re: RegExp; type: string }[] = [
      { re: /index\.html$/, type: 'text/html' },
      { re: /assets[\\/][^\\/]+\.js$/, type: 'text/javascript' },
      { re: /assets[\\/][^\\/]+\.css$/, type: 'text/css' },
      { re: /NotoSans-Regular[^\\/]*\.ttf$/, type: 'font/ttf' },
      { re: /pdfjs[\\/]cmaps[\\/][^\\/]+\.bcmap$/, type: 'application/octet-stream' },
      { re: /pdfjs[\\/]standard_fonts[\\/][^\\/]+\.pfb$/, type: 'application/x-font-type1' },
      { re: /pdfjs[\\/]wasm[\\/][^\\/]+\.wasm$/, type: 'application/wasm' },
      { re: /\.mjs$/, type: 'text/javascript' }
    ]
    let checked = 0
    for (const { re, type } of assets) {
      const asset = rendererAsset(re)
      if (!asset) {
        // The pdf.js worker (.mjs) only exists once the renderer imports pdf.js.
        expect(re.source === '\\.mjs$', `missing built asset ${re}`).toBe(true)
        continue
      }
      const res = await page.evaluate(async (url) => {
        const r = await fetch(new URL(url, document.baseURI))
        const buf = await r.arrayBuffer()
        return { status: r.status, type: r.headers.get('content-type'), size: buf.byteLength }
      }, asset.url)
      expect(res.status, asset.url).toBe(200)
      expect(res.type, asset.url).toContain(type)
      expect(res.size, asset.url).toBe(asset.size)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(7)
  })

  test('fonts load through @font-face under the custom scheme', async ({ launch }) => {
    const { page } = await launch()
    const font = rendererAsset(/NotoSerif-Bold-[^\\/]*\.ttf$/)!
    const loaded = await page.evaluate(async (url) => {
      const face = new FontFace('E2E Probe', `url(${new URL(url, document.baseURI).href})`)
      await face.load()
      return face.status
    }, font.url)
    expect(loaded).toBe('loaded')
  })

  test('rejects path traversal, unknown hosts and missing files', async ({ launch }) => {
    const { page } = await launch()
    const statuses = await page.evaluate(async () => {
      const urls = [
        'app://bundle/..%2f..%2fpackage.json',
        'app://bundle/%2e%2e/%2e%2e/package.json',
        'app://bundle/assets/..%2f..%2f..%2fpackage.json',
        'app://bundle/..%5c..%5cpackage.json',
        'app://bundle/does-not-exist.js',
        'app://bundle/assets/',
        'app://other/index.html'
      ]
      const out: Record<string, number> = {}
      for (const u of urls) {
        try {
          out[u] = (await fetch(u)).status
        } catch {
          out[u] = -1
        }
      }
      return out
    })
    for (const [url, status] of Object.entries(statuses)) {
      expect([403, 404, -1], url).toContain(status)
    }
  })
})

test.describe('document state', () => {
  test('setDocumentState updates the window title', async ({ launch }) => {
    const { app, page } = await launch()
    await setDocumentState(page, { title: 'Quarterly report.pdf', dirty: false, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toContain('Quarterly report.pdf')
    await setDocumentState(page, { title: 'Quarterly report.pdf', dirty: true, hasDocument: true, filePath: null })
    const platform = await app.evaluate(() => process.platform)
    const win = await app.browserWindow(page)
    if (platform === 'darwin') {
      await expect.poll(() => win.evaluate((w) => w.isDocumentEdited())).toBe(true)
    } else {
      await expect.poll(() => windowTitle(app, page)).toBe('*Quarterly report.pdf - Open PDF Editor')
    }
    await setDocumentState(page, { title: 'Open PDF Editor', dirty: false, hasDocument: false, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toBe('Open PDF Editor')
  })

  test('the real workspace reports the raw file name: title and close prompt are formatted once', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    const platform = await app.evaluate(() => process.platform)
    await expect(page.locator('[data-testid="page-count"]')).toHaveText('3', { timeout: 20_000 })
    const clean = platform === 'darwin' ? 'text-3pages.pdf' : 'text-3pages.pdf - Open PDF Editor'
    await expect.poll(() => windowTitle(app, page)).toBe(clean)

    await clickMenuItem(app, 'menu:rotate-cw') // make it dirty
    const win = await app.browserWindow(page)
    if (platform === 'darwin') {
      await expect.poll(() => win.evaluate((w) => w.isDocumentEdited())).toBe(true)
      expect(await windowTitle(app, page)).toBe('text-3pages.pdf')
    } else {
      await expect.poll(() => windowTitle(app, page)).toBe('*text-3pages.pdf - Open PDF Editor')
    }
    await mockMessageBox(app, 2) // Cancel
    await win.evaluate((w) => w.close())
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    const [prompt] = await dialogCalls(app, 'showMessageBox')
    expect(prompt.options.message).toBe('Do you want to save the changes you made to “text-3pages.pdf”?')
  })

  test('the page cannot change the window title through <title>', async ({ launch }) => {
    const { app, page } = await launch()
    await page.evaluate(() => (document.title = 'Spoofed'))
    await page.waitForTimeout(200)
    expect(await windowTitle(app, page)).toBe('Open PDF Editor')
  })
})

test.describe('application menu', () => {
  test('contains every MenuAction and standard accelerators', async ({ launch }) => {
    const { app } = await launch()
    const ids = await menuItemIds(app)
    for (const action of ALL_MENU_ACTIONS) expect(ids, action).toContain(`menu:${action}`)
    expect(ids).toContain('menu:open-recent')
    const platform = await app.evaluate(() => process.platform)
    const expected: Record<string, string> = {
      'menu:new': 'CmdOrCtrl+N',
      'menu:open': 'CmdOrCtrl+O',
      'menu:save': 'CmdOrCtrl+S',
      'menu:save-as': 'Shift+CmdOrCtrl+S',
      'menu:close-document': 'CmdOrCtrl+W',
      'menu:print': 'CmdOrCtrl+P',
      'menu:undo': 'CmdOrCtrl+Z',
      'menu:redo': platform === 'win32' ? 'Ctrl+Y' : 'Shift+CmdOrCtrl+Z',
      'menu:zoom-in': 'CmdOrCtrl+=',
      'menu:zoom-out': 'CmdOrCtrl+-',
      'menu:zoom-reset': 'CmdOrCtrl+0',
      'menu:find': 'CmdOrCtrl+F',
      'menu:rotate-cw': 'CmdOrCtrl+R',
      'menu:rotate-ccw': 'Shift+CmdOrCtrl+R'
    }
    for (const [id, accelerator] of Object.entries(expected)) {
      expect((await menuItem(app, id))?.accelerator, id).toBe(accelerator)
    }
    if (platform === 'win32') expect(ids).toContain('menu:redo:alt:Ctrl+Shift+Z')
  })

  test('document commands are disabled until a document is open', async ({ launch }) => {
    const { app, page } = await launch()
    await setDocumentState(page, { title: 'Open PDF Editor', dirty: false, hasDocument: false, filePath: null })
    await expect.poll(async () => (await menuItem(app, 'menu:save'))?.enabled).toBe(false)
    expect((await menuItem(app, 'menu:open'))?.enabled).toBe(true)
    expect((await menuItem(app, 'menu:new'))?.enabled).toBe(true)
    await setDocumentState(page, { title: 'a.pdf', dirty: false, hasDocument: true, filePath: null })
    await expect.poll(async () => (await menuItem(app, 'menu:save'))?.enabled).toBe(true)
    expect((await menuItem(app, 'menu:rotate-cw'))?.enabled).toBe(true)
  })

  test('clicking a menu item delivers the MenuAction to the renderer', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page)
    await setDocumentState(page, { title: 'a.pdf', dirty: false, hasDocument: true, filePath: null })
    await expect.poll(async () => (await menuItem(app, 'menu:zoom-in'))?.enabled).toBe(true)
    for (const id of ['menu:zoom-in', 'menu:rotate-cw', 'menu:undo', 'menu:redo', 'menu:open']) {
      await clickMenuItem(app, id)
    }
    await expect.poll(() => recordedMenuActions(page)).toEqual(['zoom-in', 'rotate-cw', 'undo', 'redo', 'open'])
  })

  test('Close closes the document first, then the window', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page)
    await setDocumentState(page, { title: 'a.pdf', dirty: false, hasDocument: true, filePath: null })
    await expect.poll(async () => (await menuItem(app, 'menu:save'))?.enabled).toBe(true)
    await clickMenuItem(app, 'menu:close-document')
    await expect.poll(() => recordedMenuActions(page)).toEqual(['close-document'])
    expect(await windowCount(app)).toBe(1)
  })

  test('New opens a second window when this one already has a document', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page)
    await setDocumentState(page, { title: 'a.pdf', dirty: false, hasDocument: true, filePath: null })
    await expect.poll(async () => (await menuItem(app, 'menu:save'))?.enabled).toBe(true)
    await recordEventsInNewWindows(app)
    const second = await nextWindow(app, () => clickMenuItem(app, 'menu:new'))
    expect(await windowCount(app)).toBe(2)
    expect(second).not.toBe(page)
    await expect.poll(() => recordedMenuActions(second)).toEqual(['new'])
    expect(await recordedMenuActions(page)).toEqual([])
  })
})
