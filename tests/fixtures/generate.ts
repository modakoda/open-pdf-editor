// Writes every fixture from pdfs.ts to tests/fixtures/generated/. Run: node tests/fixtures/generate.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES } from './pdfs.ts'
import { makeScannedPdf } from './scanned.ts'

/** Fixtures built from committed files (Node only, so not in pdfs.ts). */
export const FILE_FIXTURES = {
  'scanned.pdf': makeScannedPdf
} as const

export type GeneratedFixtureName = keyof typeof FIXTURES | keyof typeof FILE_FIXTURES

export async function generateFixtures(outDir = join(dirname(fileURLToPath(import.meta.url)), 'generated')): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  for (const [name, make] of Object.entries({ ...FIXTURES, ...FILE_FIXTURES })) {
    writeFileSync(join(outDir, name), await make())
  }
  return outDir
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateFixtures().then((dir) => console.log(`fixtures written to ${dir}`))
}
