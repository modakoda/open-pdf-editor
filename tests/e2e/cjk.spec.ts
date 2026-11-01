/**
 * CJK text end to end. CI runners may lack CJK system fonts, so the main process serves the
 * committed OFL test fonts (tests/fixtures/fonts) instead of the system's, through its test
 * hook (OPE_E2E_SYSTEM_FONTS, honored only with OPE_E2E=1).
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib'
import { ROOT, copyFixture, expect, makeTempDir, mockSaveDialog, settledBox, test } from './helpers'
import { pdfPageTexts, pdfTextFieldValue } from './pdf'

const FONT_DIR = join(ROOT, 'tests/fixtures/fonts')
const TEST_FONTS = JSON.stringify([
  {
    path: join(FONT_DIR, 'OPETestCJK.ttc'),
    name: 'OPE Test CJK',
    postscriptName: 'OPETestCJK-Regular',
    scripts: ['cjk', 'kana'],
    language: 'zh-Hans',
    family: 'sans',
    bold: false
  },
  {
    path: join(FONT_DIR, 'OPETestCJK.ttc'),
    name: 'OPE Test CJK Bold',
    postscriptName: 'OPETestCJK-Bold',
    scripts: ['cjk', 'kana'],
    language: 'zh-Hans',
    family: 'sans',
    bold: true
  },
  { path: join(FONT_DIR, 'OPETestJP-Regular.otf'), name: 'OPE Test JP', scripts: ['cjk', 'kana'], language: 'ja', family: 'sans', bold: false }
])
const env = { OPE_E2E_SYSTEM_FONTS: TEST_FONTS }

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)

async function firstPage(page: Page) {
  const p = page.locator('[data-testid="page"][data-page-index="0"]')
  await expect(p).toBeVisible({ timeout: 20_000 })
  return p
}

/** Adds a text object at a relative position of the first page by typing `text`. */
async function typeTextObject(page: Page, text: string, at: { x: number; y: number }) {
  const p0 = await firstPage(page)
  await byTestId(page, 'tool-text').click()
  const box = await settledBox(p0.locator('[data-testid="page-overlay"]'))
  await page.mouse.click(box.x + box.width * at.x, box.y + box.height * at.y)
  const editor = byTestId(page, 'text-object-editor')
  await expect(editor).toBeVisible()
  await editor.pressSequentially(text)
  await editor.press('Escape')
}

async function saveAs(app: Parameters<typeof mockSaveDialog>[0], page: Page): Promise<string> {
  const target = join(makeTempDir(), 'cjk.pdf')
  await mockSaveDialog(app, target)
  await byTestId(page, 'btn-save-as').click()
  await expect.poll(() => statSync(target, { throwIfNoEntry: false })?.size ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)
  return target
}

async function pageFontNames(path: string): Promise<string[]> {
  const doc = await PDFDocument.load(readFileSync(path))
  const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  return fonts.keys().map((k) => (fonts.lookup(k, PDFDict).lookup(PDFName.of('BaseFont')) as PDFName).decodeText())
}

test.describe('CJK text', () => {
  test('types Chinese and Japanese text, shows it with the system font and saves it', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf], env })
    await typeTextObject(page, '你好世界，这是中文测试。', { x: 0.3, y: 0.3 })
    await typeTextObject(page, 'こんにちは、カタカナ', { x: 0.3, y: 0.5 })
    const texts = page.locator('[data-testid="object"][data-object-type="text"] text')
    await expect(texts).toHaveCount(2)
    // The overlay draws the glyphs with the loaded font (no "?" placeholders).
    await expect(texts.nth(0)).toHaveAttribute('font-family', /^'OPE Fallback sys0'/)
    await expect(texts.nth(1)).toHaveAttribute('font-family', /^'OPE Fallback sys2'/)
    await expect(texts.nth(0)).not.toContainText('?')
    expect(await page.evaluate(() => document.fonts.check("12px 'OPE Fallback sys0'", '你'))).toBe(true)

    const target = await saveAs(app, page)
    const [first] = await pdfPageTexts(target)
    const flat = first.replace(/\s+/g, '')
    expect(flat).toContain('你好世界，这是中文测试。')
    expect(flat).toContain('こんにちは、カタカナ')
    const fonts = await pageFontNames(target)
    expect(fonts.some((n) => n.startsWith('OPETestCJK-Regular'))).toBe(true)
    expect(fonts.some((n) => n.startsWith('OPETestJP-Regular'))).toBe(true)
    await expect(byTestId(page, 'notice')).toContainText('Saved cjk.pdf')
    await expect(byTestId(page, 'notice')).not.toContainText('?')
  })

  test('fills a form field with Chinese text and saves the value', async ({ launch }) => {
    const pdf = await copyFixture('form.pdf')
    const { app, page } = await launch({ args: [pdf], env })
    const field = page.locator('[data-testid="form-field"][data-field-name="name"]')
    await expect(field).toBeVisible({ timeout: 20_000 })
    await field.fill('王小明')
    await field.blur()
    const target = await saveAs(app, page)
    expect(await pdfTextFieldValue(target, 'name')).toBe('王小明')
  })

  test('explains when no installed font contains the typed characters', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ args: [pdf], env })
    // The test fonts have no Hangul.
    await typeTextObject(page, '한국어', { x: 0.3, y: 0.3 })
    const notice = byTestId(page, 'notice')
    await expect(notice).toHaveAttribute('data-kind', 'error')
    await expect(notice).toContainText('No installed font contains “한” “국” “어”')
    const target = await saveAs(app, page)
    await expect(notice).toContainText('Saved cjk.pdf. No installed font contains')
    expect((await pdfPageTexts(target))[0]).toContain('???')
  })
})
