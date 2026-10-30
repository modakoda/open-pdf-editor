/**
 * Access to desktop features. In Electron this is the preload API (window.desktop);
 * in a plain browser (tests, `vite` dev without Electron) a fallback based on
 * <input type="file"> and downloads is used so the editor still works.
 */
import type { DesktopApi, MenuAction, NamedBytes, OpenedFile, SaveFileRequest, UnlockCertificateResult } from '@shared/ipc'
import { assertSignedAttributes } from '@core/signatures/cms'
import type { SigningIdentity } from '@core/signatures/pkcs12'
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
  // Signing certificates (in this page's memory; the desktop app keeps them in the main process).
  const certificates = new Map<string, { name: string; bytes: Uint8Array | null; identity: SigningIdentity | null }>()
  let certificateCounter = 0
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
    onSaveBeforeClose: () => () => undefined,
    async openCertificateDialog() {
      const [file] = await pickFiles('.p12,.pfx,application/x-pkcs12', false)
      if (!file) return null
      const id = `cert-${++certificateCounter}`
      certificates.set(id, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), identity: null })
      return { id, name: file.name }
    },
    async unlockCertificate(id, password): Promise<UnlockCertificateResult> {
      const entry = certificates.get(id)
      if (!entry) throw new Error('The certificate is no longer available. Choose it again.')
      if (!entry.identity) {
        const { loadPkcs12, CertificatePasswordError } = await import('@core/signatures/pkcs12')
        try {
          entry.identity = await loadPkcs12(entry.bytes!, password)
          entry.bytes = null
        } catch (e) {
          if (e instanceof CertificatePasswordError) return { ok: false, reason: 'password', message: e.message }
          return { ok: false, reason: 'unsupported', message: e instanceof Error ? e.message : String(e) }
        }
      }
      const { identity } = entry
      return {
        ok: true,
        certificate: { id, name: entry.name, certificate: identity.certificate, chain: identity.chain, summary: identity.summary, keyType: identity.keyType }
      }
    },
    async signWithCertificate(id, data) {
      const identity = certificates.get(id)?.identity
      if (!identity) throw new Error('The certificate is locked. Enter its password first.')
      assertSignedAttributes(data)
      return identity.sign(data)
    },
    releaseCertificate(id) {
      certificates.delete(id)
    }
  }
}

export const platform: DesktopApi =
  typeof window !== 'undefined' && window.desktop ? window.desktop : createBrowserPlatform()

export const isDesktop = typeof window !== 'undefined' && !!window.desktop
