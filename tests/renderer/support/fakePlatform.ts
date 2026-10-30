/**
 * Fake DesktopApi for renderer tests. Use with:
 *   vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
 * and import { fake } from './support/fakePlatform' to configure / assert.
 */
import { vi } from 'vitest'
import type { DesktopApi, MenuAction, OpenedFile } from '@shared/ipc'

type Listener<T> = (value: T) => void

export const listeners = {
  menu: new Set<Listener<MenuAction>>(),
  openFile: new Set<Listener<OpenedFile>>(),
  saveBeforeClose: new Set<() => void>()
}

export const fakeState = { desktop: false }

export const fake = {
  platform: 'browser',
  openPdfDialog: vi.fn<DesktopApi['openPdfDialog']>(async () => []),
  openImageDialog: vi.fn<DesktopApi['openImageDialog']>(async () => null),
  readFile: vi.fn<DesktopApi['readFile']>(async (path: string) => ({ path, name: path.split('/').pop()!, bytes: new Uint8Array([1]) })),
  writeFile: vi.fn<DesktopApi['writeFile']>(async () => undefined),
  saveFileDialog: vi.fn<DesktopApi['saveFileDialog']>(async (req) => `/saved/${req.defaultPath.split('/').pop()}`),
  saveFilesToFolder: vi.fn<DesktopApi['saveFilesToFolder']>(async () => '/out'),
  getPathForFile: vi.fn<DesktopApi['getPathForFile']>(() => null),
  setDocumentState: vi.fn<DesktopApi['setDocumentState']>(),
  openInNewWindow: vi.fn<DesktopApi['openInNewWindow']>(async () => undefined),
  getRecentFiles: vi.fn<DesktopApi['getRecentFiles']>(async () => []),
  confirmClose: vi.fn<DesktopApi['confirmClose']>(),
  showItemInFolder: vi.fn<DesktopApi['showItemInFolder']>(),
  onMenuAction: vi.fn<DesktopApi['onMenuAction']>((cb) => {
    listeners.menu.add(cb)
    return () => listeners.menu.delete(cb)
  }),
  onOpenFile: vi.fn<DesktopApi['onOpenFile']>((cb) => {
    listeners.openFile.add(cb)
    return () => listeners.openFile.delete(cb)
  }),
  onSaveBeforeClose: vi.fn<DesktopApi['onSaveBeforeClose']>((cb) => {
    listeners.saveBeforeClose.add(cb)
    return () => listeners.saveBeforeClose.delete(cb)
  }),
  openCertificateDialog: vi.fn<NonNullable<DesktopApi['openCertificateDialog']>>(async () => null),
  unlockCertificate: vi.fn<NonNullable<DesktopApi['unlockCertificate']>>(async () => ({ ok: false, reason: 'password', message: 'Incorrect certificate password.' })),
  signWithCertificate: vi.fn<NonNullable<DesktopApi['signWithCertificate']>>(async () => new Uint8Array(256)),
  releaseCertificate: vi.fn<NonNullable<DesktopApi['releaseCertificate']>>()
} satisfies DesktopApi

export const platformModule = {
  platform: fake,
  get isDesktop() {
    return fakeState.desktop
  },
  createBrowserPlatform: () => fake
}

export function emitMenu(action: MenuAction): void {
  for (const l of listeners.menu) l(action)
}

export function resetFakePlatform(): void {
  fakeState.desktop = false
  for (const fn of Object.values(fake)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear()
  }
  fake.openPdfDialog.mockImplementation(async () => [])
  fake.saveFileDialog.mockImplementation(async (req) => `/saved/${req.defaultPath.split('/').pop()}`)
  fake.saveFilesToFolder.mockImplementation(async () => '/out')
  fake.getRecentFiles.mockImplementation(async () => [])
  fake.writeFile.mockImplementation(async () => undefined)
  fake.openCertificateDialog.mockImplementation(async () => null)
  fake.unlockCertificate.mockImplementation(async () => ({ ok: false, reason: 'password', message: 'Incorrect certificate password.' }))
  fake.signWithCertificate.mockImplementation(async () => new Uint8Array(256))
}
