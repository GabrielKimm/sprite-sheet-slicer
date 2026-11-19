'use strict';
// Command-line entry point of the slicer: detect, review, apply, export and status.
// A work dir holds native.png (the sheet at native scale, background made
// transparent), labels.bin (one Int32 object id per pixel) and state.json.
// Commands do not lock the work dir, so run one at a time on it.
const fs = require('fs');
const path = require('path');
const png = require('./png');
const core = require('./core');
const draw = require('./draw');

const UNIT_PX = 16; // ruler and paging step on a sheet without a lattice
const PAGE_PX = 1100;
const PAGE_ROOM = PAGE_PX - 40; // 40px left for rulers

const USAGE = `sprite-sheet slicer

  node sheet.js detect <sheet.png> --work DIR [--tile N|none] [--bg rrggbb[,rrggbb]] [--pockets all|large|keep] [--scale N] [--no-split]
      Find the objects. Rerunning detect on the same DIR starts the sheet over;
      revision numbers keep counting up so older ops and names files are refused.
      --tile N       lattice pitch in native pixels, from the pack description
      --tile none    the pack has no grid: do not try to infer one
      --bg           name the background colour(s) outright
      --pockets      background-coloured areas fenced in by artwork:
                     all = remove every one, large = only those of 16px or more, keep = none
      --scale N      the image is an N-times enlargement (1 = it is not); overrides the automatic check
      --no-split     plain connected components only, no cutting of touching objects

  node sheet.js review --work DIR [--zoom K] [--page PX] [--focus | --all] [--ids 4,9,12]
      Render numbered review pages to DIR/pages and write DIR/objects.json.
      --zoom K       screen pixels per sheet pixel, 1 to 16 (default: fit the sheet on one page, else 4)
      --page PX      longest side of a page image in screen pixels (default 1100)
      --focus        render only pages that contain flagged objects
      --all          render every page even on a very large sheet
      --ids          render one enlarged page around these objects only, as pages/focus_*.png;
                     the other pages and objects.json are left as they are

  node sheet.js apply --work DIR --ops FILE
      Apply edit ops: merge, near, cells, cut, tiles, split, drop, restore, ok.

  node sheet.js export --work DIR --out DIR [--names FILE] [--pad auto|cell|none] [--force]
      Write sprites/, sheet.png, atlas.json, assets.json, ASSETS.md and contact sheets.
      --names        optional; without it every asset keeps a generated name
      --pad          auto = tiles as whole cells, other objects cropped tight (default)
                     cell = every sprite padded to whole cells, none = everything cropped tight
      --force        allow an out dir that is not empty and was not created by this tool

  node sheet.js status --work DIR [--list]
      Print revision, counts and warnings; --list adds one line per object.
`;

// per command: option name -> 1 when it takes a value, 0 for a switch
const FLAGS = {
  detect: { work: 1, tile: 1, bg: 1, pockets: 1, scale: 1, 'no-split': 0 },
  review: { work: 1, zoom: 1, page: 1, ids: 1, focus: 0, all: 0 },
  apply: { work: 1, ops: 1 },
  export: { work: 1, out: 1, names: 1, pad: 1, force: 0 },
  status: { work: 1, list: 0 },
};
function parseArgs(argv) {
  const args = { _: [] };
  const cmd = argv.find((t) => !t.startsWith('-'));
  const known = FLAGS[cmd] || {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('-')) {
      args._.push(t);
      continue;
    }
    if (t === '--help' || t === '-h') {
      args.help = true;
      continue;
    }
    if (!t.startsWith('--'))
      throw new Error(`unknown option "${t}" (options start with two dashes; run with --help)`);
    const eq = t.indexOf('=');
    const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
    if (!(name in known))
      throw new Error(
        `unknown option "--${name}"${cmd ? ` for ${cmd}` : ''}. Known: ${
          Object.keys(known)
            .map((k) => '--' + k)
            .join(', ') || 'none'
        }`,
      );
    if (!known[name]) args[name] = true;
    else {
      const v = eq >= 0 ? t.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '' || (eq < 0 && v.startsWith('--')))
        throw new Error(`--${name} needs a value`);
      args[name] = v;
    }
  }
  return args;
}
const need = (args, name) => {
  if (!args[name]) throw new Error(`missing --${name} (run with --help for usage)`);
  return args[name];
};
const int = (v, name, lo, hi) => {
  if (!/^-?\d+$/.test(String(v)) || +v < lo || +v > hi)
    throw new Error(`--${name} must be a whole number from ${lo} to ${hi}, got "${v}"`);
  return +v;
};
const readJson = (file, what) => {
  let text;
  try {
    text = fs.readFileSync(file);
  } catch (e) {
    throw new Error(`cannot read ${what} ${file}`);
  }
  if (
    text.length >= 2 &&
    ((text[0] === 0xff && text[1] === 0xfe) || (text[0] === 0xfe && text[1] === 0xff))
  )
    throw new Error(
      `${what} ${file} is UTF-16. Save it as UTF-8 (the Write tool does; PowerShell's > and Out-File do not by default).`,
    );
  try {
    return JSON.parse(text.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`${what} ${file} is not valid JSON: ${e.message}`);
  }
};

function load(work) {
  if (!fs.existsSync(path.join(work, 'state.json')))
    throw new Error(`${work} is not a work dir (no state.json). Run detect first.`);
  const state = readJson(path.join(work, 'state.json'), 'state');
  const img = png.read(path.join(work, 'native.png'));
  const buf = fs.readFileSync(path.join(work, 'labels.bin'));
  const labels = new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  return { state, img, labels };
}
function save(work, state, labels) {
  fs.writeFileSync(
    path.join(work, 'labels.bin'),
    Buffer.from(labels.buffer, labels.byteOffset, labels.byteLength),
  );
  fs.writeFileSync(path.join(work, 'state.json'), JSON.stringify(state, null, 1));
}
function softMask(img, state) {
  const soft = new Uint8Array(img.width * img.height);
  if (state.background.softRatio >= core.SOFT_MIN_RATIO)
    for (let i = 0; i < soft.length; i++)
      soft[i] = img.data[i * 4 + 3] > 0 && img.data[i * 4 + 3] < 255 ? 1 : 0;
  return soft;
}
// objects indexed by id; null for ids that no longer label any pixel
function objects(img, labels, state) {
  let max = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i];
  return core.collect(img, labels, max, softMask(img, state)).map((o) => (o && o.area ? o : null));
}
const outlineOf = (state) => ({
  key: parseInt(state.outline.color.slice(1), 16) >>> 0,
  share: state.outline.rimShare,
});
const body = (o) => [o.sx0, o.sy0, o.sx1 - o.sx0 + 1, o.sy1 - o.sy0 + 1];
// [col0, row0, col1, row1] of the cells the solid body touches, inclusive
const bodyCells = (o, T) => [
  Math.floor(o.sx0 / T),
  Math.floor(o.sy0 / T),
  Math.floor(o.sx1 / T),
  Math.floor(o.sy1 / T),
];
// ids of the objects whose body lies inside a single cell, grouped by that cell
function groupBySingleCell(list, T) {
  const byCell = new Map();
  for (const o of list) {
    const [c0, r0, c1, r1] = bodyCells(o, T);
    if (c0 !== c1 || r0 !== r1) continue;
    const k = r0 * 65536 + c0;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(o.id);
  }
  return [...byCell.values()];
}
const liveCount = (labels, state) => {
  let n = 0;
  for (const id of new Set(labels)) if (id && !state.dropped[id]) n++;
  return n;
};

// ------------------------------------------------------------------ detect ----
function parseBgColours(list) {
  return list.split(',').map((s) => {
    const digits = s.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(digits))
      throw new Error(`--bg: "${s}" is not a colour like ff00ff`);
    return parseInt(digits.length === 6 ? digits + 'ff' : digits, 16) >>> 0;
  });
}

// An object that fills exactly one cell and is not fenced by an outline is terrain.
function terrainTiles(img, objs, tile, outline) {
  const w = img.width;
  const kinds = {};
  for (const o of objs) {
    if (
      !o ||
      o.softArea ||
      o.area !== tile * tile ||
      o.x0 % tile ||
      o.y0 % tile ||
      o.x1 - o.x0 + 1 !== tile ||
      o.y1 - o.y0 + 1 !== tile
    )
      continue;
    let rim = 0;
    let dark = 0;
    for (let t = 0; t < tile; t++)
      for (const i of [
        o.y0 * w + o.x0 + t,
        o.y1 * w + o.x0 + t,
        (o.y0 + t) * w + o.x0,
        (o.y0 + t) * w + o.x1,
      ]) {
        rim++;
        if (core.key(img.data, i * 4) === outline.key) dark++;
      }
    if (dark * 2 < rim) kinds[o.id] = 'tile';
  }
  return kinds;
}

function detectWarnings({
  mask,
  pixelScale,
  w,
  h,
  count,
  scene,
  biggest,
  artwork,
  softResult,
  absorbed,
}) {
  const warnings = [];
  const warn = (code, text) => warnings.push({ code, text });
  if (!count)
    warn(
      'empty',
      'no artwork found: the image is fully transparent, a single flat colour, or everything was taken for background. Check --bg.',
    );
  if (mask.mode === 'none')
    warn(
      'no_background',
      'opaque image and no background colour could be identified: everything is treated as artwork. Read the image, find the background colour and rerun detect with --bg rrggbb.',
    );
  if (mask.bgAbsent.length)
    warn(
      'bg_absent',
      `--bg named ${mask.bgAbsent.join(', ')}, which does not occur in the image${pixelScale.scale > 1 ? ' at native scale' : ''}. Check the colour value.`,
    );
  if (mask.bgColorInsideArt > 0.02)
    warn(
      'bg_in_art',
      'the background colour also occurs inside the artwork: edges touching the background may have been eaten. A transparent source would be safer.',
    );
  if (mask.pockets)
    warn(
      'pockets',
      `${mask.pockets} enclosed region(s) of background colour (${mask.pocketPixels}px) were removed as background (policy "${mask.pocketPolicy}"). If sprites show holes on the review pages, rerun detect with --pockets large or --pockets keep.`,
    );
  if (scene)
    warn(
      'scene',
      `only ${count} object(s) and one of them holds ${((100 * biggest) / artwork).toFixed(0)}% of the artwork pixels: this looks like a composed scene or a single large sprite, not a sheet of separate assets. Read the image and decide.`,
    );
  if (pixelScale.scale > 1 && !pixelScale.forced)
    warn(
      'scale',
      `the image was read as a x${pixelScale.scale} enlargement and reduced to ${w}x${h}; --tile and all positions are in those native pixels. If it is not an enlargement, rerun detect with --scale 1.`,
    );
  if (mask.faintPixels)
    warn(
      'faint',
      `${mask.faintPixels} nearly invisible pixel(s) (alpha 12 or less) were treated as transparent. Nothing to do unless artwork is missing.`,
    );
  if (softResult.orphans)
    warn(
      'shadow_only',
      `${softResult.orphans} object(s) consist of semi-transparent pixels only (glow, smoke, glass, or a shadow whose caster is elsewhere).`,
    );
  if (absorbed.length)
    warn(
      'absorbed',
      `${absorbed.length} speck(s) of under ${core.SPECK_AREA} pixels were merged into the object next to them (listed in state.json under "absorbed"). If one was a real tiny sprite, use split on the object that took it.`,
    );
  return warnings;
}

function detect(args) {
  const file = args._[1];
  if (!file) throw new Error('detect needs the sheet path (run with --help for usage)');
  const work = need(args, 'work');
  if (!fs.existsSync(file)) throw new Error(`cannot find ${file}`);
  const original = png.read(file);
  const pixelScale = args.scale
    ? { scale: int(args.scale, 'scale', 1, 16), ox: 0, oy: 0, confidence: 1, forced: true }
    : core.detectScale(original);
  const img = core.downsample(original, pixelScale);
  const { width: w, height: h } = img;
  const bgColors = args.bg ? parseBgColours(args.bg) : null;
  if (args.pockets && !['all', 'large', 'keep'].includes(args.pockets))
    throw new Error('--pockets must be all, large or keep');
  let tile = null;
  let tileSource = 'none';
  if (args.tile === 'none') tileSource = 'none (as asked)';
  else if (args.tile) {
    tile = int(args.tile, 'tile', 2, Math.max(2, Math.min(w, h)));
    tileSource = 'argument';
  }
  const mask = core.buildMask(img, { pockets: args.pockets || null, bgColors });
  // background becomes real transparency
  for (let i = 0; i < w * h; i++) if (!mask.fg[i]) img.data.fill(0, i * 4, i * 4 + 4);
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = mask.fg[i] && !mask.soft[i] ? 1 : 0;
  const plain = core.label(solid, w, h);
  const plainComponents = plain.comps.length - 1;
  const outline = core.outlineColor(img, solid);
  const grid = core.gridEvidence(plain.comps, w, h);
  if (!tile && args.tile !== 'none') {
    // inference needs a crowd: a few objects line up with any lattice by accident
    const inferred =
      plainComponents >= 12
        ? grid.filter((g) => g.divides && g.z >= 6 && g.zFresh >= 4).sort((x, y) => x.T - y.T)[0]
        : null;
    tile = inferred ? inferred.T : null;
    tileSource = inferred ? 'inferred' : 'none';
  }
  let labels = plain.labels;
  let count = plainComponents;
  let edges = [];
  let seams = [];
  if (!args['no-split']) {
    if (tile) {
      const split = core.splitOnLattice(img, labels, tile, outline);
      labels = split.labels;
      count = split.count;
      edges = split.edges;
    } else if (outline.share >= core.OUTLINED_MIN_SHARE) {
      // no lattice to lean on: cut wherever two outlines run side by side
      const walls = core.seamWalls(img, solid, outline);
      if (walls.seams.length) {
        labels = core.label(solid, w, h, walls).labels;
        core.healSlivers(img, labels, walls, outline);
        count = core.compact(labels);
        seams = core.effectiveSeams(labels, walls.seams, w);
      }
    }
  }
  const absorbed = core.absorbSpecks(labels, core.collect(img, labels, count, mask.soft), w, h);
  count = core.compact(labels);
  const softResult = core.attachSoft(labels, mask.soft, w, h, count + 1);
  count = softResult.nextId - 1;
  const objs = core.collect(img, labels, count, mask.soft);
  // A scene is judged on the finished cut, not on raw connectivity: a sheet packed
  // edge to edge is one connected blob before cutting and many objects after.
  const artwork = objs.reduce((s, o) => s + (o ? o.area : 0), 0);
  const biggest = objs.reduce((m, o) => (o && o.area > m ? o.area : m), 0);
  const scene = count >= 1 && count <= 6 && biggest / artwork > 0.5 && biggest > 1024;
  const kinds = tile ? terrainTiles(img, objs, tile, outline) : {};
  const warnings = detectWarnings({
    mask,
    pixelScale,
    w,
    h,
    count,
    scene,
    biggest,
    artwork,
    softResult,
    absorbed,
  });
  let prevRev = -1;
  try {
    prevRev = readJson(path.join(work, 'state.json'), 'state').rev;
  } catch (e) {
    // no earlier detect in this work dir
  }
  const state = {
    source: path.basename(file),
    sourceSize: [original.width, original.height],
    pixelScale,
    nativeSize: [w, h],
    background: {
      mode: mask.mode,
      colors: mask.bgColors,
      candidates: mask.candidates,
      pockets: mask.pockets,
      pocketPixels: mask.pocketPixels,
      removedAsBackground: mask.removedAsBackground,
      softRatio: +mask.softRatio.toFixed(4),
      bgColorInsideArt: +mask.bgColorInsideArt.toFixed(4),
    },
    outline: {
      color: outline.hex,
      rimShare: +outline.share.toFixed(3),
      style: outline.share >= core.OUTLINED_MIN_SHARE ? 'outlined' : 'flat',
    },
    grid: { tile, source: tileSource, evidence: grid },
    diagnosis: { sheetKind: scene ? 'scene_or_single_object' : 'sheet' },
    warnings,
    detectStats: {
      connectedComponents: plainComponents,
      objects: count,
      cutOnLattice: edges.filter((e) => !e.joined).length,
      cutOnSeams: seams.length,
      specksAbsorbed: absorbed.length,
      shadowOnlyObjects: softResult.orphans,
      autoTiles: Object.keys(kinds).length,
    },
    ambiguousBorders: edges
      .filter((e) => e.ambiguous)
      .map((e) => ({
        orient: e.orient,
        pos: e.pos,
        cell: e.cell,
        cross: e.cross,
        same: e.same,
        outlineRun: e.outlineRun,
        diff: e.diff,
        joined: e.joined,
      })),
    seams,
    absorbed,
    rev: prevRev + 1,
    nextId: count + 1,
    dropped: {},
    kinds,
    acked: {},
    history: [],
  };
  fs.rmSync(path.join(work, 'pages'), { recursive: true, force: true });
  fs.rmSync(path.join(work, 'objects.json'), { force: true });
  fs.mkdirSync(work, { recursive: true });
  png.write(path.join(work, 'native.png'), img);
  save(work, state, labels);
  console.log(
    `detect ${state.source}: ${original.width}x${original.height}${pixelScale.scale > 1 ? ` (enlarged x${pixelScale.scale}, native ${w}x${h})` : ''}, revision ${state.rev}`,
  );
  console.log(
    `   background: ${mask.mode}${mask.bgColors.length ? ' ' + mask.bgColors.join(',') : ''} | art style: ${state.outline.style} | tile: ${tile ? tile + 'px (' + tileSource + ')' : tileSource} | kind: ${state.diagnosis.sheetKind}`,
  );
  console.log(
    `   ${count} objects (from ${plainComponents} connected blobs; ${state.detectStats.cutOnLattice + seams.length} cut(s) between touching objects${tile ? `, ${state.ambiguousBorders.length} lattice border(s) marked doubtful` : ''})`,
  );
  if (mask.removedAsBackground)
    console.log(`   ${mask.removedAsBackground} opaque pixel(s) were removed as background`);
  if (tileSource === 'inferred')
    console.log(
      `   note: tile ${tile} was inferred from how the objects line up. If the pack has no grid, rerun with --tile none; if it states another size, pass it.`,
    );
  if (tileSource === 'none')
    console.log(
      '   note: no tile size. If the pack description states one, rerun with --tile N. Without it the cells and tiles ops are unavailable.',
    );
  if (prevRev >= 0)
    console.log(
      `   note: this work folder was detected before. Revision numbering continues at ${state.rev}, so ops and names files written earlier are refused.`,
    );
  for (const wn of warnings) console.log('   WARNING: ' + wn.text);
}

// ------------------------------------------------------------------ review ----
// Sheets with more live objects than this skip the colour-pair search, which
// compares every object with its neighbours.
const MAX_OBJECTS_FOR_PAIRS = 6000;

function flagsFor(img, labels, state, live, closePairs) {
  const T = state.grid.tile;
  const flagged = new Map();
  const add = (id, f) => {
    if (state.acked[id] || state.dropped[id]) return;
    if (!flagged.has(id)) flagged.set(id, []);
    if (!flagged.get(id).includes(f)) flagged.get(id).push(f);
  };
  const exposed = core.exposedFill(img, labels, softMask(img, state), outlineOf(state));
  // size in cells; on a sheet without a lattice, in UNIT_PX square units
  const cellCount = (o) => {
    if (!T) return ((o.sx1 - o.sx0 + 1) * (o.sy1 - o.sy0 + 1)) / (UNIT_PX * UNIT_PX);
    const [c0, r0, c1, r1] = bodyCells(o, T);
    return (c1 - c0 + 1) * (r1 - r0 + 1);
  };
  const plain = live.filter((o) => state.kinds[o.id] !== 'tile');
  const sizes = plain.map(cellCount).sort((x, y) => x - y);
  const p90 = sizes[Math.floor(sizes.length * 0.9)] || 1; // what counts as a big object on this sheet
  for (const o of plain) {
    if ((exposed.get(o.id) || 0) >= 4) add(o.id, 'exposed_fill');
    if (o.area < core.SPECK_AREA) add(o.id, 'speck');
    if (plain.length >= 8 && cellCount(o) >= 12 && cellCount(o) >= 3 * p90) add(o.id, 'large_blob');
  }
  if (T) {
    for (const b of state.ambiguousBorders) {
      const [cx, cy] = b.cell;
      const r =
        b.orient === 'v'
          ? [b.pos - 1, cy * T, b.pos, cy * T + T - 1]
          : [cx * T, b.pos - 1, cx * T + T - 1, b.pos];
      for (let y = r[1]; y <= Math.min(img.height - 1, r[3]); y++)
        for (let x = r[0]; x <= Math.min(img.width - 1, r[2]); x++)
          if (labels[y * img.width + x]) add(labels[y * img.width + x], 'doubtful_border');
    }
    for (const ids of groupBySingleCell(plain, T))
      if (ids.length > 1) for (const id of ids) add(id, 'shares_cell');
  }
  for (const [x, y, gap] of closePairs)
    if (gap <= 2) {
      add(x, 'close_same_colours');
      add(y, 'close_same_colours');
    }
  return flagged;
}

// Pairs of nearby objects that share their colours: the usual sign of one asset
// drawn as loose pieces. Tiles are left out (neighbouring tiles always qualify).
// Each pair carries its gap and the size of the two bodies together.
function closeSamePalette(img, labels, state, objs) {
  const skip = { ...state.dropped };
  for (const id of Object.keys(state.kinds)) if (state.kinds[id] === 'tile') skip[id] = 1;
  const gaps = core.gapHistogram(labels, img.width, img.height, skip, softMask(img, state));
  // "shares its colours": one palette contains the other. A small piece often
  // lacks a shade band of the whole, so exact equality would miss it.
  const same = (p, q) => {
    const [s, l] = p.colors.size <= q.colors.size ? [p.colors, q.colors] : [q.colors, p.colors];
    return l.size < 9 && s.size >= 2 && [...s].every((c) => l.has(c));
  };
  const union = (p, q) =>
    `${Math.max(p.sx1, q.sx1) - Math.min(p.sx0, q.sx0) + 1}x${Math.max(p.sy1, q.sy1) - Math.min(p.sy0, q.sy0) + 1}`;
  const pairs = [];
  gaps.pairs.forEach((list, gap) => {
    for (const [x, y] of list)
      if (objs[x] && objs[y] && same(objs[x], objs[y]))
        pairs.push([x, y, gap, union(objs[x], objs[y])]);
  });
  // every pair at the closest distance that occurs, whatever its colours
  const g0 = gaps.hist.findIndex((c, g) => g > 0 && c > 0);
  const closest = g0 > 0 ? gaps.pairs[g0].map(([x, y]) => `${x}+${y}`) : [];
  return { hist: gaps.hist, pairs, closestGap: g0, closest };
}

function flagObjects(img, labels, state, objs, live) {
  const close =
    live.length <= MAX_OBJECTS_FOR_PAIRS ? closeSamePalette(img, labels, state, objs) : null;
  const flagged = flagsFor(img, labels, state, live, close ? close.pairs : []);
  return { close, flagged };
}

const pairLabel = ([x, y, gap, size]) => `${x}+${y}@${gap}px=${size}`;

function pageStarts(n, span, T) {
  if (n <= span) return [0];
  const overlap = span > 2 * T ? T : 0; // pages overlap by one cell when a page holds several
  const count = Math.max(2, Math.ceil((n - overlap) / (span - overlap)));
  const starts = [];
  for (let i = 0; i < count; i++) starts.push(Math.round(((n - span) * i) / (count - 1)));
  return [...new Set(starts)]; // the last start is exactly n - span, so the far edge is always covered
}

const overlaps = (o, reg) =>
  o.x1 >= reg.x && o.x0 < reg.x + reg.w && o.y1 >= reg.y && o.y0 < reg.y + reg.h;

// --ids: one enlarged page around the chosen objects; nothing else is touched
function reviewObjects(args, view) {
  const { state, img, labels, objs, pitch, room, drawOpts, dir } = view;
  const ids = args.ids.split(',').map((s) => int(s.trim(), 'ids', 1, 1e9));
  for (const id of ids)
    if (!objs[id] || state.dropped[id])
      throw new Error(`--ids: object ${id} does not exist in rev ${state.rev}`);
  const x0 = Math.max(0, Math.min(...ids.map((id) => objs[id].x0)) - pitch);
  const y0 = Math.max(0, Math.min(...ids.map((id) => objs[id].y0)) - pitch);
  const x1 = Math.min(img.width, Math.max(...ids.map((id) => objs[id].x1 + 1)) + pitch);
  const y1 = Math.min(img.height, Math.max(...ids.map((id) => objs[id].y1 + 1)) + pitch);
  const k = args.zoom
    ? int(args.zoom, 'zoom', 1, 16)
    : Math.max(1, Math.min(16, Math.floor(room / Math.max(x1 - x0, y1 - y0))));
  fs.mkdirSync(dir, { recursive: true });
  const pg = draw.page(img, labels, objs, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, k, {
    ...drawOpts,
    flagged: new Set(),
  });
  const name = `focus_${ids.slice(0, 6).join('_')}.png`;
  png.write(path.join(dir, name), pg.image);
  console.log(
    `review rev=${state.rev}: pages/${name} shows objects ${ids.join(', ')} at zoom ${k} (${pg.image.width}x${pg.image.height}px). The other pages and objects.json are unchanged.`,
  );
}

// The page regions to render. With focus on, only pages holding a flagged
// object; when nothing is flagged, an evenly spread sample of up to six pages.
function choosePages(regions, live, flagSet, focus) {
  if (!focus) return { chosen: regions, sampled: false };
  const chosen = regions.filter((reg) => live.some((o) => flagSet.has(o.id) && overlaps(o, reg)));
  if (chosen.length) return { chosen, sampled: false };
  const want = Math.min(6, regions.length);
  const sample = Array.from(
    { length: want },
    (_, i) => regions[Math.round((i * (regions.length - 1)) / Math.max(1, want - 1))],
  );
  return { chosen: [...new Set(sample)], sampled: true };
}

function writeObjectsJson(work, view, { k, live, flagged, flagSet, close, index, skipped }) {
  const { state, pitch, hasTile } = view;
  const row = (o) => {
    const r = { id: o.id, bbox: [o.x0, o.y0, o.x1 - o.x0 + 1, o.y1 - o.y0 + 1] };
    if (hasTile) r.cells = bodyCells(o, pitch);
    if (o.softArea) r.body = body(o);
    r.area = o.area;
    if (state.kinds[o.id]) r.kind = state.kinds[o.id];
    if (flagged.has(o.id)) r.flags = flagged.get(o.id);
    return r;
  };
  const full = live.length <= 3000;
  const head = {
    rev: state.rev,
    tile: state.grid.tile,
    rulerUnit: hasTile ? 'cell' : 'px',
    zoom: k,
    fields:
      'bbox = [x, y, width, height] in sheet pixels, shadow included. cells = [col0, row0, col1, row1] inclusive, of the solid body. body = solid part when a shadow makes bbox larger. kind = "tile" for terrain cells. flags: see SKILL.md.',
    counts: {
      objects: live.length,
      dropped: Object.keys(state.dropped).length,
      flagged: flagged.size,
      flagsByKind: countFlags(flagged),
    },
    dropped: state.dropped,
    hints: {
      objectsSharingACell: sharingACell(flagged).slice(0, 400).join(' '),
      pairsByGapPx: close
        ? { touching: close.hist[0], 1: close.hist[1], 2: close.hist[2], 3: close.hist[3] }
        : 'not computed (very large sheet)',
      closePairsSharingColours: close ? close.pairs.slice(0, 300).map(pairLabel).join(' ') : '',
      pairsAtClosestGap:
        close && close.closestGap > 0
          ? { gapPx: close.closestGap, pairs: close.closest.slice(0, 200).join(' ') }
          : null,
    },
    pagesNotRendered: skipped,
    pages: index,
    objectsListed: full ? 'all' : 'flagged only (more than 3000 objects)',
  };
  // one object per line keeps the file readable and easy to grep
  const lines = (full ? live : live.filter((o) => flagSet.has(o.id))).map(
    (o) => '  ' + JSON.stringify(row(o)),
  );
  fs.writeFileSync(
    path.join(work, 'objects.json'),
    JSON.stringify(head, null, 1).replace(
      /\n}$/,
      ',\n "objects": [\n' + lines.join(',\n') + '\n ]\n}\n',
    ),
  );
}

function countFlags(flagged) {
  const counts = {};
  for (const flags of flagged.values()) for (const f of flags) counts[f] = (counts[f] || 0) + 1;
  return counts;
}
const sharingACell = (flagged) =>
  [...flagged.entries()].filter(([, f]) => f.includes('shares_cell')).map(([id]) => id);

function printReviewSummary(
  view,
  { k, live, flagged, close, index, regions, skipped, focus, sampled },
) {
  const { state, pitch, hasTile } = view;
  console.log(
    `review rev=${state.rev}: ${live.length} objects, ${flagged.size} flagged, ${index.length} page(s) at zoom ${k}, ruler in ${hasTile ? `cells of ${pitch}px` : 'pixels'}`,
  );
  if (focus)
    console.log(
      sampled
        ? `   large sheet with nothing flagged: ${index.length} sample page(s) of ${regions.length} rendered. Use --all for every page or --ids to look at chosen objects.`
        : `   focus: ${skipped} page(s) without flagged objects were not rendered (--all renders them).`,
    );
  for (const p of index.slice(0, 30))
    console.log(
      `   ${p.file}  ${JSON.stringify(p.covers)}  objects=${p.objects} flagged=${p.flagged.length}`,
    );
  if (index.length > 30)
    console.log(`   ... ${index.length - 30} more page(s), listed in objects.json`);
  if (index.length > 1)
    console.log(
      '   pages overlap a little, so an object near a page edge appears on two pages with the same id',
    );
  const flagCounts = countFlags(flagged);
  if (Object.keys(flagCounts).length)
    console.log(
      '   flags: ' +
        Object.entries(flagCounts)
          .map(([f, c]) => `${f} ${c}`)
          .join(', '),
    );
  const sharing = sharingACell(flagged);
  if (sharing.length)
    console.log(
      `   hint: ${sharing.length} objects sit in a cell together with another object. On an icon grid that is one icon drawn in pieces, and one cells op joins them all. On a sheet of props check each pair first: it can also be two small props.`,
    );
  if (close) {
    const tight = close.pairs.filter((p) => p[2] <= 2);
    console.log(
      `   hint: neighbouring object pairs by gap (solid pixels, tiles left out): touching ${close.hist[0]}, 1px ${close.hist[1]}, 2px ${close.hist[2]}, 3px ${close.hist[3]}.`,
    );
    if (close.closestGap > 0 && close.closest.length <= 40)
      console.log(
        `   hint: the ${close.closest.length} pair(s) at the closest gap (${close.closestGap}px): ${close.closest.join(' ')}`,
      );
    if (close.pairs.length)
      console.log(
        `   hint: ${close.pairs.length} close pair(s) share their colours, ${tight.length} of them 2px apart or less${
          tight.length
            ? ': ' + tight.slice(0, 24).map(pairLabel).join(' ') + (tight.length > 24 ? ' ...' : '')
            : ''
        }. Written as a+b@gap=size of the two together. Such a pair is either one asset drawn as loose pieces or two alike assets side by side: when the size together matches the sheet's other assets, it is one (full list in objects.json under hints).`,
      );
  }
  const legend = ['coloured contour and number = one object and its id'];
  if (flagged.size) legend.push('white double box = flagged, worth a look');
  if (hasTile && state.ambiguousBorders.length)
    legend.push('magenta bar = lattice border where the cut-or-join decision was close');
  if (state.seams.length) legend.push('cyan dashes = seam the script cut');
  if (Object.keys(state.dropped).length) legend.push('dimmed art = dropped');
  console.log('   legend: ' + legend.join('; '));
}

function review(args) {
  const work = need(args, 'work');
  const { state, img, labels } = load(work);
  const objs = objects(img, labels, state);
  const live = objs.filter((o) => o && !state.dropped[o.id]);
  const hasTile = !!state.grid.tile;
  const pitch = state.grid.tile || UNIT_PX;
  const pagePx = args.page ? int(args.page, 'page', 240, 4000) : PAGE_PX;
  const room = pagePx - 40;
  const drawOpts = {
    tile: pitch,
    rulerPx: !hasTile,
    dropped: state.dropped,
    ambiguous: hasTile ? state.ambiguousBorders : [],
    seams: state.seams,
  };
  const dir = path.join(work, 'pages');
  const view = { state, img, labels, objs, hasTile, pitch, room, drawOpts, dir };
  if (args.ids) return reviewObjects(args, view);

  let k;
  if (args.zoom) k = int(args.zoom, 'zoom', 1, 16);
  else {
    const whole = Math.floor(room / Math.max(img.width, img.height));
    k = whole >= 3 ? Math.min(8, whole) : 4; // the whole sheet on one page when that leaves at least x3
  }
  const perPage = Math.floor(room / k);
  if (perPage < 8)
    throw new Error(
      `a ${pagePx}px page at zoom ${k} would show under 8 sheet pixels. Use a larger --page or a smaller --zoom.`,
    );
  const span = perPage >= pitch ? Math.floor(perPage / pitch) * pitch : perPage;
  const { close, flagged } = flagObjects(img, labels, state, objs, live);
  const flagSet = new Set(flagged.keys());
  const regions = [];
  for (const y of pageStarts(img.height, span, pitch))
    for (const x of pageStarts(img.width, span, pitch))
      regions.push({ x, y, w: Math.min(span, img.width - x), h: Math.min(span, img.height - y) });
  const focus = args.all ? false : args.focus ? true : live.length > 600;
  const { chosen, sampled } = choosePages(regions, live, flagSet, focus);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const index = [];
  for (const reg of chosen) {
    const pg = draw.page(img, labels, objs, reg, k, { ...drawOpts, flagged: flagSet });
    const name = `page_y${String(reg.y).padStart(4, '0')}_x${String(reg.x).padStart(4, '0')}.png`;
    png.write(path.join(dir, name), pg.image);
    const farX = reg.x + reg.w - 1;
    const farY = reg.y + reg.h - 1;
    index.push({
      file: 'pages/' + name,
      covers: hasTile
        ? {
            cells: [
              Math.floor(reg.x / pitch),
              Math.floor(reg.y / pitch),
              Math.floor(farX / pitch),
              Math.floor(farY / pitch),
            ],
          }
        : { px: [reg.x, reg.y, farX, farY] },
      objects: pg.ids.length,
      flagged: pg.ids.filter((id) => flagSet.has(id)),
    });
  }
  const skipped = regions.length - chosen.length;
  const result = { k, live, flagged, flagSet, close, index, regions, skipped, focus, sampled };
  writeObjectsJson(work, view, result);
  printReviewSummary(view, result);
}

// ------------------------------------------------------------------- apply ----
// Ops name objects by id and places by the ruler printed on the review pages.
// Every op is validated before it runs, and no op can create or lose artwork.
// A handler receives the op context, edits labels and state in place and returns
// its log line; ctx.fail(msg) aborts the whole ops file.

const shortList = (list, n = 12) =>
  list.length > n ? list.slice(0, n).join(', ') + `, ... (${list.length} in all)` : list.join(', ');

function relabel(labels, alias) {
  for (let p = 0; p < labels.length; p++)
    if (alias.has(labels[p])) labels[p] = alias.get(labels[p]);
}

// After a merge the group is an ordinary object unless every member was a tile;
// a checked mark no longer applies.
function settle(state, group, keep) {
  const allTiles = group.every((id) => state.kinds[id] === 'tile');
  for (const id of group) {
    delete state.acked[id];
    delete state.kinds[id];
  }
  if (allTiles) state.kinds[keep] = 'tile';
}

// An id whose pixels were handed to new ids keeps no kind and no checked mark.
function retire(state, id) {
  delete state.acked[id];
  delete state.kinds[id];
}

// Whether the body of o lies inside region [x0, y0, x1, y1], given in ruler units.
function insideRegion(o, region, T) {
  if (!region) return true;
  const u = T || 1;
  return (
    o.sx0 >= region[0] * u &&
    o.sy0 >= region[1] * u &&
    o.sx1 < (region[2] + 1) * u &&
    o.sy1 < (region[3] + 1) * u
  );
}

function onlyId({ op, ids, fail }) {
  if (ids.length !== 1) fail(`${op.op} needs exactly one "id"`);
  return ids[0];
}

function opMerge({ ids, state, labels, fail }) {
  if (ids.length < 2) fail('merge needs at least two different ids');
  const keep = Math.min(...ids);
  relabel(labels, new Map(ids.map((id) => [id, keep])));
  settle(state, ids, keep);
  return `merge ${ids.join(' + ')} -> ${keep}`;
}

function opDrop({ op, ids, state, fail }) {
  if (!ids.length) fail('drop needs ids');
  for (const id of ids) state.dropped[id] = typeof op.reason === 'string' ? op.reason : 'dropped';
  return `drop ${shortList(ids)} (${op.reason || 'no reason given'})`;
}

function opRestore({ ids, state, fail }) {
  if (!ids.length) fail('restore needs ids');
  for (const id of ids)
    if (!state.dropped[id])
      fail(
        `object ${id} is not dropped (dropped ids: ${Object.keys(state.dropped).join(', ') || 'none'})`,
      );
  for (const id of ids) delete state.dropped[id];
  return `restore ${shortList(ids)}`;
}

function opOk({ ids, state, fail }) {
  if (!ids.length) fail('ok needs ids');
  for (const id of ids) state.acked[id] = true;
  return `ok ${shortList(ids)}: checked, no longer flagged`;
}

// Undo for merge, cells and near: back to the object's connected pieces.
function opSplit(ctx) {
  const { objs, state, labels, soft, img, fail } = ctx;
  const w = img.width;
  const id = onlyId(ctx);
  const o = objs[id];
  const made = [];
  const pieceOf = new Map();
  const nextBefore = state.nextId;
  const own = [];
  for (let y = o.y0; y <= o.y1; y++)
    for (let x = o.x0; x <= o.x1; x++) if (labels[y * w + x] === id) own.push(y * w + x);
  // solid pixels, 8-connected within the object's box
  for (let y = o.y0; y <= o.y1; y++)
    for (let x = o.x0; x <= o.x1; x++) {
      const s = y * w + x;
      if (labels[s] !== id || soft[s] || pieceOf.has(s)) continue;
      const nid = state.nextId++;
      made.push(nid);
      const stack = [s];
      pieceOf.set(s, nid);
      while (stack.length) {
        const p = stack.pop();
        const px = p % w;
        const py = (p - px) / w;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < o.x0 || ny < o.y0 || nx > o.x1 || ny > o.y1) continue;
            const q = ny * w + nx;
            if (labels[q] === id && !soft[q] && !pieceOf.has(q)) {
              pieceOf.set(q, nid);
              stack.push(q);
            }
          }
      }
    }
  // the object's shadow pixels go to the nearest of its own pieces; no other object is touched
  let frontier = [...pieceOf.keys()];
  for (const [p, nid] of pieceOf) labels[p] = nid;
  while (frontier.length) {
    const next = [];
    for (const p of frontier)
      core.forEachNeighbour(p, w, labels.length, (q) => {
        if (labels[q] !== id) return;
        labels[q] = labels[p];
        next.push(q);
      });
    frontier = next;
  }
  // soft pixels that touch none of the pieces (a detached glow) become pieces of their own
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] !== id) continue;
    const nid = state.nextId++;
    made.push(nid);
    const stack = [p];
    labels[p] = nid;
    while (stack.length)
      core.forEachNeighbour(stack.pop(), w, labels.length, (q) => {
        if (labels[q] !== id) return;
        labels[q] = nid;
        stack.push(q);
      });
  }
  if (made.length < 2) {
    for (const p of own) labels[p] = id;
    state.nextId = nextBefore;
    fail(`object ${id} is a single connected piece; use cut to divide it`);
  }
  retire(state, id);
  return `split ${id} -> ${made.join(', ')}. Id ${id} is retired.`;
}

// A position read off a picture is approximate: look 3px either side of px for
// the strongest seam, judged on solid pixels; each piece must keep 2px.
// Returns the chosen line and how it was found.
function seamNear(ctx, id, lo, hi) {
  const { op, objs, state, labels, soft, img, fail } = ctx;
  const w = img.width;
  const o = objs[id];
  const missed = `a cut at ${op.axis}=${op.px}px would leave a piece under 2px, or misses object ${id}, which spans ${lo}..${hi}px`;
  if (op.px < lo + 2 || op.px > hi - 1) fail(missed);
  const outlineKey = outlineOf(state).key;
  const len = op.axis === 'x' ? o.y1 - o.y0 + 1 : o.x1 - o.x0 + 1;
  let best = -1;
  let bestScore = -Infinity;
  for (let c = Math.max(lo + 2, op.px - 3); c <= Math.min(hi - 1, op.px + 3); c++) {
    let score = 0;
    for (let t = 0; t < len; t++) {
      const i1 = op.axis === 'x' ? (o.y0 + t) * w + c - 1 : (c - 1) * w + o.x0 + t;
      const i2 = op.axis === 'x' ? (o.y0 + t) * w + c : c * w + o.x0 + t;
      if (labels[i1] !== id || labels[i2] !== id || soft[i1] || soft[i2]) continue;
      const k1 = core.key(img.data, i1 * 4);
      const k2 = core.key(img.data, i2 * 4);
      score += k1 === outlineKey && k2 === outlineKey ? 2 : k1 !== k2 ? 1 : -2;
    }
    if (
      score > bestScore ||
      (score === bestScore && Math.abs(c - op.px) < Math.abs(best - op.px))
    ) {
      bestScore = score;
      best = c;
    }
  }
  if (bestScore <= 0)
    return {
      line: op.px,
      how: `px ${op.px} (no seam found within 3px, so the cut is exactly there)`,
    };
  return {
    line: best,
    how: `px ${op.px}${best !== op.px ? ` (moved to the seam at ${best})` : ' (on a seam)'}`,
  };
}

function opCut(ctx) {
  const { op, objs, state, labels, img, T, fail } = ctx;
  const w = img.width;
  if (!['x', 'y'].includes(op.axis))
    fail(
      'cut needs axis "x" (vertical line, pieces side by side) or "y" (horizontal line, pieces stacked)',
    );
  const id = onlyId(ctx);
  const o = objs[id];
  const lo = op.axis === 'x' ? o.x0 : o.y0;
  const hi = op.axis === 'x' ? o.x1 : o.y1;
  let lines;
  let how;
  const cellList = Array.isArray(op.cells) ? op.cells : op.cell !== undefined ? [op.cell] : null;
  if (cellList) {
    if (!T) fail('this sheet has no tile grid: give the position as "px" read off the pixel ruler');
    if (!cellList.length || !cellList.every(Number.isInteger))
      fail('"cell" / "cells" must be whole cell indices');
    lines = [...new Set(cellList)].sort((p, q) => p - q).map((c) => c * T);
    how = `cell ${cellList.join(', ')}`;
  } else if (Number.isInteger(op.px)) {
    const found = seamNear(ctx, id, lo, hi);
    lines = [found.line];
    how = found.how;
  } else
    fail(
      'cut needs "cell" or "cells" (lattice sheets) or a whole-number "px" (read off a pixel ruler)',
    );
  for (const line of lines)
    if (line <= lo || line > hi)
      fail(
        `line ${op.axis}=${line}px${T ? ` (cell ${line / T})` : ''} does not pass through object ${id}, which spans ${lo}..${hi}px${T ? ` (cells ${Math.floor(lo / T)}..${Math.floor(hi / T)}); a cut line must start a cell after the object's first` : ''}`,
      );
  const pieceIds = lines.map(() => state.nextId++);
  pieceIds.push(state.nextId++);
  const counts = pieceIds.map(() => 0);
  for (let y = o.y0; y <= o.y1; y++)
    for (let x = o.x0; x <= o.x1; x++)
      if (labels[y * w + x] === id) {
        const v = op.axis === 'x' ? x : y;
        let piece = 0;
        while (piece < lines.length && v >= lines[piece]) piece++;
        labels[y * w + x] = pieceIds[piece];
        counts[piece]++;
      }
  retire(state, id);
  return `cut ${id} at ${op.axis} ${how} -> ${pieceIds.filter((_, p) => counts[p]).join(', ')} (${op.axis === 'x' ? 'left to right' : 'top to bottom'}). Id ${id} is retired. A piece may still hold several assets: check the new page.`;
}

function opTiles({ op, ids, objs, state, labels, img, T, fail }) {
  const w = img.width;
  if (!T) fail('no tile size: rerun detect with --tile N');
  if (!ids.length) fail('tiles needs ids');
  const span = op.span || [1, 1];
  if (
    !(Array.isArray(span) && span.length === 2 && span.every((v) => Number.isInteger(v) && v >= 1))
  )
    fail('"span" must be [columns, rows], each 1 or more');
  const plan = [];
  let slivers = 0;
  let pieces = 0;
  for (const id of ids) {
    const o = objs[id];
    const c0 = Math.floor(o.x0 / T);
    const r0 = Math.floor(o.y0 / T);
    const groups = new Map();
    for (let y = o.y0; y <= o.y1; y++)
      for (let x = o.x0; x <= o.x1; x++) {
        if (labels[y * w + x] !== id) continue;
        const gk =
          Math.floor((((y / T) | 0) - r0) / span[1]) * 65536 +
          Math.floor((((x / T) | 0) - c0) / span[0]);
        let g = groups.get(gk);
        if (!g) {
          g = { px: [], x0: x, x1: x, y0: y, y1: y };
          groups.set(gk, g);
        }
        g.px.push(y * w + x);
        if (x < g.x0) g.x0 = x;
        if (x > g.x1) g.x1 = x;
        if (y < g.y0) g.y0 = y;
        if (y > g.y1) g.y1 = y;
      }
    for (const g of groups.values()) {
      pieces++;
      // a sliver: a piece under a quarter tile thick that ends exactly on a
      // lattice line, i.e. artwork that straddles the line and got halved
      const thinX = g.x1 - g.x0 + 1 < T / 4 && (g.x0 % T === 0 || (g.x1 + 1) % T === 0);
      const thinY = g.y1 - g.y0 + 1 < T / 4 && (g.y0 % T === 0 || (g.y1 + 1) % T === 0);
      if (thinX || thinY) slivers++;
    }
    plan.push({ id, groups });
  }
  if (slivers > 0 && slivers >= 0.1 * pieces && op.force !== true)
    fail(
      `${slivers} of the ${pieces} pieces would be slivers under ${T / 4}px thick lying against a lattice line. The artwork straddles the lattice (walls centred on a grid line, for example), so cutting per cell halves it. Leave these objects whole, or cut them where the pieces really end; add "force": true only if slivers are what you want`,
    );
  const made = [];
  for (const { id, groups } of plan) {
    retire(state, id);
    for (const g of groups.values()) {
      const nid = state.nextId++;
      for (const p of g.px) labels[p] = nid;
      state.kinds[nid] = 'tile';
      made.push(nid);
    }
  }
  return `tiles ${shortList(ids)} -> ${made.length} tile(s) of ${span[0] * T}x${span[1] * T}px, new ids ${made[0]}..${made[made.length - 1]} (per object, in reading order). The listed ids are retired.`;
}

function opCells({ op, ids, objs, state, labels, T, fail }) {
  if (!T) fail('no tile size: rerun detect with --tile N');
  if (ids.length) fail('cells takes no ids; limit it with "region" if needed');
  // objects whose body spans several cells are left alone
  const candidates = objs.filter((o) => o && !state.dropped[o.id] && insideRegion(o, op.region, T));
  const alias = new Map();
  const groups = [];
  for (const list of groupBySingleCell(candidates, T)) {
    if (list.length < 2) continue;
    const keep = Math.min(...list);
    groups.push(list.join('+'));
    for (const id of list) alias.set(id, keep);
    settle(state, list, keep);
  }
  relabel(labels, alias);
  return `cells: ${groups.length} cell(s) had several pieces, now one object each (kept the smallest id): ${shortList(groups, 30)}`;
}

function opNear({ op, ids, objs, state, labels, soft, img, T, fail }) {
  const { width: w, height: h } = img;
  if (!(Number.isInteger(op.px) && op.px >= 0 && op.px <= 4))
    fail('near needs "px" from 0 to 4 (the widest gap to bridge)');
  if (op.smallerThan !== undefined && !(Number.isInteger(op.smallerThan) && op.smallerThan >= 2))
    fail('"smallerThan" must be a whole number of pixels, 2 or more');
  const eligible = new Set();
  for (const o of objs)
    if (
      o &&
      !state.dropped[o.id] &&
      insideRegion(o, op.region, T) &&
      (!ids.length || ids.includes(o.id))
    )
      eligible.add(o.id);
  const size = (id) => Math.max(objs[id].sx1 - objs[id].sx0, objs[id].sy1 - objs[id].sy0) + 1;
  const parent = new Map();
  const find = (x) => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const reach = op.px + 1;
  const joined = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const la = labels[y * w + x];
      if (!eligible.has(la) || soft[y * w + x]) continue;
      for (let dy = 0; dy <= reach; dy++)
        for (let dx = dy === 0 ? 1 : -reach; dx <= reach; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          const lb = labels[ny * w + nx];
          if (lb === la || !eligible.has(lb) || soft[ny * w + nx]) continue;
          if (op.smallerThan && Math.min(size(la), size(lb)) >= op.smallerThan) continue;
          const ra = find(la);
          const rb = find(lb);
          if (ra !== rb) {
            parent.set(Math.max(ra, rb), Math.min(ra, rb));
            joined.push(`${la}+${lb}`);
          }
        }
    }
  if (joined.length) {
    const groups = new Map();
    for (const id of eligible) {
      const r = find(id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(id);
    }
    for (let p = 0; p < labels.length; p++)
      if (labels[p] && parent.has(labels[p])) labels[p] = find(labels[p]);
    for (const [r, members] of groups) if (members.length > 1) settle(state, members, r);
  }
  return `near px=${op.px}${op.smallerThan ? ` smallerThan=${op.smallerThan}` : ''}: ${joined.length} pair(s) joined (kept the smallest id of each group): ${shortList(joined, 30)}`;
}

const OPS = {
  merge: opMerge,
  near: opNear,
  cells: opCells,
  cut: opCut,
  tiles: opTiles,
  split: opSplit,
  drop: opDrop,
  restore: opRestore,
  ok: opOk,
};

// Checks the parts every op shares and returns its de-duplicated ids.
function checkOp(op, T, state, objs, fail) {
  if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.op !== 'string')
    fail('each op must be an object with an "op" name');
  if (op.tile !== undefined && op.tile !== T)
    fail(
      `an op cannot set a tile size (this sheet's is ${T || 'none'}); rerun detect with --tile N to change it`,
    );
  if (op.ids !== undefined && !Array.isArray(op.ids)) fail('"ids" must be a list of numbers');
  if (op.id !== undefined && op.ids !== undefined) fail('give "id" or "ids", not both');
  const ids = [...new Set(op.ids || (op.id !== undefined ? [op.id] : []))];
  if (!ids.every(Number.isInteger)) fail('ids must be whole numbers');
  if (op.op !== 'restore')
    for (const id of ids)
      if (!objs[id] || state.dropped[id])
        fail(
          state.dropped[id]
            ? `object ${id} is dropped`
            : `object ${id} does not exist in rev ${state.rev}`,
        );
  if (op.region !== undefined) {
    if (!['cells', 'near'].includes(op.op))
      fail(`"region" only applies to cells and near, not to ${op.op}`);
    if (!(Array.isArray(op.region) && op.region.length === 4 && op.region.every(Number.isInteger)))
      fail('region must be [x0, y0, x1, y1] in ruler units, inclusive');
    if (op.region[0] > op.region[2] || op.region[1] > op.region[3])
      fail('region corners are reversed: give [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1');
  }
  return ids;
}

// A doubtful lattice border stays listed only while no edit has touched the
// pixels on either side of it.
function untouchedBorders(state, labels, before, w, h) {
  const T = state.grid.tile;
  return state.ambiguousBorders.filter((b) => {
    const [cx, cy] = b.cell;
    const len = b.orient === 'v' ? Math.min(T, h - cy * T) : Math.min(T, w - cx * T);
    for (let t = 0; t < len; t++) {
      const p1 = b.orient === 'v' ? (cy * T + t) * w + b.pos - 1 : (b.pos - 1) * w + cx * T + t;
      const p2 = b.orient === 'v' ? (cy * T + t) * w + b.pos : b.pos * w + cx * T + t;
      if (labels[p1] !== before[p1] || labels[p2] !== before[p2]) return false;
    }
    return true;
  });
}

function apply(args) {
  const work = need(args, 'work');
  const { state, img, labels } = load(work);
  const doc = readJson(need(args, 'ops'), 'ops file');
  if (!doc || Array.isArray(doc) || !Array.isArray(doc.ops) || !Number.isInteger(doc.rev))
    throw new Error(
      'ops file must be {"rev": <revision the pages were rendered at>, "ops": [...]}',
    );
  if (doc.rev !== state.rev)
    throw new Error(
      `ops were written for rev ${doc.rev} but the work dir is at rev ${state.rev}. Ids can change between revisions: run review again and re-read the pages.`,
    );
  const ops = doc.ops;
  if (!ops.length) throw new Error('the ops list is empty: nothing to apply');
  const { width: w, height: h } = img;
  const before = Int32Array.from(labels);
  const metaBefore = JSON.stringify([state.dropped, state.kinds, state.acked]);
  const soft = softMask(img, state);
  const T = state.grid.tile;
  const log = [];
  ops.forEach((op, i) => {
    const fail = (msg) => {
      throw new Error(`op #${i + 1} ${JSON.stringify(op)}: ${msg}. Nothing was applied.`);
    };
    const objs = objects(img, labels, state);
    const ids = checkOp(op, T, state, objs, fail);
    if (!Object.hasOwn(OPS, op.op))
      fail(
        `unknown op "${op.op}" (known: merge, near, cells, cut, tiles, split, drop, restore, ok)`,
      );
    log.push(OPS[op.op]({ op, ids, objs, state, labels, soft, img, T, fail }));
  });
  // invariant: ops move pixels between objects, they never create or lose artwork
  for (let p = 0; p < labels.length; p++)
    if ((before[p] === 0) !== (labels[p] === 0))
      throw new Error('internal error: an op changed the artwork mask. Nothing was saved.');
  let changed = JSON.stringify([state.dropped, state.kinds, state.acked]) !== metaBefore;
  for (let p = 0; p < labels.length && !changed; p++) if (labels[p] !== before[p]) changed = true;
  if (!changed) {
    console.log(
      `apply: no change. The ops matched nothing, so the revision stays at ${state.rev}.`,
    );
    for (const l of log) console.log('   ' + l);
    return;
  }
  if (T) state.ambiguousBorders = untouchedBorders(state, labels, before, w, h);
  state.seams = core.effectiveSeams(labels, state.seams, w);
  const alive = new Set(labels);
  for (const field of ['kinds', 'dropped', 'acked'])
    for (const id of Object.keys(state[field])) if (!alive.has(+id)) delete state[field][id];
  state.rev++;
  state.history.push({ rev: state.rev, ops });
  save(work, state, labels);
  console.log(`apply -> rev ${state.rev}, ${liveCount(labels, state)} objects`);
  for (const l of log) console.log('   ' + l);
  console.log(
    '   run review again before writing more ops or names: the pages and objects.json now on disk describe the old revision',
  );
}

// ------------------------------------------------------------------ export ----
// Coverage check: paste every exported sprite back at its source rect and compare
// with the sheet as it stands after background removal. It proves that every
// artwork pixel landed in exactly one sprite (or was dropped on purpose) and that
// the files decode to the same colours. It does NOT judge whether the objects
// were divided correctly, nor whether the background was judged correctly.
function coverage(img, labels, state, outDir, frames) {
  const { width: w, height: h } = img;
  const canvas = png.create(w, h);
  const hits = new Uint8Array(w * h);
  let empty = 0;
  for (const f of frames) {
    const sp = png.read(path.join(outDir, f.file));
    let any = false;
    for (let y = 0; y < sp.height; y++)
      for (let x = 0; x < sp.width; x++) {
        const so = (y * sp.width + x) * 4;
        if (!sp.data[so + 3]) continue;
        any = true;
        const i = (f.y + y) * w + f.x + x;
        hits[i]++;
        sp.data.copy(canvas.data, i * 4, so, so + 4);
      }
    if (!any) empty++;
  }
  let artwork = 0;
  let dropped = 0;
  let unassigned = 0;
  let twice = 0;
  let mismatch = 0;
  for (let i = 0; i < w * h; i++) {
    if (!img.data[i * 4 + 3]) {
      if (hits[i] || (labels[i] && !state.dropped[labels[i]])) mismatch++;
      continue;
    }
    artwork++;
    if (state.dropped[labels[i]]) {
      dropped++;
      if (hits[i]) mismatch++;
      continue;
    }
    if (!hits[i]) unassigned++;
    else if (hits[i] > 1) twice++;
    else if (img.data.compare(canvas.data, i * 4, i * 4 + 4, i * 4, i * 4 + 4) !== 0) mismatch++;
  }
  return {
    artworkPixels: artwork,
    droppedPixels: dropped,
    unassigned,
    claimedTwice: twice,
    mismatch,
    emptySprites: empty,
    complete: unassigned === 0 && twice === 0 && mismatch === 0 && empty === 0,
  };
}

const MARKER = '.sprite-sheet-slicer';

// The out dir must be ours to write in: never the work dir, never a folder of someone else's files.
function checkOutDir(out, outAbs, work, force) {
  if (outAbs === path.resolve(work)) throw new Error('--out must not be the work folder');
  if (fs.existsSync(outAbs) && !fs.statSync(outAbs).isDirectory())
    throw new Error(`${out} is a file, not a folder`);
  if (
    fs.existsSync(outAbs) &&
    fs.readdirSync(outAbs).length &&
    !fs.existsSync(path.join(outAbs, MARKER)) &&
    !force
  )
    throw new Error(
      `${out} is not empty and was not created by this tool. Export writes sheet.png, atlas.json, assets.json, ASSETS.md and contact sheets there and replaces its sprites folder. Choose a new or empty folder, or add --force.`,
    );
}

function readNames(file, state) {
  if (!file) return { rev: state.rev, assets: {} };
  const names = readJson(file, 'names file');
  if (!names || typeof names !== 'object' || Array.isArray(names) || !Number.isInteger(names.rev))
    throw new Error(
      'names file must be {"rev": <current revision>, "assets": { "<id>": { "name": ... } }}',
    );
  if (names.assets === undefined) names.assets = {};
  if (typeof names.assets !== 'object' || Array.isArray(names.assets))
    throw new Error('"assets" in the names file must be an object keyed by object id');
  return names;
}

// Validates the names file against the live objects and returns id -> asset name.
function assetNames(names, objs, state) {
  for (const id of Object.keys(names.assets)) {
    if (String(+id) !== id)
      throw new Error(
        `names file key "${id}" is not a plain object id (write 12, not "012" or "12.0")`,
      );
    if (!objs.find((o) => o.id === +id))
      throw new Error(
        `names file refers to object ${id}, which does not exist (or is dropped) in rev ${state.rev}`,
      );
    if (!names.assets[id] || typeof names.assets[id] !== 'object')
      throw new Error(`names file entry for object ${id} must be an object like { "name": "..." }`);
  }
  const owner = new Map();
  const nameOf = new Map();
  for (const o of objs) {
    const meta = names.assets[o.id] || {};
    const name =
      meta.name !== undefined
        ? meta.name
        : `${state.kinds[o.id] === 'tile' ? 'tile' : 'obj'}_${String(o.id).padStart(4, '0')}`;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_]{0,63}$/.test(name))
      throw new Error(
        `bad asset name ${JSON.stringify(name)} for object ${o.id}: use lowercase letters, digits and underscores, at most 64 characters. Nothing was written.`,
      );
    if (owner.has(name))
      throw new Error(
        `duplicate asset name "${name}" (objects ${owner.get(name)} and ${o.id}). Nothing was written.`,
      );
    owner.set(name, o.id);
    nameOf.set(o.id, name);
  }
  for (const o of objs) {
    const v = (names.assets[o.id] || {}).variantOf;
    if (v !== undefined && v !== null && !owner.has(v))
      throw new Error(
        `object ${o.id}: variantOf "${v}" is not the name of any exported asset. Nothing was written.`,
      );
  }
  return nameOf;
}

// Writes one sprite per object and returns its atlas frame and catalogue entry.
function writeSprites(outAbs, img, labels, state, objs, names, nameOf, pad) {
  const { width: w, height: h } = img;
  const T = state.grid.tile;
  const frames = [];
  const assets = [];
  for (const o of objs) {
    const meta = names.assets[o.id] || {};
    const name = nameOf.get(o.id);
    const wantPad = T && (pad === 'cell' || (pad === 'auto' && state.kinds[o.id] === 'tile'));
    // the rect the sprite image represents on the sheet
    const rx = wantPad ? Math.floor(o.x0 / T) * T : o.x0;
    const ry = wantPad ? Math.floor(o.y0 / T) * T : o.y0;
    const sw = (wantPad ? Math.min(w, Math.ceil((o.x1 + 1) / T) * T) : o.x1 + 1) - rx;
    const sh = (wantPad ? Math.min(h, Math.ceil((o.y1 + 1) / T) * T) : o.y1 + 1) - ry;
    const sp = png.create(sw, sh);
    let foreign = 0;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const i = (ry + y) * w + rx + x;
        if (labels[i] === o.id) img.data.copy(sp.data, (y * sw + x) * 4, i * 4, i * 4 + 4);
        else if (labels[i] && !state.dropped[labels[i]]) foreign++;
      }
    const file = `sprites/${name}.png`;
    png.write(path.join(outAbs, file), sp);
    frames.push({ file, x: rx, y: ry, w: sw, h: sh, name });
    const b = body(o);
    const cell = T ? [Math.floor(b[0] / T), Math.floor(b[1] / T)] : null;
    assets.push({
      id: o.id,
      name,
      named: meta.name !== undefined,
      category: meta.category || null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      description: meta.description || null,
      confidence: meta.confidence || null,
      variantOf: meta.variantOf || null,
      kind: state.kinds[o.id] || 'object',
      file,
      sourceRect: { x: rx, y: ry, w: sw, h: sh },
      bodyRect: { x: b[0], y: b[1], w: b[2], h: b[3] },
      paddedToCells: sw !== o.x1 - o.x0 + 1 || sh !== o.y1 - o.y0 + 1,
      cellOrigin: cell,
      cellsCovered: T
        ? [
            Math.floor((b[0] + b[2] - 1) / T) - cell[0] + 1,
            Math.floor((b[1] + b[3] - 1) / T) - cell[1] + 1,
          ]
        : null,
      footprintTiles: T ? [Math.ceil(b[2] / T), Math.ceil(b[3] / T)] : null,
      offsetInCell: T ? [rx - cell[0] * T, ry - cell[1] * T] : null,
      pivotPx: { x: Math.round(b[0] + b[2] / 2 - rx), y: b[1] + b[3] - ry },
      hasShadow: o.softArea > 0,
      rectSharedWithNeighbour: foreign > 0,
    });
  }
  return { frames, assets };
}

// sheet.png is the native sheet without the dropped objects, so atlas rects show
// assets only. The atlas is TexturePacker "JSON hash", the most widely importable
// description of rects on a sheet.
function writeSheetAndAtlas(outAbs, img, labels, state, frames) {
  const { width: w, height: h } = img;
  const sheet = png.create(w, h);
  img.data.copy(sheet.data);
  for (let i = 0; i < w * h; i++)
    if (state.dropped[labels[i]]) sheet.data.fill(0, i * 4, i * 4 + 4);
  png.write(path.join(outAbs, 'sheet.png'), sheet);
  const atlas = {
    frames: {},
    meta: {
      app: 'sprite-sheet-slicer',
      image: 'sheet.png',
      format: 'RGBA8888',
      size: { w, h },
      scale: '1',
    },
  };
  for (const f of frames)
    atlas.frames[f.name + '.png'] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
      sourceSize: { w: f.w, h: f.h },
    };
  fs.writeFileSync(path.join(outAbs, 'atlas.json'), JSON.stringify(atlas, null, 1));
}

// Contact sheets: every asset in place with its id, for finding a sprite by eye.
// Returns their file names.
function writeContactSheets(outAbs, img, labels, state) {
  const { width: w, height: h } = img;
  const T = state.grid.tile;
  const pitch = T || UNIT_PX;
  const k = Math.max(2, Math.min(8, Math.floor(PAGE_ROOM / Math.max(w, h))));
  const span = Math.max(16, Math.floor(PAGE_ROOM / k / pitch) * pitch);
  const allObjs = objects(img, labels, state);
  const contacts = [];
  for (const y of pageStarts(h, span, pitch))
    for (const x of pageStarts(w, span, pitch)) {
      const pg = draw.page(
        img,
        labels,
        allObjs,
        { x, y, w: Math.min(span, w - x), h: Math.min(span, h - y) },
        k,
        { tile: pitch, rulerPx: !T, dropped: state.dropped, flagged: new Set() },
      );
      const name = `contact_${String(contacts.length + 1).padStart(2, '0')}.png`;
      png.write(path.join(outAbs, name), pg.image);
      contacts.push(name);
    }
  return contacts;
}

function writeAssetsMd(outAbs, state, assets, contacts, check) {
  const T = state.grid.tile;
  const unnamed = assets.filter((s) => !s.named).length;
  const order = [...assets].sort(
    (p, q) =>
      (T ? p.cellOrigin[1] - q.cellOrigin[1] || p.cellOrigin[0] - q.cellOrigin[0] : 0) ||
      p.bodyRect.y - q.bodyRect.y ||
      p.bodyRect.x - q.bodyRect.x,
  );
  const md = [
    `# Assets cut from ${state.source}`,
    '',
    `Tile size: ${T || 'none'}. ${assets.length} assets, ${unnamed} with generated names. Coverage check complete: ${check.complete}.`,
    '',
    '- Use the image files under `sprites/`. Each holds one asset and nothing else.',
    `- ${contacts.join(', ')} show${contacts.length === 1 ? 's' : ''} the whole sheet with every asset outlined and numbered. The number is the asset\'s id; a generated name ends in it (\`obj_0042\` is id 42). Use ${contacts.length === 1 ? 'it' : 'them'} to find a sprite by eye.`,
    '- `atlas.json` (TexturePacker JSON hash) gives the same rects on `sheet.png`; a frame key is the asset name plus `.png`. A rect marked "shared rect" below also contains a neighbour\'s pixels, so prefer the sprite file for it.',
    T
      ? `- Placing on a ${T}px tile map: draw the sprite image with its top-left at \`cell * ${T} + offsetInCell\` to reproduce where the artist drew it. \`footprintTiles\` is the asset\'s own size in tiles; \`cellsCovered\` counts the sheet cells it touched, which is larger when it sat across a grid line. \`pivotPx\` is the bottom centre of the solid body inside the sprite image, for depth sorting and for standing a prop on a floor line.`
      : '- `pivotPx` is the bottom centre of the solid body inside the sprite image.',
    '',
    `Rows are ordered by ${T ? 'grid row, then column' : 'position'} on the sheet.`,
    '',
    `| name | id | kind | category | ${T ? 'cell (col,row) | footprint | ' : ''}image px | notes |`,
    `|---|---|---|---|${T ? '---|---|' : ''}---|---|`,
  ];
  for (const s of order) {
    const notes = [
      s.description,
      s.variantOf ? 'variant of ' + s.variantOf : null,
      s.hasShadow ? 'has shadow' : null,
      s.confidence ? 'name confidence ' + s.confidence : null,
      s.paddedToCells ? 'padded to whole cells' : null,
      s.rectSharedWithNeighbour ? 'shared rect' : null,
    ];
    md.push(
      `| ${s.name} | ${s.id} | ${s.kind} | ${s.category || ''} | ${T ? `${s.cellOrigin.join(',')} | ${s.footprintTiles.join('x')} | ` : ''}${s.sourceRect.w}x${s.sourceRect.h} | ${notes.filter(Boolean).join('; ')} |`,
    );
  }
  fs.writeFileSync(path.join(outAbs, 'ASSETS.md'), md.join('\n') + '\n');
  return unnamed;
}

function exportAll(args) {
  const work = need(args, 'work');
  const out = need(args, 'out');
  const { state, img, labels } = load(work);
  const pad = args.pad || 'auto';
  if (!['auto', 'cell', 'none'].includes(pad)) throw new Error('--pad must be auto, cell or none');
  const T = state.grid.tile;
  if (pad === 'cell' && !T)
    throw new Error('--pad cell needs a tile size (rerun detect with --tile N)');
  const outAbs = path.resolve(out);
  checkOutDir(out, outAbs, work, args.force);
  const names = readNames(args.names, state);
  if (names.rev !== state.rev)
    throw new Error(
      `names were written for rev ${names.rev} but the work dir is at rev ${state.rev}. Run review again and re-check the ids.`,
    );
  const objs = objects(img, labels, state).filter((o) => o && !state.dropped[o.id]);
  // everything is validated before anything on disk is touched
  const nameOf = assetNames(names, objs, state);
  if (!objs.length)
    throw new Error('there is nothing to export: no live objects in this work folder');
  fs.mkdirSync(outAbs, { recursive: true });
  fs.writeFileSync(
    path.join(outAbs, MARKER),
    'written by sprite-sheet-slicer export; sprites/ and contact_*.png in this folder are replaced on every export\n',
  );
  fs.rmSync(path.join(outAbs, 'sprites'), { recursive: true, force: true });
  for (const f of fs.readdirSync(outAbs))
    if (/^contact_\d+\.png$/.test(f)) fs.rmSync(path.join(outAbs, f));
  fs.mkdirSync(path.join(outAbs, 'sprites'), { recursive: true });
  const { frames, assets } = writeSprites(outAbs, img, labels, state, objs, names, nameOf, pad);
  const check = coverage(img, labels, state, outAbs, frames);
  writeSheetAndAtlas(outAbs, img, labels, state, frames);
  const contacts = writeContactSheets(outAbs, img, labels, state);
  // only the warnings that still matter to someone using the sprites
  const carried = state.warnings
    .filter((x) => ['bg_in_art', 'no_background', 'shadow_only'].includes(x.code))
    .map((x) => x.text);
  fs.writeFileSync(
    path.join(outAbs, 'assets.json'),
    JSON.stringify(
      {
        source: state.source,
        sheetImage: 'sheet.png',
        contactSheets: contacts,
        tile: T,
        pixelScale: state.pixelScale.scale,
        rev: state.rev,
        sheet: names.sheet || null,
        warnings: carried,
        coverage: check,
        assets,
      },
      null,
      1,
    ),
  );
  const unnamed = writeAssetsMd(outAbs, state, assets, contacts, check);
  console.log(
    `export rev=${state.rev}: ${assets.length} sprites (${unnamed} with generated names) -> ${out}`,
  );
  console.log('   coverage check: ' + JSON.stringify(check));
  console.log(
    '   (coverage proves no pixel of the masked sheet was lost or duplicated; it does not judge whether objects were divided correctly)',
  );
  if (!check.complete) process.exitCode = 2;
}

// ------------------------------------------------------------------ status ----
function status(args) {
  const work = need(args, 'work');
  const { state, img, labels } = load(work);
  const objs = objects(img, labels, state);
  const live = objs.filter((o) => o && !state.dropped[o.id]);
  let artwork = 0;
  let unlabeled = 0;
  for (let i = 0; i < labels.length; i++)
    if (img.data[i * 4 + 3]) {
      artwork++;
      if (!labels[i]) unlabeled++;
    }
  console.log(
    `status ${state.source}: rev=${state.rev} objects=${live.length} dropped=${Object.keys(state.dropped).length} tile=${state.grid.tile || 'none'} style=${state.outline.style} background=${state.background.mode} kind=${state.diagnosis.sheetKind}`,
  );
  console.log(`   artwork=${artwork}px unlabeled=${unlabeled}px`);
  for (const wn of state.warnings) console.log('   WARNING: ' + wn.text);
  if (!args.list) return;
  const T = state.grid.tile;
  const { flagged } = flagObjects(img, labels, state, objs, live);
  for (const o of live) {
    const cells = T ? bodyCells(o, T) : null;
    console.log(
      `   ${String(o.id).padStart(5)}  ${T ? `cells ${cells[0]},${cells[1]}..${cells[2]},${cells[3]}  ` : ''}bbox ${o.x0},${o.y0} ${o.x1 - o.x0 + 1}x${o.y1 - o.y0 + 1}${o.softArea ? `  body ${o.sx0},${o.sy0} ${o.sx1 - o.sx0 + 1}x${o.sy1 - o.sy0 + 1}` : ''}  area ${o.area}${state.kinds[o.id] ? '  ' + state.kinds[o.id] : ''}${flagged.has(o.id) ? '  [' + flagged.get(o.id).join(', ') + ']' : ''}`,
    );
  }
  for (const [id, why] of Object.entries(state.dropped))
    console.log(`   ${String(id).padStart(5)}  dropped: ${why}`);
}

const COMMANDS = { detect, review, apply, export: exportAll, status };

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) {
    console.log(USAGE);
    process.exit(0);
  }
  const cmd = args._[0];
  if (!Object.hasOwn(COMMANDS, cmd))
    throw new Error(`unknown command "${cmd}" (run with --help for usage)`);
  COMMANDS[cmd](args);
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
