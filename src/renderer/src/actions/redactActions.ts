/**
 * Redaction commands: marking every Find match, the "Apply redactions" confirmation shown
 * before saving, and keyboard handling for the selected area of the Redact tool.
 */
import {
  activeRedactions,
  addRedactions,
  clamp,
  makeRedaction,
  removeRedactions,
  snapToGlyphs,
  updateRedaction,
  viewToPage,
  type Box,
  type EditorDocument,
  type RedactionArea
} from '@core'
import { useRedaction } from '@renderer/editing/redactionState'
import { openDialog } from '@renderer/state/dialogs'
import { useFind } from '@renderer/state/find'
import { editor, isEditableTarget, notifyInfo } from './util'

export interface RedactionChoice {
  /** Also remove metadata, attachments, scripts and hidden layers. */
  sanitize: boolean
}

/** Areas a save of `doc` applies (areas of deleted pages are ignored). */
export function pendingRedactions(doc: EditorDocument | null): RedactionArea[] {
  return doc ? activeRedactions(doc) : []
}

/**
 * Before saving: ask to apply the marked redactions. Resolves undefined when there is nothing
 * to apply, null when the user cancels.
 */
export async function confirmRedactions(doc: EditorDocument | null): Promise<RedactionChoice | null | undefined> {
  const areas = pendingRedactions(doc)
  if (!areas.length) return undefined
  return openDialog<RedactionChoice>({ kind: 'redact', areas: areas.length, pages: new Set(areas.map((a) => a.pageId)).size })
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** Mark every match of the current search for redaction (one undo step). Returns the number of areas. */
export async function redactAllMatches(): Promise<number> {
  const { matches } = useFind.getState()
  const doc = editor().doc
  if (!doc || !matches.length) return 0
  const byPage = new Map<string, Box[]>()
  for (const m of matches) byPage.set(m.pageId, [...(byPage.get(m.pageId) ?? []), ...m.rects])
  const ui = useRedaction.getState()
  const areas: RedactionArea[] = []
  for (const [pageId, rects] of byPage) {
    let boxes = rects
    try {
      boxes = await snapToGlyphs(doc, pageId, rects)
    } catch {
      boxes = rects
    }
    for (const b of boxes) {
      if (!(b.width > 0 && b.height > 0)) continue
      const box = { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) }
      areas.push(makeRedaction(pageId, box, { fillColor: ui.fillColor, overlayText: ui.overlayText }))
    }
  }
  if (!areas.length || editor().doc !== doc) return 0
  editor().apply((d) => addRedactions(d, areas))
  editor().setTool('redact')
  ui.select(null)
  notifyInfo(`Marked ${areas.length} ${areas.length === 1 ? 'area' : 'areas'} for redaction. Review them, then save to apply.`)
  return areas.length
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}

/** Delete / Escape / arrow keys for the redaction area selected with the Redact tool. True when handled. */
export function handleRedactionKey(e: KeyboardEvent): boolean {
  const s = editor()
  if (s.tool !== 'redact' || !s.doc || isEditableTarget(e.target)) return false
  const ui = useRedaction.getState()
  const area = s.doc.redactions?.find((r) => r.id === ui.selectedId)
  if (!area || e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    s.apply((d) => removeRedactions(d, [area.id]))
    ui.select(null)
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    ui.select(null)
    return true
  }
  const dir = ARROWS[e.key]
  const page = s.doc.pages.find((p) => p.id === area.pageId)
  if (!dir || !page) return false
  e.preventDefault()
  const step = e.shiftKey ? 10 : 1
  // On-screen direction → page space (the page may be rotated).
  const o = viewToPage({ x: 0, y: 0 }, page, 1)
  const q = viewToPage({ x: dir[0] * step, y: dir[1] * step }, page, 1)
  const x = clamp(round2(area.x + q.x - o.x), 0, Math.max(0, page.width - area.width))
  const y = clamp(round2(area.y + q.y - o.y), 0, Math.max(0, page.height - area.height))
  s.apply((d) => updateRedaction(d, area.id, { x, y }), { coalesceKey: `redaction-nudge-${area.id}` })
  return true
}
