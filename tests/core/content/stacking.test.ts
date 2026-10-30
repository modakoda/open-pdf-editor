/**
 * Every item of the content-engine fixtures, moved or re-ordered on its own: the rest of the
 * page must stay exactly as it was (same items, same places, same order) and the content must
 * stay balanced and readable by pdf.js.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { ContentItem } from '../../../src/core/model'
import { pageContent, registerTestFonts } from '../helpers'
import { edit, listItems, pdfjsText } from './helpers'
import {
  makeCroppedPdf,
  makeDifferencesPdf,
  makeFormWrappedPdf,
  makeGarbagePdf,
  makeInlineImagePdf,
  makeMarkedPdf,
  makeMixedPdf,
  makeTextOpsPdf,
  makeType3Pdf
} from './fixtures'

const FIXTURES: Record<string, () => Promise<Uint8Array>> = {
  mixed: makeMixedPdf,
  textOps: makeTextOpsPdf,
  type3: makeType3Pdf,
  inlineImage: makeInlineImagePdf,
  formWrapped: () => makeFormWrappedPdf(),
  garbage: makeGarbagePdf,
  marked: makeMarkedPdf,
  cropped: makeCroppedPdf,
  differences: makeDifferencesPdf
}

const sig = (i: ContentItem) => `${i.kind}|${i.text ?? ''}|${i.color ?? ''}|${JSON.stringify(i.bounds)}`
/** Form XObjects with edited items get an enlarged /BBox (room for moved items): compared without bounds. */
const sigs = (list: ContentItem[], nested: boolean) => list.map((i) => (nested && i.kind === 'xobject' ? i.kind : sig(i)))
/** Words pdf.js extracts (it may group them differently when an item is drawn on its own). */
const words = async (bytes: Uint8Array) => (await pdfjsText(bytes)).flatMap((t) => t.str.split(/\s+/)).filter(Boolean).sort()

function balancedOps(content: string): boolean {
  // Literal strings and inline image data are not operators.
  const ops = content.replace(/\((?:\\.|[^\\)])*\)/g, ' ').replace(/\bID\b[^]*?\bEI\b/g, ' ').split(/\s+/)
  let q = 0
  let bt = 0
  let mc = 0
  for (const o of ops) {
    if (o === 'q') q++
    else if (o === 'Q') q--
    else if (o === 'BT') bt++
    else if (o === 'ET') bt--
    else if (o === 'BDC' || o === 'BMC') mc++
    else if (o === 'EMC') mc--
    if (q < 0 || bt < 0 || bt > 1 || mc < 0) return false
  }
  return q === 0 && bt === 0 && mc === 0
}

beforeAll(() => registerTestFonts())

describe('stacking order of every fixture item', () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    it(`${name}: a moved item keeps its place among the others`, async () => {
      const bytes = await make()
      const items = await listItems(bytes)
      const editable = items.filter((i) => !i.readOnly)
      const text = await words(bytes)
      for (const item of editable) {
        const out = await edit(bytes, [{ itemId: item.id, transform: [1, 0, 0, 1, 3, 2] }])
        const content = await pageContent(out, 0)
        expect(balancedOps(content), `${item.id}: ${content}`).toBe(true)
        const after = await listItems(out)
        // The others: same items in the same order and places (a moved form XObject moves the
        // items inside it).
        const nested = item.id.includes('/')
        const moved = after.find((i) => i.kind === item.kind && i.text === item.text && Math.abs(i.bounds.x - item.bounds.x - 3) < 0.01)
        expect(moved, item.id).toBeDefined()
        const others = (list: ContentItem[], skip: ContentItem) => sigs(list.filter((i) => i !== skip), nested)
        if (item.kind !== 'xobject') expect(others(after, moved!), item.id).toEqual(others(items, item))
        // pdf.js reads the same text.
        expect(await words(out), item.id).toEqual(text)
      }
    })

    it(`${name}: every item can be sent to the back and brought to the front`, async () => {
      const bytes = await make()
      const items = await listItems(bytes)
      for (const item of items.filter((i) => !i.readOnly)) {
        for (const z of [-1, items.length]) {
          const out = await edit(bytes, [{ itemId: item.id, z }])
          expect(balancedOps(await pageContent(out, 0)), `${item.id} z=${z}`).toBe(true)
          const nested = item.id.includes('/')
          expect(sigs(await listItems(out), nested).sort(), `${item.id} z=${z}`).toEqual(sigs(items, nested).sort())
        }
      }
    })
  }
})
