/**
 * Helpers for the content-engine tests: building PDFs from hand-written content streams,
 * reading them back with pdf.js, comparing positions.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import fontkit from '@cantoo/fontkit'
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  type PDFFont,
  type PDFPage
} from '@cantoo/pdf-lib'
import { applyContentEdits, listContentItems, type ContentEditHelpers } from '../../../src/core/content'
import { visibleBox } from '../../../src/core/pdf'
import type { ContentEdit, ContentItem } from '../../../src/core/model'
import type { ResolvedTextFont } from '../../../src/core/text'
import { closePdfjs, openWithPdfjs, OPS } from '../helpers'

export { OPS }

const ROOT = resolve(__dirname, '../../..')
export const FONT_DIR = join(ROOT, 'resources/fonts')

export function fontBytes(file = 'NotoSans-Regular.ttf'): Uint8Array {
  return new Uint8Array(readFileSync(join(FONT_DIR, file)))
}

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/**
 * A one-page PDF whose content stream is `content` (latin1). `setup` can add resources
 * (fonts, images, XObjects) to the page before the content is set; it returns a name map.
 */
export async function pdfFromContent(
  content: string | ((names: Record<string, string>) => string),
  setup?: (doc: PDFDocument, page: PDFPage) => Promise<Record<string, string>> | Record<string, string>,
  size: [number, number] = [612, 792]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const page = doc.addPage(size)
  const names = setup ? await setup(doc, page) : {}
  const text = typeof content === 'function' ? content(names) : content
  const stream = doc.context.flateStream(latin1(text))
  page.node.set(PDFName.of('Contents'), doc.context.register(stream))
  return doc.save({ useObjectStreams: false })
}

/** Add a standard font to the page resources under `name`. */
export async function addStdFont(doc: PDFDocument, page: PDFPage, name: string, font: StandardFonts): Promise<PDFFont> {
  const f = await doc.embedFont(font)
  page.node.setFontDictionary(PDFName.of(name), f.ref)
  return f
}

export interface PdfjsTextItem {
  str: string
  /** Baseline start in page space (top-left origin). */
  x: number
  y: number
  width: number
  height: number
  fontName: string
  /** pdf.js transform (PDF user space). */
  transform: number[]
}

/** pdf.js text items of a page in page space (view box origin top-left), empty strings skipped. */
export async function pdfjsText(bytes: Uint8Array, pageNumber = 1): Promise<PdfjsTextItem[]> {
  const doc = await openWithPdfjs(bytes)
  try {
    const page = await doc.getPage(pageNumber)
    const [vx0, , , vy1] = page.view
    const tc = await page.getTextContent({ disableNormalization: true } as never)
    const out: PdfjsTextItem[] = []
    for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number; fontName?: string }>) {
      if (!it.str || !it.str.trim() || !it.transform) continue
      out.push({
        str: it.str,
        x: it.transform[4] - vx0,
        y: vy1 - it.transform[5],
        width: it.width ?? 0,
        height: it.height ?? 0,
        fontName: it.fontName ?? '',
        transform: it.transform
      })
    }
    return out
  } finally {
    await closePdfjs(doc)
  }
}

/** Joined text of a page as pdf.js extracts it (whitespace collapsed). */
export async function pdfjsPlainText(bytes: Uint8Array, pageNumber = 1): Promise<string> {
  const items = await pdfjsText(bytes, pageNumber)
  return items
    .map((i) => i.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface PdfjsImage {
  /** Transform of the unit square in PDF user space. */
  transform: number[]
}

/** Image paint operations with their CTM (pdf.js operator list). */
export async function pdfjsImages(bytes: Uint8Array, pageNumber = 1): Promise<PdfjsImage[]> {
  const doc = await openWithPdfjs(bytes)
  try {
    const page = await doc.getPage(pageNumber)
    const list = await page.getOperatorList()
    const out: PdfjsImage[] = []
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    const mul = (m1: number[], m2: number[]) => [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    ]
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i]
      const args = list.argsArray[i] as unknown[]
      if (fn === OPS.save) stack.push(ctm)
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
      else if (fn === OPS.transform) ctm = mul(args as number[], ctm)
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm)
        const m = args[0] as number[] | null
        if (m) ctm = mul(Array.from(m), ctm)
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
      else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageMaskXObject
      ) {
        out.push({ transform: ctm })
      }
    }
    return out
  } finally {
    await closePdfjs(doc)
  }
}

/** Page-space bounds of an image drawn with the given user-space CTM on a page with `cropBox`. */
export function imageBoundsInPage(t: number[], pageHeight: number, cropX = 0, cropY = 0) {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ].map(([x, y]) => [t[0] * x + t[2] * y + t[4] - cropX, pageHeight - (t[1] * x + t[3] * y + t[5] - cropY)])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/** Font embedding helper like the exporter's EmbedCache. */
export function testHelpers(doc: PDFDocument): ContentEditHelpers {
  const cache = new Map<string, Promise<PDFFont>>()
  let registered = false
  return {
    embedFont(font: ResolvedTextFont) {
      const key = font.unicode ? font.fontKey : font.standardFont
      let f = cache.get(key)
      if (!f) {
        if (font.unicode) {
          if (!registered) {
            doc.registerFontkit(fontkit)
            registered = true
          }
          f = doc.embedFont(font.fontBytes, { subset: true })
        } else {
          f = doc.embedFont(font.standardFont)
        }
        cache.set(key, f)
      }
      return f
    }
  }
}

export async function listItems(bytes: Uint8Array, pageIndex = 0, skip?: Set<string>): Promise<ContentItem[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const page = doc.getPage(pageIndex)
  return listContentItems(doc, page, visibleBox(page), skip)
}

/** Apply edits to page `pageIndex` and save. */
export async function edit(bytes: Uint8Array, edits: ContentEdit[], pageIndex = 0, skip?: Set<string>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const page = doc.getPage(pageIndex)
  await applyContentEdits(doc, page, visibleBox(page), edits, testHelpers(doc), skip)
  return doc.save({ useObjectStreams: false })
}

export function byText(items: ContentItem[], text: string): ContentItem {
  const it = items.find((i) => i.kind === 'text' && i.text === text)
  if (!it) throw new Error(`no text item "${text}" in ${JSON.stringify(items.filter((i) => i.kind === 'text').map((i) => i.text))}`)
  return it
}

export function findText<T extends { str: string }>(items: T[], str: string): T {
  const it = items.find((i) => i.str === str) ?? items.find((i) => i.str.trim() === str.trim())
  if (!it) throw new Error(`no pdf.js text "${str}" in ${JSON.stringify(items.map((i) => i.str))}`)
  return it
}

export const SCRATCH = '/private/tmp/claude-501/-Users-modestas-kazinauskas-dev-open-pdf-editor/c6ad7822-cdde-4178-880e-64e5777bc65e/scratchpad/content-engine'
