/**
 * Window-wide drag & drop of PDF files. Drops on the thumbnail list are handled by the sidebar
 * (insert pages); anywhere else the files are opened.
 */
import { useEffect, useState } from 'react'
import { FileDown } from 'lucide-react'
import { openDroppedFiles } from '@renderer/actions/fileActions'
import { isDesktop } from '@renderer/platform'
import { useEditor } from '@renderer/state/store'
import './drop.css'

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files')
}

function overSidebarList(e: DragEvent): boolean {
  return e.target instanceof Element && !!e.target.closest('.thumb-list')
}

export function FileDropOverlay() {
  const [active, setActive] = useState(false)
  const hasDoc = useEditor((s) => !!s.doc)

  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (overSidebarList(e) && useEditor.getState().doc) {
        setActive(false)
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setActive(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setActive(false)
    }
    const onDrop = (e: DragEvent) => {
      setActive(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (files && files.length) void openDroppedFiles(files)
    }
    const reset = () => setActive(false)
    window.addEventListener('dragenter', onOver)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      window.removeEventListener('dragenter', onOver)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [])

  if (!active) return null
  return (
    <div className="drop-overlay" data-testid="drop-overlay" aria-hidden="true">
      <div className="drop-overlay-card">
        <FileDown size={30} strokeWidth={1.6} />
        <strong>{hasDoc && isDesktop ? 'Drop to open in a new window' : 'Drop PDF to open'}</strong>
        {hasDoc && <small>Drop on the page thumbnails to insert pages instead</small>}
      </div>
    </div>
  )
}
