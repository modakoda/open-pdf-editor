/**
 * Content stream interpreter: walks the operations of a page (and of form XObjects drawn on
 * it), tracking the graphics state, and collects the items a user can select.
 *
 * Item ids: `<prefix><kind letter><op index>` where the op index counts operations within the
 * current content (page or form XObject) and prefix is `x<n>/` for items inside the form
 * XObject drawn by operation n. Marked-content sections written by the editor for its own
 * objects (`/OPEObject <</Id (…)>> BDC … EMC`) are not counted in the enclosing numbering
 * (items inside get the prefix `@<Id>/`), so ids stay stable when they are added or removed.
 *
 * Optional content: items in layers that are hidden in the document's default configuration
 * (/OCProperties /D: /BaseState, /ON, /OFF; OCMDs with /P) are not listed.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject } from '@cantoo/pdf-lib'
import type { PdfBox } from '../geometry'
import type { ContentItem, ContentItemKind, Matrix, Point } from '../model'
import { INITIAL_COLOR, colorHex, colorSpaceInfo, deviceColor, initialComps, type ColorState } from './colors'
import { loadFont, type FontInfo } from './fonts'
import { PdfDictOp, PdfName, PdfStr, parseContent, type Op, type Operand } from './lexer'
import {
  IDENTITY,
  apply,
  applyVec,
  intersectRect,
  invert,
  isFiniteMatrix,
  maxScale,
  mul,
  rectIsEmpty,
  rectOfPoints,
  sameLinear,
  transformRect,
  translate,
  userToPageMatrix,
  type Rect
} from './matrix'
import { pathBounds, type Seg } from './paths'
import { arrayItems, get, getDict, getMatrix, getName, identityOf, numberArray, numberOf, streamData } from './pdfobj'

export const OPE_MARK = 'OPEObject'

export interface TextState {
  fontName: string | null
  font: FontInfo | null
  /** The font was set by an ExtGState /Font entry (re-established by the gs names). */
  fontFromGs: boolean
  size: number
  tc: number
  tw: number
  /** Horizontal scaling as a factor (Tz / 100). */
  th: number
  tl: number
  ts: number
  tr: number
}

export interface ClipPath {
  /** Path in page user space. */
  segs: Seg[]
  evenOdd: boolean
}

export interface GState {
  ctm: Matrix
  lw: number
  lc: number
  lj: number
  ml: number
  /** Operands of the last `d` (array, phase); null = solid. */
  dash: Operand[] | null
  ri: string | null
  flat: number | null
  fill: ColorState
  stroke: ColorState
  /**
   * ExtGStates applied so far, in order (re-applying a name moves it to the end), with the CTM
   * at the time (soft masks are defined in that space).
   */
  gsNames: { name: string; ctm: Matrix }[]
  fillAlpha: number
  strokeAlpha: number
  clips: ClipPath[]
  /** Bounds of the clipping region in page user space (null = unclipped). */
  clipRect: Rect | null
  /** Clipped by glyphs (text render modes 4–7), which `clips` does not describe. */
  textClip?: boolean
  text: TextState
  /** Changes whenever a non-text-state parameter changes (used to group text). */
  ver: number
}

let verCounter = 0
const nextVer = () => ++verCounter

export function initialGState(): GState {
  return {
    ctm: IDENTITY,
    lw: 1,
    lc: 0,
    lj: 0,
    ml: 10,
    dash: null,
    ri: null,
    flat: null,
    fill: INITIAL_COLOR,
    stroke: INITIAL_COLOR,
    gsNames: [],
    fillAlpha: 1,
    strokeAlpha: 1,
    clips: [],
    clipRect: null,
    text: { fontName: null, font: null, fontFromGs: false, size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0 },
    ver: nextVer()
  }
}

/** One run of glyphs of a show operation that belongs to a text item. */
export interface TextPiece {
  /** Page-level op index. */
  op: number
  /** Range of TJ array elements [elStart, elEnd) (Tj, ', ": [0, 1)). */
  elStart: number
  elEnd: number
  /** Text matrix at the first glyph of the piece. */
  tm: Matrix
  gs: GState
  /** Displacement of the elements of the piece, text space units. */
  adv: number
}

export interface ShowInfo {
  op: string
  /** TJ: array elements; others: [string]. */
  elements: Operand[]
  /** Displacement of each element (text space units along the writing direction). */
  elAdv: number[]
  size: number
  th: number
  vertical: boolean
}

export interface TextInfo {
  /** Text matrix of the first piece × CTM (line space → user space). */
  M: Matrix
  font: FontInfo
  size: number
  rise: number
  minA: number
  maxA: number
  /** Line-space position of the first visible glyph (origin of the item). */
  lead: number
  vertical: boolean
}

export interface ItemRecord {
  id: string
  kind: ContentItemKind
  item: ContentItem
  /** The item's operations are in the page content (not inside a non-inlined form XObject). */
  pageLevel: boolean
  /** Ids of the form XObject Do items the item is drawn by (outermost first). */
  chain: string[]
  /** Page-level op indices of the item (paths: construction + W + paint). */
  ops: number[]
  gs: GState
  pieces?: TextPiece[]
  text?: TextInfo
  path?: { paintOp: number; clipOp: number; fills: boolean; strokes: boolean }
  /** Property names of the enclosing `/OC /name BDC` sections (outermost first). */
  oc: string[]
  /** Text items: some of the text comes from /ActualText (redraws must carry it along). */
  actualText?: boolean
}

/**
 * A marked-content section with /ActualText (`/Span <</ActualText (…)>> BDC … EMC`): its text
 * replaces the Unicode of the glyphs shown inside (browsers write these for glyphs whose
 * /ToUnicode entry is empty, e.g. hyphens and brackets).
 */
export interface ActualSpan {
  /** Index of the BDC operation. */
  op: number
  text: string
  /** The text was given to the first glyph inside already. */
  used: boolean
  /** Ids of the listed text items with glyphs inside. */
  items: Set<string>
  /** Some glyphs inside belong to no listed item. */
  unlisted: boolean
  /** Number of glyphs inside, and the first one. */
  glyphs: number
  first?: { font: FontInfo; code: number }
}

export interface FinalState {
  qDepth: number
  inText: boolean
  marked: number
  pathOpen: boolean
}

/** An open marked-content section: its BDC/BMC operation and whether it began inside BT … ET. */
export interface OpenMarked {
  op: number
  inText: boolean
}

/** Interpreter state after a page-level operation (see InterpretOptions.snapshots). */
export interface Snapshot {
  /** States saved by the open `q`s (outermost first) and the current state. */
  stack: GState[]
  gs: GState
  inText: boolean
  tm: Matrix
  tlm: Matrix
  marked: OpenMarked[]
  /** Glyphs were shown with a clipping render mode (Tr 4–7) in the current text object. */
  textClip: boolean
  pathOpen: boolean
}

export interface Interpretation {
  ops: Op[]
  data: Uint8Array
  records: ItemRecord[]
  byId: Map<string, ItemRecord>
  shows: Map<number, ShowInfo>
  /** Page-level Q operations without a matching q. */
  unmatchedQ: number[]
  /** Page-level /ActualText sections. */
  actualSpans: ActualSpan[]
  /**
   * Per font: characters whose glyph only an /ActualText section of one glyph names (no
   * /ToUnicode entry), usable to re-encode text with that font.
   */
  knownCodes: Map<FontInfo, Map<string, number>>
  final: FinalState
  /** State after each page-level painting operation (and ET), when requested. */
  snapshots: Map<number, Snapshot>
}

export interface InterpretOptions {
  cropBox: PdfBox
  skipMarked?: Set<string>
  /** Form XObject nesting levels whose content is listed (default 3). */
  maxDepth?: number
  /** Graphics state at the start of the content (default: the page's initial state). */
  startGs?: GState
  /** Record a Snapshot after each page-level painting operation (paths, text, XObjects…) and ET. */
  snapshots?: boolean
}

interface Frame {
  ops: Op[]
  resources: PDFDict | undefined
  pageLevel: boolean
  chain: string[]
  prefix: string
  depth: number
  /** Form XObjects being interpreted (cycle guard). */
  active: Set<object>
}

interface TextBuilder {
  id: string
  M: Matrix
  Minv: Matrix
  font: FontInfo
  size: number
  th: number
  rise: number
  tr: number
  ver: number
  vertical: boolean
  /** Extent of the visible glyphs (line space, along the writing direction). */
  minA: number
  maxA: number
  /** Position of the first visible glyph (Infinity while there is none). */
  lead: number
  penEnd: number
  text: string
  pieces: TextPiece[]
  gs: GState
  frame: Frame
  oc: string[]
  spans: Set<ActualSpan> | null
}

interface Scope {
  prefix: string
  next: number
}

interface Marked {
  scope: boolean
  skip: boolean
  /** Property name of a visible `/OC /name BDC` section. */
  oc?: string
  /** The BDC/BMC operation and whether it began inside a text object. */
  open: OpenMarked
  actual?: ActualSpan
}

/** Operations after which Snapshots are recorded. */
const SNAPSHOT_OPS = new Set(['Tj', 'TJ', "'", '"', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'Do', 'BI', 'sh', 'ET'])

const SPACE_RE = /\s$/
const START_SPACE_RE = /^\s/

function nameArg(op: Op, i = 0): string | undefined {
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

/** Convert a pdf-lib object to an operand (for dash arrays from ExtGState). */
function toOperand(ctx: PDFContext, o: PDFObject | undefined): Operand {
  const n = numberOf(o)
  if (n !== undefined) return n
  if (o instanceof PDFArray) return arrayItems(ctx, o).map((x) => toOperand(ctx, x))
  if (o instanceof PDFName) return new PdfName(o.decodeText())
  return null
}

function rectToQuad(r: Rect): [Point, Point, Point, Point] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 }
  ]
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** Structural equality for graphics state values (numbers, arrays, small plain objects). */
function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true
  if (depth > 4 || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i], depth + 1)) return false
    return true
  }
  if (Array.isArray(b)) return false
  if (a instanceof PdfName && b instanceof PdfName) return a.name === b.name
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1)) return false
  }
  return true
}

/**
 * Order the corners of a (page-space) parallelogram as [top-left, top-right, bottom-right,
 * bottom-left] relative to the item's own orientation (`ex` = page-space direction of the
 * item's x axis), i.e. clockwise on screen starting at the item's top-left corner.
 */
export function orderQuad(pts: Point[], ex: Point): [Point, Point, Point, Point] {
  const th = Math.atan2(ex.y, ex.x)
  const c = Math.cos(-th)
  const sn = Math.sin(-th)
  const rot = pts.map((p) => ({ x: p.x * c - p.y * sn, y: p.x * sn + p.y * c }))
  let area = 0
  for (let i = 0; i < 4; i++) {
    const a = rot[i]
    const b = rot[(i + 1) % 4]
    area += a.x * b.y - b.x * a.y
  }
  const order = area < 0 ? [0, 3, 2, 1] : [0, 1, 2, 3]
  let best = 0
  const key = (k: number) => rot[order[k]].x + rot[order[k]].y
  for (let k = 1; k < 4; k++) if (key(k) < key(best) - 1e-9) best = k
  return [0, 1, 2, 3].map((k) => pts[order[(best + k) % 4]]) as [Point, Point, Point, Point]
}

function boxOfRect(r: Rect) {
  return { x: round(r.x0), y: round(r.y0), width: round(r.x1 - r.x0), height: round(r.y1 - r.y0) }
}

function roundPoint(p: Point): Point {
  return { x: round(p.x), y: round(p.y) }
}

/** The properties dict of a BDC (inline dict, or a name in /Properties). */
function bdcProps(op: Op, resources: PDFDict | undefined): { tag: string; props?: PdfDictOp; propsPdf?: PDFDict } {
  const tag = nameArg(op, 0) ?? ''
  const p = op.args[1]
  if (p instanceof PdfDictOp) return { tag, props: p }
  if (p instanceof PdfName) {
    const d = getDict(getDict(resources, 'Properties'), p.name)
    return { tag, propsPdf: d }
  }
  return { tag }
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

/** /ActualText of a BDC section (inline properties or a /Properties entry), else undefined. */
function actualTextOf(op: Op, resources: PDFDict | undefined): string | undefined {
  const { props, propsPdf } = bdcProps(op, resources)
  if (props) {
    const t = props.get('ActualText')
    return t instanceof PdfStr ? decodeTextString(t.bytes) : undefined
  }
  const t = propsPdf ? get(propsPdf, 'ActualText') : undefined
  const bytes = t && 'asBytes' in t ? (t as unknown as { asBytes(): Uint8Array }).asBytes() : undefined
  return bytes ? decodeTextString(bytes) : undefined
}

/** Id of an OPEObject section (from its properties), else undefined. */
export function opeObjectId(op: Op, resources: PDFDict | undefined): string | undefined {
  if (op.op !== 'BDC') return undefined
  const { tag, props, propsPdf } = bdcProps(op, resources)
  if (tag !== OPE_MARK) return undefined
  if (props) {
    const id = props.get('Id')
    if (id instanceof PdfStr) return decodeTextString(id.bytes)
    if (id instanceof PdfName) return id.name
    return ''
  }
  if (propsPdf) {
    const id = get(propsPdf, 'Id')
    const bytes = id && 'asBytes' in id ? (id as unknown as { asBytes(): Uint8Array }).asBytes() : undefined
    if (bytes) return decodeTextString(bytes)
  }
  return ''
}

/** PDF text string (PDFDocEncoding / UTF-16BE with BOM) → JS string. */
export function decodeTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    return s
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder().decode(bytes.subarray(3))
  }
  return latin1(bytes)
}


/**
 * Graphics state at the start of a form XObject's content drawn with state `gs`: CTM ×
 * /Matrix, clipped to /BBox (also recorded as a clipping path, so redrawn items keep it).
 * Inherited parameters that name resources of the parent (color spaces, fonts, ExtGStates) are
 * marked as inherited: a redraw block inside the form starts in that state already.
 */
export function formStartState(gs: GState, xo: PDFStream): GState {
  const dict = xo.dict
  const matrix = getMatrix(dict, 'Matrix') ?? IDENTITY
  const ctm = mul(matrix, gs.ctm)
  const bbox = numberArray(dict.context, get(dict, 'BBox') as PDFArray | undefined)
  let clips: ClipPath[] = []
  let clipRect = gs.clipRect
  if (bbox && bbox.length === 4) {
    const x0 = Math.min(bbox[0], bbox[2])
    const x1 = Math.max(bbox[0], bbox[2])
    const y0 = Math.min(bbox[1], bbox[3])
    const y1 = Math.max(bbox[1], bbox[3])
    const pts = [apply(ctm, x0, y0), apply(ctm, x1, y0), apply(ctm, x1, y1), apply(ctm, x0, y1)]
    clips = [
      {
        segs: [
          { op: 'm', pts: [pts[0].x, pts[0].y] },
          { op: 'l', pts: [pts[1].x, pts[1].y] },
          { op: 'l', pts: [pts[2].x, pts[2].y] },
          { op: 'l', pts: [pts[3].x, pts[3].y] },
          { op: 'h', pts: [] }
        ],
        evenOdd: false
      }
    ]
    clipRect = intersectRect(gs.clipRect, rectOfPoints(pts))
  }
  return {
    ...gs,
    ctm,
    clips,
    clipRect,
    gsNames: [],
    fill: { ...gs.fill, inherited: 'all' },
    stroke: { ...gs.stroke, inherited: 'all' },
    text: gs.text.fontName ? { ...gs.text, fontName: null, fontFromGs: true } : gs.text,
    ver: nextVer()
  }
}

export class Interpreter {
  readonly records: ItemRecord[] = []
  readonly shows = new Map<number, ShowInfo>()
  readonly unmatchedQ: number[] = []
  readonly snapshots = new Map<number, Snapshot>()
  readonly actualSpans: ActualSpan[] = []
  readonly knownCodes = new Map<FontInfo, Map<string, number>>()
  final: FinalState = { qDepth: 0, inText: false, marked: 0, pathOpen: false }
  private readonly toPage: Matrix
  private readonly cropRect: Rect
  private readonly maxDepth: number
  private skipCount = 0
  /** Property names of the visible optional-content sections enclosing the current op. */
  private ocStack: string[] = []
  /** The outermost /ActualText section enclosing the current op (inner ones are ignored). */
  private actual: ActualSpan | null = null
  private ocConfig: { baseOff: boolean; on: Set<PDFObject>; off: Set<PDFObject> } | null | undefined

  constructor(
    readonly ctx: PDFContext,
    readonly opts: InterpretOptions
  ) {
    const b = opts.cropBox
    this.toPage = userToPageMatrix(b)
    this.cropRect = { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }
    this.maxDepth = opts.maxDepth ?? 3
  }

  /** Interpret the operations of the content being listed / edited (page or form copy). */
  runPage(ops: Op[], resources: PDFDict | undefined): void {
    this.run(
      { ops, resources, pageLevel: true, chain: [], prefix: '', depth: 0, active: new Set() },
      this.opts.startGs ?? initialGState()
    )
  }

  /** The default optional-content configuration (/OCProperties /D). */
  private ocDefaults(): { baseOff: boolean; on: Set<PDFObject>; off: Set<PDFObject> } | null {
    if (this.ocConfig !== undefined) return this.ocConfig
    this.ocConfig = null
    try {
      const root = this.ctx.lookup(this.ctx.trailerInfo.Root)
      const props = root instanceof PDFDict ? getDict(root, 'OCProperties') : undefined
      const d = getDict(props, 'D')
      if (d) {
        const set = (key: string) => {
          const arr = get(d, key)
          return new Set(arr instanceof PDFArray ? arrayItems(this.ctx, arr).filter((o) => o) : [])
        }
        this.ocConfig = { baseOff: getName(d, 'BaseState') === 'OFF', on: set('ON'), off: set('OFF') }
      }
    } catch {
      this.ocConfig = null
    }
    return this.ocConfig
  }

  /** Whether an optional content group / membership dictionary is hidden by default. */
  ocHidden(obj: PDFObject | undefined, depth = 0): boolean {
    const o = obj instanceof PDFRef ? this.ctx.lookup(obj) : obj
    if (!(o instanceof PDFDict) || depth > 4) return false
    const cfg = this.ocDefaults()
    if (!cfg) return false
    if (getName(o, 'Type') === 'OCMD') {
      const ocgs = get(o, 'OCGs')
      const members = ocgs instanceof PDFArray ? arrayItems(this.ctx, ocgs) : ocgs ? [ocgs] : []
      if (!members.length) return false
      const vis = members.map((m) => !this.ocHidden(m, depth + 1))
      switch (getName(o, 'P') ?? 'AnyOn') {
        case 'AllOn':
          return !vis.every(Boolean)
        case 'AnyOff':
          return !vis.some((v) => !v)
        case 'AllOff':
          return !vis.every((v) => !v)
        default:
          return !vis.some(Boolean)
      }
    }
    return cfg.baseOff ? !cfg.on.has(o) : cfg.off.has(o)
  }

  // ---------------------------------------------------------------------------------------

  private toPagePoint(p: Point): Point {
    return apply(this.toPage, p.x, p.y)
  }

  private visible(r: Rect | null): boolean {
    if (!r) return false
    const i = intersectRect(r, this.cropRect)!
    return i.x1 >= i.x0 && i.y1 >= i.y0
  }

  private addRecord(rec: ItemRecord): void {
    this.records.push(rec)
  }

  /**
   * Record a box-like item (image, xobject, shading, path) given its own quad in user space
   * and bounds in user space; clipped by the current clip.
   */
  private boxItem(
    frame: Frame,
    gs: GState,
    id: string,
    kind: ContentItemKind,
    quadUser: Point[],
    aabbUser: Rect,
    ops: number[],
    extra: Partial<ItemRecord> = {},
    itemExtra: Partial<ContentItem> = {},
    axisCtm: Matrix = gs.ctm
  ): ItemRecord | undefined {
    if (this.skipCount > 0) return undefined
    let r = aabbUser
    let clippedQuad = false
    if (gs.clipRect) {
      const c = intersectRect(r, gs.clipRect)!
      if (c.x1 < c.x0 || c.y1 < c.y0) return undefined
      if (c.x0 > r.x0 + 0.5 || c.y0 > r.y0 + 0.5 || c.x1 < r.x1 - 0.5 || c.y1 < r.y1 - 0.5) clippedQuad = true
      r = c
    }
    if (!this.visible(r)) return undefined
    const pageRect = transformRect(this.toPage, r)
    const ex = applyVec(axisCtm, 1, 0)
    const quad = clippedQuad
      ? rectToQuad(pageRect)
      : orderQuad(
          quadUser.map((p) => this.toPagePoint(p)),
          { x: ex.x, y: -ex.y }
        )
    const item: ContentItem = {
      id,
      kind,
      bounds: boxOfRect(pageRect),
      quad: quad.map(roundPoint) as [Point, Point, Point, Point],
      ...itemExtra
    }
    const rec: ItemRecord = { id, kind, item, pageLevel: frame.pageLevel, chain: frame.chain, ops, gs, oc: this.ocStack, ...extra }
    this.addRecord(rec)
    return rec
  }

  private run(frame: Frame, startGs: GState): void {
    const { ops, resources } = frame
    const ctx = this.ctx
    let gs = startGs
    const stack: GState[] = []
    let inText = false
    let textClip = false
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    let path: Seg[] = []
    let pathOps: number[] = []
    let cur: Point = { x: 0, y: 0 }
    let subStart: Point = { x: 0, y: 0 }
    let pendingClip: { evenOdd: boolean; op: number } | null = null
    const marked: Marked[] = []
    const snapshots = frame.pageLevel && !!this.opts.snapshots
    const scopes: Scope[] = [{ prefix: frame.prefix, next: 0 }]
    let open: TextBuilder | null = null
    const fontCache = new Map<string, FontInfo>()
    const fonts = getDict(resources, 'Font')
    const xobjects = getDict(resources, 'XObject')
    const extGStates = getDict(resources, 'ExtGState')
    const colorSpaces = getDict(resources, 'ColorSpace')

    // Form XObjects drawn more than once in this content are not expanded.
    const doCounts = new Map<object, number>()
    for (const op of ops) {
      if (op.op !== 'Do') continue
      const name = nameArg(op)
      if (!name || !xobjects) continue
      const raw = xobjects.get(PDFName.of(name))
      const key = identityOf(raw, get(xobjects, name))
      if (key) doCounts.set(key, (doCounts.get(key) ?? 0) + 1)
    }

    const setGs = (patch: Partial<GState>) => {
      let changed = false
      for (const key of Object.keys(patch) as (keyof GState)[]) {
        if (!sameValue(gs[key], patch[key])) {
          changed = true
          break
        }
      }
      if (changed) gs = { ...gs, ...patch, ver: nextVer() }
    }
    const setText = (patch: Partial<TextState>) => {
      gs = { ...gs, text: { ...gs.text, ...patch } }
    }

    const closeText = () => {
      if (open) this.finishText(open)
      open = null
    }

    const resolveColorSpace = (name: string) => {
      switch (name) {
        case 'DeviceGray':
        case 'DeviceRGB':
        case 'DeviceCMYK':
        case 'Pattern':
        case 'G':
        case 'RGB':
        case 'CMYK':
          return colorSpaceInfo(ctx, PDFName.of(name))
        default: {
          const obj = colorSpaces ? get(colorSpaces, name) : undefined
          return colorSpaceInfo(ctx, obj ?? PDFName.of(name))
        }
      }
    }

    const fontByName = (name: string): FontInfo => {
      let f = fontCache.get(name)
      if (!f) {
        f = loadFont(ctx, fonts ? get(fonts, name) : undefined)
        fontCache.set(name, f)
      }
      return f
    }

    const addSeg = (seg: Seg) => {
      path.push(seg)
    }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      const top = scopes[scopes.length - 1]

      // Marked-content sections written by the editor (special numbering).
      if (op.op === 'BDC') {
        const opeId = opeObjectId(op, resources)
        if (opeId !== undefined) {
          closeText()
          const skip = !!this.opts.skipMarked?.has(opeId)
          marked.push({ scope: true, skip, open: { op: i, inText } })
          if (skip) this.skipCount++
          scopes.push({ prefix: top.prefix + '@' + opeId + '/', next: 0 })
          continue
        }
      }
      const idIndex = top.next++
      const id = (letter: string) => top.prefix + letter + idIndex

      switch (op.op) {
        // ---- graphics state
        case 'q':
          stack.push(gs)
          break
        case 'Q':
          if (stack.length) gs = stack.pop()!
          else if (frame.pageLevel) this.unmatchedQ.push(i)
          break
        case 'cm': {
          const m = numArgs(op, 6)
          if (m && isFiniteMatrix(m)) setGs({ ctm: mul(m as Matrix, gs.ctm) })
          break
        }
        case 'w': {
          const v = numArgs(op, 1)
          if (v) setGs({ lw: v[0] })
          break
        }
        case 'J': {
          const v = numArgs(op, 1)
          if (v) setGs({ lc: v[0] })
          break
        }
        case 'j': {
          const v = numArgs(op, 1)
          if (v) setGs({ lj: v[0] })
          break
        }
        case 'M': {
          const v = numArgs(op, 1)
          if (v) setGs({ ml: v[0] })
          break
        }
        case 'd':
          if (op.args.length >= 2 && Array.isArray(op.args[op.args.length - 2])) {
            setGs({ dash: op.args.slice(-2) })
          }
          break
        case 'ri': {
          const n = nameArg(op, op.args.length - 1)
          if (n) setGs({ ri: n })
          break
        }
        case 'i': {
          const v = numArgs(op, 1)
          if (v) setGs({ flat: v[0] })
          break
        }
        case 'gs': {
          const name = nameArg(op, op.args.length - 1)
          if (!name) break
          const dict = getDict(extGStates, name)
          const patch: Partial<GState> = { gsNames: [...gs.gsNames.filter((g) => g.name !== name), { name, ctm: gs.ctm }] }
          if (dict) {
            const lw = numberOf(get(dict, 'LW'))
            if (lw !== undefined) patch.lw = lw
            const lc = numberOf(get(dict, 'LC'))
            if (lc !== undefined) patch.lc = lc
            const lj = numberOf(get(dict, 'LJ'))
            if (lj !== undefined) patch.lj = lj
            const ml = numberOf(get(dict, 'ML'))
            if (ml !== undefined) patch.ml = ml
            const D = get(dict, 'D')
            if (D instanceof PDFArray) {
              const d = toOperand(ctx, D)
              if (Array.isArray(d) && d.length === 2) patch.dash = d
            }
            const ri = getName(dict, 'RI')
            if (ri) patch.ri = ri
            const ca = numberOf(get(dict, 'ca'))
            if (ca !== undefined) patch.fillAlpha = ca
            const CA = numberOf(get(dict, 'CA'))
            if (CA !== undefined) patch.strokeAlpha = CA
            const font = get(dict, 'Font')
            if (font instanceof PDFArray && font.size() >= 2) {
              const items = arrayItems(ctx, font)
              const size = numberOf(items[1])
              patch.text = {
                ...gs.text,
                font: loadFont(ctx, items[0]),
                fontName: null,
                fontFromGs: true,
                size: size ?? gs.text.size
              }
            }
          }
          setGs(patch)
          break
        }

        // ---- color
        case 'g':
        case 'rg':
        case 'k':
        case 'G':
        case 'RG':
        case 'K': {
          const lower = op.op.toLowerCase() as 'g' | 'rg' | 'k'
          const n = lower === 'g' ? 1 : lower === 'rg' ? 3 : 4
          const v = numArgs(op, n)
          if (!v) break
          const c = deviceColor(lower, v)
          setGs(op.op === lower ? { fill: c } : { stroke: c })
          break
        }
        case 'cs':
        case 'CS': {
          const name = nameArg(op, op.args.length - 1)
          if (!name) break
          const info = resolveColorSpace(name)
          const c: ColorState = { space: name, device: false, info, comps: initialComps(info) }
          setGs(op.op === 'cs' ? { fill: c } : { stroke: c })
          break
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const fill = op.op === 'sc' || op.op === 'scn'
          const base = fill ? gs.fill : gs.stroke
          const comps = op.args.filter((a): a is number => typeof a === 'number')
          const last = op.args[op.args.length - 1]
          const c: ColorState = {
            ...base,
            comps,
            pattern: last instanceof PdfName ? last.name : undefined,
            inherited: base.inherited ? 'space' : undefined
          }
          setGs(fill ? { fill: c } : { stroke: c })
          break
        }

        // ---- text objects
        case 'BT':
          closeText()
          inText = true
          textClip = false
          tm = IDENTITY
          tlm = IDENTITY
          break
        case 'ET':
          closeText()
          inText = false
          if (textClip) setGs({ textClip: true })
          break
        case 'Tf': {
          const name = nameArg(op, op.args.length - 2) ?? nameArg(op, 0)
          const size = typeof op.args[op.args.length - 1] === 'number' ? (op.args[op.args.length - 1] as number) : gs.text.size
          if (name) setText({ fontName: name, font: fontByName(name), fontFromGs: false, size })
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
          const val = v[0]
          if (op.op === 'Tc') setText({ tc: val })
          else if (op.op === 'Tw') setText({ tw: val })
          else if (op.op === 'Tz') setText({ th: val / 100 })
          else if (op.op === 'TL') setText({ tl: val })
          else if (op.op === 'Ts') setText({ ts: val })
          else setText({ tr: val })
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
          tlm = mul(translate(0, -gs.text.tl), tlm)
          tm = tlm
          break
        case 'Tj':
        case 'TJ':
        case "'":
        case '"': {
          if (op.op === "'" || op.op === '"') {
            if (op.op === '"') {
              const v = op.args.filter((a): a is number => typeof a === 'number')
              if (v.length >= 2) setText({ tw: v[0], tc: v[1] })
            }
            tlm = mul(translate(0, -gs.text.tl), tlm)
            tm = tlm
          }
          let elements: Operand[]
          if (op.op === 'TJ') {
            const arr = op.args[op.args.length - 1]
            elements = Array.isArray(arr) ? arr : []
          } else {
            const s = op.args[op.args.length - 1]
            elements = s instanceof PdfStr ? [s] : []
          }
          if (gs.text.tr >= 4) textClip = true
          const res = this.showText(frame, i, op.op, elements, gs, tm, open, idIndex, top.prefix)
          open = res.open
          tm = res.tm
          break
        }

        // ---- paths
        case 'm': {
          const v = numArgs(op, 2)
          if (!v) break
          cur = apply(gs.ctm, v[0], v[1])
          subStart = cur
          addSeg({ op: 'm', pts: [cur.x, cur.y] })
          pathOps.push(i)
          break
        }
        case 'l': {
          const v = numArgs(op, 2)
          if (!v) break
          cur = apply(gs.ctm, v[0], v[1])
          if (!path.length) addSeg({ op: 'm', pts: [cur.x, cur.y] })
          else addSeg({ op: 'l', pts: [cur.x, cur.y] })
          pathOps.push(i)
          break
        }
        case 'c':
        case 'v':
        case 'y': {
          const n = op.op === 'c' ? 6 : 4
          const v = numArgs(op, n)
          if (!v) break
          let p1: Point
          let p2: Point
          let p3: Point
          if (op.op === 'c') {
            p1 = apply(gs.ctm, v[0], v[1])
            p2 = apply(gs.ctm, v[2], v[3])
            p3 = apply(gs.ctm, v[4], v[5])
          } else if (op.op === 'v') {
            p1 = cur
            p2 = apply(gs.ctm, v[0], v[1])
            p3 = apply(gs.ctm, v[2], v[3])
          } else {
            p1 = apply(gs.ctm, v[0], v[1])
            p3 = apply(gs.ctm, v[2], v[3])
            p2 = p3
          }
          if (!path.length) addSeg({ op: 'm', pts: [cur.x, cur.y] })
          addSeg({ op: 'c', pts: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y] })
          cur = p3
          pathOps.push(i)
          break
        }
        case 'h':
          if (path.length) {
            addSeg({ op: 'h', pts: [] })
            cur = subStart
          }
          pathOps.push(i)
          break
        case 're': {
          const v = numArgs(op, 4)
          if (!v) break
          const [x, y, w, h] = v
          const p0 = apply(gs.ctm, x, y)
          const p1 = apply(gs.ctm, x + w, y)
          const p2 = apply(gs.ctm, x + w, y + h)
          const p3 = apply(gs.ctm, x, y + h)
          addSeg({ op: 'm', pts: [p0.x, p0.y] })
          addSeg({ op: 'l', pts: [p1.x, p1.y] })
          addSeg({ op: 'l', pts: [p2.x, p2.y] })
          addSeg({ op: 'l', pts: [p3.x, p3.y] })
          addSeg({ op: 'h', pts: [] })
          cur = p0
          subStart = p0
          pathOps.push(i)
          break
        }
        case 'W':
        case 'W*':
          pendingClip = { evenOdd: op.op === 'W*', op: i }
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
        case 'n': {
          closeText()
          const o = op.op
          if (o === 's' || o === 'b' || o === 'b*') {
            if (path.length) addSeg({ op: 'h', pts: [] })
          }
          const fills = o !== 'S' && o !== 's' && o !== 'n'
          const strokes = o === 'S' || o === 's' || o === 'B' || o === 'B*' || o === 'b' || o === 'b*'
          const segs = path
          if (o !== 'n' && segs.length) {
            this.pathItem(frame, gs, id('p'), segs, [...pathOps, ...(pendingClip ? [pendingClip.op] : []), i], {
              paintOp: i,
              clipOp: pendingClip ? pendingClip.op : -1,
              fills,
              strokes
            })
          }
          if (pendingClip && segs.length) {
            const b = pathBounds(segs)
            const clips = gs.clips.length >= 48 ? gs.clips.slice(-47) : gs.clips
            setGs({
              clips: [...clips, { segs, evenOdd: pendingClip.evenOdd }],
              clipRect: intersectRect(gs.clipRect, b ?? { x0: 0, y0: 0, x1: 0, y1: 0 })
            })
          }
          pendingClip = null
          path = []
          pathOps = []
          break
        }

        // ---- XObjects, inline images, shadings
        case 'Do': {
          closeText()
          const name = nameArg(op, op.args.length - 1)
          if (!name || !xobjects) break
          const raw = xobjects.get(PDFName.of(name))
          const xo = get(xobjects, name)
          if (!(xo instanceof PDFStream)) break
          if (this.ocHidden(xo.dict.get(PDFName.of('OC')))) break
          const subtype = getName(xo.dict, 'Subtype')
          if (subtype === 'Image') {
            this.imageItem(frame, gs, id('i'), [i])
          } else if (subtype === 'Form') {
            const key = identityOf(raw, xo) ?? xo
            this.formItem(frame, gs, id('x'), i, xo, (doCounts.get(key) ?? 1) === 1 && !frame.active.has(key), key)
          }
          break
        }
        case 'BI':
          closeText()
          this.imageItem(frame, gs, id('i'), [i])
          break
        case 'sh': {
          closeText()
          const r = intersectRect(gs.clipRect, this.cropRect)!
          if (rectIsEmpty(r)) break
          this.boxItem(frame, gs, id('s'), 'shading', rectToQuad(r), r, [i])
          break
        }

        // ---- marked content
        case 'BMC':
          marked.push({ scope: false, skip: false, open: { op: i, inText } })
          break
        case 'BDC': {
          if (nameArg(op, 0) === 'OC') {
            // Optional content: hidden layers are not listed; visible ones are re-applied to
            // redrawn items.
            closeText()
            const p = op.args[1]
            const props = p instanceof PdfName ? getDict(resources, 'Properties')?.get(PDFName.of(p.name)) : undefined
            if (p instanceof PdfName && this.ocHidden(props)) {
              marked.push({ scope: false, skip: true, open: { op: i, inText } })
              this.skipCount++
            } else {
              const name = p instanceof PdfName ? p.name : undefined
              marked.push({ scope: false, skip: false, oc: name, open: { op: i, inText } })
              if (name) this.ocStack = [...this.ocStack, name]
            }
            break
          }
          const text = this.actual ? undefined : actualTextOf(op, resources)
          if (text !== undefined) {
            const actual: ActualSpan = { op: i, text, used: false, items: new Set(), unlisted: false, glyphs: 0 }
            this.actual = actual
            if (frame.pageLevel) this.actualSpans.push(actual)
            marked.push({ scope: false, skip: false, open: { op: i, inText }, actual })
            break
          }
          marked.push({ scope: false, skip: false, open: { op: i, inText } })
          break
        }
        case 'EMC': {
          const m = marked.pop()
          if (m?.actual) {
            this.actual = null
            this.learnCode(m.actual)
          }
          if (m?.oc || m?.skip) closeText()
          if (m?.oc) this.ocStack = this.ocStack.slice(0, -1)
          if (m?.skip) this.skipCount--
          if (m?.scope) {
            closeText()
            scopes.pop()
          }
          break
        }
        default:
          break
      }
      if (snapshots && SNAPSHOT_OPS.has(op.op)) {
        this.snapshots.set(i, {
          stack: [...stack],
          gs,
          inText,
          tm,
          tlm,
          marked: marked.map((m) => m.open),
          textClip,
          pathOpen: path.length > 0 || pendingClip !== null
        })
      }
    }
    closeText()
    // Unclosed marked-content sections at the end.
    for (const m of marked) {
      if (m.actual) this.actual = null
      if (m.skip) this.skipCount--
      if (m.oc) this.ocStack = this.ocStack.slice(0, -1)
    }
    if (frame.pageLevel) {
      this.final = { qDepth: stack.length, inText, marked: marked.length, pathOpen: path.length > 0 || pendingClip !== null }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Text

  private showText(
    frame: Frame,
    opIndex: number,
    opName: string,
    elements: Operand[],
    gs: GState,
    tm0: Matrix,
    openIn: TextBuilder | null,
    idIndex: number,
    prefix: string
  ): { open: TextBuilder | null; tm: Matrix } {
    let open = openIn
    const ts = gs.text
    const font = ts.font ?? loadFont(this.ctx, undefined)
    const size = ts.size
    const th = ts.th
    const vertical = font.vertical
    const along = vertical ? size : size * th
    const space = font.spaceWidth > 0.05 ? font.spaceWidth : 0.25
    const gapMax = vertical ? Infinity : Math.abs(along) * Math.min(1, Math.max(0.5, 2.5 * space))
    const backMax = vertical ? -Infinity : -0.5 * Math.abs(along)
    const spaceGap = 0.15 * Math.abs(along)
    const elAdv: number[] = []
    let pen = 0
    let itemCount = 0

    interface Run {
      elStart: number
      lastStrEl: number
      startPen: number
      lastEnd: number
      /** Extent of the visible (non-whitespace) glyphs along the writing direction. */
      minA: number
      maxA: number
      /** Pen position at the first visible glyph (Infinity if none). */
      firstInk: number
      text: string
      spans: Set<ActualSpan> | null
    }
    let run: Run | null = null

    const finishRun = () => {
      if (!run) return
      const r = run
      run = null
      const ptm: Matrix = vertical ? mul(translate(0, r.startPen), tm0) : mul(translate(r.startPen, 0), tm0)
      const piece: TextPiece = { op: opIndex, elStart: r.elStart, elEnd: r.lastStrEl + 1, tm: ptm, gs, adv: r.lastEnd - r.startPen }
      const M = mul(ptm, gs.ctm)
      const minA = r.minA - r.startPen
      const maxA = r.maxA - r.startPen
      const lead = r.firstInk - r.startPen
      // Join the open item?
      if (open && !vertical && this.canJoin(open, font, gs, M)) {
        const q = apply(open.Minv, M[4], M[5])
        const gap = q.x - open.penEnd
        if (gap <= gapMax && gap >= backMax && Math.abs(q.y) < 0.2 * Math.abs(size)) {
          if (gap > spaceGap && !SPACE_RE.test(open.text) && !START_SPACE_RE.test(r.text)) open.text += ' '
          open.text += r.text
          open.minA = Math.min(open.minA, q.x + minA)
          open.maxA = Math.max(open.maxA, q.x + maxA)
          if (open.lead === Infinity && lead !== Infinity) open.lead = q.x + lead
          open.penEnd = q.x + piece.adv
          open.pieces.push(piece)
          if (r.spans) for (const sp of r.spans) (open.spans ??= new Set()).add(sp)
          return
        }
      }
      if (open) this.finishText(open)
      const Minv = invert(M)
      const itemId = prefix + 't' + idIndex + (itemCount ? '.' + itemCount : '')
      itemCount++
      if (!Minv) {
        open = null
        return
      }
      open = {
        id: itemId,
        M,
        Minv,
        font,
        size,
        th,
        rise: ts.ts,
        tr: ts.tr,
        ver: gs.ver,
        vertical,
        minA,
        maxA,
        lead,
        penEnd: piece.adv,
        text: r.text,
        pieces: [piece],
        gs,
        frame,
        oc: this.ocStack,
        spans: r.spans
      }
    }

    for (let k = 0; k < elements.length; k++) {
      const el = elements[k]
      if (typeof el === 'number') {
        const d = (-el / 1000) * along
        pen += d
        elAdv.push(d)
        continue
      }
      if (!(el instanceof PdfStr)) {
        elAdv.push(0)
        continue
      }
      const glyphs = font.glyphs(el.bytes)
      const startEl = pen
      if (glyphs.length) {
        if (run) {
          const r: Run = run
          const gap = pen - r.lastEnd
          if (gap > gapMax || gap < backMax) finishRun()
          else if (gap > spaceGap && !SPACE_RE.test(r.text) && !START_SPACE_RE.test(glyphs[0].unicode)) r.text += ' '
        }
        if (!run) {
          run = {
            elStart: k,
            lastStrEl: k,
            startPen: pen,
            lastEnd: pen,
            minA: Infinity,
            maxA: -Infinity,
            firstInk: Infinity,
            text: '',
            spans: null
          }
        }
        const r: Run = run
        const span = this.actual
        if (span) (r.spans ??= new Set()).add(span)
        for (const g of glyphs) {
          let u = g.unicode
          if (span) {
            // The section's text stands for all its glyphs: given to the first one.
            u = span.used ? '' : span.text
            span.used = true
            if (!span.glyphs++) span.first = { font, code: g.code }
          }
          if ((g.unicode && g.unicode.trim()) || u.trim()) {
            const ext = g.width * along
            const a0 = pen
            const a1 = pen + ext
            if (r.firstInk === Infinity) r.firstInk = pen
            if (a0 < r.minA) r.minA = a0
            if (a1 < r.minA) r.minA = a1
            if (a0 > r.maxA) r.maxA = a0
            if (a1 > r.maxA) r.maxA = a1
          }
          r.text += u
          const adv = vertical ? g.width * size + ts.tc + (g.space ? ts.tw : 0) : (g.width * size + ts.tc + (g.space ? ts.tw : 0)) * th
          pen += adv
        }
        r.lastEnd = pen
        r.lastStrEl = k
      }
      elAdv.push(pen - startEl)
    }
    finishRun()
    if (frame.pageLevel) this.shows.set(opIndex, { op: opName, elements, elAdv, size, th, vertical })
    const tm: Matrix = vertical ? mul(translate(0, pen), tm0) : mul(translate(pen, 0), tm0)
    return { open, tm }
  }

  /** An /ActualText section of one glyph and one character names that glyph's character. */
  private learnCode(span: ActualSpan): void {
    if (span.glyphs !== 1 || !span.first || [...span.text].length !== 1 || !span.text.trim()) return
    const { font, code } = span.first
    let m = this.knownCodes.get(font)
    if (!m) this.knownCodes.set(font, (m = new Map()))
    if (!m.has(span.text)) m.set(span.text, code)
  }

  private canJoin(open: TextBuilder, font: FontInfo, gs: GState, M: Matrix): boolean {
    const ts = gs.text
    return (
      open.font === font &&
      Math.abs(open.size - ts.size) <= 1e-6 * Math.max(1, Math.abs(ts.size)) &&
      Math.abs(open.th - ts.th) < 1e-6 &&
      Math.abs(open.rise - ts.ts) < 1e-6 &&
      open.tr === ts.tr &&
      open.ver === gs.ver &&
      sameLinear(open.M, M)
    )
  }

  private finishText(b: TextBuilder): void {
    const listed = this.recordText(b)
    if (b.spans) for (const sp of b.spans) listed ? sp.items.add(b.id) : (sp.unlisted = true)
  }

  /** Record the text item of `b`; false if it is not listed (invisible, empty, …). */
  private recordText(b: TextBuilder): boolean {
    if (this.skipCount > 0) return false
    if (b.tr === 3 || b.tr === 7 || !b.size) return false
    const text = b.text.trim()
    if (!text || b.lead === Infinity || !(b.maxA >= b.minA)) return false
    const { M, size, font } = b
    const asc = font.ascent * size + b.rise
    const desc = font.descent * size + b.rise
    let corners: Point[]
    if (b.vertical) {
      const half = Math.abs(size) / 2
      corners = [
        { x: -half, y: b.maxA },
        { x: half, y: b.maxA },
        { x: half, y: b.minA },
        { x: -half, y: b.minA }
      ]
    } else {
      corners = [
        { x: b.minA, y: asc },
        { x: b.maxA, y: asc },
        { x: b.maxA, y: desc },
        { x: b.minA, y: desc }
      ]
    }
    const userQuad = corners.map((p) => apply(M, p.x, p.y))
    const userRect = rectOfPoints(userQuad)!
    if (!this.visible(userRect)) return false
    const dirX = applyVec(M, 1, 0)
    const quad = orderQuad(
      userQuad.map((p) => this.toPagePoint(p)),
      { x: dirX.x, y: -dirX.y }
    ).map(roundPoint) as [Point, Point, Point, Point]
    const pageRect = transformRect(this.toPage, userRect)
    const origin = this.toPagePoint(b.vertical ? apply(M, 0, b.lead) : apply(M, b.lead, b.rise))
    const dir = applyVec(M, 1, 0)
    const angle = round((Math.atan2(-dir.y, dir.x) * 180) / Math.PI)
    const det = M[0] * M[3] - M[1] * M[2]
    const hx = Math.hypot(M[0], M[1])
    const fontSize = hx > 0 ? (Math.abs(size) * Math.abs(det)) / hx : Math.abs(size)
    const tr = b.tr
    const fillHex = colorHex(b.gs.fill)
    const strokeHex = colorHex(b.gs.stroke)
    const strokeOnly = tr === 1 || tr === 5
    const strokes = tr === 1 || tr === 2 || tr === 5 || tr === 6
    const item: ContentItem = {
      id: b.id,
      kind: 'text',
      bounds: boxOfRect(pageRect),
      quad,
      text,
      fontSize: round(fontSize),
      fontName: font.name || undefined,
      fontFamily: font.family,
      bold: font.bold,
      italic: font.italic,
      origin: roundPoint(origin),
      angle: angle === -180 ? 180 : angle === 0 ? 0 : angle,
      editableInPlace: font.editable && !font.encodingUnknown,
      ...(b.vertical ? { vertical: true } : {})
    }
    if (font.encodingUnknown) item.readOnly = true
    const color = strokeOnly ? strokeHex : fillHex
    if (color) item.color = color
    if (strokes && strokeHex) item.strokeColor = strokeHex
    const ops = [...new Set(b.pieces.map((p) => p.op))]
    this.addRecord({
      id: b.id,
      kind: 'text',
      item,
      pageLevel: b.frame.pageLevel,
      chain: b.frame.chain,
      ops,
      gs: b.gs,
      oc: b.oc,
      pieces: b.pieces,
      text: { M, font, size, rise: b.rise, minA: b.minA, maxA: b.maxA, lead: b.lead, vertical: b.vertical },
      actualText: !!b.spans?.size
    })
    return true
  }

  // ---------------------------------------------------------------------------------------
  // Paths, images, forms

  private pathItem(
    frame: Frame,
    gs: GState,
    id: string,
    segs: Seg[],
    ops: number[],
    paint: { paintOp: number; clipOp: number; fills: boolean; strokes: boolean }
  ): void {
    if (this.skipCount > 0) return
    const inv = invert(gs.ctm)
    const tight = pathBounds(segs)
    if (!tight || !inv) return
    const halfLw = paint.strokes ? Math.max(gs.lw, 0) / 2 : 0
    const local = pathBounds(segs, inv)!
    const lr = { x0: local.x0 - halfLw, y0: local.y0 - halfLw, x1: local.x1 + halfLw, y1: local.y1 + halfLw }
    const quadUser = [apply(gs.ctm, lr.x0, lr.y1), apply(gs.ctm, lr.x1, lr.y1), apply(gs.ctm, lr.x1, lr.y0), apply(gs.ctm, lr.x0, lr.y0)]
    const grow = halfLw * maxScale(gs.ctm)
    const aabb = { x0: tight.x0 - grow, y0: tight.y0 - grow, x1: tight.x1 + grow, y1: tight.y1 + grow }
    const w = aabb.x1 - aabb.x0
    const h = aabb.y1 - aabb.y0
    if (!(w > 1e-6 || h > 1e-6)) return
    if (!paint.strokes && !(w > 1e-6 && h > 1e-6)) return
    const fillHex = paint.fills ? colorHex(gs.fill) : undefined
    const strokeHex = paint.strokes ? colorHex(gs.stroke) : undefined
    const extra: Partial<ContentItem> = {}
    const color = paint.fills ? fillHex : strokeHex
    if (color) extra.color = color
    if (strokeHex) extra.strokeColor = strokeHex
    // quad order: top-left, top-right, bottom-right, bottom-left in page space (y down) — the
    // local rect's top (y1) maps to the visual top for upright CTMs.
    this.boxItem(frame, gs, id, 'path', quadUser, aabb, ops, { path: paint }, extra)
  }

  private imageItem(frame: Frame, gs: GState, id: string, ops: number[]): void {
    const q = [apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 0)]
    const r = rectOfPoints(q)!
    if (!(r.x1 - r.x0 > 1e-6 || r.y1 - r.y0 > 1e-6)) return
    this.boxItem(frame, gs, id, 'image', q, r, ops)
  }

  private formItem(frame: Frame, gs: GState, id: string, opIndex: number, xo: PDFStream, expand: boolean, key: object): void {
    const dict = xo.dict
    const matrix = getMatrix(dict, 'Matrix') ?? IDENTITY
    const ctm = mul(matrix, gs.ctm)
    const bboxArr = numberArray(this.ctx, get(dict, 'BBox') as PDFArray | undefined)
    let quad: Point[] | undefined
    let bboxUser: Rect | null = null
    if (bboxArr && bboxArr.length === 4) {
      const [a, b, c, d] = bboxArr
      const x0 = Math.min(a, c)
      const x1 = Math.max(a, c)
      const y0 = Math.min(b, d)
      const y1 = Math.max(b, d)
      quad = [apply(ctm, x0, y1), apply(ctm, x1, y1), apply(ctm, x1, y0), apply(ctm, x0, y0)]
      bboxUser = rectOfPoints(quad)
    }
    const recordStart = this.records.length
    // The container is listed before the items inside it (z-order).
    if (quad && bboxUser) this.boxItem(frame, gs, id, 'xobject', quad, bboxUser, [opIndex], {}, {}, ctm)
    if (expand && frame.depth < this.maxDepth) {
      const data = streamData(xo)
      if (data) {
        const formRes = getDict(dict, 'Resources') ?? frame.resources
        const inner = formStartState(gs, xo)
        const active = new Set(frame.active)
        active.add(key)
        const savedOc = this.ocStack
        this.ocStack = []
        this.run(
          {
            ops: parseContent(data),
            resources: formRes,
            pageLevel: false,
            chain: [...frame.chain, id],
            prefix: id + '/',
            depth: frame.depth + 1,
            active
          },
          inner
        )
        this.ocStack = savedOc
      }
    }
    if (!quad || !bboxUser) {
      // No /BBox: use the union of the items inside.
      const inner = this.records.slice(recordStart).map((r) => r.item.bounds)
      if (!inner.length) return
      const before = this.records.length
      const pts: Point[] = []
      for (const b of inner) {
        pts.push(apply(pageToUser(this.opts.cropBox), b.x, b.y), apply(pageToUser(this.opts.cropBox), b.x + b.width, b.y + b.height))
      }
      bboxUser = rectOfPoints(pts)!
      quad = [
        { x: bboxUser.x0, y: bboxUser.y1 },
        { x: bboxUser.x1, y: bboxUser.y1 },
        { x: bboxUser.x1, y: bboxUser.y0 },
        { x: bboxUser.x0, y: bboxUser.y0 }
      ]
      this.boxItem(frame, gs, id, 'xobject', quad, bboxUser, [opIndex], {}, {}, ctm)
      if (this.records.length > before) this.records.splice(recordStart, 0, this.records.pop()!)
    }
  }


}

function pageToUser(box: PdfBox): Matrix {
  return [1, 0, 0, -1, box.x, box.y + box.height]
}

/** Run the interpreter over parsed page operations. */
export function interpret(
  ctx: PDFContext,
  data: Uint8Array,
  ops: Op[],
  resources: PDFDict | undefined,
  opts: InterpretOptions
): Interpretation {
  const it = new Interpreter(ctx, opts)
  it.runPage(ops, resources)
  const byId = new Map<string, ItemRecord>()
  for (const r of it.records) if (!byId.has(r.id)) byId.set(r.id, r)
  return {
    ops,
    data,
    records: it.records,
    byId,
    shows: it.shows,
    unmatchedQ: it.unmatchedQ,
    actualSpans: it.actualSpans,
    knownCodes: it.knownCodes,
    final: it.final,
    snapshots: it.snapshots
  }
}
