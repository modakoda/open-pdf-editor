/**
 * Per-export caches of embedded fonts and images (internal to the exporter).
 */
import fontkit from '@cantoo/fontkit'
import type { PDFDocument, PDFFont, PDFImage } from '@cantoo/pdf-lib'
import { prepareText, type ResolvedTextFont } from './text'

export class EmbedCache {
  private fonts = new Map<PDFDocument, Map<string, Promise<PDFFont>>>()
  private images = new Map<PDFDocument, Map<Uint8Array, Promise<PDFImage>>>()
  private fontkitRegistered = new WeakSet<PDFDocument>()

  private ensureFontkit(doc: PDFDocument): void {
    if (this.fontkitRegistered.has(doc)) return
    doc.registerFontkit(fontkit)
    this.fontkitRegistered.add(doc)
  }

  font(doc: PDFDocument, resolved: ResolvedTextFont): Promise<PDFFont> {
    let perDoc = this.fonts.get(doc)
    if (!perDoc) {
      perDoc = new Map()
      this.fonts.set(doc, perDoc)
    }
    const key = resolved.unicode ? `u:${resolved.fontKey}` : `s:${resolved.standardFont}`
    let font = perDoc.get(key)
    if (!font) {
      if (resolved.unicode) {
        this.ensureFontkit(doc)
        font = doc.embedFont(resolved.fontBytes, { subset: true, postscriptName: resolved.postscriptName })
      } else {
        font = doc.embedFont(resolved.standardFont)
      }
      perDoc.set(key, font)
    }
    return font
  }

  /** Font able to draw `text` (sans family): Helvetica for WinAnsi text, else a Unicode font (bundled or fallback). */
  fontForText(doc: PDFDocument, text: string): Promise<PDFFont> {
    return this.font(doc, prepareText(text, { font: 'sans', bold: false, italic: false }).font)
  }

  image(doc: PDFDocument, data: Uint8Array, mimeType: string): Promise<PDFImage> {
    let perDoc = this.images.get(doc)
    if (!perDoc) {
      perDoc = new Map()
      this.images.set(doc, perDoc)
    }
    let img = perDoc.get(data)
    if (!img) {
      // Trust the file signature over the declared MIME type.
      const png = isPng(data) || (!isJpeg(data) && mimeType === 'image/png')
      img = png ? doc.embedPng(data) : doc.embedJpg(data)
      perDoc.set(data, img)
    }
    return img
  }
}

function isPng(data: Uint8Array): boolean {
  return data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
}

function isJpeg(data: Uint8Array): boolean {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8
}
