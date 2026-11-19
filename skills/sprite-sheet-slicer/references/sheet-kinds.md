# Sheet kinds and their recipes

Decide the kind from the pages and the pack description before writing ops. A sheet can mix kinds; treat each region by its own recipe.

## Not a sheet: a composed scene

Signs: `detect` prints `kind: scene_or_single_object`. Objects overlap each other, stand on a floor, or cast shadows onto one another.

Do: nothing. A scene has no clean per-asset pixels to recover because objects hide parts of each other. Tell the user and ask for the source sheets.

## Separate props with gaps

Signs: every prop has transparent space around it.

The usual miss here is a prop drawn as loose pieces, which shows as several objects. It is easy to overlook because each piece looks like a complete little thing, and a sheet can have dozens. Do not conclude "nothing to do" before checking:

- the `shares_cell` and `close_same_colours` flags and the hint lines from `review`;
- pieces that sit off-centre in their cells, or that are narrower or shorter than the sheet's other props, next to a same-coloured neighbour. Together such a pair usually makes a shape placed and sized like the others.

`shares_cell` only catches pieces inside a single cell. Pieces of a prop two or three cells tall are found through `close_same_colours` and by eye.

Fix a few with `merge`, many with `cells` (pieces inside one cell) or `near` (pieces closer together than separate props). When loose pieces and separate props are the same distance apart, merge by id.

Stray pixels of under six pixels within two pixels of another object were absorbed into it by `detect` (the count is printed and `state.json` lists them under `absorbed`). Objects of under six pixels that were not absorbed are flagged `speck`.

Two shapes drawn overlapping with one outline round both are one object and cannot be separated. Report them.

## Props with drop shadows

Signs: semi-transparent dark pixels under the props. `objects.json` gives such objects a `body` box (the solid part) as well as `bbox` (with shadow).

A shadow goes to the prop above it. Where the shadows of neighbours run together the script divides them pixel by pixel and often gets the border wrong, so a contour that bulges into a neighbour's shadow is normal and does not mean the solid parts are wrong. There is no op that moves a shadow; if shadow ownership matters, slice the pack's no-shadow version.

One shadow lying under two same-coloured pieces is a sign that they are one prop. The script does not report this; look at the artwork with `review --ids`.

Footprints and cell positions in the catalogue are taken from the solid body, so an overhanging shadow does not inflate them.

## Props packed edge to edge

Signs: furniture or crates share borders with no gap. The description often says "aligned to a 16 grid".

The script cuts these where two outlines run side by side on a lattice line. What it cannot know:

- Two props that touch only at a corner or over two or three pixels. The script cuts there and marks a magenta bar. If it is really one prop, `merge`.
- An outlined prop standing directly on flat artwork, or a table top overhanging its frame: one rim against fill with no second rim. The script keeps them joined and marks a magenta bar. If they are two assets, `cut`.
- A prop with a dark line of its own running along a lattice line may have been cut there. `merge` the halves.
- Props without outlines. Neighbours of different colours are separated; neighbours sharing a colour stay fused (`cut`), and one prop whose shading changes colour exactly on a lattice line gets split (`merge`). Neither is flagged, so on flat art look at every lattice line that crosses a prop. A fused pair often shows as an L-shaped contour or an object twice the usual size.
- Thin diagonal sprites crossing a lattice line are often flagged `doubtful_border`. They are almost always whole.
- A strip of several multi-cell assets fused in a row (five doors side by side) may carry no flag except `large_blob`. `cut` it with `cells`.

## Icon grid

Signs: small items of about the tile size, one per cell, often in labelled groups.

Recipe:

1. Look at the `shares_cell` objects. If they are icons drawn in pieces, `{ "op": "cells" }` joins them all. If instead some cells hold two different items, limit `cells` with `region` or merge the real pairs by id.
2. `drop` the label boxes. Dropping and `cells` can go in the same file in either order.
3. An icon that touches its neighbour or a label box is fused with it: find such objects with `status --list` (an object spanning several cells on an icon grid is suspect) and `cut` at the cell boundaries. A cut can leave the label, or several icons, in one piece; that takes another round.

Use label text as the `category` when naming. If the description gives the icons a cell size ("16x16 icons"), export with `--pad cell` so every icon has that size, and say so in the report.

## Terrain, wall or floor tileset

Signs: brick, stone, grass, walls, pipes, window panes. The pieces are meant to tile and usually have no outline.

- A cell completely filled with unoutlined texture, and cut apart from its neighbours, is marked as a tile by `detect` (`kind: "tile"` in `objects.json`). Where the texture or colour continues unbroken from one cell into the next, the cells stay one object: `tiles` on it.
- Doors, gates and other pieces several cells in size: `cut` with `cells` (cropped tight), or `tiles` with `span` (whole cells). Do not chop them into single cells.
- **Walls, pipes and frames drawn across lattice lines.** Thin walls are often centred on a grid line rather than inside a cell. Cutting them per cell halves them lengthwise, and `tiles` refuses to do it. Leave each connected wall piece as one object; they are already separate where they do not touch. This holds even when the description says the pack "can be sliced into 16x16 tiles": mention in your report that the walls were kept as whole pieces and why.
- A pack described as "32x32 style on a 16 grid" may intend 2x2-cell tiles: use `"span": [2, 2]`.
- Wall or pipe pieces fused with a terrain block: `cut` the block away first, then `tiles` on the block only.

## Sheet with no lattice

Signs: `tile: none`, objects of arbitrary sizes at arbitrary positions. Rulers show pixels.

The script cuts fused outlined objects along seams and draws those cuts as cyan dashes along the shared edge, on top of the two contours. Check them:

- Cyan dashes through the middle of one object (it has a thick dark line of its own): `merge` the halves.
- Two objects still fused (flat art, no outlines): `cut` with `px` read from the ruler.

## Signals that the background was misjudged

- The pages show one or two giant contours with a solid colour filling the gaps: the background was not recognised. Rerun `detect` with `--bg rrggbb`.
- Sprites have holes where a light or dark colour should be: background-coloured areas inside the artwork were removed. Rerun with `--pockets large` or `--pockets keep`.
- Sprite edges look chewed, or sprites have lost their outlines: the background has the same colour as the outlines, or an outline colour was taken for background. `state.json` lists the colours considered under `background.candidates`. Rerun with `--bg` naming the true background, or ask for a transparent source.
- A baked checkerboard that was recognised prints `background: checker` with its colours; the pages then show the artwork on the script's own dark checker instead.
