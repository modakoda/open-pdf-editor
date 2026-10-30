/**
 * Color spaces and colors as tracked by the interpreter, with conversion to "#rrggbb" when
 * the color space allows it (Gray, RGB, CMYK, ICCBased, Cal*, Indexed, Separation/DeviceN
 * with exponential tint transforms).
 */
import { PDFArray, PDFDict, PDFName, PDFStream, type PDFContext, type PDFObject } from '@cantoo/pdf-lib'
import { arrayItems, get, getNumber, nameOf, numberArray, numberOf, resolve, stringBytes, streamData } from './pdfobj'

export type ColorFamily = 'gray' | 'rgb' | 'cmyk' | 'indexed' | 'pattern' | 'tint' | 'other'

export interface ColorSpaceInfo {
  family: ColorFamily
  /** Number of color components. */
  n: number
  /** Indexed: base space + palette; tint: alternate space + C0/C1/N of a type 2 function. */
  base?: ColorSpaceInfo
  palette?: Uint8Array
  hival?: number
  tint?: { c0: number[]; c1: number[]; n: number }
}

export interface ColorState {
  /** Operand of cs/CS (device name or resource name). */
  space: string
  /** Set with g/rg/k (or the initial state): re-emitted with those operators. */
  device: boolean
  info: ColorSpaceInfo
  comps: number[]
  /** Pattern name (scn with a name operand). */
  pattern?: string
  /**
   * Inherited from the content that drew a form XObject: 'all' = color space and color are the
   * inherited ones; 'space' = only the color space (its name belongs to the parent's resources).
   */
  inherited?: 'all' | 'space'
}

const GRAY: ColorSpaceInfo = { family: 'gray', n: 1 }
const RGB: ColorSpaceInfo = { family: 'rgb', n: 3 }
const CMYK: ColorSpaceInfo = { family: 'cmyk', n: 4 }
const PATTERN: ColorSpaceInfo = { family: 'pattern', n: 0 }
const OTHER = (n: number): ColorSpaceInfo => ({ family: 'other', n })

export const INITIAL_COLOR: ColorState = { space: 'DeviceGray', device: true, info: GRAY, comps: [0] }

export function deviceColor(kind: 'g' | 'rg' | 'k', comps: number[]): ColorState {
  if (kind === 'g') return { space: 'DeviceGray', device: true, info: GRAY, comps }
  if (kind === 'rg') return { space: 'DeviceRGB', device: true, info: RGB, comps }
  return { space: 'DeviceCMYK', device: true, info: CMYK, comps }
}

function deviceByName(name: string): ColorSpaceInfo | undefined {
  switch (name) {
    case 'DeviceGray':
    case 'G':
    case 'CalGray':
      return GRAY
    case 'DeviceRGB':
    case 'RGB':
    case 'CalRGB':
      return RGB
    case 'DeviceCMYK':
    case 'CMYK':
      return CMYK
    case 'Pattern':
      return PATTERN
    default:
      return undefined
  }
}

const cache = new WeakMap<object, ColorSpaceInfo>()

/** Resolve a color space object (name already looked up in /ColorSpace, or an array). */
export function colorSpaceInfo(ctx: PDFContext, obj: PDFObject | undefined, depth = 0): ColorSpaceInfo {
  const o = resolve(ctx, obj)
  if (o instanceof PDFName) return deviceByName(o.decodeText()) ?? OTHER(1)
  if (!(o instanceof PDFArray) || depth > 4) return OTHER(1)
  const cached = cache.get(o)
  if (cached) return cached
  const items = arrayItems(ctx, o)
  const fam = nameOf(items[0])
  let info: ColorSpaceInfo
  switch (fam) {
    case 'ICCBased': {
      const s = items[1]
      const n = s instanceof PDFStream ? (getNumber(s.dict, 'N') ?? 3) : 3
      info = n === 1 ? GRAY : n === 4 ? CMYK : n === 3 ? RGB : OTHER(n)
      break
    }
    case 'CalGray':
    case 'DeviceGray':
      info = GRAY
      break
    case 'CalRGB':
    case 'DeviceRGB':
      info = RGB
      break
    case 'DeviceCMYK':
      info = CMYK
      break
    case 'Lab':
      info = OTHER(3)
      break
    case 'Indexed':
    case 'I': {
      const base = colorSpaceInfo(ctx, items[1], depth + 1)
      const hival = numberOf(items[2]) ?? 255
      const lk = items[3]
      const palette = lk instanceof PDFStream ? streamData(lk) : stringBytes(lk)
      info = { family: 'indexed', n: 1, base, hival, palette }
      break
    }
    case 'Pattern':
      info = PATTERN
      break
    case 'Separation':
    case 'DeviceN': {
      const names = items[1]
      const n = fam === 'Separation' ? 1 : names instanceof PDFArray ? names.size() : 1
      const base = colorSpaceInfo(ctx, items[2], depth + 1)
      const fn = items[3]
      const fdict = fn instanceof PDFDict ? fn : fn instanceof PDFStream ? fn.dict : undefined
      let tint: ColorSpaceInfo['tint']
      if (fdict && getNumber(fdict, 'FunctionType') === 2 && n === 1) {
        const c0 = numberArray(ctx, get(fdict, 'C0') as PDFArray | undefined) ?? [0]
        const c1 = numberArray(ctx, get(fdict, 'C1') as PDFArray | undefined) ?? [1]
        tint = { c0, c1, n: getNumber(fdict, 'N') ?? 1 }
      }
      info = { family: 'tint', n, base, tint }
      break
    }
    default:
      info = OTHER(1)
  }
  cache.set(o, info)
  return info
}

/** Initial color of a color space (set by cs/CS). */
export function initialComps(info: ColorSpaceInfo): number[] {
  switch (info.family) {
    case 'gray':
      return [0]
    case 'rgb':
      return [0, 0, 0]
    case 'cmyk':
      return [0, 0, 0, 1]
    case 'indexed':
      return [0]
    case 'pattern':
      return []
    case 'tint':
      return new Array(info.n).fill(1)
    default:
      return new Array(info.n).fill(0)
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

function toRgb(info: ColorSpaceInfo, comps: number[], depth = 0): [number, number, number] | undefined {
  if (depth > 4) return undefined
  switch (info.family) {
    case 'gray': {
      const g = clamp01(comps[0] ?? 0)
      return [g, g, g]
    }
    case 'rgb':
      return [clamp01(comps[0] ?? 0), clamp01(comps[1] ?? 0), clamp01(comps[2] ?? 0)]
    case 'cmyk': {
      const [c, m, y, k] = [0, 1, 2, 3].map((i) => clamp01(comps[i] ?? 0))
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
    }
    case 'indexed': {
      if (!info.base || !info.palette) return undefined
      const idx = Math.max(0, Math.min(info.hival ?? 255, Math.round(comps[0] ?? 0)))
      const n = info.base.n
      const start = idx * n
      if (start + n > info.palette.length) return undefined
      const base: number[] = []
      for (let i = 0; i < n; i++) base.push(info.palette[start + i] / 255)
      return toRgb(info.base, base, depth + 1)
    }
    case 'tint': {
      if (!info.tint || !info.base) return undefined
      const t = clamp01(comps[0] ?? 1)
      const { c0, c1, n } = info.tint
      const f = Math.pow(t, n)
      const out = c0.map((v, i) => v + f * ((c1[i] ?? v) - v))
      return toRgb(info.base, out, depth + 1)
    }
    default:
      return undefined
  }
}

export function colorHex(c: ColorState): string | undefined {
  if (c.pattern) return undefined
  const rgb = toRgb(c.info, c.comps)
  if (!rgb) return undefined
  return '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

/** "#rrggbb" → [r, g, b] in 0..1 (invalid → black). */
export function parseHex(color: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color ?? '').trim())
  if (!m) return [0, 0, 0]
  let hex = m[1]
  if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch)
  const n = parseInt(hex, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
