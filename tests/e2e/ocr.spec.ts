/**
 * Text recognition (OCR) in the real app: the bundled tesseract.js worker, WebAssembly core and
 * language data load from the app:// origin under the app's CSP (offline), a scanned page is
 * detected on open, recognized, searchable in Find, and the saved file has an invisible text
 * layer that other viewers can search.
 */
import { statSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { copyFixture, expect, makeTempDir, test } from './helpers'
import { pdfPageTexts, pdfTextItems } from './pdf'

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)

async function saveInPlace(page: Page, path: string): Promise<void> {
  const before = statSync(path)
  await byTestId(page, 'btn-save').click()
  await expect
    .poll(() => {
      const s = statSync(path)
      return s.mtimeMs !== before.mtimeMs || s.size !== before.size
    }, { timeout: 20_000 })
    .toBe(true)
}

test.describe('text recognition', () => {
  test('recognizes a scanned page offline and saves a searchable file', async ({ launch }) => {
    test.setTimeout(120_000)
    const file = await copyFixture('scanned.pdf', makeTempDir())
    const first = await launch({ args: [file] })
    const { page } = first
    // Nothing may be fetched from outside the app (no CDN for the worker, core or language data).
    const external: string[] = []
    page.on('request', (r) => {
      if (!/^(app|data|blob|devtools|chrome-extension):/.test(r.url())) external.push(r.url())
    })
    await expect(page.locator('[data-testid="page"][data-page-index="0"] canvas')).toBeVisible({ timeout: 20_000 })

    // The scanned page is detected and OCR is offered.
    const notice = byTestId(page, 'notice')
    await expect(notice).toContainText('scanned', { timeout: 20_000 })
    await byTestId(page, 'notice-action').click()
    const dialog = page.locator('[data-testid="dialog"][data-dialog="ocr"]')
    await expect(dialog).toBeVisible()
    await dialog.locator('[data-testid="ocr-lang-eng"]').check()
    await dialog.locator('[data-testid="ocr-lang-lit"]').check()
    await dialog.locator('[data-testid="dialog-confirm"]').click()
    await expect(byTestId(page, 'ocr-progress')).toBeVisible()
    await expect(dialog).toBeHidden({ timeout: 90_000 })
    await expect(notice).toContainText('Recognized text on 1 page')

    // Find searches the recognized text.
    await byTestId(page, 'btn-find').click()
    await page.locator('[data-testid="find-input"]').fill('brown fox')
    await expect(page.locator('[data-testid="find-count"]')).toContainText('1 of 1', { timeout: 20_000 })

    // Recognized lines show up in Edit content; one becomes editable text.
    await byTestId(page, 'tool-edit-content').click()
    const line = page.locator('[data-testid="ocr-line"][title*="Thank you"]').first()
    await expect(line).toBeVisible()
    await line.click()
    await expect(byTestId(page, 'ocr-line-text')).toContainText('Thank you for your business')
    await byTestId(page, 'ocr-make-editable').click()
    await expect(page.locator('[data-testid="object"][data-object-type="text"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="object"][data-object-type="whiteout"]')).toHaveCount(1)

    await saveInPlace(page, file)
    const [text] = await pdfPageTexts(file)
    const flat = text.replace(/\s+/g, ' ')
    expect(flat).toContain('quick brown fox')
    expect(flat).toMatch(/Total amount due/)
    expect(flat).toContain('Thank you for your business')
    // The invisible words sit on the scanned lines (the page is 420×260 pt; "The quick…" is
    // printed with its baseline about 100 pt below the top edge, 36 pt from the left).
    const items = await pdfTextItems(file, 0)
    const quick = items.find((i) => i.str.includes('quick') || i.str === 'The')!
    expect(quick).toBeDefined()
    expect(Math.abs(quick.y - (260 - 100))).toBeLessThan(6)
    expect(quick.x).toBeGreaterThan(30)
    expect(quick.x).toBeLessThan(80)
    expect(external).toEqual([])
    await first.close()

    // Reopened: the recognized text is restored (searchable, no new offer), and saving again
    // replaces the invisible layer instead of adding a second one.
    const second = await launch({ args: [file] })
    await expect(second.page.locator('[data-testid="page"][data-page-index="0"] canvas')).toBeVisible({ timeout: 20_000 })
    await byTestId(second.page, 'btn-find').click()
    await second.page.locator('[data-testid="find-input"]').fill('total amount')
    await expect(second.page.locator('[data-testid="find-count"]')).toContainText('1 of 1', { timeout: 20_000 })
    await second.page.keyboard.press('Escape')
    await byTestId(second.page, 'tool-edit-content').click()
    await expect(second.page.locator('[data-testid="ocr-line"]')).toHaveCount(4)
    await expect(byTestId(second.page, 'notice-action')).toHaveCount(0)
    await byTestId(second.page, 'btn-rotate-cw').click()
    await saveInPlace(second.page, file)
    const again = (await pdfPageTexts(file))[0].replace(/\s+/g, ' ')
    expect(again.match(/quick brown fox/g)).toHaveLength(1)
    expect(again.match(/Thank you for your business/g)).toHaveLength(1)
  })
})
