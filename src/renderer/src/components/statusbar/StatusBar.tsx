/** Bottom status bar: page x of y (click to jump), selection, busy state, file name and zoom. */
import { useState } from 'react'
import { Lock } from 'lucide-react'
import { goToPageIndex } from '@renderer/actions/viewActions'
import { currentPageIndex } from '@renderer/state/selectors'
import { useEditor } from '@renderer/state/store'
import './statusbar.css'

export function StatusBar() {
  const doc = useEditor((s) => s.doc)
  const pageCount = doc?.pages.length ?? 0
  const current = useEditor((s) => (s.doc && s.doc.pages.length ? currentPageIndex(s) + 1 : 0))
  const selectedCount = useEditor((s) => s.selectedPageIds.length)
  const busy = useEditor((s) => s.busy)
  const zoom = useEditor((s) => s.zoom)
  const fileName = useEditor((s) => s.fileName)
  const dirty = useEditor((s) => s.dirty)
  const encrypted = !!doc?.settings.encryption
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!doc) {
    return (
      <footer className="statusbar" data-testid="statusbar">
        <span className="statusbar-muted">Ready</span>
        {busy && <Busy text={busy} />}
      </footer>
    )
  }

  const commit = () => {
    const n = Number.parseInt(draft, 10)
    if (Number.isFinite(n)) goToPageIndex(n - 1)
    setEditing(false)
  }

  return (
    <footer className="statusbar" data-testid="statusbar">
      <div className="statusbar-section">
        <span className="statusbar-pages">
          Page{' '}
          {editing ? (
            <input
              className="statusbar-page-input"
              aria-label="Go to page"
              autoFocus
              value={draft}
              inputMode="numeric"
              onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <button
              type="button"
              className="statusbar-page-button"
              title="Go to page…"
              onClick={() => {
                setDraft(String(current))
                setEditing(true)
              }}
              disabled={pageCount === 0}
            >
              <span data-testid="current-page">{current}</span>
            </button>
          )}{' '}
          of <span data-testid="page-count">{pageCount}</span>
        </span>
        {selectedCount > 1 && <span className="statusbar-muted">{selectedCount} pages selected</span>}
      </div>
      <div className="statusbar-section statusbar-right">
        {busy && <Busy text={busy} />}
        <span className="statusbar-file" title={fileName}>
          {encrypted && <Lock size={11} aria-label="Password protected" />}
          {fileName}
          {dirty && <span className="statusbar-dirty"> — Edited</span>}
        </span>
        <span className="statusbar-zoom">{Math.round(zoom * 100)}%</span>
      </div>
    </footer>
  )
}

function Busy({ text }: { text: string }) {
  return (
    <span className="statusbar-busy" role="status" data-testid="busy">
      <span className="spinner" aria-hidden="true" />
      {text}
    </span>
  )
}
