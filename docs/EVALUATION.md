# Evaluation

How the skill was measured in November 2026, what the numbers say, and what they do not. The design is described in [DESIGN.md](DESIGN.md).

In short: on held-out synthetic sheets the script alone cut 86.2% of assets exactly (mean over 10 sheet families). On 7 of those sheets, Claude running the full skill reached 95.6% where the script alone had 82.2%. Plain connected components scored 49.0% and a grid import 43.4%. All sheets with ground truth come from the author's own generator, so these figures do not measure accuracy on commercial artwork.

## Method

### Sheets

| Set | Contents | Used for |
|---|---|---|
| Development | generator seeds 11, 12 and 13 across 10 families (30 sheets), one naming test sheet of 10 icons, one 2048px sheet; 7,563 assets | watched continuously while the algorithms were tuned |
| Held-out | seeds 71 to 74 across the same 10 families (40 sheets); 3,219 assets | run for the first time after development ended; the reference for the final figures |
| Real artwork | three sheets from the public preview images of one third-party pixel-art pack, which are not redistributed here: furniture packed edge to edge, a 16px icon grid, walls and doors | no ground truth; judged by a separate agent |
| Behaviour tests | 15 small hand-drawn sheets, 40 checks | the contract of each command and edit op |

The generator (`test/gen.js`) paints every sprite itself and places it, so the owner of every pixel is known by construction. The slicer's output is never used as ground truth.

The ten families are gridgap (on a lattice with gaps), packed (outlined boxes touching), icons (one icon per cell plus label boxes), shadows (semi-transparent shadows), tileset (unoutlined terrain plus props), upscaled (magenta background, 3x enlargement), checker (baked checkerboard background), nooutline (unoutlined art touching), offgrid (touching, no lattice) and loose (free placement, no lattice).

### Scoring

An asset is correct only when one predicted object owns exactly its pixels and nothing else. Failures are classed as merged with another asset, split across several objects, or both. Shadow pixels are scored separately. The headline figure is the family mean, each family counting once, so a single large sheet cannot dominate.

### Baselines

Plain connected components (`detect --no-split`) stands for a ten-line script or an editor's auto-slice. Grid import makes one sprite per occupied lattice cell, as an editor's grid import does; it applies only to the 8 families that have a lattice.

### Agent runs

The end-to-end runs used Claude agents as first-time users of the skill. Each fresh agent got the path of the skill folder, a sheet, and one line of pack description, and was asked to cut the sheet into assets. It read `SKILL.md` and carried on through export. Afterwards its work folder was scored against the ground truth, which was kept out of its reach. There were 35 runs over three rounds: 29 on synthetic sheets with ground truth and 6 on real sheets. 26 used the default session model, 4 used Sonnet and 5 used Haiku.

### Reviews

The code and documents were also reviewed, each pass by a separate agent:

- an adversarial review of the prototype, including a 180-case PNG round trip
- a full read of the four scripts, with hand-made PNGs for paths the benchmark does not reach
- about 200 careless or hostile commands
- a check of the skill documents against Anthropic's skill-authoring guidance
- a downstream consumer that received only an exported pack and built an HTML5 canvas inventory and room layout from it
- a validity review of which claims the numbers support
- a regression check of the prototype review's findings

18 of the 81 findings from the second review were reproduced by another agent: 15 confirmed, 3 partly.

## Results

### Script alone, held-out set

| Family | Tile size given | No tile size | Connected components | Grid import |
|---|---|---|---|---|
| offgrid | 100.0% | 100.0% | 6.3% | n/a |
| upscaled | 95.9% | 95.9% | 22.7% | 24.5% |
| packed | 93.5% | 93.5% | 19.1% | 17.2% |
| tileset | 90.9% | 36.4% | 36.4% | 100.0% |
| nooutline | 88.2% | 39.5% | 21.7% | 19.1% |
| shadows | 86.8% | 86.8% | 86.8% | 27.6% |
| loose | 84.4% | 84.4% | 84.4% | n/a |
| checker | 82.1% | 82.1% | 82.1% | 30.3% |
| gridgap | 79.9% | 79.9% | 79.9% | 28.5% |
| icons | 59.7% | 59.7% | 50.2% | 100.0% |
| Family mean | 86.2% | 75.8% | 49.0% | 43.4% (8 families) |

Giving the tile size moves tileset and nooutline by about 50 points. That is why the skill tells Claude to find the tile size in the pack description.

On gridgap, checker, loose and shadows the script and plain connected components score the same. Those sheets have gaps between assets, so there is nothing for the splitting stage to do, and the remaining misses are all multi-piece assets.

On icons and tileset a grid import scores 100%. The skill reaches the same result with a `cells` or `tiles` op, but if those are the only sheets you handle, the grid import is cheaper.

By how the asset is drawn:

| | Single-piece assets | Multi-piece assets |
|---|---|---|
| Script, tile size given | 2,737 / 2,774 = 98.7% | 3 / 445 = 0.7% |
| Script, no tile size | 2,416 / 2,774 = 87.1% | 3 / 445 = 0.7% |
| Connected components | 1,596 / 2,774 = 57.5% | 0 / 445 = 0% |

So the script-alone figure mostly reflects how many multi-piece assets the generator draws (445 of 3,219 here). The script gets single-piece assets right and leaves multi-piece ones to the review loop.

Shadows: 88 to 93% of shadow pixels went to the right owner, and 40 to 54% of shadowed assets had every shadow pixel right. Solid pixels are unaffected.

### Development set, first prototype against final

| | Pooled | Family mean |
|---|---|---|
| First prototype | 73.8% | 61.6% |
| Final | 82.9% | 86.3% |

The pooled figure moves less because one large sheet holds 67.5% of the development assets. Four families improved: offgrid 4% to 100%, upscaled 17% to 98%, nooutline 18% to 82%, tileset 32% to 86%. The others did not change. The family mean is 86.3% on the development set and 86.2% on the held-out set, so the result is not fitted to particular seeds. It may still be fitted to the generator itself.

### Agent runs

| Round | Skill version | Sheets | Runs | Assets | Script alone | With agent |
|---|---|---|---|---|---|---|
| 1 | first package | development set | 13 | 1,059 | 80.2% | 96.1% |
| 2 | after first fixes | development set, other seeds | 9 | 755 | 80.3% | 95.2% |
| 3 | after second fixes | held-out set | 7 | 585 | 82.2% | 95.6% |

In round 3, five of the seven runs reached 100%. The other two were Haiku on gridgap (76.0%, no edits made) and Sonnet on shadows (96.9%).

Across all three rounds one ops file was rejected. No run reported changing the wrong object through a misread id.

Work per sheet fell as the script improved. A shadows sheet took 3 rounds and 44 ops in round 1; after shadow assignment was fixed it took 1 round and 12 ops in round 2, and 1 round and 6 ops in round 3.

By model: the default model reached 100% on 16 of its 20 runs with ground truth, and 86.7 to 92.1% on the other four. Sonnet scored 100% twice on icon sheets, 96.9% on shadows and 91.4% on a tileset, where it did not improve on the script. Haiku scored 100% twice on icon sheets. On three gap-separated prop sheets it made no edits and matched the script alone: asked whether two nearby pieces were one asset, it left them separate all three times, even after the hints were strengthened. That follows the skill's rule to leave pieces separate when unsure, so it is not a malfunction, but a stronger model suits that kind of sheet.

### Real artwork

No ground truth exists for these sheets, so a separate agent judged each result.

| Sheet | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Icons (84) | 84/84, 10 naming errors | 84/84, 4 naming errors in a check of all 84 names | |
| Furniture (256) | 98.5%, 1 suspected split, 11 debatable | | |
| Walls and doors | 46% | 97% (96 assets) | 98% (96 assets) |

The wall sheet failed in round 1 because the skill told Claude to cut walls with `tiles`. A 6px wall drawn across the middle of a grid line became 132 slivers of 3px. `tiles` now detects and refuses that outcome, and the instructions were changed.

Most of the 10 naming errors on the icon sheet came from review pages that tinted each object with its own colour, so grey tape was read as a beige sack. With contours only, errors fell to 4, all either marked low confidence or about colour words in a description.

### Naming

The only naming test with ground truth is 10 hand-drawn 16px icons, and all 10 were named correctly. The sample is small and the drawings are typical, so it does not generalise. On the 84 real icons the judging agent found 4 errors (4.8%).

### Other observations

The coverage check passed in all 35 agent runs. It proves that no pixel was lost or duplicated, not that the division was right.

A downstream consumer given the named icon pack built an inventory screen without opening a single image, and all 3,817 numeric fields of 219 assets matched the actual images. Given an unnamed pack of 209 furniture sprites, it had to write a separate script to find the sprite it wanted. Contact sheets were added to the export for that reason; that addition was not re-checked end to end.

Detection takes about 0.1 seconds per sheet, 1.3 seconds for a 2048px sheet with 5,106 objects, and 2.3 seconds for a 4096px sheet with 16,384 objects, whose export took 30 seconds.

An agent run (reading the skill, 8 to 15 review pages, editing, exporting) used about 150,000 tokens on average. In 8 of the 29 runs with ground truth no edits were needed or made; on a sheet the script already cut correctly, the review loop only adds the cost of checking, and which sheets those are cannot be known in advance.

## What was found and fixed

| Source | Findings | Reproduction |
|---|---|---|
| Independent review of the prototype | 15 (1 critical, 7 major) | run by the reviewer |
| 16 agents in agent round 1 | about 110 problems with the documents and tools | n/a |
| Second review, 6 angles | 81 | 18 checked: 15 confirmed, 3 partly confirmed, 0 refuted |
| Behaviour tests | 2 | reproduced directly |
| Agents in rounds 2 and 3 | no blockers; findings centred on hints and decision rules | n/a |

The fixes with the most effect, in order:

1. Export could overwrite the user's files. With `--out` pointing at the folder holding the source sheet, it overwrote `sheet.png` and deleted other files under `sprites/`. A non-empty folder that the tool did not create is now refused.
2. On sheets filled to the edges, black outlines were taken for background. On a sheet with only 1px gaps every outline was erased and the run still reported success. Background detection now requires solid areas and lets colours vouch for each other only when their sizes are similar; thin background is accepted by a separate rule.
3. Simple images were taken for enlargements. A 64px image with few edges was read as an 8x enlargement and reduced to 7px. A scale is now accepted only with at least 12 colour-change positions per axis, and `--scale` overrides it.
4. A strip at the right and bottom edges was missing from every review page when the sheet width was not a multiple of the page width.
5. Packed sheets were classed as scenes because they are one blob before splitting. The scene check now counts objects after splitting.
6. Walls drawn across grid lines were cut into slivers (see real artwork above).
7. Review page tinting distorted colours (see real artwork above).
8. A connected shadow band was given whole to one object. Assigning to the object above first, pixel by pixel, raised shadow pixel accuracy from 68% to 88 to 93%.
9. Transparent gaps in a nearly opaque sheet were treated as artwork, and `--bg` was ignored when any transparent pixel existed.
10. Smaller fixes: mistyped options were silently ignored, a bad `--page` value corrupted the work folder, `split` moved another object's shadow and issued duplicate ids, stale ops files passed after a rerun of `detect`, 1px diagonals were silently cut at grid lines, and a checksum error in an ancillary PNG chunk was treated as fatal.

Two rules were withdrawn after they misfired on real artwork; see the end of [DESIGN.md](DESIGN.md).

## Threats to validity

1. Every sheet with ground truth comes from one generator: 12 palettes in three shades each, pure black outlines, one 16px tile size, one 3x enlargement. That art is far cleaner than commercial pixel art, and the cleanliness favours the tool on exactly the axes it depends on, outline colour and lattice alignment.
2. The generator and the tool were built with each other in view. The 1 to 2px gaps inside multi-piece assets fall within the range of the `near` op, and pack descriptions such as "some icons are drawn as two loose pieces" hint at the answer. Real store pages are not that helpful.
3. Development was tuned on the development set. The four families that improved are the ones whose failures were seen and fixed. The held-out set differs only in seeds; it is the same generator.
4. Each agent case was run once, so the variance is unknown. Each model had about five runs.
5. Real artwork was three preview sheets from one pack by one artist, judged by an agent, not a person.
6. The evidence for naming is thin.
7. The generator and the scorer use the tool's own PNG codec, so a codec bug would appear identically in the ground truth and the prediction. The codec did pass a 180-case round trip in the prototype review.

These figures do not support claims about accuracy on commercial sheets, behaviour on other art styles, or naming in general.

## Open issues

| Item | State |
|---|---|
| Changes after round 3 | Stronger hints (colour-sharing pairs, the list of closest pairs, combined size) and the wording of decision rules 3 and 4 passed the behaviour tests and the benchmark, but were not checked with agent runs. |
| Seams without a lattice | Outline colour is matched with a tolerance of 28, so a dark band close to the outline colour inside a sprite can be cut. Coloured outlines (selout) are not recognised as seams. |
| Tile size inference | Not statistically rigorous. It is only blocked on sheets with fewer than 12 objects. |
| Speck absorption | A real 2x2 sprite can be absorbed into its neighbour. There is a warning and `split` to undo it. |
| Multi-piece hints | Piece pairs of different colours appear in no hint. |
| Shadows | No op corrects a shadow assignment. Overlapping shadows are divided approximately. |
| Overlapping assets | Two assets inside one outline cannot be separated. |
| Large sheets | On a sheet of more than 600 objects with nothing flagged, only 6 sample pages are drawn. When many objects are flagged there are still many pages. |
| Permissions | `SKILL.md` declares no `allowed-tools`, because it was not confirmed that the permission matcher accepts quoted paths. Each `node` command may ask for approval. |
| Work folder lock | None. The instructions say not to run two commands on one work folder at once. |
| Atlas | Some rectangles include a neighbour's pixels (2 of 209 assets on the real furniture sheet). They are marked; there is no repacking. |
| Engine output | TexturePacker JSON only. No Godot, Unity or Tiled exporter. |
| Animation | Frames are not grouped. |
| Node version | Run only on Node 24. |

## Next measurements

1. Build a real ground-truth set by hand-labelling 5 to 10 sheets from CC0 packs. This would reduce threats 1, 2, 3 and 5 at once and is the most valuable next step.
2. Run agents with neutral pack descriptions, either real store text or none at all.
3. Run each agent case three or more times to see the variance and the differences between models.
4. For gap-separated prop sheets, have the script itself point out pairs whose combined size matches the sheet's usual asset size. Four of the five agents in round 3 worked this out by hand.

## Reproducing

The benchmark rows can be reproduced from this repository:

```
node test/gen.js .bench/cases
node test/gen.js .bench/heldout 71,72,73,74
node test/bench.js .bench/heldout .bench/runs --mode hint
node test/bench.js .bench/heldout .bench/runs --mode auto
node test/bench.js .bench/heldout .bench/runs --mode nosplit
node test/bench.js .bench/heldout .bench/runs --mode gridcell
node test/bench.js .bench/cases .bench/runs --mode hint
```

The last line gives the final development-set figures. The first-prototype figures, the agent runs, the real-artwork judgements and the reviews are not reproducible from the repository: they depend on model behaviour, and the real sheets are not included.
