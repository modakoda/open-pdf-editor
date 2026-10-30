import { useMemo, useState } from 'react'
import { splitDocument } from '@core'
import { notifyError, notifyInfo } from '@renderer/actions/util'
import { fontsReadyFor } from '@renderer/fonts/systemFonts'
import { platform } from '@renderer/platform'
import { baseFileName } from '@renderer/state/selectors'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'
import { parseRangesSafe } from './ExtractDialog'

export type SplitMode = 'every' | 'ranges'

/** Page index groups for a split. Exported for tests. */
export function computeSplitGroups(
  mode: SplitMode,
  pageCount: number,
  every: number,
  ranges: string
): { groups: number[][] } | { error: string } {
  if (mode === 'every') {
    if (!Number.isInteger(every) || every < 1) return { error: 'Enter a whole number of pages (1 or more).' }
    if (every >= pageCount) return { error: `The document has only ${pageCount} pages.` }
    const groups: number[][] = []
    for (let i = 0; i < pageCount; i += every) {
      groups.push(Array.from({ length: Math.min(every, pageCount - i) }, (_, k) => i + k))
    }
    return { groups }
  }
  const parts = ranges
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return { error: 'Enter one page range per file, e.g. 1-3; 4-6.' }
  const groups: number[][] = []
  for (const [i, part] of parts.entries()) {
    const parsed = parseRangesSafe(part, pageCount)
    if ('error' in parsed) return { error: `File ${i + 1}: ${parsed.error}` }
    groups.push(parsed.indices)
  }
  return { groups }
}

export function splitFileNames(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${base}-part${i + 1}.pdf`)
}

function describe(indices: number[]): string {
  if (indices.length === 1) return `page ${indices[0] + 1}`
  const contiguous = indices.every((v, i) => i === 0 || v === indices[i - 1] + 1)
  return contiguous
    ? `pages ${indices[0] + 1}–${indices[indices.length - 1] + 1}`
    : `${indices.length} pages`
}

export function SplitDialog({ onClose }: { onClose: (done: boolean | null) => void }) {
  const doc = useEditor((s) => s.doc)
  const fileName = useEditor((s) => s.fileName)
  const pageCount = doc?.pages.length ?? 0
  const [mode, setMode] = useState<SplitMode>('every')
  const [every, setEvery] = useState(pageCount > 2 ? Math.ceil(pageCount / 2) : 1)
  const [ranges, setRanges] = useState('')
  const [busy, setBusy] = useState(false)
  const result = useMemo(() => computeSplitGroups(mode, pageCount, every, ranges), [mode, pageCount, every, ranges])
  if (!doc) return null
  const base = baseFileName(fileName)
  const error = 'error' in result ? result.error : null
  const groups = 'groups' in result ? result.groups : []
  const names = splitFileNames(base, groups.length)

  const confirm = async () => {
    if (!groups.length) return
    setBusy(true)
    try {
      const idGroups = groups.map((g) => g.map((i) => doc.pages[i].id))
      await fontsReadyFor(doc)
      const outputs = await splitDocument(doc, idGroups)
      const folder = await platform.saveFilesToFolder(outputs.map((bytes, i) => ({ name: names[i], bytes })))
      if (folder === null) {
        setBusy(false)
        return
      }
      notifyInfo(`Split into ${outputs.length} files${folder ? ` in ${folder}` : ''}`)
      onClose(true)
    } catch (err) {
      setBusy(false)
      notifyError('Could not split the document', err)
    }
  }

  const showRangeError = mode === 'ranges' ? !!ranges.trim() : true

  return (
    <Dialog
      kind="split"
      title="Split document"
      description="Save parts of this document as separate PDF files."
      onCancel={() => onClose(null)}
      onConfirm={() => void confirm()}
      confirmLabel={groups.length ? `Split into ${groups.length} files…` : 'Split…'}
      confirmDisabled={!!error}
      busy={busy}
      width={480}
    >
      <div className="radio-group" role="radiogroup" aria-label="Split mode">
        <label className="check">
          <input
            type="radio"
            name="split-mode"
            data-testid="split-mode-every"
            checked={mode === 'every'}
            onChange={() => setMode('every')}
          />
          <span>Every N pages</span>
        </label>
        {mode === 'every' && (
          <Field label="Pages per file" htmlFor="split-every" inline error={error && showRangeError ? error : null}>
            <input
              id="split-every"
              className="input"
              data-testid="split-every"
              type="number"
              min={1}
              max={Math.max(1, pageCount - 1)}
              value={Number.isFinite(every) ? every : ''}
              onChange={(e) => setEvery(e.target.valueAsNumber)}
            />
          </Field>
        )}
        <label className="check">
          <input
            type="radio"
            name="split-mode"
            data-testid="split-mode-ranges"
            checked={mode === 'ranges'}
            onChange={() => setMode('ranges')}
          />
          <span>By page ranges</span>
        </label>
        {mode === 'ranges' && (
          <Field
            label="Ranges"
            htmlFor="split-ranges"
            hint="One file per line or per “;”, e.g. 1-3; 4-6; 7-"
            error={error && showRangeError ? error : null}
          >
            <textarea
              id="split-ranges"
              className="textarea"
              data-testid="range-input"
              value={ranges}
              placeholder={'1-3\n4-6'}
              onChange={(e) => setRanges(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}
      </div>
      {groups.length > 0 && (
        <div className="info-grid" data-testid="split-preview">
          {groups.slice(0, 6).map((g, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <span className="info-key">{names[i]}</span>
              <span>{describe(g)}</span>
            </div>
          ))}
          {groups.length > 6 && (
            <>
              <span className="info-key">…</span>
              <span>and {groups.length - 6} more</span>
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
