/** Image helpers: format sniffing, natural size, and reference-counted blob URLs. */
import { useEffect } from 'react'

export type ImageMime = 'image/png' | 'image/jpeg'

export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

/** Read width/height from PNG (IHDR) or JPEG (SOFn) headers without decoding. */
export function readImageSizeFromHeader(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png') {
    if (bytes.length < 24) return null
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0 && height > 0 ? { width, height } : null
  }
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2
      continue
    }
    const len = view.getUint16(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = view.getUint16(i + 5)
      const width = view.getUint16(i + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + len
  }
  return null
}

/** Natural size in pixels. Falls back to decoding the image when the header is unusual. */
export async function readImageSize(bytes: Uint8Array, mime: ImageMime): Promise<{ width: number; height: number } | null> {
  const fromHeader = readImageSizeFromHeader(bytes, mime)
  if (fromHeader) return fromHeader
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }))
      const size = { width: bmp.width, height: bmp.height }
      bmp.close()
      return size
    }
  } catch {
    /* fall through */
  }
  return null
}

interface UrlEntry {
  url: string
  refs: number
  timer: ReturnType<typeof setTimeout> | null
}

const urls = new WeakMap<Uint8Array, UrlEntry>()

function scheduleRevoke(data: Uint8Array, entry: UrlEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (entry.refs <= 0 && urls.get(data) === entry) {
      URL.revokeObjectURL(entry.url)
      urls.delete(data)
    }
  }, 2000)
}

/** Blob URL for image bytes, cached per Uint8Array (bytes are shared across undo snapshots). */
export function getImageUrl(data: Uint8Array, mime: string): string {
  let entry = urls.get(data)
  if (!entry) {
    entry = { url: URL.createObjectURL(new Blob([data as BlobPart], { type: mime })), refs: 0, timer: null }
    urls.set(data, entry)
    // Revoked later unless a mounted component acquires it.
    scheduleRevoke(data, entry)
  }
  return entry.url
}

/** Blob URL for image bytes that stays valid while the component is mounted. */
export function useImageUrl(data: Uint8Array, mime: string): string {
  const url = getImageUrl(data, mime)
  useEffect(() => {
    getImageUrl(data, mime)
    const entry = urls.get(data)!
    entry.refs++
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    return () => {
      entry.refs--
      if (entry.refs <= 0) scheduleRevoke(data, entry)
    }
  }, [data, mime])
  return url
}
