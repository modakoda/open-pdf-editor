/**
 * Text recognition engine. The default engine runs tesseract.js in a Web Worker, fully offline:
 * the worker script, the WebAssembly core and the language data are bundled with the app
 * (scripts/copy-ocr-assets.mjs → public/ocr) and loaded from the app's own origin. The worker is
 * started from its URL (not a blob:), so it may compile WebAssembly under the page's CSP.
 * Tests replace the engine with setOcrEngine().
 */
import type { RecognizedLine } from '@core'

export interface OcrProgress {
  /** 'loading' while the engine and language data load, then 'recognizing'. */
  stage: 'loading' | 'recognizing'
  /** 0..1 within the stage. */
  progress: number
}

export interface RecognizeOptions {
  onProgress?: (p: OcrProgress) => void
  /** Aborting rejects with an AbortError and stops the work in progress. */
  signal?: AbortSignal
}

export interface OcrEngine {
  /** Recognize the text of an image (upright for reading). Boxes are in pixels of the image. */
  recognize(image: HTMLCanvasElement, languages: string[], options?: RecognizeOptions): Promise<RecognizedLine[]>
  /** Free the worker (it is started again on the next recognize()). */
  dispose(): Promise<void>
}

export function abortError(): Error {
  return new DOMException('Text recognition was cancelled.', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  // DOMException is not an Error subclass in every environment.
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError'
}

/** Base URL of the bundled OCR assets. */
function assetBase(): string {
  return new URL('ocr/', document.baseURI).href
}

/** WebAssembly SIMD support (a v128 instruction), as detected by wasm-feature-detect. */
function hasWasmSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
    )
  } catch {
    return false
  }
}

type TesseractWorker = Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>

interface TesseractBlock {
  paragraphs?: { lines?: TesseractLine[] }[]
}
interface TesseractBox {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface TesseractLine {
  bbox: TesseractBox
  baseline?: TesseractBox & { has_baseline?: boolean }
  words?: { text: string; confidence: number; bbox: TesseractBox }[]
}

/** tesseract.js in a worker, one worker for the current language set. */
class TesseractEngine implements OcrEngine {
  private worker: Promise<TesseractWorker> | null = null
  private languages = ''
  private onProgress: ((p: OcrProgress) => void) | undefined

  private async start(languages: string[]): Promise<TesseractWorker> {
    const key = languages.join('+')
    if (this.worker && this.languages === key) return this.worker
    await this.dispose()
    this.languages = key
    this.worker = (async () => {
      const { createWorker, OEM } = await import('tesseract.js')
      const base = assetBase()
      return createWorker(languages, OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}${hasWasmSimd() ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js'}`,
        langPath: base.replace(/\/$/, ''),
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
        logger: (m: { status?: string; progress?: number }) => {
          const progress = typeof m.progress === 'number' ? m.progress : 0
          this.onProgress?.({ stage: m.status === 'recognizing text' ? 'recognizing' : 'loading', progress })
        },
        errorHandler: (err: unknown) => console.error('Text recognition worker error', err)
      })
    })()
    this.worker.catch(() => {
      this.worker = null
      this.languages = ''
    })
    return this.worker
  }

  async recognize(image: HTMLCanvasElement, languages: string[], options: RecognizeOptions = {}): Promise<RecognizedLine[]> {
    const { signal } = options
    if (signal?.aborted) throw abortError()
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        // tesseract.js cannot stop a job: the worker is terminated (and started again next time).
        void this.dispose()
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      this.onProgress = options.onProgress
      const worker = await Promise.race([this.start(languages), aborted])
      const result = await Promise.race([worker.recognize(image, {}, { blocks: true, text: false }), aborted])
      return toLines((result.data.blocks ?? []) as unknown as TesseractBlock[])
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      this.onProgress = undefined
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.languages = ''
    if (!worker) return
    try {
      await (await worker).terminate()
    } catch {
      /* failed to start, or already gone */
    }
  }
}

function toLines(blocks: TesseractBlock[]): RecognizedLine[] {
  const lines: RecognizedLine[] = []
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          bbox: line.bbox,
          baseline: line.baseline && line.baseline.has_baseline !== false ? line.baseline : null,
          words: (line.words ?? []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }))
        })
      }
    }
  }
  return lines
}

let engine: OcrEngine | null = null

export function getOcrEngine(): OcrEngine {
  engine ??= new TesseractEngine()
  return engine
}

/** Replace the engine (tests). null restores the default. */
export function setOcrEngine(next: OcrEngine | null): void {
  if (engine && engine !== next) void engine.dispose()
  engine = next
}
