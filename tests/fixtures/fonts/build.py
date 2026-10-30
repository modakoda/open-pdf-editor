"""
Builds the tiny CJK test fonts in this folder from the upstream Noto fonts (SIL OFL 1.1).
See README.md for sources. Requires fontTools (pip install fonttools==4.60.1):

    python build.py NotoSansSC[wght].ttf NotoSansJP-Regular.otf
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.ttCollection import TTCollection
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))

ASCII = ''.join(chr(c) for c in range(0x20, 0x7F))
HAN = '你好世界中文测试汉字字体漢語日本語简体繁體这是一段第页共王小明编辑器'
KANA = 'こんにちはひらがなカタカナ'
PUNCT = '　、。，．！？：；「」『』（）《》・ー…〜'
TEXT = ASCII + HAN + KANA + PUNCT


def rename(font: TTFont, family: str, style: str) -> None:
    ps = f"{family.replace(' ', '')}-{style}"
    name = font['name']
    for record in list(name.names):
        if record.nameID in (1, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=record.nameID)
    for nid, value in ((1, family), (2, style), (3, f'{ps};test subset'), (4, f'{family} {style}'), (6, ps)):
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    if 'CFF ' in font:
        cff = font['CFF '].cff
        cff.fontNames = [ps]
        top = cff.topDictIndex[0]
        top.FullName = f'{family} {style}'
        top.FamilyName = family
    font['OS/2'].usWeightClass = 700 if style == 'Bold' else 400
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~0b1100001) | (0b100000 if style == 'Bold' else 0b1000000)
    font['head'].macStyle = 1 if style == 'Bold' else 0


def make_subset(font: TTFont, text: str) -> TTFont:
    options = subset.Options()
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.hinting = False
    options.drop_tables += ['BASE', 'STAT', 'vhea', 'vmtx', 'VORG', 'gasp', 'DSIG']
    options.notdef_outline = True
    sub = subset.Subsetter(options)
    sub.populate(text=text)
    sub.subset(font)
    return font


def build(sc_variable: str, jp_otf: str) -> None:
    faces = {}
    for style, weight in (('Regular', 400), ('Bold', 700)):
        font = instancer.instantiateVariableFont(TTFont(sc_variable), {'wght': weight})
        make_subset(font, TEXT)
        rename(font, 'OPE Test CJK', style)
        faces[style] = font
    faces['Regular'].save(os.path.join(HERE, 'OPETestCJK-Regular.ttf'))

    # Bold first: tests must select the regular face by PostScript name, not by index.
    collection = TTCollection()
    collection.fonts = [faces['Bold'], faces['Regular']]
    collection.save(os.path.join(HERE, 'OPETestCJK.ttc'))

    jp = make_subset(TTFont(jp_otf), ASCII + '漢語日本語' + KANA + PUNCT)
    rename(jp, 'OPE Test JP', 'Regular')
    jp.save(os.path.join(HERE, 'OPETestJP-Regular.otf'))


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
