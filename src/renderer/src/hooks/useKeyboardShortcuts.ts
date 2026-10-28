/**
 * Workspace keyboard shortcuts (also used in the browser build where there is no app menu).
 * In text fields undo/redo edit the text (run here, so it works the same on every platform)
 * and select-all stays native.
 */
import { useEffect } from 'react'
import type { MenuAction } from '@shared/ipc'
import { runCommand, runNativeTextCommand } from '@renderer/actions/commands'
import { closeFind } from '@renderer/actions/find'
import { isEditableTarget, isMac } from '@renderer/actions/util'
import { isDesktop } from '@renderer/platform'
import { firstPage, lastPage, nextPage, previousPage } from '@renderer/actions/viewActions'
import { isDialogOpen } from '@renderer/state/dialogs'
import { useFind } from '@renderer/state/find'

/** Map a keydown with the platform modifier (Cmd on macOS, Ctrl elsewhere) to a command. */
export function shortcutAction(e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>): MenuAction | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey) return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.shiftKey) {
    switch (key) {
      case 's':
        return 'save-as'
      case 'z':
        return 'redo'
      case '+':
      case '=':
        return 'zoom-in'
      case '_':
      case '-':
        return 'zoom-out'
      default:
        return null
    }
  }
  switch (key) {
    case 'o':
      return 'open'
    case 's':
      return 'save'
    case 'z':
      return 'undo'
    case 'y':
      return isMac ? null : 'redo'
    case '=':
    case '+':
      return 'zoom-in'
    case '-':
      return 'zoom-out'
    case '0':
      return 'zoom-reset'
    case 'f':
      return 'find'
    case 'p':
      return 'print'
    case 'a':
      return 'select-all-pages'
    case 'n':
      return 'new'
    default:
      return null
  }
}

/** Text-field undo/redo: executed on the field here (and the menu echo is ignored). */
const TEXT_FIELD_EDITING = new Set<MenuAction>(['undo', 'redo'])
/** Shortcuts left completely to the browser in a text field (native select-all). */
const TEXT_FIELD_NATIVE = new Set<MenuAction>(['select-all-pages'])
/**
 * In the desktop app these shortcuts are left to the application menu, which routes them in
 * the main process (File > New opens a new window when this one shows a document).
 */
const MENU_ONLY_IN_DESKTOP = new Set<MenuAction>(['new'])

export function handleShortcutKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return
  const editable = isEditableTarget(e.target)
  const action = shortcutAction(e)
  if (action) {
    if (editable && TEXT_FIELD_EDITING.has(action)) {
      // Chromium on macOS only performs text undo via the Edit menu, whose Undo item is ours;
      // elsewhere the browser would do it natively. Run it here once on every platform.
      e.preventDefault()
      runNativeTextCommand(action)
      return
    }
    if (editable && TEXT_FIELD_NATIVE.has(action)) return
    if (isDesktop && MENU_ONLY_IN_DESKTOP.has(action)) return
    if (isDialogOpen()) return
    e.preventDefault()
    runCommand(action, 'keyboard')
    return
  }
  if (isDialogOpen() || editable || e.metaKey || e.ctrlKey || e.altKey) return
  switch (e.key) {
    case 'PageDown':
      e.preventDefault()
      nextPage()
      break
    case 'PageUp':
      e.preventDefault()
      previousPage()
      break
    case 'Home':
      e.preventDefault()
      firstPage()
      break
    case 'End':
      e.preventDefault()
      lastPage()
      break
    case 'Escape':
      if (useFind.getState().open) closeFind()
      break
    case 'F3':
      e.preventDefault()
      runCommand('find', 'keyboard')
      break
  }
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKeyDown)
    return () => window.removeEventListener('keydown', handleShortcutKeyDown)
  }, [])
}
