/** Fixtures built from committed files under tests/fixtures/assets (Node only). */
import { readFileSync } from 'node:fs'
import { PDFDocument } from '@cantoo/pdf-lib'

/**
 * A "scanned" page: one JPEG of printed text (assets/scan-sample.jpg, 200 dpi) covering a
 * 420×260 pt page, no text layer. Used for text recognition (OCR).
 */
export async function makeScannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const jpg = await doc.embedJpg(new Uint8Array(readFileSync(new URL('./assets/scan-sample.jpg', import.meta.url))))
  const page = doc.addPage([420, 260])
  page.drawImage(jpg, { x: 0, y: 0, width: 420, height: 260 })
  return doc.save()
}
