import { describe, expect, it } from 'vitest'
import { CMap, ToUnicodeMap } from '../../../src/core/content/cmap'
import { PdfDictOp, PdfName, PdfStr, parseContent } from '../../../src/core/content/lexer'
import { fmt, writeName, writeOperand, writeLiteralBytes } from '../../../src/core/content/serialize'
import { latin1 } from './helpers'

const text = (s: PdfStr) => String.fromCharCode(...s.bytes)

describe('content stream tokenizer', () => {
  it('parses numbers, names, booleans, null and operators', () => {
    const ops = parseContent(latin1('1 -2 +3.5 .5 -.25 4. --7 1e2 /Name /A#20B true false null op'))
    expect(ops).toHaveLength(1)
    const [op] = ops
    expect(op.op).toBe('op')
    expect(op.args.slice(0, 8)).toEqual([1, -2, 3.5, 0.5, -0.25, 4, -7, 100])
    expect((op.args[8] as PdfName).name).toBe('Name')
    expect((op.args[9] as PdfName).name).toBe('A B')
    expect(op.args.slice(10)).toEqual([true, false, null])
  })

  it('parses literal strings with nesting, escapes, octal and line continuations', () => {
    const src = '(a (nested) b) Tj (esc \\n\\r\\t\\b\\f\\(\\)\\\\ \\101\\7\\0123) Tj (line\\\ncont) Tj (cr\r\nlf) Tj'
    const ops = parseContent(latin1(src))
    expect(ops.map((o) => o.op)).toEqual(['Tj', 'Tj', 'Tj', 'Tj'])
    expect(text(ops[0].args[0] as PdfStr)).toBe('a (nested) b')
    expect(text(ops[1].args[0] as PdfStr)).toBe('esc \n\r\t\b\f()\\ A\x07\n3')
    expect(text(ops[2].args[0] as PdfStr)).toBe('linecont')
    expect(text(ops[3].args[0] as PdfStr)).toBe('cr\nlf')
  })

  it('parses hex strings (whitespace, odd length)', () => {
    const [op] = parseContent(latin1('<48 65 6c6C 6> Tj'))
    const s = op.args[0] as PdfStr
    expect(s.hex).toBe(true)
    expect(Array.from(s.bytes)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x60])
  })

  it('parses arrays and dictionaries (nested)', () => {
    const [tj, bdc] = parseContent(latin1('[(a) -120 (b) [1 2]] TJ /Span <</MCID 3 /Alt (x) /D <</K [1 /N]>>>> BDC'))
    expect(tj.op).toBe('TJ')
    const arr = tj.args[0] as unknown[]
    expect(arr).toHaveLength(4)
    expect(arr[1]).toBe(-120)
    expect(arr[3]).toEqual([1, 2])
    expect(bdc.op).toBe('BDC')
    const dict = bdc.args[1] as PdfDictOp
    expect(dict.get('MCID')).toBe(3)
    expect(text(dict.get('Alt') as PdfStr)).toBe('x')
    const inner = dict.get('D') as PdfDictOp
    expect((inner.get('K') as unknown[])[0]).toBe(1)
  })

  it('skips comments and keeps exact byte ranges of operators', () => {
    const src = '% header\nq 1 0 0 1 10 20 cm % move\n/F1 12 Tf\nQ'
    const data = latin1(src)
    const ops = parseContent(data)
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Tf', 'Q'])
    const slice = (i: number) => src.slice(ops[i].start, ops[i].end)
    expect(slice(0)).toBe('q')
    expect(slice(1)).toBe('1 0 0 1 10 20 cm')
    expect(slice(2)).toBe('/F1 12 Tf')
    expect(slice(3)).toBe('Q')
  })

  it('tolerates garbage: stray delimiters, unknown keywords, unterminated constructs', () => {
    const ops = parseContent(latin1('] } ) >> foo 1 2 bar q 0 0 1 rg (unterminated'))
    expect(ops.map((o) => o.op)).toEqual(['foo', 'bar', 'q', 'rg'])
    expect(ops[1].args).toEqual([1, 2])
    expect(() => parseContent(latin1('[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[['))).not.toThrow()
    expect(parseContent(latin1('<</A'))).toEqual([])
  })

  it('finds the end of binary inline image data containing "EI"', () => {
    const bin = String.fromCharCode(0x20, 0x45, 0x49, 0x20, 0xff, 0x00, 0x10, 0x45, 0x49, 0x0a, 0x80, 0x81)
    const src = `q BI /W 2 /H 2 /BPC 8 /CS /RGB ID ${bin} EI Q (x) Tj`
    const data = latin1(src)
    const ops = parseContent(data)
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'Tj'])
    const bi = ops[1]
    expect(bi.image!.dataEnd - bi.image!.dataStart).toBe(12)
    expect(src.slice(bi.start, bi.end).endsWith('EI')).toBe(true)
  })

  it('uses /L, filter end markers and the plausibility scan for inline images', () => {
    // /L (length) with data that looks like "EI Q" inside.
    const d1 = 'ab EI Q cd'
    const ops1 = parseContent(latin1(`BI /W 10 /H 1 /BPC 8 /CS /G /F /Fl /L ${d1.length} ID ${d1} EI Q`))
    expect(ops1.map((o) => o.op)).toEqual(['BI', 'Q'])
    expect(ops1[0].image!.dataEnd - ops1[0].image!.dataStart).toBe(d1.length)
    // ASCIIHex: ends at '>'.
    const ops2 = parseContent(latin1('BI /W 2 /H 1 /BPC 8 /CS /G /F /AHx ID 00 FF> EI 1 0 0 rg'))
    expect(ops2.map((o) => o.op)).toEqual(['BI', 'rg'])
    // Generic: an "EI" followed by binary bytes is not the end.
    const bin = 'xx EI \u0000\u0001\u0002 yy'
    const ops3 = parseContent(latin1(`BI /W 1 /H 1 /F /Fl ID ${bin} EI Q`))
    expect(ops3.map((o) => o.op)).toEqual(['BI', 'Q'])
    expect(ops3[0].image!.dataEnd - ops3[0].image!.dataStart).toBe(bin.length)
  })

  it('parses 50k operators quickly', () => {
    const parts: string[] = []
    for (let i = 0; i < 10000; i++) parts.push(`BT /F1 8 Tf ${i % 500} ${i % 700} Td [(Row ${i}) -200 (x)] TJ ET`)
    const data = latin1(parts.join('\n'))
    const t0 = performance.now()
    const ops = parseContent(data)
    const ms = performance.now() - t0
    expect(ops.length).toBe(50000)
    expect(ms).toBeLessThan(1000)
  })
})

describe('serializer', () => {
  it('writes numbers, names, strings and arrays', () => {
    expect(fmt(1.5)).toBe('1.5')
    expect(fmt(-0.0000001)).toBe('0')
    expect(fmt(1e21)).toBe('1000000000000000000000')
    expect(fmt(1 / 3, 4)).toBe('0.3333')
    expect(writeName('A B/#')).toBe('/A#20B#2f#23')
    expect(writeLiteralBytes(latin1('a(b)\\\né'))).toBe('(a\\(b\\)\\\\\\n\\351)')
    expect(writeOperand([new PdfStr(latin1('x'), true), -12.5, new PdfName('N')])).toBe('[<78> -12.5 /N]')
  })

  it('round-trips through the parser', () => {
    const operands = [[new PdfStr(latin1('a(b)c\\'), false), 120, new PdfStr(latin1('\u0000ÿ'), true)], new PdfName('F#1')]
    const src = operands.map(writeOperand).join(' ') + ' op'
    const [op] = parseContent(latin1(src))
    expect(text((op.args[0] as PdfStr[])[0])).toBe('a(b)c\\')
    expect(Array.from(((op.args[0] as PdfStr[])[2]).bytes)).toEqual([0, 255])
    expect((op.args[1] as PdfName).name).toBe('F#1')
  })
})

describe('CMaps', () => {
  it('reads codespace ranges of mixed lengths and CID ranges', () => {
    const cmap = CMap.parse(
      latin1(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange
2 begincidrange <20> <7E> 1 <8140> <817F> 1000 endcidrange
1 begincidchar <8200> 5000 endcidchar
endcmap end end`)
    )
    const bytes = new Uint8Array([0x41, 0x81, 0x41, 0x82, 0x00])
    const a = cmap.readCode(bytes, 0)
    expect(a).toEqual({ code: 0x41, len: 1 })
    const b = cmap.readCode(bytes, 1)
    expect(b).toEqual({ code: 0x8141, len: 2 })
    const c = cmap.readCode(bytes, 3)
    expect(c).toEqual({ code: 0x8200, len: 2 })
    expect(cmap.cid(0x41)).toBe(0x41 - 0x20 + 1)
    expect(cmap.cid(0x8141)).toBe(1001)
    expect(cmap.cid(0x8200)).toBe(5000)
    expect(cmap.codeForCid(1001)).toBe(0x8141)
  })

  it('detects vertical writing mode and usecmap Identity', () => {
    const cmap = CMap.parse(latin1('/WMode 1 def /Identity-V usecmap begincmap endcmap'))
    expect(cmap.vertical).toBe(true)
    expect(cmap.cid(0x1234)).toBe(0x1234)
    expect(cmap.readCode(new Uint8Array([0x12, 0x34]), 0)).toEqual({ code: 0x1234, len: 2 })
  })

  it('reads ToUnicode bfchar and bfrange (incl. arrays, ligatures, surrogates)', () => {
    const m = ToUnicodeMap.parse(
      latin1(`begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar <0001> <0041> <0002> <00660069> <0003> <D835DC00> endbfchar
2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<0105> <010D>] endbfrange
1 beginbfrange <1000> <2000> <4E00> endbfrange
endcmap`)
    )
    expect(m.get(1)).toBe('A')
    expect(m.get(2)).toBe('fi')
    expect(m.get(3)).toBe('\u{1D400}')
    expect(m.get(0x11)).toBe('b')
    expect(m.get(0x20)).toBe('ą')
    expect(m.get(0x21)).toBe('č')
    expect(m.get(0x1005)).toBe('丅')
    expect(m.get(0x3000)).toBeUndefined()
    expect(m.codeFor('č')).toBe(0x21)
    expect(m.codeFor('丅')).toBe(0x1005)
  })
})
