/**
 * Removing digital signatures from a document that is about to be rewritten (exported): their
 * byte ranges would no longer match, so they would show as broken. Signature fields stay, empty.
 */
import { PDFDict, PDFName, type PDFDocument } from '@cantoo/pdf-lib'
import { listFields } from './fields'

const N = (s: string) => PDFName.of(s)

/** Clears every signed signature field (value and appearance). Returns how many were signed. */
export function removeSignatures(doc: PDFDocument): number {
  let count = 0
  let fields: ReturnType<typeof listFields>
  try {
    fields = listFields(doc)
  } catch {
    return 0
  }
  for (const field of fields) {
    if (field.type !== 'Sig' || !(field.dict.lookup(N('V')) instanceof PDFDict)) continue
    field.dict.delete(N('V'))
    for (const widget of field.widgets) widget.dict.delete(N('AP'))
    count++
  }
  if (count) {
    // Certification / usage-rights signatures and validation data refer to the removed signatures.
    doc.catalog.delete(N('Perms'))
    doc.catalog.delete(N('DSS'))
  }
  return count
}
