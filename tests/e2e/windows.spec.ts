/**
 * Window lifecycle: close confirmation for unsaved changes, files opened from the OS
 * (argv, second instance, macOS open-file), new windows, recent files and saved bounds.
 */
import { join, relative } from 'node:path'
import { copyFileSync, symlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  ROOT,
  copyFixture,
  dialogCalls,
  expect,
  fixturePath,
  makeTempDir,
  mockMessageBox,
  mockOpenDialog,
  nextWindow,
  recordDesktopEvents,
  recordEventsInNewWindows,
  recordedOpenedFiles,
  setDocumentState,
  test,
  windowCount,
  windowTitle
} from './helpers'

/**
 * Resolves when `page` has received the file: either recorded by our listener or picked up by
 * the workspace UI (which subscribes first and reports the file name in the title).
 */
async function expectFileDelivered(app: ElectronApplication, page: Page, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const files = await recordedOpenedFiles(page)
        if (files.some((f) => f.name === name && f.head === '%PDF-')) return true
        return (await windowTitle(app, page)).includes(name.replace(/\.pdf$/i, ''))
      },
      { timeout: 15_000 }
    )
    .toBe(true)
}

async function closeWindow(app: ElectronApplication, page: Page): Promise<void> {
  const win = await app.browserWindow(page)
  await win.evaluate((w) => w.close())
}

/**
 * Blocks the page's main thread for `ms` (it cannot process IPC meanwhile). Resolves once the
 * blocking task is queued, so IPC sent afterwards waits for it.
 */
async function keepRendererBusy(page: Page, ms: number): Promise<void> {
  await page.evaluate((duration) => {
    setTimeout(() => {
      const end = Date.now() + duration
      while (Date.now() < end) {
        /* busy */
      }
    })
  }, ms)
}

test.describe('close confirmation', () => {
  test('a clean window closes without asking', async ({ launch }) => {
    const { app, page } = await launch()
    await setDocumentState(page, { title: 'a.pdf', dirty: false, hasDocument: true, filePath: null })
    const second = await nextWindow(app, () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('menu:new')!.click()))
    const closed = second.waitForEvent('close')
    await closeWindow(app, second)
    await closed
    expect(await dialogCalls(app, 'showMessageBox')).toEqual([])
    expect(await windowCount(app)).toBe(1)
  })

  test('Cancel keeps a dirty window open, Don’t Save closes it', async ({ launch }) => {
    const { app, page } = await launch()
    // A second window keeps the app alive on Windows/Linux when the first one closes.
    await setDocumentState(page, { title: 'draft.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(async () => (await app.browserWindow(page)).evaluate((w) => w.getTitle())).toContain('draft.pdf')
    await mockMessageBox(app, 2) // Cancel
    await closeWindow(app, page)
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    const [box] = await dialogCalls(app, 'showMessageBox')
    expect(box.options.buttons).toEqual(['Save', "Don't Save", 'Cancel'])
    expect(String(box.options.message)).toContain('draft.pdf')
    await page.waitForTimeout(300)
    expect(await windowCount(app)).toBe(1)

    await mockMessageBox(app, 1) // Don't Save
    const closed = page.waitForEvent('close')
    await closeWindow(app, page)
    await closed
  })

  test('Save asks the renderer to save and closes after confirmClose()', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page, { confirmCloseOnSave: true })
    await setDocumentState(page, { title: 'draft.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toContain('draft.pdf')
    await mockMessageBox(app, 0) // Save
    const closed = page.waitForEvent('close')
    await closeWindow(app, page)
    await closed
  })

  test('Save keeps the window open until the renderer confirms', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page, { confirmCloseOnSave: true })
    await setDocumentState(page, { title: 'draft.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toContain('draft.pdf')
    await mockMessageBox(app, 0) // Save
    await keepRendererBusy(page, 1500)
    await closeWindow(app, page)
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    await new Promise((r) => setTimeout(r, 400))
    expect(await windowCount(app)).toBe(1)
    // Once the renderer is free it saves (here: confirms at once) and the window closes.
    await page.waitForEvent('close', { timeout: 15_000 })
  })

  test('quitting asks about every dirty window and Cancel aborts the quit', async ({ launch }) => {
    const { app, page } = await launch()
    await setDocumentState(page, { title: 'one.pdf', dirty: true, hasDocument: true, filePath: null })
    const second = await nextWindow(app, () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('menu:new')!.click()))
    // Let the new window's UI create its blank document first, or its own state report races ours.
    await expect.poll(() => windowTitle(app, second)).toContain('Untitled')
    await setDocumentState(second, { title: 'two.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, second)).toContain('two.pdf')

    await mockMessageBox(app, 2) // Cancel on the first prompt
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    await page.waitForTimeout(300)
    expect(await windowCount(app)).toBe(2)

    // Don't Save for both: the app quits.
    await mockMessageBox(app, 1)
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await exited
  })
})

test.describe('files opened from the OS', () => {
  test('a PDF passed on the command line is delivered to the first window', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf', makeTempDir(), 'from-argv.pdf')
    const { app, page } = await launch({ args: [pdf] })
    // Subscribing late still receives the file (the preload buffers it until someone listens).
    await recordDesktopEvents(page)
    await expectFileDelivered(app, page, 'from-argv.pdf')
    expect(await windowCount(app)).toBe(1)
    expect(await page.evaluate(() => window.desktop!.getRecentFiles())).toContain(pdf)
    // The window may now save back to that file.
    await page.evaluate(async (p) => window.desktop!.writeFile(p, (await window.desktop!.readFile(p)).bytes), pdf)
  })

  test('file:// URLs on the command line (Linux file managers) are opened', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf', makeTempDir(), 'from uri ä.pdf')
    const { app, page } = await launch({ args: [pathToFileURL(pdf).href] })
    await recordDesktopEvents(page)
    await expectFileDelivered(app, page, 'from uri ä.pdf')
    expect(await page.evaluate(() => window.desktop!.getRecentFiles())).toContain(pdf)
  })

  test('relative argv paths are resolved; switches and non-PDF files are ignored', async ({ launch }) => {
    // The app is launched with cwd = repository root.
    const pdf = relative(ROOT, await fixturePath('form.pdf'))
    const { app, page } = await launch({ args: ['--some-switch', 'package.json', pdf] })
    await recordDesktopEvents(page)
    await expectFileDelivered(app, page, 'form.pdf')
    expect(await windowCount(app)).toBe(1)
  })

  test('second instance: empty window reuses, window with a document opens a new one', async ({ launch }) => {
    const { app, page } = await launch()
    await recordEventsInNewWindows(app)
    await recordDesktopEvents(page)
    await setDocumentState(page, { title: 'Open PDF Editor', dirty: false, hasDocument: false, filePath: null })
    const first = await fixturePath('text-3pages.pdf')
    const second = await fixturePath('rotated.pdf')
    const emitSecondInstance = (path: string) =>
      app.evaluate(({ app: electronApp }, p) => {
        electronApp.emit('second-instance', {}, [process.execPath, p], process.cwd(), {})
      }, path)

    await emitSecondInstance(first)
    await expectFileDelivered(app, page, 'text-3pages.pdf')
    expect(await windowCount(app)).toBe(1)

    await setDocumentState(page, { title: 'text-3pages.pdf', dirty: false, hasDocument: true, filePath: first })
    const other = await nextWindow(app, () => emitSecondInstance(second))
    expect(await windowCount(app)).toBe(2)
    await expectFileDelivered(app, other, 'rotated.pdf')
    expect((await recordedOpenedFiles(page)).map((f) => f.name)).not.toContain('rotated.pdf')
  })

  test('macOS open-file events are routed like second-instance files', async ({ launch }) => {
    const { app, page } = await launch()
    test.skip((await app.evaluate(() => process.platform)) !== 'darwin', 'macOS only')
    await recordDesktopEvents(page)
    const pdf = await fixturePath('mixed-sizes.pdf')
    await app.evaluate(({ app: electronApp }, p) => {
      electronApp.emit('open-file', { preventDefault() {} }, p)
    }, pdf)
    await expectFileDelivered(app, page, 'mixed-sizes.pdf')
  })

  test('openInNewWindow opens a granted file in a new window and rejects others', async ({ launch }) => {
    const { app, page } = await launch()
    await recordEventsInNewWindows(app)
    const pdf = await fixturePath('annotated.pdf')
    const denied = await page.evaluate(async (p) => {
      try {
        await window.desktop!.openInNewWindow(p)
        return 'opened'
      } catch (e) {
        return String((e as Error).message)
      }
    }, pdf)
    expect(denied).toMatch(/denied/i)
    expect(await windowCount(app)).toBe(1)

    // This window shows another document; the user picks a PDF (e.g. Insert Pages / Open).
    await setDocumentState(page, { title: 'other.pdf', dirty: false, hasDocument: true, filePath: null })
    await mockOpenDialog(app, [pdf])
    await page.evaluate(() => window.desktop!.openPdfDialog())
    const other = await nextWindow(app, () => page.evaluate((p) => window.desktop!.openInNewWindow(p), pdf))
    await expectFileDelivered(app, other, 'annotated.pdf')

    const empty = await nextWindow(app, () => page.evaluate(() => window.desktop!.openInNewWindow(null)))
    expect(await windowCount(app)).toBe(3)
    expect(await windowTitle(app, empty)).toBe('Open PDF Editor')
  })
})

test.describe('closing after a failed save', () => {
  test('cancelClose() keeps the window open and the next close asks again', async ({ launch }) => {
    const { app, page } = await launch()
    await page.evaluate(() => {
      const e2e = (window.__e2e ??= {})
      e2e.saveRequests = 0
      // Like the renderer when its Save fails or the Save As dialog is cancelled.
      window.desktop!.onSaveBeforeClose(() => {
        e2e.saveRequests = (e2e.saveRequests as number) + 1
        window.desktop!.cancelClose!()
      })
    })
    await setDocumentState(page, { title: 'draft.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toContain('draft.pdf')
    await mockMessageBox(app, 0) // Save
    await closeWindow(app, page)
    await expect.poll(() => page.evaluate(() => window.__e2e?.saveRequests)).toBe(1)
    await page.waitForTimeout(300)
    expect(await windowCount(app)).toBe(1)

    // The window is not stuck: closing again asks again.
    await mockMessageBox(app, 2) // Cancel
    await closeWindow(app, page)
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(2)
    expect(await windowCount(app)).toBe(1)
    await mockMessageBox(app, 1) // Don't Save
    const closed = page.waitForEvent('close')
    await closeWindow(app, page)
    await closed
  })

  test('closing again before the renderer answered Save asks again instead of hanging', async ({ launch }) => {
    const { app, page } = await launch()
    await setDocumentState(page, { title: 'draft.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toContain('draft.pdf')
    await mockMessageBox(app, 0) // Save
    await keepRendererBusy(page, 3000) // it cannot answer saveBeforeClose yet
    await closeWindow(app, page)
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    await mockMessageBox(app, 1) // Don't Save
    await closeWindow(app, page)
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox').catch(() => [])).length).toBe(2)
    await expect.poll(() => windowCount(app).catch(() => 0), { timeout: 15_000 }).toBe(0)
  })

  test('a reload forgets a pending save-before-close', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page, { confirmCloseOnSave: false })
    await setDocumentState(page, { title: 'draft.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, page)).toContain('draft.pdf')
    await mockMessageBox(app, 0) // Save
    await closeWindow(app, page)
    await expect.poll(() => page.evaluate(() => window.__e2e?.saveBeforeClose)).toBe(1)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => windowTitle(app, page)).toBe('Open PDF Editor')
    // The reloaded page has no document, so the window closes without asking again.
    const second = await nextWindow(app, () => page.evaluate(() => window.desktop!.openInNewWindow(null)))
    const closed = page.waitForEvent('close')
    await closeWindow(app, page)
    await closed
    expect((await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    expect(await windowCount(app)).toBe(1)
    void second
  })

  test('a cancelled save while quitting aborts the quit; quitting again asks again', async ({ launch }) => {
    const { app, page } = await launch()
    await page.evaluate(() => window.desktop!.onSaveBeforeClose(() => window.desktop!.cancelClose!()))
    await setDocumentState(page, { title: 'one.pdf', dirty: true, hasDocument: true, filePath: null })
    const second = await nextWindow(app, () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('menu:new')!.click()))
    // Let the new window's UI create its blank document first, or its own state report races ours.
    await expect.poll(() => windowTitle(app, second)).toContain('Untitled')
    await setDocumentState(second, { title: 'two.pdf', dirty: true, hasDocument: true, filePath: null })
    await expect.poll(() => windowTitle(app, second)).toContain('two.pdf')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0].focus())

    await mockMessageBox(app, 0) // Save → the renderer cancels
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    await page.waitForTimeout(500)
    expect(await windowCount(app)).toBe(2)
    expect((await dialogCalls(app, 'showMessageBox')).length).toBe(1)

    await mockMessageBox(app, 1) // Don't Save for both
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await exited
  })
})

test.describe('one window per file', () => {
  test('opening a file that a window already shows focuses that window', async ({ launch }) => {
    const { app, page } = await launch()
    const dir = makeTempDir()
    const pdf = await copyFixture('text-3pages.pdf', dir, 'shown.pdf')
    await mockOpenDialog(app, [pdf])
    await page.evaluate(() => window.desktop!.openPdfDialog())
    await setDocumentState(page, { title: 'shown.pdf', dirty: false, hasDocument: true, filePath: pdf })
    const emitSecondInstance = (path: string) =>
      app.evaluate(({ app: electronApp }, p) => {
        electronApp.emit('second-instance', {}, [process.execPath, p], process.cwd(), {})
      }, path)

    await emitSecondInstance(pdf)
    await page.waitForTimeout(500)
    expect(await windowCount(app)).toBe(1)

    const platform = await app.evaluate(() => process.platform)
    if (platform !== 'win32') {
      const link = join(dir, 'alias.pdf')
      symlinkSync(pdf, link)
      await emitSecondInstance(link)
    }
    // Case-insensitive file systems (macOS, Windows): another spelling of the same path.
    if (platform !== 'linux') await emitSecondInstance(pdf.toUpperCase())
    await page.waitForTimeout(500)
    expect(await windowCount(app)).toBe(1)

    // openInNewWindow() from another window and File > Open Recent behave the same.
    const empty = await nextWindow(app, () => page.evaluate(() => window.desktop!.openInNewWindow(null)))
    await empty.evaluate((p) => window.desktop!.openInNewWindow(p), pdf)
    await app.evaluate(({ Menu }) => {
      const recent = Menu.getApplicationMenu()!.getMenuItemById('menu:open-recent')!.submenu!.items
      recent.find((i) => i.label === 'shown.pdf')!.click()
    })
    await page.waitForTimeout(500)
    expect(await windowCount(app)).toBe(2)
  })

  test('an OS open while the window loads a file from the Open dialog goes to a new window', async ({ launch }) => {
    const { app, page } = await launch()
    await recordDesktopEvents(page)
    await recordEventsInNewWindows(app)
    await mockOpenDialog(app, [await fixturePath('form.pdf')])
    // The renderer now parses the chosen file; it has not reported a document yet.
    await page.evaluate(() => window.desktop!.openPdfDialog())
    const osFile = await fixturePath('rotated.pdf')
    const other = await nextWindow(app, () =>
      app.evaluate(({ app: electronApp }, p) => {
        electronApp.emit('second-instance', {}, [process.execPath, p], process.cwd(), {})
      }, osFile)
    )
    await expectFileDelivered(app, other, 'rotated.pdf')
    expect(await windowCount(app)).toBe(2)
    expect((await recordedOpenedFiles(page)).map((f) => f.name)).not.toContain('rotated.pdf')
  })
})

test.describe('persistence', () => {
  test('recent files persist across launches and skip missing files', async ({ launch }) => {
    const profile = makeTempDir('ope-profile-')
    const dir = makeTempDir()
    const keep = join(dir, 'keep.pdf')
    const gone = join(dir, 'gone.pdf')
    copyFileSync(await fixturePath('text-3pages.pdf'), keep)
    copyFileSync(await fixturePath('text-3pages.pdf'), gone)

    const first = await launch({ userDataDir: profile, args: [gone] })
    await recordEventsInNewWindows(first.app)
    await recordDesktopEvents(first.page)
    await expectFileDelivered(first.app, first.page, 'gone.pdf')
    await setDocumentState(first.page, { title: 'gone.pdf', dirty: false, hasDocument: true, filePath: gone })
    const second = await nextWindow(first.app, () =>
      first.app.evaluate(({ app: electronApp }, p) => electronApp.emit('second-instance', {}, [process.execPath, p], process.cwd(), {}), keep)
    )
    await expectFileDelivered(first.app, second, 'keep.pdf')
    expect(await first.page.evaluate(() => window.desktop!.getRecentFiles())).toEqual([keep, gone])
    const recentMenu = await first.app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.getMenuItemById('menu:open-recent')!.submenu!.items.map((i) => i.label)
    )
    expect(recentMenu).toContain('keep.pdf')
    await first.close()

    const { rmSync } = await import('node:fs')
    rmSync(gone)
    const relaunched = await launch({ userDataDir: profile })
    expect(await relaunched.page.evaluate(() => window.desktop!.getRecentFiles())).toEqual([keep])
    // A recent file can be read (e.g. from the welcome screen) without a dialog.
    const size = await relaunched.page.evaluate(async (p) => (await window.desktop!.readFile(p)).bytes.length, keep)
    expect(size).toBeGreaterThan(0)
  })

  test('window bounds are restored on the next launch', async ({ launch }) => {
    const profile = makeTempDir('ope-profile-')
    const first = await launch({ userDataDir: profile })
    const target = await first.app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea
      const bounds = { x: area.x + 40, y: area.y + 40, width: 900, height: 640 }
      BrowserWindow.getAllWindows()[0].setBounds(bounds)
      return BrowserWindow.getAllWindows()[0].getBounds()
    })
    await first.page.waitForTimeout(800)
    await first.close()
    const second = await launch({ userDataDir: profile })
    const bounds = await (await second.app.browserWindow(second.page)).evaluate((w) => w.getBounds())
    expect(bounds.width).toBe(target.width)
    expect(bounds.height).toBe(target.height)
    expect(Math.abs(bounds.x - target.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(bounds.y - target.y)).toBeLessThanOrEqual(30)
  })
})
