/** Update preferences, persisted as JSON in the userData folder (update-settings.json). */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface UpdateSettingsData {
  /** Check on startup and every few hours (Help > Check for Updates Automatically). */
  autoCheck: boolean
}

const DEFAULTS: UpdateSettingsData = { autoCheck: true }

export class UpdateSettings {
  private data: UpdateSettingsData | null = null

  /** `file` is resolved lazily (userData can change until the app is ready). */
  constructor(private readonly file: () => string) {}

  private load(): UpdateSettingsData {
    if (this.data) return this.data
    let data = { ...DEFAULTS }
    try {
      const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, unknown>
      if (typeof raw.autoCheck === 'boolean') data = { ...data, autoCheck: raw.autoCheck }
    } catch {
      /* missing or unreadable: defaults */
    }
    this.data = data
    return data
  }

  get autoCheck(): boolean {
    return this.load().autoCheck
  }

  set autoCheck(value: boolean) {
    this.data = { ...this.load(), autoCheck: value }
    try {
      mkdirSync(dirname(this.file()), { recursive: true })
      writeFileSync(this.file(), JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.error('Could not save update settings', err)
    }
  }
}
