/// <reference types="vite/client" />
import type { DesktopApi } from '@shared/ipc'

declare global {
  interface Window {
    /** Provided by the Electron preload script; undefined when running in a plain browser. */
    desktop?: DesktopApi
  }
}

export {}
