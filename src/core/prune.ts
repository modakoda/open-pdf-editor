/**
 * Removing every trace of deleted pages from the output document (internal): annotations,
 * structure-tree elements (tagged PDF), ParentTree / IDTree entries, outline items, named
 * destinations, links and the open action that target them.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'

export interface RemovedPages {
  pages: Set<PDFRef>
  /** Annotations that were on removed pages (and only there). */
  annots: Set<PDFRef>
  /** /StructParents and /StructParent keys used by removed pages and their annotations. */
  structKeys: Set<number>
}

const N = (s: string) => PDFName.of(s)

function annotRefs(page: PDFPage): PDFRef[] {
  const annots = page.node.Annots()
  const out: PDFRef[] = []
  if (!annots) return out
  for (let i = 0; i < annots.size(); i++) {
    const r = annots.get(i)
    if (r instanceof PDFRef) out.push(r)
  }
  return out
}

function numberOf(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined
}

export function collectRemoved(ctx: PDFContext, removed: PDFPage[], kept: PDFPage[]): RemovedPages {
  const keptAnnots = new Set<PDFRef>()
  for (const p of kept) for (const r of annotRefs(p)) keptAnnots.add(r)
  const result: RemovedPages = { pages: new Set(), annots: new Set(), structKeys: new Set() }
  for (const p of removed) {
    result.pages.add(p.ref)
    const key = numberOf(p.node.lookup(N('StructParents')))
    if (key !== undefined) result.structKeys.add(key)
    for (const r of annotRefs(p)) {
      if (keptAnnots.has(r)) continue
      result.annots.add(r)
      const annot = ctx.lookup(r)
      if (!(annot instanceof PDFDict)) continue
      const sp = numberOf(annot.lookup(N('StructParent')))
      if (sp !== undefined) result.structKeys.add(sp)
      const popup = annot.get(N('Popup'))
      if (popup instanceof PDFRef && !keptAnnots.has(popup)) result.annots.add(popup)
    }
  }
  return result
}

// ---------------------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------------------

function nameTreeLookup(ctx: PDFContext, node: PDFObject | undefined, key: string, depth = 0): PDFObject | undefined {
  const dict = ctx.lookup(node)
  if (!(dict instanceof PDFDict) || depth > 32) return undefined
  const names = dict.lookup(N('Names'))
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = names.lookup(i)
      if ((k instanceof PDFString || k instanceof PDFHexString) && k.decodeText() === key) return names.get(i + 1)
    }
  }
  const kids = dict.lookup(N('Kids'))
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const found = nameTreeLookup(ctx, kids.get(i), key, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Page a destination (explicit array, name or string; or a dict with /D) points at. */
export function destinationPage(doc: PDFDocument, dest: PDFObject | undefined, depth = 0): PDFRef | undefined {
  const ctx = doc.context
  const d = ctx.lookup(dest)
  if (depth > 8 || d === undefined) return undefined
  if (d instanceof PDFArray) {
    const first = d.get(0)
    return first instanceof PDFRef ? first : undefined
  }
  if (d instanceof PDFDict) return destinationPage(doc, d.get(N('D')), depth + 1)
  let name: string | undefined
  if (d instanceof PDFName) name = d.decodeText()
  else if (d instanceof PDFString || d instanceof PDFHexString) name = d.decodeText()
  if (name === undefined) return undefined
  const oldDests = doc.catalog.lookup(N('Dests'))
  if (oldDests instanceof PDFDict) {
    const v = oldDests.get(N(name))
    if (v) return destinationPage(doc, v, depth + 1)
  }
  const names = doc.catalog.lookup(N('Names'))
  if (names instanceof PDFDict) {
    const v = nameTreeLookup(ctx, names.get(N('Dests')), name)
    if (v) return destinationPage(doc, v, depth + 1)
  }
  return undefined
}

/** Destination of a link / outline item: /Dest, or /A with a GoTo action. */
function itemTarget(doc: PDFDocument, dict: PDFDict): PDFRef | undefined {
  const dest = dict.get(N('Dest'))
  if (dest) return destinationPage(doc, dest)
  const action = dict.lookup(N('A'))
  if (action instanceof PDFDict && action.lookup(N('S')) === N('GoTo')) return destinationPage(doc, action.get(N('D')))
  return undefined
}

function dropTarget(dict: PDFDict): void {
  dict.delete(N('Dest'))
  const action = dict.lookup(N('A'))
  if (action instanceof PDFDict && action.lookup(N('S')) === N('GoTo')) dict.delete(N('A'))
}

function pruneNameTree(doc: PDFDocument, node: PDFObject | undefined, removed: Set<PDFRef>, depth = 0): void {
  const dict = doc.context.lookup(node)
  if (!(dict instanceof PDFDict) || depth > 32) return
  const names = dict.lookup(N('Names'))
  if (names instanceof PDFArray) {
    for (let i = names.size() - 2; i >= 0; i -= 2) {
      const target = destinationPage(doc, names.get(i + 1))
      if (target && removed.has(target)) {
        names.remove(i + 1)
        names.remove(i)
      }
    }
  }
  const kids = dict.lookup(N('Kids'))
  if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) pruneNameTree(doc, kids.get(i), removed, depth + 1)
}

function pruneOutlines(doc: PDFDocument, removed: Set<PDFRef>): void {
  const ctx = doc.context
  const root = doc.catalog.lookup(N('Outlines'))
  if (!(root instanceof PDFDict)) return
  const visited = new Set<PDFRef>()
  // Returns the number of descendants that are visible when `parent` is open.
  const prune = (parent: PDFDict): number => {
    const kept: { ref: PDFRef; dict: PDFDict; visible: number }[] = []
    let ref = parent.get(N('First'))
    while (ref instanceof PDFRef && !visited.has(ref)) {
      visited.add(ref)
      const dict = ctx.lookup(ref)
      if (!(dict instanceof PDFDict)) break
      const next = dict.get(N('Next'))
      const wasOpen = (numberOf(dict.lookup(N('Count'))) ?? 0) > 0
      const childVisible = prune(dict)
      const target = itemTarget(doc, dict)
      const targetsRemoved = !!target && removed.has(target)
      if (targetsRemoved) dropTarget(dict)
      if (!targetsRemoved || dict.get(N('First'))) {
        if (childVisible > 0) dict.set(N('Count'), ctx.obj(wasOpen ? childVisible : -childVisible))
        else dict.delete(N('Count'))
        kept.push({ ref, dict, visible: wasOpen ? childVisible : 0 })
      }
      ref = next
    }
    kept.forEach((k, i) => {
      if (i > 0) k.dict.set(N('Prev'), kept[i - 1].ref)
      else k.dict.delete(N('Prev'))
      if (i < kept.length - 1) k.dict.set(N('Next'), kept[i + 1].ref)
      else k.dict.delete(N('Next'))
    })
    if (kept.length) {
      parent.set(N('First'), kept[0].ref)
      parent.set(N('Last'), kept[kept.length - 1].ref)
    } else {
      parent.delete(N('First'))
      parent.delete(N('Last'))
    }
    return kept.reduce((n, k) => n + 1 + k.visible, 0)
  }
  const total = prune(root)
  if (total > 0) root.set(N('Count'), ctx.obj(total))
  else doc.catalog.delete(N('Outlines'))
}

/** Outline items, named destinations, links on kept pages and /OpenAction. */
export function pruneDestinations(doc: PDFDocument, removed: RemovedPages, kept: PDFPage[]): void {
  if (!removed.pages.size) return
  const ctx = doc.context
  pruneOutlines(doc, removed.pages)
  for (const page of kept) {
    for (const r of annotRefs(page)) {
      const annot = ctx.lookup(r)
      if (!(annot instanceof PDFDict) || annot.lookup(N('Subtype')) !== N('Link')) continue
      const target = itemTarget(doc, annot)
      if (target && removed.pages.has(target)) dropTarget(annot)
    }
  }
  const open = doc.catalog.get(N('OpenAction'))
  if (open) {
    const resolved = ctx.lookup(open)
    const target =
      resolved instanceof PDFDict && resolved.lookup(N('S')) === N('GoTo')
        ? destinationPage(doc, resolved.get(N('D')))
        : resolved instanceof PDFArray
          ? destinationPage(doc, resolved)
          : undefined
    if (target && removed.pages.has(target)) doc.catalog.delete(N('OpenAction'))
  }
  const oldDests = doc.catalog.lookup(N('Dests'))
  if (oldDests instanceof PDFDict) {
    for (const key of oldDests.keys()) {
      const target = destinationPage(doc, oldDests.get(key))
      if (target && removed.pages.has(target)) oldDests.delete(key)
    }
  }
  const names = doc.catalog.lookup(N('Names'))
  if (names instanceof PDFDict) pruneNameTree(doc, names.get(N('Dests')), removed.pages)
}

// ---------------------------------------------------------------------------------------
// Structure tree
// ---------------------------------------------------------------------------------------

/** Drop structure elements, marked-content and object references belonging to removed pages. */
export function pruneStructureTree(doc: PDFDocument, removed: RemovedPages): void {
  const ctx = doc.context
  const root = doc.catalog.lookup(N('StructTreeRoot'))
  if (!(root instanceof PDFDict) || (!removed.pages.size && !removed.annots.size)) return
  const pruned = new Set<PDFObject>()
  const visiting = new Set<PDFObject>()
  const pageOf = (o: PDFObject | undefined) => (o instanceof PDFRef ? o : undefined)
  const onRemovedPage = (pg: PDFRef | undefined) => !!pg && removed.pages.has(pg)

  const hasKids = (elem: PDFDict) => {
    const k = elem.get(N('K'))
    if (k === undefined) return false
    const resolved = ctx.lookup(k)
    return !(resolved instanceof PDFArray) || resolved.size() > 0
  }

  // Returns whether `kid` should stay in its parent's /K.
  const keepKid = (kid: PDFObject, pg: PDFRef | undefined): boolean => {
    if (kid instanceof PDFNumber) return !onRemovedPage(pg)
    const obj = ctx.lookup(kid)
    if (!(obj instanceof PDFDict)) return true
    const type = obj.lookup(N('Type'))
    const kidPg = pageOf(obj.get(N('Pg'))) ?? pg
    if (type === N('MCR')) return !onRemovedPage(kidPg)
    if (type === N('OBJR')) {
      const target = obj.get(N('Obj'))
      return !(onRemovedPage(kidPg) || (target instanceof PDFRef && removed.annots.has(target)))
    }
    if (visiting.has(obj)) return true
    visiting.add(obj)
    const hadKids = hasKids(obj)
    pruneKids(obj, kidPg)
    visiting.delete(obj)
    const empty = !hasKids(obj)
    if ((hadKids && empty) || (!hadKids && onRemovedPage(kidPg))) {
      pruned.add(obj)
      if (kid instanceof PDFRef) pruned.add(kid)
      return false
    }
    if (onRemovedPage(pageOf(obj.get(N('Pg'))))) obj.delete(N('Pg'))
    return true
  }

  const pruneKids = (elem: PDFDict, pg: PDFRef | undefined) => {
    const k = elem.get(N('K'))
    if (k === undefined) return
    const resolved = ctx.lookup(k)
    if (resolved instanceof PDFArray) {
      for (let i = resolved.size() - 1; i >= 0; i--) if (!keepKid(resolved.get(i), pg)) resolved.remove(i)
    } else if (!keepKid(k, pg)) {
      elem.delete(N('K'))
    }
  }

  pruneKids(root, undefined)

  const isPruned = (v: PDFObject) => pruned.has(v) || pruned.has(ctx.lookup(v) as PDFObject)
  const pruneNumberTree = (node: PDFObject | undefined, depth = 0) => {
    const dict = ctx.lookup(node)
    if (!(dict instanceof PDFDict) || depth > 32) return
    const nums = dict.lookup(N('Nums'))
    if (nums instanceof PDFArray) {
      for (let i = nums.size() - 2; i >= 0; i -= 2) {
        const key = numberOf(nums.lookup(i))
        const value = nums.get(i + 1)
        const resolved = ctx.lookup(value)
        if ((key !== undefined && removed.structKeys.has(key)) || isPruned(value)) {
          nums.remove(i + 1)
          nums.remove(i)
        } else if (resolved instanceof PDFArray) {
          for (let j = 0; j < resolved.size(); j++) if (isPruned(resolved.get(j))) resolved.set(j, ctx.obj(null))
        }
      }
    }
    const kids = dict.lookup(N('Kids'))
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) pruneNumberTree(kids.get(i), depth + 1)
  }
  pruneNumberTree(root.get(N('ParentTree')))

  const pruneIdTree = (node: PDFObject | undefined, depth = 0) => {
    const dict = ctx.lookup(node)
    if (!(dict instanceof PDFDict) || depth > 32) return
    const names = dict.lookup(N('Names'))
    if (names instanceof PDFArray) {
      for (let i = names.size() - 2; i >= 0; i -= 2) {
        if (isPruned(names.get(i + 1))) {
          names.remove(i + 1)
          names.remove(i)
        }
      }
    }
    const kids = dict.lookup(N('Kids'))
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) pruneIdTree(kids.get(i), depth + 1)
  }
  pruneIdTree(root.get(N('IDTree')))
}

/** Delete the annotations of removed pages so nothing else can keep them alive. */
export function deleteRemovedAnnotations(ctx: PDFContext, removed: RemovedPages): void {
  for (const r of removed.annots) ctx.delete(r)
}
