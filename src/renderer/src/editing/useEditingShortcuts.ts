/**
 * Keyboard shortcuts for the editing layer (delete/nudge selected object, Escape, tool hotkeys,
 * Ctrl/Cmd+] / [ (with Shift: to front / back) to re-order selected existing content).
 * Called once from App. Ignores key events that originate in inputs, textareas and contenteditables.
 */
import { useEffect } from 'react'
import { viewToPage, type PageEntry, type Point } from '@core'
import { selectOcrLine, useOcrUi } from '@renderer/state/ocr'
import { useEditor } from '@renderer/state/store'
import { useEditing } from './editingState'
import { isFieldTool } from './fields'
import { duplicateSelected } from './objects'
import { deleteSelection, nudgeSelection, reorderSelection, selectionPageId } from './selection'
import { activateTool, TOOL_BY_HOTKEY } from './tools'
import { handleRedactionKey } from '@renderer/actions/redactActions'

/** True for targets that take text input (shortcuts must not fire there). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true
  return false
}

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }
}

/** Convert an on-screen direction into a page-space delta for a (possibly rotated) page. */
export function screenDeltaToPage(page: PageEntry, d: Point): Point {
  const o = viewToPage({ x: 0, y: 0 }, page, 1)
  const p = viewToPage(d, page, 1)
  return { x: p.x - o.x, y: p.y - o.y }
}

export function handleEditingKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || isEditableTarget(e.target)) return
  // Modal dialogs handle their own keys.
  if (e.target instanceof Element && e.target.closest('[role="dialog"], [data-testid="dialog"]')) return
  if (useEditing.getState().signatureOpen) return
  const s = useEditor.getState()
  if (!s.doc) return
  if (handleRedactionKey(e)) return
  const mod = e.ctrlKey || e.metaKey

  if (e.key === 'Escape') {
    const editing = useEditing.getState()
    // A recognized line selected in Edit content counts like a selected content item.
    const selection = !!(s.selectedObjectId || s.selectedElement || useOcrUi.getState().selectedLine)
    const hadSomething = !!(selection || s.pendingImage || s.tool !== 'select' || editing.openNoteId)
    editing.cancelGesture()
    editing.openNote(null)
    editing.setEditingContent(null)
    if (s.pendingImage) s.setPendingImage(null)
    s.selectObject(null)
    s.selectElement(null)
    selectOcrLine(null)
    // Modes (Edit content, Prepare form) are left with a second Escape, once nothing is selected.
    if (isFieldTool(s.tool)) s.setTool('form-design')
    else if (s.tool !== 'select' && !((s.tool === 'edit-content' || s.tool === 'form-design') && selection)) s.setTool('select')
    if (hadSomething) e.preventDefault()
    return
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) {
    if (deleteSelection()) e.preventDefault()
    return
  }

  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
    if (s.selectedObjectId) {
      e.preventDefault()
      duplicateSelected()
    }
    return
  }

  if (e.key === 'Enter' && !mod && !e.altKey && s.selectedElement?.kind === 'content') {
    // Retype the selected text item (the overlay ignores non-text items).
    e.preventDefault()
    const { pageId, itemId } = s.selectedElement
    useEditing.getState().setEditingContent({ pageId, itemId })
    return
  }

  // By character, not key position (Ctrl/Cmd+Plus is on that key in some layouts); typing a
  // bracket may need Alt (AltGr / Option).
  const bracket = e.key === ']' || e.key === '}' ? 1 : e.key === '[' || e.key === '{' ? -1 : 0
  if (bracket && mod && s.selectedElement?.kind === 'content') {
    e.preventDefault()
    reorderSelection(bracket > 0 ? (e.shiftKey ? 'front' : 'forward') : e.shiftKey ? 'back' : 'backward')
    return
  }

  const dir = ARROWS[e.key]
  if (dir && !mod && !e.altKey) {
    const pageId = selectionPageId()
    const page = pageId ? s.doc.pages.find((p) => p.id === pageId) : undefined
    if (!page) return
    const step = e.shiftKey ? 10 : 1
    if (nudgeSelection(screenDeltaToPage(page, { x: dir.x * step, y: dir.y * step }))) e.preventDefault()
    return
  }

  if (!mod && !e.altKey && !e.shiftKey && e.key.length === 1) {
    const tool = TOOL_BY_HOTKEY[e.key.toLowerCase()]
    if (tool) {
      e.preventDefault()
      activateTool(tool)
    }
  }
}

export function useEditingShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', handleEditingKeyDown)
    return () => window.removeEventListener('keydown', handleEditingKeyDown)
  }, [])
}
