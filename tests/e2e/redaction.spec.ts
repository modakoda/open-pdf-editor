/**
 * Redaction end to end: mark content (Redact tool, or every match of a search), save with the
 * "Apply redactions" confirmation and check that the saved file no longer contains it.
 */
import { statSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { copyFixture, expect, makeTempDir, test } from './helpers'
import { pdfContainsRaw, pdfPageTexts, pdfTextItems } from './pdf'

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)

async function openPage(page: Page): Promise<Locator> {
  const first = page.locator('[data-testid="page"][data-page-index="0"]')
  await expect(first.locator('canvas')).toBeVisible({ timeout: 20_000 })
  return first
}

/** Drag a rectangle given in page space (points, top-left origin) on a Letter page. */
async function dragArea(page: Page, pageEl: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await pageEl.boundingBox())!
  const scale = box.width / 612
  await page.mouse.move(box.x + from[0] * scale, box.y + from[1] * scale)
  await page.mouse.down()
  await page.mouse.move(box.x + ((from[0] + to[0]) / 2) * scale, box.y + ((from[1] + to[1]) / 2) * scale, { steps: 4 })
  await page.mouse.move(box.x + to[0] * scale, box.y + to[1] * scale, { steps: 4 })
  await page.mouse.up()
}

async function applyAndSave(page: Page, path: string, sanitize = false): Promise<void> {
  const before = statSync(path)
  await byTestId(page, 'btn-save').click()
  const dialog = page.locator('[data-testid="dialog"][data-dialog="redact"]')
  await expect(dialog).toBeVisible()
  if (sanitize) await byTestId(page, 'redact-sanitize').check()
  await byTestId(page, 'dialog-confirm').click()
  await expect
    .poll(() => {
      const s = statSync(path)
      return s.mtimeMs !== before.mtimeMs || s.size !== before.size
    }, { timeout: 20_000 })
    .toBe(true)
  await expect(byTestId(page, 'notice')).toContainText('Saved', { timeout: 20_000 })
}

test.describe('redaction', () => {
  test('redacts a word marked with the Redact tool', async ({ launch }) => {
    const file = await copyFixture('existing-content.pdf', makeTempDir())
    const { page } = await launch({ args: [file] })
    const pageEl = await openPage(page)
    await byTestId(page, 'tool-redact').click()
    // "Qty" in the table row: x 200.3–217.5, baseline 640 (page y 152), Helvetica 11.
    await dragArea(page, pageEl, [196, 141], [222, 156])
    const area = page.locator('[data-testid="redaction"]')
    await expect(area).toHaveCount(1)
    await expect(area).toHaveAttribute('data-selected', 'true')
    await expect(byTestId(page, 'redact-count')).toHaveText('1 area')

    await applyAndSave(page, file)
    const texts = await pdfPageTexts(file)
    expect(texts[0]).not.toContain('Qty')
    expect(texts[0]).toContain('Name')
    expect(texts[0]).toContain('Price')
    expect(texts[0]).toContain('Existing title')
    expect(await pdfContainsRaw(file, 'Qty')).toBe(false)
    // Neighbours stay where they were.
    const items = await pdfTextItems(file, 0)
    const price = items.find((i) => i.str.includes('Price'))!
    expect(price.x).toBeCloseTo(72 + 29.337 + 99 + 17.116 + 66, 1)
    // The saved file is shown: no marks left, the content under them is gone.
    await expect(page.locator('[data-testid="redaction"]')).toHaveCount(0)
  })

  test('redacts every match of a search', async ({ launch }) => {
    const file = await copyFixture('existing-content.pdf', makeTempDir())
    const { page } = await launch({ args: [file] })
    await openPage(page)
    await byTestId(page, 'btn-find').click()
    await byTestId(page, 'find-input').fill('line')
    await expect(byTestId(page, 'find-count')).toHaveText('1 of 2', { timeout: 20_000 })
    await byTestId(page, 'find-redact-all').click()
    await expect(page.locator('[data-testid="redaction"]')).toHaveCount(2)
    await expect(byTestId(page, 'tool-redact')).toHaveAttribute('data-active', 'true')

    await applyAndSave(page, file, true)
    const texts = await pdfPageTexts(file)
    expect(texts[0]).not.toContain('line')
    expect(texts[0]).toContain('Body')
    expect(texts[0]).toContain('one')
    expect(texts[0]).toContain('two')
    expect(await pdfContainsRaw(file, 'line')).toBe(false)
    expect(await pdfContainsRaw(file, 'Open PDF Editor')).toBe(false) // sanitized: no producer
  })
})
