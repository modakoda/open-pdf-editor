import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)

import { buildIndex, findAll, rectsForRange } from '@renderer/pdf/textSearch'
import { closeFind, findNext, findPrevious, openFind, runFind } from '@renderer/actions/find'
import { useFind } from '@renderer/state/find'
import { makeDoc } from './support/fakeCore'
import { editor, loadDoc, resetStores } from './support/editor'

describe('text index', () => {
  const identity = (x: number, y: number): [number, number] => [x, 800 - y]

  it('joins items, adds spaces at line ends and finds case-insensitive matches', () => {
    const index = buildIndex(
      [
        { str: 'Hello', transform: [10, 0, 0, 10, 100, 700], width: 50, height: 10, hasEOL: true },
        { str: 'WORLD hello', transform: [10, 0, 0, 10, 100, 680], width: 110, height: 10 }
      ],
      identity
    )
    expect(index.text).toBe('Hello WORLD hello')
    expect(findAll(index.text, 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 17 }
    ])
    expect(findAll(index.text, '')).toEqual([])
  })

  it('maps matches to page-space rectangles', () => {
    const index = buildIndex([{ str: 'abcd', transform: [10, 0, 0, 10, 100, 700], width: 40, height: 10 }], identity)
    const [rect] = rectsForRange(index, 0, 4)
    // Baseline at y = 800 - 700 = 100 in page space, text extends upwards.
    expect(rect.x).toBeCloseTo(100)
    expect(rect.width).toBeCloseTo(40)
    expect(rect.y).toBeLessThan(100)
    expect(rect.y + rect.height).toBeGreaterThan(100)
  })
})

describe('find actions', () => {
  beforeEach(() => {
    resetStores()
    loadDoc(makeDoc(3))
  })

  it('searches all pages and cycles through matches', async () => {
    openFind()
    expect(useFind.getState().open).toBe(true)
    await runFind('world')
    const { matches, active } = useFind.getState()
    expect(matches.map((m) => m.pageId)).toEqual(['p1', 'p2', 'p3'])
    expect(active).toBe(0)
    expect(editor().scrollRequest?.pageId).toBe('p1')
    findNext()
    expect(useFind.getState().active).toBe(1)
    expect(editor().currentPageId).toBe('p2')
    findPrevious()
    findPrevious()
    expect(useFind.getState().active).toBe(2)
    closeFind()
    expect(useFind.getState()).toMatchObject({ open: false, matches: [], active: -1 })
  })

  it('reports no matches', async () => {
    await runFind('nothing here')
    expect(useFind.getState().matches).toEqual([])
    expect(useFind.getState().searching).toBe(false)
  })
})
