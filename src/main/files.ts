/**
 * File-system helpers for the main process: reading files for the renderer, atomic writes,
 * file-name sanitising and command-line (argv) parsing.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { chmod, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { OpenedFile } from '@shared/ipc'

/** Largest file the app will read into memory (and send over IPC). */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024

/** Normalised key used to compare paths (case-insensitive on Windows and macOS). */
export function pathKey(path: string): string {
  const abs = resolve(path)
  return process.platform === 'linux' ? abs : abs.toLowerCase()
}

/** Canonical path (symlinks resolved) when the file exists, otherwise the absolute path. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** Both paths name the same file (symlinks resolved; case-insensitive on Windows/macOS). */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b) || pathKey(canonicalPath(a)) === pathKey(canonicalPath(b))
}

export function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === '.pdf'
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Validates an untrusted path argument coming from the renderer. */
export function assertPathArg(value: unknown, what = 'path'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_767 || value.includes('\0')) {
    throw new TypeError(`Invalid ${what}`)
  }
  if (!isAbsolute(value)) throw new TypeError(`Invalid ${what}: must be absolute`)
  return resolve(value)
}

/** Validates untrusted bytes coming from the renderer and returns a Buffer view (no copy). */
export function assertBytesArg(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  throw new TypeError('Invalid bytes: expected a Uint8Array')
}

/** A Uint8Array that owns exactly its bytes (so IPC never serialises a larger pooled buffer). */
function exactBytes(buf: Buffer): Uint8Array {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return new Uint8Array(buf.buffer, 0, buf.byteLength)
  }
  return new Uint8Array(buf)
}

/** Reads a regular file into an OpenedFile (path, base name and bytes). */
export async function readOpenedFile(path: string): Promise<OpenedFile> {
  const abs = resolve(path)
  const handle = await open(abs, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`Not a file: ${basename(abs)}`)
    if (info.size > MAX_FILE_BYTES) throw new Error(`File is too large: ${basename(abs)}`)
    const buf = await handle.readFile()
    return { path: abs, name: basename(abs), bytes: exactBytes(buf) }
  } finally {
    await handle.close()
  }
}

/**
 * Saves a file without leaving a truncated file behind if the app crashes or the disk fills up:
 * writes a temporary file next to the real target and renames it over the target.
 * - Symlinks are followed: the file they point to is updated and the link stays a link.
 * - Files with several hard links are written in place (a rename would split the links).
 * - The existing file's permissions are kept.
 * Falls back to a direct write when the rename is not possible (e.g. the target is locked on
 * Windows or the folder does not allow creating files).
 */
export async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  let target = resolve(path)
  let mode: number | undefined
  try {
    target = await realpath(target)
    const info = await stat(target)
    if (info.isDirectory()) throw new Error(`Cannot overwrite a folder: ${basename(target)}`)
    mode = info.mode & 0o777
    if (info.nlink > 1) {
      await writeFile(target, data)
      return
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, data, { mode: mode ?? 0o666, flag: 'wx' })
    // The umask applies on creation; restore the original permissions exactly.
    if (mode !== undefined) await chmod(tmp, mode).catch(() => undefined)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EXDEV') {
      await writeFile(target, data)
      return
    }
    throw err
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Turns an untrusted file name into a safe base name for the current OS. */
export function sanitizeFileName(name: string, fallback = 'document.pdf'): string {
  let clean = basename(String(name).replace(/[\\/]/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (clean === '' || clean === '.' || clean === '..') clean = fallback
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`
  if (clean.length > 200) {
    const ext = extname(clean).slice(0, 16)
    clean = clean.slice(0, 200 - ext.length) + ext
  }
  return clean
}

/** "name.pdf" → "name (2).pdf", "name (3).pdf", … until `taken` returns false. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/** Adds ".pdf" unless the path already ends with it (case-insensitive). */
export function ensurePdfExtension(path: string): string {
  return isPdfPath(path) ? path : `${path}.pdf`
}

/** A command-line argument as an absolute path: plain paths and file:// URLs (null otherwise). */
function argToPath(arg: string, cwd: string): string | null {
  if (/^file:/i.test(arg)) {
    try {
      return fileURLToPath(arg)
    } catch {
      return null
    }
  }
  // Other URL schemes (http:, smb:, …) are not local files. Windows drive letters ("C:\…")
  // look like a scheme but are single letters.
  if (/^[a-z][a-z0-9+.-]+:/i.test(arg)) return null
  return resolve(cwd, arg)
}

/**
 * PDF files named on a command line (first launch or second instance). Skips the executable,
 * switches and the app path in development; relative paths resolve against `cwd`, and
 * file:// URLs (passed by Linux file managers) are converted to paths.
 */
export function pdfPathsFromArgv(argv: readonly string[], cwd: string): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    const abs = argToPath(arg, cwd)
    if (abs && isPdfPath(abs) && existsSync(abs) && isFile(abs) && !out.includes(abs)) out.push(abs)
  }
  return out
}
