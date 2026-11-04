/**
 * Remembers the size/position of the last used window (userData/window-state.json) so new
 * windows open where the user left them. Additional windows cascade from the active one.
 */
import { app, screen, type Rectangle } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SavedWindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const DEFAULT_SIZE = { width: 1280, height: 860 }
const MIN_SIZE = { width: 640, height: 480 }
const CASCADE = 26

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
}

export function loadWindowState(): SavedWindowState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<string, unknown>
    const width = num(raw.width)
    const height = num(raw.height)
    if (!width || !height) return { ...DEFAULT_SIZE }
    return {
      x: num(raw.x),
      y: num(raw.y),
      width: Math.max(MIN_SIZE.width, width),
      height: Math.max(MIN_SIZE.height, height),
      maximized: raw.maximized === true
    }
  } catch {
    return { ...DEFAULT_SIZE }
  }
}

export function saveWindowState(state: SavedWindowState): void {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('Could not save window state', err)
  }
}

/** True if a reasonable part of the rectangle is on some display. */
function isVisible(rect: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x)
    const h = Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y)
    return w >= 120 && h >= 80
  })
}

function fitToWorkArea(width: number, height: number, near?: Rectangle): { width: number; height: number } {
  const display = near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()
  const { workArea } = display
  return { width: Math.min(width, workArea.width), height: Math.min(height, workArea.height) }
}

/**
 * Bounds for a new window: cascaded from `activeBounds` if another window is open,
 * otherwise the saved bounds (if still on a display), otherwise centred default size.
 */
export function nextWindowBounds(activeBounds?: Rectangle): Partial<Rectangle> & { maximized: boolean } {
  if (activeBounds) {
    const size = fitToWorkArea(activeBounds.width, activeBounds.height, activeBounds)
    const candidate = { x: activeBounds.x + CASCADE, y: activeBounds.y + CASCADE, ...size }
    const display = screen.getDisplayMatching(activeBounds).workArea
    if (candidate.x + candidate.width > display.x + display.width || candidate.y + candidate.height > display.y + display.height) {
      return { x: display.x + CASCADE, y: display.y + CASCADE, ...size, maximized: false }
    }
    return { ...candidate, maximized: false }
  }
  const saved = loadWindowState()
  if (saved.x !== undefined && saved.y !== undefined) {
    const rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    if (isVisible(rect)) return { ...rect, ...fitToWorkArea(rect.width, rect.height, rect), maximized: !!saved.maximized }
  }
  return { ...fitToWorkArea(saved.width, saved.height), maximized: !!saved.maximized }
}
