/**
 * Small helpers for reading pdf-lib objects defensively (malformed files are common).
 */
import {
  PDFArray,
  PDFBool,
  PDFContentStream,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject
} from '@cantoo/pdf-lib'
import type { Matrix } from '../model'

const nameCache = new Map<string, PDFName>()
export function N(name: string): PDFName {
  let n = nameCache.get(name)
  if (!n) {
    n = PDFName.of(name)
    nameCache.set(name, n)
  }
  return n
}

export function resolve(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  let o = obj
  for (let i = 0; i < 8 && o instanceof PDFRef; i++) o = ctx.lookup(o)
  return o instanceof PDFRef ? undefined : o
}

/** dict[key], with references resolved; never throws. */
export function get(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined
  try {
    return resolve(dict.context, dict.get(N(key)))
  } catch {
    return undefined
  }
}

export function getDict(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  const v = get(dict, key)
  if (v instanceof PDFDict) return v
  if (v instanceof PDFStream) return v.dict
  return undefined
}

export function getStream(dict: PDFDict | undefined, key: string): PDFStream | undefined {
  const v = get(dict, key)
  return v instanceof PDFStream ? v : undefined
}

export function getArray(dict: PDFDict | undefined, key: string): PDFArray | undefined {
  const v = get(dict, key)
  return v instanceof PDFArray ? v : undefined
}

export function numberOf(o: PDFObject | undefined): number | undefined {
  if (o instanceof PDFNumber) {
    const n = o.asNumber()
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function getNumber(dict: PDFDict | undefined, key: string): number | undefined {
  return numberOf(get(dict, key))
}

export function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined
}

export function getName(dict: PDFDict | undefined, key: string): string | undefined {
  return nameOf(get(dict, key))
}

export function getBool(dict: PDFDict | undefined, key: string): boolean | undefined {
  const v = get(dict, key)
  return v instanceof PDFBool ? v.asBoolean() : undefined
}

export function arrayItems(ctx: PDFContext, arr: PDFArray | undefined): PDFObject[] {
  if (!arr) return []
  const out: PDFObject[] = []
  for (let i = 0; i < arr.size(); i++) out.push(resolve(ctx, arr.get(i)) as PDFObject)
  return out
}

export function numberArray(ctx: PDFContext, arr: PDFArray | undefined): number[] | undefined {
  if (!arr) return undefined
  const out: number[] = []
  for (const o of arrayItems(ctx, arr)) {
    const n = numberOf(o)
    if (n === undefined) return undefined
    out.push(n)
  }
  return out
}

export function getMatrix(dict: PDFDict | undefined, key: string): Matrix | undefined {
  const arr = getArray(dict, key)
  const nums = arr ? numberArray(dict!.context, arr) : undefined
  return nums && nums.length === 6 ? (nums as Matrix) : undefined
}

export function stringBytes(o: PDFObject | undefined): Uint8Array | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes()
  return undefined
}

/** Decoded bytes of a stream; undefined if it cannot be decoded. */
export function streamData(stream: PDFStream | undefined): Uint8Array | undefined {
  if (!stream) return undefined
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode()
    if (stream instanceof PDFContentStream) return stream.getUnencodedContents()
    const s = stream as unknown as { getUnencodedContents?: () => Uint8Array }
    if (typeof s.getUnencodedContents === 'function') return s.getUnencodedContents()
    return stream.getContents()
  } catch {
    return undefined
  }
}

/** A stable identity for an object: its ref when indirect, else the object itself. */
export function identityOf(ref: PDFObject | undefined, obj: PDFObject | undefined): object | undefined {
  if (ref instanceof PDFRef) return ref
  return obj
}
