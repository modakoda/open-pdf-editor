/**
 * PDFs saved by browsers (Chrome / Skia "Save as PDF", e.g. online invoices): Identity-H
 * subset fonts, glyphs whose /ToUnicode entry is U+0000 with their text in /ActualText, one
 * `Td … Tj` per glyph under a y-down CTM. Text must list with its real characters, retyped
 * text must keep the original font when it has the glyphs (else use the bundled face of the
 * same family), and /ActualText must follow the glyphs it belongs to.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib'
import { readPageContent } from '../../../src/core/content/page'
import type { ContentEdit, ContentItem } from '../../../src/core/model'
import { makeBrowserInvoicePdf } from '../../fixtures/pdfs'
import { registerTestFonts } from '../helpers'
import { byText, edit, fontBytes, listItems, pdfjsText } from './helpers'

const near = (a: number, b: number, tol = 0.05) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol)

/** The page's content (all streams) as latin1 text. */
async function contentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  return new TextDecoder('latin1').decode(readPageContent(doc.getPage(0)))
}

async function fontNames(bytes: Uint8Array): Promise<string[]> {
  return Object.keys(await baseFonts(bytes))
}

/** Page font resource name → BaseFont (subset prefix removed). */
async function baseFonts(bytes: Uint8Array): Promise<Record<string, string>> {
  const doc = await PDFDocument.load(bytes)
  const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  return Object.fromEntries(
    fonts.keys().map((k) => {
      const base = fonts.lookup(k, PDFDict).lookup(PDFName.of('BaseFont'), PDFName).decodeText()
      return [k.decodeText(), base.replace(/^[A-Z]{6}\+/, '')]
    })
  )
}

/** /ActualText strings in the content (hex UTF-16BE, as Chrome and the editor write them). */
function actualTexts(content: string): string[] {
  return [...content.matchAll(/\/ActualText\s*<FEFF([0-9A-F]*)>/gi)].map((m) =>
    String.fromCharCode(...(m[1].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)))
  )
}

describe('browser-generated PDFs', () => {
  let bytes: Uint8Array
  let items: ContentItem[]

  beforeAll(async () => {
    registerTestFonts()
    bytes = await makeBrowserInvoicePdf({ regular: fontBytes('Inter-Regular.ttf'), bold: fontBytes('Inter-SemiBold.ttf') })
    items = await listItems(bytes)
  })

  it('lists each line with the characters given by /ActualText', () => {
    const texts = items.filter((i) => i.kind === 'text').map((i) => i.text)
    expect(texts).toEqual([
      'Invoice',
      'Invoice number INV-0042',
      'Bill to',
      'Example Store (LT-123)',
      'Oct 19–Nov 19, 2026',
      'Total €80.61'
    ])
    for (const t of items.filter((i) => i.kind === 'text')) expect(t.editableInPlace).toBe(true)
    const store = byText(items, 'Example Store (LT-123)')
    near(store.origin!.x, 30)
    near(store.origin!.y, 120)
    near(store.fontSize!, 9)
    expect(store.fontName).toMatch(/^Inter-Regular/)
    expect(byText(items, 'Bill to').fontName).toMatch(/^Inter-SemiBold/)
    expect(byText(items, 'Bill to').bold).toBe(true)
  })

  it('retypes text in the original subset font, with the glyphs /ActualText named', async () => {
    const out = await edit(bytes, [{ itemId: byText(items, 'Example Store (LT-123)').id, text: 'Example Store (LT-321)' }])
    // "(", ")" and "-" have no /ToUnicode entry: the new text uses a copy of the font
    // (same program) whose /ToUnicode has them, so every reader extracts it.
    expect(await fontNames(out)).toEqual(['F1', 'F2', 'F1_u'])
    expect((await pdfjsText(out)).map((t) => t.str)).toContain('Example Store (LT-321)')
    const content = await contentText(out)
    // The old line's /ActualText sections are gone with its glyphs; the other ones stay.
    expect(actualTexts(content).sort()).toEqual(['-', '–'])
    const after = await listItems(out)
    const line = byText(after, 'Example Store (LT-321)')
    expect(line.fontName).toBe(byText(items, 'Example Store (LT-123)').fontName)
    near(line.origin!.x, 30)
    near(line.origin!.y, 120)
    const texts = after.filter((i) => i.kind === 'text').map((i) => i.text)
    expect(texts).not.toContain('Example Store (LT-123)')
    expect(texts).toContain('Invoice number INV-0042')
  })

  it('uses characters of the whole embedded font that the page does not use yet', async () => {
    const out = await edit(bytes, [{ itemId: byText(items, 'Invoice').id, text: 'Quote' }])
    expect(await fontNames(out)).toEqual(['F1', 'F2', 'F2_u'])
    expect(byText(await listItems(out), 'Quote').bold).toBe(true)
    expect((await pdfjsText(out)).map((t) => t.str)).toContain('Quote')
  })

  it('keeps the font when retyped text only uses mapped characters', async () => {
    const out = await edit(bytes, [{ itemId: byText(items, 'Total €80.61').id, text: 'Total €81.60' }])
    expect(await fontNames(out)).toEqual(['F1', 'F2'])
    expect((await pdfjsText(out)).map((t) => t.str)).toContain('Total €81.60')
  })

  it('uses the bundled face of the same family for characters the subset lacks', async () => {
    const out = await edit(bytes, [{ itemId: byText(items, 'Total €80.61').id, text: 'Šiaurės g. 7' }])
    const fonts = await baseFonts(out)
    const added = Object.keys(fonts).filter((n) => n !== 'F1' && n !== 'F2')
    expect(added).toHaveLength(1)
    expect(added[0]).not.toBe('F1_u')
    expect(fonts[added[0]]).toMatch(/^Inter-Regular/) // bundled Inter, embedded as a new subset
    expect((await pdfjsText(out)).map((t) => t.str)).toContain('Šiaurės g. 7')
    const line = byText(await listItems(out), 'Šiaurės g. 7')
    near(line.origin!.x, 30)
    near(line.origin!.y, 165)
  })

  it('moves text with its /ActualText and deletes text together with it', async () => {
    const number = byText(items, 'Invoice number INV-0042')
    const edits: ContentEdit[] = [
      { itemId: number.id, transform: [1, 0, 0, 1, 100, 50] },
      { itemId: byText(items, 'Oct 19–Nov 19, 2026').id, deleted: true }
    ]
    const out = await edit(bytes, edits)
    const content = await contentText(out)
    // The moved line is one /ActualText section; its old "-" section and the deleted line's
    // "–" section lost their /ActualText.
    expect(actualTexts(content).sort()).toEqual(['(', ')', '-', 'Invoice number INV-0042'].sort())
    const after = await listItems(out)
    const moved = byText(after, 'Invoice number INV-0042')
    near(moved.origin!.x, number.origin!.x + 100)
    near(moved.origin!.y, number.origin!.y + 50)
    const texts = after.filter((i) => i.kind === 'text').map((i) => i.text)
    expect(texts).not.toContain('Oct 19–Nov 19, 2026')
    expect(texts).toContain('Example Store (LT-123)')
  })
})
