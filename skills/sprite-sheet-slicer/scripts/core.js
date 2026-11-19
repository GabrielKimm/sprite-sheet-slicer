'use strict';
// Pixel geometry behind the slicer: scale detection, background removal, object
// labelling and the cuts between touching objects.
const png = require('./png');

// A pixel's RGBA as one 32-bit number; 0 for a fully transparent pixel.
const key = (d, o) =>
  d[o + 3] === 0 ? 0 : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
const hex = (k) => '#' + (k >>> 0).toString(16).padStart(8, '0');

// Object ids stay below 2^22, so an unordered pair of them fits in one number.
const PAIR_BASE = 4194304;
const pairKey = (a, b) => (a < b ? a * PAIR_BASE + b : b * PAIR_BASE + a);

// Calls fn for the 4-connected neighbours of pixel i, in the order left, right, up, down.
function forEachNeighbour(i, w, n, fn) {
  const x = i % w;
  if (x > 0) fn(i - 1);
  if (x < w - 1) fn(i + 1);
  if (i >= w) fn(i - w);
  if (i < n - w) fn(i + w);
}

// Whether the set pixel (x, y) of mask lies on the image border or next to an unset pixel.
function onRim(mask, x, y, w, h) {
  const i = y * w + x;
  return (
    x === 0 ||
    y === 0 ||
    x === w - 1 ||
    y === h - 1 ||
    !mask[i - 1] ||
    !mask[i + 1] ||
    !mask[i - w] ||
    !mask[i + w]
  );
}

// Anti-aliased or slightly shaded outline pixels still count as outline here.
const OUTLINE_TOLERANCE = 28;
function nearOutline(d, i, outlineKey) {
  return (
    Math.abs(d[i * 4] - ((outlineKey >>> 24) & 255)) <= OUTLINE_TOLERANCE &&
    Math.abs(d[i * 4 + 1] - ((outlineKey >>> 16) & 255)) <= OUTLINE_TOLERANCE &&
    Math.abs(d[i * 4 + 2] - ((outlineKey >>> 8) & 255)) <= OUTLINE_TOLERANCE
  );
}

// Two outlines side by side for this many pixels make a seam between two objects.
const SEAM_MIN_RUN = 4;

// ---------------------------------------------------------------- scale ----
// An image enlarged N times with nearest-neighbour only changes colour at
// positions that share one residue mod N. Pick the largest N that explains
// (almost) every colour change on both axes. The claim needs evidence: an image
// with a handful of edges fits many N by accident, so at least MIN_EDGES distinct
// edge positions are required on each axis.
const MIN_EDGES = 12;
const SCALE_FIT = 0.995;
function detectScale(img) {
  const { width: w, height: h, data: d } = img;
  const xs = new Float64Array(w);
  const ys = new Float64Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w; x++)
      if (key(d, (y * w + x) * 4) !== key(d, (y * w + x - 1) * 4)) xs[x]++;
  for (let y = 1; y < h; y++)
    for (let x = 0; x < w; x++)
      if (key(d, (y * w + x) * 4) !== key(d, ((y - 1) * w + x) * 4)) ys[y]++;
  const distinct = (arr) => arr.reduce((c, v) => c + (v > 0 ? 1 : 0), 0);
  const edges = Math.min(distinct(xs), distinct(ys));
  if (edges < MIN_EDGES) return { scale: 1, ox: 0, oy: 0, confidence: 1, edges };
  const fit = (arr, s) => {
    const byResidue = new Float64Array(s);
    let total = 0;
    for (let i = 0; i < arr.length; i++) {
      byResidue[i % s] += arr[i];
      total += arr[i];
    }
    let best = 0;
    for (let i = 1; i < s; i++) if (byResidue[i] > byResidue[best]) best = i;
    return { frac: total ? byResidue[best] / total : 0, off: best };
  };
  for (let s = 8; s >= 2; s--) {
    const fx = fit(xs, s);
    const fy = fit(ys, s);
    if (fx.frac >= SCALE_FIT && fy.frac >= SCALE_FIT)
      return { scale: s, ox: fx.off, oy: fy.off, confidence: Math.min(fx.frac, fy.frac), edges };
  }
  return { scale: 1, ox: 0, oy: 0, confidence: 1, edges };
}

function downsample(img, pixelScale) {
  if (pixelScale.scale === 1) return img;
  const starts = (n, off) => {
    const list = off > 0 ? [0] : [];
    for (let p = off; p < n; p += pixelScale.scale) list.push(p);
    return list;
  };
  const sx = starts(img.width, pixelScale.ox);
  const sy = starts(img.height, pixelScale.oy);
  const out = png.create(sx.length, sy.length);
  for (let j = 0; j < sy.length; j++)
    for (let i = 0; i < sx.length; i++) {
      const from = (sy[j] * img.width + sx[i]) * 4;
      img.data.copy(out.data, (j * sx.length + i) * 4, from, from + 4);
    }
  return out;
}

// ----------------------------------------------------------- background ----
// alpha    : the sheet has real transparency -> artwork is everything not transparent
// colorkey : opaque sheet with one background colour -> flood from the border
// checker  : opaque sheet with several background colours (baked transparency grid)
// Transparent pixels (alpha FAINT or less) are background in every mode.
const FAINT = 12;
// Below this share of semi-transparent artwork pixels there is no shadow layer,
// only a handful of stray pixels.
const SOFT_MIN_RATIO = 0.005;
// Bulk test threshold, from measurements: outlines 0.003-0.013, real backgrounds
// 0.68-0.96, a white label fill that touched the border 0.46.
const BULK_MIN = 0.6;
// Smallest enclosed background region removed under the 'large' pocket policy.
const MIN_POCKET = 16;

function buildMask(img, opts = {}) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const fg = new Uint8Array(n);
  const soft = new Uint8Array(n);
  const colorKeys = new Uint32Array(n); // 0 = transparent
  let clear = 0;
  let faint = 0;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    if (a <= FAINT) {
      clear++;
      if (a > 0) faint++;
    } else colorKeys[i] = key(d, i * 4);
  }
  const finish = (res) => {
    let nfg = 0;
    let nsoft = 0;
    for (let i = 0; i < n; i++) {
      if (!fg[i]) continue;
      nfg++;
      if (d[i * 4 + 3] < 255) {
        soft[i] = 1;
        nsoft++;
      }
    }
    const softRatio = nfg ? nsoft / nfg : 0;
    if (softRatio < SOFT_MIN_RATIO) soft.fill(0);
    return {
      bgColors: [],
      candidates: [],
      pockets: 0,
      pocketPixels: 0,
      bgColorInsideArt: 0,
      removedAsBackground: 0,
      bgAbsent: [],
      ...res,
      faintPixels: faint,
      artworkPixels: nfg,
      fg,
      soft,
      softRatio,
    };
  };
  if (clear / n >= 0.01 && !opts.bgColors) {
    for (let i = 0; i < n; i++) fg[i] = colorKeys[i] ? 1 : 0;
    return finish({ mode: 'alpha' });
  }

  const candidates = rankBorderColours(colorKeys, w, h);
  const bg = bulkTest(candidates, colorKeys, w, h);
  if (!bg.size) thinBackground(candidates, colorKeys, bg, w);
  const bgAbsent = [];
  if (opts.bgColors) {
    // named by the caller: these colours are background, nothing else is
    bg.clear();
    const present = new Set(colorKeys);
    for (const c of opts.bgColors) {
      bg.add(c);
      if (!present.has(c)) bgAbsent.push(hex(c));
    }
    for (const c of candidates) {
      c.accepted = bg.has(c.key);
      c.acceptedBy = c.accepted ? 'named by --bg' : undefined;
    }
  }
  const report = candidates.map(({ key: k, ...rest }) => rest);
  if (!bg.size && !clear) {
    fg.fill(1);
    return finish({ mode: 'none', candidates: report });
  }
  const seen = floodFromBorder(colorKeys, bg, w, h);
  // Pockets: background-coloured regions the border flood cannot reach because
  // artwork fences them in (an empty cell ringed by packed objects).
  // Policy: 'all' removes every enclosed region, 'large' only those of MIN_POCKET
  // pixels or more, 'keep' none. A saturated key colour (magenta, green) is never
  // artwork, so the default is 'all'; white, black and greys do occur as small
  // highlights inside sprites, so there the default is 'large'.
  const saturated =
    bg.size > 0 &&
    [...bg].every((k) => {
      const ch = [(k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255];
      return Math.max(...ch) - Math.min(...ch) >= 96;
    });
  const policy = opts.pockets || (saturated ? 'all' : 'large');
  const { pockets, pocketPixels } = removePockets(seen, colorKeys, bg, policy, w);
  let nfg = 0;
  let inside = 0; // background-coloured pixels left inside the artwork
  let removed = 0;
  for (let i = 0; i < n; i++) {
    fg[i] = seen[i] ? 0 : 1;
    if (fg[i]) {
      nfg++;
      if (bg.has(colorKeys[i])) inside++;
    } else if (colorKeys[i]) removed++;
  }
  return finish({
    mode: !bg.size ? 'alpha' : bg.size > 1 ? 'checker' : 'colorkey',
    bgColors: [...bg].map(hex),
    candidates: report,
    pockets,
    pocketPixels,
    pocketPolicy: policy,
    bgColorInsideArt: nfg ? inside / nfg : 0,
    removedAsBackground: removed,
    bgAbsent,
  });
}

// Background candidates are the colours on the border: up to six that each hold
// at least 3% of it, most common first, with their pixel count over the sheet.
function rankBorderColours(colorKeys, w, h) {
  const borderCount = new Map();
  let total = 0;
  const countBorder = (x, y) => {
    const k = colorKeys[y * w + x];
    if (!k) return;
    total++;
    borderCount.set(k, (borderCount.get(k) || 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    countBorder(x, 0);
    countBorder(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    countBorder(0, y);
    countBorder(w - 1, y);
  }
  const ranked = [...borderCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, c]) => c / total >= 0.03)
    .slice(0, 6);
  const count = new Map(ranked.map(([k]) => [k, 0]));
  for (let i = 0; i < colorKeys.length; i++)
    if (count.has(colorKeys[i])) count.set(colorKeys[i], count.get(colorKeys[i]) + 1);
  return ranked.map(([k, c]) => ({
    color: hex(k),
    key: k,
    borderShare: +(c / total).toFixed(3),
    pixels: count.get(k),
    bulk: 0,
    accepted: false,
  }));
}

// Bulk test. A background colour has bulk: most of its pixels sit entirely among
// background colours. An outline never does (the fill behind it is always a
// neighbour), however much of the border it owns on a sheet packed to its edges.
// Colours may vouch for each other only if they are peers in size (the tones of
// a checkerboard are); a small colour next to the real background, such as a
// blade or a strap that touches the border, gets no such support.
// Returns the set of colour keys that pass.
function bulkTest(candidates, colorKeys, w, h) {
  const most = Math.max(0, ...candidates.map((c) => c.pixels));
  const bg = new Set(candidates.filter((c) => c.pixels * 4 >= most).map((c) => c.key));
  for (const c of candidates)
    if (!bg.has(c.key)) c.rejectedBy = 'much smaller than the main border colour';
  const isBgAt = (x, y) =>
    x < 0 || y < 0 || x >= w || y >= h || !colorKeys[y * w + x] || bg.has(colorKeys[y * w + x]);
  for (let pass = 0; pass < 6 && bg.size; pass++) {
    const bulk = new Map();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = colorKeys[y * w + x];
        if (
          bg.has(k) &&
          isBgAt(x - 1, y) &&
          isBgAt(x + 1, y) &&
          isBgAt(x, y - 1) &&
          isBgAt(x, y + 1)
        )
          bulk.set(k, (bulk.get(k) || 0) + 1);
      }
    let changed = false;
    for (const c of candidates) {
      if (!bg.has(c.key)) continue;
      c.bulk = +((bulk.get(c.key) || 0) / Math.max(1, c.pixels)).toFixed(3);
      if (c.bulk < BULK_MIN) {
        bg.delete(c.key);
        c.rejectedBy = 'no bulk';
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const c of candidates)
    if (bg.has(c.key)) {
      c.accepted = true;
      c.acceptedBy = 'bulk';
    }
  return bg;
}

// Second chance for a thin background: a key colour squeezed into 1px gutters
// and 2px rings between packed sprites has no bulk. What gives it away is its
// company: it only ever touches itself and one other colour, and that other
// colour is itself thin and mixes with many colours (the outlines). An outline
// never passes, because it also touches every fill colour it encloses.
// Adds the colours that pass to bg.
function thinBackground(candidates, colorKeys, bg, w) {
  const n = colorKeys.length;
  const neighbourStats = (colour) => {
    const hist = new Map();
    let contacts = 0;
    for (let i = 0; i < n; i++) {
      if (colorKeys[i] !== colour) continue;
      forEachNeighbour(i, w, n, (j) => {
        const k = colorKeys[j];
        if (!k) return;
        hist.set(k, (hist.get(k) || 0) + 1);
        contacts++;
      });
    }
    let mate = null;
    let mateCount = 0;
    for (const [k, c] of hist)
      if (k !== colour && c > mateCount) {
        mate = k;
        mateCount = c;
      }
    const self = hist.get(colour) || 0;
    return {
      purity: contacts ? (self + mateCount) / contacts : 0,
      mate,
      selfShare: contacts ? self / contacts : 0,
    };
  };
  for (const c of candidates) {
    const stats = neighbourStats(c.key);
    c.purity = +stats.purity.toFixed(3);
    if (stats.purity < 0.97 || stats.mate === null) continue;
    const mate = neighbourStats(stats.mate);
    if (mate.selfShare < 0.6 && mate.purity < 0.9) {
      c.accepted = true;
      c.acceptedBy = 'thin background beside outlines';
      delete c.rejectedBy;
      bg.add(c.key);
    }
  }
}

// Flood fill from the border through background (and transparent) pixels only,
// so an interior region that happens to share the background colour survives.
// Returns 1 for every pixel reached and for every transparent pixel.
function floodFromBorder(colorKeys, bg, w, h) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = [];
  const push = (i) => {
    if (seen[i] || (colorKeys[i] && !bg.has(colorKeys[i]))) return;
    seen[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) forEachNeighbour(stack.pop(), w, n, push);
  for (let i = 0; i < n; i++) if (!colorKeys[i]) seen[i] = 1; // transparent is never artwork
  return seen;
}

// Marks the background-coloured regions the flood could not reach as background,
// as far as the pocket policy allows, and counts them.
function removePockets(seen, colorKeys, bg, policy, w) {
  const n = colorKeys.length;
  const minPocket = policy === 'all' ? 1 : MIN_POCKET;
  let pockets = 0;
  let pocketPixels = 0;
  if (policy === 'keep' || !bg.size) return { pockets, pocketPixels };
  const mark = new Uint8Array(n);
  const inPocket = (j) => !seen[j] && !mark[j] && bg.has(colorKeys[j]);
  for (let start = 0; start < n; start++) {
    if (!inPocket(start)) continue;
    const region = [start];
    mark[start] = 1;
    for (let q = 0; q < region.length; q++)
      forEachNeighbour(region[q], w, n, (j) => {
        if (!inPocket(j)) return;
        mark[j] = 1;
        region.push(j);
      });
    if (region.length >= minPocket) {
      pockets++;
      pocketPixels += region.length;
      for (const i of region) seen[i] = 1;
    }
  }
  return { pockets, pocketPixels };
}

// ---------------------------------------------------- connected components ----
// Seams on sheets without a lattice: two outlines running side by side for
// SEAM_MIN_RUN pixels or more, with something other than outline beyond each of
// them. Returned as walls between pixel pairs; `label` refuses to connect across them.
//   v[y*w+x] = wall between (x-1,y) and (x,y)      h[y*w+x] = wall between (x,y-1) and (x,y)
function seamWalls(img, solid, outline) {
  const { width: w, height: h, data: d } = img;
  const dark = (x, y) =>
    x >= 0 &&
    y >= 0 &&
    x < w &&
    y < h &&
    !!solid[y * w + x] &&
    nearOutline(d, y * w + x, outline.key);
  const art = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !!solid[y * w + x];
  const wallsV = new Uint8Array(w * h);
  const wallsH = new Uint8Array(w * h);
  const seams = [];
  // Walks every border line between pixel columns (or rows). `pair(line, t)`: two
  // outline pixels face each other across the line at position t; `beyond`: no
  // further outline behind either of them; `both`: artwork on both sides, so a
  // break in the seam there is a stray highlight pixel, not the end of an object.
  const scan = (lines, length, pair, beyond, both, setWall, orient) => {
    for (let line = 1; line < lines; line++) {
      const runs = [];
      let start = -1;
      for (let t = 0; t <= length; t++) {
        const ok = t < length && pair(line, t);
        if (ok && start < 0) start = t;
        if (!ok && start >= 0) {
          runs.push([start, t - 1]);
          start = -1;
        }
      }
      // join runs separated by one or two positions that still have artwork on both sides
      const joined = [];
      for (const r of runs) {
        const last = joined[joined.length - 1];
        let bridge = last && r[0] - last[1] - 1 <= 2;
        if (bridge) for (let t = last[1] + 1; t < r[0]; t++) if (!both(line, t)) bridge = false;
        if (bridge) last[1] = r[1];
        else joined.push([r[0], r[1]]);
      }
      for (const [from, to] of joined) {
        const len = to - from + 1;
        let clean = 0;
        for (let t = from; t <= to; t++) if (beyond(line, t)) clean++;
        if (len >= SEAM_MIN_RUN && clean >= 0.7 * len) {
          for (let t = from; t <= to; t++) setWall(line, t);
          seams.push({ orient, pos: line, from, to });
        }
      }
    }
  };
  scan(
    w,
    h,
    (x, y) => dark(x - 1, y) && dark(x, y),
    (x, y) => !dark(x - 2, y) && !dark(x + 1, y),
    (x, y) => art(x - 1, y) && art(x, y),
    (x, y) => (wallsV[y * w + x] = 1),
    'v',
  );
  scan(
    h,
    w,
    (y, x) => dark(x, y - 1) && dark(x, y),
    (y, x) => !dark(x, y - 2) && !dark(x, y + 1),
    (y, x) => art(x, y - 1) && art(x, y),
    (y, x) => (wallsH[y * w + x] = 1),
    'h',
  );
  return { v: wallsV, h: wallsH, seams };
}

// Of the seams found, the ones that ended up between two different objects.
function effectiveSeams(labels, seams, w) {
  return seams.filter((s) => {
    for (let t = s.from; t <= s.to; t++) {
      const a = s.orient === 'v' ? labels[t * w + s.pos - 1] : labels[(s.pos - 1) * w + t];
      const b = s.orient === 'v' ? labels[t * w + s.pos] : labels[s.pos * w + t];
      if (a && b && a !== b) return true;
    }
    return false;
  });
}

function label(mask, w, h, walls) {
  const labels = new Int32Array(w * h);
  const comps = [null];
  const stack = [];
  // a step is blocked when it crosses a wall; a diagonal step is blocked when any
  // of the four pixel borders meeting at the shared corner is a wall
  const blocked = (x, y, dx, dy) => {
    if (!walls) return false;
    if (dy === 0) return walls.v[y * w + (dx > 0 ? x + 1 : x)] === 1;
    if (dx === 0) return walls.h[(dy > 0 ? y + 1 : y) * w + x] === 1;
    const cx = dx > 0 ? x + 1 : x; // corner sits at (cx, cy) in pixel-border coordinates
    const cy = dy > 0 ? y + 1 : y;
    return (
      walls.v[(cy - 1) * w + cx] === 1 ||
      walls.v[cy * w + cx] === 1 ||
      walls.h[cy * w + cx - 1] === 1 ||
      walls.h[cy * w + cx] === 1
    );
  };
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = comps.length;
    const c = { id, x0: w, y0: h, x1: -1, y1: -1, area: 0 };
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !labels[j] && !blocked(x, y, dx, dy)) {
            labels[j] = id;
            stack.push(j);
          }
        }
    }
    comps.push(c);
  }
  return { labels, comps };
}

// A wall that sliced a 2px-thick outline in half leaves a sliver made of outline
// colour only. Give such slivers back to the neighbour across the wall.
function healSlivers(img, labels, walls, outline) {
  const { width: w, height: h, data: d } = img;
  const fillPixels = new Map(); // label -> count of non-outline pixels
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    if (!l) continue;
    fillPixels.set(l, (fillPixels.get(l) || 0) + (nearOutline(d, i, outline.key) ? 0 : 1));
  }
  const alias = new Map();
  const root = (a) => {
    while (alias.has(a)) a = alias.get(a);
    return a;
  };
  const tryHeal = (i, j) => {
    const a = root(labels[i]);
    const b = root(labels[j]);
    if (!a || !b || a === b) return;
    if (fillPixels.get(a) === 0) alias.set(a, b);
    else if (fillPixels.get(b) === 0) alias.set(b, a);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (walls.v[i] && x > 0) tryHeal(i - 1, i);
      if (walls.h[i] && y > 0) tryHeal(i - w, i);
    }
  if (alias.size)
    for (let i = 0; i < labels.length; i++) if (labels[i]) labels[i] = root(labels[i]);
  return alias.size;
}

// Hand soft (semi-transparent) pixels to solid objects, one soft region at a time.
// A region touching one solid object goes to it whole. A region touching several
// is divided pixel by pixel: the object straight above first, the rest to the
// nearest. A region touching nothing solid (glow, smoke, glass) becomes an object
// of its own.
// Returns the next free id.
function attachSoft(labels, soft, w, h, nextId) {
  const n = w * h;
  const mark = new Uint8Array(n);
  const neighbours = (i, fn) => forEachNeighbour(i, w, n, fn);
  let orphans = 0;
  for (let s = 0; s < n; s++) {
    if (!soft[s] || labels[s] || mark[s]) continue;
    const region = [s];
    mark[s] = 1;
    const contact = new Map();
    for (let q = 0; q < region.length; q++) {
      const i = region[q];
      neighbours(i, (j) => {
        // a shadow falls below what casts it: solid directly above a shadow pixel
        // is a strong claim, solid beside it a fair one, solid underneath a weak one
        if (labels[j]) {
          const weight = j === i - w ? 3 : j === i + w ? 1 : 2;
          contact.set(labels[j], (contact.get(labels[j]) || 0) + weight);
        } else if (soft[j] && !mark[j]) {
          mark[j] = 1;
          region.push(j);
        }
      });
    }
    const ranked = [...contact.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) {
      for (const i of region) labels[i] = nextId;
      nextId++;
      orphans++;
      continue;
    }
    if (ranked.length === 1) {
      for (const i of region) labels[i] = ranked[0][0];
      continue;
    }
    // Several objects share this shadow. First give each pixel to the solid
    // object straight above it (within 8px, looking through shadow only), then
    // let the rest go to whichever claimed neighbour is nearest.
    const inRegion = new Set(region);
    const claimed = new Map();
    for (const i of region) {
      for (let j = i - w, steps = 0; j >= 0 && steps < 8; j -= w, steps++) {
        if (inRegion.has(j)) continue;
        if (labels[j]) claimed.set(i, labels[j]);
        break;
      }
    }
    // solid beside a shadow pixel may claim it; solid underneath may not (it is
    // the neighbour the shadow happens to fall towards, not the caster)
    for (const i of region)
      neighbours(i, (j) => {
        if (j !== i + w && labels[j] && !inRegion.has(j) && !claimed.has(i))
          claimed.set(i, labels[j]);
      });
    let frontier = [];
    const spread = () => {
      while (frontier.length) {
        const next = [];
        for (const i of frontier)
          neighbours(i, (j) => {
            if (!inRegion.has(j) || labels[j]) return;
            labels[j] = labels[i];
            next.push(j);
          });
        frontier = next;
      }
    };
    for (const [i, l] of claimed) {
      labels[i] = l;
      frontier.push(i);
    }
    spread();
    // a pixel still unclaimed has solid only underneath it: let that claim it after all
    for (const i of region)
      if (!labels[i] && i + w < n && labels[i + w] && !inRegion.has(i + w)) {
        labels[i] = labels[i + w];
        frontier.push(i);
      }
    spread();
    for (const i of region) if (!labels[i]) labels[i] = ranked[0][0];
  }
  return { nextId, orphans };
}

// ------------------------------------------------------------- outline ----
// The outline colour is the colour most often found on the rim of the artwork.
// Most of the artwork's rim in one colour means the art is drawn with outlines.
const OUTLINED_MIN_SHARE = 0.5;
function outlineColor(img, fg) {
  const { width: w, height: h, data: d } = img;
  const hist = new Map();
  let rim = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!fg[i] || !onRim(fg, x, y, w, h)) continue;
      rim++;
      const k = key(d, i * 4);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  let best = 0;
  let bestKey = 0;
  for (const [k, c] of hist)
    if (c > best) {
      best = c;
      bestKey = k;
    }
  return { key: bestKey, hex: hex(bestKey), share: rim ? best / rim : 0 };
}

// ---------------------------------------------------------------- grid ----
// How often do component bounding-box edges land exactly on a T-pixel lattice,
// relative to chance (1/T)? Reported as evidence; the caller may override T.
const LATTICE_PITCHES = [8, 16, 24, 32, 48, 64];
function gridEvidence(comps, w, h) {
  const rows = [];
  const list = comps.filter(Boolean).filter((c) => c.area >= 12);
  for (const T of LATTICE_PITCHES) {
    let hit = 0;
    let total = 0;
    let fresh = 0; // edges on odd multiples of T: positions a 2T lattice cannot explain
    for (const c of list) {
      for (const v of [c.x0, c.x1 + 1, c.y0, c.y1 + 1]) {
        total++;
        if (v % T === 0) hit++;
        if (v % (2 * T) === T) fresh++;
      }
    }
    const pf = 1 / (2 * T);
    const zFresh = total ? (fresh - total * pf) / Math.sqrt(total * pf * (1 - pf)) : 0;
    const frac = total ? hit / total : 0;
    // z-score against the chance rate 1/T. A plain ratio to chance favours large T:
    // if the true lattice is 16, half the edges also sit on 32 and the ratio ties,
    // whereas the z-score correctly ranks 16 above 32 (and 32 above 16 when 32 is true).
    const p = 1 / T;
    const z = total ? (hit - total * p) / Math.sqrt(total * p * (1 - p)) : 0;
    rows.push({
      T,
      divides: w % T === 0 && h % T === 0,
      edgeOnLattice: +frac.toFixed(3),
      z: +z.toFixed(1),
      zFresh: +zFresh.toFixed(1),
    });
  }
  return rows;
}

// ------------------------------------------------------ touching objects ----
// Split connected blobs along lattice lines where two outlines meet.
// Nodes are (component, lattice cell) pairs. Two neighbouring nodes stay joined
// when artwork interior continues across their shared border; they are cut when
// the border is a long run of outline-against-outline ("double outline seam").
function splitOnLattice(img, labels, T, outline) {
  const { width: w, height: h, data: d } = img;
  // Exact colour match: pixel art outlines are one palette entry. A tolerance
  // would read a near-black belt or strap as outline and cut the sprite there.
  const isOutline = (i) => key(d, i * 4) === outline.key;
  const cw = Math.ceil(w / T);
  const ch = Math.ceil(h / T);
  const nodes = cellNodes(cw, ch);
  const edges = [];
  const seamBetween = new Map(); // node pair -> true when a real seam was found on their shared border
  const lattice = { img, labels, T, isOutline, nodes, edges, seamBetween };
  straightBorders(lattice, outlinedBlobs(labels, isOutline, w, h));
  diagonalContacts(lattice);
  // relabel pixels by (component, cell-group)
  const out = new Int32Array(w * h);
  const remap = new Map();
  let next = 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lab = labels[i];
      if (!lab) continue;
      const root = nodes.find(nodes.node(lab, (x / T) | 0, (y / T) | 0));
      let id = remap.get(root);
      if (id === undefined) {
        id = next++;
        remap.set(root, id);
      }
      out[i] = id;
    }
  return { labels: out, count: next - 1, edges };
}

// Union-find over (component, lattice cell) pairs.
function cellNodes(cw, ch) {
  const nodeId = new Map();
  const parent = [];
  const node = (lab, cx, cy) => {
    const k = lab * cw * ch + cy * cw + cx;
    let id = nodeId.get(k);
    if (id === undefined) {
      id = parent.length;
      nodeId.set(k, id);
      parent.push(id);
    }
    return id;
  };
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  return { node, find, parent };
}

// Style is judged per connected blob, since a sheet can mix outlined props with
// flat terrain: a blob is "outlined" when most of its rim has the outline colour.
function outlinedBlobs(labels, isOutline, w, h) {
  const rimAll = new Map();
  const rimOut = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lab = labels[i];
      if (!lab || !onRim(labels, x, y, w, h)) continue;
      rimAll.set(lab, (rimAll.get(lab) || 0) + 1);
      if (isOutline(i)) rimOut.set(lab, (rimOut.get(lab) || 0) + 1);
    }
  return (lab) => (rimOut.get(lab) || 0) * 2 >= (rimAll.get(lab) || 1);
}

// Outline-against-outline pixels along a border come in runs: a long run is a
// seam, a short one is two rims that merely kiss.
function closeRun(e) {
  if (e.run >= SEAM_MIN_RUN) e.longRuns += e.run;
  else e.shortRuns += e.run;
  e.run = 0;
}

// Judges every straight lattice border between two cells of one blob, joins the
// cells where the artwork carries on across it, and records an edge for each.
function straightBorders(lattice, outlinedBlob) {
  const { img, labels, T, isOutline, nodes, edges, seamBetween } = lattice;
  const { width: w, height: h, data: d } = img;
  const cw = Math.ceil(w / T);
  const ch = Math.ceil(h / T);
  // one lattice border segment between two cells; `at(t)` yields the pixel
  // index pair straddling the border at position t along it
  const evalBorder = (len, at, cxa, cya, cxb, cyb, orient, pos) => {
    const perLab = new Map();
    for (let t = 0; t < len; t++) {
      const [i, j] = at(t);
      const lab = labels[i];
      if (!lab || labels[j] !== lab) continue;
      let e = perLab.get(lab);
      if (!e) {
        e = {
          same: 0,
          diff: 0,
          longRuns: 0,
          shortRuns: 0,
          cross: 0,
          run: 0,
          last: -2,
          rimA: 0,
          rimB: 0,
        };
        perLab.set(lab, e);
      }
      if (e.last !== t - 1) closeRun(e);
      e.cross++;
      e.last = t;
      // three kinds of pixel pair straddling the border:
      //   outline|outline  two rims side by side: a seam when it runs long
      //   same fill colour the artwork carries on across: continuity
      //   different colours weak either way; decides only when nothing carries on
      if (isOutline(i) && isOutline(j)) e.run++;
      else {
        closeRun(e);
        if (key(d, i * 4) === key(d, j * 4)) e.same++;
        else {
          e.diff++;
          if (isOutline(i)) e.rimA++;
          else if (isOutline(j)) e.rimB++;
        }
      }
    }
    for (const [lab, e] of perLab) {
      closeRun(e);
      let joined;
      let ambiguous;
      if (outlinedBlob(lab)) {
        // outlined art: any pair that is not rim-against-rim is the object's own
        // interior crossing the border (fill, or its outline next to its fill)
        const interior = e.same + e.diff;
        // One rim running the whole length of the border against something that
        // shows no rim of its own there. It can be an outlined prop standing on flat
        // artwork, or one object (a table top overhanging its frame). The pixels
        // cannot tell which, so it stays joined and is marked doubtful.
        const oneSided =
          e.cross >= SEAM_MIN_RUN &&
          e.longRuns === 0 &&
          e.shortRuns === 0 &&
          (e.rimA === e.cross || e.rimB === e.cross);
        joined = interior > 0 && interior * 4 >= e.longRuns;
        ambiguous =
          oneSided ||
          (interior > 0 && e.longRuns > 0) ||
          (joined && interior <= 2 && e.cross >= 6) ||
          (!joined && e.longRuns === 0); // two rims only kiss
      } else {
        // flat art has no rim to look for: only an unbroken colour says "same object"
        joined = e.same > 0 && e.same * 4 >= e.longRuns;
        ambiguous = joined && e.same * 10 < e.cross;
      }
      const a = nodes.node(lab, cxa, cya);
      const b = nodes.node(lab, cxb, cyb);
      if (joined) nodes.parent[nodes.find(a)] = nodes.find(b);
      seamBetween.set(pairKey(a, b), e.longRuns > 0);
      edges.push({
        orient,
        pos,
        cell: [cxa, cya],
        cross: e.cross,
        same: e.same,
        outlineRun: e.longRuns,
        diff: e.diff,
        joined,
        ambiguous,
      });
    }
  };
  for (let gx = T; gx < w; gx += T)
    for (let cy = 0; cy < ch; cy++) {
      const y0 = cy * T;
      evalBorder(
        Math.min(T, h - y0),
        (t) => [(y0 + t) * w + gx - 1, (y0 + t) * w + gx],
        gx / T - 1,
        cy,
        gx / T,
        cy,
        'v',
        gx,
      );
    }
  for (let gy = T; gy < h; gy += T)
    for (let cx = 0; cx < cw; cx++) {
      const x0 = cx * T;
      evalBorder(
        Math.min(T, w - x0),
        (t) => [(gy - 1) * w + x0 + t, gy * w + x0 + t],
        cx,
        gy / T - 1,
        cx,
        gy / T,
        'h',
        gy,
      );
    }
}

// Contact that is diagonal only (a 1px stroke stepping across a lattice line or
// through a lattice corner) has no pixel pair facing each other across the line.
// Such pieces stay together unless a real seam was found between their cells,
// and the place is marked doubtful: it could also be two sprites touching corners.
function diagonalContacts(lattice) {
  const { img, labels, T, nodes, edges, seamBetween } = lattice;
  const { width: w, height: h } = img;
  const blobNeighbours = (x, y, lab) => {
    let c = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (
          (dx || dy) &&
          x + dx >= 0 &&
          y + dy >= 0 &&
          x + dx < w &&
          y + dy < h &&
          labels[(y + dy) * w + x + dx] === lab
        )
          c++;
    return c;
  };
  const diagonal = (i, j, orient, pos) => {
    const lab = labels[i];
    if (!lab || labels[j] !== lab) return;
    const xi = i % w;
    const yi = (i - xi) / w;
    const xj = j % w;
    const yj = (j - xj) / w;
    // joined through a shared neighbour: the straight test covered it
    if (labels[yi * w + xj] === lab || labels[yj * w + xi] === lab) return;
    const a = nodes.node(lab, (xi / T) | 0, (yi / T) | 0);
    const b = nodes.node(lab, (xj / T) | 0, (yj / T) | 0);
    if (a === b || nodes.find(a) === nodes.find(b) || seamBetween.get(pairKey(a, b))) return;
    // Join only a thin stroke: each of the two pixels has at most two neighbours
    // of its blob (the stroke before and after it). Two rounded sprites touching
    // corners have their rims and fill around the contact and stay cut.
    const join = blobNeighbours(xi, yi, lab) <= 2 && blobNeighbours(xj, yj, lab) <= 2;
    if (join) nodes.parent[nodes.find(a)] = nodes.find(b);
    edges.push({
      orient,
      pos,
      cell: [(Math.min(xi, xj) / T) | 0, (Math.min(yi, yj) / T) | 0],
      cross: 1,
      same: 0,
      outlineRun: 0,
      diff: 0,
      joined: join,
      ambiguous: true,
    });
  };
  for (let gx = T; gx < w; gx += T)
    for (let y = 0; y < h; y++) {
      if (y > 0) diagonal(y * w + gx - 1, (y - 1) * w + gx, 'v', gx);
      if (y < h - 1) diagonal(y * w + gx - 1, (y + 1) * w + gx, 'v', gx);
    }
  for (let gy = T; gy < h; gy += T)
    for (let x = 0; x < w; x++) {
      if (x > 0) diagonal((gy - 1) * w + x, gy * w + x - 1, 'h', gy);
      if (x < w - 1) diagonal((gy - 1) * w + x, gy * w + x + 1, 'h', gy);
    }
}

// --------------------------------------------------------------- objects ----
// One record per label: bounding box of all pixels, box of the solid body
// (sx0..sy1, shadow excluded), anchor (ax, ay) and up to 9 solid colours.
function collect(img, labels, count, soft) {
  const { width: w, height: h, data: d } = img;
  const objs = [null];
  for (let id = 1; id <= count; id++)
    objs.push({
      id,
      x0: w,
      y0: h,
      x1: -1,
      y1: -1,
      sx0: w,
      sy0: h,
      sx1: -1,
      sy1: -1,
      ax: -1,
      ay: -1,
      area: 0,
      softArea: 0,
      colors: new Set(),
    });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = objs[labels[i]];
      if (!o) continue;
      o.area++;
      if (soft[i]) o.softArea++;
      else {
        if (o.colors.size < 9) o.colors.add(key(d, i * 4));
        if (o.ax < 0) {
          // first solid pixel in reading order
          o.ax = x;
          o.ay = y;
        }
        if (x < o.sx0) o.sx0 = x;
        if (x > o.sx1) o.sx1 = x;
        if (y < o.sy0) o.sy0 = y;
        if (y > o.sy1) o.sy1 = y;
      }
      if (x < o.x0) o.x0 = x;
      if (x > o.x1) o.x1 = x;
      if (y < o.y0) o.y0 = y;
      if (y > o.y1) o.y1 = y;
    }
  // an object made of shadow only has no solid body: fall back to its full box
  for (const o of objs)
    if (o && o.sx1 < 0) {
      o.sx0 = o.x0;
      o.sy0 = o.y0;
      o.sx1 = o.x1;
      o.sy1 = o.y1;
      o.ax = o.x0;
      o.ay = o.y0;
    }
  return objs;
}

// How close do separate objects sit? Counts object pairs by the number of empty
// pixels between them (0 = touching), up to 3. A reviewer deciding whether loose
// pieces belong together needs this and cannot read it off a picture.
function gapHistogram(labels, w, h, skip, soft) {
  const best = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = labels[y * w + x];
      if (!a || skip[a] || soft[y * w + x]) continue;
      for (let dy = 0; dy <= 4; dy++)
        for (let dx = dy === 0 ? 1 : -4; dx <= 4; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          const b = labels[ny * w + nx];
          if (!b || b === a || skip[b] || soft[ny * w + nx]) continue;
          const gap = Math.max(Math.abs(dx), dy) - 1;
          const k = pairKey(a, b);
          if (!best.has(k) || best.get(k) > gap) best.set(k, gap);
        }
    }
  const hist = [0, 0, 0, 0];
  const pairs = [[], [], [], []];
  for (const [k, g] of best) {
    hist[g]++;
    if (pairs[g].length < 400) pairs[g].push([Math.floor(k / PAIR_BASE), k % PAIR_BASE]);
  }
  return { hist, pairs };
}

// Objects smaller than this are specks; they join the nearest real object
// within SPECK_REACH pixels.
const SPECK_AREA = 6;
const SPECK_REACH = 2;
function absorbSpecks(labels, objs, w, h) {
  const alias = objs.map((o, i) => i);
  const absorbed = [];
  for (const o of objs) {
    if (!o || o.area >= SPECK_AREA) continue;
    let best = 0;
    let bestDist = Infinity;
    for (let y = Math.max(0, o.y0 - SPECK_REACH); y <= Math.min(h - 1, o.y1 + SPECK_REACH); y++)
      for (let x = Math.max(0, o.x0 - SPECK_REACH); x <= Math.min(w - 1, o.x1 + SPECK_REACH); x++) {
        const l = labels[y * w + x];
        if (!l || l === o.id || objs[l].area < SPECK_AREA) continue;
        const dx = x < o.x0 ? o.x0 - x : x > o.x1 ? x - o.x1 : 0;
        const dy = y < o.y0 ? o.y0 - y : y > o.y1 ? y - o.y1 : 0;
        const dist = Math.max(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = l;
        }
      }
    if (best) {
      alias[o.id] = best;
      absorbed.push({ at: [o.x0, o.y0], area: o.area, into: best });
    }
  }
  if (absorbed.length)
    for (let i = 0; i < labels.length; i++) if (labels[i]) labels[i] = alias[labels[i]];
  return absorbed;
}

// Intrinsic warning signs, usable without ground truth. On outlined artwork a
// well-cut object is fenced by its outline. The count per object is its solid,
// non-outline pixels that sit directly against another object: fill exposed by
// a cut, or two assets that share no outline. High values mark objects worth a look.
function exposedFill(img, labels, soft, outline) {
  const { width: w, height: h, data: d } = img;
  const out = new Map();
  if (outline.share < OUTLINED_MIN_SHARE) return out;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (!l || soft[i] || key(d, i * 4) === outline.key) continue;
      const other = (j) => labels[j] && labels[j] !== l && !soft[j];
      if (
        (x > 0 && other(i - 1)) ||
        (x < w - 1 && other(i + 1)) ||
        (y > 0 && other(i - w)) ||
        (y < h - 1 && other(i + w))
      )
        out.set(l, (out.get(l) || 0) + 1);
    }
  return out;
}

// Renumbers labels 1..n in order of first appearance; returns n.
function compact(labels) {
  const map = new Map();
  let next = 1;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    let m = map.get(l);
    if (m === undefined) {
      m = next++;
      map.set(l, m);
    }
    labels[i] = m;
  }
  return next - 1;
}

module.exports = {
  SOFT_MIN_RATIO,
  SPECK_AREA,
  OUTLINED_MIN_SHARE,
  key,
  forEachNeighbour,
  detectScale,
  downsample,
  buildMask,
  seamWalls,
  effectiveSeams,
  label,
  healSlivers,
  attachSoft,
  outlineColor,
  gridEvidence,
  splitOnLattice,
  collect,
  gapHistogram,
  absorbSpecks,
  exposedFill,
  compact,
};
