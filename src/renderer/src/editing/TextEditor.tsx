/** Inline textarea for editing a text object in place (styled to match the rendered text). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { removeObject, type TextObject } from '@core'
import { useFallbackFonts } from '@renderer/fonts/systemFonts'
import { isImeComposing } from '@renderer/actions/util'
import { useEditor } from '@renderer/state/store'
import { useEditing } from './editingState'
import { findObject, updateObjectFitted } from './objects'
import { fontStack, safeLayout, safeMeasure, usesFallbackFont } from './textLayout'

export function textCoalesceKey(id: string): string {
  return `text:${id}`
}

/** End inline editing of a text object; an empty object is removed. */
export function finishTextEdit(id: string): void {
  const editing = useEditing.getState()
  if (editing.editingTextId !== id) return
  editing.stopTextEdit(id)
  const s = useEditor.getState()
  const obj = findObject(s.doc, id)
  if (obj && obj.type === 'text' && !obj.text.trim()) {
    s.apply((d) => removeObject(d, id), { coalesceKey: textCoalesceKey(id) })
    if (useEditor.getState().selectedObjectId === id) useEditor.getState().selectObject(null)
  }
}

/** Text objects with a background grow their width while typing instead of wrapping, up to `maxWidth`. */
export function grownWidth(obj: TextObject, text: string, maxWidth: number): number | undefined {
  if (!obj.background) return undefined
  const widest = Math.max(0, ...text.split('\n').map((line) => safeMeasure(line, obj)))
  const needed = Math.ceil((widest + Math.max(2, obj.fontSize * 0.2)) * 100) / 100
  if (needed <= obj.width) return undefined
  return Math.min(needed, Math.max(obj.width, maxWidth))
}

export function TextEditor({ obj, scale, maxWidth = Infinity }: { obj: TextObject; scale: number; maxWidth?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [minHeight, setMinHeight] = useState(0)
  const fontsVersion = useFallbackFonts((s) => s.version)
  const layout = useMemo(
    () => safeLayout(obj),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [obj.text, obj.font, obj.bold, obj.italic, obj.fontSize, obj.lineHeight, obj.width, obj.align, fontsVersion]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [obj.id])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Browser wrapping may differ slightly from the engine's: never clip the caret line.
    const prev = el.style.height
    el.style.height = '0px'
    const needed = el.scrollHeight
    el.style.height = prev
    setMinHeight(needed)
  }, [obj.text, obj.width, obj.fontSize, obj.lineHeight, obj.font, scale, fontsVersion])

  const height = Math.max(obj.height * scale, layout.height * scale, minHeight)

  return (
    <textarea
      ref={ref}
      data-testid="text-object-editor"
      data-overlay-control=""
      className="ed-text-editor"
      aria-label="Text"
      spellCheck
      value={obj.text}
      wrap="soft"
      style={{
        left: obj.x * scale,
        top: obj.y * scale,
        width: obj.width * scale,
        height,
        transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
        transformOrigin: `${(obj.width * scale) / 2}px ${(obj.height * scale) / 2}px`,
        fontFamily: fontStack(obj.font, layout.unicode, layout.fontKey),
        fontSynthesis: usesFallbackFont(layout.fontKey) ? 'none' : undefined,
        fontSize: obj.fontSize * scale,
        lineHeight: `${obj.fontSize * obj.lineHeight * scale}px`,
        fontWeight: obj.bold ? 700 : 400,
        fontStyle: obj.italic ? 'italic' : 'normal',
        color: obj.color,
        textAlign: obj.align,
        fontKerning: 'none',
        opacity: obj.opacity ?? 1
      }}
      onChange={(e) => {
        const text = e.target.value
        const width = grownWidth(obj, text, maxWidth)
        useEditor
          .getState()
          .apply((d) => updateObjectFitted(d, obj.id, width ? { text, width } : { text }), {
            coalesceKey: textCoalesceKey(obj.id)
          })
      }}
      onBlur={() => finishTextEdit(obj.id)}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          e.stopPropagation()
          e.currentTarget.blur()
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
