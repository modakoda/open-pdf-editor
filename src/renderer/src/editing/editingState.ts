/**
 * Local UI state of the editing layer that is not part of the document or the shared store:
 * which text object is being edited inline, which sticky note popover is open, whether the
 * signature dialog is shown, and a token used to cancel in-progress pointer gestures.
 */
import { create } from 'zustand'

export interface EditingState {
  /** Text object currently edited with the inline textarea. */
  editingTextId: string | null
  openNoteId: string | null
  signatureOpen: boolean
  /** Incremented to abort any in-progress pointer gesture (Escape). */
  cancelToken: number
  /** Last committed ink stroke; following strokes shortly after are merged into it. */
  lastInk: { id: string; pageId: string; at: number } | null
  /** Existing text item being retyped inline (Edit content). */
  editingContent: { pageId: string; itemId: string } | null
  /** Radio group the next radio button created with the field tool joins (null = new group). */
  radioJoinGroup: string | null

  startTextEdit(id: string): void
  stopTextEdit(id?: string): void
  openNote(id: string | null): void
  setSignatureOpen(open: boolean): void
  cancelGesture(): void
  setLastInk(lastInk: EditingState['lastInk']): void
  setEditingContent(ref: EditingState['editingContent']): void
  setRadioJoinGroup(name: string | null): void
  reset(): void
}

export const useEditing = create<EditingState>()((set, get) => ({
  editingTextId: null,
  openNoteId: null,
  signatureOpen: false,
  cancelToken: 0,
  lastInk: null,
  editingContent: null,
  radioJoinGroup: null,

  startTextEdit(id) {
    set({ editingTextId: id, openNoteId: null })
  },
  stopTextEdit(id) {
    if (id === undefined || get().editingTextId === id) set({ editingTextId: null })
  },
  openNote(openNoteId) {
    set({ openNoteId })
  },
  setSignatureOpen(signatureOpen) {
    set({ signatureOpen })
  },
  cancelGesture() {
    set({ cancelToken: get().cancelToken + 1, lastInk: null })
  },
  setLastInk(lastInk) {
    set({ lastInk })
  },
  setEditingContent(editingContent) {
    set({ editingContent })
  },
  setRadioJoinGroup(radioJoinGroup) {
    set({ radioJoinGroup })
  },
  reset() {
    set({ editingTextId: null, openNoteId: null, signatureOpen: false, lastInk: null, editingContent: null, radioJoinGroup: null })
  }
}))
