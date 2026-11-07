/**
 * Recognized text (OCR) in Edit content: hit targets for recognized lines (on top of the
 * scanned image) and the properties panel of the selected line, with "Make editable".
 */
import { ClipboardCopy, Type } from 'lucide-react'
import { ocrLineText, type OcrLine, type OcrPageResult, type PageEntry } from '@core'
import { copyLineText, makeLineEditable } from '@renderer/actions/ocr'
import { useOcrUi, type OcrLineRef } from '@renderer/state/ocr'
import { useEditor } from '@renderer/state/store'

export function OcrLinesLayer({ page, result, scale }: { page: PageEntry; result: OcrPageResult; scale: number }) {
  const selected = useOcrUi((s) => (s.selectedLine?.pageId === page.id ? s.selectedLine.lineId : null))
  return (
    <div className="ed-elements ed-ocr-lines">
      {result.lines.map((line) => (
        <div
          key={line.id}
          className="ed-element ed-ocr-line"
          data-testid="ocr-line"
          data-ocr-line-id={line.id}
          data-selected={selected === line.id ? 'true' : 'false'}
          title={`Recognized text: “${ocrLineText(line)}” — double-click to make it editable`}
          style={{ left: line.box.x * scale, top: line.box.y * scale, width: line.box.width * scale, height: line.box.height * scale }}
        />
      ))}
    </div>
  )
}

/** The recognized line selected in Edit content, if any. */
export function useSelectedOcrLine(): { lineRef: OcrLineRef; line: OcrLine } | null {
  const lineRef = useOcrUi((s) => s.selectedLine)
  const tool = useEditor((s) => s.tool)
  const line = useEditor((s) => (lineRef ? s.doc?.ocr?.[lineRef.pageId]?.lines.find((l) => l.id === lineRef.lineId) : undefined))
  return lineRef && line && tool === 'edit-content' ? { lineRef, line } : null
}

export function OcrLineProperties({ lineRef: ref, line }: { lineRef: OcrLineRef; line: OcrLine }) {
  const confidence = line.words.length ? line.words.reduce((n, w) => n + w.confidence, 0) / line.words.length : 0
  return (
    <aside className="ed-props" data-testid="properties-panel" data-mode="element" data-element-kind="ocr-line" aria-label="Recognized text properties">
      <h3 className="ed-props-title">Recognized text</h3>
      <div className="ed-prop-col">
        <span className="ed-prop-label">Text</span>
        <p className="ed-ocr-text" data-testid="ocr-line-text">
          {ocrLineText(line)}
        </p>
      </div>
      <p className="ed-prop-hint">Confidence {Math.round(confidence)}%. Searchable, and saved as invisible text over the scan.</p>
      <div className="ed-prop-actions">
        <button
          type="button"
          className="ed-action ed-action-wide"
          data-testid="ocr-make-editable"
          title="Cover this line in the scan and replace it with editable text"
          onClick={() => makeLineEditable(ref.pageId, ref.lineId)}
        >
          <Type size={15} aria-hidden="true" /> Make editable
        </button>
        <button
          type="button"
          className="ed-action ed-action-wide"
          data-testid="ocr-copy"
          title="Copy the recognized text"
          onClick={() => void copyLineText(ref.pageId, ref.lineId)}
        >
          <ClipboardCopy size={15} aria-hidden="true" /> Copy
        </button>
      </div>
    </aside>
  )
}
