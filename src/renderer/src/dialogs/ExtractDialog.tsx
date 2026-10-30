import { useMemo, useState } from 'react'
import { deletePages, exportDocument, parsePageRanges } from '@core'
import { applyEdit, errorMessage, notifyError, notifyInfo } from '@renderer/actions/util'
import { ensurePdfName } from '@renderer/actions/fileActions'
import { fontsReadyFor } from '@renderer/fonts/systemFonts'
import { platform } from '@renderer/platform'
import { baseFileName, currentPageIndex } from '@renderer/state/selectors'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'

/** Parse a range expression, returning indices or a user-facing error. */
export function parseRangesSafe(input: string, pageCount: number): { indices: number[] } | { error: string } {
  if (!input.trim()) return { error: 'Enter the pages to use, e.g. 1-3, 5.' }
  try {
    const indices = parsePageRanges(input, pageCount)
    if (!indices.length) return { error: 'No pages selected.' }
    return { indices }
  } catch (err) {
    return { error: err instanceof RangeError ? err.message : `Invalid page range: ${errorMessage(err)}` }
  }
}

export function ExtractDialog({ initialRange, onClose }: { initialRange?: string; onClose: (done: boolean | null) => void }) {
  const doc = useEditor((s) => s.doc)
  const fileName = useEditor((s) => s.fileName)
  const defaultRange = useEditor((s) => String(currentPageIndex(s) + 1))
  const [range, setRange] = useState(initialRange || defaultRange)
  const [removeAfter, setRemoveAfter] = useState(false)
  const [busy, setBusy] = useState(false)
  const pageCount = doc?.pages.length ?? 0
  const parsed = useMemo(() => parseRangesSafe(range, pageCount), [range, pageCount])
  if (!doc) return null
  const error = 'error' in parsed ? parsed.error : null
  const count = 'indices' in parsed ? parsed.indices.length : 0

  const confirm = async () => {
    if (!('indices' in parsed) || pageCount === 0) return
    const pageIds = parsed.indices.map((i) => doc.pages[i].id)
    setBusy(true)
    try {
      await fontsReadyFor(doc)
      const bytes = await exportDocument(doc, { pageIds })
      const name = ensurePdfName(`${baseFileName(fileName)}-pages-${range.replace(/\s+/g, '').replace(/,/g, '_')}`)
      const saved = await platform.saveFileDialog({ defaultPath: name, bytes })
      if (!saved) {
        setBusy(false)
        return
      }
      if (removeAfter) applyEdit('Delete extracted pages', (d) => deletePages(d, pageIds))
      notifyInfo(`Extracted ${count} page${count === 1 ? '' : 's'}`)
      onClose(true)
    } catch (err) {
      setBusy(false)
      notifyError('Could not extract pages', err)
    }
  }

  return (
    <Dialog
      kind="extract"
      title="Extract pages"
      description="Save a copy of some pages as a new PDF file."
      onCancel={() => onClose(null)}
      onConfirm={() => void confirm()}
      confirmLabel={count ? `Extract ${count} page${count === 1 ? '' : 's'}…` : 'Extract…'}
      confirmDisabled={!!error}
      busy={busy}
      width={440}
    >
      <Field
        label="Pages"
        htmlFor="extract-range"
        error={error && range.trim() ? error : null}
        hint={`Page numbers and ranges, e.g. 1-3, 5, 8-  (document has ${pageCount} page${pageCount === 1 ? '' : 's'})`}
      >
        <input
          id="extract-range"
          className="input"
          data-testid="range-input"
          value={range}
          aria-invalid={error && range.trim() ? 'true' : undefined}
          onChange={(e) => setRange(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <label className="check">
        <input type="checkbox" data-testid="extract-remove" checked={removeAfter} onChange={(e) => setRemoveAfter(e.target.checked)} />
        <span>Delete these pages from this document after extracting</span>
      </label>
    </Dialog>
  )
}
