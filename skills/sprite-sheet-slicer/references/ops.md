# Edit ops

Contents: the ops file, what happens to ids, merge, cells, near, cut, tiles, split, drop and restore, ok, rejections you may see.

## The ops file

One JSON object:

```json
{ "rev": 2, "ops": [ { "op": "...", ... }, ... ] }
```

- `rev` is the revision the pages were rendered at. `review` prints it and writes it to `objects.json`. A mismatch is rejected.
- Ops run in order and each sees the result of the ones before it. The file is all-or-nothing: if any op is rejected, nothing is saved.
- Ruler units: cell indices on a sheet with a tile size, pixels otherwise.
- An op only moves pixels between objects. No op can create or delete artwork.
- Dropped objects are ignored by `cells` and `near`.
- Every apply that changes something creates a new revision, including one that only contains `ok`. Run `review` afterwards and write names for the new revision. An apply whose ops match nothing prints "no change" and keeps the revision.

## What happens to ids

| Op | Ids afterwards |
|---|---|
| `merge`, `cells`, `near` | Each group keeps its smallest id. Every other object keeps its id. |
| `cut`, `tiles`, `split` | The id acted on is retired. The pieces get new ids, printed by apply. |
| `drop`, `restore`, `ok` | No ids change. |

Within one file you can drop some objects and merge others in any order. Anything that needs the new ids from a `cut`, `tiles` or `split` waits for the next round.

A merged group is an ordinary object afterwards, unless every member was a tile, in which case it stays a tile. Any `ok` mark on its members is cleared.

## merge

```json
{ "op": "merge", "ids": [41, 44, 52] }
```

## cells

```json
{ "op": "cells" }
{ "op": "cells", "region": [2, 0, 13, 13] }
```

Objects whose solid body fits inside one lattice cell and that share that cell become one object. Objects spanning several cells are left alone, so label boxes two cells wide are not touched. Needs a tile size. Apply prints the groups it joined.

Look at the `shares_cell` objects first. If some cells hold two different small props rather than one asset in pieces, restrict `cells` with `region`, or merge the real pairs by id instead.

`region` is `[x0, y0, x1, y1]` in ruler units, inclusive. Only objects wholly inside take part. Only `cells` and `near` take a region.

## near

```json
{ "op": "near", "px": 1 }
{ "op": "near", "px": 2, "smallerThan": 12, "region": [0, 0, 13, 5] }
```

Joins every pair of objects whose solid pixels are separated by at most `px` empty pixels (0 to 4). Shadows do not count as contact. Apply prints the pairs it joined.

- `smallerThan`: only join a pair when the smaller object's longest side is under this many pixels. Fragments join their parent; two full-size neighbours never join each other.
- `region`, `ids`: limit which objects take part.

Pick `px` from the gap hint that `review` prints. If neighbours normally sit 2px apart and loose pieces 1px apart, `"px": 1` is safe and `"px": 2` would fuse the whole sheet. If loose pieces and separate assets sit the same distance apart, `near` cannot tell them apart: merge by id.

## cut

On a lattice, give the cell index where the next piece starts, or several at once:

```json
{ "op": "cut", "id": 12, "axis": "x", "cell": 7 }
{ "op": "cut", "id": 30, "axis": "x", "cells": [2, 4, 6, 8] }
```

`axis: "x"` cuts with vertical lines (pieces side by side, numbered left to right). `axis: "y"` cuts with horizontal lines (pieces stacked, numbered top to bottom). Cell 7 means the line at pixel 7 x tile. Each line must lie strictly inside the object: for an object spanning cells 5 to 7, lines 6 and 7 are valid.

Anywhere, including on a lattice sheet, you may instead give a pixel position:

```json
{ "op": "cut", "id": 12, "axis": "x", "px": 118 }
```

The script looks 3px either side for the strongest seam among the solid pixels (two outlines side by side, or a colour break) and cuts there. If it finds none it cuts exactly at the position given. The apply output says which happened. Each piece must keep at least 2 pixels. Use `cell` when the cut belongs on a lattice line; it is exact.

A piece of a cut may still hold several assets (a label fused with a row of icons leaves the icons in one piece): check the next review page and cut again if so.

## tiles

```json
{ "op": "tiles", "ids": [174, 175, 180] }
{ "op": "tiles", "ids": [36], "span": [2, 3] }
```

Each listed object is split along lattice lines into one object per cell, or per block of `span` = `[columns, rows]` cells counted from the object's own top-left cell (a strip of doors two cells wide and three tall is `"span": [2, 3]`). The pieces are marked as tiles: exported as whole cells and named `tile_NNNN` unless you name them. Needs a tile size.

Use `cut` with `cells` instead when the pieces are props that should be cropped tight (doors whose open leaf overhangs its cell, for example).

`tiles` refuses when a tenth or more of the pieces would be slivers under a quarter tile thick lying against a lattice line. That happens when the artwork straddles the lattice, such as walls drawn centred on a grid line: cutting per cell would halve every wall lengthwise. Leave such objects whole or `cut` them where the pieces really end. `"force": true` overrides the refusal.

Objects that fill exactly one cell and have no outline are marked as tiles by `detect` already. Running `tiles` on an object that is a single cell only marks it as a tile.

## split

```json
{ "op": "split", "id": 44 }
```

Undoes merging: the object goes back to its connected pieces, each with a new id. Use it after a `cells`, `near` or `merge` joined things that should stay apart, or to free a tiny sprite that `detect` absorbed into its neighbour. Its shadow is divided among its own pieces. It cannot divide a single connected piece; use `cut` for that.

To undo everything, rerun `detect`.

## drop and restore

```json
{ "op": "drop", "ids": [7], "reason": "label box: Weapons" }
{ "op": "restore", "ids": [7] }
```

A dropped object stays in the work folder but is not exported and is removed from the exported `sheet.png`. The reason is stored with each id; use one `drop` per label if you want to keep which box said what. Dropped ids and reasons are listed in `objects.json` under `dropped` and by `status --list`.

## ok

```json
{ "op": "ok", "ids": [9, 62, 71] }
```

Marks flagged objects as checked so they stop being flagged. It changes no object. Flags are not carried into the export, so this is bookkeeping for your own review.

## Rejections you may see

| Message | Cause |
|---|---|
| `ops were written for rev 1 but the work dir is at rev 2` | The ops come from old pages. Run `review` and read the new ones. |
| `object 171 does not exist in rev 2` | Misread id, or an id retired by `cut`, `tiles` or `split`. |
| `line x=144px (cell 9) does not pass through object 4, which spans 33..45px` | Wrong cell or wrong id. |
| `a cut at x=5px would leave a piece under 2px, or misses object 12, which spans 4..40px` | The position is at or outside the object's edge: check the id, the axis and the ruler. |
| `... pieces would be slivers ...` | The artwork straddles the lattice. See `tiles` above. |
| `"region" only applies to cells and near` | Remove the region, or list ids. |
| `no tile size` | `cells` and `tiles` need a lattice. Rerun `detect --tile N`, or use `cut` with `px`. |
| `... is UTF-16` | The file was written by a shell redirect. Write it with your file-writing tool. |
