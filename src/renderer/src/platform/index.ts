/**
 * Access to desktop features. In Electron this is the preload API (window.desktop);
 * in a plain browser (tests, `vite` dev without Electron) a fallback based on
 * <input type="file"> and downloads is used so the editor still works.
 */
import type { DesktopApi, MenuAction, NamedBytes, OpenedFile, SaveFileRequest } from '@shared/ipc'
import { formatWindowTitle } from '@renderer/state/selectors'

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    })
    input.addEventListener('cancel', () => {
      resolve([])
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}

async function toOpened(file: File): Promise<OpenedFile> {
  return { path: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

function download(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function createBrowserPlatform(): DesktopApi {
  const menuListeners = new Set<(a: MenuAction) => void>()
  return {
    platform: 'browser',
    async openPdfDialog(options) {
      const files = await pickFiles('application/pdf,.pdf', !!options?.multiple)
      return Promise.all(files.map(toOpened))
    },
    async openImageDialog() {
      const [file] = await pickFiles('image/png,image/jpeg', false)
      return file ? toOpened(file) : null
    },
    async readFile(path: string) {
      throw new Error(`Cannot read ${path} outside the desktop app`)
    },
    async writeFile(path: string, bytes: Uint8Array) {
      download(baseName(path), bytes)
    },
    async saveFileDialog(request: SaveFileRequest) {
      const name = baseName(request.defaultPath)
      download(name, request.bytes)
      return name
    },
    async saveFilesToFolder(files: NamedBytes[]) {
      for (const f of files) download(f.name, f.bytes)
      return ''
    },
    getPathForFile: () => null,
    setDocumentState(state) {
      // DocumentState.title is the raw document name; the browser formats its own tab title.
      document.title = formatWindowTitle(state.title, state.dirty, state.hasDocument)
    },
    async openInNewWindow() {
      /* not supported in the browser */
    },
    async getRecentFiles() {
      return []
    },
    confirmClose() {},
    cancelClose() {},
    showItemInFolder() {},
    onMenuAction(cb) {
      menuListeners.add(cb)
      return () => menuListeners.delete(cb)
    },
    onOpenFile: () => () => undefined,
    onSaveBeforeClose: () => () => undefined
  }
}

export const platform: DesktopApi =
  typeof window !== 'undefined' && window.desktop ? window.desktop : createBrowserPlatform()

export const isDesktop = typeof window !== 'undefined' && !!window.desktop
