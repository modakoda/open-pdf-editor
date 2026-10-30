/**
 * Unicode script classification used by the font fallback chain (src/core/text.ts) and by the
 * hosts that load system fonts on demand, plus the simple CJK line-breaking rules of layoutText.
 */

/**
 * Writing systems the bundled fonts do not cover and that need a (system) fallback font.
 * 'cjk' is Han ideographs plus CJK punctuation, symbols, fullwidth forms and Bopomofo.
 */
export type FontScript = 'cjk' | 'kana' | 'hangul' | 'arabic' | 'hebrew' | 'thai' | 'devanagari'

/**
 * The same Han character is drawn differently per language (Han unification), so CJK fonts
 * declare the language they are designed for and text picks a matching font.
 */
export type HanLanguage = 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko'

const inRange = (cp: number, lo: number, hi: number) => cp >= lo && cp <= hi

/** Script needing a fallback font, or null (Latin, Greek, Cyrillic, symbols, …: bundled fonts). */
export function scriptOf(cp: number): FontScript | null {
  if (cp < 0x0590) return null
  if (cp < 0x0600) return 'hebrew'
  if (cp < 0x0700 || inRange(cp, 0x0750, 0x077f) || inRange(cp, 0x0870, 0x08ff)) return 'arabic'
  if (inRange(cp, 0x0900, 0x097f) || inRange(cp, 0xa8e0, 0xa8ff)) return 'devanagari'
  if (inRange(cp, 0x0e00, 0x0e7f)) return 'thai'
  if (inRange(cp, 0x1100, 0x11ff) || inRange(cp, 0x3130, 0x318f) || inRange(cp, 0xa960, 0xa97f)) return 'hangul'
  if (inRange(cp, 0xac00, 0xd7ff) || inRange(cp, 0xffa0, 0xffdc)) return 'hangul'
  if (inRange(cp, 0x3040, 0x30ff) || inRange(cp, 0x31f0, 0x31ff) || inRange(cp, 0xff65, 0xff9f)) return 'kana'
  if (inRange(cp, 0x2e80, 0x2fdf) || inRange(cp, 0x2ff0, 0x303f) || inRange(cp, 0x3100, 0x312f)) return 'cjk'
  if (inRange(cp, 0x31a0, 0x31bf) || inRange(cp, 0x31c0, 0x31ef) || inRange(cp, 0x3200, 0x4dbf)) return 'cjk'
  if (inRange(cp, 0x4e00, 0x9fff) || inRange(cp, 0xf900, 0xfaff) || inRange(cp, 0xfe30, 0xfe4f)) return 'cjk'
  if (inRange(cp, 0xff00, 0xffef) || inRange(cp, 0x20000, 0x3ffff)) return 'cjk'
  if (inRange(cp, 0xfb1d, 0xfb4f)) return 'hebrew'
  if (inRange(cp, 0xfb50, 0xfdff) || inRange(cp, 0xfe70, 0xfeff)) return 'arabic'
  return null
}

/**
 * Characters of right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, N'Ko, …). Drawing them
 * needs the bidirectional algorithm and Arabic shaping, which the engine does not implement yet.
 */
export function isRtlCodePoint(cp: number): boolean {
  return (
    inRange(cp, 0x0590, 0x08ff) ||
    inRange(cp, 0xfb1d, 0xfdff) ||
    inRange(cp, 0xfe70, 0xfeff) ||
    inRange(cp, 0x10800, 0x10fff) ||
    inRange(cp, 0x1e800, 0x1efff)
  )
}

/** Scripts in `text` that need a fallback font, in order of first appearance. */
export function scriptsIn(text: string): FontScript[] {
  const out: FontScript[] = []
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Language whose CJK glyph shapes suit `text`: kana means Japanese, Hangul Korean; other Han
 * text uses `preferred` (e.g. from the UI locale). Null when the text has no CJK at all.
 */
export function hanLanguageFor(text: string, preferred: HanLanguage): HanLanguage | null {
  let cjk = false
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!)
    if (s === 'kana') return 'ja'
    if (s === 'hangul') return 'ko'
    if (s === 'cjk') cjk = true
  }
  return cjk ? preferred : null
}

/** Han language for a BCP 47 locale such as "ja-JP", "zh-TW" or "en-US" (default zh-Hans). */
export function hanLanguageForLocale(locale: string | undefined): HanLanguage {
  const l = (locale ?? '').toLowerCase()
  if (l.startsWith('ja')) return 'ja'
  if (l.startsWith('ko')) return 'ko'
  if (/^zh-(hant|tw|hk|mo)/.test(l)) return 'zh-Hant'
  return 'zh-Hans'
}

// ---------------------------------------------------------------------------------------
// CJK line breaking (deliberately simple: no dictionaries, no hanging punctuation)

/** Ideographs, kana and Hangul syllables: a line may break before and after each of them. */
function isBreakableCjk(cp: number): boolean {
  const s = scriptOf(cp)
  return s === 'cjk' || s === 'kana' || s === 'hangul'
}

/** Closing punctuation, small kana and marks that must not start a line (kinsoku). */
const NO_BREAK_BEFORE = new Set(
  Array.from(
    '!%),.:;?]}¢°’”‰′″℃、。〉》」』】〕〗〙〛〜ゝゞ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ' +
      'ーㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ・゠゛゜！），．：；？］｝｡｣､･ｧｨｩｪｫｬｭｮｯｰﾞﾟ…‥'
  ).map((c) => c.codePointAt(0)!)
)

/** Opening punctuation that must not end a line. */
const NO_BREAK_AFTER = new Set(
  Array.from('([{£¥‘“〈《「『【〔〖〘〚（［｛｢￡￥＄').map((c) => c.codePointAt(0)!)
)

/**
 * Split a space-free run of text into pieces between which a line may break: around
 * ideographs, kana and Hangul, but never before closing punctuation or after opening
 * punctuation. Text without CJK characters is returned as one piece.
 */
export function splitAtCjkBreaks(word: string): string[] {
  const chars = Array.from(word)
  if (chars.length < 2) return [word]
  const pieces: string[] = []
  let current = chars[0]
  for (let i = 1; i < chars.length; i++) {
    const prev = chars[i - 1].codePointAt(0)!
    const next = chars[i].codePointAt(0)!
    const breakable =
      (isBreakableCjk(prev) || isBreakableCjk(next)) &&
      !NO_BREAK_BEFORE.has(next) &&
      !NO_BREAK_AFTER.has(prev) &&
      // Combining marks (e.g. dakuten U+3099) stay with their base character.
      !(next >= 0x0300 && next <= 0x036f) &&
      next !== 0x3099 &&
      next !== 0x309a
    if (breakable) {
      pieces.push(current)
      current = chars[i]
    } else {
      current += chars[i]
    }
  }
  pieces.push(current)
  return pieces
}
