/**
 * The catalog's XMP packet (internal). When the user edits document properties, the matching
 * XMP properties are rewritten (viewers prefer XMP over the information dictionary); the rest
 * of the packet (document IDs, history, PDF/A identification, other schemas) is kept.
 * Text-based like stripPdfAIdentification: properties are found by the prefixes the packet
 * binds to their namespaces, as elements or as attributes of rdf:Description.
 */
import { PDFName, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument } from '@cantoo/pdf-lib'
import type { DocumentMetadata } from './model'

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const DC = 'http://purl.org/dc/elements/1.1/'
const PDF = 'http://ns.adobe.com/pdf/1.3/'
const XMP = 'http://ns.adobe.com/xap/1.0/'
/** Acrobat's namespace for custom properties. */
const PDFX = 'http://ns.adobe.com/pdfx/1.3/'
/** Prefix written for each namespace. */
const PREFIX: Record<string, string> = { [RDF]: 'rdf', [DC]: 'dc', [PDF]: 'pdf', [XMP]: 'xmp', [PDFX]: 'pdfx' }

type Kind = 'text' | 'date' | 'alt' | 'seq' | 'bag'
type TextKey = Exclude<keyof DocumentMetadata, 'custom'>

/** XMP properties of each information dictionary entry, as Acrobat writes them. */
const PROPERTIES: Record<TextKey, { ns: string; name: string; kind: Kind }[]> = {
  title: [{ ns: DC, name: 'title', kind: 'alt' }],
  author: [{ ns: DC, name: 'creator', kind: 'seq' }],
  subject: [{ ns: DC, name: 'description', kind: 'alt' }],
  keywords: [
    { ns: PDF, name: 'Keywords', kind: 'text' },
    { ns: DC, name: 'subject', kind: 'bag' }
  ],
  creator: [{ ns: XMP, name: 'CreatorTool', kind: 'text' }],
  producer: [{ ns: PDF, name: 'Producer', kind: 'text' }],
  creationDate: [{ ns: XMP, name: 'CreateDate', kind: 'date' }],
  modificationDate: [{ ns: XMP, name: 'ModifyDate', kind: 'date' }]
}

const N = (s: string) => PDFName.of(s)
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
/** Names usable as XML element names (custom property names that are not cannot go in XMP). */
const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u

function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Prefixes the packet binds to `ns`. */
function prefixesOf(xml: string, ns: string): string[] {
  const re = new RegExp(`xmlns:([\\w.-]+)\\s*=\\s*(["'])${reEscape(ns)}\\2`, 'g')
  return [...new Set([...xml.matchAll(re)].map((m) => m[1]))]
}

/** Remove property `name` (a regex source) of the namespace bound to `prefixes`: elements and attributes. */
function removeProperty(xml: string, prefixes: string[], name: string): string {
  for (const p of prefixes.map(reEscape)) {
    const element = new RegExp(`[ \\t]*<${p}:(${name})(?=[\\s/>])[^>]*?(?:/>|>[\\s\\S]*?</${p}:\\1\\s*>)[ \\t]*(?:\\r?\\n)?`, 'g')
    const attribute = new RegExp(`\\s+${p}:${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'g')
    xml = xml.replace(element, '').replace(attribute, '')
  }
  return xml
}

/** ISO 8601 for XMP, or undefined for an unparsable date. */
function xmpDate(value: string): string | undefined {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.000Z$/, 'Z')
}

function propertyXml(tag: string, kind: Kind, value: string): string | undefined {
  const li = (v: string, attrs = '') => `<rdf:li${attrs}>${xmlText(v)}</rdf:li>`
  switch (kind) {
    case 'text':
    case 'date':
      return `<${tag}>${xmlText(value)}</${tag}>`
    case 'alt':
      return `<${tag}><rdf:Alt>${li(value, ' xml:lang="x-default"')}</rdf:Alt></${tag}>`
    case 'seq':
      return `<${tag}><rdf:Seq>${li(value)}</rdf:Seq></${tag}>`
    case 'bag': {
      const items = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      return items.length ? `<${tag}><rdf:Bag>${items.map((s) => li(s)).join('')}</rdf:Bag></${tag}>` : undefined
    }
  }
}

/**
 * The packet with the overridden properties rewritten ('' removes them; custom replaces all
 * custom properties). Undefined when the packet has no rdf:RDF element to write into.
 */
export function updateXmpMetadata(xml: string, md: DocumentMetadata): string | undefined {
  const rdf = prefixesOf(xml, RDF)
  const rdfEnd = (text: string) => Math.max(-1, ...rdf.map((p) => text.lastIndexOf(`</${p}:RDF`)))
  if (rdfEnd(xml) < 0) return undefined
  const added: { ns: string; xml: string }[] = []
  for (const [key, properties] of Object.entries(PROPERTIES) as [TextKey, (typeof PROPERTIES)[TextKey]][]) {
    const value = md[key]
    if (value === undefined) continue
    for (const { ns, name, kind } of properties) {
      const text = kind === 'date' && value ? xmpDate(value) : value
      // An unparsable date leaves the entry as it is (like the information dictionary).
      if (text === undefined) continue
      xml = removeProperty(xml, prefixesOf(xml, ns), name)
      const property = text ? propertyXml(`${PREFIX[ns]}:${name}`, kind, text) : undefined
      if (property) added.push({ ns, xml: property })
    }
  }
  if (md.custom) {
    xml = removeProperty(xml, prefixesOf(xml, PDFX), '[^\\s/>=]+')
    for (const [name, value] of Object.entries(md.custom)) {
      if (XML_NAME.test(name)) added.push({ ns: PDFX, xml: `<pdfx:${name}>${xmlText(value)}</pdfx:${name}>` })
    }
  }
  if (!added.length) return xml
  // Same subject as the packet's other descriptions.
  const about = rdf.map((p) => xml.match(new RegExp(`\\s${reEscape(p)}:about\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))).find(Boolean)
  const subject = about?.[1] ?? about?.[2]?.replace(/"/g, '&quot;') ?? ''
  const namespaces = [RDF, ...new Set(added.map((a) => a.ns))].map((ns) => ` xmlns:${PREFIX[ns]}="${ns}"`).join('')
  const description = `  <rdf:Description rdf:about="${subject}"${namespaces}>\n${added.map((a) => `   ${a.xml}\n`).join('')}  </rdf:Description>\n`
  const at = rdfEnd(xml)
  return xml.slice(0, at) + description + xml.slice(at)
}

/** Text of the catalog's XMP packet; undefined if there is none or it is not UTF-8. */
export function readXmp(doc: PDFDocument): string | undefined {
  const stream = doc.context.lookup(doc.catalog.get(N('Metadata')))
  if (!(stream instanceof PDFRawStream)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(stream).decode())
  } catch {
    return undefined
  }
}

/** Replace the catalog's XMP packet, uncompressed (as PDF/A requires). */
export function writeXmp(doc: PDFDocument, xml: string): void {
  const stream = doc.context.stream(new TextEncoder().encode(xml), { Type: 'Metadata', Subtype: 'XML' })
  const ref = doc.catalog.get(N('Metadata'))
  if (ref instanceof PDFRef) doc.context.assign(ref, stream)
  else doc.catalog.set(N('Metadata'), doc.context.register(stream))
}

/**
 * Bring the catalog's XMP packet in line with the user's metadata overrides. A packet that
 * cannot be updated is removed, so viewers show the information dictionary instead.
 */
export function applyXmpMetadata(doc: PDFDocument, md: DocumentMetadata): void {
  if (!doc.catalog.get(N('Metadata'))) return
  const xml = readXmp(doc)
  const updated = xml === undefined ? undefined : updateXmpMetadata(xml, md)
  if (updated === undefined) doc.catalog.delete(N('Metadata'))
  else if (updated !== xml) writeXmp(doc, updated)
}
