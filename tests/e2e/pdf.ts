/** Inspecting saved PDFs in the test process (pdf.js legacy build for text, pdf-lib for forms). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from '@cantoo/pdf-lib'
import { ROOT } from './helpers'

type PdfJs = typeof import('pdfjs-dist')

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
    standardFontDataUrl: join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/'),
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
