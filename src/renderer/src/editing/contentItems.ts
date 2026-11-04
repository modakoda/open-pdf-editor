/** Loading of existing page content (getContentItems) for the "Edit content" tool. */
import { useEffect, useState, type RefObject } from 'react'
import { getContentItems, type ContentItem, type EditorDocument, type PageEntry, type SourceDocument } from '@core'

/** Items depend only on the source page, so they are cached per SourceDocument + page index. */
const cache = new WeakMap<SourceDocument, Map<number, Promise<ContentItem[]>>>()

export function loadContentItems(doc: EditorDocument, page: PageEntry): Promise<ContentItem[]> {
  if (page.source.kind !== 'source') return Promise.resolve([])
  const source = doc.sources[page.source.sourceId]
  if (!source) return Promise.resolve([])
  let perSource = cache.get(source)
  if (!perSource) {
    perSource = new Map()
    cache.set(source, perSource)
  }
  const index = page.source.pageIndex
  let p = perSource.get(index)
  if (!p) {
    p = getContentItems(doc, page.id)
    perSource.set(index, p)
    p.catch(() => perSource!.delete(index))
  }
  return p
}

/** Synchronous lookup of already loaded items (e.g. for keyboard actions). */
const loaded = new WeakMap<SourceDocument, Map<number, ContentItem[]>>()

export function getLoadedContentItems(doc: EditorDocument, page: PageEntry): ContentItem[] | undefined {
  if (page.source.kind !== 'source') return undefined
  const source = doc.sources[page.source.sourceId]
  return source ? loaded.get(source)?.get(page.source.pageIndex) : undefined
}

function remember(doc: EditorDocument, page: PageEntry, items: ContentItem[]): void {
  if (page.source.kind !== 'source') return
  const source = doc.sources[page.source.sourceId]
  if (!source) return
  let m = loaded.get(source)
  if (!m) {
    m = new Map()
    loaded.set(source, m)
  }
  m.set(page.source.pageIndex, items)
}

/** True while the element is in (or near) the viewport. Always true without IntersectionObserver. */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      rootMargin: '300px'
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return near
}

export function useContentItems(doc: EditorDocument | null, page: PageEntry, enabled: boolean): {
  items: ContentItem[]
  loading: boolean
  error: string | null
} {
  const source = doc && page.source.kind === 'source' ? doc.sources[page.source.sourceId] : undefined
  const pageIndex = page.source.kind === 'source' ? page.source.pageIndex : -1
  const key = source ? `${source.id}:${pageIndex}` : ''
  const [state, setState] = useState<{ key: string; items: ContentItem[]; error: string | null } | null>(null)

  useEffect(() => {
    if (!enabled || !doc || !source) return
    let cancelled = false
    loadContentItems(doc, page).then(
      (items) => {
        remember(doc, page, items)
        if (!cancelled) setState({ key, items, error: null })
      },
      (err: unknown) => {
        if (!cancelled) setState({ key, items: [], error: (err as Error)?.message ?? String(err) })
      }
    )
    return () => {
      cancelled = true
    }
    // The document changes on every edit; items only depend on the source page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, source, pageIndex, key])

  if (!enabled || !source) return { items: [], loading: false, error: null }
  if (state?.key !== key) return { items: [], loading: true, error: null }
  return { items: state.items, loading: false, error: state.error }
}
