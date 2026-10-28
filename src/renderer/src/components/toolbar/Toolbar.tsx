/**
 * Main toolbar (file, history, editing tools, find, zoom) and the secondary bar with page and
 * document operations. Every button routes through runCommand so menu, shortcuts and toolbar
 * behave identically.
 */
import { useRef, useState } from 'react'
import {
  Copy,
  Droplets,
  FileInput,
  FileOutput,
  FilePlus,
  FolderOpen,
  Hash,
  Info,
  Lock,
  Maximize,
  MoveHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  SaveAll,
  Scissors,
  Search,
  Trash,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { MenuAction } from '@shared/ipc'
import { runCommand } from '@renderer/actions/commands'
import { toggleFind } from '@renderer/actions/find'
import { duplicateTargetPages } from '@renderer/actions/pageActions'
import { ZOOM_PRESETS } from '@renderer/actions/viewActions'
import { ToolPalette } from '@renderer/editing'
import { useFind } from '@renderer/state/find'
import { canRedo, canUndo, useEditor } from '@renderer/state/store'
import { IconButton } from '../common/IconButton'
import { Menu, type MenuEntry } from '../common/Menu'
import './toolbar.css'

const run = (action: MenuAction) => () => runCommand(action, 'ui')

function Separator() {
  return <div className="toolbar-separator" role="separator" aria-orientation="vertical" />
}

export function Toolbar() {
  const hasDoc = useEditor((s) => !!s.doc)
  const pageCount = useEditor((s) => s.doc?.pages.length ?? 0)
  const undoable = useEditor(canUndo)
  const redoable = useEditor(canRedo)
  const busy = useEditor((s) => !!s.busy)
  const sidebarOpen = useEditor((s) => s.sidebarOpen)
  const findOpen = useFind((s) => s.open)

  return (
    <header className="toolbar-area">
      <div className="toolbar" role="toolbar" aria-label="Main toolbar">
        <div className="toolbar-group">
          <IconButton
            testId="btn-toggle-sidebar"
            icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen}
            label={sidebarOpen ? 'Hide page thumbnails' : 'Show page thumbnails'}
            active={hasDoc && sidebarOpen}
            disabled={!hasDoc}
            onClick={run('toggle-sidebar')}
          />
          <Separator />
          <IconButton testId="btn-open" icon={FolderOpen} label="Open…" shortcut="mod+o" onClick={run('open')} />
          <IconButton
            testId="btn-save"
            icon={Save}
            label="Save"
            shortcut="mod+s"
            disabled={!hasDoc || busy}
            onClick={run('save')}
          />
          <IconButton
            testId="btn-save-as"
            icon={SaveAll}
            label="Save As…"
            shortcut="mod+shift+s"
            disabled={!hasDoc || busy}
            onClick={run('save-as')}
          />
          <IconButton
            testId="btn-print"
            icon={Printer}
            label="Print…"
            shortcut="mod+p"
            disabled={!hasDoc || busy || pageCount === 0}
            onClick={run('print')}
          />
          <Separator />
          <IconButton
            testId="btn-undo"
            icon={Undo2}
            label="Undo"
            shortcut="mod+z"
            disabled={!undoable}
            onClick={run('undo')}
          />
          <IconButton
            testId="btn-redo"
            icon={Redo2}
            label="Redo"
            shortcut="mod+shift+z"
            disabled={!redoable}
            onClick={run('redo')}
          />
        </div>

        <div className="toolbar-center">{hasDoc && <ToolPalette />}</div>

        <div className="toolbar-group">
          <IconButton
            testId="btn-find"
            icon={Search}
            label="Find"
            shortcut="mod+f"
            disabled={!hasDoc || pageCount === 0}
            active={findOpen}
            onClick={toggleFind}
          />
          <Separator />
          <ZoomControls disabled={!hasDoc} />
        </div>
      </div>

      {hasDoc && <PageBar pageCount={pageCount} />}
    </header>
  )
}

function ZoomControls({ disabled }: { disabled: boolean }) {
  const zoom = useEditor((s) => s.zoom)
  const fitMode = useEditor((s) => s.fitMode)
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const percent = `${Math.round(zoom * 100)}%`
  const menuItems: MenuEntry[] = [
    ...ZOOM_PRESETS.filter((z) => z >= 0.5 && z <= 4).map((z) => ({
      id: `zoom-${Math.round(z * 100)}`,
      label: `${Math.round(z * 100)}%`,
      checked: !fitMode && Math.abs(zoom - z) < 0.001,
      onSelect: () => useEditor.getState().setZoom(z)
    })),
    'separator',
    { id: 'zoom-fit-width', label: 'Fit width', checked: fitMode === 'width', onSelect: run('fit-width') },
    { id: 'zoom-fit-page', label: 'Fit page', checked: fitMode === 'page', onSelect: run('fit-page') }
  ]
  const rect = anchor.current?.getBoundingClientRect()
  return (
    <>
      <IconButton
        testId="btn-zoom-out"
        icon={ZoomOut}
        label="Zoom out"
        shortcut="mod+-"
        disabled={disabled}
        onClick={run('zoom-out')}
      />
      <button
        ref={anchor}
        type="button"
        className="zoom-level"
        data-testid="zoom-level"
        title="Zoom level"
        aria-label={`Zoom level ${percent}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {disabled ? '–' : percent}
      </button>
      <IconButton
        testId="btn-zoom-in"
        icon={ZoomIn}
        label="Zoom in"
        shortcut="mod+="
        disabled={disabled}
        onClick={run('zoom-in')}
      />
      <IconButton
        testId="btn-fit-width"
        icon={MoveHorizontal}
        label="Fit width"
        disabled={disabled}
        active={!disabled && fitMode === 'width'}
        onClick={run('fit-width')}
      />
      <IconButton
        testId="btn-fit-page"
        icon={Maximize}
        label="Fit page"
        disabled={disabled}
        active={!disabled && fitMode === 'page'}
        onClick={run('fit-page')}
      />
      {menuOpen && rect && (
        <Menu
          x={rect.left}
          y={rect.bottom + 4}
          items={menuItems}
          label="Zoom"
          testId="zoom-menu"
          anchor={anchor.current}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  )
}

function PageBar({ pageCount }: { pageCount: number }) {
  const noPages = pageCount === 0
  return (
    <div className="subbar" role="toolbar" aria-label="Page and document tools">
      <div className="subbar-group" aria-label="Pages">
        <span className="subbar-title">Pages</span>
        <IconButton
          testId="btn-rotate-ccw"
          icon={RotateCcw}
          label="Rotate left"
          text="Left"
          showLabel
          disabled={noPages}
          onClick={run('rotate-ccw')}
        />
        <IconButton
          testId="btn-rotate-cw"
          icon={RotateCw}
          label="Rotate right"
          text="Right"
          showLabel
          disabled={noPages}
          onClick={run('rotate-cw')}
        />
        <IconButton
          testId="btn-insert-blank"
          icon={FilePlus}
          label="Insert blank page"
          text="Blank page"
          showLabel
          onClick={run('insert-blank-page')}
        />
        <IconButton
          testId="btn-insert-pages"
          icon={FileInput}
          label="Insert pages from file…"
          text="From file"
          showLabel
          onClick={run('insert-pages')}
        />
        <IconButton
          testId="btn-duplicate-pages"
          icon={Copy}
          label="Duplicate pages"
          text="Duplicate"
          showLabel
          disabled={noPages}
          onClick={() => duplicateTargetPages()}
        />
        <IconButton
          testId="btn-extract"
          icon={FileOutput}
          label="Extract pages…"
          text="Extract"
          showLabel
          disabled={noPages}
          onClick={run('extract-pages')}
        />
        <IconButton
          testId="btn-split"
          icon={Scissors}
          label="Split document…"
          text="Split"
          showLabel
          disabled={pageCount < 2}
          onClick={run('split')}
        />
        <IconButton
          testId="btn-delete-pages"
          icon={Trash}
          label="Delete pages"
          text="Delete"
          showLabel
          className="danger"
          disabled={noPages}
          onClick={run('delete-pages')}
        />
      </div>
      <div className="subbar-group" aria-label="Document">
        <span className="subbar-title">Document</span>
        <IconButton
          testId="btn-properties"
          icon={Info}
          label="Document properties…"
          text="Properties"
          showLabel
          onClick={run('document-properties')}
        />
        <IconButton
          testId="btn-watermark"
          icon={Droplets}
          label="Watermark…"
          text="Watermark"
          showLabel
          onClick={run('watermark')}
        />
        <IconButton
          testId="btn-page-numbers"
          icon={Hash}
          label="Page numbers…"
          text="Page numbers"
          showLabel
          onClick={run('page-numbers')}
        />
        <IconButton
          testId="btn-security"
          icon={Lock}
          label="Password & security…"
          text="Security"
          showLabel
          onClick={run('security')}
        />
      </div>
    </div>
  )
}
