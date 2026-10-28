/**
 * On-screen preview of the document-level watermark and page numbers (they are only drawn
 * into the PDF on export). Laid out in view space (the displayed, rotated page) to mirror
 * drawWatermark / drawPageNumber in src/core/exportDraw.ts.
 */
import type { CSSProperties } from 'react'
import { cssFontFamily, isWinAnsiEncodable } from '@core'
import { useEditor } from '@renderer/state/store'

function fontFor(text: string): string {
  try {
    return cssFontFamily('sans', !isWinAnsiEncodable(text))
  } catch {
    return 'Helvetica, Arial, sans-serif'
  }
}

export function formatPageNumberText(format: string, n: number, total: number): string {
  return format.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total))
}

export function Decorations({ index, scale }: { index: number; scale: number }) {
  const watermark = useEditor((s) => s.doc?.settings.watermark ?? null)
  const pageNumbers = useEditor((s) => s.doc?.settings.pageNumbers ?? null)
  const total = useEditor((s) => s.doc?.pages.length ?? 0)
  if (!watermark?.text.trim() && !pageNumbers) return null

  let numberEl = null
  if (pageNumbers) {
    const start = Number.isFinite(pageNumbers.startAt) ? pageNumbers.startAt : 1
    const text = formatPageNumberText(pageNumbers.format || '{n}', start + index, total).replace(/\s*\n\s*/g, ' ')
    const fontSize = (pageNumbers.fontSize > 0 ? pageNumbers.fontSize : 10) * scale
    const margin = (Number.isFinite(pageNumbers.margin) && pageNumbers.margin >= 0 ? pageNumbers.margin : 24) * scale
    const [vertical, horizontal] = pageNumbers.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right']
    const style: CSSProperties = {
      fontFamily: fontFor(text),
      fontSize,
      lineHeight: 0.93,
      color: pageNumbers.color,
      [vertical]: margin
    }
    if (horizontal === 'center') {
      style.left = '50%'
      style.transform = 'translateX(-50%)'
    } else style[horizontal] = margin
    numberEl = (
      <div className="decoration-page-number" data-testid="page-number-preview" style={style}>
        {text}
      </div>
    )
  }

  return (
    <div className="page-decorations" aria-hidden="true">
      {watermark && watermark.text.trim() && (
        <div
          className="decoration-watermark"
          data-testid="watermark-preview"
          style={{
            fontFamily: fontFor(watermark.text),
            fontSize: (watermark.fontSize > 0 ? watermark.fontSize : 48) * scale,
            color: watermark.color,
            opacity: Number.isFinite(watermark.opacity) ? watermark.opacity : 0.3,
            transform: `translate(-50%, -50%) rotate(${-(watermark.angle || 0)}deg)`
          }}
        >
          {watermark.text}
        </div>
      )}
      {numberEl}
    </div>
  )
}
