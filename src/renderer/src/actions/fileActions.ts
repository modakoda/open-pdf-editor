/**
 * Opening, creating, saving, closing and printing documents.
 */
import { createBlankDocument, exportDocument, openDocument, type EditorDocument, type LoadOptions } from '@core'
import type { OpenedFile } from '@shared/ipc'
import { isDesktop, platform } from '@renderer/platform'
import { releasePdfResources } from '@renderer/pdf/resources'
import { openDialog, type ConfirmResult } from '@renderer/state/dialogs'
import { confirmRedactions, type RedactionChoice } from './redactActions'
import { baseName, editor, isPasswordError, notifyError, notifyInfo } from './util'

export const UNTITLED_NAME = 'Untitled.pdf'
const WRONG_PASSWORD = 'Incorrect password. Please try again.'

function passwordOptions(password: string | undefined): LoadOptions | undefined {
  return password === undefined ? undefined : { password }
}

/**
 * Run `load`, asking for a password while it fails with PasswordRequiredError /
 * InvalidPasswordError. Resolves to null if the user cancels the password dialog.
 */
export async function loadWithPassword<T>(
  fileName: string,
  load: (options?: LoadOptions) => Promise<T>
): Promise<T | null> {
  try {
    return await load(undefined)
  } catch (err) {
    if (!isPasswordError(err)) throw err
  }
  const outcome: { result?: { value: T }; failure?: { error: unknown } } = {}
  const ok = await openDialog<boolean>({
    kind: 'password',
    fileName,
    submit: async (password) => {
      try {
        outcome.result = { value: await load(passwordOptions(password)) }
        return null
      } catch (err) {
        if (isPasswordError(err)) return WRONG_PASSWORD
        outcome.failure = { error: err }
        return null
      }
    }
  })
  if (outcome.failure) throw outcome.failure.error
  if (!ok || !outcome.result) return null
  return outcome.result.value
}

/**
 * If the document has unsaved changes, ask whether to discard them (or save first).
 * Resolves true when it is OK to replace/close the document.
 */
export async function confirmDiscardChanges(action = 'continue'): Promise<boolean> {
  const { doc, dirty, fileName } = editor()
  if (!doc || !dirty) return true
  const choice = await openDialog<ConfirmResult>({
    kind: 'confirm',
    title: 'Unsaved changes',
    message: `“${fileName}” has unsaved changes. Do you want to discard them and ${action}?`,
    confirmLabel: 'Discard changes',
    altLabel: 'Save…',
    cancelLabel: 'Cancel',
    danger: true
  })
  if (choice === 'confirm') return true
  if (choice === 'alt') return save()
  return false
}

/** Run `fn` with a busy message in the status bar. */
export async function withBusy<T>(message: string, fn: () => Promise<T>): Promise<T> {
  editor().setBusy(message)
  try {
    return await fn()
  } finally {
    editor().setBusy(null)
  }
}

function installDocument(doc: EditorDocument, file: { filePath: string | null; fileName: string }): void {
  releasePdfResources(Object.keys(doc.sources))
  editor().setDocument(doc, file)
}

/** Open a file in this window, replacing the current document (after confirmation). */
export async function openFileHere(file: OpenedFile): Promise<boolean> {
  if (editor().doc && !(await confirmDiscardChanges(`open “${file.name}”`))) return false
  try {
    const doc = await loadWithPassword(file.name, (options) =>
      withBusy(`Opening ${file.name}…`, () => openDocument(file.bytes, file.name, options))
    )
    if (!doc) return false
    installDocument(doc, { filePath: file.path, fileName: file.name })
    return true
  } catch (err) {
    notifyError(`Could not open ${file.name}`, err)
    return false
  } finally {
    editor().setBusy(null)
  }
}

let openQueue: Promise<void> = Promise.resolve()

/**
 * Open files chosen by the user / dropped / sent by the OS. With a document already open,
 * files that have a path open in new windows (desktop); otherwise the first file replaces the
 * current document after confirming unsaved changes.
 *
 * Calls are serialised: a file that arrives while another one is still loading (e.g. from the
 * OS while the Open dialog's file loads) waits, then sees the loaded document and goes to a new
 * window instead of racing with — and silently replacing or being replaced by — the first.
 */
export function openFiles(files: OpenedFile[]): Promise<void> {
  const run = openQueue.then(() => openFilesNow(files))
  openQueue = run.catch(() => undefined)
  return run
}

async function openFilesNow(files: OpenedFile[]): Promise<void> {
  let openedHere = false
  for (const file of files) {
    if (editor().doc && file.path && isDesktop) {
      try {
        await platform.openInNewWindow(file.path)
      } catch (err) {
        notifyError(`Could not open ${file.name}`, err)
      }
      continue
    }
    if (openedHere) {
      notifyInfo(`Only one document can be open per window; “${file.name}” was not opened.`)
      continue
    }
    openedHere = true
    await openFileHere(file)
  }
}

export async function openWithDialog(): Promise<void> {
  try {
    const files = await platform.openPdfDialog({ multiple: isDesktop, title: 'Open PDF' })
    if (files.length) await openFiles(files)
  } catch (err) {
    notifyError('Could not open file', err)
  }
}

/** Open a file by path (recent files, desktop only). */
export async function openPath(path: string): Promise<void> {
  if (editor().doc && isDesktop) {
    await platform.openInNewWindow(path)
    return
  }
  try {
    const file = await platform.readFile(path)
    await openFiles([file])
  } catch (err) {
    notifyError(`Could not open ${baseName(path)}`, err)
  }
}

/** Files dropped on the window (DataTransfer files). Non-PDF files are ignored. */
export async function openDroppedFiles(list: FileList | File[]): Promise<void> {
  const files = Array.from(list).filter(isPdfFile)
  if (!files.length) {
    if (Array.from(list).length) notifyInfo('Only PDF files can be opened.')
    return
  }
  const opened: OpenedFile[] = []
  for (const file of files) {
    let path: string | null = null
    try {
      path = platform.getPathForFile(file)
    } catch {
      path = null
    }
    if (path && isDesktop && editor().doc) {
      opened.push({ path, name: file.name, bytes: new Uint8Array() })
      continue
    }
    if (path && isDesktop) {
      try {
        opened.push(await platform.readFile(path))
        continue
      } catch {
        /* fall back to reading the File */
      }
    }
    opened.push({ path, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  }
  await openFiles(opened)
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/**
 * New blank document. In the desktop app a window that already shows a document opens the new
 * one in another window (one document per window); in the browser it replaces the current one
 * after confirming unsaved changes.
 */
export async function newBlankDocument(): Promise<void> {
  if (editor().doc && isDesktop) {
    try {
      if (platform.newDocumentWindow) await platform.newDocumentWindow()
      else await platform.openInNewWindow(null)
    } catch (err) {
      notifyError('Could not open a new window', err)
    }
    return
  }
  if (editor().doc && !(await confirmDiscardChanges('create a new document'))) return
  try {
    installDocument(createBlankDocument(), { filePath: null, fileName: UNTITLED_NAME })
  } catch (err) {
    notifyError('Could not create a document', err)
  }
}

export async function closeCurrentDocument(): Promise<boolean> {
  if (!editor().doc) return true
  if (!(await confirmDiscardChanges('close the document'))) return false
  editor().closeDocument()
  releasePdfResources([])
  return true
}

/** The save / save-as currently running (at most one at a time). */
let inFlight: { kind: 'save' | 'save-as'; promise: Promise<boolean> } | null = null

function exclusive(kind: 'save' | 'save-as', task: () => Promise<boolean>): Promise<boolean> {
  const entry: { kind: 'save' | 'save-as'; promise: Promise<boolean> } = { kind, promise: Promise.resolve(false) }
  entry.promise = (async () => {
    try {
      return await task()
    } finally {
      if (inFlight === entry) inFlight = null
    }
  })()
  inFlight = entry
  return entry.promise
}

async function exportForSave(
  redaction?: RedactionChoice
): Promise<{ doc: EditorDocument; bytes: Uint8Array; warnings: string[] } | null> {
  const { doc } = editor()
  if (!doc) return null
  const warnings: string[] = []
  const bytes = await exportDocument(doc, { onWarning: (w) => warnings.push(w.message), sanitize: redaction?.sanitize })
  return { doc, bytes, warnings }
}

/**
 * After a save that applied redactions: open the saved file in place of the document, so what
 * is shown (and edited further) is what the file contains. Keeps the document if that fails.
 */
async function reopenRedacted(bytes: Uint8Array, file: { filePath: string | null; fileName: string }, doc: EditorDocument): Promise<void> {
  const enc = doc.settings.encryption
  const password = enc?.userPassword || undefined
  try {
    const reopened = await openDocument(bytes, file.fileName, password === undefined ? undefined : { password })
    if (editor().doc !== doc) return
    installDocument(reopened, file)
  } catch {
    notifyInfo(`The redactions were applied to ${file.fileName}. Open the file again to see the result.`)
  }
}

/** "Saved x.pdf", plus anything the engine had to change or skip while saving. */
function savedMessage(name: string, warnings: string[]): string {
  const unique = [...new Set(warnings)]
  return unique.length ? `Saved ${name}. ${unique.join(' ')}` : `Saved ${name}`
}

const NO_PAGES_MESSAGE = 'The document has no pages. Add a page before saving.'

/** A PDF needs at least one page (the engine refuses to export zero pages). */
function hasPagesOrNotify(doc: EditorDocument): boolean {
  if (doc.pages.length > 0) return true
  editor().showNotice('error', NO_PAGES_MESSAGE)
  return false
}

/**
 * Save to the current path; untitled documents (and the browser) go through Save As.
 * If a save is already running, waits for it: when that left the document saved, this one
 * succeeds without writing again; otherwise it saves the current state.
 */
export async function save(): Promise<boolean> {
  while (inFlight) {
    const ok = await inFlight.promise.catch(() => false)
    const s = editor()
    if (ok && s.doc && !s.dirty && s.filePath) return true
  }
  const { doc, filePath } = editor()
  if (!doc) return false
  if (!hasPagesOrNotify(doc)) return false
  if (!filePath) return saveAs()
  return exclusive('save', async () => {
    const redaction = await confirmRedactions(doc)
    if (redaction === null) return false
    editor().setBusy('Saving…')
    try {
      const exported = await exportForSave(redaction)
      if (!exported) return false
      await platform.writeFile(filePath, exported.bytes)
      editor().markSaved({ filePath, fileName: baseName(filePath) }, exported.doc)
      if (redaction) await reopenRedacted(exported.bytes, { filePath, fileName: baseName(filePath) }, exported.doc)
      notifyInfo(savedMessage(baseName(filePath), exported.warnings))
      return true
    } catch (err) {
      notifyError('Could not save', err)
      return false
    } finally {
      editor().setBusy(null)
    }
  })
}

/** Save As. A second Save As while the first one's dialog is open resolves with the first's result. */
export async function saveAs(): Promise<boolean> {
  if (inFlight?.kind === 'save-as') return inFlight.promise
  while (inFlight) await inFlight.promise.catch(() => false)
  const { doc } = editor()
  if (!doc) return false
  if (!hasPagesOrNotify(doc)) return false
  return exclusive('save-as', saveAsNow)
}

async function saveAsNow(): Promise<boolean> {
  const { filePath, fileName, doc } = editor()
  const redaction = await confirmRedactions(doc)
  if (redaction === null) return false
  editor().setBusy('Saving…')
  try {
    const exported = await exportForSave(redaction)
    if (!exported) return false
    const defaultPath = filePath && isDesktop ? filePath : ensurePdfName(fileName || UNTITLED_NAME)
    const path = await platform.saveFileDialog({ defaultPath, bytes: exported.bytes })
    if (!path) return false
    editor().markSaved({ filePath: path, fileName: baseName(path) }, exported.doc)
    if (redaction) await reopenRedacted(exported.bytes, { filePath: path, fileName: baseName(path) }, exported.doc)
    notifyInfo(savedMessage(baseName(path), exported.warnings))
    return true
  } catch (err) {
    notifyError('Could not save', err)
    return false
  } finally {
    editor().setBusy(null)
  }
}

export function ensurePdfName(name: string): string {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}

/**
 * Main process asked to save before closing the window: confirm the close after a successful
 * save, otherwise tell the shell to keep the window open (and stop quitting).
 */
export async function saveBeforeClose(): Promise<void> {
  let ok = false
  try {
    ok = await save()
  } finally {
    if (ok) platform.confirmClose()
    else platform.cancelClose?.()
  }
}

