/** Locations of the bundled renderer, preload script and icon, plus dev/production URLs. */
import { app } from 'electron'
import { join } from 'node:path'
import iconPng from '../../build/icon.png?asset&asarUnpack'
import { APP_INDEX_URL, APP_ORIGIN } from './protocol'

export const PRODUCT_NAME = 'Open PDF Editor'

/** out/renderer (inside app.asar when packaged). */
export const rendererRoot = join(__dirname, '../renderer')
export const preloadPath = join(__dirname, '../preload/index.cjs')
/** Window icon (used on Linux; macOS and Windows take the icon from the app bundle / exe). */
export const iconPath = iconPng

/** Vite dev server URL in `npm run dev`, otherwise undefined. */
export const devServerUrl: string | undefined =
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : undefined

/** Development build (not packaged): enables reload/devtools menu items. */
export const isDev = !app.isPackaged

export const startUrl = devServerUrl ?? APP_INDEX_URL

/** Origin the renderer is allowed to live on (navigation and IPC sender checks). */
export const appOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN

export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === appOrigin || (u.protocol === 'app:' && u.host === 'bundle')
  } catch {
    return false
  }
}
