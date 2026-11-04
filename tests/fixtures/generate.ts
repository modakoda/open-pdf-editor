// Writes every fixture from pdfs.ts to tests/fixtures/generated/. Run: node tests/fixtures/generate.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES, type FixtureFonts } from './pdfs.ts'
import { makeScannedPdf } from './scanned.ts'

/** Fixtures built from committed files (Node only, so not in pdfs.ts). */
export const FILE_FIXTURES = {
  'scanned.pdf': makeScannedPdf
} as const

export type GeneratedFixtureName = keyof typeof FIXTURES | keyof typeof FILE_FIXTURES

const HERE = dirname(fileURLToPath(import.meta.url))

export async function generateFixtures(outDir = join(HERE, 'generated')): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const font = (file: string) => new Uint8Array(readFileSync(join(HERE, '../../resources/fonts', file)))
  const fonts: FixtureFonts = { regular: font('Inter-Regular.ttf'), bold: font('Inter-SemiBold.ttf') }
  for (const [name, make] of Object.entries(FIXTURES)) {
    writeFileSync(join(outDir, name), await make(fonts))
  }
  for (const [name, make] of Object.entries(FILE_FIXTURES)) {
    writeFileSync(join(outDir, name), await make())
  }
  return outDir
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateFixtures().then((dir) => console.log(`fixtures written to ${dir}`))
}
