/**
 * Wiring between the workspace and the desktop shell: menu commands, files opened from the OS,
 * save-before-close, and the window's document state (title / dirty flag).
 */
import { useEffect } from 'react'
import type { DocumentState } from '@shared/ipc'
import { runCommand } from '@renderer/actions/commands'
import { openFiles, saveBeforeClose } from '@renderer/actions/fileActions'
import { isDesktop, platform } from '@renderer/platform'
import { documentTitle } from '@renderer/state/selectors'
import { useEditor, type EditorState } from '@renderer/state/store'

/** The shell gets the raw document name and formats the window title / prompts itself. */
export function documentStateOf(s: EditorState): DocumentState {
  return {
    title: documentTitle(s),
    dirty: !!s.doc && s.dirty,
    hasDocument: !!s.doc,
    filePath: s.filePath
  }
}

function sameState(a: DocumentState | null, b: DocumentState): boolean {
  return !!a && a.title === b.title && a.dirty === b.dirty && a.hasDocument === b.hasDocument && a.filePath === b.filePath
}

export function useDesktopIntegration(): void {
  useEffect(() => {
    const offMenu = platform.onMenuAction((action) => runCommand(action, 'menu'))
    const offOpen = platform.onOpenFile((file) => void openFiles([file]))
    const offClose = platform.onSaveBeforeClose(() => void saveBeforeClose())

    let last: DocumentState | null = null
    const report = (s: EditorState) => {
      const next = documentStateOf(s)
      if (sameState(last, next)) return
      last = next
      try {
        platform.setDocumentState(next)
      } catch (err) {
        console.error('setDocumentState failed', err)
      }
    }
    report(useEditor.getState())
    const offStore = useEditor.subscribe(report)

    // The browser build has no close confirmation from the shell.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty && useEditor.getState().doc) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    if (!isDesktop) window.addEventListener('beforeunload', beforeUnload)

    return () => {
      offMenu()
      offOpen()
      offClose()
      offStore()
      if (!isDesktop) window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [])
}
