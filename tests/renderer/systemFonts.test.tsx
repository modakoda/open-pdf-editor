/**
 * On-demand system fonts in the renderer: which fonts are loaded for which text, engine
 * registration, notices for text no font can draw, and the overlay using the loaded font.
 * Uses the real engine with the OFL test fonts from tests/fixtures/fonts.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addObject,
  clearRegisteredFonts,
  createBlankDocument,
  prepareText,
  setPreferredHanLanguage,
  updateSettings,
  type EditorDocument,
  type TextObject
} from '@core'
import type { SystemFontInfo } from '@shared/ipc'
import { ObjectView } from '@renderer/editing/ObjectView'
import { textFontStack } from '@renderer/editing/textLayout'
import {
  ensureFontsForText,
  fontsReadyFor,
  installSystemFontLoader,
  rankSystemFonts,
  resetSystemFontsForTests,
  scanDocument,
  unsupportedCharactersIn,
  unsupportedTextMessage,
  useFallbackFonts
} from '@renderer/fonts/systemFonts'
import { platform } from '@renderer/platform'
import { useEditor } from '@renderer/state/store'

// The renderer project has no Node typings: load fs untyped. Copy into this realm's Uint8Array
// (jsdom tests run in a separate realm from Node's fs).
const fs: { readFileSync(path: URL): ArrayLike<number> } = await import(/* @vite-ignore */ 'node:fs' as string)
const here = import.meta.url // (not inlined: Vite rewrites `new URL(…, import.meta.url)` to asset URLs)
const read = (file: string) => Uint8Array.from(fs.readFileSync(new URL(`../fixtures/fonts/${file}`, here)))
const BYTES: Record<string, Uint8Array> = {
  jp: read('OPETestJP-Regular.otf'),
  'cjk-bold': read('OPETestCJK.ttc'),
  cjk: read('OPETestCJK.ttc')
}

const CATALOG: SystemFontInfo[] = [
  { id: 'jp', name: 'OPE Test JP', scripts: ['cjk', 'kana'], language: 'ja', family: 'sans', bold: false },
  {
    id: 'cjk-bold',
    name: 'OPE Test CJK Bold',
    postscriptName: 'OPETestCJK-Bold',
    scripts: ['cjk', 'kana'],
    language: 'zh-Hans',
    family: 'sans',
    bold: true
  },
  {
    id: 'cjk',
    name: 'OPE Test CJK',
    postscriptName: 'OPETestCJK-Regular',
    scripts: ['cjk', 'kana'],
    language: 'zh-Hans',
    family: 'sans',
    bold: false
  }
]

const sans = { font: 'sans' as const, bold: false, italic: false }
let catalog: SystemFontInfo[]
const listSystemFonts = vi.fn(async () => catalog)
const readSystemFont = vi.fn(async (id: string) => BYTES[id])

function textObj(pageId: string, text: string, extra: Partial<TextObject> = {}): TextObject {
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    pageId,
    type: 'text',
    x: 10,
    y: 10,
    width: 200,
    height: 30,
    text,
    font: 'sans',
    bold: false,
    italic: false,
    fontSize: 12,
    color: '#000000',
    align: 'left',
    lineHeight: 1.2,
    rotation: 0,
    ...extra
  }
}

function docWith(...texts: string[]): EditorDocument {
  let doc = createBlankDocument()
  for (const t of texts) doc = addObject(doc, textObj(doc.pages[0].id, t))
  return doc
}

const loadedIds = () => readSystemFont.mock.calls.map(([id]) => id)

beforeEach(() => {
  catalog = CATALOG
  clearRegisteredFonts()
  setPreferredHanLanguage('zh-Hans')
  resetSystemFontsForTests()
  listSystemFonts.mockClear()
  readSystemFont.mockClear()
  Object.assign(platform, { listSystemFonts, readSystemFont })
  useEditor.setState({ notice: null })
})

afterEach(() => {
  cleanup()
  delete platform.listSystemFonts
  delete platform.readSystemFont
  clearRegisteredFonts()
})

describe('loading system fonts on demand', () => {
  it('loads nothing for text the bundled fonts cover', async () => {
    await ensureFontsForText('Hello ąčę Ελληνικά', sans)
    expect(listSystemFonts).not.toHaveBeenCalled()
    expect(readSystemFont).not.toHaveBeenCalled()
  })

  it('loads the best font for the script and registers it with the engine', async () => {
    const version = useFallbackFonts.getState().version
    expect(prepareText('你好', sans).text).toBe('??')
    await ensureFontsForText('你好', sans)
    expect(loadedIds()).toEqual(['cjk'])
    expect(prepareText('你好', sans)).toMatchObject({
      text: '你好',
      font: { fontKey: 'fallback:cjk', postscriptName: 'OPETestCJK-Regular' }
    })
    expect(useFallbackFonts.getState().version).toBe(version + 1)
    // Loaded once.
    await ensureFontsForText('世界', sans)
    expect(loadedIds()).toEqual(['cjk'])
  })

  it('loads Japanese fonts for kana and bold faces for bold text', async () => {
    await ensureFontsForText('こんにちは', sans)
    expect(loadedIds()).toEqual(['jp'])
    await ensureFontsForText('你好', { ...sans, bold: true })
    expect(loadedIds()).toEqual(['jp', 'cjk-bold'])
    expect(prepareText('你好', { ...sans, bold: true }).font).toMatchObject({ postscriptName: 'OPETestCJK-Bold' })
  })

  it('tries further fonts until one contains every character', async () => {
    // The Japanese test font lacks 你好.
    await ensureFontsForText('こんにちは你好', sans)
    expect(loadedIds()).toEqual(['jp', 'cjk'])
    expect(prepareText('こんにちは你好', sans)).toMatchObject({ missing: [], font: { fontKey: 'fallback:cjk' } })
  })

  it('ranks candidates by language, family and weight', () => {
    const ids = (lang: 'ja' | 'zh-Hans' | null, bold = false) =>
      rankSystemFonts(CATALOG, 'cjk', lang, { ...sans, bold }).map((f) => f.id)
    expect(ids('ja')).toEqual(['jp', 'cjk', 'cjk-bold'])
    expect(ids('zh-Hans')).toEqual(['cjk', 'cjk-bold', 'jp'])
    expect(ids('zh-Hans', true)).toEqual(['cjk-bold', 'cjk', 'jp'])
    expect(rankSystemFonts(CATALOG, 'thai', null, sans)).toEqual([])
  })

  it('survives a shell without system fonts or failing reads', async () => {
    delete platform.listSystemFonts
    await ensureFontsForText('你好', sans)
    resetSystemFontsForTests()
    Object.assign(platform, { listSystemFonts })
    readSystemFont.mockRejectedValueOnce(new Error('EACCES'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await ensureFontsForText('你好', sans)
    // The failed font is skipped; the next candidate is used.
    expect(prepareText('你好', sans).missing).toEqual([])
  })
})

describe('documents', () => {
  it('waits for the fonts of every text before export', async () => {
    let doc = docWith('你好', 'Plain')
    doc = updateSettings(doc, { watermark: { text: '测试', fontSize: 40, color: '#ff0000', opacity: 0.3, angle: 45 } })
    await fontsReadyFor(doc)
    expect(loadedIds().sort()).toEqual(['cjk', 'cjk-bold']) // the watermark is bold
    expect(unsupportedCharactersIn(doc)).toEqual({ missing: [], rtl: false })
  })

  it('loads fonts when a document with CJK text is opened or edited', async () => {
    installSystemFontLoader()
    act(() => useEditor.getState().setDocument(docWith('漢字'), { filePath: null, fileName: 'x.pdf' }))
    await vi.waitFor(() => expect(loadedIds()).toEqual(['cjk']))
  })

  it('shows a notice for characters no installed font contains', async () => {
    catalog = []
    scanDocument(docWith('你好'))
    await fontsReadyFor(docWith('你好'))
    const notice = useEditor.getState().notice
    expect(notice?.kind).toBe('error')
    expect(notice?.text).toContain('No installed font contains “你” “好”')
    expect(unsupportedCharactersIn(docWith('你好'))).toEqual({ missing: ['你', '好'], rtl: false })
  })

  it('says right-to-left text is not supported yet', async () => {
    await fontsReadyFor(docWith('שלום'))
    expect(useEditor.getState().notice?.text).toContain('Right-to-left text (Arabic, Hebrew) is not supported yet')
  })

  it('formats the unsupported-text message', () => {
    expect(unsupportedTextMessage([], false)).toBeNull()
    expect(unsupportedTextMessage(['你'], false)).toBe(
      'No installed font contains “你”: it is shown and saved as “?”. Install a font for this language and restart Open PDF Editor.'
    )
    // Combining marks are not listed on their own.
    expect(unsupportedTextMessage(['न', '्'], false)).toContain('contains “न”: these are')
    expect(unsupportedTextMessage(['ש'], true)).toBe('Right-to-left text (Arabic, Hebrew) is not supported yet: it is shown and saved as “?”.')
  })
})

describe('overlay', () => {
  it('draws text with the loaded font once it is available', async () => {
    const obj = textObj('p1', '你好世界')
    const { container } = render(<ObjectView obj={obj} page={{ width: 600, height: 800 }} scale={1} selected={false} />)
    const text = () => container.querySelector('text')!
    expect(text().textContent).toBe('????')
    expect(text().getAttribute('font-family')).not.toContain('OPE Fallback')
    await act(() => ensureFontsForText('你好世界', sans))
    expect(text().textContent).toBe('你好世界')
    expect(text().getAttribute('font-family')).toBe("'OPE Fallback cjk', 'OPE Noto Sans', 'Noto Sans', sans-serif")
    expect(text().style.fontSynthesis).toBe('none')
    expect(textFontStack('你好', { font: 'serif' })).toBe("'OPE Fallback cjk', 'OPE Noto Serif', 'Noto Serif', serif")
  })
})
