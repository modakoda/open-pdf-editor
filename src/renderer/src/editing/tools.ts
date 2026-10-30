/** Tool metadata (labels, icons, hotkeys) and tool activation shared by the palette and shortcuts. */
import type { LucideIcon } from 'lucide-react'
import {
  ChevronDown,
  CircleDot,
  ClipboardPen,
  Eraser,
  List,
  PenTool,
  SquareCheck,
  SquareMousePointer,
  SquareX,
  TextCursorInput,
  Hand,
  Highlighter,
  Image,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
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
    id: 'edit-content',
    label: 'Edit content',
    hotkey: 'E',
    icon: SquareMousePointer,
    hint: 'Select, move, resize or delete text, images and graphics that are already in the PDF; double-click text to retype it'
  },
  {
    id: 'form-design',
    label: 'Prepare form',
    hotkey: 'F',
    icon: ClipboardPen,
    hint: 'Move, resize, rename or delete form fields and add new ones'
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
  {
    id: 'redact',
    label: 'Redact',
    hotkey: 'X',
    icon: SquareX,
    hint: 'Drag to mark content for redaction; on save everything under the marks is removed from the file'
  },
  { id: 'note', label: 'Sticky note', hotkey: 'N', icon: StickyNote, hint: 'Click to add a comment' }
]

/** Field creation tools, shown as a sub-toolbar while preparing a form (no hotkeys). */
export const FIELD_TOOLS: ToolDef[] = [
  { id: 'field-text', label: 'Text field', hotkey: '', icon: TextCursorInput, hint: 'Drag to add a text field' },
  { id: 'field-checkbox', label: 'Checkbox', hotkey: '', icon: SquareCheck, hint: 'Click or drag to add a checkbox' },
  {
    id: 'field-radio',
    label: 'Radio button',
    hotkey: '',
    icon: CircleDot,
    hint: 'Click or drag to add a radio button (with a radio button selected: adds a choice to its group)'
  },
  { id: 'field-dropdown', label: 'Dropdown', hotkey: '', icon: ChevronDown, hint: 'Drag to add a dropdown list' },
  { id: 'field-list', label: 'List box', hotkey: '', icon: List, hint: 'Drag to add a list box' },
  { id: 'field-signature', label: 'Signature field', hotkey: '', icon: PenTool, hint: 'Drag to add a signature field' }
]

export const TOOL_BY_HOTKEY: Record<string, ToolId> = Object.fromEntries(
  TOOLS.filter((t) => t.hotkey).map((t) => [t.hotkey.toLowerCase(), t.id])
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
  editing.setEditingContent(null)
  // A new radio button joins the group of the selected one.
  if (id === 'field-radio') {
    const sel = store.doc?.objects.find((o) => o.id === store.selectedObjectId)
    editing.setRadioJoinGroup(sel?.type === 'field' && sel.fieldType === 'radio' ? sel.name : null)
  }
  store.setTool(id)
}
