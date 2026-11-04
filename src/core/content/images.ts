/**
 * Image sample access for redaction: decode an image XObject or inline image (ASCIIHex,
 * ASCII85, LZW, Flate, RunLength — with PNG / TIFF predictors — and DCT), overwrite the pixels
 * under some areas, and write the result as a new Flate-compressed image XObject. The original
 * image object is never modified (it may be drawn elsewhere). Soft masks and explicit masks
 * get the same treatment, so the shape of what was under the areas does not survive in them.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject
} from '@cantoo/pdf-lib'
import type { Point } from '../model'
import { PdfDictOp, PdfName, PdfStr, type Operand } from './lexer'
import { N, arrayItems, get, getDict, getName, numberOf, resolve, streamData, stringBytes } from './pdfobj'

export class UnsupportedImageError extends Error {}

interface Filter {
  name: string
  parms?: PDFDict
}

interface Samples {
  data: Uint8Array
  width: number
  height: number
  bpc: number
  comps: number
}

/** RGB, components 0..1. */
export type Rgb = [number, number, number]

const FILTER_ABBREV: Record<string, string> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode'
}

const LIB_FILTERS = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode', 'FlateDecode', 'RunLengthDecode'])

/** Keys that describe the encoding of the original data (or data that must not survive). */
const DROP_KEYS = new Set([
  'Filter',
  'DecodeParms',
  'Length',
  'DL',
  'F',
  'FFilter',
  'FDecodeParms',
  'SMask',
  'Mask',
  'BitsPerComponent',
  'Metadata',
  'Alternates',
  'OPI',
  'ID',
  'SMaskInData'
])

function filtersOf(ctx: PDFContext, dict: PDFDict): Filter[] {
  const f = get(dict, 'Filter')
  const p = get(dict, 'DecodeParms')
  const names = f instanceof PDFName ? [f] : f instanceof PDFArray ? arrayItems(ctx, f) : []
  const parms = p instanceof PDFArray ? arrayItems(ctx, p) : [p]
  return names.map((n, i) => {
    const name = n instanceof PDFName ? n.decodeText() : ''
    const parm = parms[i]
    return { name: FILTER_ABBREV[name] ?? name, parms: parm instanceof PDFDict ? parm : undefined }
  })
}

let jpegModule: Promise<typeof import('pdfjs-dist/image_decoders/pdf.image_decoders.mjs')> | undefined

function jpegDecoder() {
  jpegModule ??= import('pdfjs-dist/image_decoders/pdf.image_decoders.mjs')
  jpegModule.catch(() => (jpegModule = undefined))
  return jpegModule
}

async function decodeDct(bytes: Uint8Array, parms: PDFDict | undefined, width: number, height: number) {
  const { JpegImage } = await jpegDecoder()
  const colorTransform = numberOf(get(parms, 'ColorTransform'))
  const jpeg = new JpegImage(colorTransform === undefined ? {} : { colorTransform })
  try {
    jpeg.parse(bytes)
  } catch (e) {
    throw new UnsupportedImageError(`JPEG image could not be decoded (${(e as Error).message})`)
  }
  const w = width || jpeg.width
  const h = height || jpeg.height
  // isSourcePDF: CMYK samples are returned as stored (the image's /Decode still applies).
  const data = jpeg.getData({ width: w, height: h, forceRGB: false, isSourcePDF: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), comps: jpeg.numComponents }
}

function libDecode(ctx: PDFContext, bytes: Uint8Array, f: Filter): Uint8Array {
  const dict = ctx.obj({})
  dict.set(N('Filter'), N(f.name))
  if (f.parms) dict.set(N('DecodeParms'), f.parms)
  return decodePDFRawStream(PDFRawStream.of(dict, bytes)).decode()
}

/** Undo a PNG (10–15) or TIFF (2) predictor. */
function unpredict(data: Uint8Array, parms: PDFDict | undefined): Uint8Array {
  const predictor = numberOf(get(parms, 'Predictor')) ?? 1
  if (predictor <= 1) return data
  const colors = numberOf(get(parms, 'Colors')) ?? 1
  const bpc = numberOf(get(parms, 'BitsPerComponent')) ?? 8
  const columns = numberOf(get(parms, 'Columns')) ?? 1
  const rowBytes = Math.ceil((colors * bpc * columns) / 8)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  if (predictor === 2) {
    const out = data.slice()
    if (bpc === 8) {
      for (let row = 0; row * rowBytes < out.length; row++) {
        const base = row * rowBytes
        for (let i = colors; i < rowBytes && base + i < out.length; i++) out[base + i] = (out[base + i] + out[base + i - colors]) & 0xff
      }
      return out
    }
    if (bpc === 16) {
      for (let row = 0; row * rowBytes < out.length; row++) {
        const base = row * rowBytes
        for (let i = 2 * colors; i + 1 < rowBytes && base + i + 1 < out.length; i += 2) {
          const v = ((out[base + i] << 8) | out[base + i + 1]) + ((out[base + i - 2 * colors] << 8) | out[base + i + 1 - 2 * colors])
          out[base + i] = (v >> 8) & 0xff
          out[base + i + 1] = v & 0xff
        }
      }
      return out
    }
    throw new UnsupportedImageError(`TIFF predictor with ${bpc} bits per component`)
  }
  // PNG: every row starts with a filter type byte.
  const rows = Math.floor(data.length / (rowBytes + 1))
  const out = new Uint8Array(rows * rowBytes)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)]
    const src = r * (rowBytes + 1) + 1
    const dst = r * rowBytes
    const up = dst - rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + i]
      const left = i >= bpp ? out[dst + i - bpp] : 0
      const above = r > 0 ? out[up + i] : 0
      const upLeft = r > 0 && i >= bpp ? out[up + i - bpp] : 0
      let v: number
      switch (type) {
        case 1:
          v = raw + left
          break
        case 2:
          v = raw + above
          break
        case 3:
          v = raw + ((left + above) >> 1)
          break
        case 4: {
          const p = left + above - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - above)
          const pc = Math.abs(p - upLeft)
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft)
          break
        }
        default:
          v = raw
      }
      out[dst + i] = v & 0xff
    }
  }
  return out
}

/** Decoded samples (rows padded to whole bytes) of image data encoded with `filters`. */
async function decodeSamples(
  ctx: PDFContext,
  encoded: Uint8Array,
  filters: Filter[],
  geometry: { width: number; height: number; bpc: number; comps: number }
): Promise<Samples> {
  let data = encoded
  let { bpc, comps } = geometry
  const { width, height } = geometry
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    if (f.name === 'DCTDecode') {
      if (i !== filters.length - 1) throw new UnsupportedImageError('DCTDecode followed by another filter')
      const jpeg = await decodeDct(data, f.parms, width, height)
      data = jpeg.data
      bpc = 8
      comps = jpeg.comps
      break
    }
    if (f.name === 'Crypt') continue
    if (!LIB_FILTERS.has(f.name)) throw new UnsupportedImageError(`${f.name || 'unknown'} images are not supported`)
    try {
      data = libDecode(ctx, data, f)
    } catch (e) {
      throw new UnsupportedImageError(`image data could not be decoded (${(e as Error).message})`)
    }
    if (f.name === 'FlateDecode' || f.name === 'LZWDecode') data = unpredict(data, f.parms)
  }
  if (!(width > 0 && height > 0 && bpc > 0 && comps > 0)) throw new UnsupportedImageError('invalid image geometry')
  const rowBytes = Math.ceil((width * comps * bpc) / 8)
  const size = rowBytes * height
  if (data.length !== size) {
    // Truncated (or padded) data: like viewers, missing samples are zero.
    const fixed = new Uint8Array(size)
    fixed.set(data.subarray(0, size))
    data = fixed
  } else if (data === encoded) {
    data = data.slice()
  }
  return { data, width, height, bpc, comps }
}

// ---------------------------------------------------------------------------------------
// Color spaces and target samples

type CsKind = 'gray' | 'rgb' | 'cmyk' | 'indexed' | 'lab' | 'sep' | 'other'

interface CsInfo {
  kind: CsKind
  comps: number
  indexed?: { base: CsInfo; hival: number; lookup: Uint8Array }
}

function nameCs(name: string): CsInfo | undefined {
  switch (name) {
    case 'DeviceGray':
    case 'G':
    case 'CalGray':
      return { kind: 'gray', comps: 1 }
    case 'DeviceRGB':
    case 'RGB':
    case 'CalRGB':
      return { kind: 'rgb', comps: 3 }
    case 'DeviceCMYK':
    case 'CMYK':
      return { kind: 'cmyk', comps: 4 }
    default:
      return undefined
  }
}

function csInfo(ctx: PDFContext, cs: PDFObject | undefined, resources: PDFDict | undefined, depth = 0): CsInfo {
  const o = resolve(ctx, cs)
  if (depth > 5 || !o) return { kind: 'other', comps: 1 }
  if (o instanceof PDFName) {
    const name = o.decodeText()
    const known = nameCs(name)
    if (known) return known
    const named = get(getDict(resources, 'ColorSpace'), name)
    return named ? csInfo(ctx, named, resources, depth + 1) : { kind: 'other', comps: 1 }
  }
  if (!(o instanceof PDFArray) || !o.size()) return { kind: 'other', comps: 1 }
  const items = arrayItems(ctx, o)
  const family = items[0] instanceof PDFName ? items[0].decodeText() : ''
  switch (family) {
    case 'CalGray':
    case 'CalRGB':
    case 'CalCMYK':
      return nameCs(family) ?? { kind: 'cmyk', comps: 4 }
    case 'Lab':
      return { kind: 'lab', comps: 3 }
    case 'ICCBased': {
      const stream = items[1]
      const n = stream instanceof PDFStream ? numberOf(get(stream.dict, 'N')) : undefined
      if (n === 1) return { kind: 'gray', comps: 1 }
      if (n === 3) return { kind: 'rgb', comps: 3 }
      if (n === 4) return { kind: 'cmyk', comps: 4 }
      const alt = stream instanceof PDFStream ? get(stream.dict, 'Alternate') : undefined
      return alt ? csInfo(ctx, alt, resources, depth + 1) : { kind: 'other', comps: n ?? 1 }
    }
    case 'Indexed':
    case 'I': {
      const base = csInfo(ctx, items[1], resources, depth + 1)
      const hival = numberOf(items[2]) ?? 0
      const lookupObj = items[3]
      const lookup = lookupObj instanceof PDFStream ? streamData(lookupObj) : stringBytes(lookupObj)
      return { kind: 'indexed', comps: 1, indexed: { base, hival, lookup: lookup ?? new Uint8Array() } }
    }
    case 'Separation':
      return { kind: 'sep', comps: 1 }
    case 'DeviceN': {
      const names = items[1]
      return { kind: 'sep', comps: names instanceof PDFArray ? Math.max(1, names.size()) : 1 }
    }
    default:
      return nameCs(family) ?? { kind: 'other', comps: 1 }
  }
}

const luminance = ([r, g, b]: Rgb) => 0.299 * r + 0.587 * g + 0.114 * b

function cmykOf([r, g, b]: Rgb): number[] {
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return [0, 0, 0, 1]
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k]
}

function rgbOfBase(base: CsInfo, comps: number[]): Rgb | undefined {
  if (base.kind === 'gray') return [comps[0], comps[0], comps[0]]
  if (base.kind === 'rgb') return [comps[0], comps[1], comps[2]]
  if (base.kind === 'cmyk') {
    const [c, m, y, k] = comps
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
  }
  return undefined
}

/** Color values (in the color space, before /Decode) closest to `fill`. */
function colorValues(cs: CsInfo, fill: Rgb): number[] {
  switch (cs.kind) {
    case 'gray':
      return [luminance(fill)]
    case 'rgb':
      return [...fill]
    case 'cmyk':
      return cmykOf(fill)
    case 'lab':
      return [luminance(fill) * 100, 0, 0]
    case 'sep':
      return new Array(cs.comps).fill(1 - luminance(fill))
    case 'indexed': {
      const { base, hival, lookup } = cs.indexed!
      let best = 0
      let bestDist = Infinity
      for (let i = 0; i <= hival; i++) {
        const comps = Array.from({ length: base.comps }, (_, c) => (lookup[i * base.comps + c] ?? 0) / 255)
        const rgb = rgbOfBase(base, comps)
        if (!rgb) break
        const d = (rgb[0] - fill[0]) ** 2 + (rgb[1] - fill[1]) ** 2 + (rgb[2] - fill[2]) ** 2
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      return [best]
    }
    default:
      return new Array(cs.comps).fill(0)
  }
}

/** Sample values that decode (through /Decode) to `values`. */
function toSamples(values: number[], decode: number[] | undefined, defaults: number[], bpc: number): number[] {
  const max = 2 ** bpc - 1
  return values.map((v, i) => {
    const d0 = decode?.[2 * i] ?? defaults[2 * i] ?? 0
    const d1 = decode?.[2 * i + 1] ?? defaults[2 * i + 1] ?? 1
    if (d1 === d0) return 0
    return Math.min(max, Math.max(0, Math.round(((v - d0) / (d1 - d0)) * max)))
  })
}

function decodeArray(ctx: PDFContext, dict: PDFDict): number[] | undefined {
  const d = get(dict, 'Decode')
  if (!(d instanceof PDFArray)) return undefined
  const nums = arrayItems(ctx, d).map((o) => numberOf(o))
  return nums.every((n) => n !== undefined) ? (nums as number[]) : undefined
}

// ---------------------------------------------------------------------------------------
// Painting

/** Polygon in unit image space (u right, v up; the image fills [0,1]²). */
export type UnitPolygon = Point[]

function clipBand(poly: Point[], y0: number, y1: number): Point[] {
  const clip = (pts: Point[], keep: (p: Point) => boolean, edge: number): Point[] => {
    const out: Point[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const ina = keep(a)
      const inb = keep(b)
      if (ina) out.push(a)
      if (ina !== inb && b.y !== a.y) {
        const t = (edge - a.y) / (b.y - a.y)
        out.push({ x: a.x + t * (b.x - a.x), y: edge })
      }
    }
    return out
  }
  return clip(clip(poly, (p) => p.y >= y0, y0), (p) => p.y <= y1, y1)
}

/** Set every pixel that overlaps one of the polygons (pixel space) to `samples`. Returns the count. */
function paint(s: Samples, polys: Point[][], samples: number[]): number {
  const rowBytes = Math.ceil((s.width * s.comps * s.bpc) / 8)
  let count = 0
  for (let row = 0; row < s.height; row++) {
    let c0 = Infinity
    let c1 = -Infinity
    for (const poly of polys) {
      const band = clipBand(poly, row, row + 1)
      if (band.length < 3) continue
      let minY = Infinity
      let maxY = -Infinity
      let minX = Infinity
      let maxX = -Infinity
      for (const p of band) {
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
      }
      if (maxY - minY < 1e-9 || maxX - minX < 1e-9) continue
      c0 = Math.min(c0, Math.floor(minX + 1e-9))
      c1 = Math.max(c1, Math.ceil(maxX - 1e-9) - 1)
    }
    const from = Math.max(0, c0)
    const to = Math.min(s.width - 1, c1)
    for (let col = from; col <= to; col++) {
      for (let c = 0; c < s.comps; c++) setSample(s, rowBytes, row, col, c, samples[c] ?? 0)
      count++
    }
  }
  return count
}

function setSample(s: Samples, rowBytes: number, row: number, col: number, comp: number, value: number): void {
  const index = col * s.comps + comp
  const base = row * rowBytes
  if (s.bpc === 8) {
    s.data[base + index] = value
  } else if (s.bpc === 16) {
    s.data[base + 2 * index] = (value >> 8) & 0xff
    s.data[base + 2 * index + 1] = value & 0xff
  } else {
    const bit = index * s.bpc
    const byte = base + (bit >> 3)
    const shift = 8 - s.bpc - (bit & 7)
    const mask = ((1 << s.bpc) - 1) << shift
    s.data[byte] = (s.data[byte] & ~mask) | ((value << shift) & mask)
  }
}

function toPixels(polys: UnitPolygon[], width: number, height: number): Point[][] {
  return polys.map((poly) => poly.map((p) => ({ x: p.x * width, y: (1 - p.y) * height })))
}

// ---------------------------------------------------------------------------------------
// Image XObjects

type Role = 'image' | 'smask' | 'mask'

function geometryOf(dict: PDFDict, cs: CsInfo | null, role: Role) {
  const width = numberOf(get(dict, 'Width')) ?? 0
  const height = numberOf(get(dict, 'Height')) ?? 0
  const imageMask = get(dict, 'ImageMask')
  const stencil = role === 'mask' || (imageMask instanceof PDFBool && imageMask.asBoolean())
  const bpc = stencil ? 1 : (numberOf(get(dict, 'BitsPerComponent')) ?? 8)
  const comps = stencil || role === 'smask' ? 1 : (cs?.comps ?? 1)
  return { width, height, bpc, comps, stencil }
}

function targetFor(ctx: PDFContext, dict: PDFDict, role: Role, cs: CsInfo | null, stencil: boolean, bpc: number, fill: Rgb): number[] {
  const decode = decodeArray(ctx, dict)
  if (stencil) {
    // Stencil masks (Decode [0 1]): 1 leaves the page unchanged; explicit masks: 0 paints the image.
    const paintValue = role === 'mask' ? 0 : 1
    const inverted = decode?.[0] === 1
    return [inverted ? 1 - paintValue : paintValue]
  }
  if (role === 'smask') return toSamples([1], decode, [0, 1], bpc)
  const info = cs ?? { kind: 'other' as const, comps: 1 }
  const defaults =
    info.kind === 'indexed'
      ? [0, 2 ** bpc - 1]
      : info.kind === 'lab'
        ? [0, 100, -100, 100, -100, 100]
        : new Array(info.comps * 2).fill(0).map((_, i) => (i % 2 ? 1 : 0))
  return toSamples(colorValues(info, fill), decode, defaults, bpc)
}

/**
 * A new image XObject: `xo` with the pixels under `polys` (unit image space) painted, encoded
 * with Flate. Its soft mask / explicit mask are redacted the same way.
 */
export async function redactImageXObject(
  ctx: PDFContext,
  xo: PDFStream,
  polys: UnitPolygon[],
  fill: Rgb,
  resources: PDFDict | undefined,
  role: Role = 'image'
): Promise<PDFRef> {
  const dict = xo.dict
  let encoded: Uint8Array
  let filters: Filter[]
  if (xo instanceof PDFRawStream) {
    encoded = xo.getContents()
    filters = filtersOf(ctx, dict)
  } else {
    const plain = streamData(xo)
    if (!plain) throw new UnsupportedImageError('image data could not be read')
    encoded = plain
    filters = []
  }
  const cs = role === 'image' ? csInfo(ctx, dict.get(N('ColorSpace')), resources) : null
  const geom = geometryOf(dict, cs, role)
  const samples = await decodeSamples(ctx, encoded, filters, geom)
  paint(samples, toPixels(polys, samples.width, samples.height), targetFor(ctx, dict, role, cs, geom.stencil, samples.bpc, fill))

  const out = ctx.flateStream(samples.data)
  for (const [key, value] of dict.entries()) if (!DROP_KEYS.has(key.decodeText())) out.dict.set(key, value)
  if (!geom.stencil || role === 'image') out.dict.set(N('BitsPerComponent'), PDFNumber.of(samples.bpc))
  if (role === 'mask') out.dict.set(N('BitsPerComponent'), PDFNumber.of(1))
  const smask = get(dict, 'SMask')
  if (role === 'image' && smask instanceof PDFStream) {
    out.dict.set(N('SMask'), await redactImageXObject(ctx, smask, polys, fill, resources, 'smask'))
  }
  const mask = dict.get(N('Mask'))
  const maskObj = resolve(ctx, mask)
  if (role === 'image' && maskObj instanceof PDFStream) {
    out.dict.set(N('Mask'), await redactImageXObject(ctx, maskObj, polys, fill, resources, 'mask'))
  } else if (role === 'image' && maskObj instanceof PDFArray) {
    out.dict.set(N('Mask'), maskObj)
  }
  if (getName(out.dict, 'Type') !== 'XObject') out.dict.set(N('Type'), N('XObject'))
  if (getName(out.dict, 'Subtype') !== 'Image') out.dict.set(N('Subtype'), N('Image'))
  return ctx.register(out)
}

// ---------------------------------------------------------------------------------------
// Inline images

const INLINE_KEYS: Record<string, string> = {
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  H: 'Height',
  IM: 'ImageMask',
  I: 'Interpolate',
  W: 'Width',
  L: 'Length'
}

const INLINE_CS: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' }

function toPdf(ctx: PDFContext, o: Operand, key?: string): PDFObject {
  if (typeof o === 'number') return PDFNumber.of(o)
  if (typeof o === 'boolean') return o ? PDFBool.True : PDFBool.False
  if (o instanceof PdfName) {
    const name = key === 'Filter' ? FILTER_ABBREV[o.name] ?? o.name : key === 'ColorSpace' ? INLINE_CS[o.name] ?? o.name : o.name
    return N(name)
  }
  if (o instanceof PdfStr) return PDFHexString.of(Array.from(o.bytes, (b) => b.toString(16).padStart(2, '0')).join(''))
  if (Array.isArray(o)) {
    const arr = ctx.obj([]) as PDFArray
    o.forEach((v, i) => arr.push(toPdf(ctx, v, key === 'ColorSpace' && i === 0 ? 'ColorSpace' : key === 'Filter' ? 'Filter' : undefined)))
    return arr
  }
  if (o instanceof PdfDictOp) {
    const d = ctx.obj({}) as PDFDict
    for (const [k, v] of o.map) d.set(N(INLINE_KEYS[k] ?? k), toPdf(ctx, v, INLINE_KEYS[k] ?? k))
    return d
  }
  return ctx.obj(null)
}

/**
 * An image XObject made from an inline image (`dict` and its encoded `data`) with the pixels
 * under `polys` painted. Named color spaces are resolved through `resources`.
 */
export async function redactInlineImage(
  ctx: PDFContext,
  inline: PdfDictOp,
  data: Uint8Array,
  polys: UnitPolygon[],
  fill: Rgb,
  resources: PDFDict | undefined
): Promise<PDFRef> {
  const dict = toPdf(ctx, inline) as PDFDict
  const cs = dict.get(N('ColorSpace'))
  if (cs instanceof PDFName && !nameCs(cs.decodeText())) {
    const named = getDict(resources, 'ColorSpace')?.get(cs)
    if (named) dict.set(N('ColorSpace'), named)
  }
  dict.set(N('Type'), N('XObject'))
  dict.set(N('Subtype'), N('Image'))
  return redactImageXObject(ctx, PDFRawStream.of(dict, data), polys, fill, resources)
}
