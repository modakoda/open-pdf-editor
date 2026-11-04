import { Fragment } from 'react'
import { useEditor, type ToolId } from '@renderer/state/store'
import { useEditing } from './editingState'
import { SignatureDialog } from './SignatureDialog'
import { isFieldTool } from './fields'
import { RedactOptions } from './RedactOptions'
import { activateTool, FIELD_TOOLS, TOOLS, type ToolDef } from './tools'
import './ToolPalette.css'

const GROUPS: ToolId[][] = [
  ['select', 'hand'],
  ['text', 'edit-content', 'form-design'],
  ['image', 'signature'],
  ['rect', 'ellipse', 'line', 'arrow', 'ink'],
  ['highlight', 'whiteout', 'redact', 'note']
]

const WIDTHS = [0.5, 1, 2, 3, 4, 6, 8, 12]
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72]

function QuickOptions({ tool }: { tool: ToolId }) {
  const options = useEditor((s) => s.toolOptions)
  const setToolOptions = useEditor((s) => s.setToolOptions)
  const colorKey = tool === 'highlight' ? 'highlightColor' : 'color'
  const hasColor = ['text', 'rect', 'ellipse', 'line', 'arrow', 'ink', 'highlight'].includes(tool)
  const hasWidth = ['rect', 'ellipse', 'line', 'arrow', 'ink'].includes(tool)
  if (!hasColor) return null
  const widths = WIDTHS.includes(options.strokeWidth) ? WIDTHS : [...WIDTHS, options.strokeWidth].sort((a, b) => a - b)
  const sizes = FONT_SIZES.includes(options.fontSize) ? FONT_SIZES : [...FONT_SIZES, options.fontSize].sort((a, b) => a - b)
  return (
    <div className="ed-quick" aria-label="Tool options">
      <input
        type="color"
        className="ed-quick-color"
        data-testid="tool-color"
        title={tool === 'rect' || tool === 'ellipse' ? 'Stroke color' : 'Color'}
        aria-label={tool === 'rect' || tool === 'ellipse' ? 'Stroke color' : 'Color'}
        value={options[colorKey]}
        onChange={(e) => setToolOptions({ [colorKey]: e.target.value })}
      />
      {hasWidth && (
        <select
          className="ed-quick-select"
          data-testid="tool-width"
          title="Stroke width"
          aria-label="Stroke width"
          value={options.strokeWidth}
          onChange={(e) => setToolOptions({ strokeWidth: Number(e.target.value) })}
        >
          {widths.map((w) => (
            <option key={w} value={w}>
              {w} pt
            </option>
          ))}
        </select>
      )}
      {tool === 'text' && (
        <select
          className="ed-quick-select"
          data-testid="tool-font-size"
          title="Font size"
          aria-label="Font size"
          value={options.fontSize}
          onChange={(e) => setToolOptions({ fontSize: Number(e.target.value) })}
        >
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s} pt
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function ToolButton({ t, active, disabled }: { t: ToolDef; active: boolean; disabled: boolean }) {
  const Icon = t.icon
  const title = `${t.label}${t.hotkey ? ` (${t.hotkey})` : ''}${t.hint ? ' — ' + t.hint : ''}`
  return (
    <button
      type="button"
      className={`ed-tool-btn${active ? ' active' : ''}`}
      data-testid={`tool-${t.id}`}
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      aria-label={t.label}
      title={title}
      disabled={disabled}
      onClick={() => activateTool(t.id)}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

/** Field creation tools, shown while preparing a form. */
function FieldToolbar({ tool }: { tool: ToolId }) {
  return (
    <div className="ed-subtools" role="group" aria-label="Add form field" data-testid="field-tools">
      {FIELD_TOOLS.map((t) => (
        <ToolButton key={t.id} t={t} active={tool === t.id} disabled={false} />
      ))}
    </div>
  )
}

/** Tool buttons (data-testid="tool-<id>") placed in the main toolbar by the workspace. */
export function ToolPalette() {
  const tool = useEditor((s) => s.tool)
  const hasDoc = useEditor((s) => !!s.doc)
  const signatureOpen = useEditing((s) => s.signatureOpen)
  const setSignatureOpen = useEditing((s) => s.setSignatureOpen)
  const byId = new Map(TOOLS.map((t) => [t.id, t]))
  const designing = tool === 'form-design' || isFieldTool(tool)

  return (
    <div className="ed-palette" role="toolbar" aria-label="Editing tools">
      {GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <span className="ed-palette-sep" aria-hidden="true" />}
          {group.map((id) => (
            <Fragment key={id}>
              <ToolButton
                t={byId.get(id)!}
                active={tool === id || (id === 'signature' && signatureOpen) || (id === 'form-design' && designing)}
                disabled={!hasDoc && id !== 'select' && id !== 'hand'}
              />
              {id === 'form-design' && designing && hasDoc && <FieldToolbar tool={tool} />}
            </Fragment>
          ))}
        </Fragment>
      ))}
      <QuickOptions tool={tool} />
      {tool === 'redact' && hasDoc && <RedactOptions />}
      {signatureOpen && <SignatureDialog onClose={() => setSignatureOpen(false)} />}
    </div>
  )
}
