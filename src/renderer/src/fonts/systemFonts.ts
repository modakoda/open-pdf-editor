/**
 * System fonts for text the bundled fonts cannot draw (CJK, Thai, Devanagari), loaded on demand.
 *
 * The shell lists suitable OS fonts (DesktopApi.listSystemFonts). When a document contains such
 * text, the best font for its script, CJK language, family and weight is read once, registered
 * with the engine's fallback chain (layout and export) and declared for the overlay as a
 * FontFace built from the same bytes (for collections: the face the engine uses). Components
 * that lay out text re-render when useFallbackFonts().version changes. Characters no font can
 * draw, and right-to-left text (not supported yet), are reported with a notice.
 */
import { create } from 'zustand'
import {
  collectionFaceIndex,
  extractCollectionFace,
  fallbackCssFamily,
  getPreferredHanLanguage,
  hanLanguageFor,
  hanLanguageForLocale,
  isRtlCodePoint,
  prepareText,
  registerFallbackFonts,
  scriptsIn,
  setPreferredHanLanguage,
  type EditorDocument,
  type FontFamily,
  type FontScript,
  type HanLanguage
} from '@core'
import type { SystemFontInfo } from '@shared/ipc'
import { platform } from '@renderer/platform'
import { useEditor } from '@renderer/state/store'
import { documentTexts, type StyledText } from './documentTexts'

export type TextFontStyle = { font: FontFamily; bold: boolean; italic: boolean }

/** Bumped whenever a fallback font becomes available (layouts must be recomputed). */
export const useFallbackFonts = create<{ version: number }>(() => ({ version: 0 }))

/** Scripts system fonts are loaded for (right-to-left scripts are not supported yet). */
const LOADABLE: FontScript[] = ['cjk', 'kana', 'hangul', 'thai', 'devanagari']
const MAX_LOADS_PER_TEXT = 6

let catalog: Promise<SystemFontInfo[]> | null = null
const loads = new Map<string, Promise<boolean>>()
/** Ids of fonts registered with the engine. */
const registered = new Set<string>()
const pending = new Set<Promise<unknown>>()
const ensured = new Set<string>()
const notified = new Set<string>()

function systemFontCatalog(): Promise<SystemFontInfo[]> {
  catalog ??= Promise.resolve()
    .then(() => platform.listSystemFonts?.() ?? [])
    .catch((err) => {
      console.warn('Could not list system fonts', err)
      return [] as SystemFontInfo[]
    })
  return catalog
}

/** Candidates for one script, best first (same preferences as the engine's chain). */
export function rankSystemFonts(
  fonts: SystemFontInfo[],
  script: FontScript,
  language: HanLanguage | null,
  style: TextFontStyle
): SystemFontInfo[] {
  const family = style.font === 'mono' ? ['mono', 'sans'] : [style.font]
  const score = (f: SystemFontInfo, i: number) =>
    (language && script !== 'thai' && script !== 'devanagari' && f.language !== language ? 8 : 0) +
    (family.includes(f.family) ? 0 : 4) +
    (f.bold === style.bold ? 0 : 2) +
    i / (fonts.length + 1)
  return fonts
    .map((f, i) => ({ f, s: score(f, i) }))
    .filter(({ f }) => f.scripts.includes(script))
    .sort((a, b) => a.s - b.s)
    .map(({ f }) => f)
}

async function declareForCss(id: string, bytes: Uint8Array, postscriptName?: string): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return
  try {
    const face = extractCollectionFace(bytes, collectionFaceIndex(bytes, postscriptName))
    // A weight range: bold text uses this face as is (like the export), without fake bold.
    const fontFace = new FontFace(fallbackCssFamily(id), face as BufferSource, { weight: '100 900' })
    await fontFace.load()
    document.fonts.add(fontFace)
  } catch (err) {
    console.warn(`Could not declare font ${id} for display`, err)
  }
}

function loadFont(info: SystemFontInfo): Promise<boolean> {
  let p = loads.get(info.id)
  if (!p) {
    p = (async () => {
      const read = platform.readSystemFont
      if (!read) return false
      const bytes = await read(info.id)
      registerFallbackFonts([
        {
          id: info.id,
          bytes,
          postscriptName: info.postscriptName,
          family: info.family,
          bold: info.bold,
          language: info.language
        }
      ])
      await declareForCss(info.id, bytes, info.postscriptName)
      registered.add(info.id)
      useFallbackFonts.setState((s) => ({ version: s.version + 1 }))
      return true
    })().catch((err) => {
      console.warn(`Could not load system font ${info.name}`, err)
      return false
    })
    loads.set(info.id, p)
  }
  return p
}

/** Characters of `text` that will be drawn as "?" with the fonts registered now. */
function missingNow(text: string, style: TextFontStyle): { missing: string[]; rtl: boolean } {
  try {
    const p = prepareText(text, style)
    return { missing: p.missing, rtl: p.rtl }
  } catch {
    return { missing: [], rtl: false }
  }
}

/**
 * Load the system fonts `text` needs in this style: the best font for each script, then more
 * candidates while characters are still missing. Resolves when done (never rejects).
 */
export async function ensureFontsForText(text: string, style: TextFontStyle): Promise<void> {
  const scripts = scriptsIn(text).filter((s) => LOADABLE.includes(s))
  if (!scripts.length) return
  const fonts = await systemFontCatalog()
  if (!fonts.length) return
  const language = hanLanguageFor(text, getPreferredHanLanguage())
  for (const script of scripts) {
    const best = rankSystemFonts(fonts, script, language, style)[0]
    if (best) await loadFont(best)
  }
  // One font must contain every character (e.g. Thai and Devanagari in one text): try more
  // candidates, including ones another text is loading right now.
  const tried = new Set<string>()
  for (let i = 0; i < MAX_LOADS_PER_TEXT; i++) {
    const missing = missingNow(text, style).missing.filter((ch) => !isRtlCodePoint(ch.codePointAt(0)!))
    if (!missing.length) return
    const next = scriptsIn(missing.join(''))
      .filter((s) => LOADABLE.includes(s))
      .flatMap((s) => rankSystemFonts(fonts, s, language, style))
      .find((f) => !tried.has(f.id) && !registered.has(f.id))
    if (!next) return
    tried.add(next.id)
    await loadFont(next)
  }
}

/** Notice text for characters that cannot be drawn, or null. */
export function unsupportedTextMessage(missing: string[], rtl: boolean): string | null {
  const other = missing.filter((ch) => !isRtlCodePoint(ch.codePointAt(0)!))
  const parts: string[] = []
  if (rtl) parts.push('Right-to-left text (Arabic, Hebrew) is not supported yet: it is shown and saved as “?”.')
  if (other.length) {
    // Combining marks (e.g. Devanagari vowel signs) are not listed on their own.
    const shown = other.filter((ch) => !/^\p{M}$/u.test(ch))
    const list = (shown.length ? shown : other).slice(0, 8).map((ch) => `“${ch}”`).join(' ')
    parts.push(
      `No installed font contains ${list}${other.length > 8 ? ' …' : ''}: ${other.length === 1 ? 'it is' : 'these are'} shown and saved as “?”. ` +
        'Install a font for this language and restart Open PDF Editor.'
    )
  }
  return parts.length ? parts.join(' ') : null
}

function reportUnsupported(text: string, style: TextFontStyle): void {
  const { missing, rtl } = missingNow(text, style)
  const fresh = missing.filter((ch) => !notified.has(ch))
  if (!fresh.length) return
  for (const ch of missing) notified.add(ch)
  const message = unsupportedTextMessage(missing, rtl)
  if (message) useEditor.getState().showNotice('error', message)
}

function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p)
  void p.finally(() => pending.delete(p))
  return p
}

/** Make sure the fonts for every text in the document are loading; report unsupported text. */
export function scanDocument(doc: EditorDocument | null): void {
  if (!doc) return
  for (const { text, style } of documentTexts(doc)) {
    const key = `${style.font}|${style.bold}|${style.italic}|${text}`
    if (ensured.has(key)) continue
    if (ensured.size > 5000) ensured.clear()
    ensured.add(key)
    void track(ensureFontsForText(text, style).then(() => reportUnsupported(text, style)))
  }
}

/** Resolves once the fonts for every text of `doc` are loaded (call before exporting). */
export async function fontsReadyFor(doc: EditorDocument): Promise<void> {
  scanDocument(doc)
  while (pending.size) await Promise.all([...pending])
}

/** Characters of the document's texts that are saved as "?" (for the save notice). */
export function unsupportedCharactersIn(doc: EditorDocument): { missing: string[]; rtl: boolean } {
  const missing = new Set<string>()
  let rtl = false
  for (const { text, style } of documentTexts(doc)) {
    const r = missingNow(text, style)
    r.missing.forEach((ch) => missing.add(ch))
    rtl ||= r.rtl
  }
  return { missing: [...missing], rtl }
}

let installed = false

/** Start loading fallback fonts for the documents being edited. Call once at startup. */
export function installSystemFontLoader(): void {
  if (installed) return
  installed = true
  if (typeof navigator !== 'undefined') setPreferredHanLanguage(hanLanguageForLocale(navigator.language))
  scanDocument(useEditor.getState().doc)
  useEditor.subscribe((s, prev) => {
    if (s.doc !== prev.doc) scanDocument(s.doc)
  })
}

/** Forget loaded fonts and notices (tests). */
export function resetSystemFontsForTests(): void {
  catalog = null
  loads.clear()
  registered.clear()
  pending.clear()
  ensured.clear()
  notified.clear()
  useFallbackFonts.setState({ version: 0 })
}

export type { StyledText }
