import { beforeAll, describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream, type PDFPage } from '@cantoo/pdf-lib'
import { JpegImage } from 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs'
import { pdfFromContent, pdfjsImages } from './content/helpers'
import { registerTestFonts } from './helpers'
import { redact } from './redactionHelpers'

beforeAll(() => registerTestFonts())

const W = 24
const H = 16

/** RGB samples of a W×H gradient. */
function gradient(): Uint8Array {
  const out = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      out[i] = (x * 10) % 256
      out[i + 1] = (y * 15) % 256
      out[i + 2] = ((x + y) * 7) % 256
    }
  return out
}

/** PNG "Sub" predictor rows (filter type 1) for RGB samples. */
function pngSubRows(samples: Uint8Array): Uint8Array {
  const rowBytes = W * 3
  const out = new Uint8Array(H * (rowBytes + 1))
  for (let y = 0; y < H; y++) {
    out[y * (rowBytes + 1)] = 1
    for (let i = 0; i < rowBytes; i++) {
      const v = samples[y * rowBytes + i]
      const left = i >= 3 ? samples[y * rowBytes + i - 3] : 0
      out[y * (rowBytes + 1) + 1 + i] = (v - left) & 0xff
    }
  }
  return out
}

const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAGKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAYAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAv/aAAwDAQACEQMRAD8A/Lvw58KPu/uf0r3nw78KPu/uf0r668OfCj7v7n9K958O/Cj7v7n9K6+Hs721Pzfwu8ffh/eHyL4c+FH3f3P6V2v/AAqj/pj+lffOifC+G1h8+eMJGgySR0rd/wCEO0T+/wD+Q3/+Jr9Er+ImWYHlpY3F06cmr2nOMXba9m07XT18mf3pw547TlhYuMmz/9k='
  ),
  (c) => c.charCodeAt(0)
)

function decodeJpeg(bytes: Uint8Array): Uint8Array {
  const jpeg = new JpegImage()
  jpeg.parse(bytes)
  return Uint8Array.from(jpeg.getData({ width: W, height: H, isSourcePDF: true }))
}

/**
 * The image is drawn at (100, 100) 240×160 pt: one pixel = 10×10 pt. The area covers pixel
 * columns 5–9 and rows 3–7 (from the top) exactly.
 */
const AREA = { x: 150, y: 792 - 230, width: 50, height: 50 }
const inArea = (x: number, y: number) => x >= 5 && x <= 9 && y >= 3 && y <= 7

/** Image XObjects drawn on the page (name → stream). */
async function pageImages(bytes: Uint8Array, pageIndex = 0): Promise<{ pdf: PDFDocument; page: PDFPage; images: Map<string, PDFStream> }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const page = pdf.getPage(pageIndex)
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  const images = new Map<string, PDFStream>()
  for (const [name, ref] of xobjects?.entries() ?? []) {
    const xo = pdf.context.lookup(ref)
    if (xo instanceof PDFStream && xo.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) images.set(name.decodeText(), xo)
  }
  return { pdf, page, images }
}

function samplesOf(stream: PDFStream): Uint8Array {
  return decodePDFRawStream(stream as PDFRawStream).decode()
}

function expectRedactedRgb(after: Uint8Array, before: Uint8Array, comps = 3): void {
  expect(after.length).toBe(before.length)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < comps; c++) {
        const i = (y * W + x) * comps + c
        if (inArea(x, y)) expect(after[i]).toBe(0)
        else if (after[i] !== before[i]) throw new Error(`pixel ${x},${y} changed outside the area`)
      }
}

async function imagePdf(setup: (doc: PDFDocument, page: PDFPage) => Promise<void>, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  await setup(doc, doc.getPage(0))
  return doc.save()
}

describe('redacting images', () => {
  it('paints the pixels of a Flate image with a PNG predictor; pixels outside stay identical', async () => {
    const samples = gradient()
    const bytes = await imagePdf(async (doc, page) => {
      const stream = PDFRawStream.of(
        doc.context.obj({
          Type: 'XObject',
          Subtype: 'Image',
          Width: W,
          Height: H,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: 3, Columns: W }
        }),
        deflateSync(pngSubRows(samples))
      )
      page.node.setXObject(PDFName.of('Im1'), doc.context.register(stream))
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q 240 0 0 160 100 100 cm /Im1 Do Q')))
    })
    const out = await redact(bytes, [AREA])
    const { images } = await pageImages(out)
    expect(images.size).toBe(1)
    const [img] = images.values()
    expect(img.dict.lookup(PDFName.of('DecodeParms'))).toBeUndefined()
    expectRedactedRgb(samplesOf(img), samples)
    // The original image is not kept in the file.
    const { pdf } = await pageImages(out)
    const allImages = pdf.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFStream && o.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'))
    expect(allImages.length).toBe(1)
    // Still drawn in the same place.
    const drawn = await pdfjsImages(out)
    expect(drawn.map((d) => d.transform)).toEqual([[240, 0, 0, 160, 100, 100]])
  })

  it('decodes JPEG (DCT) images, paints the area and re-encodes them losslessly', async () => {
    const before = decodeJpeg(JPEG)
    const bytes = await imagePdf(async (doc, page) => {
      const img = await doc.embedJpg(JPEG)
      page.drawImage(img, { x: 100, y: 100, width: 240, height: 160 })
    })
    const out = await redact(bytes, [AREA])
    const { images } = await pageImages(out)
    expect(images.size).toBe(1)
    const [img] = images.values()
    expect(img.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'))
    expectRedactedRgb(samplesOf(img), before)
  })

  it('redacts the soft mask of an image with transparency as well', async () => {
    // 2×2 RGBA PNG, alpha 128 64 / 200 32.
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGP4z8DQwPCfwYGBgeH/if//GRQAN3AGpA3PCfMAAAAASUVORK5CYII='),
      (c) => c.charCodeAt(0)
    )
    const bytes = await imagePdf(async (doc, page) => {
      const img = await doc.embedPng(png)
      page.drawImage(img, { x: 100, y: 100, width: 200, height: 200 })
    })
    // Covers the left column of pixels (x 100..200).
    const out = await redact(bytes, [{ x: 100, y: 792 - 300, width: 100, height: 200 }])
    const { images, pdf } = await pageImages(out)
    const [img] = images.values()
    const smask = pdf.context.lookup(img.dict.get(PDFName.of('SMask')))
    expect(smask).toBeInstanceOf(PDFStream)
    const alpha = samplesOf(smask as PDFStream)
    // Left pixels opaque (255), right column keeps its original alpha.
    expect([...alpha]).toEqual([255, 64, 255, 32])
  })

  it('removes an image that is completely covered', async () => {
    const bytes = await imagePdf(async (doc, page) => {
      const img = await doc.embedJpg(JPEG)
      page.drawImage(img, { x: 100, y: 100, width: 240, height: 160 })
    })
    const out = await redact(bytes, [{ x: 90, y: 792 - 270, width: 260, height: 180 }])
    expect((await pageImages(out)).images.size).toBe(0)
    expect(await pdfjsImages(out)).toEqual([])
  })

  it('gives an image shared with another page a private copy', async () => {
    const samples = gradient()
    const bytes = await imagePdf(async (doc) => {
      const stream = doc.context.flateStream(samples, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })
      const ref = doc.context.register(stream)
      for (const page of doc.getPages()) {
        page.node.setXObject(PDFName.of('Im1'), ref)
        page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q 240 0 0 160 100 100 cm /Im1 Do Q')))
      }
    }, 2)
    const out = await redact(bytes, [AREA])
    const first = await pageImages(out, 0)
    const second = await pageImages(out, 1)
    const [a] = first.images.values()
    const [b] = second.images.values()
    expectRedactedRgb(samplesOf(a), samples)
    expect(samplesOf(b)).toEqual(samples)
  })

  it('converts a partly covered inline image and paints its pixels', async () => {
    // 4×2 gray inline image, drawn 40×20 pt at (100, 700): pixels 10 pt wide.
    const hex = '1020304050607080'
    const bytes = await pdfFromContent(`q 40 0 0 20 100 700 cm BI /W 4 /H 2 /CS /G /BPC 8 /F /AHx ID ${hex}> EI Q`)
    const out = await redact(bytes, [{ x: 100, y: 792 - 720, width: 20, height: 10 }])
    const { images } = await pageImages(out)
    expect(images.size).toBe(1)
    const [img] = images.values()
    expect([...samplesOf(img)]).toEqual([0, 0, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80])
  })
})
