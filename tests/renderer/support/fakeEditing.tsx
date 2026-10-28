/**
 * Stand-in for the editing layer so workspace tests do not depend on it. Use with:
 *   vi.mock('@renderer/editing', async () => (await import('./support/fakeEditing')).editingModule)
 */
import { vi } from 'vitest'
import type { PageEntry } from '@core'
import { useEditor } from '@renderer/state/store'

/** The editing layer's deleteSelection(): a spy (returns true when something was selected). */
export const deleteSelectionSpy = vi.fn((): boolean => {
  const s = useEditor.getState()
  if (!s.selectedObjectId && !s.selectedElement) return false
  s.selectObject(null)
  s.selectElement(null)
  return true
})

export const editingModule = {
  deleteSelection: deleteSelectionSpy,
  PAGE_RENDERED_EVENT: 'ope:page-rendered',
  PageOverlay: ({ page, pageIndex, scale }: { page: PageEntry; pageIndex: number; scale: number }) => (
    <div data-testid="page-overlay" data-page-id={page.id} data-page-index={pageIndex} data-scale={scale} />
  ),
  PropertiesPanel: () => null,
  ToolPalette: () => <div data-testid="tool-palette" />,
  useEditingShortcuts: () => undefined
}
