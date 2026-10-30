/**
 * Reading and writing a page's content streams and resources.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject, type PDFPage } from '@cantoo/pdf-lib'
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
 * Copy-on-write access to a resources dictionary (of a page or of a form XObject copy): the
 * first modification creates an own copy of the dict (and of each category dict modified), so
 * resources shared with other pages / forms or inherited from the page tree are never changed.
 */
export class ResourceEditor {
  private own: PDFDict | null = null
  private ownCategories = new Map<string, PDFDict>()

  constructor(
    private readonly context: PDFContext,
    private readonly base: () => PDFDict | undefined,
    private readonly install: (own: PDFDict) => void
  ) {}

  static forPage(doc: PDFDocument, page: PDFPage): ResourceEditor {
    return new ResourceEditor(
      doc.context,
      () => pageResources(page),
      (own) => page.node.set(PDFName.of('Resources'), own)
    )
  }

  resources(): PDFDict | undefined {
    return this.own ?? this.base()
  }

  private ownResources(): PDFDict {
    if (this.own) return this.own
    const current = this.base()
    const own = current ? current.clone(this.context) : this.context.obj({})
    this.install(own)
    this.own = own
    return own
  }

  category(name: string): PDFDict {
    const cached = this.ownCategories.get(name)
    if (cached) return cached
    const res = this.ownResources()
    const cur = resolve(this.context, res.get(N(name)))
    const own = cur instanceof PDFDict ? cur.clone(this.context) : this.context.obj({})
    res.set(N(name), own)
    this.ownCategories.set(name, own)
    return own
  }

  /** A name not used in the category (current resources), based on `base`. */
  freshName(category: string, base: string): string {
    const dict = this.resources()
    const cat = dict ? resolve(this.context, dict.get(N(category))) : undefined
    const has = (n: string) => cat instanceof PDFDict && cat.get(N(n)) !== undefined
    if (!has(base)) return base
    for (let i = 1; ; i++) {
      const n = `${base}_${i}`
      if (!has(n)) return n
    }
  }

  get(category: string, name: string): PDFObject | undefined {
    const dict = this.resources()
    const cat = dict ? resolve(this.context, dict.get(N(category))) : undefined
    return cat instanceof PDFDict ? cat.get(N(name)) : undefined
  }

  set(category: string, name: string, value: PDFObject | PDFRef): void {
    this.category(category).set(N(name), value)
  }
}
