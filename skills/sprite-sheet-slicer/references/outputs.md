# Files the script writes

## In the work folder

| File | Purpose |
|---|---|
| `native.png` | The sheet at native size with the background made transparent. No markings. |
| `pages/*.png` | Review pages for the current revision. Replaced by every `review`, except `focus_*.png` pages from `review --ids`, which are added. |
| `objects.json` | The objects of the current revision, one per line, plus hints. Replaced by every `review`. |
| `state.json` | Everything `detect` measured and every op applied. Useful fields: `warnings`, `background.candidates`, `grid.evidence`, `absorbed`, `dropped`, `history`. |
| `labels.bin` | One 32-bit object id per pixel. Not for reading. |

### objects.json

```json
{ "rev": 1, "tile": 16, "rulerUnit": "cell", "zoom": 4,
  "counts": { "objects": 84, "dropped": 9, "flagged": 3, "flagsByKind": { "shares_cell": 2, "doubtful_border": 1 } },
  "dropped": { "7": "label box: Weapons" },
  "hints": { "objectsSharingACell": "54 58",
             "pairsByGapPx": { "touching": 0, "1": 9, "2": 310, "3": 41 },
             "closePairsSharingColours": "5+10@1px=28x28 21+26@2px=14x30",
             "pairsAtClosestGap": { "gapPx": 1, "pairs": "5+10 33+34" } },
  "pagesNotRendered": 0,
  "pages": [ { "file": "pages/page_y0000_x0000.png", "covers": { "cells": [0, 0, 13, 13] }, "objects": 84, "flagged": [9] } ],
  "objects": [
    { "id": 4, "bbox": [33, 2, 13, 13], "cells": [2, 0, 2, 0], "area": 96 },
    { "id": 9, "bbox": [80, 30, 20, 24], "cells": [5, 2, 6, 3], "body": [82, 30, 16, 20], "area": 300, "flags": ["doubtful_border"] }
  ] }
```

- `bbox` is `[x, y, width, height]` in sheet pixels and includes any shadow.
- `cells` is `[col0, row0, col1, row1]`, inclusive, of the solid body. Present only with a tile size.
- `body` is the solid part, given only when a shadow makes `bbox` larger.
- `kind` is `"tile"` for terrain cells and absent for ordinary objects.
- `flags` is absent when there are none.
- `covers` of a page uses `[x0, y0, x1, y1]` inclusive, in ruler units, the same convention as an op's `region`.
- `hints.pairsByGapPx` counts neighbouring object pairs by the empty pixels between their solid parts, tiles left out. `closePairsSharingColours` lists the pairs up to 3px apart where one object's colours are all found in the other, written `a+b@gap=WxH` with the size of the two bodies together. `pairsAtClosestGap` lists every pair at the smallest gap that occurs, whatever their colours.
- On a sheet of more than 3000 objects only flagged objects are listed.

## In the output folder

| File | Purpose |
|---|---|
| `sprites/<name>.png` | One image per asset, containing only that asset's pixels. Use these. |
| `sheet.png` | The whole sheet at native size, background transparent, dropped objects removed. |
| `atlas.json` | TexturePacker JSON hash: `frames["<name>.png"].frame = {x, y, w, h}` on `sheet.png`. Loads in Phaser (`load.atlas`) and PixiJS. |
| `assets.json` | The catalogue, described below. |
| `ASSETS.md` | The same catalogue as a table ordered by grid row and column, with a note on placing sprites. |
| `contact_NN.png` | The sheet with every asset outlined and numbered by id, for finding a sprite by eye. A generated name ends in the id. |

Export replaces `sprites/`, the contact sheets and the four files above. Other files in the folder are left alone. A non-empty folder that export did not create is refused unless `--force` is given.

### assets.json

Top level: `source` (the original file name), `sheetImage`, `contactSheets`, `tile`, `pixelScale` (how much the input had been enlarged), `rev`, `sheet` (from names.json), `warnings`, `coverage`, `assets`. Only warnings that bear on the result are carried over (damaged edges, unrecognised background, shadow-only objects); the full list is in `state.json`.

Each asset:

| Field | Meaning |
|---|---|
| `id` | Object id in the work folder at export time. |
| `name` | Given name, or a generated `obj_NNNN` / `tile_NNNN`. The atlas frame key is this plus `.png`. |
| `named` | `false` when the name is generated. |
| `category`, `tags`, `description` | From names.json. |
| `confidence` | How sure the namer was: `high`, `medium`, `low`, or null. |
| `variantOf` | Name of the base asset this is a variant of. |
| `kind` | `object` or `tile`. |
| `file` | Path of the sprite image. |
| `sourceRect` | `{x, y, w, h}`: the area of `sheet.png` that the sprite image shows. Includes shadow and any cell padding. |
| `bodyRect` | The solid part of the asset, without shadow or padding. |
| `paddedToCells` | `true` when transparent padding was added to bring the image to whole cells. |
| `cellOrigin` | Lattice cell holding the top-left of the solid body. Null without a tile size, like the three fields below. |
| `cellsCovered` | `[columns, rows]` of sheet cells the solid body touches. Larger than the footprint when the asset sat across a grid line. |
| `footprintTiles` | `[w, h]`: the solid body's own size, rounded up to whole tiles. Use this for how much room the asset needs. |
| `offsetInCell` | Where the sprite image's top-left sits relative to `cellOrigin`, in pixels. Negative when a shadow or outline overhangs the cell. |
| `pivotPx` | `{x, y}` inside the sprite image: bottom centre of the solid body. For depth sorting and for standing a prop on a floor line. |
| `hasShadow` | The sprite includes semi-transparent pixels. |
| `rectSharedWithNeighbour` | `true` when `sourceRect` also covers pixels of another asset (irregular packing). The sprite file is clean; the same rect on `sheet.png` is not. |

### coverage

```json
{ "artworkPixels": 139416, "droppedPixels": 0, "unassigned": 0, "claimedTwice": 0, "mismatch": 0, "emptySprites": 0, "complete": true }
```

Every exported sprite is read back from disk and pasted at its source rect, then compared with the sheet as it stands after background removal. `complete` is true when no artwork pixel is missing, duplicated or changed and no sprite is empty. It says nothing about whether objects were divided at the right places or whether the background was judged correctly.

### Padding

| `--pad` | Tiles | Other objects |
|---|---|---|
| `auto` (default) | whole cells | cropped tight |
| `cell` | whole cells | whole cells |
| `none` | cropped tight | cropped tight |

With `cell`, every image is a whole number of cells except where the sheet edge cuts a cell short, which only happens when the sheet itself is not a whole number of cells.

## Placing an asset in a game

On a tile map with tile size `T`, draw the sprite image with its top-left at `cell * T + offsetInCell`, where `cell` is the map cell you want in place of `cellOrigin`. That reproduces where the artist drew the asset relative to the grid, shadow included. Props drawn bottom-aligned in their cells then stand on a common floor line; props the artist centred do not, and for those place `pivotPx` on the floor line instead.
