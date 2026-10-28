/**
 * IPC channels used only between the preload script and the main process (not part of the
 * renderer-facing DesktopApi contract in src/shared/ipc.ts).
 */
export const INTERNAL_IPC = {
  /** preload → main: path of a File the user dropped/picked (from webUtils.getPathForFile). */
  grantDroppedPath: 'internal:grant-dropped-path'
} as const
