/**
 * Redaction of page content: everything drawn under the given areas is removed from the
 * content stream (not covered up). Untouched operations are copied byte-for-byte.
 *
 * - Text: glyphs whose box overlaps an area are taken out of their show operator (Tj, TJ, ',
 *   "), which becomes a TJ whose numeric adjustments stand in for the removed glyphs, so every
 *   remaining glyph keeps its exact position. Invisible text (Tr 3, e.g. OCR layers) and text in
 *   hidden layers is redacted too. Marked-content sections that lose content also lose their
 *   /ActualText, /Alt and /E replacement texts.
 * - Paths (and shadings painted with `sh`): removed when fully inside one area, otherwise the
 *   areas are clipped out of them (`q <outside of the areas> W* n … Q`).
 * - Images (XObjects and inline images): removed when fully covered, otherwise replaced by a
 *   new image XObject whose pixels under the areas are painted over (images.ts). The original
 *   image object is not modified, so other pages / occurrences keep it.
 * - Form XObjects: removed when inside one area, otherwise redacted in a private copy
 *   (recursively); the one `Do` is re-pointed at the copy.
 * Resource entries that the rewritten content no longer uses (original images / forms that
 * were redacted) are removed from the (copy-on-write) resources, so the file does not keep
 * them for nothing.
 *
 * With `removeHiddenLayers`, content in optional-content layers that are hidden by default
 * is removed as well (sanitize).
 */
import { PDFArray, PDFDict, PDFName, PDFStream, type PDFContext, type PDFRef } from '@cantoo/pdf-lib'
import type { Point } from '../model'
import type { PdfBox } from '../geometry'
import { loadFont, type FontInfo } from './fonts'
import { redactImageXObject, redactInlineImage, UnsupportedImageError, type Rgb, type UnitPolygon } from './images'
import { Interpreter } from './interpreter'
import { PdfDictOp, PdfName, PdfStr, isWhite, parseContent, type Op, type Operand } from './lexer'
import { IDENTITY, apply, intersectRect, invert, isFiniteMatrix, maxScale, mul, rectOfPoints, translate, type Rect } from './matrix'
import { ResourceEditor } from './page'
import { pathBounds, type Seg } from './paths'
import { N, arrayItems, get, getDict, getMatrix, getName, numberArray, numberOf, streamData } from './pdfobj'
import { ByteWriter, fmt, writeName, writeOp, writeOperand } from './serialize'
import type { Matrix } from '../model'

export type RedactWarningCode = 'image-removed' | 'form-removed'

export interface RedactContentOptions {
  /** Areas in PDF user space of the page (axis-aligned). */
  areas: Rect[]
  /** Also remove content of optional-content layers hidden by default. */
  removeHiddenLayers?: boolean
  /** Color painted into image pixels under the areas. */
  imageFill: Rgb
  cropBox: PdfBox
  onWarning?: (code: RedactWarningCode, message: string) => void
}

export interface RedactContentResult {
  /** The rewritten content, or null when nothing had to change. */
  data: Uint8Array | null
  /** MCIDs of page-level marked-content sections that lost content. */
  touchedMcids: number[]
}

type Replacement = string | Uint8Array | null

/** Nesting levels of form XObject copies. */
const MAX_FORM_DEPTH = 8
/** Glyph hit boxes: from this fraction of the font size below the baseline to … above it. */
const HIT_DESCENT = 0.25
const HIT_ASCENT = 0.8
const STREAM_KEYS = new Set(['Filter', 'DecodeParms', 'Length', 'DL', 'F', 'FFilter', 'FDecodeParms'])
const REPLACEMENT_TEXT_KEYS = ['ActualText', 'Alt', 'E']
const TEXT_STATE_KEYS: Record<string, 'tc' | 'tw' | 'th' | 'tl' | 'ts' | 'tr'> = { Tc: 'tc', Tw: 'tw', Tz: 'th', TL: 'tl', Ts: 'ts', Tr: 'tr' }

interface TextState {
  font: FontInfo | null
  size: number
  tc: number
  tw: number
  th: number
  tl: number
  ts: number
  tr: number
}

interface GState {
  ctm: Matrix
  lw: number
  /** Bounds of the clipping region in user space (null = unclipped). */
  clip: Rect | null
  text: TextState
}

interface Session {
  ctx: PDFContext
  areas: Rect[]
  hidden: boolean
  oc: Interpreter
  fill: Rgb
  crop: Rect
  warn: (code: RedactWarningCode, message: string) => void
  /** Form copies made only for hidden-layer removal (they do not depend on placement). */
  formCache: Map<PDFStream, PDFRef | null>
  touchedMcids: Set<number>
  /** Listing mode: called for every glyph that stays (hit box quad in user space). */
  collect?: (quad: Point[], unicode: string) => void
}

interface Target {
  data: Uint8Array
  res: ResourceEditor
  start: GState
  depth: number
  pageLevel: boolean
}

interface MarkedEntry {
  op: number
  hidden: boolean
  mcid?: number
  /** The section's properties carry replacement text (ActualText / Alt / E). */
  replacementText: boolean
  touched: boolean
}

// ---------------------------------------------------------------------------------------
// Geometry

const overlaps = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0)
const contains = (outer: Rect, inner: Rect) =>
  inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1

function corners(r: Rect): Point[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 }
  ]
}

/** Clip a convex polygon to the box [x0,x1]×[y0,y1]; returns the area of the result. */
function clippedArea(poly: Point[], x0: number, y0: number, x1: number, y1: number): number {
  let pts = poly
  const edges: [(p: Point) => number, number, 'x' | 'y', 1 | -1][] = [
    [(p) => p.x, x0, 'x', 1],
    [(p) => p.x, x1, 'x', -1],
    [(p) => p.y, y0, 'y', 1],
    [(p) => p.y, y1, 'y', -1]
  ]
  for (const [coord, edge, axis, dir] of edges) {
    const inside = (p: Point) => (coord(p) - edge) * dir >= 0
    const out: Point[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const ia = inside(a)
      const ib = inside(b)
      if (ia) out.push(a)
      if (ia !== ib) {
        const t = (edge - coord(a)) / (coord(b) - coord(a))
        const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
        if (axis === 'x') p.x = edge
        else p.y = edge
        out.push(p)
      }
    }
    pts = out
    if (pts.length < 3) return 0
  }
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

/** Whether the (convex) quad in user space overlaps the rectangle with a non-zero area. */
function quadOverlaps(quad: Point[], r: Rect): boolean {
  const b = rectOfPoints(quad)!
  if (!overlaps(b, r)) return false
  return clippedArea(quad, r.x0, r.y0, r.x1, r.y1) > 1e-9
}

function pointIn(r: Rect, p: Point): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1
}

// ---------------------------------------------------------------------------------------
// Emitting

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function onlyWhitespaceOrComments(bytes: Uint8Array): boolean {
  let inComment = false
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (inComment) {
      if (c === 0x0a || c === 0x0d) inComment = false
      continue
    }
    if (c === 0x25) inComment = true
    else if (!isWhite(c)) return false
  }
  return true
}

function emit(ops: Op[], data: Uint8Array, plan: Map<number, Replacement>): Uint8Array {
  const w = new ByteWriter()
  let prev = 0
  const removed = (k: number) => plan.has(k) && plan.get(k) == null
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op.start > prev && !(k > 0 && removed(k) && removed(k - 1))) w.bytes(data.subarray(prev, op.start))
    prev = op.end
    if (!plan.has(k)) {
      w.bytes(data.subarray(op.start, op.end))
      continue
    }
    const r = plan.get(k)
    if (r == null) continue
    w.text('\n')
    if (typeof r === 'string') w.text(r)
    else w.bytes(r)
    w.text('\n')
  }
  const tail = data.subarray(ops.length ? ops[ops.length - 1].end : 0)
  if (onlyWhitespaceOrComments(tail)) w.bytes(tail)
  return w.toBytes()
}

// ---------------------------------------------------------------------------------------

function nameArg(op: Op, i: number): string | undefined {
  const a = op.args[i]
  return a instanceof PdfName ? a.name : undefined
}

function numArgs(op: Op, n: number): number[] | undefined {
  if (op.args.length < n) return undefined
  const out: number[] = []
  for (let i = op.args.length - n; i < op.args.length; i++) {
    const v = op.args[i]
    if (typeof v !== 'number') return undefined
    out.push(v)
  }
  return out
}

function initialText(): TextState {
  return { font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0 }
}

/**
 * Redact the page content `data` (the page's decoded content streams) drawn with resources
 * `res`. Returns the new content (null when unchanged).
 */
export async function redactContent(
  ctx: PDFContext,
  data: Uint8Array,
  res: ResourceEditor,
  options: RedactContentOptions
): Promise<RedactContentResult> {
  const session = newSession(ctx, options)
  const out = await redactStream(session, { data, res, start: startState(), depth: 0, pageLevel: true })
  return { data: out, touchedMcids: [...session.touchedMcids] }
}

function newSession(ctx: PDFContext, options: RedactContentOptions): Session {
  const b = options.cropBox
  return {
    ctx,
    areas: options.areas.filter((a) => a.x1 > a.x0 && a.y1 > a.y0),
    hidden: !!options.removeHiddenLayers,
    oc: new Interpreter(ctx, { cropBox: b }),
    fill: options.imageFill,
    crop: { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height },
    warn: options.onWarning ?? (() => {}),
    formCache: new Map(),
    touchedMcids: new Set()
  }
}

const startState = (): GState => ({ ctm: IDENTITY, lw: 1, clip: null, text: initialText() })

export interface GlyphBox {
  /** Hit box of the glyph (as used for redaction) in PDF user space. */
  quad: Point[]
  unicode: string
}

/** Every glyph drawn by the content (also inside form XObjects), with the box redaction tests it with. */
export async function listGlyphBoxes(ctx: PDFContext, data: Uint8Array, res: ResourceEditor, cropBox: PdfBox): Promise<GlyphBox[]> {
  const out: GlyphBox[] = []
  const session = newSession(ctx, { areas: [], imageFill: [0, 0, 0], cropBox })
  session.collect = (quad, unicode) => out.push({ quad, unicode })
  await redactStream(session, { data, res, start: startState(), depth: 0, pageLevel: true })
  return out
}

async function redactStream(s: Session, t: Target): Promise<Uint8Array | null> {
  if (!s.areas.length && !s.hidden && !s.collect) return null
  const ctx = s.ctx
  const ops = parseContent(t.data)
  const plan = new Map<number, Replacement>()
  const resources = t.res.resources()
  const fonts = getDict(resources, 'Font')
  const xobjects = getDict(resources, 'XObject')
  const extGStates = getDict(resources, 'ExtGState')
  const properties = getDict(resources, 'Properties')
  const fontCache = new Map<string, FontInfo>()
  const fontByName = (name: string) => {
    let f = fontCache.get(name)
    if (!f) {
      f = loadFont(ctx, fonts ? get(fonts, name) : undefined)
      fontCache.set(name, f)
    }
    return f
  }

  let g: GState = t.start
  const stack: GState[] = []
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY
  let path: Seg[] = []
  let pathOps: number[] = []
  let cur: Point = { x: 0, y: 0 }
  let subStart: Point = { x: 0, y: 0 }
  let pendingClip: { evenOdd: boolean; op: number } | null = null
  const marked: MarkedEntry[] = []
  let hiddenDepth = 0
  /** XObject names whose Do was replaced or removed / that are still drawn. */
  const replacedNames = new Set<string>()
  const keptNames = new Set<string>()
  let inheritingForm = false

  const touch = () => {
    for (const m of marked) m.touched = true
  }
  const setText = (patch: Partial<TextState>) => {
    g = { ...g, text: { ...g.text, ...patch } }
  }
  const opText = (k: number) => latin1(t.data.subarray(ops[k].start, ops[k].end))

  /** The user-space region outside every area in `hits`, as clipping operators in the current space. */
  const exclusionClip = (hits: Rect[], extent: Rect): string | null => {
    const inv = invert(g.ctm)
    if (!inv) return null
    const margin = 1000
    const big: Rect = {
      x0: Math.min(extent.x0, s.crop.x0) - margin,
      y0: Math.min(extent.y0, s.crop.y0) - margin,
      x1: Math.max(extent.x1, s.crop.x1) + margin,
      y1: Math.max(extent.y1, s.crop.y1) + margin
    }
    const poly = (r: Rect) =>
      corners(r)
        .map((p, i) => {
          const q = apply(inv, p.x, p.y)
          return `${fmt(q.x, 4)} ${fmt(q.y, 4)} ${i ? 'l' : 'm'}`
        })
        .join(' ') + ' h'
    // One clip per area: overlapping areas stay excluded (a single even-odd path would not).
    return hits.map((r) => `${poly(big)} ${poly(r)} W* n`).join('\n')
  }

  const hitAreas = (r: Rect | null) => (r ? s.areas.filter((a) => overlaps(a, r)) : [])

  // ---- text
  const show = (k: number, op: Op) => {
    // Glyph positions only matter for hit tests (sanitize-only passes skip them).
    if (!hiddenDepth && !s.areas.length && !s.collect) return
    let elements: Operand[]
    if (op.op === 'TJ') {
      const arr = op.args[op.args.length - 1]
      elements = Array.isArray(arr) ? arr : []
    } else {
      const str = op.args[op.args.length - 1]
      elements = str instanceof PdfStr ? [str] : []
    }
    const ts = g.text
    const font = ts.font ?? loadFont(ctx, undefined)
    const { size, th, tc, tw, ts: rise } = ts
    const vertical = font.vertical
    const along = vertical ? size : size * th
    const M = mul(tm, g.ctm)
    const removeAll = hiddenDepth > 0
    // Areas in text space (relative to the text matrix at the start of the operator).
    const Minv = invert(M)
    let local: { poly: Point[]; box: Rect }[] = []
    if (!removeAll && s.areas.length) {
      if (Minv) {
        local = s.areas.map((a) => {
          const poly = corners(a).map((p) => apply(Minv, p.x, p.y))
          return { poly, box: rectOfPoints(poly)! }
        })
      }
    }
    const asc = Math.min(font.ascent > 0 ? font.ascent : HIT_ASCENT, HIT_ASCENT)
    const desc = Math.max(font.descent < 0 ? font.descent : -HIT_DESCENT, -HIT_DESCENT)
    /** A glyph's hit box in text space. */
    const glyphBox = (pen: number, ext: number): Rect => {
      let x0: number, x1: number, y0: number, y1: number
      if (vertical) {
        const half = Math.abs(size) / 2
        x0 = -half
        x1 = half
        y0 = Math.min(pen, pen + ext)
        y1 = Math.max(pen, pen + ext)
      } else {
        x0 = Math.min(pen, pen + ext)
        x1 = Math.max(pen, pen + ext)
        const ya = rise + desc * size
        const yb = rise + asc * size
        y0 = Math.min(ya, yb)
        y1 = Math.max(ya, yb)
      }
      // Zero-width glyphs (and size 0) still count when they sit inside an area.
      if (x1 - x0 < 1e-6) x1 = x0 + 1e-6
      if (y1 - y0 < 1e-6) y1 = y0 + 1e-6
      return { x0, y0, x1, y1 }
    }
    const hit = (pen: number, ext: number): boolean => {
      if (removeAll) return true
      if (!s.areas.length) return false
      if (!Minv) {
        const p = vertical ? apply(M, 0, pen) : apply(M, pen, rise)
        return s.areas.some((a) => pointIn(a, p))
      }
      const { x0, y0, x1, y1 } = glyphBox(pen, ext)
      const boxArea = (x1 - x0) * (y1 - y0)
      return local.some(
        (l) =>
          l.box.x1 > x0 && l.box.x0 < x1 && l.box.y1 > y0 && l.box.y0 < y1 && clippedArea(l.poly, x0, y0, x1, y1) > boxArea * 1e-6
      )
    }

    interface GlyphRun {
      start: number
      end: number
      adv: number
      removed: boolean
    }
    const parts: ({ num: number } | { str: PdfStr; glyphs: GlyphRun[] } | null)[] = []
    let pen = 0
    let any = false
    for (const el of elements) {
      if (typeof el === 'number') {
        pen += (-el / 1000) * along
        parts.push({ num: el })
        continue
      }
      if (!(el instanceof PdfStr)) {
        parts.push(null)
        continue
      }
      const glyphs: GlyphRun[] = []
      let offset = 0
      for (const gl of font.glyphs(el.bytes)) {
        const spacing = gl.space ? tw : 0
        const adv = vertical ? gl.width * size + tc + spacing : (gl.width * size + tc + spacing) * th
        const ext = vertical ? gl.width * size : gl.width * size * th
        const removed = hit(pen, ext)
        if (removed) any = true
        else if (s.collect && Minv) s.collect(corners(glyphBox(pen, ext)).map((p) => apply(M, p.x, p.y)), gl.unicode)
        glyphs.push({ start: offset, end: offset + gl.len, adv, removed })
        offset += gl.len
        pen += adv
      }
      if (offset < el.bytes.length) glyphs.push({ start: offset, end: el.bytes.length, adv: 0, removed: removeAll })
      parts.push({ str: el, glyphs })
    }
    tm = vertical ? mul(translate(0, pen), tm) : mul(translate(pen, 0), tm)
    if (!any) return
    touch()
    const out: Operand[] = []
    let pending = 0
    const flush = () => {
      if (Math.abs(pending) > 1e-9) out.push(Number(fmt(pending, 4)))
      pending = 0
    }
    for (const part of parts) {
      if (!part) continue
      if ('num' in part) {
        pending += part.num
        continue
      }
      let runStart = -1
      let runEnd = -1
      const flushRun = () => {
        if (runStart < 0) return
        flush()
        out.push(new PdfStr(part.str.bytes.subarray(runStart, runEnd), part.str.hex))
        runStart = -1
      }
      for (const gl of part.glyphs) {
        if (gl.removed) {
          flushRun()
          if (along) pending += (-gl.adv * 1000) / along
          continue
        }
        if (runStart < 0) runStart = gl.start
        runEnd = gl.end
      }
      flushRun()
    }
    flush()
    const shows = out.length ? `${writeOperand(out)} TJ` : ''
    if (op.op === 'TJ' || op.op === 'Tj') {
      plan.set(k, shows || null)
    } else if (op.op === "'") {
      plan.set(k, `T*${shows ? ' ' + shows : ''}`)
    } else {
      const nums = op.args.filter((a): a is number => typeof a === 'number')
      const pre = nums.length >= 2 ? `${fmt(nums[0])} Tw ${fmt(nums[1])} Tc ` : ''
      plan.set(k, `${pre}T*${shows ? ' ' + shows : ''}`)
    }
  }

  // ---- paths
  const paint = (k: number, o: string) => {
    if (o === 's' || o === 'b' || o === 'b*') if (path.length) path.push({ op: 'h', pts: [] })
    const segs = path
    const clipOp = pendingClip ? pendingClip.op : -1
    const construct = pathOps
    if (pendingClip && segs.length) {
      const bounds = pathBounds(segs)
      g = { ...g, clip: intersectRect(g.clip, bounds ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) }
    }
    const evenOddClip = pendingClip?.evenOdd
    pendingClip = null
    path = []
    pathOps = []
    if (o === 'n' || !segs.length || !construct.length) return
    const strokes = o === 'S' || o === 's' || o === 'B' || o === 'B*' || o === 'b' || o === 'b*'
    const remove = () => {
      touch()
      if (clipOp >= 0) plan.set(k, 'n')
      else for (const i of [...construct, k]) plan.set(i, null)
    }
    if (hiddenDepth > 0) {
      remove()
      return
    }
    const tight = pathBounds(segs)
    if (!tight) return
    const grow = strokes ? (Math.max(g.lw, 0) / 2) * maxScale(g.ctm) + 0.01 : 0
    let bounds: Rect = { x0: tight.x0 - grow, y0: tight.y0 - grow, x1: tight.x1 + grow, y1: tight.y1 + grow }
    if (g.clip) {
      const c = intersectRect(bounds, g.clip)!
      if (!(c.x1 > c.x0 && c.y1 > c.y0)) return
      bounds = c
    }
    const hits = hitAreas(bounds)
    if (!hits.length) return
    if (hits.some((a) => contains(a, bounds))) {
      remove()
      return
    }
    const excl = exclusionClip(hits, bounds)
    if (!excl) return
    touch()
    plan.set(construct[0], `q\n${excl}\n${opText(construct[0])}`)
    if (clipOp >= 0) {
      // The path is also a clip: paint it inside q … Q, then establish the clip again.
      plan.set(clipOp, null)
      const again = construct.map(opText).join('\n')
      plan.set(k, `${o}\nQ\n${again}\n${evenOddClip ? 'W*' : 'W'} n`)
    } else {
      plan.set(k, `${opText(k)}\nQ`)
    }
  }

  // ---- XObjects and images
  const unitQuad = (m: Matrix): Point[] => [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)]

  /** Areas overlapping the image drawn with the current CTM, in unit image space; null = fully covered. */
  const imageHits = (): { polys: UnitPolygon[] } | null | undefined => {
    const quad = unitQuad(g.ctm)
    // Pixels under an area are redacted even where a clip hides them: the data would stay in the file.
    const hits = s.areas.filter((a) => quadOverlaps(quad, a))
    if (!hits.length) return undefined
    if (hits.some((a) => quad.every((p) => pointIn(a, p)))) return null
    const inv = invert(g.ctm)
    if (!inv) return null
    return { polys: hits.map((a) => corners(a).map((p) => apply(inv, p.x, p.y))) }
  }

  const replaceDo = (k: number, op: Op, name: string, ref: PDFRef, base: string) => {
    const fresh = t.res.freshName('XObject', base)
    t.res.set('XObject', fresh, ref)
    plan.set(k, writeOp('Do', [...op.args.slice(0, -1), new PdfName(fresh)]))
    replacedNames.add(name)
  }
  const removeDo = (k: number, name?: string) => {
    touch()
    plan.set(k, null)
    if (name) replacedNames.add(name)
  }

  const doImage = async (k: number, op: Op, name: string, xo: PDFStream) => {
    if (hiddenDepth > 0) return removeDo(k, name)
    const h = imageHits()
    if (h === undefined) {
      keptNames.add(name)
      return
    }
    if (h === null) return removeDo(k, name)
    touch()
    try {
      const ref = await redactImageXObject(ctx, xo, h.polys, s.fill, resources)
      replaceDo(k, op, name, ref, `${name}_r`)
    } catch (e) {
      if (!(e instanceof UnsupportedImageError)) throw e
      s.warn('image-removed', `An image under a redaction area was removed completely (${e.message}).`)
      removeDo(k, name)
    }
  }

  const doForm = async (k: number, op: Op, name: string, xo: PDFStream) => {
    if (hiddenDepth > 0) return removeDo(k, name)
    const dict = xo.dict
    const matrix = getMatrix(dict, 'Matrix') ?? IDENTITY
    const ctm = mul(matrix, g.ctm)
    const bboxArr = numberArray(ctx, get(dict, 'BBox') as PDFArray | undefined)
    let quad: Point[] | null = null
    if (bboxArr && bboxArr.length === 4) {
      const [a, b2, c, d] = bboxArr
      quad = [apply(ctm, a, b2), apply(ctm, c, b2), apply(ctm, c, d), apply(ctm, a, d)]
    }
    const hits = quad ? s.areas.filter((a) => quadOverlaps(quad!, a)) : s.areas
    if (quad && hits.some((a) => quad!.every((p) => pointIn(a, p)))) return removeDo(k, name)
    if (!hits.length && !s.hidden && !s.collect) {
      keptNames.add(name)
      return
    }
    if (!getDict(dict, 'Resources')) inheritingForm = true
    const cacheable = !hits.length && !s.collect
    if (cacheable && s.formCache.has(xo)) {
      const cached = s.formCache.get(xo)!
      if (cached) replaceDo(k, op, name, cached, `${name}_s`)
      else keptNames.add(name)
      return
    }
    if (t.depth >= MAX_FORM_DEPTH) {
      if (!hits.length) {
        keptNames.add(name)
        return
      }
      s.warn('form-removed', 'Content nested too deeply under a redaction area was removed completely.')
      return removeDo(k, name)
    }
    const copy = await redactForm(s, xo, { ...g, ctm }, resources, t.depth + 1)
    if (cacheable) s.formCache.set(xo, copy)
    if (copy) {
      touch()
      replaceDo(k, op, name, copy, `${name}_r`)
    } else {
      keptNames.add(name)
    }
  }

  const inlineImage = async (k: number, op: Op) => {
    if (hiddenDepth > 0) return removeDo(k)
    const h = imageHits()
    if (h === undefined) return
    if (h === null || !op.image) return removeDo(k)
    touch()
    try {
      const data = t.data.subarray(op.image.dataStart, op.image.dataEnd)
      const ref = await redactInlineImage(ctx, op.image.dict, data, h.polys, s.fill, resources)
      const fresh = t.res.freshName('XObject', 'OPEInline')
      t.res.set('XObject', fresh, ref)
      plan.set(k, writeOp('Do', [new PdfName(fresh)]))
    } catch (e) {
      if (!(e instanceof UnsupportedImageError)) throw e
      s.warn('image-removed', `An image under a redaction area was removed completely (${e.message}).`)
      removeDo(k)
    }
  }

  const shading = (k: number) => {
    if (hiddenDepth > 0) return removeDo(k)
    const region = intersectRect(g.clip, s.crop)!
    if (!(region.x1 > region.x0 && region.y1 > region.y0)) return
    const hits = hitAreas(region)
    if (!hits.length) return
    if (hits.some((a) => contains(a, region))) return removeDo(k)
    const excl = exclusionClip(hits, region)
    if (!excl) return
    touch()
    plan.set(k, `q\n${excl}\n${opText(k)}\nQ`)
  }

  // ---- marked content
  const markedProps = (op: Op): PDFDict | PdfDictOp | undefined => {
    const p = op.args[1]
    if (p instanceof PdfDictOp) return p
    if (p instanceof PdfName) return getDict(properties, p.name)
    return undefined
  }

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    switch (op.op) {
      case 'q':
        stack.push(g)
        break
      case 'Q':
        if (stack.length) g = stack.pop()!
        break
      case 'cm': {
        const m = numArgs(op, 6)
        if (m && isFiniteMatrix(m)) g = { ...g, ctm: mul(m as Matrix, g.ctm) }
        break
      }
      case 'w': {
        const v = numArgs(op, 1)
        if (v) g = { ...g, lw: v[0] }
        break
      }
      case 'gs': {
        const dict = getDict(extGStates, nameArg(op, op.args.length - 1) ?? '')
        if (!dict) break
        const lw = numberOf(get(dict, 'LW'))
        if (lw !== undefined) g = { ...g, lw }
        const font = get(dict, 'Font')
        if (font instanceof PDFArray && font.size() >= 2) {
          const items = arrayItems(ctx, font)
          setText({ font: loadFont(ctx, items[0]), size: numberOf(items[1]) ?? g.text.size })
        }
        break
      }
      case 'BT':
        tm = IDENTITY
        tlm = IDENTITY
        break
      case 'Tf': {
        const name = nameArg(op, op.args.length - 2) ?? nameArg(op, 0)
        const size = op.args[op.args.length - 1]
        if (name) setText({ font: fontByName(name), size: typeof size === 'number' ? size : g.text.size })
        break
      }
      case 'Tc':
      case 'Tw':
      case 'Tz':
      case 'TL':
      case 'Ts':
      case 'Tr': {
        const v = numArgs(op, 1)
        if (!v) break
        const key = TEXT_STATE_KEYS[op.op]
        setText({ [key]: op.op === 'Tz' ? v[0] / 100 : v[0] })
        break
      }
      case 'Td':
      case 'TD': {
        const v = numArgs(op, 2)
        if (!v) break
        if (op.op === 'TD') setText({ tl: -v[1] })
        tlm = mul(translate(v[0], v[1]), tlm)
        tm = tlm
        break
      }
      case 'Tm': {
        const m = numArgs(op, 6)
        if (m && isFiniteMatrix(m)) {
          tlm = m as Matrix
          tm = tlm
        }
        break
      }
      case 'T*':
        tlm = mul(translate(0, -g.text.tl), tlm)
        tm = tlm
        break
      case "'":
      case '"':
        if (op.op === '"') {
          const v = op.args.filter((a): a is number => typeof a === 'number')
          if (v.length >= 2) setText({ tw: v[0], tc: v[1] })
        }
        tlm = mul(translate(0, -g.text.tl), tlm)
        tm = tlm
        show(k, op)
        break
      case 'Tj':
      case 'TJ':
        show(k, op)
        break

      case 'm': {
        const v = numArgs(op, 2)
        if (!v) break
        cur = apply(g.ctm, v[0], v[1])
        subStart = cur
        path.push({ op: 'm', pts: [cur.x, cur.y] })
        pathOps.push(k)
        break
      }
      case 'l': {
        const v = numArgs(op, 2)
        if (!v) break
        cur = apply(g.ctm, v[0], v[1])
        path.push({ op: path.length ? 'l' : 'm', pts: [cur.x, cur.y] })
        pathOps.push(k)
        break
      }
      case 'c':
      case 'v':
      case 'y': {
        const v = numArgs(op, op.op === 'c' ? 6 : 4)
        if (!v) break
        let p1: Point, p2: Point, p3: Point
        if (op.op === 'c') {
          p1 = apply(g.ctm, v[0], v[1])
          p2 = apply(g.ctm, v[2], v[3])
          p3 = apply(g.ctm, v[4], v[5])
        } else if (op.op === 'v') {
          p1 = cur
          p2 = apply(g.ctm, v[0], v[1])
          p3 = apply(g.ctm, v[2], v[3])
        } else {
          p1 = apply(g.ctm, v[0], v[1])
          p3 = apply(g.ctm, v[2], v[3])
          p2 = p3
        }
        if (!path.length) path.push({ op: 'm', pts: [cur.x, cur.y] })
        path.push({ op: 'c', pts: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y] })
        cur = p3
        pathOps.push(k)
        break
      }
      case 'h':
        if (path.length) {
          path.push({ op: 'h', pts: [] })
          cur = subStart
        }
        pathOps.push(k)
        break
      case 're': {
        const v = numArgs(op, 4)
        if (!v) break
        const [x, y, w, h] = v
        const p0 = apply(g.ctm, x, y)
        const p1 = apply(g.ctm, x + w, y)
        const p2 = apply(g.ctm, x + w, y + h)
        const p3 = apply(g.ctm, x, y + h)
        path.push({ op: 'm', pts: [p0.x, p0.y] }, { op: 'l', pts: [p1.x, p1.y] }, { op: 'l', pts: [p2.x, p2.y] }, { op: 'l', pts: [p3.x, p3.y] }, { op: 'h', pts: [] })
        cur = p0
        subStart = p0
        pathOps.push(k)
        break
      }
      case 'W':
      case 'W*':
        pendingClip = { evenOdd: op.op === 'W*', op: k }
        break
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
      case 'n':
        paint(k, op.op)
        break

      case 'Do': {
        const name = nameArg(op, op.args.length - 1)
        if (!name) break
        const xo = xobjects ? get(xobjects, name) : undefined
        if (!(xo instanceof PDFStream)) break
        if (s.hidden && s.oc.ocHidden(xo.dict.get(N('OC')))) {
          removeDo(k, name)
          break
        }
        const subtype = getName(xo.dict, 'Subtype')
        if (subtype === 'Image') await doImage(k, op, name, xo)
        else if (subtype === 'Form') await doForm(k, op, name, xo)
        else keptNames.add(name)
        break
      }
      case 'BI':
        await inlineImage(k, op)
        break
      case 'sh':
        shading(k)
        break

      case 'BMC':
        marked.push({ op: k, hidden: false, replacementText: false, touched: false })
        break
      case 'BDC': {
        const props = markedProps(op)
        const hidden = s.hidden && nameArg(op, 0) === 'OC' && s.oc.ocHidden(op.args[1] instanceof PdfName ? properties?.get(N(op.args[1].name)) : undefined)
        if (hidden) hiddenDepth++
        let mcid: number | undefined
        let replacementText = false
        if (props instanceof PdfDictOp) {
          const v = props.get('MCID')
          if (typeof v === 'number') mcid = v
          replacementText = REPLACEMENT_TEXT_KEYS.some((key) => props.map.has(key))
        } else if (props) {
          mcid = numberOf(get(props, 'MCID'))
          replacementText = REPLACEMENT_TEXT_KEYS.some((key) => props.get(N(key)) !== undefined)
        }
        marked.push({ op: k, hidden, mcid, replacementText, touched: false })
        break
      }
      case 'EMC': {
        const m = marked.pop()
        if (m) closeMarked(m)
        break
      }
      default:
        break
    }
  }
  for (const m of marked.splice(0)) closeMarked(m)

  function closeMarked(m: MarkedEntry): void {
    if (m.hidden) hiddenDepth--
    if (!m.touched) return
    // The enclosing sections lost content too.
    for (const outer of marked) outer.touched = true
    if (m.mcid !== undefined && t.pageLevel) s.touchedMcids.add(m.mcid)
    if (!m.replacementText) return
    const op = ops[m.op]
    const tag = op.args[0] instanceof PdfName ? op.args[0] : new PdfName('Span')
    const props = op.args[1]
    if (props instanceof PdfDictOp) {
      const map = new Map([...props.map].filter(([key]) => !REPLACEMENT_TEXT_KEYS.includes(key)))
      plan.set(m.op, `${writeOperand(tag)} ${writeOperand(new PdfDictOp(map))} BDC`)
    } else if (props instanceof PdfName) {
      const dict = getDict(properties, props.name)
      if (!dict) return
      const copy = dict.clone(ctx)
      for (const key of REPLACEMENT_TEXT_KEYS) copy.delete(N(key))
      const fresh = t.res.freshName('Properties', `${props.name}_r`)
      t.res.set('Properties', fresh, ctx.register(copy))
      plan.set(m.op, `${writeOperand(tag)} ${writeName(fresh)} BDC`)
    }
  }

  if (!plan.size) return null
  // Originals of redacted images / forms are not kept in the resources when nothing else here draws them.
  if (!inheritingForm) {
    for (const name of replacedNames) {
      if (keptNames.has(name)) continue
      t.res.category('XObject').delete(N(name))
    }
  }
  return emit(ops, t.data, plan)
}

/** A private copy of form XObject `xo` (drawn with state `gs`) with its content redacted; null if unchanged. */
async function redactForm(s: Session, xo: PDFStream, gs: GState, parentRes: PDFDict | undefined, depth: number): Promise<PDFRef | null> {
  const data = streamData(xo)
  if (!data) return null
  const own = getDict(xo.dict, 'Resources')
  let installed: PDFDict | undefined
  const res = new ResourceEditor(
    s.ctx,
    () => own ?? parentRes,
    (d) => (installed = d)
  )
  let clip = gs.clip
  const bbox = numberArray(s.ctx, get(xo.dict, 'BBox') as PDFArray | undefined)
  if (bbox && bbox.length === 4) {
    const r = rectOfPoints([apply(gs.ctm, bbox[0], bbox[1]), apply(gs.ctm, bbox[2], bbox[1]), apply(gs.ctm, bbox[2], bbox[3]), apply(gs.ctm, bbox[0], bbox[3])])
    clip = intersectRect(clip, r)
  }
  const start: GState = { ...gs, clip }
  const result = await redactStream(s, { data, res, start, depth, pageLevel: false })
  if (!result) return null
  const stream = s.ctx.flateStream(result)
  for (const [key, value] of xo.dict.entries()) {
    if (!STREAM_KEYS.has(key.decodeText())) stream.dict.set(key, value)
  }
  // Private application data and XMP of the form may describe the removed content.
  stream.dict.delete(PDFName.of('PieceInfo'))
  stream.dict.delete(PDFName.of('Metadata'))
  if (installed) stream.dict.set(PDFName.of('Resources'), installed)
  return s.ctx.register(stream)
}
