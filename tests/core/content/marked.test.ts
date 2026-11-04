import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib'
import { OPE_MARK, applyContentEdits, listContentItems, stripMarkedContent } from '../../../src/core/content'
import { visibleBox } from '../../../src/core/pdf'
import { pageContent } from '../helpers'
import { addStdFont, byText, edit, listItems, pdfFromContent, pdfjsText, testHelpers } from './helpers'
import { makeMarkedPdf } from './fixtures'

async function strip(bytes: Uint8Array, ids?: Set<string>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  stripMarkedContent(doc, doc.getPage(0), ids)
  return doc.save()
}

describe('OPEObject marked content', () => {
  it('exports the marker tag', () => {
    expect(OPE_MARK).toBe('OPEObject')
  })

  it('lists items inside sections with an @<id>/ prefix unless skipped', async () => {
    const bytes = await makeMarkedPdf()
    const all = await listItems(bytes)
    expect(all.map((i) => i.id)).toEqual(['t3', '@obj_a/p3', '@obj_a/t7', 'p7', '@obj_b/p4', 't11'])
    const skipped = await listItems(bytes, 0, new Set(['obj_a', 'obj_b']))
    expect(skipped.map((i) => i.id)).toEqual(['t3', 'p7', 't11'])
    const one = await listItems(bytes, 0, new Set(['obj_b']))
    expect(one.map((i) => i.id)).toEqual(['t3', '@obj_a/p3', '@obj_a/t7', 'p7', 't11'])
  })

  it('strips all sections, keeping the rest byte-identical', async () => {
    const bytes = await makeMarkedPdf()
    const out = await strip(bytes)
    const before = await pageContent(bytes, 0)
    const after = await pageContent(out, 0)
    const expected = before.replace(/\/OPEObject <<\/Id \(obj_a\)>> BDC.*?Q EMC/, '').replace(/\/OPEObject <<\/Id \(obj_b\)>> BDC.*?EMC Q EMC/, '')
    expect(after).toBe(expected)
    expect((await pdfjsText(out)).map((t) => t.str)).toEqual(['Before', 'After'])
    // Ids of the other items do not change.
    expect((await listItems(out)).map((i) => i.id)).toEqual(['t3', 'p7', 't11'])
  })

  it('strips only the given ids (nested marked content inside is removed with it)', async () => {
    const bytes = await makeMarkedPdf()
    const out = await strip(bytes, new Set(['obj_b']))
    const items = await listItems(out)
    expect(items.map((i) => i.id)).toEqual(['t3', '@obj_a/p3', '@obj_a/t7', 'p7', 't11'])
    expect(await pageContent(out, 0)).not.toContain('/Span BMC')
  })

  it('leaves pages without sections untouched', async () => {
    const bytes = await pdfFromContent('BT /F1 12 Tf 72 700 Td (Plain) Tj ET', async (doc, page) => {
      await addStdFont(doc, page, 'F1', StandardFonts.Helvetica)
      return {}
    })
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const contentsBefore = page.node.get(page.node.context.obj('Contents') as never)
    stripMarkedContent(doc, page)
    expect(page.node.get(page.node.context.obj('Contents') as never)).toBe(contentsBefore)
  })

  it('reads section ids from /Properties resources and UTF-16 strings', async () => {
    const bytes = await pdfFromContent(
      '/OPEObject /MC0 BDC 1 0 0 rg 10 10 20 20 re f EMC /OPEObject <</Id <FEFF0105>>> BDC 0 0 1 rg 50 50 20 20 re f EMC 0 g 100 100 5 5 re f',
      async (doc, page) => {
        const ctx = doc.context
        page.node.Resources()!.set(ctx.obj('Properties') as never, ctx.obj({ MC0: { Id: ctx.obj('obj_props') as never } }))
        return {}
      }
    )
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const ids = listContentItems(doc, page, visibleBox(page)).map((i) => i.id)
    // Sections are numbered on their own and do not count in the page numbering.
    expect(ids).toEqual(['@obj_props/p2', '@ą/p2', 'p2'])
    expect(listContentItems(doc, page, visibleBox(page), new Set(['obj_props', 'ą'])).map((i) => i.kind)).toEqual(['path'])
  })

  it('works with edits in either order (strip before or after applyContentEdits)', async () => {
    const bytes = await makeMarkedPdf()
    const skip = new Set(['obj_a', 'obj_b'])
    const items = await listItems(bytes, 0, skip)
    const target = byText(items, 'After')
    const run = async (stripFirst: boolean) => {
      const doc = await PDFDocument.load(bytes)
      const page = doc.getPage(0)
      if (stripFirst) stripMarkedContent(doc, page, skip)
      await applyContentEdits(doc, page, visibleBox(page), [{ itemId: target.id, transform: [1, 0, 0, 1, 0, -100] }], testHelpers(doc), skip)
      if (!stripFirst) stripMarkedContent(doc, page, skip)
      return pdfjsText(await doc.save())
    }
    for (const stripFirst of [true, false]) {
      const pj = await run(stripFirst)
      expect(pj.map((p) => p.str)).toEqual(['Before', 'After'])
      expect(pj[1].y).toBeCloseTo(target.origin!.y - 100, 2)
    }
  })

  it('edits items inside a non-skipped section', async () => {
    const bytes = await makeMarkedPdf()
    const out = await edit(bytes, [{ itemId: '@obj_a/t7', deleted: true }])
    expect((await pdfjsText(out)).map((p) => p.str)).toEqual(['Before', 'After'])
  })
})
