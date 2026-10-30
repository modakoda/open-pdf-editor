/**
 * Recognize text (OCR): which pages, which languages; then progress with Cancel. Runs while the
 * dialog is open (it is modal, so the document does not change meanwhile).
 */
import { useEffect, useRef, useState } from 'react'
import { OCR_LANGUAGES } from '@core'
import {
  ocrSummary,
  pagesForScope,
  preferredOcrLanguages,
  recognizePages,
  rememberOcrLanguages,
  type OcrRunProgress,
  type OcrScope
} from '@renderer/actions/ocr'
import { errorMessage, notifyError, notifyInfo } from '@renderer/actions/util'
import { useEditor } from '@renderer/state/store'
import { Dialog } from './Dialog'

export function OcrDialog({
  scope: initialScope,
  skipPagesWithText: initialSkip,
  onClose
}: {
  scope?: OcrScope
  skipPagesWithText?: boolean
  onClose: (done: boolean | null) => void
}) {
  const pageCount = useEditor((s) => s.doc?.pages.length ?? 0)
  const selectedCount = useEditor((s) => s.selectedPageIds.length)
  const currentNumber = useEditor((s) => {
    const i = s.doc?.pages.findIndex((p) => p.id === s.currentPageId) ?? -1
    return i >= 0 ? i + 1 : 1
  })
  const [scope, setScope] = useState<OcrScope>(initialScope ?? (pageCount > 1 ? 'all' : 'current'))
  const [languages, setLanguages] = useState<string[]>(preferredOcrLanguages)
  const [skipText, setSkipText] = useState(initialSkip ?? true)
  const [progress, setProgress] = useState<OcrRunProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const controller = useRef<AbortController | null>(null)

  // Closing the window / the dialog being replaced stops the work.
  useEffect(() => () => controller.current?.abort(), [])

  const toggleLanguage = (code: string, on: boolean) =>
    setLanguages((current) => {
      const next = on ? [...current, code] : current.filter((l) => l !== code)
      return OCR_LANGUAGES.map((l) => l.code).filter((c) => next.includes(c))
    })

  const start = async () => {
    const pageIds = pagesForScope(scope)
    if (!pageIds.length || !languages.length) return
    rememberOcrLanguages(languages)
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    try {
      const result = await recognizePages(
        { pageIds, languages, skipPagesWithText: scope !== 'current' && skipText },
        setProgress,
        abort.signal
      )
      notifyInfo(ocrSummary(result))
      onClose(true)
    } catch (err) {
      notifyError('Text recognition failed', err)
      console.error(errorMessage(err))
      onClose(null)
    } finally {
      controller.current = null
    }
  }

  const cancel = () => {
    if (running) {
      setCancelling(true)
      controller.current?.abort()
    } else {
      onClose(null)
    }
  }

  const count = scope === 'all' ? pageCount : scope === 'selected' ? selectedCount : 1
  const percent = progress ? Math.round(((progress.index + (progress.stage === 'recognizing' ? progress.progress : 0)) / progress.total) * 100) : 0

  return (
    <Dialog
      kind="ocr"
      title="Recognize text"
      description="Find the text in scanned pages so you can search, select and copy it, and edit recognized lines. Everything runs on this computer."
      onCancel={cancel}
      onConfirm={() => void start()}
      confirmLabel={running ? 'Recognizing…' : 'Recognize text'}
      confirmDisabled={running || !languages.length || !pageCount}
      cancelLabel={cancelling ? 'Cancelling…' : 'Cancel'}
      width={460}
    >
      <fieldset className="ocr-fieldset" disabled={running}>
        <div className="dialog-section-title">Pages</div>
        <div className="radio-group" role="radiogroup" aria-label="Pages">
          <label className="check">
            <input type="radio" name="ocr-scope" data-testid="ocr-scope-current" checked={scope === 'current'} onChange={() => setScope('current')} />
            <span>Current page ({currentNumber})</span>
          </label>
          <label className="check">
            <input type="radio" name="ocr-scope" data-testid="ocr-scope-all" checked={scope === 'all'} onChange={() => setScope('all')} />
            <span>All pages ({pageCount})</span>
          </label>
          {selectedCount > 1 && (
            <label className="check">
              <input type="radio" name="ocr-scope" data-testid="ocr-scope-selected" checked={scope === 'selected'} onChange={() => setScope('selected')} />
              <span>Selected pages ({selectedCount})</span>
            </label>
          )}
        </div>
        {scope !== 'current' && (
          <label className="check">
            <input type="checkbox" data-testid="ocr-skip-text" checked={skipText} onChange={(e) => setSkipText(e.target.checked)} />
            <span>Skip pages that already contain text</span>
          </label>
        )}
        <div className="dialog-section-title">Languages</div>
        <div className="radio-group radio-group-inline" role="group" aria-label="Languages">
          {OCR_LANGUAGES.map((l) => (
            <label key={l.code} className="check">
              <input
                type="checkbox"
                data-testid={`ocr-lang-${l.code}`}
                checked={languages.includes(l.code)}
                onChange={(e) => toggleLanguage(l.code, e.target.checked)}
              />
              <span>{l.label}</span>
            </label>
          ))}
        </div>
        {!languages.length && <div className="field-error">Choose at least one language.</div>}
      </fieldset>
      {running && (
        <div className="ocr-progress" data-testid="ocr-progress" aria-live="polite">
          <div className="ocr-progress-label">
            {progress
              ? `Page ${progress.pageNumber} (${progress.index + 1} of ${progress.total}): ${progress.stage === 'loading' ? 'preparing…' : `recognizing text… ${Math.round(progress.progress * 100)}%`}`
              : `Preparing ${count} page${count === 1 ? '' : 's'}…`}
          </div>
          <progress max={100} value={percent} aria-label="Text recognition progress" data-testid="ocr-progress-bar" />
        </div>
      )}
    </Dialog>
  )
}
