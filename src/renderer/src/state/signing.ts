/**
 * Digital-signature state: the signing request waiting for the user to draw the signature box,
 * which documents are exactly as opened from their file, and whether this window's signatures
 * were removed by saving changes.
 */
import { create } from 'zustand'
import type { EditorDocument, PdfSignatureInfo } from '@core'
import type { UnlockedCertificate } from '@shared/ipc'
import { useEditor, type PendingImage } from './store'

export interface SignRequest {
  certificate: UnlockedCertificate
  /** An empty signature field (current name), or a new field drawn on a page. */
  target: { kind: 'field'; name: string } | { kind: 'new' }
  reason: string
  location: string
  contactInfo: string
  /** Name shown in the visible signature. */
  displayName: string
  showDate: boolean
  image: PendingImage | null
}

interface SigningState {
  /** Waiting for the signature box to be drawn on a page (Esc cancels). */
  placing: SignRequest | null
  /** docSession whose signatures were removed from the file by saving changes. */
  removedInSession: number | null
  /** docSession in which the "saving removes signatures" notice was shown. */
  warnedInSession: number | null
}

export const useSigning = create<SigningState>()(() => ({ placing: null, removedInSession: null, warnedInSession: null }))

const opened = new WeakSet<EditorDocument>()

/** `doc` was just loaded from a file: its primary source bytes are that file. */
export function rememberOpenedDocument(doc: EditorDocument): void {
  opened.add(doc)
}

/** The document is exactly as opened (no edits, or all of them undone). */
export function isUnchangedSinceOpen(doc: EditorDocument): boolean {
  return opened.has(doc)
}

/** Signatures of the document's file (primary source). */
export function documentSignatures(doc: EditorDocument | null): PdfSignatureInfo[] {
  if (!doc?.primarySourceId) return []
  return doc.sources[doc.primarySourceId]?.signatures ?? []
}

/** The open file is digitally signed (and the signatures were not removed by saving changes). */
export function hasLiveSignatures(doc: EditorDocument | null): boolean {
  return documentSignatures(doc).length > 0 && useSigning.getState().removedInSession !== useEditor.getState().docSession
}
