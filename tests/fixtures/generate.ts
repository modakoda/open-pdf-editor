// Writes every fixture from pdfs.ts to tests/fixtures/generated/. Run: node tests/fixtures/generate.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES } from './pdfs.ts'

export async function generateFixtures(outDir = join(dirname(fileURLToPath(import.meta.url)), 'generated')): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  for (const [name, make] of Object.entries(FIXTURES)) {
    writeFileSync(join(outDir, name), await make())
  }
  return outDir
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateFixtures().then((dir) => console.log(`fixtures written to ${dir}`))
}
