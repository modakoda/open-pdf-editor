/** Small upright popover for editing a sticky note's text and author. */
import { useEffect, useRef } from 'react'
import { Trash, X } from 'lucide-react'
import { displaySize, pageToView, removeObject, updateObject, type NoteObject, type PageEntry } from '@core'
import { useEditor } from '@renderer/state/store'
import { useEditing } from './editingState'
import { NOTE_SIZE, saveNoteAuthor } from './objects'

const POPOVER_W = 240
const POPOVER_H = 170

export function NotePopover({ note, page, scale }: { note: NoteObject; page: PageEntry; scale: number }) {
  const textRef = useRef<HTMLTextAreaElement>(null)
  const apply = useEditor((s) => s.apply)

  useEffect(() => {
    textRef.current?.focus({ preventScroll: true })
  }, [note.id])

  // Place the popover next to the icon in (rotated) view space.
  const corners = [
    { x: note.x, y: note.y },
    { x: note.x + NOTE_SIZE, y: note.y },
    { x: note.x, y: note.y + NOTE_SIZE },
    { x: note.x + NOTE_SIZE, y: note.y + NOTE_SIZE }
  ].map((p) => pageToView(p, page, scale))
  const minX = Math.min(...corners.map((c) => c.x))
  const maxX = Math.max(...corners.map((c) => c.x))
  const minY = Math.min(...corners.map((c) => c.y))
  // The viewer clips pages (overflow: hidden), so keep the popover inside the page.
  const view = displaySize(page)
  const viewW = view.width * scale
  const viewH = view.height * scale
  const preferred = maxX + 8 + POPOVER_W <= viewW ? maxX + 8 : minX - 8 - POPOVER_W
  const left = Math.max(4, Math.min(preferred, viewW - POPOVER_W - 4))
  const top = Math.max(4, Math.min(minY, viewH - POPOVER_H - 4))

  const close = () => useEditing.getState().openNote(null)

  return (
    <div
      className="ed-note-popover"
      data-overlay-control=""
      data-testid="note-popover"
      role="dialog"
      aria-label="Sticky note"
      style={{ left, top, width: POPOVER_W }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <div className="ed-note-popover-header">
        <span>Note</span>
        <button
          type="button"
          className="ed-icon-btn"
          title="Delete note"
          aria-label="Delete note"
          onClick={() => {
            close()
            apply((d) => removeObject(d, note.id))
          }}
        >
          <Trash size={14} aria-hidden="true" />
        </button>
        <button type="button" className="ed-icon-btn" title="Close" aria-label="Close note" onClick={close}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref={textRef}
        data-testid="note-text"
        aria-label="Note text"
        placeholder="Write a comment…"
        rows={4}
        value={note.text}
        onChange={(e) => {
          const text = e.target.value
          apply((d) => updateObject(d, note.id, { text }), { coalesceKey: `note:${note.id}:text` })
        }}
      />
      <input
        data-testid="note-author"
        aria-label="Author"
        placeholder="Author"
        value={note.author ?? ''}
        onChange={(e) => {
          const author = e.target.value
          saveNoteAuthor(author)
          apply((d) => updateObject(d, note.id, { author }), { coalesceKey: `note:${note.id}:author` })
        }}
      />
    </div>
  )
}
