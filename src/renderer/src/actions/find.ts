/** Find in document: searches the text of every source page with pdf.js, and text recognized by OCR. */
import { boxCenter } from '@core'
import { getPreviewPage, hasPreviewFailed, previewKeyFor } from '@renderer/pdf/previews'
import {
  findAll,
  getOcrTextIndex,
  getPageTextIndex,
  getPreviewTextIndex,
  rectsForRange,
  type PageTextIndex
} from '@renderer/pdf/textSearch'
import { useFind, type FindMatch } from '@renderer/state/find'
import { editor } from './util'

let searchToken = 0

export function openFind(): void {
  if (!editor().doc) return
  useFind.setState((s) => ({ open: true, focusNonce: s.focusNonce + 1 }))
}

export function closeFind(): void {
  searchToken++
  useFind.setState({ open: false, matches: [], active: -1, searching: false })
}

export function toggleFind(): void {
  if (useFind.getState().open) closeFind()
  else openFind()
}

function revealActive(): void {
  const { matches, active } = useFind.getState()
  const match = matches[active]
  if (!match) return
  const point = match.rects[0] ? boxCenter(match.rects[0]) : undefined
  editor().goToPage(match.pageId, point)
}

/** Search the whole document for `query` (case-insensitive). */
export async function runFind(query: string): Promise<void> {
  const token = ++searchToken
  const { doc } = editor()
  useFind.setState({ query, matches: [], active: -1, searching: !!query && !!doc })
  if (!doc || !query.trim()) {
    useFind.setState({ searching: false })
    return
  }
  const matches: FindMatch[] = []
  for (const page of doc.pages) {
    if (page.source.kind !== 'source') continue
    const source = doc.sources[page.source.sourceId]
    if (!source) continue
    try {
      // Edited pages are searched in their preview document (moved / retyped / deleted text).
      const key = previewKeyFor(doc, page)
      let index: PageTextIndex
      if (key && !hasPreviewFailed(key)) {
        try {
          index = await getPreviewTextIndex(page.id, key, () => getPreviewPage(doc, page.id, key))
        } catch {
          index = await getPageTextIndex(source, page.source.pageIndex)
        }
      } else {
        index = await getPageTextIndex(source, page.source.pageIndex)
      }
      if (token !== searchToken) return
      for (const m of findAll(index.text, query)) {
        matches.push({ pageId: page.id, rects: rectsForRange(index, m.start, m.end) })
      }
    } catch {
      if (token !== searchToken) return
    }
    const ocr = doc.ocr?.[page.id]
    if (ocr) {
      const index = getOcrTextIndex(ocr)
      for (const m of findAll(index.text, query)) {
        matches.push({ pageId: page.id, rects: rectsForRange(index, m.start, m.end) })
      }
    }
    // Publish progress so the first results show up quickly on large documents.
    const hadActive = useFind.getState().active >= 0
    useFind.setState({ matches: [...matches], active: hadActive ? useFind.getState().active : matches.length ? 0 : -1 })
    if (!hadActive && matches.length) revealActive()
  }
  if (token === searchToken) useFind.setState({ searching: false })
}

export function findNext(): void {
  const { matches, active } = useFind.getState()
  if (!matches.length) return
  useFind.setState({ active: (active + 1) % matches.length })
  revealActive()
}

export function findPrevious(): void {
  const { matches, active } = useFind.getState()
  if (!matches.length) return
  useFind.setState({ active: (active - 1 + matches.length) % matches.length })
  revealActive()
}
