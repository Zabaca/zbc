# The document's font

Noto Sans 2.015 (`NotoSans-Regular.subset.ttf`, `NotoSans-Bold.subset.ttf`), by the Noto Project Authors, under the SIL Open Font License
1.1 (`OFL.txt`, the licence file of https://github.com/notofonts/latin-greek-cyrillic, copied unchanged). The OFL allows subsetting and
bundling; neither file is sold on its own. `test/font.test.ts` pins each file's SHA-256, its version and the licence text.

## Where the files came from

The originals are `fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf` and `NotoSans-Bold.ttf` of
`notofonts/notofonts.github.io` (version 2.015, 620 KB each). Subset with fontTools 4.68.0:

```sh
python3 -m fontTools.subset NotoSans-Regular.ttf \
  --unicodes="U+0020-007E,U+00A0-024F,U+0300-036F,U+0370-03FF,U+0400-052F,U+1E00-1EFF,U+2010-2027,U+2030-205E,U+20A0-20CF,U+2116,U+2122" \
  --layout-features='' --no-hinting --desubroutinize \
  --drop-tables+=GPOS,GSUB,GDEF,kern,DSIG,STAT,meta,gasp,prep,fpgm,cvt --name-IDs='*' --notdef-outline \
  --output-file=NotoSans-Regular.subset.ttf        # and the same for Bold
```

That keeps Basic Latin, Latin-1, Latin Extended A and B, combining marks, Greek, Cyrillic, Latin Extended Additional (all of Vietnamese),
general punctuation and currency signs: about 103 KB each. It has no kerning or ligatures (LibPDF applies none).

## What is generated from them

`bun scripts/make-font.ts` writes, from these two files only:

- `src/pdf/font-data.ts`: the bytes as base64 (the Worker has no file system), with the font's version and licence and the files' hashes;
- `src/pdf/coverage.ts`: every code point the font can draw, as ranges, read from the font's own character map. The browser imports this (and
  not the font) so a character is refused where it is typed by the rule the PDF is drawn with (`src/pdf/glyphs.ts`).

Both are committed. Run the script again only when a file here changes, and commit the three together.

## Subsetting per document

`src/pdf/font.ts` embeds the font once per PDF, and `subsetFonts` keeps only the glyphs the document uses before it is saved or sealed. LibPDF
subsets only when asked at save, and `pdf.sign` saves on its own, so a sealed document would otherwise carry about 70 KB of each font.
`finalize` is not in LibPDF's typings; LibPDF is pinned exactly (0.5.3) and `test/font.test.ts` fails if a sealed document is not subset.
