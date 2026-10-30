/**
 * "Sanitize document" on export (internal): removes hidden information that is not part of
 * the visible pages.
 * - metadata: the document information dictionary, XMP streams (/Metadata) everywhere,
 *   private application data (/PieceInfo, /LastModified, /SpiderInfo);
 * - attachments: embedded files (/Names /EmbeddedFiles, file specifications' /EF, associated
 *   files /AF, portfolios /Collection) and file attachment annotations;
 * - scripts: document JavaScript (/Names /JavaScript), JavaScript and Launch actions (in
 *   /OpenAction, /A, /Next chains), additional actions (/AA) and XFA forms;
 * - hidden layers: optional content groups hidden by default are dropped from /OCProperties
 *   (their content was already removed from the pages by redaction.ts).
 * Runs after everything else was written, before encryption.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib'
import { Interpreter } from './content/interpreter'

const N = (s: string) => PDFName.of(s)
const SCRIPT_ACTIONS = new Set(['JavaScript', 'Launch', 'ImportData', 'RichMediaExecute'])
const DROP_EVERYWHERE = ['Metadata', 'PieceInfo', 'AA', 'AF', 'EF', 'RF']

function lookup(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o
}

function dictOf(o: PDFObject | undefined): PDFDict | undefined {
  if (o instanceof PDFDict) return o
  if (o instanceof PDFStream) return o.dict
  return undefined
}

function isScriptAction(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const d = dictOf(lookup(ctx, o))
  if (!d) return false
  const s = d.lookup(N('S'))
  return (s instanceof PDFName && SCRIPT_ACTIONS.has(s.decodeText())) || d.get(N('JS')) !== undefined
}

/** Drop scripts from an action chain (/Next may be one action or an array of them). */
function pruneNext(ctx: PDFContext, action: PDFDict, seen: Set<PDFDict>): void {
  if (seen.has(action)) return
  seen.add(action)
  const next = action.get(N('Next'))
  const resolved = lookup(ctx, next)
  if (resolved instanceof PDFArray) {
    for (let i = resolved.size() - 1; i >= 0; i--) {
      if (isScriptAction(ctx, resolved.get(i))) resolved.remove(i)
      else {
        const d = dictOf(lookup(ctx, resolved.get(i)))
        if (d) pruneNext(ctx, d, seen)
      }
    }
  } else if (next !== undefined) {
    if (isScriptAction(ctx, next)) action.delete(N('Next'))
    else {
      const d = dictOf(resolved)
      if (d) pruneNext(ctx, d, seen)
    }
  }
}

export function sanitizeDocument(out: PDFDocument): void {
  const ctx = out.context
  const catalog = out.catalog

  // Document information dictionary.
  const trailer = ctx.trailerInfo as { Info?: PDFObject }
  trailer.Info = undefined

  // Catalog-level entries.
  for (const key of ['Metadata', 'PieceInfo', 'SpiderInfo', 'AA', 'AF', 'Collection', 'Threads']) catalog.delete(N(key))
  if (isScriptAction(ctx, catalog.get(N('OpenAction')))) catalog.delete(N('OpenAction'))
  const names = dictOf(lookup(ctx, catalog.get(N('Names'))))
  if (names) {
    names.delete(N('JavaScript'))
    names.delete(N('EmbeddedFiles'))
  }
  const acroForm = dictOf(lookup(ctx, catalog.get(N('AcroForm'))))
  acroForm?.delete(N('XFA'))

  // File attachment annotations.
  for (const page of out.getPages()) {
    page.node.delete(N('LastModified'))
    const annots = lookup(ctx, page.node.get(N('Annots')))
    if (!(annots instanceof PDFArray)) continue
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = dictOf(lookup(ctx, annots.get(i)))
      if (a?.lookup(N('Subtype')) === N('FileAttachment')) annots.remove(i)
    }
  }

  // Every object: metadata, private data, embedded files, scripts.
  const seen = new Set<PDFDict>()
  const visit = (d: PDFDict) => {
    for (const key of DROP_EVERYWHERE) d.delete(N(key))
    const a = d.get(N('A'))
    if (a !== undefined) {
      if (isScriptAction(ctx, a)) d.delete(N('A'))
      else {
        const ad = dictOf(lookup(ctx, a))
        if (ad) pruneNext(ctx, ad, seen)
      }
    }
    const open = d.get(N('OpenAction'))
    if (open !== undefined) {
      const od = dictOf(lookup(ctx, open))
      if (od) pruneNext(ctx, od, seen)
    }
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = dictOf(obj)
    if (d) visit(d)
    // Direct dictionaries inside arrays / dictionaries (e.g. inline annotation actions).
    const stack: PDFObject[] = d ? [...d.entries()].map(([, v]) => v) : obj instanceof PDFArray ? obj.asArray() : []
    for (let n = 0; stack.length && n < 10_000; n++) {
      const v = stack.pop()!
      if (v instanceof PDFDict) {
        visit(v)
        for (const [, w] of v.entries()) if (!(w instanceof PDFRef)) stack.push(w)
      } else if (v instanceof PDFArray) {
        for (const w of v.asArray()) if (!(w instanceof PDFRef)) stack.push(w)
      }
    }
  }

  removeHiddenLayers(out)
}

/** Remove optional content groups that are hidden in the default configuration. */
function removeHiddenLayers(out: PDFDocument): void {
  const ctx = out.context
  const props = dictOf(lookup(ctx, out.catalog.get(N('OCProperties'))))
  const ocgs = props ? lookup(ctx, props.get(N('OCGs'))) : undefined
  if (!props || !(ocgs instanceof PDFArray)) return
  const oc = new Interpreter(ctx, { cropBox: { x: 0, y: 0, width: 0, height: 0 } })
  const hidden = new Set<PDFObject>()
  for (const ref of ocgs.asArray()) if (oc.ocHidden(ref)) hidden.add(lookup(ctx, ref)!)
  if (!hidden.size) return
  const isHidden = (o: PDFObject) => hidden.has(lookup(ctx, o)!)
  const prune = (arr: PDFArray, depth = 0) => {
    if (depth > 16) return
    for (let i = arr.size() - 1; i >= 0; i--) {
      const v = arr.get(i)
      if (isHidden(v)) arr.remove(i)
      else {
        const inner = lookup(ctx, v)
        if (inner instanceof PDFArray) prune(inner, depth + 1)
      }
    }
  }
  prune(ocgs)
  const configs: PDFDict[] = []
  const d = dictOf(lookup(ctx, props.get(N('D'))))
  if (d) configs.push(d)
  const alt = lookup(ctx, props.get(N('Configs')))
  if (alt instanceof PDFArray) for (const c of alt.asArray()) {
    const cd = dictOf(lookup(ctx, c))
    if (cd) configs.push(cd)
  }
  for (const cfg of configs) {
    for (const key of ['ON', 'OFF', 'Order', 'RBGroups', 'Locked']) {
      const arr = lookup(ctx, cfg.get(N(key)))
      if (arr instanceof PDFArray) prune(arr)
    }
    const as = lookup(ctx, cfg.get(N('AS')))
    if (as instanceof PDFArray) for (const entry of as.asArray()) {
      const ed = dictOf(lookup(ctx, entry))
      const list = ed ? lookup(ctx, ed.get(N('OCGs'))) : undefined
      if (list instanceof PDFArray) prune(list)
    }
  }
  if (!ocgs.size()) out.catalog.delete(N('OCProperties'))
}
