export { PageOverlay, type PageOverlayProps } from './PageOverlay'
export { PropertiesPanel } from './PropertiesPanel'
export { ToolPalette } from './ToolPalette'
export { useEditingShortcuts } from './useEditingShortcuts'
/** Helpers for the workspace (e.g. the "Delete" menu item when an object is selected). */
export { deleteSelected as deleteSelectedObject, duplicateSelected as duplicateSelectedObject } from './objects'
/** Delete whatever is selected: object, existing content item, annotation or form field. */
export { deleteSelection } from './selection'
/** Dispatched (bubbling, detail { pageId }) on the [data-testid=page] element after each canvas render. */
export { PAGE_RENDERED_EVENT } from './previews'
export { activateTool } from './tools'
export { useEditing } from './editingState'
/**
 * Field name check shared with the fields list: exact match or a dotted-prefix clash ("a" vs
 * "a.b") with effective fields of the primary source or FieldObjects.
 */
export { validateFieldName, namesClash } from './fields'
