/**
 * Bundled Unicode fonts (resources/fonts, SIL OFL). They are registered with the core engine
 * (for measuring/embedding text that the standard PDF fonts cannot encode) and exposed to the
 * overlay via @font-face (see fonts.css) under the family names in UNICODE_CSS_FAMILIES.
 */
import { registerFonts, type FontAssets, type FontStyleKey } from '@core'
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

/** CSS font-family names declared in fonts.css. */
export const UNICODE_CSS_FAMILIES = {
  sans: 'OPE Noto Sans',
  serif: 'OPE Noto Serif',
  mono: 'OPE Noto Sans Mono'
} as const

let loading: Promise<void> | null = null

/** Fetch the font files and register them with the engine. Safe to call more than once. */
export function loadAndRegisterFonts(): Promise<void> {
  loading ??= (async () => {
    const entries = await Promise.all(
      (Object.entries(FONT_URLS) as [FontStyleKey, string][]).map(async ([key, url]) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to load font ${url}: ${res.status}`)
        return [key, new Uint8Array(await res.arrayBuffer())] as const
      })
    )
    const assets: FontAssets = Object.fromEntries(entries)
    registerFonts(assets)
  })()
  loading.catch(() => (loading = null))
  return loading
}
