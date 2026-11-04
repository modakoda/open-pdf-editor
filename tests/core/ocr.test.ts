import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from '@cantoo/pdf-lib'
import {
  OCR_LAYER_ID,
  addRedactions,
  deletePages,
  duplicatePages,
  exportDocument,
  getContentItems,
  insertSourcePages,
  loadSource,
  looksScanned,
  makeOcrLineEditable,
  makeRedaction,
  ocrPageText,
  ocrResultFromRecognition,
  openDocument,
  readingFrame,
  removeOcrLine,
  rotatePages,
  setOcrResults,
  setPageOcr,
  type Box,
  type EditorDocument,
  type OcrLine,
  type OcrPageResult,
  type PageEntry,
  type Rotation
} from '../../src/core'
import { makeTextPdf } from '../fixtures/pdfs'
import { closePdfjs, makePng, openWithPdfjs, pageContent, registerTestFonts } from './helpers'

beforeAll(() => registerTestFonts())

/** A page that is one big image (like a scan), optionally rotated / with an offset crop box. */
async function makeImagePdf(options: { rotate?: Rotation; crop?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([600, 800])
  if (options.crop) {
    page.setMediaBox(-40, -60, 700, 900)
    page.setCropBox(20, 30, 600, 800)
  }
  const img = await doc.embedPng(makePng(60, 80, [240, 240, 235]))
  const box = page.getCropBox()
  page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height })
  if (options.rotate) page.setRotation(degrees(options.rotate))
  return doc.save()
}

/** One line "Hello wörld ąžuolas" in reading orientation `rotation`, top-left of the line at reading (100, 200). */
function sampleResult(page: PageEntry, rotation: Rotation): OcrPageResult {
  // Lay the words out upright (reading space), then map them to page space like the renderer does.
  const scale = 2
  const view = { ...page, baseRotation: 0 as Rotation, rotation }
  const word = (text: string, x: number, w: number) => ({
    text,
    confidence: 91.5,
    bbox: { x0: x * scale, y0: 200 * scale, x1: (x + w) * scale, y1: 220 * scale }
  })
  return ocrResultFromRecognition(view, scale, ['eng', 'lit'], [
    {
      bbox: { x0: 100 * scale, y0: 200 * scale, x1: 330 * scale, y1: 220 * scale },
      baseline: { x0: 100 * scale, y0: 216 * scale, x1: 330 * scale, y1: 216 * scale },
      words: [word('Hello', 100, 50), word('wörld', 160, 60), word('ąžuolas', 240, 90)]
    }
  ])
}

interface ExtractedItem {
  str: string
  /** Baseline start in page space. */
  start: { x: number; y: number }
  /** Baseline end in page space. */
  end: { x: number; y: number }
}

/** Text items of page 1 converted to page space (the viewport without rotation does that). */
async function extract(bytes: Uint8Array): Promise<{ text: string; items: ExtractedItem[] }> {
  const doc = await openWithPdfjs(bytes)
  try {
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1, rotation: 0 })
    const tc = await page.getTextContent()
    const items: ExtractedItem[] = []
    let text = ''
    for (const raw of tc.items as Array<{ str?: string; transform?: number[]; width?: number; hasEOL?: boolean }>) {
      if (typeof raw.str !== 'string') continue
      text += raw.str + (raw.hasEOL ? '\n' : '')
      if (!raw.str.trim()) continue
      const [a, b, , , e, f] = raw.transform!
      const len = Math.hypot(a, b) || 1
      const [sx, sy] = viewport.convertToViewportPoint(e, f)
      const [ex, ey] = viewport.convertToViewportPoint(e + (a / len) * raw.width!, f + (b / len) * raw.width!)
      items.push({ str: raw.str, start: { x: sx, y: sy }, end: { x: ex, y: ey } })
    }
    return { text, items }
  } finally {
    await closePdfjs(doc)
  }
}

const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol

/** The reading-space start/end of each word on the baseline, in page space. */
function expectedWordBaselines(result: OcrPageResult) {
  const line = result.lines[0]
  const frame = readingFrame(line.box, result.rotation)
  return line.words.map((w) => {
    const wf = readingFrame(w.box, result.rotation)
    const along = (p: { x: number; y: number }) => (p.x - frame.origin.x) * frame.u.x + (p.y - frame.origin.y) * frame.u.y
    const x0 = along(wf.origin)
    const pt = (x: number) => ({
      x: frame.origin.x + frame.u.x * x + frame.v.x * line.baseline,
      y: frame.origin.y + frame.u.y * x + frame.v.y * line.baseline
    })
    return { text: w.text, start: pt(x0), end: pt(x0 + wf.width) }
  })
}

async function docWithOcr(bytes: Uint8Array, rotation?: Rotation): Promise<EditorDocument> {
  const doc = await openDocument(bytes, 'scan.pdf')
  const page = doc.pages[0]
  return setPageOcr(doc, page.id, sampleResult(page, rotation ?? (page.baseRotation as Rotation)))
}

/** Finds each expected word in the extracted items (a word may be part of a longer item). */
function expectWordsAt(items: ExtractedItem[], expected: ReturnType<typeof expectedWordBaselines>) {
  for (const word of expected) {
    const item = items.find((i) => i.str.includes(word.text))
    expect(item, `no text item with ${word.text}`).toBeDefined()
    const at = item!.str.indexOf(word.text)
    // Interpolate along the item (the gaps between words are stretched spaces).
    const t0 = at / item!.str.length
    const dx = item!.end.x - item!.start.x
    const dy = item!.end.y - item!.start.y
    if (at === 0) {
      expect(near(item!.start.x, word.start.x) && near(item!.start.y, word.start.y), `${word.text} start ${JSON.stringify(item!.start)} vs ${JSON.stringify(word.start)}`).toBe(true)
    } else {
      // Not exact for proportional glyphs; only check that the word lies on the baseline segment.
      const px = item!.start.x + dx * t0
      const py = item!.start.y + dy * t0
      expect(Math.hypot(px - word.start.x, py - word.start.y)).toBeLessThan(60)
    }
  }
  const last = expected[expected.length - 1]
  const lastItem = items.find((i) => i.str.endsWith(last.text))!
  expect(near(lastItem.end.x, last.end.x, 2) && near(lastItem.end.y, last.end.y, 2), `line end ${JSON.stringify(lastItem.end)} vs ${JSON.stringify(last.end)}`).toBe(true)
}

describe('OCR results from recognition', () => {
  const page: PageEntry = { id: 'p', source: { kind: 'blank' }, width: 600, height: 800, baseRotation: 0, rotation: 0 }

  it('maps pixel boxes of an upright page to page space', () => {
    const result = sampleResult(page, 0)
    expect(result.rotation).toBe(0)
    expect(result.languages).toEqual(['eng', 'lit'])
    expect(result.lines).toHaveLength(1)
    const line = result.lines[0]
    expect(line.box).toEqual({ x: 100, y: 200, width: 230, height: 20 })
    expect(line.baseline).toBe(16)
    expect(line.words.map((w) => w.text)).toEqual(['Hello', 'wörld', 'ąžuolas'])
    expect(line.words[0].box).toEqual({ x: 100, y: 200, width: 50, height: 20 })
    expect(line.words[0].confidence).toBe(91.5)
    expect(ocrPageText(result)).toBe('Hello wörld ąžuolas')
  })

  it('maps pixel boxes of a page displayed rotated by 90° to unrotated page space', () => {
    const result = sampleResult(page, 90)
    expect(result.rotation).toBe(90)
    // Reading (x, y) on a page displayed at 90° is page (y, H - x).
    expect(result.lines[0].box).toEqual({ x: 200, y: 800 - 330, width: 20, height: 230 })
    const frame = readingFrame(result.lines[0].box, 90)
    expect(frame.origin).toEqual({ x: 200, y: 700 })
    expect(frame.width).toBe(230)
    expect(frame.height).toBe(20)
  })

  it('drops empty words and lines and falls back to an estimated baseline', () => {
    const result = ocrResultFromRecognition(page, 1, ['eng'], [
      { bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, words: [{ text: '  ', confidence: 50, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }] },
      { bbox: { x0: 0, y0: 20, x1: 50, y1: 30 }, baseline: null, words: [{ text: 'ok', confidence: 120, bbox: { x0: 0, y0: 20, x1: 20, y1: 30 } }] }
    ])
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].id).toBe('l0')
    expect(result.lines[0].baseline).toBe(8)
    expect(result.lines[0].words[0].confidence).toBe(100)
  })
})

describe('OCR model operations', () => {
  it('stores, replaces and removes results per page (ignoring unknown pages)', async () => {
    const doc = await openDocument(await makeTextPdf(2), 't.pdf')
    const [p1, p2] = doc.pages
    const r = sampleResult(p1, 0)
    const a = setOcrResults(doc, { [p1.id]: r, nope: r })
    expect(Object.keys(a.ocr!)).toEqual([p1.id])
    expect(doc.ocr).toBeUndefined()
    const b = setPageOcr(a, p2.id, r)
    expect(Object.keys(b.ocr!).sort()).toEqual([p1.id, p2.id].sort())
    const c = setPageOcr(b, p1.id, null)
    expect(Object.keys(c.ocr!)).toEqual([p2.id])
    expect(setPageOcr(c, p1.id, null)).toBe(c)
    const d = removeOcrLine(b, p1.id, 'l0')
    expect(d.ocr![p1.id].lines).toEqual([])
    expect(b.ocr![p1.id].lines).toHaveLength(1)
  })

  it('follows page deletion and duplication', async () => {
    const doc = await openDocument(await makeTextPdf(2), 't.pdf')
    const [p1, p2] = doc.pages
    const withOcr = setOcrResults(doc, { [p1.id]: sampleResult(p1, 0), [p2.id]: sampleResult(p2, 0) })
    expect(Object.keys(deletePages(withOcr, [p1.id]).ocr!)).toEqual([p2.id])
    const dup = duplicatePages(withOcr, [p1.id])
    expect(dup.pages).toHaveLength(3)
    expect(dup.ocr![dup.pages[1].id]).toBe(withOcr.ocr![p1.id])
  })

  it('makes a recognized line editable: covers it and places upright text on its baseline', async () => {
    const doc = await openDocument(await makeImagePdf(), 'scan.pdf')
    const page = doc.pages[0]
    const withOcr = setPageOcr(doc, page.id, sampleResult(page, 0))
    const line = withOcr.ocr![page.id].lines[0]
    const made = makeOcrLineEditable(withOcr, page.id, line.id, {})!
    expect(made).not.toBeNull()
    expect(made.doc.ocr![page.id].lines).toEqual([])
    expect(made.doc.objects.map((o) => o.type)).toEqual(['whiteout', 'text'])
    const { cover, text } = made
    expect(text.text).toBe('Hello wörld ąžuolas')
    expect(text.rotation).toBe(0)
    expect(text.fontSize).toBeGreaterThan(14)
    expect(text.fontSize).toBeLessThan(28)
    // The cover contains the line; the text starts at the line and stays on one line.
    expect(cover.x).toBeLessThanOrEqual(line.box.x)
    expect(cover.y).toBeLessThanOrEqual(line.box.y)
    expect(cover.x + cover.width).toBeGreaterThanOrEqual(line.box.x + line.box.width)
    expect(cover.y + cover.height).toBeGreaterThanOrEqual(line.box.y + line.box.height)
    expect(cover.color).toBe('#ffffff')
    expect(text.x).toBeCloseTo(line.box.x, 0)
    expect(text.width).toBeGreaterThanOrEqual(line.box.width)
    expect(text.y).toBeLessThan(line.box.y + line.baseline)
    expect(text.y + text.height).toBeGreaterThan(line.box.y + line.baseline)
    expect(makeOcrLineEditable(made.doc, page.id, line.id)).toBeNull()

    // Sampled colors are used; rotated reading orientation gives a rotated TextObject.
    const colored = setPageOcr(doc, page.id, {
      ...sampleResult(page, 90),
      lines: sampleResult(page, 90).lines.map((l: OcrLine) => ({ ...l, background: '#eeeedd', color: '#202030' }))
    })
    const rotated = makeOcrLineEditable(colored, page.id, 'l0')!
    expect(rotated.text.rotation).toBe(270)
    expect(rotated.text.color).toBe('#202030')
    expect(rotated.cover.color).toBe('#eeeedd')
    const lineBox = colored.ocr![page.id].lines[0].box
    // Centered across the line, the unrotated box is as long as the reading width.
    expect(rotated.text.width).toBeGreaterThanOrEqual(lineBox.height)
    expect(rotated.text.x + rotated.text.width / 2).toBeGreaterThan(lineBox.x)
    expect(rotated.text.x + rotated.text.width / 2).toBeLessThan(lineBox.x + lineBox.width)
  })

  it('detects scanned pages: no text and one image covering most of the page', async () => {
    const scan = await openDocument(await makeImagePdf(), 'scan.pdf')
    const items = await getContentItems(scan, scan.pages[0].id)
    expect(looksScanned(items, scan.pages[0])).toBe(true)
    const text = await openDocument(await makeTextPdf(1), 'text.pdf')
    expect(looksScanned(await getContentItems(text, text.pages[0].id), text.pages[0])).toBe(false)
    const small: Box = { x: 0, y: 0, width: 100, height: 100 }
    expect(looksScanned([{ id: 'i1', kind: 'image', bounds: small }], { width: 600, height: 800 })).toBe(false)
  })
})

describe('invisible text layer', () => {
  it('writes the words as invisible text that pdf.js extracts at the recognized positions', async () => {
    const doc = await docWithOcr(await makeImagePdf())
    const bytes = await exportDocument(doc)
    const content = await pageContent(bytes, 0)
    expect(content).toMatch(/\b3 Tr\b/)
    expect(content).toContain(`/OPEObject << /Id (${OCR_LAYER_ID}) >> BDC`)
    const { text, items } = await extract(bytes)
    expect(text.replace(/\s+/g, ' ')).toContain('Hello wörld ąžuolas')
    expectWordsAt(items, expectedWordBaselines(doc.ocr![doc.pages[0].id]))
    // The font is embedded (a subset of the bundled Noto Sans).
    const pdf = await PDFDocument.load(bytes)
    const fonts = pdf.context.enumerateIndirectObjects().filter(([, o]) => String(o).includes('/FontFile2'))
    expect(fonts.length).toBeGreaterThan(0)
  })

  for (const rotate of [90, 180, 270] as Rotation[]) {
    it(`positions the text on a page with /Rotate ${rotate}`, async () => {
      const doc = await docWithOcr(await makeImagePdf({ rotate }))
      expect(doc.pages[0].baseRotation).toBe(rotate)
      expect(doc.ocr![doc.pages[0].id].rotation).toBe(rotate)
      const bytes = await exportDocument(doc)
      const { text, items } = await extract(bytes)
      expect(text.replace(/\s+/g, ' ')).toContain('Hello wörld ąžuolas')
      expectWordsAt(items, expectedWordBaselines(doc.ocr![doc.pages[0].id]))
    })
  }

  it('positions the text on a page whose crop box does not start at the origin', async () => {
    const doc = await docWithOcr(await makeImagePdf({ crop: true }))
    expect(doc.pages[0].width).toBe(600)
    const bytes = await exportDocument(doc)
    const { text, items } = await extract(bytes)
    expect(text.replace(/\s+/g, ' ')).toContain('Hello wörld ąžuolas')
    expectWordsAt(items, expectedWordBaselines(doc.ocr![doc.pages[0].id]))
  })

  it('keeps the text where it was recognized when the user rotates the page', async () => {
    const doc = await docWithOcr(await makeImagePdf())
    const rotated = rotatePages(doc, [doc.pages[0].id], 90)
    const { items } = await extract(await exportDocument(rotated))
    expectWordsAt(items, expectedWordBaselines(doc.ocr![doc.pages[0].id]))
  })

  it('restores the results on reopening and replaces the layer instead of adding another one', async () => {
    const doc = await docWithOcr(await makeImagePdf())
    const saved = await exportDocument(doc)
    const reopened = await openDocument(saved, 'scan.pdf')
    const pageId = reopened.pages[0].id
    expect(reopened.ocr?.[pageId]).toEqual(doc.ocr![doc.pages[0].id])
    expect(reopened.sources[reopened.primarySourceId!].pageInfo![0].restoredObjectIds).toEqual([OCR_LAYER_ID])
    // The restored layer is not existing content (Edit content does not list it).
    expect((await getContentItems(reopened, pageId)).filter((i) => i.kind === 'text')).toEqual([])

    const again = await exportDocument(reopened)
    const { text } = await extract(again)
    expect(text.match(/Hello/g)).toHaveLength(1)

    // Removing the results removes the layer.
    const cleared = await exportDocument(setPageOcr(reopened, pageId, null))
    expect((await extract(cleared)).text.trim()).toBe('')
    const reopenedCleared = await loadSource(cleared, 'c.pdf')
    expect(reopenedCleared.pageInfo![0].restoredOcr).toBeUndefined()
  })

  it('does not keep recognized words under a redaction area', async () => {
    const doc = await docWithOcr(await makeImagePdf())
    const pageId = doc.pages[0].id
    const line = doc.ocr![pageId].lines[0]
    // Over "Hello" and the start of "wörld"; "ąžuolas" stays.
    const saved = await exportDocument(addRedactions(doc, [makeRedaction(pageId, { x: 90, y: 190, width: 100, height: 40 })]))
    const { text } = await extract(saved)
    expect(text).not.toContain('Hello')
    expect(text).toContain('ąžuolas')
    const restored = (await loadSource(saved, 'scan.pdf')).pageInfo![0].restoredOcr!
    expect(restored.lines).toHaveLength(1)
    const kept = restored.lines[0]
    expect(kept.words.map((w) => w.text)).toEqual(['ąžuolas'])
    // The line box shrinks along the text only: same top edge and baseline.
    expect(kept.box.x).toBeCloseTo(kept.words[0].box.x, 1)
    expect(kept.box.x + kept.box.width).toBeCloseTo(line.box.x + line.box.width, 1)
    expect(kept.box.y).toBe(line.box.y)
    expect(kept.box.height).toBe(line.box.height)
    expect(kept.baseline).toBe(line.baseline)

    // Nothing left of a line under the area: no recognized text is stored.
    const all = await exportDocument(addRedactions(doc, [makeRedaction(pageId, { x: 50, y: 150, width: 400, height: 120 })]))
    expect((await loadSource(all, 'scan.pdf')).pageInfo![0].restoredOcr).toBeUndefined()
  })

  it('brings restored results along when the pages are inserted into another document', async () => {
    const saved = await exportDocument(await docWithOcr(await makeImagePdf()))
    const source = await loadSource(saved, 'scan.pdf')
    const target = await openDocument(await makeTextPdf(1), 't.pdf')
    const merged = insertSourcePages(target, source, 1)
    expect(merged.ocr?.[merged.pages[1].id]?.lines[0].words[0].text).toBe('Hello')
    const { text } = await extract(await exportDocument(merged, { pageIds: [merged.pages[1].id] }))
    expect(text.match(/Hello/g)).toHaveLength(1)
  })

  it('writes nothing for pages without recognized words', async () => {
    const doc = await openDocument(await makeImagePdf(), 'scan.pdf')
    const empty = setPageOcr(doc, doc.pages[0].id, { languages: ['eng'], rotation: 0, lines: [] })
    const bytes = await exportDocument(empty)
    expect(await pageContent(bytes, 0)).not.toContain('Tr')
    // The (empty) result still survives a reopen: the page counts as recognized.
    const reopened = await openDocument(bytes, 'x.pdf')
    expect(reopened.ocr?.[reopened.pages[0].id]).toEqual({ languages: ['eng'], rotation: 0, lines: [] })
  })
})
