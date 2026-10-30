/**
 * Digital signing: Sign dialog → (optionally) draw the signature box → export → sign as an
 * incremental update → Save As → the signed file becomes the open document.
 */
import {
  exportDocument,
  getEffectiveFormFields,
  openDocument,
  signPdf,
  type Box,
  type EditorDocument,
  type SignatureTarget
} from '@core'
import { platform } from '@renderer/platform'
import { openDialog } from '@renderer/state/dialogs'
import { documentSignatures, isUnchangedSinceOpen, useSigning, type SignRequest } from '@renderer/state/signing'
import { useEditor } from '@renderer/state/store'
import { ensurePdfName, installDocument, UNTITLED_NAME, withBusy } from './fileActions'
import { baseName, editor, notifyError, notifyInfo } from './util'

/** An empty signature field the user can sign into. */
export interface SignatureFieldChoice {
  /** Current (effective) field name. */
  name: string
  pageId?: string
  /** 1-based page number in the document. */
  pageNumber?: number
}

/** Unsigned signature fields of the document (existing fields of the file, and new ones). */
export function emptySignatureFieldChoices(doc: EditorDocument): SignatureFieldChoice[] {
  const out: SignatureFieldChoice[] = []
  const primary = doc.primarySourceId
  if (primary) {
    const signed = new Set(documentSignatures(doc).map((s) => s.fieldName))
    for (const field of getEffectiveFormFields(doc, primary)) {
      if (field.type !== 'signature' || signed.has(field.originalName)) continue
      const widget = field.widgets[0]
      const index = widget
        ? doc.pages.findIndex((p) => p.source.kind === 'source' && p.source.sourceId === primary && p.source.pageIndex === widget.pageIndex)
        : -1
      // Fields on removed pages are removed on export.
      if (index < 0) continue
      out.push({ name: field.name, pageId: doc.pages[index].id, pageNumber: index + 1 })
    }
  }
  for (const obj of doc.objects) {
    if (obj.type !== 'field' || obj.fieldType !== 'signature') continue
    const index = doc.pages.findIndex((p) => p.id === obj.pageId)
    if (index >= 0 && !out.some((f) => f.name === obj.name)) out.push({ name: obj.name, pageId: obj.pageId, pageNumber: index + 1 })
  }
  return out
}

/** Whether this window's build can sign (the desktop shell, or the browser fallback). */
export function canSign(): boolean {
  return typeof platform.openCertificateDialog === 'function' && typeof platform.signWithCertificate === 'function'
}

/** Opens the Sign dialog and continues with the signature box or signing. */
export async function startSigning(): Promise<void> {
  const { doc } = editor()
  if (!doc) return
  if (!canSign()) {
    editor().showNotice('error', 'Digital signing is not available in this version.')
    return
  }
  if (!doc.pages.length) {
    editor().showNotice('error', 'The document has no pages. Add a page before signing.')
    return
  }
  cancelPlacement()
  const request = await openDialog<SignRequest>({ kind: 'sign' })
  if (!request) return
  if (request.target.kind === 'new') {
    useSigning.setState({ placing: request })
    notifyInfo('Drag a box on a page where the signature should appear (Esc to cancel).')
    return
  }
  await signAndSave(request, { fieldName: request.target.name })
}

/** The signature box was drawn: sign. */
export async function completePlacement(pageId: string, box: Box): Promise<void> {
  const request = useSigning.getState().placing
  if (!request) return
  useSigning.setState({ placing: null })
  const { doc } = editor()
  const pageIndex = doc?.pages.findIndex((p) => p.id === pageId) ?? -1
  if (pageIndex < 0) {
    releaseCertificate(request)
    return
  }
  await signAndSave(request, { pageIndex, box })
}

// A box drawn for one document must not sign another.
useEditor.subscribe((s, prev) => {
  if (s.docSession !== prev.docSession) cancelPlacement()
})

export function cancelPlacement(): void {
  const request = useSigning.getState().placing
  if (!request) return
  useSigning.setState({ placing: null })
  releaseCertificate(request)
}

function releaseCertificate(request: SignRequest): void {
  try {
    platform.releaseCertificate?.(request.certificate.id)
  } catch {
    /* ignore */
  }
}

function signedName(fileName: string): string {
  const name = ensurePdfName(fileName || UNTITLED_NAME)
  return /-signed\.pdf$/i.test(name) ? name : name.replace(/\.pdf$/i, '-signed.pdf')
}

/**
 * Signs the current document and saves it under a new name. The document is exported first
 * (unless it is unchanged since it was opened: then the file itself is signed, which keeps
 * existing signatures valid); the signature is appended as an incremental update.
 */
export async function signAndSave(request: SignRequest, target: SignatureTarget): Promise<boolean> {
  const { doc, filePath, fileName } = editor()
  if (!doc) {
    releaseCertificate(request)
    return false
  }
  const { certificate } = request
  try {
    const signed = await withBusy('Signing…', async () => {
      const primary = doc.primarySourceId ? doc.sources[doc.primarySourceId] : undefined
      const base = primary && !primary.isEncrypted && isUnchangedSinceOpen(doc) ? primary.bytes : await exportDocument(doc)
      return signPdf(base, {
        signer: {
          certificate: certificate.certificate,
          chain: certificate.chain,
          sign: (data) => platform.signWithCertificate!(certificate.id, data)
        },
        target,
        reason: request.reason || undefined,
        location: request.location || undefined,
        contactInfo: request.contactInfo || undefined,
        appearance: {
          name: request.displayName || undefined,
          showDate: request.showDate,
          image: request.image ? { data: request.image.data, mimeType: request.image.mimeType } : undefined
        }
      })
    })
    const defaultPath = filePath ? filePath.replace(/[^\\/]*$/, signedName(baseName(filePath))) : signedName(fileName)
    const path = await platform.saveFileDialog({ defaultPath, bytes: signed })
    if (!path) return false
    const name = baseName(path)
    const reopened = await withBusy(`Opening ${name}…`, () => openDocument(signed, name))
    installDocument(reopened, { filePath: path, fileName: name })
    notifyInfo(`Signed and saved ${name}`)
    return true
  } catch (err) {
    notifyError('Could not sign the document', err)
    return false
  } finally {
    releaseCertificate(request)
  }
}
