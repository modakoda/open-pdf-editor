/**
 * UI state of the Redact tool (not part of the document): the selected redaction area and the
 * defaults for new areas.
 */
import { create } from 'zustand'
import { DEFAULT_REDACTION_FILL, type Color } from '@core'

export interface RedactionUiState {
  selectedId: string | null
  /** Fill of new areas (null = no fill). */
  fillColor: Color | null
  /** Overlay text of new areas ('' = none). */
  overlayText: string
  select(id: string | null): void
  setDefaults(patch: Partial<Pick<RedactionUiState, 'fillColor' | 'overlayText'>>): void
}

export const useRedaction = create<RedactionUiState>()((set) => ({
  selectedId: null,
  fillColor: DEFAULT_REDACTION_FILL,
  overlayText: '',
  select(selectedId) {
    set({ selectedId })
  },
  setDefaults(patch) {
    set(patch)
  }
}))
