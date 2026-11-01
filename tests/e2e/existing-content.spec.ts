/**
 * End-to-end flows for editing what already exists in a PDF: page content (Edit content),
 * existing annotations, existing form fields (Prepare form), and editor objects that stay
 * editable after save + reopen. Every test saves and inspects the real file on disk.
 */
import { statSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { copyFixture, expect, makeTempDir, settledBox, test } from './helpers'
import { pdfAnnotationSubtypes, pdfFieldRects, pdfPageTexts, pdfPaintOrder, pdfTextItems, type PaintedItem } from './pdf'

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)

async function openPage(page: Page): Promise<Locator> {
  const first = page.locator('[data-testid="page"][data-page-index="0"]')
  await expect(first.locator('canvas')).toBeVisible({ timeout: 20_000 })
  return first
}

async function drag(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const box = await settledBox(target)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

async function saveInPlace(page: Page, path: string): Promise<void> {
  const before = statSync(path)
  await byTestId(page, 'btn-save').click()
  await expect
    .poll(() => {
      const s = statSync(path)
      return s.mtimeMs !== before.mtimeMs || s.size !== before.size
    }, { timeout: 20_000 })
    .toBe(true)
  await expect(byTestId(page, 'notice')).toContainText('Saved', { timeout: 20_000 })
}

test.describe('editing existing content', () => {
  test('moves, deletes and retypes text that is already in the page', async ({ launch }) => {
    const file = await copyFixture('existing-content.pdf', makeTempDir())
    const { page } = await launch({ args: [file] })
    await openPage(page)
    await byTestId(page, 'tool-edit-content').click()

    const title = page.locator('[data-testid="content-item"][data-kind="text"][title*="Existing title"]').first()
    await expect(title).toBeAttached({ timeout: 20_000 })
    await title.click()
    await expect(title).toHaveAttribute('data-selected', 'true')
    await drag(page, title, 120, 0)

    const bodyLine = page.locator('[data-testid="content-item"][title*="Body line one"]').first()
    await bodyLine.click()
    await page.keyboard.press('Delete')
    await expect(page.locator('[data-testid="content-item"][title*="Body line one"]')).toHaveCount(0)

    const qty = page.locator('[data-testid="content-item"][title*="“Qty”"]').first()
    await qty.dblclick()
    const editor = byTestId(page, 'content-text-editor')
    await expect(editor).toBeVisible()
    await editor.fill('Amount')
    await editor.press('Enter')

    await saveInPlace(page, file)
    const items = await pdfTextItems(file, 0)
    const strs = items.map((i) => i.str)
    expect(strs.join(' ')).not.toContain('Body line one')
    expect(strs.join(' ')).toContain('Body line two')
    expect(strs.join(' ')).toContain('Amount')
    expect(strs.join(' ')).not.toContain('Qty')
    const savedTitle = items.find((i) => i.str.includes('Existing title'))!
    expect(savedTitle.x).toBeGreaterThan(72 + 40) // moved right from x = 72
    expect(savedTitle.y).toBeCloseTo(720, 0) // same baseline
  })

  test('a moved image stays under a rectangle drawn after it until brought to the front', async ({ launch }) => {
    const file = await copyFixture('existing-content.pdf', makeTempDir())
    const { page } = await launch({ args: [file] })
    await openPage(page)
    await byTestId(page, 'tool-edit-content').click()
    // Without text: the image (x 72) and the yellow rectangle (300..450 × 500..550) after it.
    const graphics = (painted: PaintedItem[]) => painted.filter((p) => p.kind !== 'text')
    expect(graphics(await pdfPaintOrder(file, 0)).map((p) => p.kind)).toEqual(['image', 'path'])

    const image = page.locator('[data-testid="content-item"][data-kind="image"]').first()
    await expect(image).toBeAttached({ timeout: 20_000 })
    await image.click()
    const x = byTestId(page, 'prop-x')
    await x.fill('250')
    await x.press('Enter')
    await saveInPlace(page, file)
    let painted = graphics(await pdfPaintOrder(file, 0))
    expect(painted.map((p) => p.kind)).toEqual(['image', 'path'])
    expect((painted[0] as { x: number }).x).toBeCloseTo(250, 0)

    // Select it by its part left of the rectangle, then Ctrl/Cmd+Shift+] (bring to front).
    await image.click({ position: { x: 5, y: 5 } })
    await expect(image).toHaveAttribute('data-selected', 'true')
    await expect(byTestId(page, 'prop-front')).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+Shift+BracketRight')
    await expect(byTestId(page, 'prop-front')).toBeDisabled()
    await saveInPlace(page, file)
    painted = graphics(await pdfPaintOrder(file, 0))
    expect(painted.map((p) => p.kind)).toEqual(['path', 'image'])
    expect((painted[1] as { x: number }).x).toBeCloseTo(250, 0)
    // The text is unchanged.
    expect((await pdfPageTexts(file))[0]).toContain('Existing title')
  })

  test('deletes an existing link annotation', async ({ launch }) => {
    const file = await copyFixture('annotated.pdf', makeTempDir())
    const { page } = await launch({ args: [file] })
    await openPage(page)
    const link = page.locator('[data-testid="annotation"][data-subtype="Link"]').first()
    await expect(link).toBeAttached({ timeout: 20_000 })
    await link.click()
    await page.keyboard.press('Delete')
    await expect(page.locator('[data-testid="annotation"][data-subtype="Link"]')).toHaveCount(0)
    await saveInPlace(page, file)
    expect(await pdfAnnotationSubtypes(file, 0)).not.toContain('Link')
  })

  test('moves an existing form field and adds a new one in Prepare form', async ({ launch }) => {
    const file = await copyFixture('form.pdf', makeTempDir())
    const { page } = await launch({ args: [file] })
    const first = await openPage(page)
    const before = await pdfFieldRects(file)

    await byTestId(page, 'tool-form-design').click()
    const nameBox = page.locator('[data-testid="field-box"][data-field-name="name"]').first()
    await expect(nameBox).toBeVisible({ timeout: 20_000 })
    await nameBox.click()
    await drag(page, nameBox, 0, 60)

    await byTestId(page, 'tool-field-text').click()
    const pageBox = await settledBox(first)
    // Empty area right of the existing fields, near the top so it is on screen.
    const sx = pageBox.x + pageBox.width * 0.72
    const sy = pageBox.y + pageBox.height * 0.08
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx + 100, sy + 25, { steps: 5 })
    await page.mouse.up()

    await saveInPlace(page, file)
    const after = await pdfFieldRects(file)
    expect(after.name[1]).toBeLessThan(before.name[1] - 20) // moved down the page (PDF y grows upwards)
    expect(after.name[0]).toBeCloseTo(before.name[0], 0)
    const added = Object.keys(after).filter((n) => !(n in before))
    expect(added).toHaveLength(1)
  })

  test('objects added in the editor stay editable after saving and reopening', async ({ launch }) => {
    const file = await copyFixture('text-3pages.pdf', makeTempDir())
    const first = await launch({ args: [file] })
    const p0 = await openPage(first.page)
    await byTestId(first.page, 'tool-text').click()
    const box = await settledBox(p0)
    await first.page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5)
    await first.page.keyboard.type('Persistent note')
    await first.page.keyboard.press('Escape')
    await expect(first.page.locator('[data-testid="object"][data-object-type="text"]')).toHaveCount(1)
    await saveInPlace(first.page, file)
    await first.close()

    const second = await launch({ args: [file] })
    await openPage(second.page)
    const restored = second.page.locator('[data-testid="object"][data-object-type="text"]')
    await expect(restored).toHaveCount(1, { timeout: 20_000 })
    await restored.click()
    await expect(restored).toHaveAttribute('data-selected', 'true')

    // Saving again draws the restored object exactly once.
    await second.page.keyboard.press('ArrowRight')
    await saveInPlace(second.page, file)
    const text = (await pdfPageTexts(file))[0]
    expect(text.split('Persistent note').length - 1).toBe(1)
  })
})
