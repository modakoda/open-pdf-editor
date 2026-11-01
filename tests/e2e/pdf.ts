/** Inspecting saved PDFs in the test process (pdf.js legacy build for text, pdf-lib for forms). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib'
import { ROOT } from './helpers'

type PdfJs = typeof import('pdfjs-dist')

// pdf.js wants a trailing '/', which join() would turn into '\' on Windows.
const STANDARD_FONT_DATA_URL = join(ROOT, 'node_modules/pdfjs-dist/standard_fonts') + '/'

let pdfjsPromise: Promise<PdfJs> | null = null
function pdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import(pathToFileURL(join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href) as Promise<PdfJs>
  return pdfjsPromise
}

/** Text of every page (items joined with spaces), using pdf.js like the app does. */
export async function pdfPageTexts(path: string): Promise<string[]> {
  const lib = await pdfjs()
  const task = lib.getDocument({
    data: new Uint8Array(readFileSync(path)),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0
  })
  const doc = await task.promise
  try {
    const out: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent()
      out.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
    }
    return out
  } finally {
    await task.destroy()
  }
}

export async function pdfPageCount(path: string): Promise<number> {
  return (await PDFDocument.load(readFileSync(path), { ignoreEncryption: true })).getPageCount()
}

/** /Rotate of every page. */
export async function pdfRotations(path: string): Promise<number[]> {
  const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true })
  return doc.getPages().map((p) => p.getRotation().angle)
}

/** Value of a text form field (undefined if the field does not exist). */
export async function pdfTextFieldValue(path: string, name: string): Promise<string | undefined> {
  const doc = await PDFDocument.load(readFileSync(path))
  const field = doc.getForm().getFields().find((f) => f.getName() === name)
  if (!field) return undefined
  return doc.getForm().getTextField(name).getText() ?? ''
}

export interface PdfTextItem {
  str: string
  /** Baseline origin in PDF user space. */
  x: number
  y: number
}

/** Text items of one page (0-based) with their positions. */
export async function pdfTextItems(path: string, pageIndex: number): Promise<PdfTextItem[]> {
  const lib = await pdfjs()
  const task = lib.getDocument({
    data: new Uint8Array(readFileSync(path)),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0
  })
  const doc = await task.promise
  try {
    const content = await (await doc.getPage(pageIndex + 1)).getTextContent()
    return content.items.flatMap((it) =>
      'str' in it && it.str.trim() ? [{ str: it.str, x: it.transform[4], y: it.transform[5] }] : []
    )
  } finally {
    await task.destroy()
  }
}

/** Subtypes of the annotations on one page (0-based), e.g. ['Link', 'Text']. */
export async function pdfAnnotationSubtypes(path: string, pageIndex: number): Promise<string[]> {
  const doc = await PDFDocument.load(readFileSync(path))
  const annots = doc.getPage(pageIndex).node.Annots()
  if (!annots) return []
  return annots.asArray().map((ref) => {
    const dict = doc.context.lookup(ref, PDFDict)
    return String(dict.get(PDFName.of('Subtype'))).replace(/^\//, '')
  })
}

/** Field names and the rectangle of each field's first widget ([x, y, width, height], PDF space). */
export async function pdfFieldRects(path: string): Promise<Record<string, [number, number, number, number]>> {
  const doc = await PDFDocument.load(readFileSync(path))
  const out: Record<string, [number, number, number, number]> = {}
  for (const f of doc.getForm().getFields()) {
    const w = f.acroField.getWidgets()[0]
    if (!w) continue
    const r = w.getRectangle()
    out[f.getName()] = [r.x, r.y, r.width, r.height]
  }
  return out
}

/**
 * Whether `text` occurs anywhere in the file after decoding its streams: as literal bytes or
 * as hex (how pdf-lib writes standard-font text). Used to prove redacted text is gone.
 */
export async function pdfContainsRaw(path: string, text: string): Promise<boolean> {
  const { PDFRawStream, PDFStream, decodePDFRawStream } = await import('@cantoo/pdf-lib')
  const doc = await PDFDocument.load(readFileSync(path), { updateMetadata: false })
  const hex = Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    let s: string
    if (obj instanceof PDFStream) {
      let data: Uint8Array
      try {
        data = obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents()
      } catch {
        data = obj.getContents()
      }
      s = Buffer.from(data).toString('latin1')
    } else {
      s = obj.toString()
    }
    if (s.includes(text) || s.replace(/\s+/g, '').toLowerCase().includes(hex)) return true
  }
  return false
}

export type PaintedItem = { kind: 'image'; x: number; y: number } | { kind: 'path'; color: string } | { kind: 'text'; text: string }

/**
 * What pdf.js paints on one page (0-based), in drawing order: images (with the lower-left
 * corner of the unit square in PDF space), filled/stroked paths (fill color), text.
 */
export async function pdfPaintOrder(path: string, pageIndex: number): Promise<PaintedItem[]> {
  const lib = await pdfjs()
  const { OPS } = lib
  const task = lib.getDocument({
    data: new Uint8Array(readFileSync(path)),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0
  })
  const doc = await task.promise
  try {
    const list = await (await doc.getPage(pageIndex + 1)).getOperatorList()
    const out: PaintedItem[] = []
    type State = { ctm: number[]; fill: string }
    let st: State = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000' }
    const stack: State[] = []
    const mul = (a: number[], b: number[]) => [
      a[0] * b[0] + a[1] * b[2],
      a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2],
      a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4],
      a[4] * b[1] + a[5] * b[3] + b[5]
    ]
    const paints = new Set<number>([OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i]
      const args = list.argsArray[i] as unknown[]
      if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
        stack.push(st)
        st = { ...st }
        const m = fn === OPS.paintFormXObjectBegin ? (args[0] as number[] | null) : null
        if (m) st.ctm = mul(Array.from(m), st.ctm)
      } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) st = stack.pop() ?? st
      else if (fn === OPS.transform) st.ctm = mul(args as number[], st.ctm)
      else if (fn === OPS.setFillRGBColor) st.fill = String(args[0])
      else if (fn === OPS.constructPath && paints.has(args[0] as number)) out.push({ kind: 'path', color: st.fill })
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        out.push({ kind: 'image', x: st.ctm[4], y: st.ctm[5] })
      } else if (fn === OPS.showText) {
        const text = (args[0] as Array<{ unicode?: string } | number>).map((g) => (typeof g === 'object' && g ? (g.unicode ?? '') : '')).join('')
        if (text.trim()) out.push({ kind: 'text', text })
      }
    }
    return out
  } finally {
    await task.destroy()
  }
}
