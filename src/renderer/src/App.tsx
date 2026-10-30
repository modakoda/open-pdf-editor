/**
 * Workspace layout:
 *   toolbar (+ page/document bar)
 *   [thumbnails sidebar] [viewer + find bar] [properties panel]
 *   status bar
 * plus the welcome screen (no document), dialogs, notices, the update banner and the file drop overlay.
 */
import { useEffect } from 'react'
import { closeFind } from './actions/find'
import { FileDropOverlay } from './components/drop/FileDropOverlay'
import { FindBar } from './components/find/FindBar'
import { Notice } from './components/notice/Notice'
import { Sidebar } from './components/sidebar/Sidebar'
import { StatusBar } from './components/statusbar/StatusBar'
import { Toolbar } from './components/toolbar/Toolbar'
import { UpdateBanner } from './components/update/UpdateBanner'
import { Viewer } from './components/viewer/Viewer'
import { Welcome } from './components/welcome/Welcome'
import { DialogHost } from './dialogs/DialogHost'
import { PropertiesPanel, useEditingShortcuts } from './editing'
import { useDesktopIntegration } from './hooks/useDesktopIntegration'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useEditor } from './state/store'
import './styles/app.css'
import './styles/print.css'

export function App() {
  useKeyboardShortcuts()
  useEditingShortcuts()
  useDesktopIntegration()
  const hasDoc = useEditor((s) => !!s.doc)
  const sidebarOpen = useEditor((s) => s.sidebarOpen)
  const docSession = useEditor((s) => s.docSession)

  // A different document: drop find results that refer to the old one.
  useEffect(() => closeFind(), [docSession])

  return (
    <div className="app" data-testid="app-root">
      <Toolbar />
      <main className="workspace">
        {hasDoc ? (
          <>
            {sidebarOpen && <Sidebar />}
            <div className="viewer-column">
              <Viewer />
              <FindBar />
            </div>
            <div className="properties-slot">
              <PropertiesPanel />
            </div>
          </>
        ) : (
          <Welcome />
        )}
      </main>
      <StatusBar />
      <Notice />
      <UpdateBanner />
      <DialogHost />
      <FileDropOverlay />
    </div>
  )
}
