/**
 * System fonts for scripts the bundled Noto fonts do not cover (CJK, Thai, Devanagari). CJK
 * fonts are far too large to bundle, so the main process finds suitable font files of the OS
 * and serves their bytes to the renderer, which registers them with the engine's fallback
 * chain (src/core/text.ts) on demand.
 *
 * Only files found here are ever read: known font files in the platform's font folders
 * (macOS, Windows, Linux without fontconfig) or fonts fontconfig reports (Linux). The renderer
 * refers to them by catalog id, never by path. No Electron imports: tested with mocked fs.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { SystemFontInfo } from '@shared/ipc'

type Family = SystemFontInfo['family']
type Script = SystemFontInfo['scripts'][number]
type Language = NonNullable<SystemFontInfo['language']>

/** A font face on disk (SystemFontInfo without the id, plus its path). */
export interface FontCandidate extends Omit<SystemFontInfo, 'id'> {
  path: string
}

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc'])
/** Largest font file served (the biggest CJK collections are ~70 MB). */
export const MAX_FONT_BYTES = 256 * 1024 * 1024

const CJK: Script[] = ['cjk', 'kana']
const KOREAN: Script[] = ['hangul', 'cjk']
const THAI: Script[] = ['thai']
const DEVANAGARI: Script[] = ['devanagari']

interface KnownFont {
  file: string
  name: string
  postscriptName?: string
  scripts: Script[]
  language?: Language
  family?: Family
  bold?: boolean
}

const zh = (language: Language, family: Family = 'sans', bold = false) => ({ scripts: ['cjk'] as Script[], language, family, bold })
const ja = (family: Family = 'sans', bold = false) => ({ scripts: CJK, language: 'ja' as const, family, bold })
const ko = (family: Family = 'sans', bold = false) => ({ scripts: KOREAN, language: 'ko' as const, family, bold })

/** In order of preference; the renderer picks among them by script, language, family, weight. */
const MAC_FONTS: KnownFont[] = [
  { file: 'PingFang.ttc', name: 'PingFang SC', postscriptName: 'PingFangSC-Regular', ...zh('zh-Hans') },
  { file: 'PingFang.ttc', name: 'PingFang SC Semibold', postscriptName: 'PingFangSC-Semibold', ...zh('zh-Hans', 'sans', true) },
  { file: 'PingFang.ttc', name: 'PingFang TC', postscriptName: 'PingFangTC-Regular', ...zh('zh-Hant') },
  { file: 'PingFang.ttc', name: 'PingFang TC Semibold', postscriptName: 'PingFangTC-Semibold', ...zh('zh-Hant', 'sans', true) },
  { file: 'Hiragino Sans GB.ttc', name: 'Hiragino Sans GB W3', postscriptName: 'HiraginoSansGB-W3', ...zh('zh-Hans') },
  { file: 'Hiragino Sans GB.ttc', name: 'Hiragino Sans GB W6', postscriptName: 'HiraginoSansGB-W6', ...zh('zh-Hans', 'sans', true) },
  { file: 'STHeiti Light.ttc', name: 'Heiti SC Light', postscriptName: 'STHeitiSC-Light', ...zh('zh-Hans') },
  { file: 'STHeiti Medium.ttc', name: 'Heiti SC Medium', postscriptName: 'STHeitiSC-Medium', ...zh('zh-Hans', 'sans', true) },
  { file: 'STHeiti Light.ttc', name: 'Heiti TC Light', postscriptName: 'STHeitiTC-Light', ...zh('zh-Hant') },
  { file: 'STHeiti Medium.ttc', name: 'Heiti TC Medium', postscriptName: 'STHeitiTC-Medium', ...zh('zh-Hant', 'sans', true) },
  { file: 'Songti.ttc', name: 'Songti SC', postscriptName: 'STSongti-SC-Regular', ...zh('zh-Hans', 'serif') },
  { file: 'Songti.ttc', name: 'Songti SC Bold', postscriptName: 'STSongti-SC-Bold', ...zh('zh-Hans', 'serif', true) },
  { file: 'Songti.ttc', name: 'Songti TC', postscriptName: 'STSongti-TC-Regular', ...zh('zh-Hant', 'serif') },
  { file: 'Songti.ttc', name: 'Songti TC Bold', postscriptName: 'STSongti-TC-Bold', ...zh('zh-Hant', 'serif', true) },
  { file: 'ヒラギノ角ゴシック W3.ttc', name: 'Hiragino Sans W3', postscriptName: 'HiraginoSans-W3', ...ja() },
  { file: 'ヒラギノ角ゴシック W6.ttc', name: 'Hiragino Sans W6', postscriptName: 'HiraginoSans-W6', ...ja('sans', true) },
  { file: 'ヒラギノ明朝 ProN.ttc', name: 'Hiragino Mincho ProN W3', postscriptName: 'HiraMinProN-W3', ...ja('serif') },
  { file: 'ヒラギノ明朝 ProN.ttc', name: 'Hiragino Mincho ProN W6', postscriptName: 'HiraMinProN-W6', ...ja('serif', true) },
  { file: 'AppleSDGothicNeo.ttc', name: 'Apple SD Gothic Neo', postscriptName: 'AppleSDGothicNeo-Regular', ...ko() },
  { file: 'AppleSDGothicNeo.ttc', name: 'Apple SD Gothic Neo Bold', postscriptName: 'AppleSDGothicNeo-Bold', ...ko('sans', true) },
  { file: 'AppleMyungjo.ttf', name: 'AppleMyungjo', ...ko('serif') },
  { file: 'AppleGothic.ttf', name: 'AppleGothic', ...ko() },
  { file: 'Thonburi.ttc', name: 'Thonburi', postscriptName: 'Thonburi', scripts: THAI },
  { file: 'Thonburi.ttc', name: 'Thonburi Bold', postscriptName: 'Thonburi-Bold', scripts: THAI, bold: true },
  { file: 'Ayuthaya.ttf', name: 'Ayuthaya', scripts: THAI, family: 'serif' },
  { file: 'Kohinoor.ttc', name: 'Kohinoor Devanagari', postscriptName: 'KohinoorDevanagari-Regular', scripts: DEVANAGARI },
  { file: 'Kohinoor.ttc', name: 'Kohinoor Devanagari Bold', postscriptName: 'KohinoorDevanagari-Bold', scripts: DEVANAGARI, bold: true },
  { file: 'DevanagariMT.ttc', name: 'Devanagari MT', postscriptName: 'DevanagariMT', scripts: DEVANAGARI, family: 'serif' },
  { file: 'Arial Unicode.ttf', name: 'Arial Unicode MS', scripts: ['cjk', 'kana', 'hangul', 'thai', 'devanagari'] }
]

/** Collections on Windows list their main face first, so no PostScript names are needed. */
const WINDOWS_FONTS: KnownFont[] = [
  { file: 'msyh.ttc', name: 'Microsoft YaHei', ...zh('zh-Hans') },
  { file: 'msyhbd.ttc', name: 'Microsoft YaHei Bold', ...zh('zh-Hans', 'sans', true) },
  { file: 'Deng.ttf', name: 'DengXian', ...zh('zh-Hans') },
  { file: 'Dengb.ttf', name: 'DengXian Bold', ...zh('zh-Hans', 'sans', true) },
  { file: 'simhei.ttf', name: 'SimHei', ...zh('zh-Hans') },
  { file: 'simsun.ttc', name: 'SimSun', ...zh('zh-Hans', 'serif') },
  { file: 'msjh.ttc', name: 'Microsoft JhengHei', ...zh('zh-Hant') },
  { file: 'msjhbd.ttc', name: 'Microsoft JhengHei Bold', ...zh('zh-Hant', 'sans', true) },
  { file: 'mingliu.ttc', name: 'MingLiU', ...zh('zh-Hant', 'serif') },
  { file: 'YuGothR.ttc', name: 'Yu Gothic', ...ja() },
  { file: 'YuGothB.ttc', name: 'Yu Gothic Bold', ...ja('sans', true) },
  { file: 'meiryo.ttc', name: 'Meiryo', ...ja() },
  { file: 'meiryob.ttc', name: 'Meiryo Bold', ...ja('sans', true) },
  { file: 'msgothic.ttc', name: 'MS Gothic', ...ja() },
  { file: 'yumin.ttf', name: 'Yu Mincho', ...ja('serif') },
  { file: 'yumindb.ttf', name: 'Yu Mincho Demibold', ...ja('serif', true) },
  { file: 'msmincho.ttc', name: 'MS Mincho', ...ja('serif') },
  { file: 'malgun.ttf', name: 'Malgun Gothic', ...ko() },
  { file: 'malgunbd.ttf', name: 'Malgun Gothic Bold', ...ko('sans', true) },
  { file: 'gulim.ttc', name: 'Gulim', ...ko() },
  { file: 'batang.ttc', name: 'Batang', ...ko('serif') },
  { file: 'LeelawUI.ttf', name: 'Leelawadee UI', scripts: THAI },
  { file: 'LeelaUIb.ttf', name: 'Leelawadee UI Bold', scripts: THAI, bold: true },
  { file: 'tahoma.ttf', name: 'Tahoma', scripts: THAI },
  { file: 'tahomabd.ttf', name: 'Tahoma Bold', scripts: THAI, bold: true },
  { file: 'Nirmala.ttc', name: 'Nirmala UI', scripts: DEVANAGARI },
  { file: 'Nirmala.ttf', name: 'Nirmala UI', scripts: DEVANAGARI },
  { file: 'NirmalaB.ttf', name: 'Nirmala UI Bold', scripts: DEVANAGARI, bold: true },
  { file: 'mangal.ttf', name: 'Mangal', scripts: DEVANAGARI }
]

const notoCjk = (file: string, family: Family, bold: boolean, prefix: string, style: string): KnownFont[] =>
  (
    [
      ['sc', 'zh-Hans'],
      ['tc', 'zh-Hant'],
      ['jp', 'ja'],
      ['kr', 'ko']
    ] as const
  ).map(([region, language]) => ({
    file,
    name: `${prefix} ${region.toUpperCase()} ${style}`,
    postscriptName: `${prefix.replace(/ /g, '')}${region}-${style}`,
    scripts: language === 'ko' ? KOREAN : CJK,
    language,
    family,
    bold
  }))

/** Linux without fontconfig: well-known file names below the font folders. */
const LINUX_FONTS: KnownFont[] = [
  ...notoCjk('NotoSansCJK-Regular.ttc', 'sans', false, 'Noto Sans CJK', 'Regular'),
  ...notoCjk('NotoSansCJK-Bold.ttc', 'sans', true, 'Noto Sans CJK', 'Bold'),
  ...notoCjk('NotoSerifCJK-Regular.ttc', 'serif', false, 'Noto Serif CJK', 'Regular'),
  ...notoCjk('NotoSerifCJK-Bold.ttc', 'serif', true, 'Noto Serif CJK', 'Bold'),
  { file: 'NotoSansCJKsc-Regular.otf', name: 'Noto Sans CJK SC', ...zh('zh-Hans') },
  { file: 'NotoSansCJKjp-Regular.otf', name: 'Noto Sans CJK JP', ...ja() },
  { file: 'NotoSansCJKkr-Regular.otf', name: 'Noto Sans CJK KR', ...ko() },
  { file: 'wqy-zenhei.ttc', name: 'WenQuanYi Zen Hei', ...zh('zh-Hans') },
  { file: 'wqy-microhei.ttc', name: 'WenQuanYi Micro Hei', ...zh('zh-Hans') },
  { file: 'DroidSansFallbackFull.ttf', name: 'Droid Sans Fallback', ...zh('zh-Hans') },
  { file: 'ipag.ttf', name: 'IPAGothic', ...ja() },
  { file: 'ipam.ttf', name: 'IPAMincho', ...ja('serif') },
  { file: 'NanumGothic.ttf', name: 'NanumGothic', ...ko() },
  { file: 'NanumGothicBold.ttf', name: 'NanumGothic Bold', ...ko('sans', true) },
  { file: 'NanumMyeongjo.ttf', name: 'NanumMyeongjo', ...ko('serif') },
  { file: 'NotoSansThai-Regular.ttf', name: 'Noto Sans Thai', scripts: THAI },
  { file: 'NotoSansThai-Bold.ttf', name: 'Noto Sans Thai Bold', scripts: THAI, bold: true },
  { file: 'NotoSerifThai-Regular.ttf', name: 'Noto Serif Thai', scripts: THAI, family: 'serif' },
  { file: 'Garuda.ttf', name: 'Garuda', scripts: THAI },
  { file: 'NotoSansDevanagari-Regular.ttf', name: 'Noto Sans Devanagari', scripts: DEVANAGARI },
  { file: 'NotoSansDevanagari-Bold.ttf', name: 'Noto Sans Devanagari Bold', scripts: DEVANAGARI, bold: true },
  { file: 'NotoSerifDevanagari-Regular.ttf', name: 'Noto Serif Devanagari', scripts: DEVANAGARI, family: 'serif' },
  { file: 'Lohit-Devanagari.ttf', name: 'Lohit Devanagari', scripts: DEVANAGARI }
]

export function fontDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  switch (platform) {
    case 'darwin':
      return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(home, 'Library/Fonts')]
    case 'win32': {
      const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows'
      const dirs = [join(windir, 'Fonts')]
      if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
      return dirs
    }
    default: {
      const dataHome = env.XDG_DATA_HOME || join(home, '.local/share')
      return ['/usr/share/fonts', '/usr/local/share/fonts', join(dataHome, 'fonts'), join(home, '.fonts')]
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function toCandidate(path: string, f: KnownFont): FontCandidate {
  const c: FontCandidate = { path, name: f.name, scripts: f.scripts, family: f.family ?? 'sans', bold: !!f.bold }
  if (f.postscriptName) c.postscriptName = f.postscriptName
  if (f.language) c.language = f.language
  return c
}

/** Known fonts present directly in one of `dirs` (macOS, Windows). */
function findKnownFonts(dirs: string[], known: KnownFont[]): FontCandidate[] {
  const out: FontCandidate[] = []
  for (const f of known) {
    for (const dir of dirs) {
      const path = join(dir, f.file)
      if (existsSync(path) && isFile(path)) {
        out.push(toCandidate(path, f))
        break
      }
    }
  }
  return out
}

/** Font files below `dirs` (recursively, a few levels deep), by lower-cased base name. */
function scanFontFiles(dirs: string[], maxDepth = 4): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(path, depth + 1)
      } else if (FONT_EXTENSIONS.has(extname(e.name).toLowerCase()) && !found.has(e.name.toLowerCase())) {
        found.set(e.name.toLowerCase(), path)
      }
    }
  }
  for (const dir of dirs) walk(dir, 0)
  return found
}

// ---------------------------------------------------------------------------------------
// fontconfig (Linux)

/** fontconfig language queries and what a match means. */
const FC_LANGS: { lang: string; scripts: Script[]; language?: Language }[] = [
  { lang: 'zh-cn', scripts: ['cjk'], language: 'zh-Hans' },
  { lang: 'zh-tw', scripts: ['cjk'], language: 'zh-Hant' },
  { lang: 'ja', scripts: CJK, language: 'ja' },
  { lang: 'ko', scripts: ['hangul'], language: 'ko' },
  { lang: 'th', scripts: THAI },
  { lang: 'hi', scripts: DEVANAGARI }
]

export const FC_FORMAT = '%{file}\t%{index}\t%{postscriptname}\t%{family[0]}\t%{style[0]}\t%{weight}\t%{spacing}\n'

/** Families known to be good, preferred over whatever else fontconfig reports. */
const PREFERRED_FAMILIES = [/^Noto Sans CJK/, /^Noto Serif CJK/, /^Source Han/, /^Noto Sans (Thai|Devanagari)/, /^WenQuanYi/, /^Droid Sans Fallback/]

/** The language a CJK family is designed for, from its name (Noto CJK etc. support every language). */
function languageFromFamily(family: string): Language | undefined {
  if (/\b(KR|K|Korean)\b|Nanum|^Un |Baekmuk|Gulim|Batang|Dotum/i.test(family)) return 'ko'
  if (/\b(JP|JA|Japanese)\b|Gothic|Mincho|^IPA|Takao|^VL /i.test(family)) return 'ja'
  if (/\b(TC|HK|Traditional)\b|Ming/i.test(family)) return 'zh-Hant'
  if (/\b(SC|Simplified|CN)\b|WenQuanYi|Droid Sans Fallback|^AR PL/i.test(family)) return 'zh-Hans'
  return undefined
}

function familyClass(family: string, spacing: number): Family {
  if (spacing === 100 || /\bMono\b/i.test(family)) return 'mono'
  if (/Serif|Mincho|Ming|Song|Myeongjo|Batang|Kai/i.test(family)) return 'serif'
  return 'sans'
}

/** Parse `fc-list -f FC_FORMAT :lang=…` output into candidates (regular and bold, upright faces). */
export function parseFcList(output: string, query: (typeof FC_LANGS)[number]): FontCandidate[] {
  const out: FontCandidate[] = []
  for (const line of output.split('\n')) {
    const [path, , postscriptName, family, style = '', weightText, spacingText] = line.split('\t')
    if (!path || !family || !FONT_EXTENSIONS.has(extname(path).toLowerCase())) continue
    if (/italic|oblique/i.test(style)) continue
    const weight = Number(weightText)
    if (Number.isFinite(weight) && weight > 0 && (weight < 75 || (weight > 105 && weight < 180) || weight > 210)) continue
    const c: FontCandidate = {
      path,
      name: [family, style].filter((s) => s && s !== 'Regular').join(' '),
      scripts: query.scripts,
      family: familyClass(family, Number(spacingText)),
      bold: weight >= 180
    }
    if (postscriptName) c.postscriptName = postscriptName
    const language = languageFromFamily(family) ?? query.language
    if (language) c.language = language
    out.push(c)
  }
  return out
}

function runFcList(lang: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('fc-list', ['-f', FC_FORMAT, `:lang=${lang}`], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout))
    )
  })
}

/** fontconfig's fonts per language, merged per face (null if fc-list is unavailable). */
async function fontconfigFonts(): Promise<FontCandidate[] | null> {
  const outputs = await Promise.all(FC_LANGS.map((q) => runFcList(q.lang)))
  if (outputs.every((o) => o === null)) return null
  const byFace = new Map<string, FontCandidate>()
  outputs.forEach((output, i) => {
    if (!output) return
    for (const c of parseFcList(output, FC_LANGS[i])) {
      const key = `${c.path}\0${c.postscriptName ?? ''}`
      const existing = byFace.get(key)
      if (existing) existing.scripts = [...new Set([...existing.scripts, ...c.scripts])]
      else byFace.set(key, c)
    }
  })
  const rank = (c: FontCandidate) => {
    const i = PREFERRED_FAMILIES.findIndex((re) => re.test(c.name))
    return i < 0 ? PREFERRED_FAMILIES.length : i
  }
  // Stable sort: preferred families first, then fontconfig's order.
  const sorted = [...byFace.values()].map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
  // A handful per kind is plenty (the renderer loads at most a few).
  const perKind = new Map<string, number>()
  return sorted
    .map(({ c }) => c)
    .filter((c) => {
      const kind = `${c.scripts.join()}|${c.language}|${c.family}|${c.bold}`
      const n = perKind.get(kind) ?? 0
      perKind.set(kind, n + 1)
      return n < 3
    })
}

// ---------------------------------------------------------------------------------------

/** Test hook (OPE_E2E=1 only): JSON list of FontCandidate replacing the system fonts. */
function e2eFonts(env: NodeJS.ProcessEnv): FontCandidate[] | null {
  if (env.OPE_E2E !== '1' || !env.OPE_E2E_SYSTEM_FONTS) return null
  try {
    const list = JSON.parse(env.OPE_E2E_SYSTEM_FONTS) as FontCandidate[]
    return Array.isArray(list) ? list.filter((c) => typeof c?.path === 'string' && isFile(c.path)) : []
  } catch {
    return []
  }
}

/** Fallback fonts available on this system, in order of preference. */
export async function discoverSystemFonts(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<FontCandidate[]> {
  const test = e2eFonts(env)
  if (test) return test
  const dirs = fontDirectories(platform, env, home)
  if (platform === 'darwin') return findKnownFonts(dirs, MAC_FONTS)
  if (platform === 'win32') return findKnownFonts(dirs, WINDOWS_FONTS)
  const fc = await fontconfigFonts()
  if (fc && fc.length) return fc
  const files = scanFontFiles(dirs)
  return LINUX_FONTS.flatMap((f) => {
    const path = files.get(f.file.toLowerCase())
    return path ? [toCandidate(path, f)] : []
  })
}

/** sfnt (TrueType/OpenType) or collection signature. */
export function isFontData(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  return tag === 'ttcf' || tag === 'OTTO' || tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
}

/** The discovered fonts with ids; bytes are only served for fonts in this catalog. */
export class SystemFontCatalog {
  private entries: Promise<Map<string, FontCandidate>> | null = null

  constructor(private readonly discover: () => Promise<FontCandidate[]> = () => discoverSystemFonts()) {}

  private load(): Promise<Map<string, FontCandidate>> {
    this.entries ??= this.discover()
      .catch(() => [] as FontCandidate[])
      .then((list) => new Map(list.map((c, i) => [`sys${i}`, c])))
    return this.entries
  }

  async list(): Promise<SystemFontInfo[]> {
    const entries = await this.load()
    return [...entries].map(([id, { path, ...info }]) => ({ id, ...info, name: info.name || basename(path) }))
  }

  async read(id: unknown): Promise<Uint8Array> {
    if (typeof id !== 'string') throw new TypeError('Invalid font id')
    const entry = (await this.load()).get(id)
    if (!entry) throw new Error('Unknown system font')
    const info = statSync(entry.path)
    if (!info.isFile() || info.size > MAX_FONT_BYTES) throw new Error(`Font “${basename(entry.path)}” cannot be used`)
    const data = await readFile(entry.path)
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (!isFontData(bytes)) throw new Error(`“${basename(entry.path)}” is not a font file`)
    return bytes
  }
}

export const systemFonts = new SystemFontCatalog()
