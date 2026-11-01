import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib'
import { registerFonts, type FontAssets, type FontStyleKey } from '../../src/core'

const ROOT = resolve(__dirname, '../..')
const FONT_DIR = join(ROOT, 'resources/fonts')
/** Small OFL CJK test fonts (see tests/fixtures/fonts/README.md). */
export const TEST_FONT_DIR = join(ROOT, 'tests/fixtures/fonts')
const STANDARD_FONT_DATA_URL = join(ROOT, 'node_modules/pdfjs-dist/standard_fonts') + '/'

const FONT_FILES: Partial<Record<FontStyleKey, string>> = {
  'sans-regular': 'NotoSans-Regular.ttf',
  'sans-bold': 'NotoSans-Bold.ttf',
  'sans-italic': 'NotoSans-Italic.ttf',
  'sans-bolditalic': 'NotoSans-BoldItalic.ttf',
  'serif-regular': 'NotoSerif-Regular.ttf',
  'serif-bold': 'NotoSerif-Bold.ttf',
  'serif-italic': 'NotoSerif-Italic.ttf',
  'serif-bolditalic': 'NotoSerif-BoldItalic.ttf',
  'mono-regular': 'NotoSansMono-Regular.ttf',
  'mono-bold': 'NotoSansMono-Bold.ttf'
}

export function loadFontAssets(): FontAssets {
  const assets: FontAssets = {}
  for (const [key, file] of Object.entries(FONT_FILES) as [FontStyleKey, string][]) {
    assets[key] = new Uint8Array(readFileSync(join(FONT_DIR, file)))
  }
  return assets
}

export function registerTestFonts(): void {
  registerFonts(loadFontAssets())
}

/** Bytes of a test font in tests/fixtures/fonts. */
export function testFont(file: 'OPETestCJK-Regular.ttf' | 'OPETestCJK.ttc' | 'OPETestJP-Regular.otf'): Uint8Array {
  return new Uint8Array(readFileSync(join(TEST_FONT_DIR, file)))
}

/**
 * Wall-clock budget for a performance check. Shared CI runners (Windows above all) run several
 * times slower than a developer machine; the budgets only have to catch pathological slowdowns.
 */
export function timeBudget(ms: number): number {
  return process.env.CI ? ms * 4 : ms
}

const tasks = new WeakMap<object, { destroy(): Promise<void> }>()

export async function openWithPdfjs(bytes: Uint8Array, password?: string) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0
  })
  try {
    const doc = await task.promise
    tasks.set(doc, task)
    return doc
  } catch (e) {
    await task.destroy()
    throw e
  }
}

export async function closePdfjs(doc: object): Promise<void> {
  await tasks.get(doc)?.destroy()
}

export interface TextItem {
  str: string
  /** [a, b, c, d, e, f] in PDF user space. */
  transform: number[]
}

export async function pageTextItems(bytes: Uint8Array, pageNumber: number, password?: string): Promise<TextItem[]> {
  const doc = await openWithPdfjs(bytes, password)
  try {
    const page = await doc.getPage(pageNumber)
    const tc = await page.getTextContent()
    return (tc.items as Array<{ str?: string; transform?: number[] }>)
      .filter((i) => typeof i.str === 'string' && i.str.length > 0)
      .map((i) => ({ str: i.str!, transform: i.transform! }))
  } finally {
    await closePdfjs(doc)
  }
}

export async function allPagesText(bytes: Uint8Array, password?: string): Promise<string[]> {
  const doc = await openWithPdfjs(bytes, password)
  try {
    const out: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      out.push(
        (tc.items as Array<{ str?: string }>)
          .map((it) => it.str ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
    }
    return out
  } finally {
    await closePdfjs(doc)
  }
}

export async function pageInfo(bytes: Uint8Array, password?: string) {
  const doc = await openWithPdfjs(bytes, password)
  try {
    const pages: { rotate: number; view: number[] }[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      pages.push({ rotate: page.rotate, view: [...page.view] })
    }
    return pages
  } finally {
    await closePdfjs(doc)
  }
}

export async function pageAnnotations(bytes: Uint8Array, pageNumber: number, password?: string) {
  const doc = await openWithPdfjs(bytes, password)
  try {
    const page = await doc.getPage(pageNumber)
    return (await page.getAnnotations()) as Array<Record<string, any>>
  } finally {
    await closePdfjs(doc)
  }
}

export async function operatorNames(bytes: Uint8Array, pageNumber: number): Promise<number[]> {
  const doc = await openWithPdfjs(bytes)
  try {
    const page = await doc.getPage(pageNumber)
    const list = await page.getOperatorList()
    return list.fnArray
  } finally {
    await closePdfjs(doc)
  }
}

export const OPS = pdfjs.OPS

/** Angle (degrees, counter-clockwise, PDF space) of a text item's baseline. */
export function textAngle(item: TextItem): number {
  const [a, b] = item.transform
  const deg = (Math.atan2(b, a) * 180) / Math.PI
  return ((Math.round(deg * 1000) / 1000) % 360 + 360) % 360
}

/** Recursively freeze an object graph (typed arrays are skipped: they cannot be frozen). */
export function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !ArrayBuffer.isView(obj) && !Object.isFrozen(obj)) {
    Object.freeze(obj)
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v)
  }
  return obj
}

/** A valid RGB PNG of the given size filled with one color. */
export function makePng(width: number, height: number, [r, g, b]: [number, number, number] = [255, 0, 0]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) raw.set([r, g, b], row + 1 + x * 3)
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
  return new Uint8Array(png)
}

/** Smallest valid baseline JPEG (1x1 gray). */
export const TINY_JPEG = new Uint8Array(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64'
  )
)

/** Decoded content streams (concatenated) of a page, via pdf-lib. */
export async function pageContent(bytes: Uint8Array, pageIndex: number, password?: string): Promise<string> {
  const doc = await PDFDocument.load(bytes, { password, updateMetadata: false })
  const page = doc.getPage(pageIndex)
  const contents = page.node.Contents()
  const streams: unknown[] = []
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) streams.push(doc.context.lookup(contents.get(i)))
  } else if (contents) streams.push(contents)
  return streams
    .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
    .join('\n')
}

/** Every decoded stream in the file (to check that content was really removed). */
export async function allStreamsText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const parts: string[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    try {
      parts.push(Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1'))
    } catch {
      // images etc.
    }
  }
  return parts.join('\n')
}

/** Hex of a WinAnsi string as pdf-lib writes it in content streams (<...> Tj). */
export function hexText(s: string): string {
  return Buffer.from(s, 'latin1').toString('hex').toUpperCase()
}
