/**
 * End-to-end editor flows through the real workspace UI (test ids from docs/ARCHITECTURE.md).
 * Run only these with: npx playwright test -g "editor UI"
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  clickMenuItem,
  copyFixture,
  dialogCalls,
  expect,
  makeTempDir,
  mockMessageBox,
  mockOpenDialog,
  mockSaveDialog,
  nextWindow,
  settledBox,
  test,
  windowCount,
  windowTitle
} from './helpers'
import { pdfPageCount, pdfPageTexts, pdfRotations, pdfTextFieldValue } from './pdf'

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)

async function expectPageCount(page: Page, count: number): Promise<void> {
  await expect(byTestId(page, 'page-count')).toHaveText(String(count), { timeout: 20_000 })
}

/** Waits for the file on disk to change (mtime/size) after a save. */
async function waitForWrite(path: string, before: { mtimeMs: number; size: number }): Promise<void> {
  await expect
    .poll(() => {
      const s = statSync(path)
      return s.mtimeMs !== before.mtimeMs || s.size !== before.size
    }, { timeout: 20_000 })
    .toBe(true)
}

async function firstPage(page: Page) {
  const p = page.locator('[data-testid="page"][data-page-index="0"]')
  await expect(p).toBeVisible({ timeout: 20_000 })
  return p
}

async function expectDirty(app: ElectronApplication, page: Page, dirty: boolean): Promise<void> {
  const platform = await app.evaluate(() => process.platform)
  if (platform === 'darwin') {
    const win = await app.browserWindow(page)
    await expect.poll(() => win.evaluate((w) => w.isDocumentEdited())).toBe(dirty)
  } else {
    await expect.poll(async () => (await windowTitle(app, page)).startsWith('*')).toBe(dirty)
  }
}

test.describe('editor UI', () => {
  test('opens a PDF passed on the command line', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    await expect(page.locator('[data-testid="page"]')).toHaveCount(3)
    await expect.poll(() => windowTitle(app, page)).toContain('text-3pages')
    await expect(byTestId(page, 'welcome')).toHaveCount(0)
  })

  test('opens a PDF from the welcome screen with the Open dialog', async ({ launch }) => {
    const { app, page } = await launch()
    await expect(byTestId(page, 'welcome')).toBeVisible({ timeout: 20_000 })
    await mockOpenDialog(app, [await copyFixture('text-10pages.pdf')])
    await byTestId(page, 'welcome-open').click()
    await expectPageCount(page, 10)
    await expect(page.locator('[data-testid="thumbnail"]')).toHaveCount(10)
  })

  test('opens a PDF via the File > Open menu', async ({ launch }) => {
    const { app, page } = await launch()
    await expect(byTestId(page, 'welcome')).toBeVisible({ timeout: 20_000 })
    await mockOpenDialog(app, [await copyFixture('mixed-sizes.pdf')])
    await clickMenuItem(app, 'menu:open')
    await expectPageCount(page, 3)
  })

  test('the page and document bar shows every button at common window widths', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expect(page.locator('[data-testid="page-count"]')).toHaveText('3', { timeout: 20_000 })
    for (const width of [1440, 1280, 1100, 900]) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 800), width)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      const overflow = await page.evaluate(() => {
        const bar = document.querySelector('.subbar')!
        return bar.scrollWidth - bar.clientWidth
      })
      expect(overflow, `hidden buttons at ${width}px`).toBeLessThanOrEqual(0)
    }
  })

  test('rotates a page, then undoes and redoes it', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    const p0 = await firstPage(page)
    await expect(p0).toHaveAttribute('data-rotation', '0')
    await page.locator('[data-testid="thumbnail"][data-page-index="0"]').click()
    await byTestId(page, 'btn-rotate-cw').click()
    await expect(p0).toHaveAttribute('data-rotation', '90')
    await expect(page.locator('[data-testid="page"][data-page-index="1"]')).toHaveAttribute('data-rotation', '0')
    await expectDirty(app, page, true)

    await byTestId(page, 'btn-undo').click()
    await expect(p0).toHaveAttribute('data-rotation', '0')
    await byTestId(page, 'btn-redo').click()
    await expect(p0).toHaveAttribute('data-rotation', '90')

    // The same through the application menu (undo/redo are MenuActions).
    await clickMenuItem(app, 'menu:undo')
    await expect(p0).toHaveAttribute('data-rotation', '0')
    await clickMenuItem(app, 'menu:redo')
    await expect(p0).toHaveAttribute('data-rotation', '90')
    await clickMenuItem(app, 'menu:rotate-ccw')
    await expect(p0).toHaveAttribute('data-rotation', '0')
  })

  test('saves a rotation back to the opened file', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    await firstPage(page)
    await page.locator('[data-testid="thumbnail"][data-page-index="1"]').click()
    await byTestId(page, 'btn-rotate-cw').click()
    await expect(page.locator('[data-testid="page"][data-page-index="1"]')).toHaveAttribute('data-rotation', '90')
    const before = statSync(pdf)
    await byTestId(page, 'btn-save').click()
    await waitForWrite(pdf, before)
    expect(await pdfRotations(pdf)).toEqual([0, 90, 0])
    await expectDirty(app, page, false)
  })

  test('adds a text object and saves it with Save As', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    const p0 = await firstPage(page)
    await byTestId(page, 'tool-text').click()
    const overlay = p0.locator('[data-testid="page-overlay"]')
    const box = await settledBox(overlay)
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4)
    const editor = byTestId(page, 'text-object-editor')
    await expect(editor).toBeVisible()
    await editor.pressSequentially('Hello from e2e')
    await editor.press('Escape')
    await expect(p0.locator('[data-testid="object"][data-object-type="text"]')).toHaveCount(1)

    const target = join(makeTempDir(), 'with-text.pdf')
    await mockSaveDialog(app, target)
    await byTestId(page, 'btn-save-as').click()
    await expect.poll(() => statSync(target, { throwIfNoEntry: false })?.size ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)
    const texts = await pdfPageTexts(target)
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('Hello from e2e')
    expect(texts[0]).toContain('Page 1')
    expect((await dialogCalls(app, 'showSaveDialog')).length).toBe(1)
    await expect.poll(() => windowTitle(app, page)).toContain('with-text')
  })

  test('saves non-Latin text with the bundled fonts', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    const p0 = await firstPage(page)
    await byTestId(page, 'tool-text').click()
    const box = await settledBox(p0.locator('[data-testid="page-overlay"]'))
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5)
    const editor = byTestId(page, 'text-object-editor')
    await expect(editor).toBeVisible()
    await editor.pressSequentially('Ąžuolynas Šiauliai Ελληνικά')
    await editor.press('Escape')
    const before = statSync(pdf)
    await byTestId(page, 'btn-save').click()
    await waitForWrite(pdf, before)
    const [first] = await pdfPageTexts(pdf)
    expect(first.replace(/\s+/g, ' ')).toContain('Ąžuolynas Šiauliai Ελληνικά')
  })

  test('fills a form field and saves the value', async ({ launch }) => {
    const pdf = await copyFixture('form.pdf')
    const { page } = await launch({ args: [pdf] })
    await expectPageCount(page, 2)
    const field = page.locator('[data-testid="form-field"][data-field-name="name"]')
    await expect(field).toBeVisible({ timeout: 20_000 })
    await field.fill('Ada Lovelace')
    await field.blur()
    const before = statSync(pdf)
    await byTestId(page, 'btn-save').click()
    await waitForWrite(pdf, before)
    expect(await pdfTextFieldValue(pdf, 'name')).toBe('Ada Lovelace')
    expect(await pdfTextFieldValue(pdf, 'readonly')).toBe('fixed')
    expect(await pdfPageCount(pdf)).toBe(2)
  })

  test('a cancelled Save As in the close prompt keeps the window, and closing again asks again', async ({ launch }) => {
    const { app, page } = await launch()
    await expect(byTestId(page, 'welcome')).toBeVisible({ timeout: 20_000 })
    await clickMenuItem(app, 'menu:new')
    await expectPageCount(page, 1)
    await clickMenuItem(app, 'menu:insert-blank-page')
    await expectPageCount(page, 2)
    await expectDirty(app, page, true)

    await mockMessageBox(app, 0) // Save → Save As dialog …
    await mockSaveDialog(app, null) // … cancelled
    const win = await app.browserWindow(page)
    await win.evaluate((w) => w.close())
    await expect.poll(async () => (await dialogCalls(app, 'showSaveDialog')).length).toBe(1)
    await page.waitForTimeout(500)
    expect(await windowCount(app)).toBe(1)
    await expectPageCount(page, 2)

    await mockMessageBox(app, 1) // Don't Save
    const closed = page.waitForEvent('close')
    await win.evaluate((w) => w.close())
    await closed
    expect((await dialogCalls(app, 'showMessageBox').catch(() => [{}, {}])).length).toBe(2)
  })

  test('New with a document open opens a second window and never replaces the document', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    // The workspace leaves Cmd/Ctrl+N to the application menu in the desktop app (where the
    // accelerator may or may not see this synthetic key press, depending on the platform).
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n')
    await page.waitForTimeout(800)
    await expectPageCount(page, 3)
    await expect.poll(() => windowTitle(app, page)).toContain('text-3pages')
    const afterKey = await windowCount(app)
    expect([1, 2]).toContain(afterKey)

    // File > New, chosen in the window that shows the document.
    const second = await nextWindow(app, () =>
      app.evaluate(({ Menu, BrowserWindow }) => {
        const first = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0]
        Menu.getApplicationMenu()!.getMenuItemById('menu:new')!.click(undefined, first, first.webContents)
      })
    )
    await expectPageCount(second, 1)
    await expect.poll(() => windowTitle(app, second)).toContain('Untitled')
    await expectPageCount(page, 3)
    expect(await windowCount(app)).toBe(afterKey + 1)
  })

  test('Cmd/Ctrl+Z in the text editor undoes typing, not the document', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    const p0 = await firstPage(page)
    await byTestId(page, 'tool-text').click()
    const box = await settledBox(p0.locator('[data-testid="page-overlay"]'))
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4)
    const editor = byTestId(page, 'text-object-editor')
    await expect(editor).toBeVisible()
    await editor.pressSequentially('hello world')
    await expect(editor).toHaveValue('hello world')

    // A real key press through Chromium's input pipeline (as typed by the user).
    const sendUndo = (shift = false) =>
      app.evaluate(
        ({ BrowserWindow }, { mac, shift }) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents
          const modifiers: ('meta' | 'control' | 'shift')[] = [mac ? 'meta' : 'control', ...(shift ? (['shift'] as const) : [])]
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers })
        },
        { mac: process.platform === 'darwin', shift }
      )
    await sendUndo()
    await expect.poll(() => editor.inputValue()).not.toBe('hello world')
    const undone = await editor.inputValue()
    expect('hello world'.startsWith(undone)).toBe(true)
    // Edit > Undo from the menu also edits the text (a click right after the key press would be
    // taken for the key's own menu echo, so wait like a user would).
    await page.waitForTimeout(400)
    await clickMenuItem(app, 'menu:undo')
    await expect.poll(async () => (await editor.inputValue()).length).toBeLessThan(undone.length)
    // Shift+Cmd/Ctrl+Z redoes in the field.
    const beforeRedo = (await editor.inputValue()).length
    await page.waitForTimeout(400)
    await sendUndo(true)
    await expect.poll(async () => (await editor.inputValue()).length).toBeGreaterThan(beforeRedo)
    await expect(editor).toBeVisible()
    await expect(p0.locator('[data-testid="object"][data-object-type="text"]')).toHaveCount(1)
  })

  test('closing a window with unsaved edits asks first', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    await firstPage(page)
    await page.locator('[data-testid="thumbnail"][data-page-index="0"]').click()
    await byTestId(page, 'btn-rotate-cw').click()
    await expectDirty(app, page, true)
    await mockMessageBox(app, 2) // Cancel
    await (await app.browserWindow(page)).evaluate((w) => w.close())
    await expect.poll(async () => (await dialogCalls(app, 'showMessageBox')).length).toBe(1)
    await expect(byTestId(page, 'page-count')).toHaveText('3')

    // Save: the renderer saves to the file and the window closes.
    await mockMessageBox(app, 0)
    const before = statSync(pdf)
    const closed = page.waitForEvent('close')
    await (await app.browserWindow(page)).evaluate((w) => w.close())
    await closed
    await waitForWrite(pdf, before)
    expect(await pdfRotations(pdf)).toEqual([90, 0, 0])
  })
})
