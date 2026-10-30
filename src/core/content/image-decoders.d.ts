/** The part of pdf.js' standalone image decoders used by the redaction engine (pure JS JPEG decoder). */
declare module 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs' {
  export class JpegImage {
    constructor(options?: { decodeTransform?: Int32Array | null; colorTransform?: number })
    width: number
    height: number
    numComponents: number
    parse(data: Uint8Array, options?: { dnlScanLines?: number | null }): void
    getData(options: {
      width: number
      height: number
      forceRGB?: boolean
      forceRGBA?: boolean
      isSourcePDF?: boolean
    }): Uint8Array | Uint8ClampedArray
  }
}
