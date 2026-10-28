/**
 * Reading and writing a page's content streams and resources.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFObject, type PDFPage } from '@cantoo/pdf-lib'
import { N, resolve, streamData } from './pdfobj'

/** All /Contents streams of the page, decoded and joined with newlines. */
export function readPageContent(page: PDFPage): Uint8Array {
  let contents: PDFObject | undefined
  try {
    contents = page.node.get(PDFName.of('Contents'))
  } catch {
    contents = undefined
  }
  const ctx = page.node.context
  const obj = resolve(ctx, contents)
  const streams: PDFStream[] = []
  if (obj instanceof PDFStream) streams.push(obj)
  else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const s = resolve(ctx, obj.get(i))
      if (s instanceof PDFStream) streams.push(s)
    }
  }
  const parts: Uint8Array[] = []
  let size = 0
  for (const s of streams) {
    const d = streamData(s)
    if (!d) continue
    parts.push(d)
    size += d.length + 1
  }
  const out = new Uint8Array(Math.max(0, size - 1))
  let off = 0
  parts.forEach((p, i) => {
    out.set(p, off)
    off += p.length
    if (i < parts.length - 1) out[off++] = 0x0a
  })
  return out
}

/** Replace the page's /Contents with one Flate-compressed stream. */
export function writePageContent(doc: PDFDocument, page: PDFPage, bytes: Uint8Array): void {
  const stream = doc.context.flateStream(bytes)
  const ref = doc.context.register(stream)
  // An array (not a bare stream) so pdf-lib can append content streams to the page later.
  page.node.set(PDFName.of('Contents'), doc.context.obj([ref]))
  // pdf-lib caches the content stream it draws into; what it holds was merged into the new
  // stream above, so make its next drawing operation start a fresh stream.
  const internals = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown }
  internals.contentStream = undefined
  internals.contentStreamRef = undefined
}

export function pageResources(page: PDFPage): PDFDict | undefined {
  try {
    return page.node.Resources()
  } catch {
    return undefined
  }
}

/**
 * Copy-on-write access to the page's resources: the first modification gives the page its own
 * /Resources dict (and own category dicts), so resources shared with other pages or inherited
 * from the page tree are never modified.
 */
export class ResourceEditor {
  private own: PDFDict | null = null
  private ownCategories = new Map<string, PDFDict>()

  constructor(
    private readonly doc: PDFDocument,
    private readonly page: PDFPage
  ) {}

  resources(): PDFDict | undefined {
    return this.own ?? pageResources(this.page)
  }

  private ownResources(): PDFDict {
    if (this.own) return this.own
    const current = pageResources(this.page)
    const own = current ? current.clone(this.doc.context) : this.doc.context.obj({})
    this.page.node.set(PDFName.of('Resources'), own)
    this.own = own
    return own
  }

  category(name: string): PDFDict {
    const cached = this.ownCategories.get(name)
    if (cached) return cached
    const res = this.ownResources()
    const cur = resolve(this.doc.context, res.get(N(name)))
    const own = cur instanceof PDFDict ? cur.clone(this.doc.context) : this.doc.context.obj({})
    res.set(N(name), own)
    this.ownCategories.set(name, own)
    return own
  }

  /** A name not used in the category (current resources), based on `base`. */
  freshName(category: string, base: string): string {
    const dict = this.resources()
    const cat = dict ? resolve(this.doc.context, dict.get(N(category))) : undefined
    const has = (n: string) => cat instanceof PDFDict && cat.get(N(n)) !== undefined
    if (!has(base)) return base
    for (let i = 1; ; i++) {
      const n = `${base}_${i}`
      if (!has(n)) return n
    }
  }

  get(category: string, name: string): PDFObject | undefined {
    const dict = this.resources()
    const cat = dict ? resolve(this.doc.context, dict.get(N(category))) : undefined
    return cat instanceof PDFDict ? cat.get(N(name)) : undefined
  }

  set(category: string, name: string, value: PDFObject | PDFRef): void {
    this.category(category).set(N(name), value)
  }
}
