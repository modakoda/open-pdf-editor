import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFObjectCopier,
  PDFPage,
  PDFPageLeaf,
  PDFPageTree,
  PDFRef,
  PDFStream,
  PDFString,
  degrees,
  type PDFObject
} from '@cantoo/pdf-lib'
import { displayRotation } from './geometry'
import type { ContentEdit, ContentItem, EditObject, EditorDocument, FieldObject, PageEntry, Rotation, SourceDocument } from './model'
import { applyContentEdits, listContentItems, stripMarkedContent, type ContentEditHelpers } from './content'
import { applyAnnotationEdits, removeMarkedAnnotations, tagAnnotations, untagAnnotations } from './annotations'
import { applyFieldEdits, applyWidgetEditsToPage, createNewFields, removeRestoredFields } from './fieldEdits'
import { clearPageObjects, writePageObjects } from './persist'
import { collectGarbage, openPdfLib, visibleBox } from './pdf'
import { EmbedCache } from './exportFonts'
import {
  fieldsByName,
  detachForm,
  fillForm,
  flattenForm,
  hasAcroForm,
  pruneFieldsOnRemovedPages,
  refreshAppearancesForBurning
} from './exportForms'
import { detachAllWidgets, drawBurns, pageWidgets, widgetBurn, type WidgetBurn } from './flatten'
import { drawObject, drawPageNumber, drawWatermark, isolateExistingContent, type DrawTarget } from './exportDraw'
import { collectRemoved, deleteRemovedAnnotations, pruneDestinations, pruneStructureTree } from './prune'
import {
  applyEncryption,
  applyOriginalEncryption,
  encryptStringsForSave,
  sameEncryption,
  stripPdfAIdentification
} from './security'
import { fileEncryptionKey } from './pdfCrypto'
import { encryptionFromSource } from './load'

export type ExportWarningCode = 'pdfa-claim-removed' | 'image-skipped'

export interface ExportWarning {
  code: ExportWarningCode
  message: string
  /** Object the warning is about, if any. */
  objectId?: string
}

export interface ExportOptions {
  /** Export only these pages (in document order). Defaults to all pages. */
  pageIds?: string[]
  /** Called for non-fatal problems the user may want to know about. */
  onWarning?: (warning: ExportWarning) => void
}

/** Value written to /Producer unless the user overrides it. */
export const PRODUCER = 'Open PDF Editor'

/** `burns`: widget appearances to draw into the page content after content edits. */
type PlanItem = (
  | { entry: PageEntry; kind: 'primary'; pageIndex: number }
  | { entry: PageEntry; kind: 'copy'; sourceId: string; pageIndex: number }
  | { entry: PageEntry; kind: 'clone'; of: PlanItem }
  | { entry: PageEntry; kind: 'blank' }
) & { page?: PDFPage; burns?: WidgetBurn[] }

const N = (s: string) => PDFName.of(s)
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map(N)

/**
 * Load a non-primary source prepared for copying pages out of it: forms filled with the
 * user's values and flattened (pdf-lib cannot merge AcroForms), structure keys and
 * internal destinations removed (they would refer to the other file), and annotation
 * back-references removed so copying a page does not drag in the rest of the file.
 */
async function loadSourceForCopy(
  doc: EditorDocument,
  source: SourceDocument,
  cache: EmbedCache
): Promise<{ src: PDFDocument; burns: Map<number, WidgetBurn[]> }> {
  const { doc: src } = await openPdfLib(source.bytes, source.password, { identify: false })
  const pages = src.getPages()
  const restored = new Set<string>()
  pages.forEach((page, i) => {
    tagAnnotations(src.context, page)
    const ids = restoredIdsOf(source, i)
    if (!ids.size) return
    ids.forEach((id) => restored.add(id))
    removeMarkedAnnotations(src.context, page, ids)
    stripMarkedContent(src, page, ids)
    afterContentRewrite(page)
  })
  let detached: Map<PDFPage, WidgetBurn[]>
  if (hasAcroForm(src)) {
    const form = src.getForm()
    const byName = fieldsByName(form)
    removeRestoredFields(form, byName.values(), restored, pages)
    await applyFieldEdits(src, form, byName, doc.fieldEdits?.[source.id], pages, cache, { renames: false })
    await fillForm(src, form, doc.formValues[source.id], cache, byName)
    detached = await detachForm(src, form, pages, cache)
  } else {
    detached = detachAllWidgets(src, pages) // orphan widgets
  }
  // The widgets are burned in only after content edits (which need the original content).
  const burns = new Map<number, WidgetBurn[]>()
  pages.forEach((page, i) => {
    const b = detached.get(page)
    if (b) burns.set(i, b)
  })
  for (const page of pages) {
    page.node.delete(N('B'))
    page.node.delete(N('StructParents'))
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = src.context.lookup(annots.get(i))
      if (!(annot instanceof PDFDict)) continue
      annot.delete(N('P'))
      annot.delete(N('StructParent'))
      // Destinations (explicit or named) would resolve against the other file.
      annot.delete(N('Dest'))
      const action = annot.lookup(N('A'))
      if (action instanceof PDFDict && action.lookup(N('S')) === N('GoTo')) annot.delete(N('A'))
    }
  }
  return { src, burns }
}

/** Ids of EditObjects restored from a source page (their old drawings must be removed). */
function restoredIdsOf(source: SourceDocument | undefined, pageIndex: number): Set<string> {
  return new Set(source?.pageInfo?.[pageIndex]?.restoredObjectIds ?? [])
}

/**
 * After the content library rewrote a page's /Contents: make pdf-lib append to a fresh
 * content stream, keep /Contents an array, and isolate the content again before drawing.
 */
function afterContentRewrite(page: PDFPage): void {
  const wrapper = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown }
  wrapper.contentStream = undefined
  wrapper.contentStreamRef = undefined
  const contents = page.node.get(N('Contents'))
  if (contents instanceof PDFRef && page.doc.context.lookup(contents) instanceof PDFStream) {
    page.node.set(N('Contents'), page.doc.context.obj([contents]))
  }
  ;(page.node as unknown as { normalized?: boolean }).normalized = false
}

/** Give a page its own copies of its content streams (it shares them with a repeat). */
function unshareContents(out: PDFDocument, page: PDFPage): void {
  const ctx = out.context
  const contents = page.node.get(N('Contents'))
  const resolved = ctx.lookup(contents)
  const refs: PDFObject[] = resolved instanceof PDFArray ? resolved.asArray() : contents ? [contents] : []
  const copies = refs.map((r) => {
    const stream = ctx.lookup(r)
    return stream instanceof PDFStream ? ctx.register(stream.clone(ctx)) : r
  })
  page.node.set(N('Contents'), ctx.obj(copies))
  afterContentRewrite(page)
}

function numberArray(o: PDFObject | undefined): PDFRef[] {
  const out: PDFRef[] = []
  if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) {
    const v = o.get(i)
    if (v instanceof PDFRef) out.push(v)
  }
  return out
}

/**
 * Copy pages of another document, then register the optional content groups they use in
 * the output's /OCProperties (with their default ON/OFF state) so hidden layers stay hidden.
 */
async function copyForeignPages(
  out: PDFDocument,
  src: PDFDocument,
  indices: number[],
  burns: Map<number, WidgetBurn[]>
): Promise<{ pages: PDFPage[]; burns: (WidgetBurn[] | undefined)[] }> {
  await src.flush()
  const copier = PDFObjectCopier.for(src.context, out.context)
  const srcPages = src.getPages()
  const pages = indices.map((i) => {
    const copy = copier.copy(srcPages[i].node) as PDFPageLeaf
    return PDFPage.of(copy, out.context.register(copy), out)
  })
  // Appearance streams of the detached widgets come along with the same copier.
  const copiedBurns = indices.map((i) =>
    burns.get(i)?.flatMap((b) => {
      const apRef = copier.copy(b.apRef)
      return apRef instanceof PDFRef ? [{ apRef, matrix: b.matrix }] : []
    })
  )
  registerCopiedOptionalContent(out, src, copier)
  return { pages, burns: copiedBurns }
}

/** Register the optional content groups used by copied pages, keeping their default state. */
function registerCopiedOptionalContent(out: PDFDocument, src: PDFDocument, copier: PDFObjectCopier): void {
  const ocProps = src.catalog.lookup(N('OCProperties'))
  if (!(ocProps instanceof PDFDict)) return
  const srcGroups = numberArray(ocProps.lookup(N('OCGs')))
  if (!srcGroups.length) return
  const config = ocProps.lookup(N('D'))
  const cfg = config instanceof PDFDict ? config : undefined
  const baseOff = cfg?.lookup(N('BaseState')) === N('OFF')
  const off = new Set(numberArray(cfg?.lookup(N('OFF'))))
  const on = new Set(numberArray(cfg?.lookup(N('ON'))))
  const traversed = (copier as unknown as { traversedObjects?: Map<PDFObject, PDFObject> }).traversedObjects
  const used = srcGroups.filter((g) => !traversed || traversed.has(g))
  if (!used.length) return

  let outProps = out.catalog.lookup(N('OCProperties'))
  if (!(outProps instanceof PDFDict)) {
    outProps = out.context.obj({ OCGs: [], D: { Order: [] } })
    out.catalog.set(N('OCProperties'), outProps as PDFDict)
  }
  const props = outProps as PDFDict
  let ocgs = props.lookup(N('OCGs'))
  if (!(ocgs instanceof PDFArray)) {
    ocgs = out.context.obj([])
    props.set(N('OCGs'), ocgs as PDFArray)
  }
  let d = props.lookup(N('D'))
  if (!(d instanceof PDFDict)) {
    d = out.context.obj({})
    props.set(N('D'), d as PDFDict)
  }
  const outD = d as PDFDict
  const outBaseOff = outD.lookup(N('BaseState')) === N('OFF')
  const listOf = (key: string) => {
    let arr = outD.lookup(N(key))
    if (!(arr instanceof PDFArray)) {
      arr = out.context.obj([])
      outD.set(N(key), arr as PDFArray)
    }
    return arr as PDFArray
  }
  for (const g of used) {
    const mapped = copier.copy(g)
    if (!(mapped instanceof PDFRef)) continue
    ;(ocgs as PDFArray).push(mapped)
    const isOff = off.has(g) || (baseOff && !on.has(g))
    if (isOff && !outBaseOff) listOf('OFF').push(mapped)
    if (!isOff && outBaseOff) listOf('ON').push(mapped)
    const order = outD.lookup(N('Order'))
    if (order instanceof PDFArray) order.push(mapped)
  }
}

/**
 * A second output page showing the same page: shares content streams and resources, has its
 * own /Contents array and copies of the annotations. Widgets are burned in (only one page
 * may own a form field); see PlanItem.burns.
 */
function clonePage(out: PDFDocument, original: PDFPage): PDFPage {
  const ctx = out.context
  const leaf = original.node
  const clone = leaf.clone() as PDFPageLeaf
  const contents = leaf.get(N('Contents'))
  const resolved = ctx.lookup(contents)
  if (resolved instanceof PDFArray) clone.set(N('Contents'), resolved.clone())
  else if (contents instanceof PDFRef) clone.set(N('Contents'), ctx.obj([contents]))
  clone.delete(N('Annots'))
  clone.delete(N('StructParents'))
  clone.delete(N('B'))
  const ref = ctx.register(clone)
  const page = PDFPage.of(clone, ref, out)

  const annots = leaf.Annots()
  const mapping = new Map<PDFRef, PDFRef>()
  const copies: PDFDict[] = []
  if (annots) {
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i)
      const a = ctx.lookup(r)
      if (!(a instanceof PDFDict)) continue
      // Widgets are not copied (a field has one set of widgets); their appearances are
      // burned into the copy later (PlanItem.burns).
      if (a.lookup(N('Subtype')) === N('Widget')) continue
      const copy = a.clone()
      copy.set(N('P'), ref)
      copy.delete(N('StructParent'))
      copy.delete(N('NM'))
      const copyRef = ctx.register(copy)
      if (r instanceof PDFRef) mapping.set(r, copyRef)
      copies.push(copy)
    }
  }
  for (const copy of copies) {
    for (const key of ['Popup', 'Parent', 'IRT']) {
      const target = copy.get(N(key))
      if (target instanceof PDFRef && mapping.has(target)) copy.set(N(key), mapping.get(target)!)
      else if (key === 'Parent' && target instanceof PDFRef) copy.delete(N(key))
    }
  }
  if (mapping.size) clone.set(N('Annots'), ctx.obj([...mapping.values()]))
  return page
}

/** Copy inherited page attributes onto the leaf so it survives re-parenting. */
function materializeInherited(page: PDFPage): void {
  for (const key of INHERITABLE) {
    if (page.node.get(key)) continue
    const value = page.node.getInheritableAttribute(key)
    if (value) page.node.set(key, value)
  }
}

/** Replace the page tree with a flat one containing exactly `pages`, in order. */
function rebuildPageTree(out: PDFDocument, pages: PDFPage[]): void {
  const tree = PDFPageTree.withContext(out.context)
  const treeRef = out.context.register(tree)
  for (const page of pages) {
    tree.pushLeafNode(page.ref)
    page.node.setParent(treeRef)
  }
  out.catalog.set(N('Pages'), treeRef)
  // pdf-lib caches the page list; refresh it.
  const internal = out as unknown as {
    pageCache?: { invalidate(): void }
    pageCount?: number
    pageMap?: Map<PDFPageLeaf, PDFPage>
  }
  for (const page of pages) internal.pageMap?.set(page.node, page)
  internal.pageCache?.invalidate()
  if ('pageCount' in internal) internal.pageCount = pages.length
}

function setInfoString(info: PDFDict, key: string, value: string | undefined): void {
  if (value === undefined) return
  if (value === '') info.delete(N(key))
  else info.set(N(key), PDFHexString.fromText(value))
}

function applyMetadata(out: PDFDocument, doc: EditorDocument): void {
  const md = doc.settings.metadata ?? {}
  const now = new Date()
  out.setProducer(md.producer ?? PRODUCER) // also creates the Info dict if missing
  const info = out.context.lookup(out.context.trailerInfo.Info)
  if (!(info instanceof PDFDict)) return
  setInfoString(info, 'Title', md.title)
  setInfoString(info, 'Author', md.author)
  setInfoString(info, 'Subject', md.subject)
  setInfoString(info, 'Keywords', md.keywords)
  setInfoString(info, 'Creator', md.creator)
  if (md.producer === '') info.delete(N('Producer'))
  if (!info.get(N('Creator')) && md.creator === undefined) out.setCreator(PRODUCER)
  if (!info.get(N('CreationDate'))) out.setCreationDate(now)
  out.setModificationDate(now)
  const overridden = Object.values(md).some((v) => v !== undefined)
  // Viewers prefer XMP over the Info dictionary; drop a stale XMP packet when the user edited metadata.
  if (overridden && out.catalog.get(N('Metadata'))) out.catalog.delete(N('Metadata'))
}

function selectPages(doc: EditorDocument, pageIds?: string[]): PageEntry[] {
  if (!pageIds) return doc.pages
  const ids = new Set(pageIds)
  return doc.pages.filter((p) => ids.has(p.id))
}

/**
 * Produce the final PDF bytes for a document:
 * - preserves the primary source's structure (forms, links, annotations, outline) where possible,
 * - applies page order / rotation / deletion / blank pages / pages from other sources,
 * - fills form values (and flattens if settings.flattenForms),
 * - draws all EditObjects, watermark and page numbers,
 * - writes metadata and applies encryption settings.
 *
 * Notes: a page that appears more than once (duplicates) keeps its interactive form fields
 * only on its first occurrence; later copies get the field values burned in. Repeated pages
 * share content and resources. Everything belonging only to pages that are not exported
 * (content, annotations, form fields, structure elements, outline items) is removed.
 */
export async function exportDocument(doc: EditorDocument, options?: ExportOptions): Promise<Uint8Array> {
  const entries = selectPages(doc, options?.pageIds)
  if (!entries.length) throw new Error('There are no pages to export.')
  const warn = (w: ExportWarning) => options?.onWarning?.(w)
  const cache = new EmbedCache()
  const primary = doc.primarySourceId ? doc.sources[doc.primarySourceId] : undefined
  const opened = primary ? await openPdfLib(primary.bytes, primary.password, { identify: false }) : undefined
  const out = opened ? opened.doc : await PDFDocument.create({ updateMetadata: false })
  const origPages = primary ? out.getPages() : []
  const pageIds = new Set(entries.map((e) => e.id))
  const fieldObjects = doc.objects.filter((o): o is FieldObject => o.type === 'field' && pageIds.has(o.pageId))

  // 1. Plan where each output page comes from.
  const firstUse = new Map<string, PlanItem>()
  const plan: PlanItem[] = entries.map((entry): PlanItem => {
    if (entry.source.kind !== 'source') return { entry, kind: 'blank' }
    const { sourceId, pageIndex } = entry.source
    const source = doc.sources[sourceId]
    const isPrimary = !!primary && sourceId === primary.id
    const exists = isPrimary ? pageIndex >= 0 && pageIndex < origPages.length : !!source && pageIndex >= 0 && pageIndex < source.pageCount
    if (!exists) return { entry, kind: 'blank' }
    const key = `${sourceId}\u0000${pageIndex}`
    const first = firstUse.get(key)
    if (first) return { entry, kind: 'clone', of: first }
    const item: PlanItem = isPrimary ? { entry, kind: 'primary', pageIndex } : { entry, kind: 'copy', sourceId, pageIndex }
    firstUse.set(key, item)
    return item
  })
  const reused = new Set(plan.flatMap((i) => (i.kind === 'primary' ? [i.pageIndex] : [])))
  const removedIndices = origPages.map((_, i) => i).filter((i) => !reused.has(i))
  const removedPages = removedIndices.map((i) => origPages[i])
  const keptPages = [...reused].map((i) => origPages[i])

  // 2. Primary pages: tag annotations (for annotation edits), drop what an earlier export
  //    created for restored EditObjects (they are drawn again below).
  const restored = new Set<string>()
  origPages.forEach((page, i) => {
    tagAnnotations(out.context, page)
    const ids = restoredIdsOf(primary, i)
    if (!ids.size) return
    ids.forEach((id) => restored.add(id))
    removeMarkedAnnotations(out.context, page, ids)
    stripMarkedContent(out, page, ids)
    afterContentRewrite(page)
  })

  // 3. Primary form: restored fields, removed pages, structural edits, values.
  const primaryClones = plan.some(
    (i) => i.kind === 'clone' && i.of.kind === 'primary' && pageWidgets(out, origPages[i.of.pageIndex]).length > 0
  )
  if (primary && hasAcroForm(out)) {
    const values = doc.formValues[primary.id]
    const edits = doc.fieldEdits?.[primary.id]
    const hasValues = !!values && Object.keys(values).length > 0
    const hasEdits = !!edits && Object.keys(edits).length > 0
    if (removedIndices.length || hasValues || hasEdits || restored.size || doc.settings.flattenForms || primaryClones || fieldObjects.length) {
      const form = out.getForm()
      const byName = fieldsByName(form)
      removeRestoredFields(form, byName.values(), restored, origPages)
      // Field edits first: their widget indexes refer to the unmodified file, and a field
      // renamed here and then left without widgets by the page removal is still dropped.
      await applyFieldEdits(out, form, byName, edits, origPages, cache)
      pruneFieldsOnRemovedPages(out, form, origPages, new Set(removedIndices))
      await fillForm(out, form, values, cache, byName)
      if (primaryClones) await refreshAppearancesForBurning(out, form, cache)
    }
  }
  const removed = collectRemoved(out.context, removedPages, keptPages)

  // 4. Copy pages from other sources (each distinct page once, one copier per source so
  //    pages of the same file share their resources).
  const bySource = new Map<string, Extract<PlanItem, { kind: 'copy' }>[]>()
  for (const item of plan) {
    if (item.kind !== 'copy') continue
    const list = bySource.get(item.sourceId) ?? []
    list.push(item)
    bySource.set(item.sourceId, list)
  }
  for (const [sourceId, items] of bySource) {
    const { src, burns } = await loadSourceForCopy(doc, doc.sources[sourceId], cache)
    const copied = await copyForeignPages(
      out,
      src,
      items.map((i) => i.pageIndex),
      burns
    )
    items.forEach((item, i) => {
      item.page = copied.pages[i]
      item.burns = copied.burns[i]
    })
  }

  // 5. Primary pages, blank pages and repeats.
  for (const item of plan) {
    if (item.kind === 'primary') {
      item.page = origPages[item.pageIndex]
      materializeInherited(item.page)
    } else if (item.kind === 'blank') {
      const page = PDFPage.create(out)
      page.setSize(item.entry.width, item.entry.height)
      item.page = page
    }
  }
  // Repeats share content streams and resources with the first occurrence. Nothing has drawn
  // on any page yet, so the copies start from the same (original) content.
  const sharing = new Set<PDFPage>()
  for (const item of plan) {
    if (item.kind !== 'clone') continue
    const original = item.of.page!
    item.page = clonePage(out, original)
    item.burns =
      item.of.kind === 'primary'
        ? pageWidgets(out, original).flatMap((w) => {
            const b = widgetBurn(out, w)
            return b ? [b] : []
          })
        : item.of.burns
    sharing.add(original)
    sharing.add(item.page)
  }

  const finalPages = plan.map((item) => item.page!)
  rebuildPageTree(out, finalPages)

  // Remove every trace of pages that are not exported.
  pruneStructureTree(out, removed)
  pruneDestinations(out, removed, finalPages)
  deleteRemovedAnnotations(out.context, removed)
  for (const p of removedPages) out.context.delete(p.ref)

  // 6. Edits of existing content (first: item ids refer to the original content, so nothing
  //    may draw on a page before), annotation edits, then the burned-in widgets.
  const helpers: ContentEditHelpers = { embedFont: (font) => cache.font(out, font) }
  for (const item of plan) {
    const page = item.page!
    const contentEdits = effectiveContentEdits(doc.contentEdits?.[item.entry.id])
    if (contentEdits.length) {
      if (sharing.has(page)) unshareContents(out, page)
      await applyContentEdits(out, page, visibleBox(page), contentEdits, helpers, restoredIdsOfItem(doc, item))
      afterContentRewrite(page)
    }
    await applyAnnotationEdits(out, page, doc.annotationEdits?.[item.entry.id], cache)
  }
  for (const item of plan) if (item.burns?.length) drawBurns(item.page!, item.burns)

  // 7. New form fields, then flattening (which includes them).
  if (fieldObjects.length) {
    const pageById = new Map(plan.map((item) => [item.entry.id, item.page!]))
    await createNewFields(out, out.getForm(), fieldObjects, (o) => pageById.get(o.pageId), cache)
  }
  if (doc.settings.flattenForms && hasAcroForm(out)) await flattenForm(out, out.getForm(), finalPages, cache)

  // 8. Draw objects, watermark and page numbers.
  const objectsByPage = new Map<string, EditObject[]>()
  for (const obj of doc.objects) {
    let list = objectsByPage.get(obj.pageId)
    if (!list) {
      list = []
      objectsByPage.set(obj.pageId, list)
    }
    list.push(obj)
  }
  const { watermark, pageNumbers } = doc.settings
  for (let i = 0; i < plan.length; i++) {
    const { entry, page } = plan[i] as PlanItem & { page: PDFPage }
    const rotation: Rotation = displayRotation(entry)
    page.setRotation(degrees(rotation))
    const objects = objectsByPage.get(entry.id) ?? []
    if (!objects.length && !watermark && !pageNumbers) continue
    const target: DrawTarget = { doc: out, page, box: visibleBox(page), rotation }
    isolateExistingContent(page)
    for (const obj of objects) {
      try {
        await drawObject(target, obj, cache)
      } catch (e) {
        if (obj.type !== 'image') throw e
        // A corrupt image must not make the whole document unsavable; it is skipped.
        warn({ code: 'image-skipped', message: 'An image could not be embedded and was skipped.', objectId: obj.id })
      }
    }
    if (watermark) await drawWatermark(target, watermark, cache)
    if (pageNumbers) await drawPageNumber(target, pageNumbers, i, plan.length, cache)
  }

  // 9. Keep the EditObjects editable after reopening (after all drawing: the data includes a
  //    fingerprint of the final page content).
  const lastModified = PDFString.fromDate(new Date())
  for (const item of plan) {
    const page = item.page!
    clearPageObjects(page)
    untagAnnotations(out.context, page)
    const objects = objectsByPage.get(item.entry.id)
    if (objects?.length) writePageObjects(out, page, objects, lastModified)
  }

  // 10. Metadata, cleanup, encryption, save.
  applyMetadata(out, doc)
  const enc = doc.settings.encryption
  if (enc && (enc.userPassword || enc.ownerPassword || enc.permissions) && stripPdfAIdentification(out)) {
    warn({
      code: 'pdfa-claim-removed',
      message: 'The PDF/A conformance claim was removed because PDF/A files cannot be encrypted.'
    })
  }
  collectGarbage(out)
  let encrypted = false
  if (enc && primary?.isEncrypted && opened?.security && primary.passwordKind && sameEncryption(enc, encryptionFromSource(primary))) {
    // Unchanged security settings: keep the original encryption, so the file still opens
    // with both original passwords (an AES-256 user password cannot be recovered otherwise).
    const key = await fileEncryptionKey(opened.security, primary.password ?? '', primary.passwordKind, primary.userPassword)
    if (key) encrypted = applyOriginalEncryption(out, opened.security, key)
  }
  if (!encrypted) encrypted = applyEncryption(out, enc)
  if (encrypted) {
    // Embed fonts/images now so their dictionaries get their strings encrypted as well.
    await out.flush()
    encryptStringsForSave(out)
  }
  // Encrypted saves write every object uncompressed (see encryptStringsForSave). Large files
  // too: pdf-lib's object-stream writer is quadratic in the number of objects.
  const plainWriter = encrypted || out.context.enumerateIndirectObjects().length > OBJECT_STREAM_LIMIT
  return out.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: 500,
    ...(plainWriter ? { useObjectStreams: false } : {})
  })
}

/** Content edits without those inside a deleted container (item ids "x1/…" when "x1" is deleted). */
export function effectiveContentEdits(edits: ContentEdit[] | undefined): ContentEdit[] {
  if (!edits?.length) return []
  const deleted = edits.filter((e) => e.deleted).map((e) => `${e.itemId}/`)
  if (!deleted.length) return edits
  return edits.filter((e) => !deleted.some((prefix) => e.itemId.startsWith(prefix)))
}

function restoredIdsOfItem(doc: EditorDocument, item: PlanItem): Set<string> {
  const base = item.kind === 'clone' ? item.of : item
  if (base.kind === 'primary') return restoredIdsOf(doc.sources[doc.primarySourceId!], base.pageIndex)
  if (base.kind === 'copy') return restoredIdsOf(doc.sources[base.sourceId], base.pageIndex)
  return new Set()
}

/** Above this many objects, files are written without object streams (see exportDocument). */
const OBJECT_STREAM_LIMIT = 10_000

/** Export several PDFs, one per group of page ids (used by "Split"). */
export async function splitDocument(doc: EditorDocument, groups: string[][]): Promise<Uint8Array[]> {
  const results: Uint8Array[] = []
  for (const group of groups) results.push(await exportDocument(doc, { pageIds: group }))
  return results
}

// ---------------------------------------------------------------------------------------
// Existing content and page previews
// ---------------------------------------------------------------------------------------

/** Parsed (decrypted) pdf-lib documents per source; never modified (pages are copied out). */
const parsedSources = new WeakMap<SourceDocument, Promise<PDFDocument>>()
const contentItemCache = new WeakMap<SourceDocument, Map<number, Promise<ContentItem[]>>>()

function parsedSource(source: SourceDocument): Promise<PDFDocument> {
  let p = parsedSources.get(source)
  if (!p) {
    p = openPdfLib(source.bytes, source.password, { identify: false }).then((o) => o.doc)
    parsedSources.set(source, p)
    p.catch(() => parsedSources.delete(source))
  }
  return p
}

function sourcePageOf(doc: EditorDocument, pageId: string): { entry: PageEntry; source?: SourceDocument; pageIndex: number } {
  const entry = doc.pages.find((p) => p.id === pageId)
  if (!entry) throw new Error(`Unknown page ${pageId}.`)
  if (entry.source.kind !== 'source') return { entry, pageIndex: -1 }
  const source = doc.sources[entry.source.sourceId]
  const ok = !!source && entry.source.pageIndex >= 0 && entry.source.pageIndex < source.pageCount
  return { entry, source: ok ? source : undefined, pageIndex: entry.source.pageIndex }
}

/**
 * Existing content of a page (text runs, images, paths…) from its source page, in page space,
 * without edits applied (apply ContentEdit.transform for the current placement). Drawings of
 * restored objects are excluded. Blank pages have none. Results are cached per source page.
 */
export async function getContentItems(doc: EditorDocument, pageId: string): Promise<ContentItem[]> {
  const { source, pageIndex } = sourcePageOf(doc, pageId)
  if (!source) return []
  let perSource = contentItemCache.get(source)
  if (!perSource) {
    perSource = new Map()
    contentItemCache.set(source, perSource)
  }
  let items = perSource.get(pageIndex)
  if (!items) {
    items = parsedSource(source).then((pdf) => {
      const page = pdf.getPage(pageIndex)
      return listContentItems(pdf, page, visibleBox(page), restoredIdsOf(source, pageIndex))
    })
    perSource.set(pageIndex, items)
    items.catch(() => perSource!.delete(pageIndex))
  }
  return items
}

/** Copy one page into `dst` without following references to other pages (fast, small). */
function copyPageAlone(dst: PDFDocument, src: PDFDocument, pageIndex: number): PDFPage {
  const copier = PDFObjectCopier.for(src.context, dst.context)
  const traversed = (copier as unknown as { traversedObjects?: Map<PDFObject, PDFObject> }).traversedObjects
  if (traversed) for (const p of src.getPages()) traversed.set(p.ref, PDFNull)
  const copy = copier.copy(src.getPage(pageIndex).node) as PDFPageLeaf
  return PDFPage.of(copy, dst.context.register(copy), dst)
}

/**
 * One-page PDF for displaying a page whose existing content changed (see pageNeedsPreview):
 * the source page with content edits and annotation edits applied and drawings of restored
 * objects removed. Not included: EditObjects, form widgets changes, watermark, page numbers
 * (the UI draws those itself). Keeps the page's own /Rotate and boxes.
 */
export async function renderPagePreview(doc: EditorDocument, pageId: string): Promise<Uint8Array> {
  const { entry, source, pageIndex } = sourcePageOf(doc, pageId)
  const out = await PDFDocument.create({ updateMetadata: false })
  if (!source) {
    out.addPage([entry.width, entry.height])
  } else {
    const cache = new EmbedCache()
    const page = copyPageAlone(out, await parsedSource(source), pageIndex)
    out.addPage(page)
    tagAnnotations(out.context, page)
    const ids = restoredIdsOf(source, pageIndex)
    if (ids.size) {
      removeMarkedAnnotations(out.context, page, ids, { widgets: true })
      stripMarkedContent(out, page, ids)
      afterContentRewrite(page)
    }
    const edits = effectiveContentEdits(doc.contentEdits?.[pageId])
    if (edits.length) {
      await applyContentEdits(out, page, visibleBox(page), edits, { embedFont: (f) => cache.font(out, f) }, ids)
    }
    await applyAnnotationEdits(out, page, doc.annotationEdits?.[pageId], cache)
    applyWidgetEditsToPage(out, page, pageIndex, source.formFields, doc.fieldEdits?.[source.id])
    untagAnnotations(out.context, page)
  }
  return out.save({ useObjectStreams: false, objectsPerTick: Infinity, addDefaultPage: false, updateFieldAppearances: false })
}
