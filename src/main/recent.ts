/**
 * Recently opened files, persisted as JSON in the userData folder (most recent first, max 10).
 * Also mirrored to the OS recent-documents list (macOS Dock menu, Windows Jump List).
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isFile, pathKey } from './files'

export const MAX_RECENT = 10

type Listener = () => void

class RecentFiles {
  private items: string[] | null = null
  private listeners = new Set<Listener>()

  private get file(): string {
    return join(app.getPath('userData'), 'recent-files.json')
  }

  private load(): string[] {
    if (this.items) return this.items
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      const list = Array.isArray(data) ? data : (data as { files?: unknown })?.files
      this.items = Array.isArray(list)
        ? list.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_RECENT)
        : []
    } catch {
      this.items = []
    }
    return this.items
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ files: this.items ?? [] }, null, 2))
    } catch (err) {
      console.error('Could not save recent files', err)
    }
    for (const l of this.listeners) l()
  }

  /** Existing files only; missing files are dropped from the persisted list. */
  list(): string[] {
    const items = this.load()
    const existing = items.filter(isFile)
    if (existing.length !== items.length) {
      this.items = existing
      this.save()
    }
    return [...existing]
  }

  has(path: string): boolean {
    const key = pathKey(path)
    return this.load().some((p) => pathKey(p) === key)
  }

  add(path: string): void {
    const abs = resolve(path)
    const key = pathKey(abs)
    const current = this.load()
    if (current.length > 0 && pathKey(current[0]) === key) return
    this.items = [abs, ...current.filter((p) => pathKey(p) !== key)].slice(0, MAX_RECENT)
    try {
      app.addRecentDocument(abs)
    } catch {
      /* not supported on this platform */
    }
    this.save()
  }

  remove(path: string): void {
    const key = pathKey(path)
    const current = this.load()
    const next = current.filter((p) => pathKey(p) !== key)
    if (next.length === current.length) return
    this.items = next
    this.save()
  }

  clear(): void {
    this.items = []
    try {
      app.clearRecentDocuments()
    } catch {
      /* not supported on this platform */
    }
    this.save()
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const recentFiles = new RecentFiles()
