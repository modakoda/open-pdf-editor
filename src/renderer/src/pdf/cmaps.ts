/**
 * Supplies predefined CJK CMaps (pdf.js .bcmap files copied to public/pdfjs/cmaps) to the
 * content engine, which needs them synchronously while parsing page content. Only fonts that
 * use a named CMap (e.g. 90ms-RKSJ-H) trigger a load; the engine caches the result.
 */
import { setCMapLoader } from '@core/content'

/** Read a same-origin binary file synchronously (main-thread XHR cannot use responseType). */
function readBinarySync(url: string): Uint8Array | null {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.overrideMimeType('text/plain; charset=x-user-defined')
  xhr.send()
  if (xhr.status !== 200) return null
  const text = xhr.responseText
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

export function installCMapLoader(): void {
  setCMapLoader((name) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null
    try {
      return readBinarySync(new URL(`pdfjs/cmaps/${name}.bcmap`, document.baseURI).href)
    } catch {
      return null
    }
  })
}
