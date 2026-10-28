/**
 * pdf.js does not run in jsdom. Use with:
 *   vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)
 */
import { vi } from 'vitest'

export interface FakeViewport {
  width: number
  height: number
  scale: number
  rotation: number
  convertToViewportPoint(x: number, y: number): [number, number]
}

export function fakeViewport({ scale = 1, rotation = 0 }: { scale?: number; rotation?: number }): FakeViewport {
  const swap = rotation === 90 || rotation === 270
  const w = 600 * scale
  const h = 800 * scale
  return {
    width: swap ? h : w,
    height: swap ? w : h,
    scale,
    rotation,
    convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale]
  }
}

export const renderCalls: { rotation: number; scale: number; annotationMode: unknown; preview?: boolean }[] = []

export const fakePage = {
  getViewport: vi.fn(fakeViewport),
  render: vi.fn((params: { viewport: FakeViewport; annotationMode?: unknown }) => {
    renderCalls.push({ rotation: params.viewport.rotation, scale: params.viewport.scale, annotationMode: params.annotationMode })
    return { promise: Promise.resolve(), cancel: vi.fn() }
  }),
  getTextContent: vi.fn(async () => ({
    items: [{ str: 'Hello world', transform: [12, 0, 0, 12, 72, 700], width: 66, height: 12, hasEOL: true }]
  }))
}

/** Page 1 of every document opened with openPdfBytes (previews, print). */
export const fakePreviewPage = {
  getViewport: vi.fn(fakeViewport),
  render: vi.fn((params: { viewport: FakeViewport; annotationMode?: unknown }) => {
    renderCalls.push({
      rotation: params.viewport.rotation,
      scale: params.viewport.scale,
      annotationMode: params.annotationMode,
      preview: true
    })
    return { promise: Promise.resolve(), cancel: vi.fn() }
  }),
  getTextContent: vi.fn(async () => ({
    items: [{ str: 'Edited words', transform: [12, 0, 0, 12, 72, 700], width: 70, height: 12, hasEOL: true }]
  }))
}

export const openedTasks: { bytes: Uint8Array; destroy: ReturnType<typeof vi.fn> }[] = []

export const pdfjsModule = {
  pdfjs: { AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 } },
  getPdfPage: vi.fn(async () => fakePage),
  getPdfDocument: vi.fn(async () => ({ numPages: 1, getPage: async () => fakePage })),
  openPdfBytes: vi.fn((bytes: Uint8Array) => {
    const task = {
      bytes,
      promise: Promise.resolve({ numPages: 1, getPage: async () => fakePreviewPage }),
      destroy: vi.fn(async () => undefined)
    }
    openedTasks.push(task)
    return task
  }),
  releaseSources: vi.fn()
}
