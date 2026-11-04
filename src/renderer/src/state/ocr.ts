/** Text recognition UI state (not undoable): the recognized line selected in Edit content. */
import { create } from 'zustand'
import { useEditor } from './store'

export interface OcrLineRef {
  pageId: string
  lineId: string
}

export interface OcrUiState {
  selectedLine: OcrLineRef | null
}

export const useOcrUi = create<OcrUiState>()(() => ({ selectedLine: null }))

// Lines are selected in Edit content only: another tool or document drops the selection.
useEditor.subscribe((s, prev) => {
  if ((s.tool !== prev.tool || s.docSession !== prev.docSession) && useOcrUi.getState().selectedLine) {
    useOcrUi.setState({ selectedLine: null })
  }
})

export function selectOcrLine(ref: OcrLineRef | null): void {
  const current = useOcrUi.getState().selectedLine
  if (current?.pageId === ref?.pageId && current?.lineId === ref?.lineId) return
  useOcrUi.setState({ selectedLine: ref })
}
