/**
 * IPC handlers implementing DesktopApi (src/shared/ipc.ts). Every handler checks that the
 * message comes from the main frame of one of our windows showing the app, validates its
 * arguments, and only touches paths the user granted to that window (dialogs, OS open events,
 * command line, drag & drop) or files from the recent list.
 */
import { dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { IPC, type DocumentState, type NamedBytes, type OpenedFile } from '@shared/ipc'
import {
  assertBytesArg,
  assertPathArg,
  ensurePdfExtension,
  isFile,
  isPdfPath,
  readOpenedFile,
  sanitizeFileName,
  uniqueName,
  writeFileAtomic
} from './files'
import { INTERNAL_IPC } from './internal-ipc'
import { dispatchMenuAction } from './menu'
import { openPath } from './open'
import { isAppUrl, PRODUCT_NAME } from './paths'
import { recentFiles } from './recent'
import { windows, type WindowContext } from './windows'

const PDF_FILTERS: Electron.FileFilter[] = [
  { name: 'PDF Documents', extensions: ['pdf'] },
  { name: 'All Files', extensions: ['*'] }
]
const IMAGE_FILTERS: Electron.FileFilter[] = [{ name: 'Images (PNG, JPEG)', extensions: ['png', 'jpg', 'jpeg'] }]
const MAX_FILES_PER_FOLDER_SAVE = 2000

/** The window behind an IPC message, or an error for anything that is not our app's main frame. */
function senderContext(event: IpcMainEvent | IpcMainInvokeEvent): WindowContext {
  const ctx = windows.fromWebContents(event.sender)
  const frame = event.senderFrame
  if (!ctx || !frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
    throw new Error('IPC from an unknown sender was rejected')
  }
  return ctx
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function canAccess(ctx: WindowContext, path: string): boolean {
  if (windows.isGranted(ctx, path)) return true
  if (recentFiles.has(path)) {
    windows.grant(ctx, path)
    return true
  }
  return false
}

function accessDenied(path: string): Error {
  return new Error(`Access denied: “${basename(path)}” was not opened by the user`)
}

function parseDocumentState(value: unknown): DocumentState {
  if (!isObject(value)) throw new TypeError('Invalid document state')
  const { title, dirty, hasDocument, filePath } = value
  if (typeof title !== 'string' || typeof dirty !== 'boolean' || typeof hasDocument !== 'boolean') {
    throw new TypeError('Invalid document state')
  }
  if (filePath !== null && filePath !== undefined && typeof filePath !== 'string') {
    throw new TypeError('Invalid document state')
  }
  return {
    // eslint-disable-next-line no-control-regex
    title: title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300),
    dirty,
    hasDocument,
    filePath: typeof filePath === 'string' && filePath.length > 0 ? filePath : null
  }
}

function parseNamedBytes(value: unknown): NamedBytes[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES_PER_FOLDER_SAVE) {
    throw new TypeError('Invalid files')
  }
  return value.map((f) => {
    if (!isObject(f) || typeof f.name !== 'string') throw new TypeError('Invalid files')
    return { name: f.name, bytes: assertBytesArg(f.bytes) }
  })
}

async function readGranted(ctx: WindowContext, paths: string[]): Promise<OpenedFile[]> {
  const out: OpenedFile[] = []
  for (const p of paths) {
    windows.grant(ctx, p)
    out.push(await readOpenedFile(p))
  }
  return out
}

/** Asks before overwriting a file the save dialog did not confirm (".pdf" was appended). */
async function confirmOverwrite(ctx: WindowContext, path: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'warning',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: PRODUCT_NAME,
    message: `“${basename(path)}” already exists. Do you want to replace it?`,
    detail: `A file with the same name already exists in “${basename(dirname(path))}”.`
  })
  return response === 0
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.openPdfDialog, async (event, options: unknown) => {
    const ctx = senderContext(event)
    const opts = isObject(options) ? options : {}
    const multiple = opts.multiple === true
    const title = typeof opts.title === 'string' ? opts.title.slice(0, 200) : undefined
    const result = await dialog.showOpenDialog(ctx.win, {
      title: title ?? (multiple ? 'Choose PDF Files' : 'Open PDF'),
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: PDF_FILTERS
    })
    if (result.canceled || !result.filePaths?.length) return []
    const files = await readGranted(ctx, multiple ? result.filePaths : result.filePaths.slice(0, 1))
    // An empty window is about to load this file: OS opens meanwhile go to another window.
    if (!ctx.state.hasDocument) windows.markPendingOpen(ctx, files[0]?.path ?? null)
    return files
  })

  ipcMain.handle(IPC.openImageDialog, async (event) => {
    const ctx = senderContext(event)
    const result = await dialog.showOpenDialog(ctx.win, {
      title: 'Choose an Image',
      properties: ['openFile'],
      filters: IMAGE_FILTERS
    })
    if (result.canceled || !result.filePaths?.length) return null
    const [file] = await readGranted(ctx, result.filePaths.slice(0, 1))
    return file
  })

  ipcMain.handle(IPC.readFile, async (event, path: unknown) => {
    const ctx = senderContext(event)
    const abs = assertPathArg(path)
    if (!canAccess(ctx, abs)) throw accessDenied(abs)
    const file = await readOpenedFile(abs)
    if (!ctx.state.hasDocument && isPdfPath(abs)) windows.markPendingOpen(ctx, abs)
    return file
  })

  ipcMain.handle(IPC.writeFile, async (event, path: unknown, bytes: unknown) => {
    const ctx = senderContext(event)
    const abs = assertPathArg(path)
    const data = assertBytesArg(bytes)
    if (!canAccess(ctx, abs)) throw accessDenied(abs)
    await writeFileAtomic(abs, data)
  })

  ipcMain.handle(IPC.saveFileDialog, async (event, request: unknown) => {
    const ctx = senderContext(event)
    if (!isObject(request) || typeof request.defaultPath !== 'string') throw new TypeError('Invalid save request')
    const data = assertBytesArg(request.bytes)
    // eslint-disable-next-line no-control-regex
    const defaultPath = request.defaultPath.replace(/[\u0000-\u001f]/g, '').slice(0, 4096) || 'document.pdf'
    const result = await dialog.showSaveDialog(ctx.win, {
      title: 'Save PDF',
      defaultPath: ensurePdfExtension(defaultPath),
      filters: [PDF_FILTERS[0]],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (result.canceled || !result.filePath) return null
    const chosen = assertPathArg(result.filePath)
    const target = ensurePdfExtension(chosen)
    if (target !== chosen && existsSync(target) && !(await confirmOverwrite(ctx, target))) return null
    await writeFileAtomic(target, data)
    windows.grant(ctx, target)
    return target
  })

  ipcMain.handle(IPC.saveFilesToFolder, async (event, filesArg: unknown) => {
    const ctx = senderContext(event)
    const files = parseNamedBytes(filesArg)
    const result = await dialog.showOpenDialog(ctx.win, {
      title: 'Choose a Folder',
      buttonLabel: 'Save Here',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (result.canceled || !result.filePaths?.length) return null
    const folder = assertPathArg(result.filePaths[0])
    await mkdir(folder, { recursive: true })

    // Unique names within the batch first, then check what already exists on disk.
    const planned: string[] = []
    const lower = (s: string) => (process.platform === 'linux' ? s : s.toLowerCase())
    for (const f of files) {
      const name = uniqueName(sanitizeFileName(f.name), (n) => planned.some((p) => lower(p) === lower(n)))
      planned.push(name)
    }
    const conflicts = planned.filter((n) => existsSync(join(folder, n)))
    let names = planned
    if (conflicts.length > 0) {
      const { response } = await dialog.showMessageBox(ctx.win, {
        type: 'warning',
        buttons: ['Keep Both', 'Replace', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: PRODUCT_NAME,
        message:
          conflicts.length === 1
            ? `“${conflicts[0]}” already exists in “${basename(folder)}”.`
            : `${conflicts.length} files already exist in “${basename(folder)}”.`,
        detail: '“Keep Both” saves the new files with a number added to their names.'
      })
      if (response === 2) return null
      if (response === 0) {
        const used: string[] = []
        names = planned.map((n) => {
          const unique = uniqueName(n, (c) => existsSync(join(folder, c)) || used.some((u) => lower(u) === lower(c)))
          used.push(unique)
          return unique
        })
      }
    }
    for (let i = 0; i < files.length; i++) {
      const target = join(folder, names[i])
      await writeFileAtomic(target, files[i].bytes)
      windows.grant(ctx, target)
    }
    windows.grant(ctx, folder)
    return folder
  })

  ipcMain.on(IPC.setDocumentState, (event, state: unknown) => {
    try {
      const ctx = senderContext(event)
      const next = parseDocumentState(state)
      const previousPath = ctx.state.filePath
      windows.setDocumentState(ctx, next)
      if (next.hasDocument && next.filePath && next.filePath !== previousPath && windows.isGranted(ctx, next.filePath)) {
        recentFiles.add(next.filePath)
      }
    } catch (err) {
      console.error('setDocumentState:', err)
    }
  })

  ipcMain.handle(IPC.openInNewWindow, async (event, path: unknown) => {
    const ctx = senderContext(event)
    if (path === null || path === undefined) {
      windows.focus(windows.create())
      return
    }
    const abs = assertPathArg(path)
    if (!canAccess(ctx, abs)) throw accessDenied(abs)
    // Focuses the window that already shows the file instead of opening it twice.
    const target = await openPath(abs, { newWindow: true, reportErrors: false })
    if (!target) throw new Error(`Could not open “${basename(abs)}”`)
  })

  ipcMain.handle(IPC.newDocumentWindow, (event) => {
    const ctx = senderContext(event)
    // Same routing as File > New: a window that shows a document gets a sibling.
    dispatchMenuAction('new', ctx.win)
  })

  ipcMain.handle(IPC.getRecentFiles, (event) => {
    senderContext(event)
    return recentFiles.list()
  })

  ipcMain.on(IPC.confirmClose, (event) => {
    try {
      windows.confirmClose(senderContext(event))
    } catch (err) {
      console.error('confirmClose:', err)
    }
  })

  ipcMain.on(IPC.cancelClose, (event) => {
    try {
      windows.cancelClose(senderContext(event))
    } catch (err) {
      console.error('cancelClose:', err)
    }
  })

  ipcMain.on(IPC.showItemInFolder, (event, path: unknown) => {
    try {
      const ctx = senderContext(event)
      const abs = assertPathArg(path)
      if (!canAccess(ctx, abs)) throw accessDenied(abs)
      shell.showItemInFolder(abs)
    } catch (err) {
      console.error('showItemInFolder:', err)
    }
  })

  // Internal (preload only): a real file was dropped / picked in the page and its path was
  // resolved with webUtils.getPathForFile, so the user chose it.
  ipcMain.on(INTERNAL_IPC.grantDroppedPath, (event, path: unknown) => {
    try {
      const ctx = senderContext(event)
      const abs = assertPathArg(path)
      if (isFile(abs)) windows.grant(ctx, abs)
    } catch (err) {
      console.error('grantDroppedPath:', err)
    }
  })
}
