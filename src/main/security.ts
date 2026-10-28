/**
 * Hardening for every web contents: no new windows, no navigation away from the app, no
 * <webview>, no permission prompts. http(s)/mailto links (e.g. PDF link annotations) open in the
 * user's browser instead.
 */
import { app, session, shell } from 'electron'
import { isAppUrl } from './paths'

/** Harmless permissions the editor may use (copying to the clipboard, fullscreen). */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

function openExternalSafely(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url)
  } catch {
    /* not a URL */
  }
}

export function hardenSessions(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  ses.setDevicePermissionHandler(() => false)
}

export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return
      event.preventDefault()
      openExternalSafely(url)
    })
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    // Pinch-zoom would scale the whole UI; the viewer implements its own zoom.
    void Promise.resolve(contents.setVisualZoomLevelLimits(1, 1)).catch(() => undefined)
  })
}
