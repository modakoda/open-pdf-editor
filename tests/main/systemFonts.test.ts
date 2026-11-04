/**
 * System font discovery per platform, with node:fs and node:child_process mocked by a small
 * in-memory file system and canned fc-list output. Paths are normalized (the suite also runs
 * on Windows, where join() turns "/" into "\\").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join, normalize } from 'node:path'

const vfs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  sizes: new Map<string, number>(),
  fcList: null as null | ((lang: string) => string | Error)
}))

function dirsOf(): Set<string> {
  const dirs = new Set<string>()
  for (const f of vfs.files.keys()) {
    let d = dirname(f)
    while (!dirs.has(d) && d !== dirname(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  return dirs
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { basename, dirname, normalize } = await import('node:path')
  return {
    ...actual,
    existsSync: (path: string) => vfs.files.has(normalize(path)) || dirsOf().has(normalize(path)),
    statSync: (path: string) => {
      const p = normalize(path)
      if (vfs.files.has(p)) return { isFile: () => true, size: vfs.sizes.get(p) ?? vfs.files.get(p)!.length }
      if (dirsOf().has(p)) return { isFile: () => false, size: 0 }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
    readdirSync: (path: string) => {
      const dir = normalize(path)
      const dirs = dirsOf()
      if (!dirs.has(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' })
      const names = new Map<string, boolean>()
      for (const f of vfs.files.keys()) if (dirname(f) === dir) names.set(basename(f), false)
      for (const d of dirs) if (dirname(d) === dir && d !== dir) names.set(basename(d), true)
      return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }))
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (p: string) => {
      const { normalize } = await import('node:path')
      const data = vfs.files.get(normalize(p))
      if (!data) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return Buffer.from(data)
    }
  }
})

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const lang = args[args.length - 1].replace(':lang=', '')
    const out = cmd === 'fc-list' && vfs.fcList ? vfs.fcList(lang) : new Error('spawn fc-list ENOENT')
    setTimeout(() => (out instanceof Error ? cb(out, '') : cb(null, out)), 0)
  }
}))

const { FC_FORMAT, MAX_FONT_BYTES, SystemFontCatalog, discoverSystemFonts, fontDirectories, isFontData, parseFcList } = await import(
  '../../src/main/systemFonts'
)

const TTC = new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])
const TTF = new Uint8Array([0, 1, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const OTF = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

function addFile(path: string, data = TTF): string {
  vfs.files.set(normalize(path), data)
  return path
}

beforeEach(() => {
  vfs.files.clear()
  vfs.sizes.clear()
  vfs.fcList = null
})

describe('font folders', () => {
  it('lists the system and per-user folders of each platform', () => {
    expect(fontDirectories('darwin', {}, '/Users/ada')).toEqual([
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      join('/Users/ada', 'Library/Fonts')
    ])
    expect(fontDirectories('win32', { WINDIR: 'D:\\Win', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'C:\\Users\\ada')).toEqual([
      join('D:\\Win', 'Fonts'),
      join('C:\\Users\\ada\\AppData\\Local', 'Microsoft', 'Windows', 'Fonts')
    ])
    expect(fontDirectories('win32', {}, '')).toEqual([join('C:\\Windows', 'Fonts')])
    expect(fontDirectories('linux', { XDG_DATA_HOME: '/data' }, '/home/ada')).toEqual([
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      join('/data', 'fonts'),
      join('/home/ada', '.fonts')
    ])
  })
})

describe('macOS', () => {
  it('finds the known CJK, Thai and Devanagari fonts with their faces', async () => {
    addFile('/System/Library/Fonts/Hiragino Sans GB.ttc', TTC)
    addFile('/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc', TTC)
    addFile('/System/Library/Fonts/AppleSDGothicNeo.ttc', TTC)
    addFile('/System/Library/Fonts/Supplemental/Songti.ttc', TTC)
    addFile('/System/Library/Fonts/Supplemental/Thonburi.ttc', TTC)
    addFile('/System/Library/Fonts/Kohinoor.ttc', TTC)
    addFile(join('/Users/ada', 'Library/Fonts', 'Arial Unicode.ttf'))
    addFile('/System/Library/Fonts/Helvetica.ttc', TTC) // not a fallback font
    const fonts = await discoverSystemFonts('darwin', {}, '/Users/ada')
    const summary = fonts.map((f) => [f.postscriptName ?? f.name, f.language ?? '-', f.family, f.bold])
    expect(summary).toEqual([
      ['HiraginoSansGB-W3', 'zh-Hans', 'sans', false],
      ['HiraginoSansGB-W6', 'zh-Hans', 'sans', true],
      ['STSongti-SC-Regular', 'zh-Hans', 'serif', false],
      ['STSongti-SC-Bold', 'zh-Hans', 'serif', true],
      ['STSongti-TC-Regular', 'zh-Hant', 'serif', false],
      ['STSongti-TC-Bold', 'zh-Hant', 'serif', true],
      ['HiraginoSans-W3', 'ja', 'sans', false],
      ['AppleSDGothicNeo-Regular', 'ko', 'sans', false],
      ['AppleSDGothicNeo-Bold', 'ko', 'sans', true],
      ['Thonburi', '-', 'sans', false],
      ['Thonburi-Bold', '-', 'sans', true],
      ['KohinoorDevanagari-Regular', '-', 'sans', false],
      ['KohinoorDevanagari-Bold', '-', 'sans', true],
      ['Arial Unicode MS', '-', 'sans', false]
    ])
    expect(fonts[0].path).toBe(join('/System/Library/Fonts', 'Hiragino Sans GB.ttc'))
    expect(fonts[2].path).toBe(join('/System/Library/Fonts/Supplemental', 'Songti.ttc'))
    expect(fonts.find((f) => f.language === 'ko')!.scripts).toEqual(['hangul', 'cjk'])
    expect(fonts.find((f) => f.language === 'ja')!.scripts).toEqual(['cjk', 'kana'])
    expect(fonts.find((f) => f.postscriptName === 'Thonburi')!.scripts).toEqual(['thai'])
    expect(fonts.at(-1)!.path).toBe(join('/Users/ada', 'Library/Fonts', 'Arial Unicode.ttf'))
  })

  it('finds nothing on a system without such fonts', async () => {
    addFile('/System/Library/Fonts/Helvetica.ttc', TTC)
    expect(await discoverSystemFonts('darwin', {}, '/Users/ada')).toEqual([])
  })
})

describe('Windows', () => {
  it('finds system-wide and per-user fonts (first face of collections)', async () => {
    const env = { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }
    const sys = join('C:\\Windows', 'Fonts')
    const user = join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')
    addFile(join(sys, 'msyh.ttc'), TTC)
    addFile(join(sys, 'msyhbd.ttc'), TTC)
    addFile(join(sys, 'YuGothR.ttc'), TTC)
    addFile(join(sys, 'malgun.ttf'))
    addFile(join(user, 'batang.ttc'), TTC)
    addFile(join(sys, 'Nirmala.ttc'), TTC)
    addFile(join(sys, 'LeelawUI.ttf'))
    const fonts = await discoverSystemFonts('win32', env, 'C:\\Users\\ada')
    expect(fonts.map((f) => [f.name, f.language ?? '-', f.family, f.bold, f.path])).toEqual([
      ['Microsoft YaHei', 'zh-Hans', 'sans', false, join(sys, 'msyh.ttc')],
      ['Microsoft YaHei Bold', 'zh-Hans', 'sans', true, join(sys, 'msyhbd.ttc')],
      ['Yu Gothic', 'ja', 'sans', false, join(sys, 'YuGothR.ttc')],
      ['Malgun Gothic', 'ko', 'sans', false, join(sys, 'malgun.ttf')],
      ['Batang', 'ko', 'serif', false, join(user, 'batang.ttc')],
      ['Leelawadee UI', '-', 'sans', false, join(sys, 'LeelawUI.ttf')],
      ['Nirmala UI', '-', 'sans', false, join(sys, 'Nirmala.ttc')]
    ])
    expect(fonts.every((f) => f.postscriptName === undefined)).toBe(true)
  })
})

const fcLine = (file: string, index: number, ps: string, family: string, style: string, weight: number, spacing = 0) =>
  [file, index, ps, family, style, weight, spacing].join('\t')

describe('Linux with fontconfig', () => {
  const NOTO = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
  const NOTO_BOLD = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
  const WQY = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
  const THAI = '/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf'

  it('parses fc-list output: faces, language from the family, weight, italics and mono', () => {
    const out = [
      fcLine(NOTO, 2, 'NotoSansCJKsc-Regular', 'Noto Sans CJK SC', 'Regular', 80),
      fcLine(NOTO, 0, 'NotoSansCJKjp-Regular', 'Noto Sans CJK JP', 'Regular', 80),
      fcLine(NOTO_BOLD, 3, 'NotoSansCJKkr-Bold', 'Noto Sans CJK KR', 'Bold', 200),
      fcLine(NOTO, 7, 'NotoSansMonoCJKsc-Regular', 'Noto Sans Mono CJK SC', 'Regular', 80, 100),
      fcLine('/usr/share/fonts/x/Light.ttc', 0, 'X-Light', 'Noto Sans CJK SC', 'Light', 50),
      fcLine('/usr/share/fonts/x/Italic.ttf', 0, 'X-Italic', 'Some Font', 'Italic', 80),
      fcLine('/usr/share/fonts/x/font.pcf.gz', 0, 'X', 'Bitmap', 'Regular', 80),
      fcLine('/usr/share/fonts/truetype/arphic/ukai.ttc', 0, 'ARPLUKaiCN', 'AR PL UKai CN', 'Book', 80),
      ''
    ].join('\n')
    const fonts = parseFcList(out, { lang: 'zh-tw', scripts: ['cjk'], language: 'zh-Hant' })
    expect(fonts.map((f) => [f.postscriptName, f.language, f.family, f.bold])).toEqual([
      ['NotoSansCJKsc-Regular', 'zh-Hans', 'sans', false],
      ['NotoSansCJKjp-Regular', 'ja', 'sans', false],
      ['NotoSansCJKkr-Bold', 'ko', 'sans', true],
      ['NotoSansMonoCJKsc-Regular', 'zh-Hans', 'mono', false],
      ['ARPLUKaiCN', 'zh-Hans', 'serif', false]
    ])
    expect(fonts[0]).toMatchObject({ path: NOTO, name: 'Noto Sans CJK SC', scripts: ['cjk'] })
    expect(fonts[2].name).toBe('Noto Sans CJK KR Bold')
    // Unknown families take the language of the query.
    expect(parseFcList(fcLine('/f/a.ttf', 0, 'A', 'Foo', 'Regular', 80), { lang: 'ja', scripts: ['cjk', 'kana'], language: 'ja' })[0].language).toBe('ja')
  })

  it('queries each language, merges faces and prefers well-known families', async () => {
    vfs.fcList = (lang) => {
      const lines: Record<string, string[]> = {
        'zh-cn': [fcLine(WQY, 0, 'WenQuanYiZenHei', 'WenQuanYi Zen Hei', 'Regular', 80), fcLine(NOTO, 2, 'NotoSansCJKsc-Regular', 'Noto Sans CJK SC', 'Regular', 80)],
        'zh-tw': [fcLine(NOTO, 3, 'NotoSansCJKtc-Regular', 'Noto Sans CJK TC', 'Regular', 80)],
        ja: [fcLine(NOTO, 0, 'NotoSansCJKjp-Regular', 'Noto Sans CJK JP', 'Regular', 80), fcLine(NOTO, 2, 'NotoSansCJKsc-Regular', 'Noto Sans CJK SC', 'Regular', 80)],
        ko: [fcLine(NOTO, 1, 'NotoSansCJKkr-Regular', 'Noto Sans CJK KR', 'Regular', 80), fcLine(NOTO, 2, 'NotoSansCJKsc-Regular', 'Noto Sans CJK SC', 'Regular', 80)],
        th: [fcLine(THAI, 0, 'NotoSansThai-Regular', 'Noto Sans Thai', 'Regular', 80)],
        hi: []
      }
      return lines[lang].map((l) => l + '\n').join('')
    }
    const fonts = await discoverSystemFonts('linux', {}, '/home/ada')
    expect(fonts.map((f) => f.postscriptName)).toEqual([
      'NotoSansCJKsc-Regular',
      'NotoSansCJKtc-Regular',
      'NotoSansCJKjp-Regular',
      'NotoSansCJKkr-Regular',
      'NotoSansThai-Regular',
      'WenQuanYiZenHei'
    ])
    // The SC face was reported for Chinese, Japanese and Korean: one entry with every script.
    expect(fonts[0].scripts.sort()).toEqual(['cjk', 'hangul', 'kana'])
    expect(fonts[0].language).toBe('zh-Hans')
    expect(fonts[4]).toMatchObject({ path: THAI, scripts: ['thai'] })
  })

  it('passes the format and language to fc-list', async () => {
    const seen: string[] = []
    vfs.fcList = (lang) => {
      seen.push(lang)
      return ''
    }
    await discoverSystemFonts('linux', {}, '/home/ada')
    expect(seen.sort()).toEqual(['hi', 'ja', 'ko', 'th', 'zh-cn', 'zh-tw'])
    expect(FC_FORMAT).toContain('%{postscriptname}')
  })
})

describe('Linux without fontconfig', () => {
  it('scans the font folders for well-known files', async () => {
    addFile('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', TTC)
    addFile('/usr/share/fonts/truetype/nanum/NanumGothic.ttf')
    addFile(join('/home/ada', '.local/share', 'fonts', 'NotoSansDevanagari-Regular.ttf'))
    addFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    const fonts = await discoverSystemFonts('linux', {}, '/home/ada')
    expect(fonts.map((f) => [f.postscriptName ?? f.name, f.language ?? '-'])).toEqual([
      ['NotoSansCJKsc-Regular', 'zh-Hans'],
      ['NotoSansCJKtc-Regular', 'zh-Hant'],
      ['NotoSansCJKjp-Regular', 'ja'],
      ['NotoSansCJKkr-Regular', 'ko'],
      ['NanumGothic', 'ko'],
      ['Noto Sans Devanagari', '-']
    ])
    expect(fonts.at(-1)!.path).toBe(join('/home/ada', '.local/share', 'fonts', 'NotoSansDevanagari-Regular.ttf'))
  })
})

describe('e2e test hook', () => {
  it('replaces the system fonts only when OPE_E2E=1', async () => {
    const path = addFile('/tmp/test/OPETestCJK.ttc', TTC)
    const list = JSON.stringify([
      { path, name: 'OPE Test CJK', postscriptName: 'OPETestCJK-Regular', scripts: ['cjk', 'kana'], language: 'zh-Hans', family: 'sans', bold: false },
      { path: '/tmp/test/missing.ttf', name: 'Missing', scripts: ['cjk'], family: 'sans', bold: false }
    ])
    addFile('/System/Library/Fonts/Hiragino Sans GB.ttc', TTC)
    const hooked = await discoverSystemFonts('darwin', { OPE_E2E: '1', OPE_E2E_SYSTEM_FONTS: list }, '/Users/ada')
    expect(hooked.map((f) => f.name)).toEqual(['OPE Test CJK'])
    const normal = await discoverSystemFonts('darwin', { OPE_E2E_SYSTEM_FONTS: list }, '/Users/ada')
    expect(normal[0].postscriptName).toBe('HiraginoSansGB-W3')
  })
})

describe('catalog', () => {
  const candidates = () => [
    { path: addFile('/fonts/a.ttc', TTC), name: 'A', postscriptName: 'A-Regular', scripts: ['cjk' as const], family: 'sans' as const, bold: false },
    { path: addFile('/fonts/b.otf', OTF), name: 'B', scripts: ['thai' as const], family: 'serif' as const, bold: true }
  ]

  it('lists fonts by id without paths and serves their bytes', async () => {
    const catalog = new SystemFontCatalog(async () => candidates())
    const list = await catalog.list()
    expect(list).toEqual([
      { id: 'sys0', name: 'A', postscriptName: 'A-Regular', scripts: ['cjk'], family: 'sans', bold: false },
      { id: 'sys1', name: 'B', scripts: ['thai'], family: 'serif', bold: true }
    ])
    expect(JSON.stringify(list)).not.toContain('/fonts/')
    expect(await catalog.read('sys0')).toEqual(TTC)
    expect(await catalog.read('sys1')).toEqual(OTF)
  })

  it('discovers once', async () => {
    const discover = vi.fn(async () => candidates())
    const catalog = new SystemFontCatalog(discover)
    await catalog.list()
    await catalog.read('sys0')
    await catalog.list()
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('refuses unknown ids, non-font data and oversized files', async () => {
    const list = candidates()
    const catalog = new SystemFontCatalog(async () => list)
    await expect(catalog.read('sys9')).rejects.toThrow('Unknown system font')
    await expect(catalog.read('/fonts/a.ttc')).rejects.toThrow('Unknown system font')
    await expect(catalog.read(0)).rejects.toThrow(TypeError)
    addFile('/fonts/a.ttc', new TextEncoder().encode('#!/bin/sh\necho not a font\n'))
    await expect(catalog.read('sys0')).rejects.toThrow('is not a font file')
    vfs.sizes.set(normalize('/fonts/b.otf'), MAX_FONT_BYTES + 1)
    await expect(catalog.read('sys1')).rejects.toThrow('cannot be used')
  })

  it('treats a failing discovery as no fonts', async () => {
    const catalog = new SystemFontCatalog(async () => {
      throw new Error('boom')
    })
    expect(await catalog.list()).toEqual([])
  })

  it('recognizes font signatures', () => {
    expect([TTC, TTF, OTF].map(isFontData)).toEqual([true, true, true])
    expect(isFontData(new Uint8Array([0x74, 0x72, 0x75, 0x65, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true) // 'true'
    expect(isFontData(new Uint8Array(4))).toBe(false)
    expect(isFontData(new TextEncoder().encode('<html><body>hi</body></html>'))).toBe(false)
  })
})
