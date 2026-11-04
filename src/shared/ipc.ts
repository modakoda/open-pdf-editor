/**
 * Contract between the Electron main process, the preload script and the renderer.
 * The preload exposes an object implementing `DesktopApi` as `window.desktop`.
 */
import type { FontScript, HanLanguage } from '../core/scripts'

/** A font face of the OS for scripts the bundled fonts lack (CJK, Thai, Devanagari). */
export interface SystemFontInfo {
  /** Catalog id for readSystemFont (the renderer never sees or sends paths). */
  id: string
  /** Display name, e.g. "Hiragino Sans GB W3". */
  name: string
  /** Face within a font collection (.ttc/.otc). */
  postscriptName?: string
  /** Scripts the font is meant for (the engine checks actual glyph coverage). */
  scripts: FontScript[]
  /** CJK fonts: the language its Han glyphs are designed for. */
  language?: HanLanguage
  family: 'sans' | 'serif' | 'mono'
  bold: boolean
}
import type { CertificateSummary } from '../core/signatures/x509'

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

/** A PKCS#12 certificate file the user picked; the main process holds its bytes. */
export interface CertificateFile {
  id: string
  /** Base name, e.g. "jane.p12". */
  name: string
}

/** An unlocked certificate: public parts only (the private key stays in the main process). */
export interface UnlockedCertificate extends CertificateFile {
  /** Signer certificate, DER. */
  certificate: Uint8Array
  /** Issuer certificates from the file, DER, nearest first. */
  chain: Uint8Array[]
  summary: CertificateSummary
  keyType: 'RSA' | 'EC'
}

export type UnlockCertificateResult =
  | { ok: true; certificate: UnlockedCertificate }
  /** 'password': wrong password; 'unsupported': not a usable PKCS#12 file (see message). */
  | { ok: false; reason: 'password' | 'unsupported'; message: string }

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
  | 'recognize-text'
  | 'sign'
  | 'find'
  | 'about'

/** What the in-app updater is doing (src/main/updates). */
export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; currentVersion: string }
  /** This build cannot update itself (unsigned macOS app, portable, deb, tar.gz): link to the download. */
  | { status: 'available'; version: string; downloadUrl: string }
  | { status: 'downloading'; version: string; percent: number }
  /** Installs when the app quits, or now with installUpdate() ("Restart to Update"). */
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

/** Update state as shown by the update banner. */
export type UpdateState = UpdateStatus & {
  /**
   * Changes whenever the banner should show again (a new status, or a check the user asked
   * for); progress updates keep it, so a dismissed download banner stays dismissed.
   */
  id: number
  /** The user asked for this check (Help > Check for Updates…), or should see its outcome. */
  manual: boolean
}

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
  /**
   * Fallback fonts installed on the system, in order of preference. (Optional: older shells
   * and the browser lack it.)
   */
  listSystemFonts?(): Promise<SystemFontInfo[]>
  /** Bytes of a font from listSystemFonts(). */
  readSystemFont?(id: string): Promise<Uint8Array>
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onMenuAction(callback: (action: MenuAction) => void): () => void
  /** Files opened from the OS (argv, "Open With", dock drop, second instance, recent menu). */
  onOpenFile(callback: (file: OpenedFile) => void): () => void
  /**
   * The user chose "Save" in the close-confirmation dialog: save the document, then call
   * confirmClose() on success, or cancelClose() on failure/cancel to keep the window open.
   */
  onSaveBeforeClose(callback: () => void): () => void
  // In-app updates (optional: the browser build and older shells lack them).
  /** Current update state. */
  getUpdateState?(): Promise<UpdateState>
  /** Check for updates now (like Help > Check for Updates…). */
  checkForUpdates?(): void
  /** "Restart to Update": quit (asking to save unsaved changes), install and relaunch. */
  installUpdate?(): void
  /** Open the download page of the available version (builds that cannot update themselves). */
  openUpdateDownload?(): void
  /** Subscribe to update state changes. Returns an unsubscribe function. */
  onUpdateState?(callback: (state: UpdateState) => void): () => void
  /**
   * Digital signing (optional: older shells and the browser build may lack it). The user picks a
   * PKCS#12 file; the main process keeps it and, once unlocked with the password, its private
   * key, only in memory. Passwords are never stored.
   */
  openCertificateDialog?(): Promise<CertificateFile | null>
  unlockCertificate?(id: string, password: string): Promise<UnlockCertificateResult>
  /** Signs CMS signed attributes (DER) with the unlocked certificate's key (SHA-256). */
  signWithCertificate?(id: string, data: Uint8Array): Promise<Uint8Array>
  /** Forgets the certificate and its key. */
  releaseCertificate?(id: string): void
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
  listSystemFonts: 'fonts:list-system',
  readSystemFont: 'fonts:read-system',
  menuAction: 'event:menu-action',
  openFile: 'event:open-file',
  saveBeforeClose: 'event:save-before-close',
  getUpdateState: 'update:get-state',
  checkForUpdates: 'update:check',
  installUpdate: 'update:install',
  openUpdateDownload: 'update:open-download',
  updateState: 'event:update-state',
  openCertificateDialog: 'cert:open-dialog',
  unlockCertificate: 'cert:unlock',
  signWithCertificate: 'cert:sign',
  releaseCertificate: 'cert:release'
} as const
