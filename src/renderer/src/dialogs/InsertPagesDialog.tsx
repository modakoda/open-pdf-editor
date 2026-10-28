import { useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import type { SourceDocument } from '@core'
import { insertSourcePagesAt } from '@renderer/actions/pageActions'
import { currentPageIndex } from '@renderer/state/selectors'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'
import { parseRangesSafe } from './ExtractDialog'

/** Insertion index in the document for "before/after page N" (N is 1-based). */
export function insertionIndex(where: 'before' | 'after', pageNumber: number, pageCount: number): number {
  if (pageCount === 0) return 0
  const n = Math.min(pageCount, Math.max(1, Math.round(pageNumber)))
  return where === 'before' ? n - 1 : n
}

export function InsertPagesDialog({ source, onClose }: { source: SourceDocument; onClose: (done: boolean | null) => void }) {
  const pageCount = useEditor((s) => s.doc?.pages.length ?? 0)
  const current = useEditor((s) => currentPageIndex(s) + 1)
  const [where, setWhere] = useState<'before' | 'after'>('after')
  const [pageNumber, setPageNumber] = useState(pageCount ? current : 1)
  const [range, setRange] = useState('')
  const parsedRange = useMemo(
    () => (range.trim() ? parseRangesSafe(range, source.pageCount) : { indices: undefined }),
    [range, source.pageCount]
  )
  const rangeError = 'error' in parsedRange ? parsedRange.error : null
  const pageError =
    pageCount > 0 && (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount)
      ? `Enter a page number between 1 and ${pageCount}.`
      : null
  const count = 'indices' in parsedRange && parsedRange.indices ? parsedRange.indices.length : source.pageCount

  const confirm = () => {
    if (rangeError || pageError) return
    const indices = 'indices' in parsedRange ? parsedRange.indices : undefined
    if (insertSourcePagesAt(source, insertionIndex(where, pageNumber, pageCount), indices)) onClose(true)
  }

  return (
    <Dialog
      kind="insert"
      title="Insert pages"
      onCancel={() => onClose(null)}
      onConfirm={confirm}
      confirmLabel={`Insert ${count} page${count === 1 ? '' : 's'}`}
      confirmDisabled={!!rangeError || !!pageError}
      width={460}
    >
      <div className="callout">
        <FileText size={16} aria-hidden="true" />
        <span>
          <strong>{source.name}</strong> — {source.pageCount} page{source.pageCount === 1 ? '' : 's'}
        </span>
      </div>
      <Field
        label="Pages to insert"
        htmlFor="insert-range"
        error={rangeError}
        hint="Leave empty to insert all pages, or enter ranges like 1-3, 5."
      >
        <input
          id="insert-range"
          className="input"
          data-testid="range-input"
          placeholder="All pages"
          value={range}
          aria-invalid={rangeError ? 'true' : undefined}
          onChange={(e) => setRange(e.target.value)}
          spellCheck={false}
        />
      </Field>
      {pageCount > 0 && (
        <Field label="Position" htmlFor="insert-where" error={pageError}>
          <div className="control-row">
            <select
              id="insert-where"
              className="select"
              data-testid="insert-where"
              value={where}
              onChange={(e) => setWhere(e.target.value as 'before' | 'after')}
              style={{ width: 110, flex: 'none' }}
            >
              <option value="before">Before</option>
              <option value="after">After</option>
            </select>
            <span>page</span>
            <input
              className="input"
              data-testid="insert-page"
              aria-label="Page number"
              type="number"
              min={1}
              max={pageCount}
              value={Number.isFinite(pageNumber) ? pageNumber : ''}
              onChange={(e) => setPageNumber(e.target.valueAsNumber)}
              style={{ width: 90, flex: 'none' }}
            />
            <span className="field-hint">of {pageCount}</span>
          </div>
          <div className="control-row">
            <button type="button" className="btn btn-small" onClick={() => { setWhere('before'); setPageNumber(1) }}>
              At the beginning
            </button>
            <button type="button" className="btn btn-small" onClick={() => { setWhere('after'); setPageNumber(pageCount) }}>
              At the end
            </button>
          </div>
        </Field>
      )}
    </Dialog>
  )
}
