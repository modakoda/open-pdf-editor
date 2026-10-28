import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@core': resolve(__dirname, 'src/core'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: { outDir: 'out/main' }
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})
