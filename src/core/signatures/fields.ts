/**
 * Low-level walk over the AcroForm field tree (pdf-lib objects), shared by signing and
 * verification. Unlike pdf-lib's PDFForm it creates nothing and keeps track of which indirect
 * object holds each dictionary (needed to write an incremental update).
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, type PDFDocument, type PDFObject, type PDFPage } from '@cantoo/pdf-lib'

const N = (s: string) => PDFName.of(s)
const MAX_DEPTH = 32

export interface WidgetNode {
  dict: PDFDict
  /** The widget's own ref (widgets are normally indirect). */
  ref?: PDFRef
}

export interface FieldNode {
  /** Fully qualified name ("parent.child"). */
  name: string
  dict: PDFDict
  /** The field's own ref, when it is an indirect object. */
  ref?: PDFRef
  /** Nearest indirect object that contains the dictionary (itself when indirect). */
  ownerRef?: PDFRef
  /** Field type (inherited), e.g. "Sig", "Tx". */
  type?: string
  widgets: WidgetNode[]
}

export function textOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText()
    } catch {
      return undefined
    }
  }
  return undefined
}

export function acroFormOf(doc: PDFDocument): PDFDict | undefined {
  const acro = doc.catalog.lookup(N('AcroForm'))
  return acro instanceof PDFDict ? acro : undefined
}

/** Every terminal field of the document's AcroForm. */
export function listFields(doc: PDFDocument): FieldNode[] {
  const out: FieldNode[] = []
  const acro = acroFormOf(doc)
  if (!acro) return out
  const rootRef = doc.context.trailerInfo.Root instanceof PDFRef ? doc.context.trailerInfo.Root : undefined
  const acroRaw = doc.catalog.get(N('AcroForm'))
  const acroOwner = acroRaw instanceof PDFRef ? acroRaw : rootRef
  const seen = new Set<PDFDict>()

  const visit = (entry: PDFObject, parentName: string, inheritedType: string | undefined, owner: PDFRef | undefined, depth: number) => {
    if (depth > MAX_DEPTH) return
    const ref = entry instanceof PDFRef ? entry : undefined
    const dict = ref ? doc.context.lookup(ref) : entry
    if (!(dict instanceof PDFDict) || seen.has(dict)) return
    seen.add(dict)
    const partial = textOf(dict.lookup(N('T')))
    const name = partial === undefined ? parentName : parentName ? `${parentName}.${partial}` : partial
    const ft = dict.lookup(N('FT'))
    const type = ft instanceof PDFName ? ft.decodeText() : inheritedType
    const dictOwner = ref ?? owner
    const kids = dict.lookup(N('Kids'))
    const fieldKids: PDFObject[] = []
    const widgets: WidgetNode[] = []
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.get(i)
        const kidDict = kid instanceof PDFRef ? doc.context.lookup(kid) : kid
        if (!(kidDict instanceof PDFDict)) continue
        // Kids with a partial name (or their own kids) are fields; the others are widgets.
        if (kidDict.has(N('T')) || kidDict.has(N('Kids'))) fieldKids.push(kid)
        else widgets.push({ dict: kidDict, ref: kid instanceof PDFRef ? kid : undefined })
      }
    }
    if (fieldKids.length) {
      for (const kid of fieldKids) visit(kid, name, type, dictOwner, depth + 1)
      return
    }
    if (!widgets.length && dict.lookup(N('Subtype')) === N('Widget')) widgets.push({ dict, ref })
    if (name) out.push({ name, dict, ref, ownerRef: dictOwner, type, widgets })
  }

  const fields = acro.lookup(N('Fields'))
  if (fields instanceof PDFArray) {
    const fieldsRaw = acro.get(N('Fields'))
    const owner = fieldsRaw instanceof PDFRef ? fieldsRaw : acroOwner
    for (let i = 0; i < fields.size(); i++) visit(fields.get(i), '', undefined, owner, 0)
  }
  return out
}

/** Index of the page that shows `widget` (via the pages' /Annots, else /P). */
export function pageIndexOfWidget(pages: PDFPage[], widget: WidgetNode): number | undefined {
  if (widget.ref) {
    for (let i = 0; i < pages.length; i++) {
      const annots = pages[i].node.lookup(N('Annots'))
      if (!(annots instanceof PDFArray)) continue
      for (let k = 0; k < annots.size(); k++) {
        const a = annots.get(k)
        if (a instanceof PDFRef && a.objectNumber === widget.ref.objectNumber && a.generationNumber === widget.ref.generationNumber) return i
      }
    }
  }
  const p = widget.dict.get(N('P'))
  if (p instanceof PDFRef) {
    const i = pages.findIndex((page) => page.ref === p || (page.ref.objectNumber === p.objectNumber && page.ref.generationNumber === p.generationNumber))
    if (i >= 0) return i
  }
  return undefined
}
