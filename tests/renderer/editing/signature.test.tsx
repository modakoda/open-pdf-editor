import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditing } from '@renderer/editing/editingState'
import { ToolPalette } from '@renderer/editing/ToolPalette'
import { loadDoc, makeDoc, mockLayout, pngBytes, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))
const openImageDialog = vi.fn()
vi.mock('@renderer/platform', () => ({ platform: { openImageDialog: (...a: unknown[]) => openImageDialog(...a) } }))

/** Fake 2D context: every pixel inside `ink` (canvas px) is opaque. */
function installCanvasMock(ink = { x0: 300, y0: 150, x1: 899, y1: 449 }) {
  const calls: string[] = []
  const ctx = new Proxy(
    {
      measureText: (t: string) => ({ width: t.length * 30 }),
      getImageData: (x: number, y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++) {
            const px = x + i
            const py = y + j
            if (px >= ink.x0 && px <= ink.x1 && py >= ink.y0 && py <= ink.y1) data[(j * w + i) * 4 + 3] = 255
          }
        return { data, width: w, height: h }
      }
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.length})`)
        }
      },
      set(target, prop: string, value) {
        target[prop] = value
        return true
      }
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
    cb(new Blob([pngBytes(this.width, this.height) as BlobPart], { type: 'image/png' }))
  })
  return calls
}

beforeEach(() => {
  mockLayout()
  loadDoc(makeDoc())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ToolPalette', () => {
  it('renders every tool with an active state and switches tools', async () => {
    const user = userEvent.setup()
    render(<ToolPalette />)
    for (const id of ['select', 'hand', 'text', 'edit-text', 'image', 'signature', 'rect', 'ellipse', 'line', 'arrow', 'ink', 'highlight', 'whiteout', 'note']) {
      const btn = screen.getByTestId(`tool-${id}`)
      expect(btn).toHaveAttribute('title')
      expect(btn).toHaveAttribute('aria-label')
    }
    expect(screen.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByTestId('tool-rect'))
    expect(store().tool).toBe('rect')
    expect(screen.getByTestId('tool-rect')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('tool-edit-text').title).toMatch(/covered/i)
    // Quick options for the active tool.
    fireEvent.input(screen.getByTestId('tool-color'), { target: { value: '#ff0000' } })
    expect(store().toolOptions.color).toBe('#ff0000')
    await user.selectOptions(screen.getByTestId('tool-width'), '4')
    expect(store().toolOptions.strokeWidth).toBe(4)
  })

  it('image tool: picks a file, reads its size and sets the pending image', async () => {
    const user = userEvent.setup()
    openImageDialog.mockResolvedValue({ path: null, name: 'a.png', bytes: pngBytes(320, 240) })
    render(<ToolPalette />)
    await user.click(screen.getByTestId('tool-image'))
    await vi.waitFor(() => expect(store().pendingImage).not.toBeNull())
    expect(store().pendingImage).toMatchObject({ mimeType: 'image/png', width: 320, height: 240 })
    expect(store().tool).toBe('image')
  })

  it('image tool: cancelling the dialog returns to the select tool', async () => {
    const user = userEvent.setup()
    openImageDialog.mockResolvedValue(null)
    render(<ToolPalette />)
    await user.click(screen.getByTestId('tool-image'))
    await vi.waitFor(() => expect(openImageDialog).toHaveBeenCalled())
    await vi.waitFor(() => expect(store().tool).toBe('select'))
    expect(store().pendingImage).toBeNull()
  })

  it('image tool: rejects unsupported files with a notice', async () => {
    const user = userEvent.setup()
    openImageDialog.mockResolvedValue({ path: null, name: 'a.gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38]) })
    render(<ToolPalette />)
    await user.click(screen.getByTestId('tool-image'))
    await vi.waitFor(() => expect(store().notice?.kind).toBe('error'))
    expect(store().pendingImage).toBeNull()
  })
})

describe('SignatureDialog', () => {
  it('drawing a signature produces a trimmed transparent PNG as the pending image', async () => {
    const user = userEvent.setup()
    const calls = installCanvasMock()
    render(<ToolPalette />)
    await user.click(screen.getByTestId('tool-signature'))
    const dialog = screen.getByTestId('dialog')
    expect(dialog).toHaveAttribute('data-dialog', 'signature')
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()

    const pad = screen.getByTestId('signature-pad')
    const pts = [
      [100, 50],
      [150, 80],
      [200, 60],
      [300, 120]
    ]
    fireEvent.pointerDown(pad, { pointerId: 1, button: 0, clientX: pts[0][0], clientY: pts[0][1] })
    for (const [x, y] of pts.slice(1)) fireEvent.pointerMove(pad, { pointerId: 1, clientX: x, clientY: y })
    fireEvent.pointerUp(pad, { pointerId: 1, clientX: 300, clientY: 120 })
    expect(calls.some((c) => c.startsWith('quadraticCurveTo'))).toBe(true) // smoothed strokes
    expect(screen.getByTestId('dialog-confirm')).toBeEnabled()

    await user.click(screen.getByTestId('dialog-confirm'))
    await vi.waitFor(() => expect(store().pendingImage).not.toBeNull())
    const img = store().pendingImage!
    expect(img.mimeType).toBe('image/png')
    // Ink spans canvas px 300..899 × 150..449 at 3× → plus 12px padding each side.
    expect(img.width).toBeCloseTo((600 + 24) / 3)
    expect(img.height).toBeCloseTo((300 + 24) / 3)
    expect(Array.from(img.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(store().tool).toBe('signature')
    expect(screen.queryByTestId('dialog')).toBeNull()
    expect(useEditing.getState().signatureOpen).toBe(false)
  })

  it('typed signatures render the name; Clear and Cancel work', async () => {
    const user = userEvent.setup()
    const calls = installCanvasMock()
    render(<ToolPalette />)
    await user.click(screen.getByTestId('tool-signature'))
    const pad = screen.getByTestId('signature-pad')
    fireEvent.pointerDown(pad, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(pad, { pointerId: 1, clientX: 10, clientY: 10 })
    expect(screen.getByTestId('dialog-confirm')).toBeEnabled()
    await user.click(screen.getByTestId('signature-clear'))
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()

    await user.click(screen.getByTestId('signature-mode-type'))
    await user.type(screen.getByTestId('signature-name'), 'Jane Doe')
    await user.click(screen.getByTestId('dialog-confirm'))
    await vi.waitFor(() => expect(store().pendingImage).not.toBeNull())
    expect(calls.some((c) => c.startsWith('fillText'))).toBe(true)
    expect(store().tool).toBe('signature')

    act(() => store().setPendingImage(null))
    await user.click(screen.getByTestId('tool-signature'))
    await user.click(screen.getByTestId('dialog-cancel'))
    expect(screen.queryByTestId('dialog')).toBeNull()
    expect(store().pendingImage).toBeNull()
  })

  it('Escape closes the dialog', async () => {
    const user = userEvent.setup()
    installCanvasMock()
    render(<ToolPalette />)
    await user.click(screen.getByTestId('tool-signature'))
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Escape' })
    expect(screen.queryByTestId('dialog')).toBeNull()
  })
})
