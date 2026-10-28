/**
 * WinAnsiEncoding (Windows code page 1252), the encoding used for the standard 14 PDF fonts
 * by the exporter. Maps Unicode code points to the single-byte code.
 */

/** Code points of bytes 0x80..0x9F in CP1252 (undefined bytes 0x81, 0x8D, 0x8F, 0x90, 0x9D omitted). */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f // Ÿ
}

/** WinAnsi byte for a Unicode code point, or undefined if it cannot be encoded. */
export function winAnsiCode(codePoint: number): number | undefined {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint
  return CP1252_HIGH[codePoint]
}

export function isWinAnsiCodePoint(codePoint: number): boolean {
  return winAnsiCode(codePoint) !== undefined
}
