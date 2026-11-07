/**
 * Single entry point for every command, whether it comes from the application menu
 * (platform.onMenuAction), a keyboard shortcut or a toolbar button.
 *
 * In Electron a shortcut can reach the renderer both as a keydown and as a menu accelerator;
 * the same action arriving from the other source within DEDUPE_MS is ignored.
 */
import type { MenuAction } from '@shared/ipc'
import { isDialogOpen, openDialog } from '@renderer/state/dialogs'
import {
  closeCurrentDocument,
  newBlankDocument,
  openWithDialog,
  save,
  saveAs
} from './fileActions'
import { openFind } from './find'
import { openOcrDialog } from './ocr'
import {
  deleteSelection,
  deleteTargetPages,
  insertBlankPageAt,
  insertPagesFromFile,
  openExtractDialog,
  openSplitDialog,
  rotateTargetPages,
  selectAllPages
} from './pageActions'
import { printDocument } from './print'
import { startSigning } from './signActions'
import { fitPage, fitWidth, toggleSidebar, zoomIn, zoomOut, zoomReset } from './viewActions'
import { editor, isEditableFocused } from './util'

export type CommandSource = 'menu' | 'keyboard' | 'ui'

const DEDUPE_MS = 200
let last: { action: MenuAction; source: CommandSource; at: number } | null = null

/** Remember that a keyboard shortcut for `action` was seen (even if handled natively). */
export function noteKeyboardAction(action: MenuAction): void {
  last = { action, source: 'keyboard', at: now() }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function isDuplicate(action: MenuAction, source: CommandSource): boolean {
  if (source === 'ui' || !last || last.source === 'ui') return false
  return last.action === action && last.source !== source && now() - last.at < DEDUPE_MS
}

/** Commands that act on a focused text field natively instead of on the document. */
export const NATIVE_TEXT_COMMANDS: Partial<Record<MenuAction, string>> = {
  undo: 'undo',
  redo: 'redo',
  'select-all-pages': 'selectAll',
  'delete-selection': 'delete'
}

/**
 * Runs a text-editing command on the focused text field (from its keyboard shortcut) and
 * remembers it, so the same command arriving from the menu accelerator right after is not
 * applied a second time.
 */
export function runNativeTextCommand(action: MenuAction): boolean {
  const native = NATIVE_TEXT_COMMANDS[action]
  if (!native) return false
  document.execCommand(native)
  noteKeyboardAction(action)
  return true
}

const NO_DOCUMENT_COMMANDS = new Set<MenuAction>(['new', 'open', 'about', 'toggle-sidebar'])

export function runCommand(action: MenuAction, source: CommandSource = 'ui'): void {
  // A focused text field gets undo/redo/select-all/delete natively. This is decided before the
  // keyboard/menu dedupe: on macOS a text field's Cmd+Z only works through the menu item.
  if (source !== 'ui' && isEditableFocused()) {
    const native = NATIVE_TEXT_COMMANDS[action]
    if (native) {
      // The keyboard handler already ran it (runNativeTextCommand) if this is the menu echo.
      if (source === 'menu' && !isDuplicate(action, source)) document.execCommand(native)
      last = { action, source, at: now() }
      return
    }
  }

  if (isDuplicate(action, source)) return
  last = { action, source, at: now() }
  // While a modal dialog is open only text editing commands (handled above) apply.
  if (isDialogOpen() && source !== 'ui') return
  if (!editor().doc && !NO_DOCUMENT_COMMANDS.has(action)) return

  void execute(action)
}

async function execute(action: MenuAction): Promise<void> {
  const s = editor()
  switch (action) {
    case 'new':
      return newBlankDocument()
    case 'open':
      return openWithDialog()
    case 'save':
      await save()
      return
    case 'save-as':
      await saveAs()
      return
    case 'close-document':
      await closeCurrentDocument()
      return
    case 'insert-pages':
      return insertPagesFromFile()
    case 'extract-pages':
      return openExtractDialog()
    case 'split':
      return openSplitDialog()
    case 'print':
      return printDocument()
    case 'undo':
      return s.undo()
    case 'redo':
      return s.redo()
    case 'delete-selection':
      return deleteSelection()
    case 'select-all-pages':
      return selectAllPages()
    case 'zoom-in':
      return zoomIn()
    case 'zoom-out':
      return zoomOut()
    case 'zoom-reset':
      return zoomReset()
    case 'fit-width':
      return fitWidth()
    case 'fit-page':
      return fitPage()
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'rotate-cw':
      return rotateTargetPages(90)
    case 'rotate-ccw':
      return rotateTargetPages(-90)
    case 'insert-blank-page':
      return insertBlankPageAt('after')
    case 'delete-pages':
      return deleteTargetPages()
    case 'document-properties':
      await openDialog({ kind: 'properties' })
      return
    case 'watermark':
      await openDialog({ kind: 'watermark' })
      return
    case 'page-numbers':
      await openDialog({ kind: 'page-numbers' })
      return
    case 'security':
      await openDialog({ kind: 'security' })
      return
    case 'recognize-text':
      return openOcrDialog()
    case 'sign':
      return startSigning()
    case 'find':
      return openFind()
    case 'about':
      await openDialog({ kind: 'about' })
      return
    default: {
      const unknown: never = action
      console.warn('Unhandled menu action', unknown)
    }
  }
}

/** Test helper: forget the last command (dedupe state). */
export function resetCommandState(): void {
  last = null
}
