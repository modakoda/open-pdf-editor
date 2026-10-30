/** Text recognition UI state (not undoable): the recognized line selected in Edit content. */
import { create } from 'zustand'

export interface OcrLineRef {
  pageId: string
  lineId: string
}

export interface OcrUiState {
  selectedLine: OcrLineRef | null
}

export const useOcrUi = create<OcrUiState>()(() => ({ selectedLine: null }))

export function selectOcrLine(ref: OcrLineRef | null): void {
  const current = useOcrUi.getState().selectedLine
  if (current?.pageId === ref?.pageId && current?.lineId === ref?.lineId) return
  useOcrUi.setState({ selectedLine: ref })
}
