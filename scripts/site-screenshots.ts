// Captures the product screenshots used by the promo site (site/screenshots/).
// Run after "npm run build": node scripts/site-screenshots.ts [scene]
import { _electron as electron, type Page } from '@playwright/test'
import fontkit from '@cantoo/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from '@cantoo/pdf-lib'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'site', 'screenshots')
const SIZE = { width: 1440, height: 900 }

// ---------------------------------------------------------------------------------------------
// Sample document: a three-page project proposal

const INK = rgb(0.07, 0.09, 0.15)
const MUTED = rgb(0.42, 0.45, 0.5)
const ACCENT = rgb(0.83, 0.15, 0.23)
const RULE = rgb(0.86, 0.88, 0.91)
const A4: [number, number] = [595.28, 841.89]

interface Fonts {
  regular: PDFFont
  medium: PDFFont
  bold: PDFFont
}

function paragraph(page: PDFPage, text: string, x: number, y: number, width: number, font: PDFFont, size = 10.5): number {
  const words = text.split(' ')
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) > width && line) {
      page.drawText(line, { x, y, size, font, color: INK })
      y -= size * 1.55
      line = word
    } else {
      line = next
    }
  }
  if (line) page.drawText(line, { x, y, size, font, color: INK })
  return y - size * 1.55
}

function header(page: PDFPage, f: Fonts, n: number): void {
  page.drawRectangle({ x: 0, y: A4[1] - 6, width: A4[0], height: 6, color: ACCENT })
  page.drawText('BRIGHTWATER', { x: 56, y: A4[1] - 48, size: 11, font: f.bold, color: INK })
  page.drawText('STUDIO', { x: 56 + f.bold.widthOfTextAtSize('BRIGHTWATER ', 11), y: A4[1] - 48, size: 11, font: f.regular, color: ACCENT })
  const label = `Proposal BW-2611  ·  Page ${n} of 3`
  page.drawText(label, { x: A4[0] - 56 - f.regular.widthOfTextAtSize(label, 8.5), y: A4[1] - 47, size: 8.5, font: f.regular, color: MUTED })
  page.drawLine({ start: { x: 56, y: A4[1] - 64 }, end: { x: A4[0] - 56, y: A4[1] - 64 }, thickness: 0.6, color: RULE })
}

async function makeProposal(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle('Website redesign proposal')
  doc.setAuthor('Brightwater Studio')
  const font = (file: string) => doc.embedFont(readFileSync(join(ROOT, 'resources/fonts', file)), { subset: true })
  const f: Fonts = { regular: await font('Inter-Regular.ttf'), medium: await font('Inter-Medium.ttf'), bold: await font('Inter-Bold.ttf') }
  const W = A4[0] - 112

  // Page 1: title, summary, chart
  let page = doc.addPage(A4)
  header(page, f, 1)
  page.drawText('PROPOSAL', { x: 56, y: 700, size: 9, font: f.medium, color: ACCENT })
  page.drawText('Website redesign', { x: 56, y: 668, size: 30, font: f.bold, color: INK })
  page.drawText('& content platform', { x: 56, y: 634, size: 30, font: f.bold, color: INK })
  page.drawText('Prepared for Harbor Lane Bakery  ·  November 2026', { x: 56, y: 606, size: 10.5, font: f.regular, color: MUTED })
  page.drawLine({ start: { x: 56, y: 584 }, end: { x: A4[0] - 56, y: 584 }, thickness: 0.6, color: RULE })
  page.drawText('Summary', { x: 56, y: 556, size: 13, font: f.bold, color: INK })
  let y = paragraph(
    page,
    'Harbor Lane Bakery has grown from a single shop to four locations, and its website has not kept up. This proposal covers a full redesign, a new ordering flow for pickup and catering, and a content platform the team can update without help.',
    56,
    532,
    W,
    f.regular
  )
  y = paragraph(
    page,
    'We plan the work in three phases over ten weeks, with a working preview at the end of every phase so decisions are made on real pages, not mock-ups.',
    56,
    y - 4,
    W,
    f.regular
  )
  page.drawText('Online orders per month, last year', { x: 56, y: y - 18, size: 10, font: f.medium, color: INK })
  const base = y - 190
  const bars = [38, 42, 40, 51, 55, 61, 58, 66, 72, 80, 86, 94]
  const months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
  bars.forEach((v, i) => {
    const x = 60 + i * 40
    page.drawRectangle({ x, y: base, width: 24, height: v * 1.45, color: i === bars.length - 1 ? ACCENT : rgb(0.95, 0.72, 0.68) })
    page.drawText(months[i], { x: x + 9, y: base - 14, size: 8, font: f.regular, color: MUTED })
  })
  page.drawLine({ start: { x: 56, y: base }, end: { x: A4[0] - 56, y: base }, thickness: 0.6, color: RULE })
  page.drawText('Orders grew 2.5× without any change to the site. A faster checkout should do better.', {
    x: 56,
    y: base - 40,
    size: 9.5,
    font: f.regular,
    color: MUTED
  })

  // Page 2: scope and pricing table
  page = doc.addPage(A4)
  header(page, f, 2)
  page.drawText('Scope & pricing', { x: 56, y: 730, size: 20, font: f.bold, color: INK })
  y = paragraph(
    page,
    'Each phase ends with a review. Prices are fixed per phase and include design, development, testing and two rounds of changes.',
    56,
    702,
    W,
    f.regular
  )
  const rows: [string, string, string][] = [
    ['Phase', 'Deliverables', 'Price'],
    ['1. Discovery', 'Interviews, analytics review, sitemap', '€ 3,200'],
    ['2. Design', 'Visual design, components, prototypes', '€ 7,800'],
    ['3. Build', 'Website, ordering flow, content platform', '€ 14,500'],
    ['Support', 'Three months of fixes and updates', '€ 1,500']
  ]
  let ty = y - 14
  rows.forEach((r, i) => {
    if (i === 0) page.drawRectangle({ x: 56, y: ty - 8, width: W, height: 26, color: rgb(0.96, 0.97, 0.98) })
    const rf = i === 0 ? f.medium : f.regular
    page.drawText(r[0], { x: 66, y: ty, size: 10, font: rf, color: INK })
    page.drawText(r[1], { x: 176, y: ty, size: 10, font: rf, color: i === 0 ? INK : MUTED })
    page.drawText(r[2], { x: A4[0] - 66 - rf.widthOfTextAtSize(r[2], 10), y: ty, size: 10, font: rf, color: INK })
    page.drawLine({ start: { x: 56, y: ty - 9 }, end: { x: A4[0] - 56, y: ty - 9 }, thickness: 0.5, color: RULE })
    ty -= 32
  })
  page.drawText('Total', { x: 66, y: ty - 4, size: 11, font: f.bold, color: INK })
  page.drawText('€ 27,000', { x: A4[0] - 66 - f.bold.widthOfTextAtSize('€ 27,000', 11), y: ty - 4, size: 11, font: f.bold, color: ACCENT })
  page.drawText('Timeline', { x: 56, y: ty - 56, size: 13, font: f.bold, color: INK })
  const phases: [string, number, number][] = [
    ['Discovery', 0, 2],
    ['Design', 2, 5],
    ['Build', 5, 10]
  ]
  phases.forEach(([name, from, to], i) => {
    const py = ty - 90 - i * 30
    page.drawText(name, { x: 56, y: py + 5, size: 9.5, font: f.regular, color: INK })
    page.drawRectangle({ x: 140 + from * 38, y: py, width: (to - from) * 38 - 4, height: 18, color: [rgb(0.99, 0.82, 0.78), rgb(0.96, 0.55, 0.5), ACCENT][i] })
  })
  paragraph(
    page,
    'Payment: 30% when the proposal is signed, then the remainder of each phase on its review. Invoices are due within 14 days.',
    56,
    ty - 200,
    W,
    f.regular
  )

  // Page 3: terms and signatures
  page = doc.addPage(A4)
  header(page, f, 3)
  page.drawText('Terms & acceptance', { x: 56, y: 730, size: 20, font: f.bold, color: INK })
  y = 700
  for (const t of [
    'Ownership. On final payment, Harbor Lane Bakery owns the designs, the code written for this project and all content.',
    'Changes. Work outside the scope above is estimated in writing before it starts and billed at € 95 per hour.',
    'Confidentiality. Both parties keep the other’s business information confidential during and after the project.',
    'Validity. This proposal is valid for 30 days from the date above.'
  ]) {
    y = paragraph(page, t, 56, y, W, f.regular) - 6
  }
  const sig = (x: number, who: string, role: string) => {
    page.drawLine({ start: { x, y: 360 }, end: { x: x + 210, y: 360 }, thickness: 0.8, color: INK })
    page.drawText(who, { x, y: 344, size: 10, font: f.medium, color: INK })
    page.drawText(role, { x, y: 330, size: 9, font: f.regular, color: MUTED })
    page.drawText('Date:', { x, y: 296, size: 9, font: f.regular, color: MUTED })
    page.drawLine({ start: { x: x + 28, y: 294 }, end: { x: x + 130, y: 294 }, thickness: 0.5, color: RULE })
  }
  sig(56, 'Elena Brightwater', 'Brightwater Studio')
  sig(A4[0] - 56 - 210, 'Tomas Lane', 'Harbor Lane Bakery')
  return doc.save()
}

// ---------------------------------------------------------------------------------------------
// Capture

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)
const pageEl = (page: Page, index: number) => page.locator(`[data-testid="page"][data-page-index="${index}"]`)

interface Launched {
  page: Page
  shot: (name: string) => Promise<void>
  close: () => Promise<void>
}

async function launch(file: string, theme: 'light' | 'dark'): Promise<Launched> {
  const profile = mkdtempSync(join(tmpdir(), 'ope-site-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, { OPE_USER_DATA: profile, OPE_E2E: '1', OPE_HEADLESS: '1' })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), file], cwd: ROOT, env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), SIZE)
  // Retina-sharp screenshots: pdf.js renders the pages for the emulated pixel ratio.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 2, mobile: false })
  await page.emulateMedia({ colorScheme: theme })
  await pageEl(page, 0).locator('canvas').first().waitFor({ timeout: 30_000 })
  // Re-fit so the pages render again at the new pixel ratio.
  await byTestId(page, 'btn-fit-page').click()
  await byTestId(page, 'btn-fit-width').click()
  await page.waitForTimeout(1200)
  return {
    page,
    // Page.captureScreenshot keeps the emulated pixel ratio (Playwright's screenshot does not).
    shot: async (name) => {
      await page.mouse.move(SIZE.width - 4, SIZE.height - 4)
      await page.waitForTimeout(800)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 88 })
      writeFileSync(join(OUT, `${name}.webp`), Buffer.from(data, 'base64'))
      console.log(`wrote site/screenshots/${name}.webp`)
    },
    close: async () => {
      await app.evaluate(({ BrowserWindow, app: electronApp }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy()
        setTimeout(() => electronApp.exit(0), 50)
      })
      await app.close().catch(() => undefined)
      rmSync(profile, { recursive: true, force: true })
    }
  }
}

/** Screen position of a point given in page space (points, top-left origin) on an A4 page. */
async function at(page: Page, index: number, x: number, y: number): Promise<{ x: number; y: number }> {
  await page.waitForTimeout(400)
  const box = (await pageEl(page, index).boundingBox())!
  const scale = box.width / A4[0]
  return { x: box.x + x * scale, y: box.y + y * scale }
}

async function dragOnPage(page: Page, index: number, from: [number, number], to: [number, number]): Promise<void> {
  const a = await at(page, index, ...from)
  const b = await at(page, index, ...to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 })
  await page.mouse.move(b.x, b.y, { steps: 5 })
  await page.mouse.up()
}

async function zoomOut(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await byTestId(page, 'btn-zoom-out').click()
  await page.waitForTimeout(800)
}

/** Points of a smooth curve through `points` (Catmull-Rom), for natural-looking pen strokes. */
function smooth(points: [number, number][], steps = 8): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const [p1, p2] = [points[i], points[i + 1]]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const c = (k: 0 | 1) =>
        0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
      out.push([c(0), c(1)])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** Edit content: the title line, already in the PDF, selected with its properties. */
async function editContent(page: Page): Promise<void> {
  await zoomOut(page, 2)
  await byTestId(page, 'tool-edit-content').click()
  const title = page.locator('[data-testid="content-item"][data-kind="text"][title*="Website redesign"]').first()
  await title.waitFor({ state: 'attached', timeout: 20_000 })
  await title.click()
}

/** Retype: a line of the PDF's own text being retyped in place. */
async function retype(page: Page): Promise<void> {
  await zoomOut(page, 2)
  await byTestId(page, 'tool-edit-content').click()
  const line = page.locator('[data-testid="content-item"][data-kind="text"][title*="Prepared for"]').first()
  await line.waitFor({ state: 'attached', timeout: 20_000 })
  await line.dblclick()
  const editor = byTestId(page, 'content-text-editor')
  await editor.waitFor()
  const text = await editor.inputValue()
  await editor.fill(text.replace('November', 'December'))
}

/** Redact: the price column marked for removal. */
async function redact(page: Page): Promise<void> {
  await zoomOut(page, 1)
  await page.locator('[data-testid="thumbnail"]').nth(1).click()
  await page.waitForTimeout(800)
  await byTestId(page, 'tool-redact').click()
  await dragOnPage(page, 1, [462, 204], [536, 358])
}

/** Signature: a drawn signature placed on the signature line. */
async function sign(page: Page): Promise<void> {
  await zoomOut(page, 1)
  await page.locator('[data-testid="thumbnail"]').nth(2).click()
  await page.waitForTimeout(800)
  await byTestId(page, 'tool-signature').click()
  const pad = byTestId(page, 'signature-pad')
  await pad.waitFor()
  const box = (await pad.boundingBox())!
  const stroke = async (points: [number, number][]) => {
    const p = (q: [number, number]) => ({ x: box.x + q[0] * box.width, y: box.y + q[1] * box.height })
    await page.mouse.move(p(points[0]).x, p(points[0]).y)
    await page.mouse.down()
    for (const q of points.slice(1)) await page.mouse.move(p(q).x, p(q).y, { steps: 3 })
    await page.mouse.up()
  }
  // "E" with a looping tail and an underline flourish, in pad fractions.
  await stroke(
    smooth([
      [0.26, 0.22], [0.2, 0.18], [0.14, 0.24], [0.15, 0.36], [0.22, 0.42], [0.15, 0.46], [0.1, 0.56],
      [0.13, 0.68], [0.22, 0.7], [0.3, 0.62], [0.34, 0.5], [0.33, 0.6], [0.36, 0.66], [0.4, 0.6],
      [0.42, 0.36], [0.41, 0.28], [0.4, 0.4], [0.42, 0.62], [0.47, 0.66], [0.51, 0.56], [0.5, 0.5],
      [0.53, 0.62], [0.58, 0.64], [0.6, 0.54], [0.6, 0.66], [0.64, 0.52], [0.68, 0.64], [0.72, 0.58],
      [0.71, 0.52], [0.73, 0.64], [0.78, 0.6], [0.84, 0.48], [0.88, 0.4]
    ])
  )
  await stroke(smooth([[0.06, 0.8], [0.3, 0.74], [0.6, 0.72], [0.8, 0.7], [0.92, 0.66]]))
  await byTestId(page, 'dialog-confirm').click()
  const target = await at(page, 2, 160, 448)
  await page.mouse.click(target.x, target.y)
  await page.mouse.move(700, 500)
  await page.mouse.wheel(0, 260)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const dir = mkdtempSync(join(tmpdir(), 'ope-site-doc-'))
  const file = join(dir, 'Brightwater proposal.pdf')
  writeFileSync(file, await makeProposal())
  const scenes: [string, 'light' | 'dark', (page: Page) => Promise<void>][] = [
    ['edit-content', 'light', editContent],
    ['edit-content-dark', 'dark', editContent],
    ['editor-light', 'light', async () => {}],
    ['editor-dark', 'dark', async () => {}],
    ['retype', 'light', retype],
    ['redact', 'light', redact],
    ['sign', 'light', sign]
  ]
  const only = process.argv[2]
  for (const [name, theme, scene] of scenes) {
    if (only && only !== name) continue
    const { page, shot, close } = await launch(file, theme)
    try {
      await scene(page)
      await shot(name)
    } finally {
      await close()
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
