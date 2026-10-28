/** Tool metadata (labels, icons, hotkeys) and tool activation shared by the palette and shortcuts. */
import type { LucideIcon } from 'lucide-react'
import {
  Eraser,
  Hand,
  Highlighter,
  Image,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Replace,
  Signature,
  Square,
  Circle,
  StickyNote,
  Type
} from 'lucide-react'
import { useEditor, type ToolId } from '@renderer/state/store'
import { platform } from '@renderer/platform'
import { useEditing } from './editingState'
import { detectImageMime, readImageSize } from './images'

export interface ToolDef {
  id: ToolId
  label: string
  /** Single-letter hotkey (no modifiers). */
  hotkey: string
  icon: LucideIcon
  /** Longer tooltip text. */
  hint?: string
}

export const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', hotkey: 'V', icon: MousePointer2, hint: 'Select, move, resize and rotate objects' },
  { id: 'hand', label: 'Hand', hotkey: 'H', icon: Hand, hint: 'Pan the document' },
  { id: 'text', label: 'Add text', hotkey: 'T', icon: Type, hint: 'Click or drag a box to add text' },
  {
    id: 'edit-text',
    label: 'Edit existing text',
    hotkey: 'E',
    icon: Replace,
    hint:
      'Click text on the page to replace it. The original text is covered by an editable copy on a ' +
      'background box (it is hidden visually, not removed from the file).'
  },
  { id: 'image', label: 'Image', hotkey: 'I', icon: Image, hint: 'Pick a PNG/JPEG image, then click a page to place it' },
  { id: 'signature', label: 'Signature', hotkey: 'S', icon: Signature, hint: 'Draw or type a signature, then click a page to place it' },
  { id: 'rect', label: 'Rectangle', hotkey: 'R', icon: Square, hint: 'Drag to draw a rectangle (Shift: square)' },
  { id: 'ellipse', label: 'Ellipse', hotkey: 'O', icon: Circle, hint: 'Drag to draw an ellipse (Shift: circle)' },
  { id: 'line', label: 'Line', hotkey: 'L', icon: Minus, hint: 'Drag to draw a line (Shift: snap to 45°)' },
  { id: 'arrow', label: 'Arrow', hotkey: 'A', icon: MoveUpRight, hint: 'Drag to draw an arrow (Shift: snap to 45°)' },
  { id: 'ink', label: 'Pen', hotkey: 'P', icon: PenLine, hint: 'Draw freehand' },
  { id: 'highlight', label: 'Highlight', hotkey: 'M', icon: Highlighter, hint: 'Drag over content to highlight it' },
  {
    id: 'whiteout',
    label: 'Whiteout',
    hotkey: 'W',
    icon: Eraser,
    hint: 'Drag to cover content with an opaque box (hides it visually; it is not removed from the file)'
  },
  { id: 'note', label: 'Sticky note', hotkey: 'N', icon: StickyNote, hint: 'Click to add a comment' }
]

export const TOOL_BY_HOTKEY: Record<string, ToolId> = Object.fromEntries(
  TOOLS.map((t) => [t.hotkey.toLowerCase(), t.id])
)

/** Tools that return to 'select' after creating one object. */
export const ONE_SHOT_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'text',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'whiteout',
  'note',
  'image',
  'signature'
])

/** Tools whose defaults are shown in the properties panel when nothing is selected. */
export function toolHasOptions(tool: ToolId): boolean {
  return ['text', 'rect', 'ellipse', 'line', 'arrow', 'ink', 'highlight'].includes(tool)
}

/** Ask for an image file and make it the pending image (tool 'image'). */
export async function pickImage(): Promise<void> {
  const store = useEditor.getState()
  store.setTool('image')
  let file
  try {
    file = await platform.openImageDialog()
  } catch (err) {
    useEditor.getState().showNotice('error', `Could not open the image: ${(err as Error).message}`)
    file = null
  }
  const s = useEditor.getState()
  if (!file) {
    if (s.tool === 'image' && !s.pendingImage) s.setTool('select')
    return
  }
  const mimeType = detectImageMime(file.bytes)
  if (!mimeType) {
    s.showNotice('error', 'Unsupported image format. Please choose a PNG or JPEG image.')
    if (s.tool === 'image') s.setTool('select')
    return
  }
  const size = await readImageSize(file.bytes, mimeType)
  if (!size) {
    s.showNotice('error', 'The image could not be read.')
    if (s.tool === 'image') s.setTool('select')
    return
  }
  const after = useEditor.getState()
  after.setPendingImage({ data: file.bytes, mimeType, width: size.width, height: size.height })
  if (after.tool !== 'image') after.setTool('image')
  after.showNotice('info', 'Click on a page to place the image (Esc to cancel).')
}

/** Activate a tool as if its palette button was clicked. */
export function activateTool(id: ToolId): void {
  const store = useEditor.getState()
  const editing = useEditing.getState()
  editing.cancelGesture()
  if (id === 'image') {
    store.setPendingImage(null)
    void pickImage()
    return
  }
  if (id === 'signature') {
    editing.setSignatureOpen(true)
    return
  }
  if (store.pendingImage) store.setPendingImage(null)
  editing.openNote(null)
  store.setTool(id)
}
