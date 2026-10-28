/**
 * Existing annotations (internal): reading them for SourcePageInfo.annotations, and applying
 * AnnotationEdits on export / preview (delete, move/resize with geometry, contents, author,
 * color, uri, regenerated appearance streams).
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
import type { AnnotationEdit, AnnotationInfo, Box, Color } from './model'
import type { PdfBox } from './geometry'
import { rectFromArray, visibleBox } from './pdf'
import { layoutText, prepareText } from './text'
import { normalAppearanceRef } from './flatten'
import type { EmbedCache } from './exportFonts'

const N = (s: string) => PDFName.of(s)

/** Temporary key carrying an annotation's id through page copies during export. */
const TAG = N('OPEAnnotId')
/** Persistent key marking annotations / widgets created for an EditObject (value: object id). */
export const OBJECT_MARK = N('OPEObjectId')

export const annotationId = (index: number) => `a${index}`

function text(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined
}

function nums(o: PDFObject | undefined): number[] | undefined {
  if (!(o instanceof PDFArray)) return undefined
  const out: number[] = []
  for (let i = 0; i < o.size(); i++) {
    const v = o.lookup(i)
    if (!(v instanceof PDFNumber)) return undefined
    out.push(v.asNumber())
  }
  return out
}

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0')

/** PDF color components (gray / RGB / CMYK) → "#rrggbb". */
export function colorFromComponents(c: number[] | undefined): Color | undefined {
  if (!c || !c.length) return undefined
  let rgb: number[]
  if (c.length === 1) rgb = [c[0], c[0], c[0]]
  else if (c.length === 3) rgb = c
  else if (c.length === 4) rgb = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]
  else return undefined
  return `#${rgb.map(hex2).join('')}`
}

function componentsFromColor(color: Color): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  const n = m ? parseInt(m[1], 16) : 0
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Text color of a /DA string ("r g b rg", "g g" or "c m y k k"). */
function daColor(da: string | undefined): Color | undefined {
  if (!da) return undefined
  const rg = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+rg\b/.exec(da)
  if (rg) return colorFromComponents([Number(rg[1]), Number(rg[2]), Number(rg[3])])
  const g = /([-\d.]+)\s+g\b/.exec(da)
  if (g) return colorFromComponents([Number(g[1])])
  const k = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+k\b/.exec(da)
  if (k) return colorFromComponents([Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])])
  return undefined
}

function daFontSize(da: string | undefined): number | undefined {
  const m = da && /([-\d.]+)\s+Tf\b/.exec(da)
  return m ? Number(m[1]) : undefined
}

const subtypeOf = (d: PDFDict) => {
  const s = d.lookup(N('Subtype'))
  return s instanceof PDFName ? s.decodeText() : ''
}

function toPageBox(r: PdfBox, vb: PdfBox): Box {
  return { x: r.x - vb.x, y: vb.y + vb.height - (r.y + r.height), width: r.width, height: r.height }
}

function toPdfBox(b: Box, vb: PdfBox): PdfBox {
  return { x: vb.x + b.x, y: vb.y + vb.height - (b.y + b.height), width: b.width, height: b.height }
}

function uriOf(d: PDFDict): string | undefined {
  const a = d.lookup(N('A'))
  if (!(a instanceof PDFDict) || a.lookup(N('S')) !== N('URI')) return undefined
  return text(a.lookup(N('URI')))
}

/** Value of the persistent object mark of an annotation / widget dict. */
export function objectMark(d: PDFDict): string | undefined {
  return text(d.lookup(OBJECT_MARK))
}

/**
 * Annotations of a page for SourcePageInfo.annotations: widgets and popups are left out, as
 * are annotations created for restored EditObjects (`skipObjects`). Ids are positions in /Annots.
 */
export function readPageAnnotations(
  ctx: PDFContext,
  page: PDFPage,
  vb: PdfBox,
  skipObjects?: Set<string>
): AnnotationInfo[] {
  const annots = page.node.Annots()
  if (!annots) return []
  const out: AnnotationInfo[] = []
  for (let k = 0; k < annots.size(); k++) {
    const d = ctx.lookup(annots.get(k))
    if (!(d instanceof PDFDict)) continue
    const subtype = subtypeOf(d)
    if (!subtype || subtype === 'Widget' || subtype === 'Popup') continue
    const mark = objectMark(d)
    if (mark && skipObjects?.has(mark)) continue
    const rect = rectFromArray(d.lookup(N('Rect')))
    if (!rect) continue
    const info: AnnotationInfo = { id: annotationId(k), subtype, bounds: toPageBox(rect, vb) }
    const contents = text(d.lookup(N('Contents')))
    if (contents !== undefined) info.contents = contents
    const author = text(d.lookup(N('T')))
    if (author !== undefined) info.author = author
    const color =
      subtype === 'FreeText'
        ? (daColor(text(d.lookup(N('DA')))) ?? colorFromComponents(nums(d.lookup(N('C')))))
        : colorFromComponents(nums(d.lookup(N('C'))))
    if (color) info.color = color
    const uri = uriOf(d)
    if (uri !== undefined) info.uri = uri
    info.hasAppearance = !!normalAppearanceRef(ctx, d)
    out.push(info)
  }
  return out
}

/** Tag every annotation of the page with its id (position) so copies keep it. */
export function tagAnnotations(ctx: PDFContext, page: PDFPage): void {
  const annots = page.node.Annots()
  if (!annots) return
  for (let k = 0; k < annots.size(); k++) {
    const d = ctx.lookup(annots.get(k))
    if (d instanceof PDFDict) d.set(TAG, PDFString.of(annotationId(k)))
  }
}

export function untagAnnotations(ctx: PDFContext, page: PDFPage): void {
  const annots = page.node.Annots()
  if (!annots) return
  for (let k = 0; k < annots.size(); k++) {
    const d = ctx.lookup(annots.get(k))
    if (d instanceof PDFDict) d.delete(TAG)
  }
}

/**
 * Remove annotations created for the given EditObjects (they are drawn again on export).
 * Widgets are only removed with `widgets: true` (otherwise fields are removed as fields).
 */
export function removeMarkedAnnotations(
  ctx: PDFContext,
  page: PDFPage,
  ids: Set<string>,
  options: { widgets?: boolean } = {}
): void {
  const annots = page.node.Annots()
  if (!annots || !ids.size) return
  const remove = new Set<number>()
  for (let k = 0; k < annots.size(); k++) {
    const d = ctx.lookup(annots.get(k))
    if (!(d instanceof PDFDict) || (!options.widgets && subtypeOf(d) === 'Widget')) continue
    const mark = objectMark(d)
    if (!mark || !ids.has(mark)) continue
    remove.add(k)
    const popup = d.get(N('Popup'))
    if (popup) for (let j = 0; j < annots.size(); j++) if (annots.get(j) === popup) remove.add(j)
  }
  for (const k of [...remove].sort((a, b) => b - a)) annots.remove(k)
}

// ---------------------------------------------------------------------------------------
// Applying edits
// ---------------------------------------------------------------------------------------

type Mapper = (x: number, y: number) => [number, number]

function mapPairs(arr: PDFObject | undefined, map: Mapper, ctx: PDFContext): PDFArray | undefined {
  const v = nums(arr)
  if (!v || v.length % 2) return undefined
  const out: number[] = []
  for (let i = 0; i + 1 < v.length; i += 2) out.push(...map(v[i], v[i + 1]))
  return ctx.obj(out)
}

function moveGeometry(ctx: PDFContext, d: PDFDict, from: PdfBox, to: PdfBox): void {
  const sx = from.width > 0 ? to.width / from.width : 1
  const sy = from.height > 0 ? to.height / from.height : 1
  const map: Mapper = (x, y) => [to.x + (x - from.x) * sx, to.y + (y - from.y) * sy]
  for (const key of ['QuadPoints', 'Vertices', 'L', 'CL']) {
    const mapped = mapPairs(d.lookup(N(key)), map, ctx)
    if (mapped) d.set(N(key), mapped)
  }
  const ink = d.lookup(N('InkList'))
  if (ink instanceof PDFArray) {
    const paths: PDFArray[] = []
    for (let i = 0; i < ink.size(); i++) {
      const p = mapPairs(ink.lookup(i), map, ctx)
      if (p) paths.push(p)
    }
    d.set(N('InkList'), ctx.obj(paths))
  }
  const rd = nums(d.lookup(N('RD')))
  if (rd && rd.length === 4) d.set(N('RD'), ctx.obj([rd[0] * sx, rd[1] * sy, rd[2] * sx, rd[3] * sy]))
  d.set(N('Rect'), ctx.obj([to.x, to.y, to.x + to.width, to.y + to.height]))
  // Keep an attached popup next to its annotation.
  const popup = d.lookup(N('Popup'))
  const popupRect = popup instanceof PDFDict ? rectFromArray(popup.lookup(N('Rect'))) : undefined
  if (popup instanceof PDFDict && popupRect) {
    const dx = to.x - from.x
    const dy = to.y + to.height - (from.y + from.height)
    popup.set(
      N('Rect'),
      ctx.obj([popupRect.x + dx, popupRect.y + dy, popupRect.x + popupRect.width + dx, popupRect.y + popupRect.height + dy])
    )
  }
}

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(Math.round(n * 1000) / 1000))

function borderWidth(d: PDFDict): number {
  const bs = d.lookup(N('BS'))
  if (bs instanceof PDFDict) {
    const w = bs.lookup(N('W'))
    if (w instanceof PDFNumber) return w.asNumber()
  }
  const border = nums(d.lookup(N('Border')))
  if (border && border.length >= 3) return border[2]
  return 1
}

function opacityGs(ctx: PDFContext, d: PDFDict, blend?: string): { resources: Record<string, unknown>; op: string } {
  const ca = d.lookup(N('CA'))
  const opacity = ca instanceof PDFNumber ? ca.asNumber() : 1
  if (opacity >= 1 && !blend) return { resources: {}, op: '' }
  const gs: Record<string, unknown> = { Type: 'ExtGState', CA: opacity, ca: opacity }
  if (blend) gs.BM = blend
  return { resources: { ExtGState: { GS0: ctx.obj(gs as never) } }, op: '/GS0 gs\n' }
}

function ellipsePath(x: number, y: number, w: number, h: number): string {
  const k = 0.5522847498
  const rx = w / 2
  const ry = h / 2
  const cx = x + rx
  const cy = y + ry
  const ox = rx * k
  const oy = ry * k
  return [
    `${fmt(cx - rx)} ${fmt(cy)} m`,
    `${fmt(cx - rx)} ${fmt(cy + oy)} ${fmt(cx - ox)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`,
    `${fmt(cx + ox)} ${fmt(cy + ry)} ${fmt(cx + rx)} ${fmt(cy + oy)} ${fmt(cx + rx)} ${fmt(cy)} c`,
    `${fmt(cx + rx)} ${fmt(cy - oy)} ${fmt(cx + ox)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`,
    `${fmt(cx - ox)} ${fmt(cy - ry)} ${fmt(cx - rx)} ${fmt(cy - oy)} ${fmt(cx - rx)} ${fmt(cy)} c`,
    'h'
  ].join('\n')
}

function arrowHeadPath(x1: number, y1: number, x2: number, y2: number, size: number, closed: boolean): string {
  const len = Math.hypot(x2 - x1, y2 - y1)
  if (!len) return ''
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  const bx = x2 - ux * size
  const by = y2 - uy * size
  const lx = bx - uy * size * 0.5
  const ly = by + ux * size * 0.5
  const rx = bx + uy * size * 0.5
  const ry = by - ux * size * 0.5
  return closed
    ? `${fmt(x2)} ${fmt(y2)} m ${fmt(lx)} ${fmt(ly)} l ${fmt(rx)} ${fmt(ry)} l h B\n`
    : `${fmt(lx)} ${fmt(ly)} m ${fmt(x2)} ${fmt(y2)} l ${fmt(rx)} ${fmt(ry)} l S\n`
}

/** Build a fresh normal appearance for common annotation types. Returns false if unsupported. */
export async function regenerateAppearance(pdf: PDFDocument, d: PDFDict, cache: EmbedCache): Promise<boolean> {
  const ctx = pdf.context
  const subtype = subtypeOf(d)
  const rect = rectFromArray(d.lookup(N('Rect')))
  if (!rect || rect.width <= 0 || rect.height <= 0) return false
  const w = rect.width
  const h = rect.height
  const local = (x: number, y: number): [number, number] => [x - rect.x, y - rect.y]
  const c = nums(d.lookup(N('C')))
  const rgb = colorFromComponents(c)
  const col = rgb ? componentsFromColor(rgb).map(fmt).join(' ') : undefined
  const ic = colorFromComponents(nums(d.lookup(N('IC'))))
  const icCol = ic ? componentsFromColor(ic).map(fmt).join(' ') : undefined
  const bw = borderWidth(d)
  let content = ''
  let resources: Record<string, unknown> = {}

  switch (subtype) {
    case 'Square':
    case 'Circle': {
      if (!col && !icCol) return false
      const g = opacityGs(ctx, d)
      resources = g.resources
      const inset = col ? bw / 2 : 0
      const path =
        subtype === 'Square'
          ? `${fmt(inset)} ${fmt(inset)} ${fmt(w - 2 * inset)} ${fmt(h - 2 * inset)} re`
          : ellipsePath(inset, inset, w - 2 * inset, h - 2 * inset)
      const paint = col && icCol ? 'B' : col ? 'S' : 'f'
      content = `${g.op}${col ? `${col} RG ${fmt(bw)} w\n` : ''}${icCol ? `${icCol} rg\n` : ''}${path}\n${paint}\n`
      break
    }
    case 'Line': {
      const l = nums(d.lookup(N('L')))
      if (!l || l.length !== 4 || !col) return false
      const g = opacityGs(ctx, d)
      resources = g.resources
      const [x1, y1] = local(l[0], l[1])
      const [x2, y2] = local(l[2], l[3])
      const le = d.lookup(N('LE'))
      const ending = (i: number) => {
        const n = le instanceof PDFArray ? le.lookup(i) : undefined
        return n instanceof PDFName ? n.decodeText() : 'None'
      }
      const size = Math.max(6, bw * 4)
      let heads = ''
      for (const [i, [ax, ay, bx, by]] of [
        [0, [x2, y2, x1, y1]],
        [1, [x1, y1, x2, y2]]
      ] as const) {
        const e = ending(i)
        if (e === 'OpenArrow' || e === 'ClosedArrow') heads += arrowHeadPath(ax, ay, bx, by, size, e === 'ClosedArrow')
      }
      content = `${g.op}${col} RG ${col} rg ${fmt(bw)} w 1 J\n${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S\n${heads}`
      break
    }
    case 'Ink': {
      const ink = d.lookup(N('InkList'))
      if (!(ink instanceof PDFArray) || !col) return false
      const g = opacityGs(ctx, d)
      resources = g.resources
      let paths = ''
      for (let i = 0; i < ink.size(); i++) {
        const p = nums(ink.lookup(i))
        if (!p || p.length < 2) continue
        for (let j = 0; j + 1 < p.length; j += 2) {
          const [x, y] = local(p[j], p[j + 1])
          paths += `${fmt(x)} ${fmt(y)} ${j === 0 ? 'm' : 'l'}\n`
        }
        if (p.length === 2) {
          const [x, y] = local(p[0], p[1])
          paths += `${fmt(x)} ${fmt(y)} l\n`
        }
      }
      content = `${g.op}${col} RG ${fmt(bw)} w 1 J 1 j\n${paths}S\n`
      break
    }
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const q = nums(d.lookup(N('QuadPoints')))
      if (!q || q.length < 8 || !col) return false
      const g = opacityGs(ctx, d, subtype === 'Highlight' ? 'Multiply' : undefined)
      resources = g.resources
      let ops = ''
      for (let i = 0; i + 7 < q.length; i += 8) {
        const p1 = local(q[i], q[i + 1])
        const p2 = local(q[i + 2], q[i + 3])
        const p3 = local(q[i + 4], q[i + 5])
        const p4 = local(q[i + 6], q[i + 7])
        const height = Math.hypot(p1[0] - p3[0], p1[1] - p3[1])
        const lw = Math.max(1, height / 14)
        if (subtype === 'Highlight') {
          ops += `${fmt(p1[0])} ${fmt(p1[1])} m ${fmt(p2[0])} ${fmt(p2[1])} l ${fmt(p4[0])} ${fmt(p4[1])} l ${fmt(p3[0])} ${fmt(p3[1])} l h f\n`
        } else if (subtype === 'Underline') {
          const off = lw
          ops += `${fmt(lw)} w ${fmt(p3[0])} ${fmt(p3[1] + off)} m ${fmt(p4[0])} ${fmt(p4[1] + off)} l S\n`
        } else if (subtype === 'StrikeOut') {
          const a = [(p1[0] + p3[0]) / 2, (p1[1] + p3[1]) / 2]
          const b = [(p2[0] + p4[0]) / 2, (p2[1] + p4[1]) / 2]
          ops += `${fmt(lw)} w ${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S\n`
        } else {
          const len = Math.hypot(p4[0] - p3[0], p4[1] - p3[1])
          const step = Math.max(2, height / 6)
          const n = Math.max(1, Math.floor(len / step))
          const ux = (p4[0] - p3[0]) / (len || 1)
          const uy = (p4[1] - p3[1]) / (len || 1)
          let s = `${fmt(lw)} w ${fmt(p3[0])} ${fmt(p3[1] + lw)} m\n`
          for (let j = 1; j <= n; j++) {
            const up = j % 2 ? step / 2 : 0
            s += `${fmt(p3[0] + ux * j * step - uy * up)} ${fmt(p3[1] + lw + uy * j * step + ux * up)} l\n`
          }
          ops += `${s}S\n`
        }
      }
      content = `${g.op}${col} rg ${col} RG\n${ops}`
      break
    }
    case 'Text': {
      const fill = col ?? '1 0.84 0'
      const r = Math.min(w, h) * 0.15
      content =
        `${fill} rg 0.25 0.25 0.25 RG 1 w\n` +
        `${fmt(0.5)} ${fmt(r + 0.5)} m ${fmt(0.5)} ${fmt(h - 0.5)} l ${fmt(w - 0.5)} ${fmt(h - 0.5)} l ${fmt(w - 0.5)} ${fmt(r + 0.5)} l ` +
        `${fmt(w * 0.45)} ${fmt(r + 0.5)} l ${fmt(w * 0.25)} ${fmt(0.5)} l ${fmt(w * 0.3)} ${fmt(r + 0.5)} l h B\n` +
        [0.72, 0.55, 0.38].map((f) => `${fmt(w * 0.2)} ${fmt(h * f)} m ${fmt(w * 0.8)} ${fmt(h * f)} l S`).join('\n') +
        '\n'
      break
    }
    case 'FreeText': {
      const da = text(d.lookup(N('DA')))
      const size = daFontSize(da) || 12
      const textColor = daColor(da) ?? '#000000'
      const contents = text(d.lookup(N('Contents'))) ?? ''
      const style = { font: 'sans' as const, bold: false, italic: false }
      const pad = 2 + bw
      const layout = layoutText({ ...style, text: contents, fontSize: size, lineHeight: 1.2, width: w - 2 * pad, align: 'left' })
      const font = await cache.font(pdf, prepareText(contents, style).font)
      resources = { Font: { F1: font.ref } }
      let body = ''
      for (const line of layout.lines) {
        if (!line.text) continue
        const x = pad + line.x
        const y = h - pad - line.baseline
        body += `BT /F1 ${fmt(size)} Tf ${fmt(x)} ${fmt(y)} Td ${font.encodeText(line.text).toString()} Tj ET\n`
      }
      const bg = col ? `${col} rg 0 0 ${fmt(w)} ${fmt(h)} re f\n` : ''
      const border = bw > 0 && d.lookup(N('BS')) instanceof PDFDict ? `${componentsFromColor(textColor).map(fmt).join(' ')} RG ${fmt(bw)} w ${fmt(bw / 2)} ${fmt(bw / 2)} ${fmt(w - bw)} ${fmt(h - bw)} re S\n` : ''
      content = `${bg}${border}${componentsFromColor(textColor).map(fmt).join(' ')} rg\n${body}`
      break
    }
    default:
      return false
  }
  const stream = ctx.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, w, h],
    Resources: resources as never
  })
  d.set(N('AP'), ctx.obj({ N: ctx.register(stream) }))
  return true
}

/** Types whose appearance viewers regenerate reliably when /AP is missing. */
const VIEWER_REGENERATES = new Set(['Polygon', 'PolyLine', 'Link'])

/**
 * Apply annotation edits to a page whose annotations were tagged with tagAnnotations()
 * (directly or on the page it was copied from).
 */
export async function applyAnnotationEdits(
  pdf: PDFDocument,
  page: PDFPage,
  edits: AnnotationEdit[] | undefined,
  cache: EmbedCache
): Promise<void> {
  if (!edits?.length) return
  const ctx = pdf.context
  const annots = page.node.Annots()
  if (!annots) return
  const byId = new Map(edits.map((e) => [e.annotId, e]))
  const vb = visibleBox(page)
  const remove = new Set<number>()
  const refIndex = new Map<PDFObject, number>()
  for (let k = 0; k < annots.size(); k++) refIndex.set(annots.get(k), k)
  for (let k = 0; k < annots.size(); k++) {
    const d = ctx.lookup(annots.get(k))
    if (!(d instanceof PDFDict)) continue
    const id = text(d.lookup(TAG))
    const edit = id ? byId.get(id) : undefined
    if (!edit) continue
    if (edit.deleted) {
      remove.add(k)
      const popup = d.get(N('Popup'))
      if (popup instanceof PDFRef && refIndex.has(popup)) remove.add(refIndex.get(popup)!)
      continue
    }
    const subtype = subtypeOf(d)
    let regenerate = false
    if (edit.bounds) {
      const from = rectFromArray(d.lookup(N('Rect')))
      if (from) {
        moveGeometry(ctx, d, from, toPdfBox(edit.bounds, vb))
        regenerate ||= subtype === 'FreeText' || subtype === 'Square' || subtype === 'Circle'
      }
    }
    if (edit.contents !== undefined) {
      d.set(N('Contents'), PDFHexString.fromText(edit.contents))
      regenerate ||= subtype === 'FreeText'
    }
    if (edit.author !== undefined) d.set(N('T'), PDFHexString.fromText(edit.author))
    if (edit.color !== undefined) {
      const comps = componentsFromColor(edit.color)
      if (subtype === 'FreeText') {
        const da = text(d.lookup(N('DA'))) ?? '/Helv 12 Tf'
        const stripped = da.replace(/([-\d.]+\s+){1,4}(rg|g|k)\b/g, '').trim()
        d.set(N('DA'), PDFString.of(`${stripped} ${comps.map(fmt).join(' ')} rg`.trim()))
      } else {
        d.set(N('C'), ctx.obj(comps))
      }
      regenerate = true
    }
    if (edit.uri !== undefined) {
      d.set(N('A'), ctx.obj({ S: 'URI', URI: PDFString.of(edit.uri) }))
    }
    d.set(N('M'), PDFString.fromDate(new Date()))
    if (regenerate) {
      const done = await regenerateAppearance(pdf, d, cache)
      if (!done && VIEWER_REGENERATES.has(subtype)) d.delete(N('AP'))
    }
  }
  for (const k of [...remove].sort((a, b) => b - a)) annots.remove(k)
}
