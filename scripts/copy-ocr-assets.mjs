// Copies the text recognition (OCR) runtime into the renderer's public folder so it is served
// next to the app (dev and production, also offline): the tesseract.js worker, the Tesseract
// WebAssembly core (LSTM-only builds, with and without SIMD) and the English and Lithuanian
// recognition data, plus their licenses.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(root, 'node_modules')
const dest = join(root, 'src', 'renderer', 'public', 'ocr')

/** [source relative to node_modules, file name in public/ocr] */
const FILES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js/dist/worker.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt'],
  ['tesseract.js/LICENSE.md', 'LICENSE-tesseract.js.md'],
  ['tesseract.js-core/tesseract-core-simd-lstm.js', 'tesseract-core-simd-lstm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-lstm.js', 'tesseract-core-lstm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  ['tesseract.js-core/LICENSE', 'LICENSE-tesseract.js-core.txt'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
  ['@tesseract.js-data/lit/4.0.0_best_int/lit.traineddata.gz', 'lit.traineddata.gz']
]

const NOTICE = `Text recognition (OCR) components bundled with Open PDF Editor

- tesseract.js (worker.min.js) — Apache License 2.0, see LICENSE-tesseract.js.md.
  Bundled libraries are listed in worker.min.js.LICENSE.txt (MIT / BSD-3-Clause).
- tesseract.js-core (tesseract-core-*.js / .wasm): Tesseract OCR compiled to WebAssembly —
  Apache License 2.0, see LICENSE-tesseract.js-core.txt. Includes Leptonica (BSD 2-Clause).
- eng.traineddata.gz, lit.traineddata.gz: Tesseract "tessdata_best" models (integer version)
  from https://github.com/tesseract-ocr/tessdata_best, Apache License 2.0, distributed through
  the @tesseract.js-data packages (MIT).
`

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const [from, to] of FILES) {
  const src = join(modules, from)
  if (!existsSync(src)) throw new Error(`OCR asset missing: ${src} (run npm install)`)
  copyFileSync(src, join(dest, to))
}
writeFileSync(join(dest, 'NOTICE.txt'), NOTICE)
console.log(`OCR assets copied to ${dest}`)
