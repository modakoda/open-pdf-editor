import { InvalidPasswordError, PasswordRequiredError, type EditorDocument } from '@core'
import { useEditor } from '@renderer/state/store'

export const editor = () => useEditor.getState()

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  return 'Unknown error'
}

export function isPasswordRequiredError(err: unknown): boolean {
  return err instanceof PasswordRequiredError || (err instanceof Error && err.name === 'PasswordRequiredError')
}

export function isInvalidPasswordError(err: unknown): boolean {
  return err instanceof InvalidPasswordError || (err instanceof Error && err.name === 'InvalidPasswordError')
}

export function isPasswordError(err: unknown): boolean {
  return isPasswordRequiredError(err) || isInvalidPasswordError(err)
}

export function notifyError(prefix: string, err: unknown): void {
  console.error(prefix, err)
  editor().showNotice('error', `${prefix}: ${errorMessage(err)}`)
}

export function notifyInfo(text: string): void {
  editor().showNotice('info', text)
}

/**
 * Apply an undoable edit, reporting failures as an error notice instead of throwing.
 * Returns true if the edit was applied (or was a no-op).
 */
export function applyEdit(
  label: string,
  mutator: (doc: EditorDocument) => EditorDocument,
  options?: { coalesceKey?: string }
): boolean {
  try {
    editor().apply(mutator, options)
    return true
  } catch (err) {
    notifyError(`${label} failed`, err)
    return false
  }
}

/** Base name of a path ("C:\\docs\\a.pdf" → "a.pdf"). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** True when keyboard input currently goes to a text field (native undo/select-all apply). */
export function isEditableTarget(target: EventTarget | Element | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA') return !(target as HTMLTextAreaElement).readOnly
  if (tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type)
  }
  return false
}

export function isEditableFocused(): boolean {
  return typeof document !== 'undefined' && isEditableTarget(document.activeElement)
}

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Human-readable shortcut, e.g. shortcut('mod+shift+s') → "⇧⌘S" / "Ctrl+Shift+S". */
export function shortcutLabel(spec: string): string {
  const parts = spec.split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  const keyLabel = key.length === 1 ? key.toUpperCase() : key
  if (isMac) {
    return `${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('mod') ? '⌘' : ''}${keyLabel}`
  }
  return [mods.has('mod') && 'Ctrl', mods.has('alt') && 'Alt', mods.has('shift') && 'Shift', keyLabel]
    .filter(Boolean)
    .join('+')
}
