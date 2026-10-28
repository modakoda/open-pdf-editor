/**
 * Parse a 1-based page range expression like "1-3, 5, 8-" into sorted unique 0-based indices.
 * "8-" means 8 to the end, "-3" means 1 to 3. Throws RangeError on invalid input or
 * out-of-range pages.
 *
 * Accepted separators between parts: "," and ";". Inside a range, "-", "–" (en dash) or "—"
 * may be used and whitespace is ignored ("1 - 3").
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const parts = input
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (!parts.length) throw new RangeError('No pages specified.')

  const parseNumber = (s: string, part: string): number => {
    if (!/^\d+$/.test(s)) throw new RangeError(`Invalid page range "${part}".`)
    const n = Number(s)
    if (n < 1 || n > pageCount) {
      throw new RangeError(`Page ${n} is out of range (1-${pageCount}).`)
    }
    return n
  }

  const result = new Set<number>()
  for (const part of parts) {
    const m = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(part)
    if (m) {
      const [, a, b] = m
      if (!a && !b) throw new RangeError(`Invalid page range "${part}".`)
      const from = a ? parseNumber(a, part) : 1
      const to = b ? parseNumber(b, part) : pageCount
      if (from > to) throw new RangeError(`Invalid page range "${part}" (start is after end).`)
      for (let n = from; n <= to; n++) result.add(n - 1)
    } else {
      result.add(parseNumber(part, part) - 1)
    }
  }
  return [...result].sort((x, y) => x - y)
}

/** Format 0-based indices as a compact 1-based range string, e.g. [0,1,2,4] → "1-3, 5". */
export function formatPageRanges(indices: number[]): string {
  const sorted = [...new Set(indices.filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    const start = sorted[i]
    let end = start
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      i++
      end = sorted[i]
    }
    parts.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`)
    i++
  }
  return parts.join(', ')
}
