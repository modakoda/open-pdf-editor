import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = {
  '@core': resolve(__dirname, 'src/core'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'core',
          environment: 'node',
          include: ['tests/core/**/*.test.ts'],
          testTimeout: 30000
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/main/**/*.test.ts']
        }
      },
      {
        resolve: { alias },
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/renderer/setup.ts'],
          testTimeout: 30000
        }
      }
    ]
  }
})
