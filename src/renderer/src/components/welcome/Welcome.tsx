/** Start screen shown when the window has no document. */
import { useEffect, useState } from 'react'
import { Clock, FilePlus, FileText, FolderOpen, Upload } from 'lucide-react'
import { newBlankDocument, openPath, openWithDialog } from '@renderer/actions/fileActions'
import { baseName, shortcutLabel } from '@renderer/actions/util'
import { platform } from '@renderer/platform'
import './welcome.css'

function dirName(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join(path.includes('\\') ? '\\' : '/')
}

export function Welcome() {
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    platform
      .getRecentFiles()
      .then((files) => alive && setRecent(files.slice(0, 8)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="welcome" data-testid="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <div className="welcome-logo" aria-hidden="true">
            <FileText size={30} strokeWidth={1.6} />
          </div>
          <div>
            <h1>Open PDF Editor</h1>
            <p>View, edit, sign and organize PDF documents.</p>
          </div>
        </div>

        <div className="welcome-actions">
          <button type="button" className="welcome-action primary" data-testid="welcome-open" onClick={() => void openWithDialog()}>
            <FolderOpen size={22} strokeWidth={1.7} aria-hidden="true" />
            <span className="welcome-action-text">
              <strong>Open PDF…</strong>
              <small>{shortcutLabel('mod+o')}</small>
            </span>
          </button>
          <button type="button" className="welcome-action" data-testid="welcome-new" onClick={() => void newBlankDocument()}>
            <FilePlus size={22} strokeWidth={1.7} aria-hidden="true" />
            <span className="welcome-action-text">
              <strong>New blank document</strong>
              <small>A4, one page</small>
            </span>
          </button>
        </div>

        {recent.length > 0 && (
          <section className="welcome-recent" aria-label="Recent files">
            <h2>
              <Clock size={13} aria-hidden="true" /> Recent
            </h2>
            <ul>
              {recent.map((path) => (
                <li key={path}>
                  <button type="button" className="welcome-recent-item" title={path} onClick={() => void openPath(path)}>
                    <FileText size={15} aria-hidden="true" />
                    <span className="welcome-recent-name">{baseName(path)}</span>
                    <span className="welcome-recent-dir">{dirName(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="welcome-drop">
          <Upload size={16} aria-hidden="true" />
          Or drop a PDF file anywhere in this window
        </div>
      </div>
    </div>
  )
}
