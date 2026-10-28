import { beforeAll, describe, expect, it } from 'vitest'
import {
  PAGE_SIZES,
  addObject,
  createBlankDocument,
  deletePages,
  duplicatePages,
  getFormValue,
  getObjectsForPage,
  insertBlankPage,
  insertSourcePages,
  loadSource,
  movePages,
  openDocument,
  removeObject,
  reorderObject,
  rotatePages,
  setFormValue,
  updateObject,
  updateSettings,
  type EditObject,
  type EditorDocument,
  type ShapeObject,
  type SourceDocument
} from '../../src/core'
import { makeFormPdf, makeMixedSizesPdf, makeRotatedPdf, makeTextPdf } from '../fixtures/pdfs'
import { deepFreeze } from './helpers'

type Rect = ShapeObject

function rect(id: string, pageId: string, extra: Partial<Rect> = {}): Rect {
  return {
    id,
    pageId,
    type: 'rect',
    x: 10,
    y: 10,
    width: 50,
    height: 20,
    strokeColor: '#000000',
    fillColor: null,
    strokeWidth: 1,
    rotation: 0,
    ...extra
  }
}

let base: EditorDocument
let mixed: SourceDocument
let rotatedSource: SourceDocument

beforeAll(async () => {
  base = await openDocument(await makeTextPdf(4), 'four.pdf')
  base = addObject(base, rect('a', base.pages[0].id))
  base = addObject(base, rect('b', base.pages[1].id))
  base = addObject(base, rect('c', base.pages[1].id))
  deepFreeze(base)
  mixed = await loadSource(await makeMixedSizesPdf(), 'mixed.pdf')
  rotatedSource = await loadSource(await makeRotatedPdf(), 'rotated.pdf')
  deepFreeze(mixed)
  deepFreeze(rotatedSource)
})

const ids = (doc: EditorDocument) => doc.pages.map((p) => p.id)

describe('page operations', () => {
  it('rotatePages rotates only the given pages, normalizing to 0..270', () => {
    const [p0, p1] = base.pages
    let doc = rotatePages(base, [p0.id], 90)
    expect(doc).not.toBe(base)
    expect(doc.pages[0].rotation).toBe(90)
    expect(doc.pages[1]).toBe(p1) // unchanged pages are shared
    doc = rotatePages(doc, [p0.id, p1.id], -180)
    expect(doc.pages[0].rotation).toBe(270)
    expect(doc.pages[1].rotation).toBe(180)
    doc = rotatePages(doc, [p0.id], 450)
    expect(doc.pages[0].rotation).toBe(0)
    expect(base.pages[0].rotation).toBe(0)
  })

  it('deletePages removes pages and their objects', () => {
    const doc = deletePages(base, [base.pages[1].id])
    expect(doc.pages).toHaveLength(3)
    expect(doc.objects.map((o) => o.id)).toEqual(['a'])
    expect(base.pages).toHaveLength(4)
    const empty = deletePages(base, ids(base))
    expect(empty.pages).toEqual([])
    expect(empty.objects).toEqual([])
  })

  it('movePages keeps relative order and clamps the target', () => {
    const [a, b, c, d] = ids(base)
    expect(ids(movePages(base, [d], 0))).toEqual([d, a, b, c])
    expect(ids(movePages(base, [a, c], 1))).toEqual([b, a, c, d])
    expect(ids(movePages(base, [c, a], 1))).toEqual([b, a, c, d])
    expect(ids(movePages(base, [a], 99))).toEqual([b, c, d, a])
    expect(ids(movePages(base, [d], -5))).toEqual([d, a, b, c])
    expect(ids(movePages(base, [b, c], 2))).toEqual([a, d, b, c])
  })

  it('insertBlankPage uses the neighbour size, explicit size or A4', () => {
    const { doc, page } = insertBlankPage(base, 2)
    expect(doc.pages[2]).toBe(page)
    expect(page.source).toEqual({ kind: 'blank' })
    expect(page.width).toBe(base.pages[1].width)
    expect(page.height).toBe(base.pages[1].height)
    expect(page.rotation).toBe(0)
    expect(page.baseRotation).toBe(0)

    const sized = insertBlankPage(base, 0, { width: 100, height: 200 })
    expect(sized.doc.pages[0].width).toBe(100)
    expect(sized.page.height).toBe(200)

    const empty = deletePages(base, ids(base))
    const a4 = insertBlankPage(empty, 5)
    expect(a4.doc.pages).toHaveLength(1)
    expect(a4.page.width).toBe(PAGE_SIZES.A4.width)

    // The displayed size of a rotated neighbour is used.
    const rotated = rotatePages(base, [base.pages[0].id], 90)
    const next = insertBlankPage(rotated, 1).page
    expect(next.width).toBe(base.pages[0].height)
    expect(next.height).toBe(base.pages[0].width)
  })

  it('duplicatePages inserts copies after originals with copied objects', () => {
    const doc = duplicatePages(base, [base.pages[1].id, base.pages[3].id])
    expect(doc.pages).toHaveLength(6)
    const [p0, p1, copy1, p2, p3, copy3] = doc.pages
    expect([p0.id, p1.id, p2.id, p3.id]).toEqual(ids(base))
    expect(copy1.id).not.toBe(p1.id)
    expect(copy1.source).toEqual(p1.source)
    expect(copy3.source).toEqual(p3.source)
    const copies = getObjectsForPage(doc, copy1.id)
    expect(copies).toHaveLength(2)
    expect(copies.map((o) => o.id)).not.toContain('b')
    expect(new Set(doc.objects.map((o) => o.id)).size).toBe(doc.objects.length)
    expect(getObjectsForPage(doc, p1.id).map((o) => o.id)).toEqual(['b', 'c'])
  })

  it('insertSourcePages registers the source and uses its page geometry', () => {
    const doc = insertSourcePages(base, mixed, 1)
    expect(doc.sources[mixed.id]).toBe(mixed)
    expect(doc.primarySourceId).toBe(base.primarySourceId)
    expect(doc.pages).toHaveLength(7)
    const inserted = doc.pages.slice(1, 4)
    expect(inserted.map((p) => p.source)).toEqual([0, 1, 2].map((pageIndex) => ({ kind: 'source', sourceId: mixed.id, pageIndex })))
    expect(inserted.map((p) => [Math.round(p.width), Math.round(p.height)])).toEqual([
      [595, 842],
      [612, 792],
      [842, 595]
    ])

    const some = insertSourcePages(base, rotatedSource, 99, [3, 1, 42])
    expect(some.pages.slice(4).map((p) => [p.source.kind === 'source' && p.source.pageIndex, p.baseRotation])).toEqual([
      [3, 270],
      [1, 90]
    ])
  })

  it('insertSourcePages makes the source primary for a blank document', () => {
    const blank = deepFreeze(createBlankDocument())
    const doc = insertSourcePages(blank, mixed, 0)
    expect(doc.primarySourceId).toBe(mixed.id)
    expect(doc.pages).toHaveLength(4)
    expect(doc.pages[3].source.kind).toBe('blank')
  })
})

describe('object operations', () => {
  it('addObject / updateObject / removeObject', () => {
    let doc = addObject(base, rect('d', base.pages[2].id))
    expect(doc.objects.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd'])
    doc = updateObject(doc, 'd', { x: 99, id: 'hacked', type: 'ellipse' } as Partial<EditObject>)
    const d = doc.objects[3] as Rect
    expect(d.x).toBe(99)
    expect(d.id).toBe('d')
    expect(d.type).toBe('rect')
    expect(doc.objects[0]).toBe(base.objects[0])
    doc = removeObject(doc, 'b')
    expect(doc.objects.map((o) => o.id)).toEqual(['a', 'c', 'd'])
    expect(updateObject(doc, 'missing', { x: 1 }).objects).toEqual(doc.objects)
  })

  it('reorderObject moves to front / back', () => {
    expect(reorderObject(base, 'a', 'front').objects.map((o) => o.id)).toEqual(['b', 'c', 'a'])
    expect(reorderObject(base, 'c', 'back').objects.map((o) => o.id)).toEqual(['c', 'a', 'b'])
    expect(reorderObject(base, 'zzz', 'back').objects.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })

  it('getObjectsForPage keeps z-order', () => {
    expect(getObjectsForPage(base, base.pages[1].id).map((o) => o.id)).toEqual(['b', 'c'])
    expect(getObjectsForPage(base, base.pages[3].id)).toEqual([])
  })
})

describe('forms and settings', () => {
  it('setFormValue / getFormValue fall back to the stored value', async () => {
    const formDoc = deepFreeze(await openDocument(await makeFormPdf(), 'form.pdf'))
    const sid = formDoc.primarySourceId!
    expect(getFormValue(formDoc, sid, 'readonly')).toBe('fixed')
    expect(getFormValue(formDoc, sid, 'agree')).toBe(false)
    expect(getFormValue(formDoc, sid, 'nope')).toBeUndefined()
    let doc = setFormValue(formDoc, sid, 'agree', true)
    doc = setFormValue(doc, sid, 'langs', ['English'])
    doc = setFormValue(doc, sid, 'name', '')
    expect(getFormValue(doc, sid, 'agree')).toBe(true)
    expect(getFormValue(doc, sid, 'langs')).toEqual(['English'])
    expect(getFormValue(doc, sid, 'name')).toBe('')
    expect(formDoc.formValues).toEqual({})
  })

  it('updateSettings merges shallowly and metadata one level deeper', () => {
    let doc = updateSettings(base, { metadata: { title: 'T' }, flattenForms: true })
    doc = updateSettings(doc, { metadata: { author: 'A' } })
    expect(doc.settings.metadata).toEqual({ title: 'T', author: 'A' })
    expect(doc.settings.flattenForms).toBe(true)
    doc = updateSettings(doc, { watermark: { text: 'W', fontSize: 40, color: '#ff0000', opacity: 0.3, angle: 45 } })
    expect(doc.settings.metadata).toEqual({ title: 'T', author: 'A' })
    expect(doc.settings.watermark?.text).toBe('W')
    expect(base.settings.metadata).toEqual({})
    expect(base.settings.flattenForms).toBe(false)
  })
})

describe('immutability', () => {
  it('no operation mutates a deep-frozen input', async () => {
    const formDoc = deepFreeze(await openDocument(await makeFormPdf(), 'form.pdf'))
    const p = base.pages.map((x) => x.id)
    const run = () => {
      rotatePages(base, p, 90)
      deletePages(base, [p[0]])
      movePages(base, [p[0]], 3)
      insertBlankPage(base, 1)
      duplicatePages(base, p)
      insertSourcePages(base, mixed, 0, [0])
      addObject(base, rect('z', p[0]))
      updateObject(base, 'a', { x: 5 })
      removeObject(base, 'a')
      reorderObject(base, 'a', 'front')
      setFormValue(formDoc, formDoc.primarySourceId!, 'name', 'x')
      updateSettings(base, { metadata: { title: 'x' }, encryption: { userPassword: 'p' } })
    }
    expect(run).not.toThrow()
  })
})
