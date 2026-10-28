/** Object construction helpers and document actions shared by the overlay, panel and shortcuts. */
import {
  NOTE_ICON_SIZE,
  addObject,
  createId,
  isBoxObject,
  layoutText,
  removeObject,
  updateObject,
  type Box,
  type EditObject,
  type EditorDocument,
  type ImageObject,
  type LineObject,
  type NoteObject,
  type PageEntry,
  type Point,
  type ShapeObject,
  type TextObject
} from '@core'
import { useEditor, type PendingImage, type ToolOptions } from '@renderer/state/store'
import { useEditing } from './editingState'
import { inkBounds, translateObject } from './manip'

/** Sticky note icon size in points (same as the exported /Text annotation). */
export const NOTE_SIZE = NOTE_ICON_SIZE
export const NOTE_COLOR = '#facc15'
export const DEFAULT_HIGHLIGHT_OPACITY = 0.4
export const DEFAULT_TEXT_WIDTH = 200
export const DUPLICATE_OFFSET = 10

const opacityField = (o: ToolOptions) => (o.opacity < 1 ? { opacity: o.opacity } : {})

export function newObjectId(): string {
  return createId('obj')
}

export function makeShape(
  type: 'rect' | 'ellipse' | 'highlight' | 'whiteout',
  pageId: string,
  box: Box,
  o: ToolOptions
): EditObject {
  const id = newObjectId()
  switch (type) {
    case 'highlight':
      return { id, pageId, type, ...box, color: o.highlightColor, opacity: DEFAULT_HIGHLIGHT_OPACITY }
    case 'whiteout':
      return { id, pageId, type, ...box, color: '#ffffff' }
    default:
      return {
        id,
        pageId,
        type,
        ...box,
        strokeColor: o.color,
        fillColor: o.fillColor,
        strokeWidth: o.strokeWidth,
        rotation: 0,
        ...opacityField(o)
      }
  }
}

export function makeLine(pageId: string, a: Point, b: Point, arrow: boolean, o: ToolOptions): LineObject {
  return {
    id: newObjectId(),
    pageId,
    type: 'line',
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    color: o.color,
    strokeWidth: o.strokeWidth,
    arrowEnd: arrow,
    ...opacityField(o)
  }
}

export function makeText(pageId: string, box: Box, o: ToolOptions, text = ''): TextObject {
  return {
    id: newObjectId(),
    pageId,
    type: 'text',
    ...box,
    text,
    font: o.font,
    bold: o.bold,
    italic: o.italic,
    fontSize: o.fontSize,
    color: o.color,
    align: 'left',
    lineHeight: 1.2,
    rotation: 0,
    background: null,
    ...opacityField(o)
  }
}

export function makeNote(pageId: string, at: Point): NoteObject {
  return {
    id: newObjectId(),
    pageId,
    type: 'note',
    x: at.x,
    y: at.y,
    text: '',
    color: NOTE_COLOR,
    author: loadNoteAuthor() || undefined
  }
}

/** Initial size of a placed image: natural size in points, at most 40% of the page width. */
export function placedImageBox(page: Pick<PageEntry, 'width' | 'height'>, img: PendingImage, center: Point): Box {
  const ratio = img.height > 0 ? img.width / img.height : 1
  let width = Math.max(8, img.width * 0.75)
  width = Math.min(width, page.width * 0.4)
  let height = width / ratio
  if (height > page.height * 0.6) {
    height = page.height * 0.6
    width = height * ratio
  }
  const x = Math.min(Math.max(center.x - width / 2, 0), Math.max(0, page.width - width))
  const y = Math.min(Math.max(center.y - height / 2, 0), Math.max(0, page.height - height))
  return { x, y, width, height }
}

export function makeImage(pageId: string, box: Box, img: PendingImage): ImageObject {
  return { id: newObjectId(), pageId, type: 'image', ...box, data: img.data, mimeType: img.mimeType, rotation: 0 }
}

/** Text height needed by the layout (falls back to one line if layout fails). */
export function textLayoutHeight(t: Pick<TextObject, 'text' | 'font' | 'bold' | 'italic' | 'fontSize' | 'lineHeight' | 'width' | 'align'>): number {
  try {
    const layout = layoutText({
      text: t.text || ' ',
      font: t.font,
      bold: t.bold,
      italic: t.italic,
      fontSize: t.fontSize,
      lineHeight: t.lineHeight,
      width: t.width,
      align: t.align
    })
    return Math.max(layout.height, t.fontSize * t.lineHeight)
  } catch {
    return Math.max(1, t.text.split('\n').length) * t.fontSize * t.lineHeight
  }
}

/** Grow a text object's height so the laid-out text fits. */
export function fitText<T extends TextObject>(t: T): T {
  const h = textLayoutHeight(t)
  return h > t.height + 0.01 ? { ...t, height: Math.ceil(h * 100) / 100 } : t
}

/** updateObject that keeps text boxes tall enough for their text. */
export function updateObjectFitted(doc: EditorDocument, id: string, patch: Partial<EditObject>): EditorDocument {
  const obj = doc.objects.find((o) => o.id === id)
  if (!obj) return doc
  if (obj.type === 'text') {
    const merged = { ...obj, ...patch } as TextObject
    const fitted = fitText(merged)
    if (fitted.height !== merged.height) patch = { ...patch, height: fitted.height } as Partial<EditObject>
  }
  return updateObject(doc, id, patch)
}

export function findObject(doc: EditorDocument | null, id: string | null): EditObject | undefined {
  if (!doc || !id) return undefined
  return doc.objects.find((o) => o.id === id)
}

/** Delete the selected object (one undo step). */
export function deleteSelected(): boolean {
  const { doc, selectedObjectId, apply, selectObject } = useEditor.getState()
  const obj = findObject(doc, selectedObjectId)
  if (!obj) return false
  const editing = useEditing.getState()
  editing.stopTextEdit(obj.id)
  if (editing.openNoteId === obj.id) editing.openNote(null)
  apply((d) => removeObject(d, obj.id))
  selectObject(null)
  return true
}

/** Duplicate the selected object with a small offset and select the copy. */
export function duplicateSelected(): string | null {
  const { doc, selectedObjectId, apply, selectObject } = useEditor.getState()
  const obj = findObject(doc, selectedObjectId)
  if (!obj) return null
  const copy = { ...translateObject(obj, DUPLICATE_OFFSET, DUPLICATE_OFFSET), id: newObjectId() } as EditObject
  apply((d) => addObject(d, copy))
  selectObject(copy.id)
  return copy.id
}

/** Box objects that support rotation (highlight and whiteout boxes do not). */
export function hasRotation(obj: EditObject): obj is TextObject | ImageObject | ShapeObject {
  return obj.type === 'text' || obj.type === 'image' || obj.type === 'rect' || obj.type === 'ellipse'
}

/** Bounding box of any object (unrotated). */
export function objectBounds(obj: EditObject): Box {
  if (isBoxObject(obj)) return { x: obj.x, y: obj.y, width: obj.width, height: obj.height }
  switch (obj.type) {
    case 'line':
      return {
        x: Math.min(obj.x1, obj.x2),
        y: Math.min(obj.y1, obj.y2),
        width: Math.abs(obj.x2 - obj.x1),
        height: Math.abs(obj.y2 - obj.y1)
      }
    case 'ink':
      return inkBounds(obj.paths)
    case 'note':
      return { x: obj.x, y: obj.y, width: NOTE_SIZE, height: NOTE_SIZE }
  }
}

const AUTHOR_KEY = 'ope.noteAuthor'

export function loadNoteAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveNoteAuthor(author: string): void {
  try {
    localStorage.setItem(AUTHOR_KEY, author)
  } catch {
    /* ignore */
  }
}
