/**
 * The production renderer is served from a privileged custom scheme (app://bundle/…) instead of
 * file://, so it gets a proper origin (fetch, workers, CSP 'self') and cannot read arbitrary files.
 * Every request maps to a file inside out/renderer; anything else is a 404.
 */
import { protocol } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pfb': 'application/x-font-type1',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
    }
  ])
}

/**
 * Maps a URL path (still percent-encoded) to a file below `root`, or null if it would escape
 * `root` (path traversal, encoded separators, NUL bytes, absolute paths…).
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  if (decoded === '' || decoded.endsWith('/')) decoded += 'index.html'
  const base = resolve(root)
  const full = resolve(join(base, decoded))
  const rel = relative(base, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
  return full
}

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }
  })
}

/** Serves `root` (out/renderer) on app://bundle/. Must run after the app is ready. */
export function handleAppScheme(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Method Not Allowed')
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return textResponse(400, 'Bad Request')
    }
    if (url.host !== APP_HOST) return textResponse(404, 'Not Found')
    const file = resolveAssetPath(root, url.pathname)
    if (!file) return textResponse(403, 'Forbidden')
    try {
      const info = await stat(file)
      if (!info.isFile()) return textResponse(404, 'Not Found')
      const headers = {
        'content-type': mimeTypeFor(file),
        'content-length': String(info.size),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      const body = await readFile(file)
      return new Response(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), { status: 200, headers })
    } catch {
      return textResponse(404, 'Not Found')
    }
  })
}
