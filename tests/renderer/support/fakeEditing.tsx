/**
 * Stand-in for the editing layer so workspace tests do not depend on it. Use with:
 *   vi.mock('@renderer/editing', async () => (await import('./support/fakeEditing')).editingModule)
 */
import type { PageEntry } from '@core'

export const editingModule = {
  PageOverlay: ({ page, pageIndex, scale }: { page: PageEntry; pageIndex: number; scale: number }) => (
    <div data-testid="page-overlay" data-page-id={page.id} data-page-index={pageIndex} data-scale={scale} />
  ),
  PropertiesPanel: () => null,
  ToolPalette: () => <div data-testid="tool-palette" />,
  useEditingShortcuts: () => undefined
}
