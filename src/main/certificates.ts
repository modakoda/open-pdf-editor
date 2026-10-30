/**
 * Signing certificates (PKCS#12) for the renderer's "Sign Digitally" flow.
 *
 * The user picks the file in a native dialog; its bytes, and after unlocking the private key (a
 * non-extractable WebCrypto key), stay in this process's memory, owned by the window that asked.
 * The renderer only gets the public certificates and can ask for CMS signed attributes to be
 * signed. Passwords are used once and never stored. Entries are dropped when released, when the
 * window closes, or after a period without use.
 */
import { dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { IPC, type CertificateFile, type UnlockCertificateResult } from '@shared/ipc'
import { assertSignedAttributes } from '@core/signatures/cms'
import { CertificateFileError, CertificatePasswordError, loadPkcs12, type SigningIdentity } from '@core/signatures/pkcs12'
import { assertBytesArg } from './files'
import type { WindowContext } from './windows'

const MAX_CERTIFICATE_BYTES = 1024 * 1024
const MAX_PASSWORD_LENGTH = 4096
/** Forget a certificate that was not used for this long. */
const IDLE_MS = 15 * 60_000

interface Entry {
  ctx: WindowContext
  name: string
  /** File contents until unlocked. */
  bytes: Uint8Array | null
  identity: SigningIdentity | null
  timer: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()
const watchedWindows = new WeakSet<WindowContext>()

function release(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entries.delete(id)
}

function touch(id: string, entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => release(id), IDLE_MS)
  entry.timer.unref?.()
}

function entryFor(ctx: WindowContext, id: unknown): [string, Entry] {
  if (typeof id !== 'string') throw new TypeError('Invalid certificate id')
  const entry = entries.get(id)
  if (!entry || entry.ctx !== ctx) throw new Error('The certificate is no longer available. Choose it again.')
  return [id, entry]
}

export function registerCertificateHandlers(senderContext: (event: IpcMainEvent | IpcMainInvokeEvent) => WindowContext): void {
  ipcMain.handle(IPC.openCertificateDialog, async (event): Promise<CertificateFile | null> => {
    const ctx = senderContext(event)
    const result = await dialog.showOpenDialog(ctx.win, {
      title: 'Choose a Signing Certificate',
      properties: ['openFile'],
      filters: [
        { name: 'Certificates (PKCS#12)', extensions: ['p12', 'pfx'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    const path = result.filePaths?.[0]
    if (result.canceled || !path) return null
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Not a file: ${basename(path)}`)
    if (info.size > MAX_CERTIFICATE_BYTES) throw new Error(`“${basename(path)}” is too large to be a certificate file.`)
    const bytes = new Uint8Array(await readFile(path))
    const id = randomUUID()
    const entry: Entry = { ctx, name: basename(path), bytes, identity: null, timer: null }
    entries.set(id, entry)
    touch(id, entry)
    if (!watchedWindows.has(ctx)) {
      watchedWindows.add(ctx)
      ctx.win.once('closed', () => {
        for (const [key, e] of entries) if (e.ctx === ctx) release(key)
      })
    }
    return { id, name: entry.name }
  })

  ipcMain.handle(IPC.unlockCertificate, async (event, id: unknown, password: unknown): Promise<UnlockCertificateResult> => {
    const ctx = senderContext(event)
    const [key, entry] = entryFor(ctx, id)
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) throw new TypeError('Invalid password')
    touch(key, entry)
    if (!entry.identity) {
      if (!entry.bytes) throw new Error('The certificate is no longer available. Choose it again.')
      try {
        entry.identity = await loadPkcs12(entry.bytes, password)
      } catch (e) {
        if (e instanceof CertificatePasswordError) return { ok: false, reason: 'password', message: e.message }
        if (e instanceof CertificateFileError) return { ok: false, reason: 'unsupported', message: e.message }
        throw e
      }
      entry.bytes = null
    }
    const { identity } = entry
    return {
      ok: true,
      certificate: {
        id: key,
        name: entry.name,
        certificate: identity.certificate,
        chain: identity.chain,
        summary: identity.summary,
        keyType: identity.keyType
      }
    }
  })

  ipcMain.handle(IPC.signWithCertificate, async (event, id: unknown, data: unknown): Promise<Uint8Array> => {
    const ctx = senderContext(event)
    const [key, entry] = entryFor(ctx, id)
    if (!entry.identity) throw new Error('The certificate is locked. Enter its password first.')
    const bytes = new Uint8Array(assertBytesArg(data))
    // Only CMS signed attributes (content type + message digest) are ever signed.
    assertSignedAttributes(bytes)
    touch(key, entry)
    return entry.identity.sign(bytes)
  })

  ipcMain.on(IPC.releaseCertificate, (event, id: unknown) => {
    try {
      const ctx = senderContext(event)
      const [key] = entryFor(ctx, id)
      release(key)
    } catch {
      /* already gone */
    }
  })
}
