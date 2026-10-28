/**
 * Contract between the Electron main process, the preload script and the renderer.
 * The preload exposes an object implementing `DesktopApi` as `window.desktop`.
 */

export interface OpenedFile {
  /** Absolute path on disk (null for files that did not come from disk). */
  path: string | null
  /** Base name, e.g. "report.pdf". */
  name: string
  bytes: Uint8Array
}

export interface SaveFileRequest {
  /** Suggested file name (Save As) or a full path. */
  defaultPath: string
  bytes: Uint8Array
}

export interface NamedBytes {
  name: string
  bytes: Uint8Array
}

/** What the renderer tells the main process about the window's document. */
export interface DocumentState {
  /**
   * The document's display name, unformatted (e.g. "report.pdf"; "" without a document).
   * The shell builds the window title from it (dirty marker, app name) and uses it in the
   * close confirmation, so it must not contain the app name or a dirty marker.
   */
  title: string
  /** Unsaved changes: drives the close confirmation and macOS "edited" dot. */
  dirty: boolean
  hasDocument: boolean
  filePath: string | null
}

/** Commands sent from the application menu (and OS events) to the renderer. */
export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'save-as'
  | 'close-document'
  | 'insert-pages'
  | 'extract-pages'
  | 'split'
  | 'print'
  | 'undo'
  | 'redo'
  | 'delete-selection'
  | 'select-all-pages'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'fit-width'
  | 'fit-page'
  | 'toggle-sidebar'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'insert-blank-page'
  | 'delete-pages'
  | 'document-properties'
  | 'watermark'
  | 'page-numbers'
  | 'security'
  | 'find'
  | 'about'

export interface DesktopApi {
  platform: 'darwin' | 'win32' | 'linux' | string
  /** Show an Open dialog for PDFs. Resolves to [] if cancelled. */
  openPdfDialog(options?: { multiple?: boolean; title?: string }): Promise<OpenedFile[]>
  /** Show an Open dialog for PNG/JPEG images. Resolves to null if cancelled. */
  openImageDialog(): Promise<OpenedFile | null>
  /** Read a file from disk (e.g. drag & drop with a path, recent files). */
  readFile(path: string): Promise<OpenedFile>
  /** Write bytes to an existing path (Save). */
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** Show a Save dialog and write the file. Resolves to the chosen path, or null if cancelled. */
  saveFileDialog(request: SaveFileRequest): Promise<string | null>
  /** Ask for a folder and write several files into it (Split). Resolves to the folder, or null. */
  saveFilesToFolder(files: NamedBytes[]): Promise<string | null>
  /** Absolute path for a dropped File object (Electron webUtils), or null. */
  getPathForFile(file: File): string | null
  /** Report the document state for window title / close confirmation. */
  setDocumentState(state: DocumentState): void
  /** Open a file in a new window (used when this window already has a document). */
  openInNewWindow(path: string | null): Promise<void>
  /** Recently opened files (most recent first). */
  getRecentFiles(): Promise<string[]>
  /** Called when the renderer finished the save the main process asked for before closing. */
  confirmClose(): void
  /**
   * Called when the save the main process asked for before closing failed or was cancelled:
   * the window stays open and a pending quit is aborted. (Optional: older shells lack it.)
   */
  cancelClose?(): void
  /**
   * Show a new blank document in a new window (this window already shows a document).
   * (Optional: older shells lack it; fall back to openInNewWindow(null).)
   */
  newDocumentWindow?(): Promise<void>
  /** Reveal a file in Finder / Explorer / file manager. */
  showItemInFolder(path: string): void
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onMenuAction(callback: (action: MenuAction) => void): () => void
  /** Files opened from the OS (argv, "Open With", dock drop, second instance, recent menu). */
  onOpenFile(callback: (file: OpenedFile) => void): () => void
  /**
   * The user chose "Save" in the close-confirmation dialog: save the document, then call
   * confirmClose() on success, or cancelClose() on failure/cancel to keep the window open.
   */
  onSaveBeforeClose(callback: () => void): () => void
}

/** IPC channel names (invoke = request/response, send = fire-and-forget, event = main → renderer). */
export const IPC = {
  openPdfDialog: 'dialog:open-pdf',
  openImageDialog: 'dialog:open-image',
  readFile: 'fs:read-file',
  writeFile: 'fs:write-file',
  saveFileDialog: 'dialog:save-file',
  saveFilesToFolder: 'dialog:save-files-to-folder',
  setDocumentState: 'window:set-document-state',
  openInNewWindow: 'window:open-in-new-window',
  getRecentFiles: 'app:get-recent-files',
  confirmClose: 'window:confirm-close',
  cancelClose: 'window:cancel-close',
  newDocumentWindow: 'window:new-document-window',
  showItemInFolder: 'shell:show-item-in-folder',
  menuAction: 'event:menu-action',
  openFile: 'event:open-file',
  saveBeforeClose: 'event:save-before-close'
} as const
