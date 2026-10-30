/**
 * Modal dialog service. One dialog is shown at a time; `openDialog()` returns a promise that
 * resolves with the dialog's result (null when cancelled). Rendered by dialogs/DialogHost.tsx.
 */
import { create } from 'zustand'
import type { SourceDocument } from '@core'

export type ConfirmResult = 'confirm' | 'alt'

export type DialogRequest =
  | {
      kind: 'password'
      fileName: string
      /** Try a password. Resolves to null on success, or an error message to show. */
      submit: (password: string) => Promise<string | null>
    }
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmLabel?: string
      cancelLabel?: string
      /** Optional third button (e.g. "Save"); resolves to 'alt'. */
      altLabel?: string
      danger?: boolean
    }
  | { kind: 'properties' }
  | { kind: 'watermark' }
  | { kind: 'page-numbers' }
  | { kind: 'security' }
  | { kind: 'extract'; initialRange?: string }
  | { kind: 'split' }
  | { kind: 'insert'; source: SourceDocument }
  | { kind: 'about' }
  /** Digital signing; resolves with a SignRequest (state/signing.ts). */
  | { kind: 'sign' }

export type DialogKind = DialogRequest['kind']

export interface ActiveDialog {
  id: number
  request: DialogRequest
  resolve: (result: unknown) => void
}

interface DialogState {
  current: ActiveDialog | null
}

export const useDialogs = create<DialogState>()(() => ({ current: null }))

let nextId = 0

/** Show a dialog. Any dialog that is already open is cancelled (resolves to null). */
export function openDialog<R = unknown>(request: DialogRequest): Promise<R | null> {
  const prev = useDialogs.getState().current
  return new Promise<R | null>((resolve) => {
    const id = ++nextId
    useDialogs.setState({
      current: {
        id,
        request,
        resolve: (result) => {
          if (useDialogs.getState().current?.id === id) useDialogs.setState({ current: null })
          resolve(result as R | null)
        }
      }
    })
    prev?.resolve(null)
  })
}

/** Close the current dialog with `result` (null = cancelled). */
export function closeDialog(result: unknown = null): void {
  useDialogs.getState().current?.resolve(result)
}

export function isDialogOpen(): boolean {
  return useDialogs.getState().current !== null
}

/** Yes/no confirmation. Resolves true when confirmed. */
export async function confirmDialog(options: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return (await openDialog<ConfirmResult>({ kind: 'confirm', ...options })) === 'confirm'
}
