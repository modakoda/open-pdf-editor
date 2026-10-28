import { describe, expect, it } from 'vitest'
import { formatPageRanges, parsePageRanges } from '../../src/core'

describe('parsePageRanges', () => {
  it('parses single pages, ranges and open ranges', () => {
    expect(parsePageRanges('1-3, 5, 8-', 10)).toEqual([0, 1, 2, 4, 7, 8, 9])
    expect(parsePageRanges('-3', 10)).toEqual([0, 1, 2])
    expect(parsePageRanges('4', 4)).toEqual([3])
    expect(parsePageRanges('2-2', 4)).toEqual([1])
  })

  it('sorts and removes duplicates', () => {
    expect(parsePageRanges('5, 1-3, 2, 3-4', 10)).toEqual([0, 1, 2, 3, 4])
  })

  it('tolerates whitespace, en dashes, semicolons and empty parts', () => {
    expect(parsePageRanges('  1 - 2 ;4–5,, ', 6)).toEqual([0, 1, 3, 4])
  })

  it('rejects invalid input', () => {
    for (const bad of ['', '   ', 'abc', '1-2-3', '-', '0', '3-1', '1.5', '2,x', '1 2']) {
      expect(() => parsePageRanges(bad, 10), bad).toThrow(RangeError)
    }
  })

  it('rejects out-of-range pages', () => {
    expect(() => parsePageRanges('11', 10)).toThrow(RangeError)
    expect(() => parsePageRanges('5-12', 10)).toThrow(RangeError)
    expect(() => parsePageRanges('1', 0)).toThrow(RangeError)
  })
})

describe('formatPageRanges', () => {
  it('formats compact ranges', () => {
    expect(formatPageRanges([0, 1, 2, 4])).toBe('1-3, 5')
    expect(formatPageRanges([4, 0, 2, 1, 2])).toBe('1-3, 5')
    expect(formatPageRanges([9])).toBe('10')
    expect(formatPageRanges([])).toBe('')
    expect(formatPageRanges([0, 2, 4])).toBe('1, 3, 5')
  })

  it('round-trips with parsePageRanges', () => {
    const indices = [0, 1, 2, 5, 7, 8, 11]
    expect(parsePageRanges(formatPageRanges(indices), 12)).toEqual(indices)
  })
})
