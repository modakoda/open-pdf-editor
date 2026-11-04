/** Focus handling for pointer input on pages. */

/**
 * A press on a page takes the keyboard: an edited field commits (blur), and focus leaves the
 * sidebar or toolbar, whose own keys (Delete removes pages, typing edits a toolbar field…)
 * would otherwise take the keys meant for what was just selected on the page.
 */
export function releaseFocusForPage(): void {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return
  const editable = el.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  if (editable || !el.closest('.ed-overlay')) el.blur()
}
