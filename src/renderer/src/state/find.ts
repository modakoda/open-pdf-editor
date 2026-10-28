/** Find-in-document state (not undoable, not part of the editor store). */
import { create } from 'zustand'
import type { Box } from '@core'

export interface FindMatch {
  pageId: string
  /** Rectangles in page space covering the match. */
  rects: Box[]
}

export interface FindState {
  open: boolean
  query: string
  matches: FindMatch[]
  /** Index into `matches` of the highlighted match (-1 when none). */
  active: number
  searching: boolean
  /** Incremented to ask the find bar to focus its input. */
  focusNonce: number
}

export const useFind = create<FindState>()(() => ({
  open: false,
  query: '',
  matches: [],
  active: -1,
  searching: false,
  focusNonce: 0
}))
