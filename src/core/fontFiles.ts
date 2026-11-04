/**
 * Font file helpers for hosts that load system fonts: browsers cannot pick a face out of a
 * TrueType/OpenType collection (.ttc/.otc), so the overlay declares the face the engine uses
 * as a standalone font built from the same bytes.
 */
import fontkit from '@cantoo/fontkit'

const TAG_TTCF = 0x74746366 // 'ttcf'

export function isFontCollection(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === TAG_TTCF
}

/** Index of the face with this PostScript name in a collection (0 if absent or not a collection). */
export function collectionFaceIndex(bytes: Uint8Array, postscriptName: string | undefined): number {
  if (!postscriptName || !isFontCollection(bytes)) return 0
  try {
    const created = fontkit.create(bytes)
    if (!('fonts' in created)) return 0
    return Math.max(0, created.fonts.findIndex((f) => f.postscriptName === postscriptName))
  } catch {
    return 0
  }
}

/**
 * The face `index` of a collection as a standalone sfnt font (tables copied, offsets rewritten).
 * Single-font files are returned unchanged.
 */
export function extractCollectionFace(bytes: Uint8Array, index = 0): Uint8Array {
  if (!isFontCollection(bytes)) return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numFonts = view.getUint32(8)
  if (index < 0 || index >= numFonts) throw new RangeError(`Font collection has no face ${index}`)
  const dir = view.getUint32(12 + 4 * index)
  const numTables = view.getUint16(dir + 4)
  const tables: { tag: number; checksum: number; offset: number; length: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const rec = dir + 12 + 16 * i
    tables.push({
      tag: view.getUint32(rec),
      checksum: view.getUint32(rec + 4),
      offset: view.getUint32(rec + 8),
      length: view.getUint32(rec + 12)
    })
  }
  const pad = (n: number) => (n + 3) & ~3
  const headerSize = 12 + 16 * numTables
  let size = headerSize
  for (const t of tables) {
    if (t.offset + t.length > bytes.length) throw new RangeError('Font collection table out of bounds')
    size += pad(t.length)
  }
  const out = new Uint8Array(size)
  const w = new DataView(out.buffer)
  out.set(bytes.subarray(dir, dir + 12), 0) // sfnt version, numTables, search fields
  let offset = headerSize
  tables.forEach((t, i) => {
    const rec = 12 + 16 * i
    w.setUint32(rec, t.tag)
    w.setUint32(rec + 4, t.checksum)
    w.setUint32(rec + 8, offset)
    w.setUint32(rec + 12, t.length)
    out.set(bytes.subarray(t.offset, t.offset + t.length), offset)
    offset += pad(t.length)
  })
  return out
}
