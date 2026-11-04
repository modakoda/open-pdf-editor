/**
 * Preload script (sandboxed, context-isolated): exposes DesktopApi as `window.desktop`.
 * See src/shared/ipc.ts for the contract.
 *
 * Events from the main process are buffered here until the renderer subscribes, so a file
 * opened from the command line or the OS is never lost if the UI subscribes late:
 * - open-file events are queued whenever nobody is listening and delivered to the next subscriber;
 * - menu actions are queued only until the first subscriber appears.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type DesktopApi, type DocumentState, type MenuAction, type OpenedFile, type UpdateState } from '../shared/ipc'
import { INTERNAL_IPC } from '../main/internal-ipc'

type Listener<T> = (value: T) => void

/** Fan-out of one main → renderer channel with buffering until someone listens. */
function bufferedChannel<T>(channel: string, bufferAfterFirstSubscriber: boolean) {
  const listeners = new Set<Listener<T>>()
  const pending: T[] = []
  let everSubscribed = false
  let flushScheduled = false

  const deliver = (value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (err) {
        console.error(`Error in ${channel} listener`, err)
      }
    }
  }

  const flush = () => {
    flushScheduled = false
    // Deliver to whoever is subscribed once the current task settles (React StrictMode
    // subscribes, unsubscribes and re-subscribes synchronously).
    if (listeners.size === 0) return
    for (const value of pending.splice(0)) deliver(value)
  }

  ipcRenderer.on(channel, (_event: IpcRendererEvent, value: T) => {
    if (listeners.size > 0) {
      // Keep order behind values still waiting for the scheduled flush.
      if (pending.length === 0) deliver(value)
      else pending.push(value)
    } else if (!everSubscribed || bufferAfterFirstSubscriber) {
      pending.push(value)
    }
  })

  return (callback: Listener<T>): (() => void) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function')
    listeners.add(callback)
    everSubscribed = true
    if (pending.length > 0 && !flushScheduled) {
      flushScheduled = true
      setTimeout(flush, 0)
    }
    return () => {
      listeners.delete(callback)
    }
  }
}

const subscribeOpenFile = bufferedChannel<OpenedFile>(IPC.openFile, true)
const subscribeMenuAction = bufferedChannel<MenuAction>(IPC.menuAction, false)
const subscribeSaveBeforeClose = bufferedChannel<void>(IPC.saveBeforeClose, false)
const subscribeUpdateState = bufferedChannel<UpdateState>(IPC.updateState, false)

const api: DesktopApi = {
  platform: process.platform,
  openPdfDialog: (options) => ipcRenderer.invoke(IPC.openPdfDialog, options ?? {}),
  openImageDialog: () => ipcRenderer.invoke(IPC.openImageDialog),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  writeFile: (path, bytes) => ipcRenderer.invoke(IPC.writeFile, path, bytes),
  saveFileDialog: (request) => ipcRenderer.invoke(IPC.saveFileDialog, request),
  saveFilesToFolder: (files) => ipcRenderer.invoke(IPC.saveFilesToFolder, files),
  getPathForFile(file: File): string | null {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return null
    }
    if (!path) return null
    // The user dropped or picked this file: allow the renderer to read it.
    ipcRenderer.send(INTERNAL_IPC.grantDroppedPath, path)
    return path
  },
  setDocumentState(state: DocumentState): void {
    ipcRenderer.send(IPC.setDocumentState, {
      title: state.title,
      dirty: state.dirty,
      hasDocument: state.hasDocument,
      filePath: state.filePath
    })
  },
  openInNewWindow: (path) => ipcRenderer.invoke(IPC.openInNewWindow, path),
  getRecentFiles: () => ipcRenderer.invoke(IPC.getRecentFiles),
  confirmClose: () => ipcRenderer.send(IPC.confirmClose),
  cancelClose: () => ipcRenderer.send(IPC.cancelClose),
  newDocumentWindow: () => ipcRenderer.invoke(IPC.newDocumentWindow),
  showItemInFolder: (path) => ipcRenderer.send(IPC.showItemInFolder, path),
  listSystemFonts: () => ipcRenderer.invoke(IPC.listSystemFonts),
  readSystemFont: (id) => ipcRenderer.invoke(IPC.readSystemFont, id),
  onMenuAction: (callback) => subscribeMenuAction(callback),
  onOpenFile: (callback) => subscribeOpenFile(callback),
  onSaveBeforeClose: (callback) => subscribeSaveBeforeClose(() => callback()),
  getUpdateState: () => ipcRenderer.invoke(IPC.getUpdateState),
  checkForUpdates: () => ipcRenderer.send(IPC.checkForUpdates),
  installUpdate: () => ipcRenderer.send(IPC.installUpdate),
  openUpdateDownload: () => ipcRenderer.send(IPC.openUpdateDownload),
  onUpdateState: (callback) => subscribeUpdateState(callback),
  openCertificateDialog: () => ipcRenderer.invoke(IPC.openCertificateDialog),
  unlockCertificate: (id, password) => ipcRenderer.invoke(IPC.unlockCertificate, id, password),
  signWithCertificate: (id, data) => ipcRenderer.invoke(IPC.signWithCertificate, id, data),
  releaseCertificate: (id) => ipcRenderer.send(IPC.releaseCertificate, id)
}

contextBridge.exposeInMainWorld('desktop', api)
