# CJK test fonts

Tiny subsets of the Noto CJK fonts so tests can lay out, embed and extract CJK text on
machines (and CI runners) without CJK system fonts. They are test fixtures only; the app uses
the system's fonts (see `src/main/systemFonts.ts`).

| File | Faces (PostScript names) | Outlines | Source |
| --- | --- | --- | --- |
| `OPETestCJK-Regular.ttf` | `OPETestCJK-Regular` | TrueType | Noto Sans SC, `wght` 400 instance |
| `OPETestCJK.ttc` | `OPETestCJK-Bold`, `OPETestCJK-Regular` (bold first, so tests must select by name) | TrueType | Noto Sans SC, `wght` 700 and 400 instances |
| `OPETestJP-Regular.otf` | `OPETestJP-Regular` | CFF (CID-keyed) | Noto Sans JP Regular |

Characters: printable ASCII, the ideographs `你好世界中文测试汉字字体漢語日本語简体繁體这是一段第页共王小明编辑器`
(the JP font only `漢語日本語`), the kana `こんにちはひらがなカタカナ`, and the CJK punctuation
`、。，．！？：；「」『』（）《》・ー…〜` plus U+3000. No Hangul (tests rely on that).

## Sources

- Noto Sans SC: <https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf>
  (Version 2.004, SHA-256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`)
- Noto Sans JP: <https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf>
  (Version 2.004, SHA-256 `dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073`)

## License

SIL Open Font License 1.1, see [OFL.txt](OFL.txt). Copyright 2014-2021 Adobe, with Reserved Font
Name "Source". The subsets are Modified Versions under the OFL: they were renamed ("OPE Test CJK",
"OPE Test JP") and keep the original copyright and license strings in their `name` tables.

## Rebuilding

```bash
pip install fonttools==4.60.1
python build.py 'NotoSansSC[wght].ttf' NotoSansJP-Regular.otf
```
