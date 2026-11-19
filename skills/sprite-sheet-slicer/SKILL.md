---
name: sprite-sheet-slicer
description: Cuts a game-art sprite sheet, tileset or icon sheet (PNG) into one image per asset and writes a catalogue that names each asset and records its size in tiles and where it came from. Use when a single image packs many game assets, often irregularly and edge to edge, and they have to be separated, named or catalogued before a game can use them. Typical requests are "slice this sprite sheet", "split this asset pack into sprites", "extract the sprites", "cut up this tileset", "make an atlas from this sheet", 스프라이트 시트 자르기, 에셋 슬라이싱, 타일셋 분리.
---

# Sprite sheet slicer

The script owns the pixels and you own the meaning.

- `scripts/sheet.js` finds every object, knows exactly which pixel belongs to which one, and draws numbered review pages.
- You look at the pages, decide what counts as one asset, and say so with short edit ops that name objects by **id** and places by the **ruler** printed on the page.
- You never estimate where a sprite's edge is. A position read off a picture is approximate, so the one free position the script accepts (`cut` with `px`) is moved to the strongest seam within 3 pixels.

Words used here: an **object** is one region the script found and numbered. An **asset** is what the game needs: one prop, one icon, one tile. The job is to make every object exactly one asset. A **cell** is one square of the sheet's tile grid.

Requires Node on PATH (`node --version`; tested on Node 24, 18 or newer is expected to work but untested). Nothing to install. Input must be PNG.

Commands are run as `node "${CLAUDE_SKILL_DIR}/scripts/sheet.js" <command> ...`, with paths in quotes; `--help` lists every command and option. Pick a work folder per sheet (`WORK`) and a new, empty output folder (`OUT`), both outside the skill folder. Write ops and names files with the Write tool, which saves UTF-8; a UTF-16 file from a PowerShell redirect is refused.

Progress list to copy and tick:

```
[ ] licence checked     [ ] tile size found
[ ] detect: warnings read
[ ] review: pages read, kind of sheet decided
[ ] apply (round 1)     [ ] review again
[ ] names (if wanted)   [ ] export: coverage complete
[ ] report
```

## Before you start

1. **Check the licence.** If the user gave a store page or a readme, read its licence text. If it restricts AI use ("no AI", "not for AI training", "may not be fed to AI"), stop and ask the user how to proceed.
   - If they tell you to go ahead, carry on with the normal workflow and say in your report that they made that call.
   - If they want the artwork kept away from AI: run `detect` and `review`, tell them where `WORK/pages` is, and let them look and write the ops file. Do not Read the pages, `native.png` or any sprite. You may still run `apply`, `review`, `status` and `export` for them and read the text those print.
2. **Find the tile size.** Pack descriptions usually state it ("16x16 tiles", "32x32 style aligned to a 16 grid"). Pass it as `--tile N`. It matters most on art without outlines: on synthetic test sheets of unoutlined terrain and flat-shaded props, the script cut about 90% of assets correctly with the tile size and under 40% without. If the description says there is no grid, pass `--tile none`. If it says nothing, leave `--tile` out; the script then tries to infer a size and says so.
3. **One sheet, one work folder.** Rerunning `detect` on a work folder starts that sheet over.

## Workflow

### 1. Detect

```
node "${CLAUDE_SKILL_DIR}/scripts/sheet.js" detect "<sheet.png>" --work "WORK" --tile 16
```

It prints the background it found, the art style (outlined or flat; informational), the tile size, the number of objects, and `WARNING` and `note` lines. Act on these:

| It prints | Do this |
|---|---|
| `kind: scene_or_single_object` | Very few objects, and one holds most of the artwork. Read the image. If it is a mock-up scene (objects overlapping, standing on a floor), tell the user it cannot be cut into clean assets and stop. If it is one or a few big sprites, carry on. |
| `background: none` | An opaque image whose background was not recognised. Read the image, find the background colour, rerun with `--bg rrggbb` (comma-separate the colours of a baked checkerboard). |
| "background colour also occurs inside the artwork" | Sprite edges may be damaged. Tell the user a transparent source would be safer; carry on. |
| "enclosed region(s) of background colour were removed" | Normal on packed sheets. If sprites show holes on the pages, rerun with `--pockets large` or `--pockets keep`. |
| "read as a xN enlargement" | The image was an enlarged preview and has been reduced. `--tile` and every position are in native pixels. If the image is not an enlargement, rerun with `--scale 1`. |
| `tile: 16px (inferred)` | A guess from how objects line up. If the pack has no grid, rerun with `--tile none`; if it states a size, pass it. |
| `tile: none` | No lattice. The `cells` and `tiles` ops are unavailable and `cut` takes `px`. |
| "speck(s) ... were merged into the object next to them" | Usually stray pixels. If the pack has real sprites of under six pixels, see `split` in the ops reference. |
| "nearly invisible pixel(s) ... treated as transparent" | Nothing to do. |

### 2. Review

```
node "${CLAUDE_SKILL_DIR}/scripts/sheet.js" review --work "WORK"
```

This writes `WORK/pages/*.png` and `WORK/objects.json` and prints hints. Read the pages with the Read tool: all of them when there are eight or fewer; otherwise those listing flagged objects first, then a sample of the rest. Pages overlap a little, so an object near a page edge appears on two pages with the same id. A sheet that fits is drawn on one page; a sheet of more than 600 objects gets only the pages with flagged objects (or a sample when nothing is flagged).

Reading a page:

- The artwork is shown in its true colours on a dark checker. Each object has a **coloured contour** along the exact edge of its pixels and a **number** in the same colour. The number is the **id**. It sits inside large objects and beside small ones. An object made of separate pieces has one number and a contour of the same colour round each piece.
- The numbers along the top and left are the **ruler**: cell indices on a sheet with a tile size (cell 3 starts at pixel 3 x tile), pixel positions otherwise.
- A **white double box** marks a flagged object. Flags are prompts to look, not errors:
  - `shares_cell`: several objects sit inside one cell.
  - `close_same_colours`: another object sharing its colours lies 2 pixels away or less.
  - `doubtful_border`: the object touches a lattice border (**magenta bar**) where the choice to cut or join was close. Thin diagonal sprites crossing a grid line get this often and are fine.
  - `exposed_fill`: the object's fill lies directly against another object with no outline between: a wrong cut, or two assets with no outline between them.
  - `large_blob`: far bigger than the other objects. Often several assets fused.
  - `speck`: under six pixels.
- **Cyan dashes** mark seams the script cut on a sheet with no lattice.
- Dimmed artwork without a contour has been dropped.

The hints printed by `review` tell you what a picture cannot: which objects share a cell, how far apart neighbours are, which pairs sit at the closest gap, and which close pairs share their colours. A colour-sharing pair is written `12+13@1px=28x28`: ids, gap, and the size of the two together. They are the main lead for the most common miss, one asset drawn as several loose pieces, though a piece whose colours differ from its partner's is not listed.

When a page is not enough:

- `review --ids 12,13` writes one enlarged page of the area round those objects (`pages/focus_*.png`), neighbours included, and leaves everything else alone. Give ids that lie close together, a pair at a time; ids far apart give a page no larger than the normal one. `--zoom` works with it. Use it for small sprites and for any pair you are unsure about.
- `review --zoom 8` re-renders the whole sheet larger. A plain `review` goes back to the default.
- `WORK/native.png` is the clean sheet at native size.
- `status --list` prints one line per object: id, cells, box, area, flags.

Take ids from `status --list` or `objects.json` rather than from the picture alone: check that the object's `cells` or `bbox` is where you saw it. An id that exists but is not the one you meant is accepted and changes the wrong object.

### 3. Decide and edit

If every asset already has exactly one object, skip this step. No ops file is needed and you can name and export at the current revision. The stop checks at the end of this step still apply.

Otherwise decide what kind of sheet this is, because that picks the recipe. [references/sheet-kinds.md](references/sheet-kinds.md) describes each kind and its usual problems.

| Kind | Usual ops |
|---|---|
| Separate props with gaps | `merge`, `cells` or `near` for props drawn as loose pieces. Check the hints before deciding there is nothing to do. |
| Props packed edge to edge | `cut` where two props are still fused, `merge` where one prop was split. |
| Icon grid, one icon per cell | `cells` once, then `drop` any label boxes. |
| Terrain or wall tileset | `tiles` on blocks still fused. Walls drawn across lattice lines: leave whole. |
| No lattice | Check the cyan seams: `merge` a wrong one, `cut` with `px` where two objects are still fused. |
| Mixed | Each region by its own recipe; `cells` and `near` take a `region`. |

Write the ops file and apply it:

```json
{ "rev": 0, "ops": [
  { "op": "cells" },
  { "op": "drop", "ids": [7, 31], "reason": "category label boxes" }
] }
```

```
node "${CLAUDE_SKILL_DIR}/scripts/sheet.js" apply --work "WORK" --ops "WORK/ops_r1.json"
```

`rev` is the revision that `review` printed (also in `objects.json`). The file is all-or-nothing: if any op is rejected nothing changes; read the message, fix the file, apply again. Full reference with examples: [references/ops.md](references/ops.md).

| Op | Use it when |
|---|---|
| `merge` ids | Several pieces are one asset. |
| `cells` | Everything inside one cell is one asset (icon grids, loose pieces within a cell). |
| `near` px | Many assets are drawn as loose pieces closer together than separate assets are. |
| `cut` id, axis, cell / cells / px | Two or more assets are fused. `cells: [2, 4, 6]` cuts a strip in one go. |
| `tiles` ids, optional span | A fused block should become one object per cell, or per `span` of cells. |
| `split` id | Undo a merge: back to the object's connected pieces. |
| `drop` ids, reason | Not an asset: label text, a watermark, a colour swatch. |
| `restore` ids | Undo a drop. |
| `ok` ids | You checked a flagged object and it is right. Optional. |

Prefer the bulk ops (`cells`, `near`, `tiles`) to long id lists: fewer ids, fewer misreadings.

Ids within one file: ops run in order and each sees the result of the ones before. `merge`, `cells` and `near` keep the smallest id of each group and leave other ids alone, so later ops in the same file can still use them. `cut`, `tiles` and `split` retire the id they act on and create new ones that you only learn from the apply output, so anything that needs those new ids goes in the next round.

**After every apply, run `review` again** and read the new pages before writing more ops or names.

**One piece or two?** Two nearby pieces could be one asset or two. Work down this list:

1. They sit inside one cell of a sheet built one asset per cell (an icon grid): one asset.
2. They are painted with different colours, or are plainly different things: two assets.
3. Shared colours, and the two together have the size and placement of the sheet's other assets while each piece alone does not: one asset. This holds even when each piece has its own complete outline. The hint gives the size together (`=28x28`); compare it with the sizes of single objects in `status --list`. Shading bands or highlights that line up across the two pieces, or one shadow under both, point the same way.
4. Shared colours, but each piece alone already has the size and placement of the sheet's other assets (two bottles side by side, each as big as every other bottle): two assets.
5. Still unsure: leave them separate and list them in your report. A developer can combine two sprites; pulling a fused one apart is harder.

The gap hint helps only when loose pieces sit closer together than separate assets do. When both are 2 pixels apart it cannot tell them apart, and rule 3 decides.

Stop when the pages show one object per asset. Three rounds is normally enough; a cut can leave a piece that needs a further cut or drop, which takes another round. If something is still wrong after three, export anyway and report it.

Before you stop, check:

- No object holds two different assets (`cut`, `tiles`). Look hardest at `large_blob` objects and at any object much wider or taller than its neighbours.
- No asset is spread over several objects (`merge`, `cells`, `near`).
- No object is something other than an asset (`drop`).
- Each flagged object has been looked at once. Flags that remain on objects you judged correct are fine.

### 4. Name (optional)

Skip this step if the user does not want names: export without `--names` and every asset keeps a generated name (`obj_0042`, `tile_0107`).

Otherwise write `WORK/names.json` for the current revision. Name what you can recognise and leave the rest out.

```json
{ "rev": 1,
  "sheet": { "kind": "icon grid", "notes": "16px item icons under six label boxes" },
  "assets": {
    "12": { "name": "weapon_sword_iron", "category": "weapons", "tags": ["melee"], "confidence": "high" },
    "40": { "name": "food_loaf", "category": "food", "confidence": "low", "description": "brown oval, could be bread or a potato" }
  } }
```

- Keys are object ids as plain numbers. Names are lowercase letters, digits and underscores, at most 64 characters, and unique. A good pattern is `category_thing_variant` (`bench_wood_stocked`, `locker_red_open`).
- `sheet.kind`, `sheet.notes`, `category`, `tags` and `description` are free text for whoever reads the catalogue.
- Use label text printed on the sheet as the category when there is any.
- Judge colour from the artwork inside the contour, never from the contour or the number, which are drawn in arbitrary colours. `review --ids` gives a large view of a few objects.
- Say `"confidence": "low"` when guessing. A 16px icon is often ambiguous, and a wrong confident name misleads whoever builds the game.
- Link variants with `"variantOf": "<name of the base asset>"` (open and closed, empty and stocked). The base must be an asset you also name; export checks.
- On a sheet of hundreds of assets, name the ones the user is likely to ask for by name and say how many you left with generated names.

### 5. Export

```
node "${CLAUDE_SKILL_DIR}/scripts/sheet.js" export --work "WORK" --out "OUT" --names "WORK/names.json"
```

`--names` is optional. `OUT` must be a new or empty folder, or one a previous export created; any other non-empty folder is refused so that nothing of the user's is overwritten. It receives `sprites/<name>.png`, `sheet.png`, `atlas.json` (TexturePacker JSON hash), `assets.json`, `ASSETS.md` and `contact_NN.png`. The contact sheets show the whole sheet with every asset outlined and numbered, so a sprite with a generated name can still be found by eye. Field reference: [references/outputs.md](references/outputs.md).

Sprites are cropped tight, except terrain tiles, which are written as whole cells. For an icon grid, or anything else the game loads at a fixed cell size, add `--pad cell`; say in your report which you chose. `--pad none` crops everything tight.

The export ends with a **coverage check**. `"complete": true` means every artwork pixel landed in exactly one sprite or was dropped on purpose. It does not mean the objects were divided correctly, nor that the background was judged correctly; only your review covers those. If it prints `"complete": false`, do not hand the result over: report the numbers to the user.

### 6. Report

Tell the user, in this order:

1. How many assets were exported and where.
2. What kind of sheet it was and what you changed by hand (ops used).
3. Anything uncertain: objects you could not resolve, close pairs you left separate, low-confidence names, warnings from detect.
4. How many assets have generated names, and that the contact sheets show which is which.

## Limits

- PNG only. Interlaced and animated PNGs are rejected with a message; ask the user to re-export.
- Built for pixel art with hard edges. Anti-aliased or painted artwork, and JPEG sources, will segment poorly.
- A background the same colour as the outlines cannot be separated. The script warns; ask for a transparent source.
- Shadows are given to the object above them. Where the shadows of neighbours run together the division is approximate: on dense synthetic test sheets about 90% of shadow pixels went to the right owner, and about half of shadowed assets came out with every shadow pixel right. The solid parts are not affected. If the pack ships a version without shadows, slice that one.
- Two assets drawn overlapping, with one outline round both, cannot be separated.
- Animation frames are cut as separate objects; nothing groups them into animations.
- The work folder has no lock. Never run two commands on the same work folder at once.
