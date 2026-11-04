/** Floating find bar over the viewer (data-testid="dialog" data-dialog="find"). */
import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, SquareX, X } from 'lucide-react'
import { closeFind, findNext, findPrevious, runFind } from '@renderer/actions/find'
import { redactAllMatches } from '@renderer/actions/redactActions'
import { isImeComposing } from '@renderer/actions/util'
import { useFind } from '@renderer/state/find'
import { useEditor } from '@renderer/state/store'
import './find.css'

const SEARCH_DELAY_MS = 200

export function FindBar() {
  const open = useFind((s) => s.open)
  const query = useFind((s) => s.query)
  const count = useFind((s) => s.matches.length)
  const active = useFind((s) => s.active)
  const searching = useFind((s) => s.searching)
  const focusNonce = useFind((s) => s.focusNonce)
  const pages = useEditor((s) => s.doc?.pages)
  const ocr = useEditor((s) => s.doc?.ocr)
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusNonce])

  // Page order / content / recognized text changed: search again so highlights stay correct.
  useEffect(() => {
    const q = useFind.getState().query
    if (open && q) void runFind(q)
  }, [pages, ocr, open])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  if (!open) return null

  const onChange = (value: string) => {
    useFind.setState({ query: value })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void runFind(value), SEARCH_DELAY_MS)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        void runFind(query)
        return
      }
      if (e.shiftKey) findPrevious()
      else findNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeFind()
    }
  }

  const status = !query.trim()
    ? ''
    : searching && count === 0
      ? 'Searching…'
      : count === 0
        ? 'No results'
        : `${active + 1} of ${count}${searching ? '+' : ''}`

  return (
    <div className="find-bar" data-testid="dialog" data-dialog="find" role="search" aria-label="Find in document">
      <Search size={15} aria-hidden="true" className="find-icon" />
      <input
        ref={inputRef}
        className="find-input"
        data-testid="find-input"
        type="search"
        placeholder="Find in document"
        aria-label="Find in document"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
      <span className={`find-count${count === 0 && query.trim() && !searching ? ' none' : ''}`} data-testid="find-count" aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        className="find-btn"
        data-testid="find-prev"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={findPrevious}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="find-btn"
        data-testid="find-next"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={count === 0}
        onClick={findNext}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="find-btn"
        data-testid="find-redact-all"
        title="Mark all matches for redaction"
        aria-label="Redact all matches"
        disabled={count === 0 || searching}
        onClick={() => void redactAllMatches()}
      >
        <SquareX size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="find-btn"
        data-testid="dialog-cancel"
        title="Close (Esc)"
        aria-label="Close find"
        onClick={closeFind}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
