import { useEditor, DEFAULT_TOOL_OPTIONS } from '@renderer/state/store'
import { useDialogs } from '@renderer/state/dialogs'
import { useFind } from '@renderer/state/find'
import type { EditorDocument } from '@core'

/** Reset all renderer stores to their initial state. */
export function resetStores(): void {
  useDialogs.getState().current?.resolve(null)
  useDialogs.setState({ current: null })
  useFind.setState({ open: false, query: '', matches: [], active: -1, searching: false })
  useEditor.getState().closeDocument()
  useEditor.setState({
    sidebarOpen: true,
    tool: 'select',
    toolOptions: DEFAULT_TOOL_OPTIONS,
    notice: null,
    busy: null
  })
}

export function loadDoc(doc: EditorDocument, file: { filePath?: string | null; fileName?: string } = {}): void {
  useEditor.getState().setDocument(doc, { filePath: file.filePath ?? null, fileName: file.fileName ?? 'test.pdf' })
}

export const editor = () => useEditor.getState()
