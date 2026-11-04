import { describe, expect, it } from 'vitest'
import { updateXmpMetadata } from '../../src/core/xmp'

const PACKET = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreateDate>2020-01-02T03:04:05Z</xmp:CreateDate>
   <xmp:ModifyDate>2021-02-03T04:05:06Z</xmp:ModifyDate>
   <xmp:CreatorTool>Word</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jonas</rdf:li></rdf:Seq></dc:creator>
   <dc:subject><rdf:Bag><rdf:li>a</rdf:li><rdf:li>b</rdf:li></rdf:Bag></dc:subject>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="Acrobat Distiller" pdf:Keywords="a, b"/>
  <rdf:Description rdf:about="" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">
   <xmpMM:DocumentID>uuid:1234</xmpMM:DocumentID>
   <pdfaid:part>2</pdfaid:part>
   <pdfx:Company>ACME</pdfx:Company>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`

const count = (s: string, part: string) => s.split(part).length - 1

describe('updateXmpMetadata', () => {
  it('rewrites only the edited properties', () => {
    const xml = updateXmpMetadata(PACKET, { title: 'New & <improved>', producer: 'Me', modificationDate: '2025-01-02T03:04:05.000Z' })!
    expect(xml).toContain('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">New &amp; &lt;improved&gt;</rdf:li></rdf:Alt></dc:title>')
    expect(xml).toContain('<pdf:Producer>Me</pdf:Producer>')
    expect(xml).toContain('<xmp:ModifyDate>2025-01-02T03:04:05Z</xmp:ModifyDate>')
    for (const gone of ['Original', 'Acrobat Distiller', '2021-02-03']) expect(xml).not.toContain(gone)
    expect(count(xml, '<dc:title>')).toBe(1)
    // Everything else as it was.
    for (const kept of [
      '<xmp:CreateDate>2020-01-02T03:04:05Z</xmp:CreateDate>',
      '<xmp:CreatorTool>Word</xmp:CreatorTool>',
      '<dc:creator><rdf:Seq><rdf:li>Jonas</rdf:li></rdf:Seq></dc:creator>',
      'pdf:Keywords="a, b"',
      '<xmpMM:DocumentID>uuid:1234</xmpMM:DocumentID>',
      '<pdfaid:part>2</pdfaid:part>',
      '<pdfx:Company>ACME</pdfx:Company>',
      '<?xpacket end="w"?>'
    ]) {
      expect(xml).toContain(kept)
    }
    // Written inside rdf:RDF.
    expect(xml.indexOf('<pdf:Producer>')).toBeLessThan(xml.indexOf('</rdf:RDF>'))
  })

  it('removes cleared properties and replaces custom ones', () => {
    const xml = updateXmpMetadata(PACKET, { author: '', keywords: '', custom: { Department: 'Legal', 'Not a name': 'x' } })!
    for (const gone of ['Jonas', 'pdf:Keywords', 'dc:subject', 'ACME', 'Not a name']) expect(xml).not.toContain(gone)
    expect(xml).toContain('<pdfx:Department>Legal</pdfx:Department>')
    expect(xml).toContain('xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"')
    expect(xml).toContain('pdf:Producer="Acrobat Distiller"')
  })

  it('writes keywords as text and as a list', () => {
    const xml = updateXmpMetadata(PACKET, { keywords: 'one, two; three' })!
    expect(xml).toContain('<pdf:Keywords>one, two; three</pdf:Keywords>')
    expect(xml).toContain('<dc:subject><rdf:Bag><rdf:li>one</rdf:li><rdf:li>two</rdf:li><rdf:li>three</rdf:li></rdf:Bag></dc:subject>')
    expect(count(xml, 'dc:subject>')).toBe(2)
  })

  it('finds properties by the prefixes the packet uses', () => {
    const old = PACKET.replace('xmlns:xmp=', 'xmlns:xap=').replace(/xmp:(\w+)>/g, 'xap:$1>').replace(/<xmp:/g, '<xap:')
    const xml = updateXmpMetadata(old, { creator: 'Pages' })!
    expect(xml).not.toContain('<xap:CreatorTool>')
    expect(xml).toContain('<xmp:CreatorTool>Pages</xmp:CreatorTool>')
    expect(xml).toContain('<xap:CreateDate>2020-01-02T03:04:05Z</xap:CreateDate>')
  })

  it('leaves unparsable dates and gives up without rdf:RDF', () => {
    expect(updateXmpMetadata(PACKET, { creationDate: 'not a date' })).toBe(PACKET)
    expect(updateXmpMetadata('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', { title: 'T' })).toBeUndefined()
  })
})
