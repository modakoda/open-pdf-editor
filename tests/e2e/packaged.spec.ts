/**
 * Smoke test for a packaged app (electron-builder output). Skipped unless OPE_PACKAGED_APP points
 * to the app executable, e.g.
 *   OPE_PACKAGED_APP="release/mac-arm64/Open PDF Editor.app/Contents/MacOS/Open PDF Editor" npx playwright test packaged
 *   OPE_PACKAGED_APP=release/linux-unpacked/open-pdf-editor   (Linux)
 *   OPE_PACKAGED_APP="release/win-unpacked/Open PDF Editor.exe" (Windows)
 */
import { resolve } from 'node:path'
import { copyFixture, expect, test, windowTitle } from './helpers'

const executablePath = process.env.OPE_PACKAGED_APP ? resolve(process.env.OPE_PACKAGED_APP) : undefined

test.describe('packaged app', () => {
  test.skip(!executablePath, 'set OPE_PACKAGED_APP to the packaged executable')

  test('starts, serves the renderer from app.asar and opens a PDF', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ executablePath, args: [pdf] })
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
    expect(page.url()).toBe('app://bundle/index.html')
    expect(await page.evaluate(() => typeof window.desktop?.openPdfDialog)).toBe('function')
    const worker = await page.evaluate(async () => {
      const res = await fetch(new URL('index.html', document.baseURI))
      return { status: res.status, type: res.headers.get('content-type') }
    })
    expect(worker).toEqual({ status: 200, type: 'text/html; charset=utf-8' })
    await expect(page.locator('[data-testid="page-count"]')).toHaveText('3', { timeout: 30_000 })
    await expect.poll(() => windowTitle(app, page)).toContain('text-3pages')
  })

  test('recognizes text with the bundled OCR engine and language data', async ({ launch }) => {
    test.setTimeout(120_000)
    const pdf = await copyFixture('scanned.pdf')
    const { page } = await launch({ executablePath, args: [pdf] })
    await expect(page.locator('[data-testid="page-count"]')).toHaveText('1', { timeout: 30_000 })
    await page.locator('[data-testid="btn-ocr"]').click()
    const dialog = page.locator('[data-testid="dialog"][data-dialog="ocr"]')
    await dialog.locator('[data-testid="dialog-confirm"]').click()
    await expect(dialog).toBeHidden({ timeout: 90_000 })
    await expect(page.locator('[data-testid="notice"]')).toContainText('Recognized text on 1 page')
  })
})
