/**
 * Bundled Unicode fonts (resources/fonts, SIL OFL). They are registered with the core engine
 * (for measuring/embedding text that the standard PDF fonts cannot encode) and exposed to the
 * overlay via @font-face (see fonts.css) under the family names in UNICODE_CSS_FAMILIES.
 * Inter is registered as a named family: existing PDF text set in Inter (common in invoices
 * saved from web pages) keeps Inter when its embedded subset lacks retyped characters.
 */
import { registerFonts, registerNamedFonts, type FontAssets, type FontStyleKey } from '@core'
import sansRegular from '../../../../resources/fonts/NotoSans-Regular.ttf?url'
import sansBold from '../../../../resources/fonts/NotoSans-Bold.ttf?url'
import sansItalic from '../../../../resources/fonts/NotoSans-Italic.ttf?url'
import sansBoldItalic from '../../../../resources/fonts/NotoSans-BoldItalic.ttf?url'
import serifRegular from '../../../../resources/fonts/NotoSerif-Regular.ttf?url'
import serifBold from '../../../../resources/fonts/NotoSerif-Bold.ttf?url'
import serifItalic from '../../../../resources/fonts/NotoSerif-Italic.ttf?url'
import serifBoldItalic from '../../../../resources/fonts/NotoSerif-BoldItalic.ttf?url'
import monoRegular from '../../../../resources/fonts/NotoSansMono-Regular.ttf?url'
import monoBold from '../../../../resources/fonts/NotoSansMono-Bold.ttf?url'
import interRegular from '../../../../resources/fonts/Inter-Regular.ttf?url'
import interMedium from '../../../../resources/fonts/Inter-Medium.ttf?url'
import interSemiBold from '../../../../resources/fonts/Inter-SemiBold.ttf?url'
import interBold from '../../../../resources/fonts/Inter-Bold.ttf?url'

export const FONT_URLS: Record<FontStyleKey, string> = {
  'sans-regular': sansRegular,
  'sans-bold': sansBold,
  'sans-italic': sansItalic,
  'sans-bolditalic': sansBoldItalic,
  'serif-regular': serifRegular,
  'serif-bold': serifBold,
  'serif-italic': serifItalic,
  'serif-bolditalic': serifBoldItalic,
  // Noto Sans Mono has no italic; the upright faces are used for italic text.
  'mono-regular': monoRegular,
  'mono-bold': monoBold,
  'mono-italic': monoRegular,
  'mono-bolditalic': monoBold
}

/** Faces of named families (see registerNamedFonts), by family and CSS weight. */
export const NAMED_FONT_URLS: { family: string; weight: number; url: string }[] = [
  { family: 'Inter', weight: 400, url: interRegular },
  { family: 'Inter', weight: 500, url: interMedium },
  { family: 'Inter', weight: 600, url: interSemiBold },
  { family: 'Inter', weight: 700, url: interBold }
]

/** CSS font-family names declared in fonts.css. */
export const UNICODE_CSS_FAMILIES = {
  sans: 'OPE Noto Sans',
  serif: 'OPE Noto Serif',
  mono: 'OPE Noto Sans Mono'
} as const

/** CSS font-family name (fonts.css) of a named family. */
export const namedCssFamily = (family: string): string => `OPE ${family}`

let loading: Promise<void> | null = null

/** Fetch the font files and register them with the engine. Safe to call more than once. */
export function loadAndRegisterFonts(): Promise<void> {
  loading ??= (async () => {
    const load = async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to load font ${url}: ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    }
    const [entries, named] = await Promise.all([
      Promise.all((Object.entries(FONT_URLS) as [FontStyleKey, string][]).map(async ([key, url]) => [key, await load(url)] as const)),
      Promise.all(NAMED_FONT_URLS.map(async ({ family, weight, url }) => ({ family, weight, bytes: await load(url) })))
    ])
    const assets: FontAssets = Object.fromEntries(entries)
    registerFonts(assets)
    registerNamedFonts(named)
  })()
  loading.catch(() => (loading = null))
  return loading
}
