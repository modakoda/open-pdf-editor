// Runs the renderer in a plain browser (no Electron) for fast UI iteration and browser-based
// tests. Desktop-only features fall back to file inputs / downloads (src/renderer/src/platform).
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react()],
  server: { fs: { allow: [resolve(__dirname)] } },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true }
})
