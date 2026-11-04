/**
 * Files opened from outside the renderer: command line (first launch and second instance),
 * macOS "open-file" (Finder, Dock, Open With), the Open Recent menu and openInNewWindow().
 * A file that is already open in a window just focuses that window; otherwise it goes to the
 * active window if that has no document (and is not loading one), else to a new window.
 */
import { dialog } from 'electron'
import { basename, resolve } from 'node:path'
import { IPC, type OpenedFile } from '@shared/ipc'
import { readOpenedFile } from './files'
import { PRODUCT_NAME } from './paths'
import { recentFiles } from './recent'
import { windows, type WindowContext } from './windows'

async function showOpenError(path: string, err: unknown, parent?: WindowContext): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    buttons: ['OK'],
    title: PRODUCT_NAME,
    message: `“${basename(path)}” could not be opened.`,
    detail: err instanceof Error ? err.message : String(err)
  }
  if (parent && !parent.win.isDestroyed()) await dialog.showMessageBox(parent.win, options)
  else await dialog.showMessageBox(options)
}

/** Grants the path to the window, sends the file and brings the window to the front. */
export function deliverFile(ctx: WindowContext, file: OpenedFile): void {
  if (file.path) windows.grant(ctx, file.path)
  windows.markPendingOpen(ctx, file.path)
  windows.send(ctx, IPC.openFile, file)
  windows.focus(ctx)
}

/**
 * Opens a file from disk: focuses the window already showing it, else uses the active empty
 * window (unless `newWindow`), else a new window. Resolves to the window, or null on error.
 */
export async function openPath(
  path: string,
  options: { newWindow?: boolean; reportErrors?: boolean } = {}
): Promise<WindowContext | null> {
  const abs = resolve(path)
  const existing = windows.findByPath(abs)
  if (existing) {
    windows.focus(existing)
    // Keep the spelling the window uses (not a symlink / other-case alias) in Open Recent.
    recentFiles.add(existing.state.filePath ?? existing.pendingOpenPath ?? abs)
    return existing
  }
  let file: OpenedFile
  try {
    file = await readOpenedFile(abs)
  } catch (err) {
    recentFiles.remove(abs)
    if (options.reportErrors === false) throw err
    await showOpenError(abs, err, windows.active())
    return null
  }
  const active = windows.active()
  const ctx = !options.newWindow && active && !windows.isOccupied(active) ? active : windows.create()
  deliverFile(ctx, file)
  recentFiles.add(abs)
  return ctx
}

/** Opens several files in order (first one may reuse the active empty window). */
export async function openPaths(paths: readonly string[]): Promise<void> {
  for (const p of paths) await openPath(p)
}
