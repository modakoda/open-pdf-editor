/** Zoom and navigation. */
import { ZOOM_MAX, ZOOM_MIN } from '@renderer/state/store'
import { currentPageIndex } from '@renderer/state/selectors'
import { editor } from './util'

export const ZOOM_PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = ZOOM_PRESETS.find((z) => z > zoom * 1.001)
    return Math.min(ZOOM_MAX, next ?? ZOOM_MAX)
  }
  const prev = [...ZOOM_PRESETS].reverse().find((z) => z < zoom / 1.001)
  return Math.max(ZOOM_MIN, prev ?? ZOOM_MIN)
}

export function zoomIn(): void {
  const { doc, zoom, setZoom } = editor()
  if (doc) setZoom(nextZoomStep(zoom, 1))
}

export function zoomOut(): void {
  const { doc, zoom, setZoom } = editor()
  if (doc) setZoom(nextZoomStep(zoom, -1))
}

export function zoomReset(): void {
  if (editor().doc) editor().setZoom(1)
}

export function fitWidth(): void {
  if (editor().doc) editor().setFitMode('width')
}

export function fitPage(): void {
  if (editor().doc) editor().setFitMode('page')
}

export function toggleSidebar(): void {
  editor().setSidebarOpen(!editor().sidebarOpen)
}

export function goToPageIndex(index: number): void {
  const { doc } = editor()
  if (!doc || !doc.pages.length) return
  const i = Math.min(doc.pages.length - 1, Math.max(0, index))
  editor().goToPage(doc.pages[i].id)
}

export function nextPage(): void {
  goToPageIndex(currentPageIndex(editor()) + 1)
}

export function previousPage(): void {
  goToPageIndex(currentPageIndex(editor()) - 1)
}

export function firstPage(): void {
  goToPageIndex(0)
}

export function lastPage(): void {
  const { doc } = editor()
  if (doc) goToPageIndex(doc.pages.length - 1)
}
