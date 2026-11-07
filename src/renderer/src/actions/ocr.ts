/**
 * Text recognition (OCR): recognizing pages, offering it for scanned documents, and turning a
 * recognized line into editable text. Results go into the document (EditorDocument.ocr) as one
 * undoable step per run.
 */
import {
  OCR_LANGUAGES,
  getContentItems,
  hasText,
  looksScanned,
  makeOcrLineEditable,
  ocrLineText,
  ocrResultFromRecognition,
  setOcrResults,
  type OcrPageResult
} from '@core'
import { getOcrEngine, isAbortError, type OcrProgress } from '@renderer/ocr/engine'
import { renderPageForOcr, sampleLineColors } from '@renderer/ocr/render'
import { openDialog } from '@renderer/state/dialogs'
import { selectOcrLine } from '@renderer/state/ocr'
import { hasLiveSignatures } from '@renderer/state/signing'
import { useEditing } from '@renderer/editing/editingState'
import { editor, notifyError, notifyInfo } from './util'

export type OcrScope = 'current' | 'all' | 'selected'

export interface OcrRunOptions {
  pageIds: string[]
  languages: string[]
  /** Leave out pages that already have text of their own (not counting recognized text). */
  skipPagesWithText?: boolean
}

export interface OcrRunProgress {
  /** 0-based position in the run and number of pages in it. */
  index: number
  total: number
  /** 1-based number of the page in the document. */
  pageNumber: number
  stage: OcrProgress['stage']
  /** 0..1 for the current page. */
  progress: number
}

export interface OcrRunResult {
  /** Pages that got a result (possibly without any words). */
  recognized: number
  /** Pages left out (blank pages, pages with text when skipping them). */
  skipped: number
  words: number
  cancelled: boolean
}

const LANGUAGE_KEY = 'ope.ocr.languages'

/** The languages chosen last time (default: English, plus Lithuanian for Lithuanian systems). */
export function preferredOcrLanguages(): string[] {
  const known = new Set<string>(OCR_LANGUAGES.map((l) => l.code))
  try {
    const stored = JSON.parse(localStorage.getItem(LANGUAGE_KEY) ?? 'null') as unknown
    if (Array.isArray(stored)) {
      const langs = stored.filter((l): l is string => typeof l === 'string' && known.has(l))
      if (langs.length) return langs
    }
  } catch {
    /* unavailable or invalid */
  }
  const lt = typeof navigator !== 'undefined' && /^lt\b/i.test(navigator.language ?? '')
  return lt ? ['lit', 'eng'] : ['eng']
}

export function rememberOcrLanguages(languages: string[]): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, JSON.stringify(languages))
  } catch {
    /* unavailable */
  }
}

/** Page ids the scope refers to, in document order. */
export function pagesForScope(scope: OcrScope): string[] {
  const { doc, currentPageId, selectedPageIds } = editor()
  if (!doc) return []
  if (scope === 'all') return doc.pages.map((p) => p.id)
  if (scope === 'selected') {
    const selected = new Set(selectedPageIds)
    return doc.pages.filter((p) => selected.has(p.id)).map((p) => p.id)
  }
  const current = currentPageId ?? doc.pages[0]?.id
  return current ? [current] : []
}

/**
 * Recognize the text of pages and store the results (one undo step). Cancelling via `signal`
 * keeps the pages finished so far. Throws on recognition errors (after storing finished pages).
 */
export async function recognizePages(
  options: OcrRunOptions,
  onProgress?: (p: OcrRunProgress) => void,
  signal?: AbortSignal
): Promise<OcrRunResult> {
  const { doc, docSession } = editor()
  const outcome: OcrRunResult = { recognized: 0, skipped: 0, words: 0, cancelled: false }
  if (!doc || !options.languages.length) return outcome
  const wanted = new Set(options.pageIds)
  const pages = doc.pages.filter((p) => wanted.has(p.id))
  const engine = getOcrEngine()
  const results: Record<string, OcrPageResult> = {}
  let failure: unknown = null
  try {
    for (let index = 0; index < pages.length; index++) {
      if (signal?.aborted) {
        outcome.cancelled = true
        break
      }
      const page = pages[index]
      const pageNumber = doc.pages.indexOf(page) + 1
      const report = (stage: OcrProgress['stage'], progress: number) =>
        onProgress?.({ index, total: pages.length, pageNumber, stage, progress })
      report('loading', 0)
      if (options.skipPagesWithText && hasText(await getContentItems(doc, page.id))) {
        outcome.skipped++
        continue
      }
      const image = await renderPageForOcr(doc, page)
      if (!image) {
        outcome.skipped++
        continue
      }
      try {
        const lines = await engine.recognize(image.canvas, options.languages, {
          signal,
          onProgress: (p) => report(p.stage, p.progress)
        })
        const result = ocrResultFromRecognition(page, image.scale, options.languages, sampleLineColors(image.canvas, lines))
        results[page.id] = result
        outcome.recognized++
        outcome.words += result.lines.reduce((n, l) => n + l.words.length, 0)
        report('recognizing', 1)
      } finally {
        image.canvas.width = 0
        image.canvas.height = 0
      }
    }
  } catch (err) {
    if (isAbortError(err)) outcome.cancelled = true
    else failure = err
  }
  if (outcome.recognized && editor().docSession === docSession) {
    editor().apply((d) => setOcrResults(d, results))
  }
  if (failure) throw failure
  return outcome
}

export async function openOcrDialog(options: { scope?: OcrScope; skipPagesWithText?: boolean } = {}): Promise<void> {
  if (!editor().doc) return
  await openDialog({ kind: 'ocr', scope: options.scope, skipPagesWithText: options.skipPagesWithText })
}

/** Summary shown after a run. `signed`: the open file is digitally signed (saving removes the signatures). */
export function ocrSummary(result: OcrRunResult, signed = false): string {
  const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`
  if (result.cancelled) {
    return result.recognized
      ? `Text recognition cancelled. Text was recognized on ${pages(result.recognized)}.`
      : 'Text recognition cancelled.'
  }
  if (!result.recognized) {
    return result.skipped ? 'No pages to recognize: the pages already contain text or are blank.' : 'No pages to recognize.'
  }
  if (!result.words) return `No text was found on ${pages(result.recognized)}.`
  return signed
    ? `Recognized text on ${pages(result.recognized)}. It is searchable now; use Save As to keep the signed original.`
    : `Recognized text on ${pages(result.recognized)}. It is searchable now and is saved with the document.`
}

// ---------------------------------------------------------------------------------------------
// Scanned documents

/** Stop looking after this many pages with text when no scanned page was found yet. */
const DETECT_TEXT_PAGES = 10
const DETECT_MAX_PAGES = 300

/** Ids of pages that look scanned (no text, one large image) and have no recognized text yet. */
export async function findScannedPages(): Promise<string[]> {
  const { doc } = editor()
  if (!doc) return []
  const scanned: string[] = []
  let withText = 0
  for (const page of doc.pages.slice(0, DETECT_MAX_PAGES)) {
    if (page.source.kind !== 'source' || doc.ocr?.[page.id]) continue
    let items
    try {
      items = await getContentItems(doc, page.id)
    } catch {
      continue
    }
    if (looksScanned(items, page)) scanned.push(page.id)
    else if (++withText >= DETECT_TEXT_PAGES && !scanned.length) break
    // Yield between pages so the UI stays responsive on long documents.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return scanned
}

/** After opening a document: offer text recognition when pages look scanned. */
export async function offerOcrForScannedPages(): Promise<void> {
  const { docSession } = editor()
  let scanned: string[]
  try {
    scanned = await findScannedPages()
  } catch {
    return
  }
  const s = editor()
  if (!scanned.length || s.docSession !== docSession || !s.doc) return
  const all = scanned.length === s.doc.pages.length
  // Recognizing text changes the document: saving then removes the digital signatures.
  const signedNote = hasLiveSignatures(s.doc) ? ' The file is digitally signed: use Save As afterwards to keep the signed original.' : ''
  const text = all
    ? s.doc.pages.length === 1
      ? 'This page looks scanned: it is an image without text. Recognize the text to make it searchable and editable.'
      : 'This document looks scanned: its pages are images without text. Recognize the text to make it searchable and editable.'
    : `${scanned.length} page${scanned.length === 1 ? ' looks' : 's look'} scanned (images without text). Recognize the text to make ${scanned.length === 1 ? 'it' : 'them'} searchable.`
  s.showNotice('info', text + signedNote, {
    label: 'Recognize text…',
    run: () => void openOcrDialog({ scope: 'all', skipPagesWithText: true })
  })
}

// ---------------------------------------------------------------------------------------------
// Recognized lines

/** Replace a recognized line by an editable TextObject (covering the line in the scan). */
export function makeLineEditable(pageId: string, lineId: string, options: { edit?: boolean } = {}): boolean {
  const s = editor()
  if (!s.doc) return false
  let textId: string | null = null
  try {
    s.apply((d) => {
      const made = makeOcrLineEditable(d, pageId, lineId)
      if (!made) return d
      textId = made.text.id
      return made.doc
    })
  } catch (err) {
    notifyError('Could not make the text editable', err)
    return false
  }
  if (!textId) return false
  selectOcrLine(null)
  s.setTool('select')
  editor().selectObject(textId)
  if (options.edit) useEditing.getState().startTextEdit(textId)
  return true
}

/** Copy a recognized line's text to the clipboard. */
export async function copyLineText(pageId: string, lineId: string): Promise<void> {
  const line = editor().doc?.ocr?.[pageId]?.lines.find((l) => l.id === lineId)
  if (!line) return
  try {
    await navigator.clipboard.writeText(ocrLineText(line))
    notifyInfo('Copied the recognized text.')
  } catch (err) {
    notifyError('Could not copy the text', err)
  }
}
