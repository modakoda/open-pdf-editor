/**
 * Deterministic stand-ins for the @core engine functions the workspace calls, so renderer
 * tests do not depend on the engine (or on pdf parsing). Use with:
 *
 *   vi.mock('@core', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@core')>()),
 *     ...(await import('./support/fakeCore')).coreOverrides
 *   }))
 */
import { vi } from 'vitest'
import type { DocumentSettings, EditObject, EditorDocument, PageEntry, Rotation, SourceDocument } from '@core'

let idCounter = 0
const nextId = (prefix: string) => `${prefix}-${++idCounter}`

export function makeSource(id = 'src1', pageCount = 3, name = 'test.pdf'): SourceDocument {
  return {
    id,
    name,
    bytes: new Uint8Array([37, 80, 68, 70]),
    isEncrypted: false,
    pageCount,
    metadata: { title: 'Fixture title', author: 'Fixture Author' },
    formFields: []
  } as SourceDocument
}

export function makePage(id: string, sourceId = 'src1', pageIndex = 0, extra: Partial<PageEntry> = {}): PageEntry {
  return {
    id,
    source: { kind: 'source', sourceId, pageIndex },
    width: 600,
    height: 800,
    baseRotation: 0,
    rotation: 0,
    ...extra
  }
}

const DEFAULT_SETTINGS: DocumentSettings = {
  metadata: {},
  watermark: null,
  pageNumbers: null,
  flattenForms: false,
  encryption: null
}

/** Document with `count` pages p1..pN from one source. */
export function makeDoc(count = 3, objects: EditObject[] = []): EditorDocument {
  const source = makeSource('src1', count)
  return {
    primarySourceId: source.id,
    sources: { [source.id]: source },
    pages: Array.from({ length: count }, (_, i) => makePage(`p${i + 1}`, source.id, i)),
    objects,
    formValues: {},
    settings: { ...DEFAULT_SETTINGS, metadata: {} }
  }
}

const norm = (r: number) => ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as Rotation

export const coreOverrides = {
  openDocument: vi.fn(async (_bytes: Uint8Array, name: string) => {
    const doc = makeDoc(3)
    doc.sources.src1 = { ...doc.sources.src1, name }
    return doc
  }),
  loadSource: vi.fn(async (_bytes: Uint8Array, name: string) => makeSource(nextId('src'), 2, name)),
  createBlankDocument: vi.fn((): EditorDocument => ({
    primarySourceId: null,
    sources: {},
    pages: [{ id: nextId('blank'), source: { kind: 'blank' }, width: 595.28, height: 841.89, baseRotation: 0, rotation: 0 }],
    objects: [],
    formValues: {},
    settings: { ...DEFAULT_SETTINGS, metadata: {} }
  })),
  exportDocument: vi.fn(async (_doc: EditorDocument, _opts?: { pageIds?: string[] }) => new Uint8Array([1, 2, 3])),
  renderPagePreview: vi.fn(async (_doc: EditorDocument, pageId: string) => new TextEncoder().encode(`preview:${pageId}`)),
  splitDocument: vi.fn(async (_doc: EditorDocument, groups: string[][]) => groups.map((_, i) => new Uint8Array([i]))),
  rotatePages: vi.fn((doc: EditorDocument, ids: string[], delta: number): EditorDocument => ({
    ...doc,
    pages: doc.pages.map((p) => (ids.includes(p.id) ? { ...p, rotation: norm(p.rotation + delta) } : p))
  })),
  deletePages: vi.fn((doc: EditorDocument, ids: string[]): EditorDocument => ({
    ...doc,
    pages: doc.pages.filter((p) => !ids.includes(p.id)),
    objects: doc.objects.filter((o) => !ids.includes(o.pageId))
  })),
  movePages: vi.fn((doc: EditorDocument, ids: string[], target: number): EditorDocument => {
    const moving = doc.pages.filter((p) => ids.includes(p.id))
    const rest = doc.pages.filter((p) => !ids.includes(p.id))
    const t = Math.max(0, Math.min(rest.length, target))
    return { ...doc, pages: [...rest.slice(0, t), ...moving, ...rest.slice(t)] }
  }),
  insertBlankPage: vi.fn((doc: EditorDocument, index: number) => {
    const page: PageEntry = { id: nextId('blank'), source: { kind: 'blank' }, width: 600, height: 800, baseRotation: 0, rotation: 0 }
    const pages = [...doc.pages]
    pages.splice(index, 0, page)
    return { doc: { ...doc, pages }, page }
  }),
  duplicatePages: vi.fn((doc: EditorDocument, ids: string[]): EditorDocument => ({
    ...doc,
    pages: doc.pages.flatMap((p) => (ids.includes(p.id) ? [p, { ...p, id: nextId('dup') }] : [p]))
  })),
  insertSourcePages: vi.fn((doc: EditorDocument, source: SourceDocument, index: number, pageIndices?: number[]): EditorDocument => {
    const indices = pageIndices ?? Array.from({ length: source.pageCount }, (_, i) => i)
    const added = indices.map((i) => makePage(nextId('ins'), source.id, i))
    const pages = [...doc.pages]
    pages.splice(index, 0, ...added)
    return { ...doc, sources: { ...doc.sources, [source.id]: source }, pages }
  }),
  removeObject: vi.fn((doc: EditorDocument, id: string): EditorDocument => ({
    ...doc,
    objects: doc.objects.filter((o) => o.id !== id)
  })),
  updateSettings: vi.fn((doc: EditorDocument, patch: Partial<DocumentSettings>): EditorDocument => ({
    ...doc,
    settings: {
      ...doc.settings,
      ...patch,
      metadata: { ...doc.settings.metadata, ...(patch.metadata ?? {}) }
    }
  }))
}

/** Restore default implementations and clear call history. */
export function resetFakeCore(): void {
  for (const fn of Object.values(coreOverrides)) fn.mockClear()
  coreOverrides.openDocument.mockImplementation(async (_bytes: Uint8Array, name: string) => {
    const doc = makeDoc(3)
    doc.sources.src1 = { ...doc.sources.src1, name }
    return doc
  })
  coreOverrides.loadSource.mockImplementation(async (_bytes: Uint8Array, name: string) => makeSource(nextId('src'), 2, name))
  coreOverrides.exportDocument.mockImplementation(async () => new Uint8Array([1, 2, 3]))
  coreOverrides.renderPagePreview.mockImplementation(async (_doc: EditorDocument, pageId: string) =>
    new TextEncoder().encode(`preview:${pageId}`)
  )
}
