# Design

This document records why the skill is built the way it is. Measurements are in [EVALUATION.md](EVALUATION.md).

## The problem

Many pixel-art packs are published as one image with dozens or hundreds of assets packed into it, often irregularly and edge to edge. A game needs them as separate images with names. The preview images of one pack already showed how mixed the inputs are: a furniture sheet with props touching each other, a 16px icon grid with label boxes, icons on a baked four-colour checkerboard, a wall and door tileset, the furniture sheet again with semi-transparent shadows, and composed scenes enlarged three or four times on a white background.

No single algorithm handles all of these. The first step is deciding what kind of sheet it is, and that is a judgement about meaning.

## Division of labour

The script owns the pixels. Connected-component labelling is deterministic, exact to the pixel and takes about 0.1 seconds per sheet, so the script always knows which pixel belongs to which object.

Claude owns the meaning. It can tell whether three blobs are three tool carts or one long shelf, whether two pieces in a cell are one icon, and whether a pale box is a label rather than an asset.

They talk in object ids and lattice cell numbers. Claude never outputs the coordinates of a sprite's edge, because a position a vision model reads off an image is approximate, and a sprite edge has to be exact to the pixel. The only free pixel position the script accepts is `cut` with `px` on a sheet without a lattice, and that position is moved to the strongest seam within 3 pixels.

## Why no segmentation model

Segment Anything (SAM) and similar models predict masks from a feature map 16 times coarser than the image, so objects of 32 pixels or less are their weak point. The 16px icons and props on these sheets fall in that range. Background-removal tools such as rembg produce one foreground mask, not instances. On a pixel-art sheet with a transparent background the foreground mask is already exact, so what remains is a grouping problem, and that is the part handled by the review loop.

## Why zero-dependency Node

The machine the skill was built on had Node and no Python. The operations needed (connected components, flood fill, union-find) are simple enough that OpenCV would not pay for its install. The PNG codec is written on top of `node:zlib`: five colour types, bit depths 1 to 16, tRNS, CRC checks; interlaced PNG and APNG are refused. The skill folder is four scripts (about 130 KB) and four Markdown files, with no install step.

Extending the tool to unoutlined illustration, anti-aliasing or JPEG would need colour quantisation and watershed. The plan in that case is to look at image-js, which is pure JavaScript, before reaching for Python.

## Every estimate has evidence and an override

The script's guesses can be wrong, so each one records its evidence in `state.json` and has an option that replaces it.

| Estimate | Evidence recorded | Override |
|---|---|---|
| Enlargement factor | Share of colour changes that fall on a common remainder, number of changes | `--scale N` |
| Background colour | Border share per candidate, solid-patch ratio, reason for acceptance | `--bg rrggbb` |
| Enclosed background areas | Number of areas and pixels removed | `--pockets all\|large\|keep` |
| Tile size | z-score per candidate lattice | `--tile N`, `--tile none` |
| Splitting touching objects | Counts of same-colour, different-colour and outline pairs across each border | `merge`, `cut` |

## Ops are validated before they run

An ops file is checked as a whole and applied as a whole, or not at all.

- A file written against a different revision is refused, because ids mean different things in different revisions. Rerunning `detect` keeps the revision counter going up, so an old ops file cannot slip through.
- Ops only move pixels between objects. If the foreground mask differs by a single pixel after applying, nothing is saved.
- `tiles` is refused when 10% or more of the resulting pieces are thin slivers lying against a lattice line. This stops a wall drawn across a grid line from being cut in half lengthwise.
- `export` validates the names file before touching the disk, and refuses a non-empty output folder it did not create, so it cannot overwrite the user's files.

## Pipeline

```
sheet.png
  detect   undo enlargement, find background, label components, infer tile size,
           split touching objects, absorb specks, assign shadows, mark terrain tiles
           -> native.png, labels.bin, state.json
  review   numbered pages with contours and a ruler, objects.json, printed hints   <--+
  Claude   decide the kind of sheet, write ops.json                                   |  usually 1 to 3 rounds
  apply    validate, then apply  ----------------------------------------------------+
  Claude   names.json (optional)
  export   sprites/, sheet.png, atlas.json, assets.json, ASSETS.md, contact_NN.png,
           coverage check
```

`SKILL.md` gives exact commands where there is one right thing to do, and an ordered list of questions where judgement is needed: what kind of sheet this is, and whether two nearby pieces are one asset or two.

## Main algorithms

**Enlargement.** In a nearest-neighbour enlargement by N, every colour change falls at the same remainder modulo N. The script picks the largest N that explains at least 99.5% of changes on both axes, and accepts it only when each axis has at least 12 changes. Without that floor a simple 64px image with a few edges was read as an 8x enlargement and shrunk to 7px.

**Background.** With an alpha channel the background is the transparent pixels. On an opaque sheet the candidates are colours seen on the border. A background colour has solid patches, pixels whose four neighbours are all background candidates; an outline never has, because its inside is always fill. Colours can vouch for each other only when their pixel counts are similar, which lets the two colours of a checkerboard support each other but stops a blade touching the border from doing the same. A background seen only through 1px gaps is accepted by a separate rule: it touches only itself and one other colour, and that other colour is thin. The accepted colours are flood-filled from the border, and background areas enclosed by artwork are removed according to `--pockets`.

**Splitting on a lattice.** Lattice cells are nodes. For each pair of neighbouring cells the script counts the pixel pairs that cross their shared border. Outlines facing each other along 4 or more pixels make a seam; any non-outline pair across the border joins the cells. Each blob is classified as outlined or flat first, and on flat art two cells join only where the same colour continues across. Close calls are flagged for review rather than decided silently.

**Splitting without a lattice.** Wherever two outlines run side by side for 4 or more pixels the script places a wall and recomputes connected components. Walls also block diagonal connections.

**Shadows.** Semi-transparent pixels are grouped into regions and given to the opaque object directly above. A region touching several objects is shared out pixel by pixel, the object above first, the rest to the nearest.

**Review pages.** The artwork keeps its true colours. Each object gets a contour along the exact edge of its pixels and an id, inside large objects and beside small ones. A tint over each object would distort the colours that names are judged by.

**Coverage check.** Every exported sprite is read back from disk, pasted at its source position and compared with the sheet. This guarantees that no pixel was lost or duplicated. It cannot tell whether the sheet was divided at the right places, and the output says so.

## Edit ops

| Op | Use | Ids afterwards |
|---|---|---|
| `merge` ids | Several pieces are one asset | Smallest id kept |
| `cells` | Pieces sharing one cell are one asset | Smallest id kept |
| `near` px | Pieces within px of each other are one asset | Smallest id kept |
| `cut` id, axis, cell / cells / px | Split fused assets | Old id retired, new ids issued |
| `tiles` ids, span | Turn a block into one object per cell or span | Old id retired, new ids issued |
| `split` id | Undo a merge | Old id retired, new ids issued |
| `drop`, `restore` | Exclude something that is not an asset, or bring it back | Unchanged |
| `ok` | Mark a flagged object as checked | Unchanged |

Full reference with examples and rejection messages: `skills/sprite-sheet-slicer/references/ops.md`.

## Decisions reversed during development

| First version | Now | Why |
|---|---|---|
| Round-trip check passing meant done | Called a coverage check, documented as unable to judge the division | A wrong division is also lossless |
| Objects tinted on review pages | Contours only | Tinting caused wrong names |
| Border share of 8% or more made a colour background | Solid patches, vouching only between similar counts, separate rule for thin background | On a full sheet the outlines were erased as background |
| Scene if the largest blob held 50% of the art | Scene if 6 or fewer objects remain after splitting and one holds 50% | Packed sheets are one blob before splitting |
| No splitting without a lattice | Seam walls | Off-grid packed sheets went from 4% to 100% |
| Outline colour tolerance of 28 on a lattice | Exact colour match | Dark bands inside sprites were cut as outlines |
| Shadows to the nearest object | Object above first | Shadow pixel accuracy from 68% to 88-93% |
| Export cleared the output folder | Replaces only its own files, refuses foreign folders | It could overwrite the source sheet |
| Walls cut with `tiles` | Walls across lattice lines left whole | A real wall sheet was judged 46% correct |

Two rules were tried and withdrawn after they misfired on real art; the script now flags these cases instead of cutting. A border where an outline continues on one side only is not treated as a seam, because it split a table whose top overhangs its frame. Objects touching only diagonally are joined only when both are 1px lines, because the broader rule fused three stools standing side by side.
