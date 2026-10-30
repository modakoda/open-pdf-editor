/**
 * Signature pad: draw with the pointer or type a name. Produces a trimmed transparent PNG that
 * becomes the store's pendingImage; the next click on a page places it (tool 'signature').
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, PenLine, Type, X } from 'lucide-react'
import type { Point } from '@core'
import { useEditor, type PendingImage } from '@renderer/state/store'
import './SignatureDialog.css'

const PAD_W = 480
const PAD_H = 180
/** Export resolution multiplier (CSS px → PNG px). */
const EXPORT_SCALE = 3

export const SIGNATURE_COLORS = ['#111827', '#1d4ed8', '#7f1d1d']

export const SIGNATURE_FONTS = [
  {
    id: 'script',
    label: 'Script',
    css: '"Snell Roundhand", "Segoe Script", "Apple Chancery", "URW Chancery L", "Z003", "Brush Script MT", cursive'
  },
  {
    id: 'hand',
    label: 'Handwriting',
    css: '"Bradley Hand", "Segoe Print", "Lucida Handwriting", "Comic Neue", "Chalkboard SE", cursive'
  },
  {
    id: 'formal',
    label: 'Formal',
    css: '"Zapfino", "Edwardian Script ITC", "Lucida Calligraphy", "Palace Script MT", "URW Chancery L", cursive'
  }
] as const

type FontId = (typeof SIGNATURE_FONTS)[number]['id']

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Point[][], color: string, width: number): void {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const pts of strokes) {
    if (!pts.length) continue
    ctx.beginPath()
    if (pts.length === 1) {
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2
      const my = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x, last.y)
    ctx.stroke()
  }
}

/** Crop a canvas to its non-transparent pixels (plus padding). Null if it is empty. */
export function trimCanvas(src: HTMLCanvasElement, pad: number): HTMLCanvasElement | null {
  const ctx = src.getContext('2d')
  if (!ctx) return null
  const { width, height } = src
  const data = ctx.getImageData(0, 0, width, height).data
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  const out = document.createElement('canvas')
  out.width = maxX - minX + 1
  out.height = maxY - minY + 1
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return out
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not encode the signature')
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

export type SignatureInput =
  | { mode: 'draw'; strokes: Point[][]; color: string; width: number }
  | { mode: 'type'; name: string; fontCss: string; color: string }

/** Render the signature at high resolution and export it as a trimmed transparent PNG. */
export async function renderSignature(input: SignatureInput): Promise<PendingImage | null> {
  const canvas = document.createElement('canvas')
  const s = EXPORT_SCALE
  let ctx: CanvasRenderingContext2D | null
  if (input.mode === 'draw') {
    if (!input.strokes.some((st) => st.length)) return null
    canvas.width = PAD_W * s
    canvas.height = PAD_H * s
    ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(s, s)
    drawStrokes(ctx, input.strokes, input.color, input.width)
  } else {
    const name = input.name.trim()
    if (!name) return null
    const fontSize = 56
    const font = `${fontSize}px ${input.fontCss}`
    const measureCtx = canvas.getContext('2d')
    if (!measureCtx) return null
    measureCtx.font = font
    const textW = Math.ceil(measureCtx.measureText(name).width) || name.length * fontSize * 0.5
    canvas.width = (textW + fontSize) * s
    canvas.height = fontSize * 2 * s
    ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(s, s)
    ctx.font = font
    ctx.fillStyle = input.color
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(name, fontSize / 2, fontSize * 1.3)
  }
  const trimmed = trimCanvas(canvas, 4 * s)
  if (!trimmed) return null
  const data = await canvasToPng(trimmed)
  return { data, mimeType: 'image/png', width: trimmed.width / s, height: trimmed.height / s }
}

export interface SignatureDialogProps {
  onClose(): void
  /** Receives the signature image instead of placing it with the Signature tool. */
  onCreate?(image: PendingImage): void
  /** Confirm button label (default "Use signature"). */
  confirmLabel?: string
}

export function SignatureDialog({ onClose, onCreate, confirmLabel = 'Use signature' }: SignatureDialogProps) {
  const [mode, setMode] = useState<'draw' | 'type'>('draw')
  const [strokes, setStrokes] = useState<Point[][]>([])
  const [color, setColor] = useState(SIGNATURE_COLORS[0])
  const [width, setWidth] = useState(2.5)
  const [name, setName] = useState('')
  const [fontId, setFontId] = useState<FontId>('script')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const current = useRef<{ pointerId: number; points: Point[] } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const fontCss = SIGNATURE_FONTS.find((f) => f.id === fontId)!.css
  const canConfirm = !busy && (mode === 'draw' ? strokes.length > 0 : name.trim().length > 0)

  const redraw = useCallback(
    (extra?: Point[]) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, PAD_W, PAD_H)
      drawStrokes(ctx, extra ? [...strokes, extra] : strokes, color, width)
    },
    [strokes, color, width]
  )

  useEffect(() => {
    if (mode !== 'draw') return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = PAD_W * dpr
    canvas.height = PAD_H * dpr
    redraw()
  }, [mode, redraw])

  useEffect(() => {
    const el = dialogRef.current
    ;(el?.querySelector<HTMLElement>('[data-autofocus]') ?? el)?.focus()
  }, [mode])

  const padPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect()
    const sx = r.width ? PAD_W / r.width : 1
    const sy = r.height ? PAD_H / r.height : 1
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }
  }

  const confirm = async () => {
    if (!canConfirm) return
    setBusy(true)
    try {
      const img = await renderSignature(
        mode === 'draw' ? { mode, strokes, color, width } : { mode, name, fontCss, color }
      )
      const s = useEditor.getState()
      if (!img) {
        s.showNotice('error', 'The signature is empty.')
        setBusy(false)
        return
      }
      if (onCreate) {
        onCreate(img)
        onClose()
        return
      }
      s.setPendingImage(img)
      s.setTool('signature')
      s.showNotice('info', 'Click on a page to place the signature (Esc to cancel).')
      onClose()
    } catch (err) {
      useEditor.getState().showNotice('error', `Could not create the signature: ${(err as Error).message}`)
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="ed-dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="ed-dialog ed-signature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ed-signature-title"
        data-testid="dialog"
        data-dialog="signature"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="ed-dialog-header">
          <h2 id="ed-signature-title">Add signature</h2>
          <button type="button" className="ed-icon-btn" aria-label="Close" title="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="ed-segmented" role="tablist" aria-label="Signature mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'draw'}
            data-testid="signature-mode-draw"
            className={mode === 'draw' ? 'active' : ''}
            onClick={() => setMode('draw')}
          >
            <PenLine size={14} aria-hidden="true" /> Draw
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'type'}
            data-testid="signature-mode-type"
            className={mode === 'type' ? 'active' : ''}
            onClick={() => setMode('type')}
          >
            <Type size={14} aria-hidden="true" /> Type
          </button>
        </div>

        {mode === 'draw' ? (
          <canvas
            ref={canvasRef}
            className="ed-signature-pad"
            data-testid="signature-pad"
            aria-label="Signature drawing area"
            style={{ width: PAD_W, height: PAD_H }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              try {
                e.currentTarget.setPointerCapture?.(e.pointerId)
              } catch {
                /* ignore */
              }
              current.current = { pointerId: e.pointerId, points: [padPoint(e)] }
              redraw(current.current.points)
            }}
            onPointerMove={(e) => {
              const c = current.current
              if (!c || c.pointerId !== e.pointerId) return
              const p = padPoint(e)
              const last = c.points[c.points.length - 1]
              if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return
              c.points.push(p)
              redraw(c.points)
            }}
            onPointerUp={(e) => {
              const c = current.current
              if (!c || c.pointerId !== e.pointerId) return
              current.current = null
              setStrokes((s) => [...s, c.points])
            }}
            onPointerCancel={() => {
              current.current = null
              redraw()
            }}
          />
        ) : (
          <div className="ed-signature-type">
            <input
              data-testid="signature-name"
              data-autofocus=""
              aria-label="Your name"
              placeholder="Type your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void confirm()
                }
              }}
            />
            <div className="ed-signature-preview" style={{ fontFamily: fontCss, color }} aria-hidden="true">
              {name || 'Your name'}
            </div>
            <div className="ed-segmented" role="radiogroup" aria-label="Signature style">
              {SIGNATURE_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={fontId === f.id}
                  className={fontId === f.id ? 'active' : ''}
                  style={{ fontFamily: f.css }}
                  onClick={() => setFontId(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="ed-signature-controls">
          <div className="ed-swatches" role="radiogroup" aria-label="Ink color">
            {SIGNATURE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`Color ${c}`}
                title={c}
                className={`ed-swatch${color === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          {mode === 'draw' && (
            <label className="ed-signature-width">
              Width
              <input
                type="range"
                min={1}
                max={8}
                step={0.5}
                value={width}
                aria-label="Stroke width"
                onChange={(e) => setWidth(Number(e.target.value))}
              />
            </label>
          )}
          {mode === 'draw' && (
            <button
              type="button"
              className="ed-btn"
              data-testid="signature-clear"
              disabled={!strokes.length}
              onClick={() => setStrokes([])}
            >
              <Eraser size={14} aria-hidden="true" /> Clear
            </button>
          )}
        </div>

        <div className="ed-dialog-footer">
          <button type="button" className="ed-btn" data-testid="dialog-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ed-btn ed-btn-primary"
            data-testid="dialog-confirm"
            disabled={!canConfirm}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
