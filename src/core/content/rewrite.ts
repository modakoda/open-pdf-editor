/**
 * Rewriting page content: applying ContentEdits, stripping OPEObject sections. Untouched
 * operations are copied byte-for-byte.
 *
 * Moved / re-typed / re-sized / re-colored items are removed from their place and redrawn at
 * the end of their content in a self-contained block (`q` + the graphics state they need + the
 * original operators + `Q`); the original content is wrapped in `q … Q` (with missing `Q`/`ET`
 * added and stray `Q` removed) so the blocks start from the initial graphics state. In a block:
 * - the clipping paths in effect for the item are redrawn transformed together with the item;
 * - ExtGStates are applied in the coordinate system they were originally applied in (moved
 *   with the item), so soft masks keep their place relative to the item;
 * - pattern colors are re-anchored (a copy of the pattern with /Matrix × the move), so the
 *   pattern moves with the item;
 * - enclosing optional-content sections (`/OC /name BDC`) are re-applied.
 * Paths whose only change is the color are re-colored in place (keeps their stacking order).
 *
 * Items inside a form XObject are edited in a private copy of the form (its /Group, /Matrix,
 * /BBox, resources, pattern space and structure are kept), registered under a fresh name, and
 * the one `Do` that drew the item is pointed at the copy (recursively for nested forms). Other
 * uses of the form are untouched. Blocks of a copy are drawn inside the form, so transforms of
 * inner items compose with an edit of the form item itself.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFFont,
  type PDFPage
} from '@cantoo/pdf-lib'
import type { PdfBox } from '../geometry'
import type { ContentEdit, Matrix } from '../model'
import { fontMetrics, prepareText, type ResolvedTextFont } from '../text'
import { parseHex, type ColorState } from './colors'
import {
  formStartState,
  interpret,
  opeObjectId,
  type GState,
  type Interpretation,
  type ItemRecord,
  type TextState
} from './interpreter'
import { PdfName, PdfStr, isWhite, parseContent, type Op, type Operand } from './lexer'
import { IDENTITY, apply, invert, mul, pageTransformToUser, rectOfPoints, transformRect, translate, type Rect } from './matrix'
import { ResourceEditor, pageResources, readPageContent, writePageContent } from './page'
import { writePath } from './paths'
import { get, getDict, getMatrix, numberArray, resolve, streamData } from './pdfobj'
import { ByteWriter, fmt, writeHexBytes, writeMatrix, writeName, writeOp, writeOperand } from './serialize'

export interface EditHelpers {
  embedFont(font: ResolvedTextFont): Promise<PDFFont>
}

type Replacement = string | Uint8Array | null

const RESET_OPS = new Set(['Td', 'TD', 'Tm', 'T*', "'", '"', 'BT', 'ET'])
/** Nesting levels of form XObject copies. */
const MAX_FORM_DEPTH = 8

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function isIdentity(m: Matrix | undefined): boolean {
  if (!m) return true
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
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

/**
 * Write ops [from, to] with replacements. `skip` ops are left out. Bytes between operations
 * (whitespace, comments) are kept.
 */
function emitOps(
  w: ByteWriter,
  interp: Interpretation,
  from: number,
  to: number,
  plan: Map<number, Replacement>,
  skip?: Set<number>
): void {
  const { ops, data } = interp
  let prev = from > 0 ? ops[from - 1].end : 0
  const removed = (k: number) => !!skip?.has(k) || (plan.has(k) && plan.get(k) == null)
  for (let k = from; k <= to && k < ops.length; k++) {
    const op = ops[k]
    // Whitespace between two removed operators is dropped with them.
    if (op.start > prev && !(k > from && removed(k) && removed(k - 1))) w.bytes(data.subarray(prev, op.start))
    prev = op.end
    if (skip?.has(k)) continue
    if (plan.has(k)) {
      const r = plan.get(k)
      if (r === null || r === undefined) continue
      w.text('\n')
      if (typeof r === 'string') w.text(r)
      else w.bytes(r)
      w.text('\n')
    } else {
      w.bytes(data.subarray(op.start, op.end))
    }
  }
}

function emitAll(interp: Interpretation, plan: Map<number, Replacement>, skip?: Set<number>): ByteWriter {
  const w = new ByteWriter()
  emitOps(w, interp, 0, interp.ops.length - 1, plan, skip)
  const lastEnd = interp.ops.length ? interp.ops[interp.ops.length - 1].end : 0
  const tail = interp.data.subarray(lastEnd)
  if (onlyWhitespaceOrComments(tail)) w.bytes(tail)
  return w
}

// ---------------------------------------------------------------------------------------
// Context of one content stream being edited (the page, or a form XObject copy)

interface Session {
  ctx: PDFContext
  cropBox: PdfBox
  skipMarked?: Set<string>
  helpers: EditHelpers
}

interface Target {
  data: Uint8Array
  res: ResourceEditor
  /** Graphics state at the start of the content (forms: inherited from the Do). */
  startGs?: GState
  /** Content space → page user space (identity for the page) and its inverse. */
  base: Matrix
  baseInv: Matrix
  /** Form copies: the original /BBox (in form space). */
  bbox?: number[]
  depth: number
}

class Emitter {
  /** Do operations re-pointed at private form copies. */
  readonly overrides = new Map<number, string>()
  private patterns = new Map<string, string>()
  private fontNames = new Map<PDFRef, string>()

  constructor(
    readonly s: Session,
    readonly t: Target,
    readonly interp: Interpretation
  ) {}

  opText(k: number): string {
    const o = this.overrides.get(k)
    if (o !== undefined) return o
    const op = this.interp.ops[k]
    return latin1(this.interp.data.subarray(op.start, op.end))
  }

  opBytes(k: number): Uint8Array {
    const o = this.overrides.get(k)
    if (o !== undefined) {
      const w = new ByteWriter()
      w.text(o)
      return w.toBytes()
    }
    const op = this.interp.ops[k]
    return this.interp.data.subarray(op.start, op.end)
  }

  /** A page-space edit transform expressed in this content's space (for pattern matrices). */
  contentTransform(U: Matrix): Matrix {
    return mul(mul(this.t.base, U), this.t.baseInv)
  }

  /** A copy of pattern `name` re-anchored by `M` (pattern space → content space), cached. */
  private movedPattern(name: string, M: Matrix): string {
    if (isIdentity(M)) return name
    const key = `${name}|${M.join(',')}`
    const cached = this.patterns.get(key)
    if (cached) return cached
    const ctx = this.s.ctx
    const obj = resolve(ctx, this.t.res.get('Pattern', name))
    let clone: PDFDict | PDFRawStream | undefined
    if (obj instanceof PDFRawStream) {
      clone = PDFRawStream.of(obj.dict.clone(ctx), obj.contents, obj.transform)
    } else if (obj instanceof PDFDict) {
      clone = obj.clone(ctx)
    }
    if (!clone) return name
    const dict = clone instanceof PDFRawStream ? clone.dict : clone
    const P = getMatrix(dict, 'Matrix') ?? IDENTITY
    dict.set(PDFName.of('Matrix'), ctx.obj(mul(P, M)))
    const fresh = this.t.res.freshName('Pattern', `${name}_m`)
    this.t.res.set('Pattern', fresh, ctx.register(clone))
    this.patterns.set(key, fresh)
    return fresh
  }

  private colorOps(c: ColorState, stroke: boolean, M: Matrix): string {
    if (c.inherited === 'all') return ''
    const comps = c.comps.map((v) => fmt(v)).join(' ')
    if (c.device) {
      const op = c.space === 'DeviceGray' ? 'g' : c.space === 'DeviceRGB' ? 'rg' : 'k'
      return `${comps} ${stroke ? op.toUpperCase() : op}\n`
    }
    const pattern = c.pattern ? this.movedPattern(c.pattern, M) : undefined
    let s = c.inherited === 'space' ? '' : `${writeName(c.space)} ${stroke ? 'CS' : 'cs'}\n`
    if (comps || pattern) s += `${comps}${pattern ? (comps ? ' ' : '') + writeName(pattern) : ''} ${stroke ? 'SCN' : 'scn'}\n`
    return s
  }

  /**
   * `q`, clipping paths (moved by U), ExtGStates (each in its own coordinate system, moved by
   * U), CTM × U, line state, colors. U is in page user space.
   */
  head(gs: GState, U: Matrix): string {
    const toContent = mul(U, this.t.baseInv)
    let s = 'q\n'
    for (const c of gs.clips) s += writePath(c.segs, toContent) + (c.evenOdd ? '\nW* n\n' : '\nW n\n')
    // `cur` stays invertible: singular intermediate targets are skipped.
    let cur: Matrix = IDENTITY
    const moveTo = (target: Matrix, required: boolean) => {
      if (!required && !invert(target)) return
      const delta = mul(target, invert(cur)!)
      if (!isIdentity(delta)) s += `${writeMatrix(delta)} cm\n`
      cur = target
    }
    for (const g of gs.gsNames) {
      moveTo(mul(g.ctm, toContent), false)
      s += `${writeName(g.name)} gs\n`
    }
    moveTo(mul(gs.ctm, toContent), true)
    const dash = gs.dash ? `${writeOperand(gs.dash[0])} ${writeOperand(gs.dash[1])}` : '[] 0'
    s += `${fmt(gs.lw)} w ${fmt(gs.lc)} J ${fmt(gs.lj)} j ${fmt(gs.ml)} M ${dash} d\n`
    if (gs.ri) s += `${writeName(gs.ri)} ri\n`
    if (gs.flat !== null) s += `${fmt(gs.flat)} i\n`
    const M = this.contentTransform(U)
    s += this.colorOps(gs.fill, false, M) + this.colorOps(gs.stroke, true, M)
    return s
  }

  /** Wrap a block in the item's optional-content sections. */
  wrapOc(rec: ItemRecord, block: string | Uint8Array): Uint8Array {
    const w = new ByteWriter()
    for (const name of rec.oc) w.text(`/OC ${writeName(name)} BDC\n`)
    if (typeof block === 'string') w.text(block)
    else w.bytes(block)
    for (let i = 0; i < rec.oc.length; i++) w.text('EMC\n')
    return w.toBytes()
  }

  fontResource(font: PDFFont): string {
    const known = this.fontNames.get(font.ref)
    if (known) return known
    const fonts = getDict(this.t.res.resources(), 'Font')
    if (fonts) {
      for (const [key, val] of fonts.entries()) {
        if (val === font.ref) {
          this.fontNames.set(font.ref, key.decodeText())
          return key.decodeText()
        }
      }
    }
    const name = this.t.res.freshName('Font', 'OPEF1')
    this.t.res.set('Font', name, font.ref)
    this.fontNames.set(font.ref, name)
    return name
  }
}

function textStateOps(ts: TextState, prev: TextState | null): string {
  let s = ''
  if (!prev || prev.fontName !== ts.fontName || prev.size !== ts.size || prev.font !== ts.font) {
    if (ts.fontName && !ts.fontFromGs) s += `${writeName(ts.fontName)} ${fmt(ts.size)} Tf\n`
  }
  if (!prev || prev.tc !== ts.tc) s += `${fmt(ts.tc)} Tc\n`
  if (!prev || prev.tw !== ts.tw) s += `${fmt(ts.tw)} Tw\n`
  if (!prev || prev.th !== ts.th) s += `${fmt(ts.th * 100)} Tz\n`
  if (!prev || prev.tl !== ts.tl) s += `${fmt(ts.tl)} TL\n`
  if (!prev || prev.ts !== ts.ts) s += `${fmt(ts.ts)} Ts\n`
  if (!prev || prev.tr !== ts.tr) s += `${fmt(ts.tr)} Tr\n`
  return s
}

function rgbOp(color: string, stroke: boolean): string {
  const [r, g, b] = parseHex(color)
  return `${fmt(r, 4)} ${fmt(g, 4)} ${fmt(b, 4)} ${stroke ? 'RG' : 'rg'}\n`
}

// ---------------------------------------------------------------------------------------
// Text removal

/** For each show op: does a later show op in the same text object depend on its advance? */
function advanceNeeded(interp: Interpretation): (k: number) => boolean {
  let cache: Uint8Array | null = null
  return (k: number) => {
    if (!cache) {
      const ops = interp.ops
      cache = new Uint8Array(ops.length)
      let next = 0 // 1 = next relevant op is a show without repositioning
      for (let i = ops.length - 1; i >= 0; i--) {
        cache[i] = next
        const o = ops[i].op
        if (o === 'Tj' || o === 'TJ') next = 1
        else if (RESET_OPS.has(o)) next = 0
      }
    }
    return cache[k] === 1
  }
}

function rewriteShow(
  op: Op,
  show: { elements: Operand[]; elAdv: number[]; size: number; th: number; vertical: boolean },
  ranges: [number, number][],
  needAdv: boolean
): string | null {
  const along = show.vertical ? show.size : show.size * show.th
  const toNum = (adv: number) => (along ? (-adv * 1000) / along : 0)
  const inRange = (k: number) => ranges.some(([s, e]) => k >= s && k < e)
  const adjust = (adv: number) => (Math.abs(adv) > 1e-9 && along ? `[${fmt(toNum(adv), 4)}] TJ` : '')
  if (op.op === 'TJ') {
    const out: Operand[] = []
    let pending = 0
    let hasString = false
    show.elements.forEach((el, k) => {
      if (inRange(k) || typeof el === 'number' || !(el instanceof PdfStr)) {
        pending += show.elAdv[k] ?? 0
        return
      }
      if (Math.abs(pending) > 1e-9 && along) out.push(Number(fmt(toNum(pending), 4)))
      pending = 0
      out.push(el)
      hasString = true
    })
    if (!hasString) return needAdv ? adjust(pending) || null : null
    if (needAdv && Math.abs(pending) > 1e-9 && along) out.push(Number(fmt(toNum(pending), 4)))
    return `${writeOperand(out)} TJ`
  }
  const total = show.elAdv.reduce((a, b) => a + b, 0)
  const adj = needAdv ? adjust(total) : ''
  if (op.op === 'Tj') return adj || null
  if (op.op === "'") return 'T*' + (adj ? ' ' + adj : '')
  // ": aw ac string "
  const nums = op.args.filter((a): a is number => typeof a === 'number')
  const pre = nums.length >= 2 ? `${fmt(nums[0])} Tw ${fmt(nums[1])} Tc ` : ''
  return `${pre}T*${adj ? ' ' + adj : ''}`
}

// ---------------------------------------------------------------------------------------
// Applying edits

interface Action {
  rec: ItemRecord
  edit: ContentEdit
  U: Matrix
  mode: 'delete' | 'redraw' | 'color'
}

function hasEffect(e: ContentEdit): boolean {
  return !!(e.deleted || !isIdentity(e.transform) || e.text !== undefined || e.color || e.fontSize)
}

export async function applyEdits(
  doc: PDFDocument,
  page: PDFPage,
  cropBox: PdfBox,
  edits: ContentEdit[],
  helpers: EditHelpers,
  skipMarked?: Set<string>
): Promise<void> {
  const map = new Map<string, ContentEdit>()
  for (const e of edits) if (hasEffect(e) && !map.has(e.itemId)) map.set(e.itemId, e)
  if (!map.size) return
  const data = readPageContent(page)
  if (!data.length) return
  const session: Session = { ctx: doc.context, cropBox, skipMarked, helpers }
  const res = ResourceEditor.forPage(doc, page)
  const result = await editContent(session, { data, res, base: IDENTITY, baseInv: IDENTITY, depth: 0 }, map)
  if (result) writePageContent(doc, page, result.data)
}

/** Apply edits (ids local to this content) to one content stream; null if nothing changed. */
async function editContent(
  s: Session,
  t: Target,
  edits: Map<string, ContentEdit>
): Promise<{ data: Uint8Array; blocks: boolean } | null> {
  const interp = interpret(s.ctx, t.data, parseContent(t.data), t.res.resources(), {
    cropBox: s.cropBox,
    skipMarked: s.skipMarked,
    startGs: t.startGs
  })
  const em = new Emitter(s, t, interp)

  // Edits of items inside form XObjects drawn by this content → private copies.
  const nested = new Map<string, Map<string, ContentEdit>>()
  const direct: [ItemRecord, ContentEdit][] = []
  for (const [id, e] of edits) {
    const rec = interp.byId.get(id)
    if (rec?.pageLevel) {
      direct.push([rec, e])
      continue
    }
    const parts = id.split('/')
    for (let k = parts.length - 1; k >= 1; k--) {
      const prefix = parts.slice(0, k).join('/')
      const r = interp.byId.get(prefix)
      if (r && r.pageLevel && r.kind === 'xobject') {
        let m = nested.get(prefix)
        if (!m) nested.set(prefix, (m = new Map()))
        m.set(id.slice(prefix.length + 1), e)
        break
      }
    }
  }
  if (t.depth < MAX_FORM_DEPTH) {
    const xobjects = getDict(t.res.resources(), 'XObject')
    for (const [xid, inner] of nested) {
      const rec = interp.byId.get(xid)!
      const k = rec.ops[0]
      const op = interp.ops[k]
      const nameOp = op.args[op.args.length - 1]
      if (!(nameOp instanceof PdfName)) continue
      const xo = get(xobjects, nameOp.name)
      if (!(xo instanceof PDFStream)) continue
      const copy = await editFormCopy(s, xo, rec.gs, inner, t.res.resources(), t.depth + 1)
      if (!copy) continue
      const fresh = t.res.freshName('XObject', `${nameOp.name}_e`)
      t.res.set('XObject', fresh, copy)
      em.overrides.set(k, writeOp('Do', [...op.args.slice(0, -1), new PdfName(fresh)]))
    }
  }

  // Classify direct edits.
  const actions: Action[] = []
  for (const [rec, edit] of direct) {
    if (rec.item.readOnly) continue
    const U = isIdentity(edit.transform) ? IDENTITY : pageTransformToUser(edit.transform!, s.cropBox)
    const moved = !isIdentity(edit.transform)
    if (edit.deleted || (rec.kind === 'text' && edit.text !== undefined && !edit.text.replace(/\s+/g, ''))) {
      actions.push({ rec, edit, U, mode: 'delete' })
    } else if (rec.kind === 'text') {
      actions.push({ rec, edit, U, mode: 'redraw' })
    } else if (rec.kind === 'path') {
      if (moved) actions.push({ rec, edit, U, mode: 'redraw' })
      else if (edit.color) actions.push({ rec, edit, U, mode: 'color' })
    } else if (moved) {
      actions.push({ rec, edit, U, mode: 'redraw' })
    }
  }
  if (!actions.length && !em.overrides.size) return null

  // Removal plan.
  const plan = new Map<number, Replacement>()
  for (const [k, text] of em.overrides) plan.set(k, text)
  const textRemovals = new Map<number, [number, number][]>()
  for (const a of actions) {
    if (a.mode === 'color') continue
    const rec = a.rec
    if (rec.kind === 'text') {
      for (const p of rec.pieces ?? []) {
        let list = textRemovals.get(p.op)
        if (!list) textRemovals.set(p.op, (list = []))
        list.push([p.elStart, p.elEnd])
      }
    } else if (rec.kind === 'path' && rec.path) {
      if (rec.path.clipOp >= 0) plan.set(rec.path.paintOp, 'n')
      else for (const k of rec.ops) plan.set(k, null)
    } else {
      for (const k of rec.ops) plan.set(k, null)
    }
  }
  const needAdv = advanceNeeded(interp)
  for (const [k, ranges] of textRemovals) {
    const show = interp.shows.get(k)
    if (!show) continue
    plan.set(k, rewriteShow(interp.ops[k], show, ranges, needAdv(k)))
  }

  // In-place color changes of paths.
  for (const a of actions) {
    if (a.mode !== 'color' || !a.rec.path || !a.edit.color) continue
    const { paintOp, clipOp, fills } = a.rec.path
    const constr = a.rec.ops.filter((k) => k !== paintOp && k !== clipOp)
    if (!constr.length) continue
    const override = rgbOp(a.edit.color, !fills)
    plan.set(constr[0], `q\n${override}${em.opText(constr[0])}`)
    if (clipOp >= 0) plan.set(clipOp, null)
    let tail = `${em.opText(paintOp)}\nQ`
    if (clipOp >= 0) tail += '\n' + constr.map((k) => em.opText(k)).join('\n') + `\n${interp.ops[clipOp].op} n`
    plan.set(paintOp, tail)
  }

  // Redrawn blocks.
  const blocks: Uint8Array[] = []
  for (const a of actions) {
    if (a.mode !== 'redraw') continue
    const rec = a.rec
    if (rec.kind === 'text') {
      blocks.push(em.wrapOc(rec, await textBlock(em, rec, a.edit, a.U)))
    } else if (rec.kind === 'path' && rec.path) {
      const { paintOp, clipOp, fills } = rec.path
      let b = em.head(rec.gs, a.U)
      if (a.edit.color) b += rgbOp(a.edit.color, !fills)
      for (const k of rec.ops) if (k !== paintOp && k !== clipOp) b += em.opText(k) + '\n'
      b += `${interp.ops[paintOp].op}\nQ\n`
      blocks.push(em.wrapOc(rec, b))
    } else {
      const w = new ByteWriter()
      w.text(em.head(rec.gs, a.U))
      if (rec.kind === 'xobject') w.text(textStateOps(rec.gs.text, null))
      for (const k of rec.ops) w.bytes(em.opBytes(k))
      w.text('\nQ\n')
      blocks.push(em.wrapOc(rec, w.toBytes()))
    }
  }

  // Assemble.
  const out = new ByteWriter()
  if (blocks.length) {
    for (const k of interp.unmatchedQ) if (!plan.has(k)) plan.set(k, null)
    out.text('q\n')
    if (t.bbox && t.bbox.length === 4) {
      // The copy's /BBox is enlarged for the blocks; the original content keeps its clip.
      const [a, b, c, d] = t.bbox
      out.text(`${fmt(Math.min(a, c))} ${fmt(Math.min(b, d))} ${fmt(Math.abs(c - a))} ${fmt(Math.abs(d - b))} re W n\n`)
    }
    out.bytes(emitAll(interp, plan).toBytes())
    const f = interp.final
    let closers = '\n'
    if (f.pathOpen) closers += 'n\n'
    if (f.inText) closers += 'ET\n'
    for (let i = 0; i < f.marked; i++) closers += 'EMC\n'
    for (let i = 0; i < f.qDepth; i++) closers += 'Q\n'
    out.text(closers + 'Q\n')
    for (const b of blocks) out.bytes(b)
  } else {
    out.bytes(emitAll(interp, plan).toBytes())
  }
  return { data: out.toBytes(), blocks: blocks.length > 0 }
}

const STREAM_KEYS = new Set(['Filter', 'DecodeParms', 'Length', 'DL', 'F', 'FFilter', 'FDecodeParms'])

/**
 * A private copy of form XObject `xo` (drawn with state `gsAtDo`) with `edits` applied to its
 * content; null if nothing changed.
 */
async function editFormCopy(
  s: Session,
  xo: PDFStream,
  gsAtDo: GState,
  edits: Map<string, ContentEdit>,
  parentRes: PDFDict | undefined,
  depth: number
): Promise<PDFRef | null> {
  const data = streamData(xo)
  if (!data) return null
  const own = getDict(xo.dict, 'Resources')
  let installed: PDFDict | undefined
  const res = new ResourceEditor(
    s.ctx,
    () => own ?? parentRes,
    (d) => (installed = d)
  )
  const start = formStartState(gsAtDo, xo)
  const base = start.ctm
  const baseInv = invert(base)
  if (!baseInv) return null
  const bbox = numberArray(s.ctx, get(xo.dict, 'BBox') as PDFArray | undefined)
  const result = await editContent(s, { data, res, startGs: start, base, baseInv, bbox, depth }, edits)
  if (!result) return null
  const stream = s.ctx.flateStream(result.data)
  for (const [key, value] of xo.dict.entries()) {
    if (!STREAM_KEYS.has(key.decodeText())) stream.dict.set(key, value)
  }
  if (installed) stream.dict.set(PDFName.of('Resources'), installed)
  if (result.blocks && bbox && bbox.length === 4) {
    // Room for redrawn items anywhere on the page (the original content is clipped to the
    // original box by editContent).
    const c = s.cropBox
    const pageInForm = transformRect(baseInv, { x0: c.x, y0: c.y, x1: c.x + c.width, y1: c.y + c.height })
    const orig: Rect = rectOfPoints([
      { x: bbox[0], y: bbox[1] },
      { x: bbox[2], y: bbox[3] }
    ])!
    const u = {
      x0: Math.min(orig.x0, pageInForm.x0),
      y0: Math.min(orig.y0, pageInForm.y0),
      x1: Math.max(orig.x1, pageInForm.x1),
      y1: Math.max(orig.y1, pageInForm.y1)
    }
    stream.dict.set(PDFName.of('BBox'), s.ctx.obj([u.x0, u.y0, u.x1, u.y1]))
  }
  return s.ctx.register(stream)
}

async function textBlock(em: Emitter, rec: ItemRecord, edit: ContentEdit, U0: Matrix): Promise<string> {
  const interp = em.interp
  const pieces = rec.pieces ?? []
  const t = rec.text!
  const first = pieces[0]
  const ts0 = first.gs.text
  let U = U0
  const oldSize = rec.item.fontSize ?? 0
  const k = edit.fontSize && oldSize > 0 ? edit.fontSize / oldSize : 1
  if (k !== 1 && Number.isFinite(k) && k > 0) {
    const o = t.vertical ? apply(t.M, 0, t.lead) : apply(t.M, t.lead, t.rise)
    const S = mul(mul(translate(-o.x, -o.y), [k, 0, 0, k, 0, 0]), translate(o.x, o.y))
    U = mul(S, U)
  }
  let s = em.head(first.gs, U)
  const tr = ts0.tr
  const fillMode = tr === 0 || tr === 2 || tr === 4 || tr === 6
  const strokeMode = tr === 1 || tr === 2 || tr === 5 || tr === 6
  if (edit.color) {
    if (fillMode) s += rgbOp(edit.color, false)
    if (strokeMode) s += rgbOp(edit.color, true)
  }
  s += 'BT\n'
  if (edit.text === undefined) {
    let prev: TextState | null = null
    for (const p of pieces) {
      s += textStateOps(p.gs.text, prev)
      prev = p.gs.text
      const show = interp.shows.get(p.op)
      if (!show) continue
      s += `${writeMatrix(p.tm)} Tm\n`
      const els = show.elements.slice(p.elStart, p.elEnd)
      if (interp.ops[p.op].op === 'TJ') s += `${writeOperand(els)} TJ\n`
      else if (els[0] !== undefined) s += `${writeOperand(els[0])} Tj\n`
    }
  } else {
    const text = edit.text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
    const lines = text.split('\n')
    let fontName: string | null = null
    let encoded: string[] | null = null
    let lineFactor = 1.2
    let tw = ts0.tw
    if (rec.item.editableInPlace && ts0.fontName && !ts0.fontFromGs) {
      const enc = lines.map((l) => t.font.encode(l))
      if (enc.every((e) => e !== null)) {
        fontName = ts0.fontName
        encoded = enc.map((e) => writeHexBytes(e!))
        lineFactor = Math.max(1.15, t.font.ascent - t.font.descent)
      }
    }
    if (!encoded) {
      const prepared = prepareText(text, {
        font: rec.item.fontFamily ?? 'sans',
        bold: !!rec.item.bold,
        italic: !!rec.item.italic
      })
      const pdfFont = await em.s.helpers.embedFont(prepared.font)
      fontName = em.fontResource(pdfFont)
      encoded = prepared.text.split('\n').map((l) => pdfFont.encodeText(l).toString())
      const m = fontMetrics(prepared.font)
      lineFactor = Math.max(1.15, m.ascent + m.descent)
      tw = 0
    }
    s += `${writeName(fontName!)} ${fmt(ts0.size)} Tf\n`
    s += `${fmt(ts0.tc)} Tc\n${fmt(tw)} Tw\n${fmt(ts0.th * 100)} Tz\n${fmt(ts0.ts)} Ts\n${fmt(ts0.tr)} Tr\n`
    // The replacement starts at the item's origin (first visible glyph).
    const startTm = t.lead && Number.isFinite(t.lead) && !t.vertical ? mul(translate(t.lead, 0), first.tm) : first.tm
    encoded.forEach((e, j) => {
      const m = j ? mul(translate(0, -j * lineFactor * ts0.size), startTm) : startTm
      s += `${writeMatrix(m)} Tm\n${e} Tj\n`
    })
  }
  s += 'ET\nQ\n'
  return s
}

// ---------------------------------------------------------------------------------------
// Stripping OPEObject sections

export function stripMarked(doc: PDFDocument, page: PDFPage, ids?: Set<string>): void {
  const data = readPageContent(page)
  if (!data.length) return
  const ops = parseContent(data)
  const resources = pageResources(page)
  const skip = new Set<number>()
  let depth = 0
  let active: { start: number; depth: number } | null = null
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op.op === 'BDC' || op.op === 'BMC') {
      if (!active && op.op === 'BDC') {
        const id = opeObjectId(op, resources)
        if (id !== undefined && (!ids || ids.has(id))) active = { start: k, depth }
      }
      depth++
    } else if (op.op === 'EMC') {
      if (depth > 0) depth--
      if (active && depth === active.depth) {
        for (let i = active.start; i <= k; i++) skip.add(i)
        active = null
      }
    }
  }
  if (active) for (let i = active.start; i < ops.length; i++) skip.add(i)
  if (!skip.size) return
  const interp = { ops, data } as Interpretation
  writePageContent(doc, page, emitAll(interp, new Map(), skip).toBytes())
}
