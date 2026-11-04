/**
 * Helpers for the redaction tests: building documents with redaction areas and searching a
 * saved file for text that must be gone (pdf.js extraction and raw decoded streams).
 */
import { PDFDocument, PDFRawStream, PDFStream, decodePDFRawStream, type PDFDict } from '@cantoo/pdf-lib'
import { addRedactions, exportDocument, makeRedaction, openDocument, type Box, type EditorDocument, type ExportOptions, type RedactionArea } from '../../src/core'
import { allPagesText } from './helpers'

/** Open `bytes` and mark `boxes` (page space) for redaction on page `pageIndex`. */
export async function withRedactions(
  bytes: Uint8Array,
  boxes: Box[],
  pageIndex = 0,
  extra: Partial<RedactionArea> = {}
): Promise<EditorDocument> {
  const doc = await openDocument(bytes, 'r.pdf')
  const pageId = doc.pages[pageIndex].id
  return addRedactions(
    doc,
    boxes.map((b) => ({ ...makeRedaction(pageId, b), ...extra }))
  )
}

export async function redact(bytes: Uint8Array, boxes: Box[], pageIndex = 0, options?: ExportOptions): Promise<Uint8Array> {
  return exportDocument(await withRedactions(bytes, boxes, pageIndex), options)
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function hexOf(text: string): string {
  return Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

/** Every stream of the file, decoded where possible (latin1), plus every non-stream object as written. */
export async function decodedObjects(bytes: Uint8Array): Promise<{ streams: string[]; dicts: string[] }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const streams: string[] = []
  const dicts: string[] = []
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      let data: Uint8Array
      try {
        data = obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents()
      } catch {
        data = obj.getContents()
      }
      streams.push(latin1(data))
      dicts.push((obj.dict as PDFDict).toString())
    } else {
      dicts.push(obj.toString())
    }
  }
  return { streams, dicts }
}

/** Whether `text` occurs anywhere in the decoded file: as literal bytes, hex, or UTF-16BE hex. */
export async function rawContains(bytes: Uint8Array, text: string): Promise<boolean> {
  const { streams, dicts } = await decodedObjects(bytes)
  const hex = hexOf(text).toLowerCase()
  const utf16 = Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  const all = [...streams, ...dicts]
  return all.some((s) => {
    if (s.includes(text)) return true
    const compact = s.replace(/\s+/g, '').toLowerCase()
    return compact.includes(hex) || compact.includes(utf16)
  })
}

export async function pdfjsText(bytes: Uint8Array): Promise<string> {
  return (await allPagesText(bytes)).join('\n')
}
