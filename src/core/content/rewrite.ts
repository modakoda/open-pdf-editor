/**
 * Rewriting page content: applying ContentEdits, inlining form XObjects, stripping
 * OPEObject sections. Untouched operations are copied byte-for-byte.
 *
 * Moved / re-typed / re-sized / re-colored items are removed from their place and redrawn at
 * the end of the page in a self-contained block (`q` + the graphics state they need + the
 * original operators + `Q`); the original content is wrapped in `q … Q` (with missing `Q`/`ET`
 * added and stray `Q` removed) so the blocks start from the default graphics state. The
 * clipping paths in effect for a moved item are redrawn transformed together with the item, so
 * it looks the same at its new place. Paths whose only change is the color are re-colored in
 * place (keeps their stacking order).
 */
import { PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFFont, type PDFPage } from '@cantoo/pdf-lib'
import type { PdfBox } from '../geometry'
import type { ContentEdit, Matrix } from '../model'
import { fontMetrics, prepareText, type ResolvedTextFont } from '../text'
import { parseHex, type ColorState } from './colors'
import {
  OPE_INLINE,
  interpret,
  opeObjectId,
  type GState,
  type Interpretation,
  type ItemRecord,
  type TextState
} from './interpreter'
import { PdfName, PdfStr, isWhite, parseContent, type Op, type Operand } from './lexer'
import { IDENTITY, apply, mul, pageTransformToUser, translate } from './matrix'
import { ResourceEditor, pageResources, readPageContent, writePageContent } from './page'
import { writePath } from './paths'
import { get, getDict, getMatrix, numberArray, resolve, streamData } from './pdfobj'
import { ByteWriter, fmt, writeHexBytes, writeMatrix, writeName, writeOp, writeOperand, writeTextString } from './serialize'

export interface EditHelpers {
  embedFont(font: ResolvedTextFont): Promise<PDFFont>
}

type Replacement = string | Uint8Array | null

const RESET_OPS = new Set(['Td', 'TD', 'Tm', 'T*', "'", '"', 'BT', 'ET'])

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function opBytes(interp: Interpretation, k: number): Uint8Array {
  const op = interp.ops[k]
  return interp.data.subarray(op.start, op.end)
}

function opText(interp: Interpretation, k: number): string {
  return latin1(opBytes(interp, k))
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
// Graphics state re-emission

function colorOps(c: ColorState, stroke: boolean): string {
  const comps = c.comps.map((v) => fmt(v)).join(' ')
  if (c.device) {
    const op = c.space === 'DeviceGray' ? 'g' : c.space === 'DeviceRGB' ? 'rg' : 'k'
    return `${comps} ${stroke ? op.toUpperCase() : op}\n`
  }
  let s = `${writeName(c.space)} ${stroke ? 'CS' : 'cs'}\n`
  if (comps || c.pattern) s += `${comps}${c.pattern ? (comps ? ' ' : '') + writeName(c.pattern) : ''} ${stroke ? 'SCN' : 'scn'}\n`
  return s
}

/** `q`, clipping paths (moved by U), CTM × U, ExtGStates, line state, colors. */
function blockHead(gs: GState, U: Matrix): string {
  let s = 'q\n'
  for (const c of gs.clips) s += writePath(c.segs, U) + (c.evenOdd ? '\nW* n\n' : '\nW n\n')
  s += `${writeMatrix(mul(gs.ctm, U))} cm\n`
  for (const n of gs.gsNames) s += `${writeName(n)} gs\n`
  const dash = gs.dash ? `${writeOperand(gs.dash[0])} ${writeOperand(gs.dash[1])}` : '[] 0'
  s += `${fmt(gs.lw)} w ${fmt(gs.lc)} J ${fmt(gs.lj)} j ${fmt(gs.ml)} M ${dash} d\n`
  if (gs.ri) s += `${writeName(gs.ri)} ri\n`
  if (gs.flat !== null) s += `${fmt(gs.flat)} i\n`
  s += colorOps(gs.fill, false) + colorOps(gs.stroke, true)
  return s
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
// Inlining form XObjects

const RESOURCE_CATEGORIES = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties']
const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK', 'I', 'Indexed'])

type Renames = Map<string, Map<string, string>>

function mergeResources(formRes: PDFDict, res: ResourceEditor): Renames {
  const renames: Renames = new Map()
  for (const cat of RESOURCE_CATEGORIES) {
    const src = getDict(formRes, cat)
    if (!src) continue
    for (const [key, val] of src.entries()) {
      const name = key.decodeText()
      const existing = res.get(cat, name)
      if (existing === undefined) {
        res.set(cat, name, val)
      } else if (existing !== val && resolve(src.context, existing) !== resolve(src.context, val)) {
        const fresh = res.freshName(cat, name)
        res.set(cat, fresh, val)
        let m = renames.get(cat)
        if (!m) renames.set(cat, (m = new Map()))
        m.set(name, fresh)
      }
    }
  }
  return renames
}

function renameOp(op: Op, data: Uint8Array, renames: Renames): Uint8Array | undefined {
  if (!renames.size) return undefined
  const rn = (cat: string, o: Operand | undefined): Operand | undefined => {
    if (!(o instanceof PdfName)) return undefined
    const to = renames.get(cat)?.get(o.name)
    return to ? new PdfName(to) : undefined
  }
  const args = op.args.slice()
  let changed = false
  const at = (idx: number, cat: string) => {
    if (idx < 0 || idx >= args.length) return
    const r = rn(cat, args[idx])
    if (r) {
      args[idx] = r
      changed = true
    }
  }
  switch (op.op) {
    case 'Tf':
      at(args.length - 2, 'Font')
      break
    case 'Do':
      at(args.length - 1, 'XObject')
      break
    case 'gs':
      at(args.length - 1, 'ExtGState')
      break
    case 'sh':
      at(args.length - 1, 'Shading')
      break
    case 'cs':
    case 'CS': {
      const a = args[args.length - 1]
      if (a instanceof PdfName && !DEVICE_SPACES.has(a.name)) at(args.length - 1, 'ColorSpace')
      break
    }
    case 'sc':
    case 'scn':
    case 'SC':
    case 'SCN':
      at(args.length - 1, 'Pattern')
      break
    case 'BDC':
    case 'DP':
      at(1, 'Properties')
      break
    case 'BI': {
      if (!op.image) return undefined
      const dict = new Map(op.image.dict.map)
      for (const key of ['CS', 'ColorSpace']) {
        const v = dict.get(key)
        if (v instanceof PdfName && !DEVICE_SPACES.has(v.name)) {
          const r = rn('ColorSpace', v)
          if (r) {
            dict.set(key, r)
            changed = true
          }
        } else if (Array.isArray(v) && v[1] instanceof PdfName && !DEVICE_SPACES.has(v[1].name)) {
          const r = rn('ColorSpace', v[1])
          if (r) {
            const nv = v.slice()
            nv[1] = r
            dict.set(key, nv)
            changed = true
          }
        }
      }
      if (!changed) return undefined
      const w = new ByteWriter()
      w.text('BI ')
      for (const [k, v] of dict) w.text(`${writeName(k)} ${writeOperand(v)} `)
      w.text('ID ')
      w.bytes(data.subarray(op.image.dataStart, op.image.dataEnd))
      w.text('\nEI')
      return w.toBytes()
    }
    default:
      return undefined
  }
  if (!changed) return undefined
  const w = new ByteWriter()
  w.text(writeOp(op.op, args))
  return w.toBytes()
}

const PATH_CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're'])
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])

/** Content replacing a `Do` of a form XObject: its content wrapped in an OPEInline section. */
function inlineRegion(xo: PDFStream, src: string, res: ResourceEditor): Uint8Array | undefined {
  const data = streamData(xo)
  if (!data) return undefined
  const inner = parseContent(data)
  const formRes = getDict(xo.dict, 'Resources')
  const renames = formRes ? mergeResources(formRes, res) : new Map()
  const m = getMatrix(xo.dict, 'Matrix') ?? IDENTITY
  const bbox = numberArray(xo.dict.context, get(xo.dict, 'BBox') as never)
  let header = ''
  let n = 0
  const oc = xo.dict.get(PDFName.of('OC'))
  if (oc) {
    const name = res.freshName('Properties', 'OPEoc')
    res.set('Properties', name, oc)
    header += `/OC ${writeName(name)} BDC\n`
    n++
  }
  header += 'q\n'
  header += `${writeMatrix(m)} cm\n`
  n += 2
  if (bbox && bbox.length === 4) {
    const x0 = Math.min(bbox[0], bbox[2])
    const y0 = Math.min(bbox[1], bbox[3])
    header += `${fmt(x0)} ${fmt(y0)} ${fmt(Math.abs(bbox[2] - bbox[0]))} ${fmt(Math.abs(bbox[3] - bbox[1]))} re\nW\nn\n`
    n += 3
  }
  const w = new ByteWriter()
  w.text(`/${OPE_INLINE} <</Src ${writeTextString(src)} /N ${n}>> BDC\n`)
  w.text(header)
  let depth = 0
  let mdepth = 0
  let inText = false
  let pathOpen = false
  let prev = 0
  for (const op of inner) {
    if (op.start > prev) w.bytes(data.subarray(prev, op.start))
    prev = op.end
    const o = op.op
    // Keep the operation count (ids) while neutralizing operators that would break nesting.
    if ((o === 'Q' && depth === 0) || (o === 'EMC' && mdepth === 0)) {
      w.text('/OPENop MP')
      continue
    }
    if (o === 'q') depth++
    else if (o === 'Q') depth--
    else if (o === 'BMC' || o === 'BDC') mdepth++
    else if (o === 'EMC') mdepth--
    else if (o === 'BT') inText = true
    else if (o === 'ET') inText = false
    if (PATH_CONSTRUCTION.has(o)) pathOpen = true
    else if (PATH_PAINT.has(o)) pathOpen = false
    const renamed = renameOp(op, data, renames)
    w.bytes(renamed ?? data.subarray(op.start, op.end))
  }
  w.text('\n')
  if (pathOpen) w.text('n\n')
  if (inText) w.text('ET\n')
  for (let i = 0; i < mdepth; i++) w.text('EMC\n')
  for (let i = 0; i < depth; i++) w.text('Q\n')
  w.text('Q\n')
  if (oc) w.text('EMC\n')
  w.text('EMC')
  return w.toBytes()
}

function inlineForms(interp: Interpretation, ids: Set<string>, res: ResourceEditor): Uint8Array {
  const plan = new Map<number, Replacement>()
  const xobjects = getDict(res.resources(), 'XObject')
  for (const id of ids) {
    const rec = interp.byId.get(id)
    if (!rec || rec.region) continue
    const k = rec.ops[0]
    const op = interp.ops[k]
    const nameOp = op.args[op.args.length - 1]
    if (!(nameOp instanceof PdfName)) continue
    const xo = get(xobjects, nameOp.name)
    if (!(xo instanceof PDFStream)) continue
    const region = inlineRegion(xo, id, res)
    if (region) plan.set(k, region)
  }
  return emitAll(interp, plan).toBytes()
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
  const effective = edits.filter(hasEffect)
  if (!effective.length) return
  const ctx = doc.context
  const res = new ResourceEditor(doc, page)
  let data = readPageContent(page)
  let interp = interpret(ctx, data, parseContent(data), res.resources(), { cropBox, skipMarked })

  // Inline the form XObjects that contain edited items (outermost first, up to 6 levels).
  for (let round = 0; round < 6; round++) {
    const toInline = new Set<string>()
    for (const e of effective) {
      const rec = interp.byId.get(e.itemId)
      if (rec?.pageLevel) continue
      const parts = e.itemId.split('/')
      for (let k = parts.length - 1; k >= 1; k--) {
        const prefix = parts.slice(0, k).join('/')
        const r = interp.byId.get(prefix)
        if (r && r.pageLevel && r.kind === 'xobject' && !r.region) {
          toInline.add(prefix)
          break
        }
      }
    }
    if (!toInline.size) break
    data = inlineForms(interp, toInline, res)
    interp = interpret(ctx, data, parseContent(data), res.resources(), { cropBox, skipMarked })
  }

  // Classify.
  const actions: Action[] = []
  const seen = new Set<string>()
  for (const edit of effective) {
    if (seen.has(edit.itemId)) continue
    const rec = interp.byId.get(edit.itemId)
    if (!rec || !rec.pageLevel) continue
    seen.add(edit.itemId)
    const U = isIdentity(edit.transform) ? IDENTITY : pageTransformToUser(edit.transform!, cropBox)
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
  if (!actions.length) return

  // Removal plan.
  const plan = new Map<number, Replacement>()
  const removed = new Set<number>()
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
    } else if (rec.region) {
      for (const k of rec.ops) removed.add(k)
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
    plan.set(constr[0], `q\n${override}${opText(interp, constr[0])}`)
    if (clipOp >= 0) plan.set(clipOp, null)
    let tail = `${opText(interp, paintOp)}\nQ`
    if (clipOp >= 0) tail += '\n' + constr.map((k) => opText(interp, k)).join('\n') + `\n${interp.ops[clipOp].op} n`
    plan.set(paintOp, tail)
  }

  // Redrawn blocks.
  const blocks: (string | Uint8Array)[] = []
  const fontNames = new Map<PDFRef, string>()
  const fontResource = (font: PDFFont): string => {
    const known = fontNames.get(font.ref)
    if (known) return known
    const fonts = getDict(res.resources(), 'Font')
    if (fonts) {
      for (const [key, val] of fonts.entries()) {
        if (val === font.ref) {
          fontNames.set(font.ref, key.decodeText())
          return key.decodeText()
        }
      }
    }
    const name = res.freshName('Font', 'OPEF1')
    res.set('Font', name, font.ref)
    fontNames.set(font.ref, name)
    return name
  }

  for (const a of actions) {
    if (a.mode !== 'redraw') continue
    const rec = a.rec
    if (rec.kind === 'text') {
      blocks.push(await textBlock(interp, rec, a.edit, a.U, helpers, fontResource))
    } else if (rec.kind === 'path' && rec.path) {
      const { paintOp, clipOp, fills } = rec.path
      let s = blockHead(rec.gs, a.U)
      if (a.edit.color) s += rgbOp(a.edit.color, !fills)
      for (const k of rec.ops) if (k !== paintOp && k !== clipOp) s += opText(interp, k) + '\n'
      s += `${interp.ops[paintOp].op}\nQ\n`
      blocks.push(s)
    } else {
      const w = new ByteWriter()
      w.text(blockHead(rec.gs, a.U))
      if (rec.kind === 'xobject') w.text(textStateOps(rec.gs.text, null))
      if (rec.region) emitOps(w, interp, rec.region.start, rec.region.end, plan)
      else for (const k of rec.ops) w.bytes(opBytes(interp, k))
      w.text('\nQ\n')
      blocks.push(w.toBytes())
    }
  }

  // Assemble.
  const out = new ByteWriter()
  if (blocks.length) {
    for (const k of interp.unmatchedQ) if (!plan.has(k)) plan.set(k, null)
    out.text('q\n')
    out.bytes(emitAll(interp, plan, removed).toBytes())
    const f = interp.final
    let closers = '\n'
    if (f.pathOpen) closers += 'n\n'
    if (f.inText) closers += 'ET\n'
    for (let i = 0; i < f.marked; i++) closers += 'EMC\n'
    for (let i = 0; i < f.qDepth; i++) closers += 'Q\n'
    out.text(closers + 'Q\n')
    for (const b of blocks) {
      if (typeof b === 'string') out.text(b)
      else out.bytes(b)
    }
  } else {
    out.bytes(emitAll(interp, plan, removed).toBytes())
  }
  writePageContent(doc, page, out.toBytes())
}

async function textBlock(
  interp: Interpretation,
  rec: ItemRecord,
  edit: ContentEdit,
  U0: Matrix,
  helpers: EditHelpers,
  fontResource: (font: PDFFont) => string
): Promise<string> {
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
  let s = blockHead(first.gs, U)
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
      const pdfFont = await helpers.embedFont(prepared.font)
      fontName = fontResource(pdfFont)
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
