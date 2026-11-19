'use strict';
// Synthetic sprite sheet generator. Every sheet is built from sprites painted
// here, so the ground truth (which pixel belongs to which asset) is known by
// construction and does not depend on the slicer under test.
//   node test/gen.js <out-dir> [seed,seed,...]
// Default seeds are 11,12,13, plus two fixed sheets (semantic icons, a large
// one). Each case folder gets sheet.png, gt.bin (Int32 asset id per native
// pixel), gt_native.png (artwork at native scale) and gt.json.
const fs = require('fs');
const path = require('path');
const LIB =
  process.env.SLICER_LIB || path.join(__dirname, '..', 'skills', 'sprite-sheet-slicer', 'scripts');
const png = require(path.join(LIB, 'png.js'));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, a) => a[Math.floor(r() * a.length)];
const BLACK = [0, 0, 0];
// mid-tone fills: never pure black, white, magenta or the checker greys used as backgrounds
const BASES = [
  [196, 72, 60],
  [72, 140, 200],
  [96, 168, 84],
  [212, 168, 64],
  [150, 96, 180],
  [70, 170, 160],
  [190, 120, 70],
  [120, 130, 150],
  [200, 110, 150],
  [110, 90, 70],
  [90, 150, 110],
  [170, 150, 120],
];
const T = 16;
function setPixel(img, x, y, c, a = 255) {
  const p = (y * img.width + x) * 4;
  img.data[p] = c[0];
  img.data[p + 1] = c[1];
  img.data[p + 2] = c[2];
  img.data[p + 3] = a;
}
const shade = (c, f) => c.map((v) => Math.max(8, Math.min(250, Math.round(v * f))));

// ---------------------------------------------------------------- masks ----
function rectMask(w, h) {
  const m = new Uint8Array(w * h).fill(1);
  if (w > 4 && h > 4) m[0] = m[w - 1] = m[(h - 1) * w] = m[h * w - 1] = 0;
  return m;
}
function ellipseMask(w, h, r) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2);
      const dy = (y + 0.5 - h / 2) / (h / 2);
      if (dx * dx + dy * dy <= 1) m[y * w + x] = 1;
    }
  // a random bar across the ellipse makes it less regular
  if (r && w >= 8 && h >= 8) {
    const horizontal = r() < 0.5;
    const t = horizontal ? randInt(r, 1, h - 4) : randInt(r, 1, w - 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (horizontal ? y >= t && y < t + 3 : x >= t && x < t + 3) m[y * w + x] = 1;
  }
  return m;
}
function stickMask(w, h) {
  const m = new Uint8Array(w * h);
  const len = Math.hypot(w - 1, h - 1) || 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (Math.abs(x * (h - 1) + (y - (h - 1)) * (w - 1)) / len <= 1.7) m[y * w + x] = 1;
  return m;
}
// two parts with an empty column band between them: one asset, two connected components
function splitMask(w, h, r) {
  const m = new Uint8Array(w * h);
  const gap = randInt(r, 1, 2);
  const lw = Math.floor((w - gap) / 2);
  const rw = w - gap - lw;
  const lh = randInt(r, Math.max(4, h - 5), h);
  const rh = randInt(r, Math.max(4, h - 5), h);
  const a = ellipseMask(lw, lh);
  const b = ellipseMask(rw, rh);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) m[(h - lh + y) * w + x] = a[y * lw + x];
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) m[y * w + lw + gap + x] = b[y * rw + x];
  return m;
}
function paint(mask, w, h, r, o) {
  const img = png.create(w, h);
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      let c;
      if (edge && o.outline) c = o.outline;
      else {
        const t = y / h;
        c = shade(o.base, t < 0.34 ? 1.15 : t < 0.67 ? 1 : 0.82);
        if (r() < 0.06) c = shade(o.base, 1.3);
      }
      setPixel(img, x, y, c);
    }
  return img;
}
function tileSprite(T, base, r) {
  const img = png.create(T, T);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const mortar = y % 4 === 3 || (x + (((y / 4) | 0) % 2) * 4) % 8 === 7;
      const c = shade(base, mortar ? 0.7 : r() < 0.15 ? 1.1 : 1);
      setPixel(img, x, y, c);
    }
  return img;
}
function labelSprite(w, h, r) {
  const img = png.create(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, [236, 232, 214]);
  // fake text: a row of 3x5 glyphs with random pixels set
  const top = Math.floor((h - 5) / 2);
  for (let gx = 3; gx + 3 < w - 2; gx += 4)
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++) if (r() < 0.6) setPixel(img, gx + x, top + y, [40, 40, 64]);
  return img;
}
function withShadow(sp) {
  const out = png.create(sp.width + 4, sp.height + 3);
  const cy = sp.height;
  for (let y = sp.height - 3; y < sp.height + 3; y++)
    for (let x = 0; x < out.width; x++) {
      const dx = (x + 0.5 - out.width / 2) / (out.width / 2);
      const dy = (y + 0.5 - cy) / 3;
      if (dx * dx + dy * dy <= 1) out.data[(y * out.width + x) * 4 + 3] = 90;
    }
  for (let y = 0; y < sp.height; y++)
    for (let x = 0; x < sp.width; x++) {
      const so = (y * sp.width + x) * 4;
      if (sp.data[so + 3]) sp.data.copy(out.data, (y * out.width + x + 2) * 4, so, so + 4);
    }
  return out;
}

// --------------------------------------------------- recognisable icons ----
const ICON_COLORS = {
  '#': [0, 0, 0],
  r: [208, 52, 52],
  R: [244, 150, 150],
  y: [226, 184, 48],
  Y: [250, 226, 130],
  s: [176, 184, 196],
  S: [226, 232, 240],
  b: [140, 92, 52],
  B: [186, 136, 84],
  w: [238, 236, 226],
  p: [150, 80, 196],
  P: [214, 170, 240],
  g: [70, 150, 70],
  G: [130, 200, 110],
  c: [170, 120, 80],
};
const ICONS = {
  heart: {
    accept: ['heart'],
    rows: [
      '',
      '',
      '..###...###',
      '.#rr##.##rr#',
      '#rRrrr#rrrrr#',
      '#rrrrrrrrrrr#',
      '#rrrrrrrrrrr#',
      '.#rrrrrrrrr#',
      '..#rrrrrrr#',
      '...#rrrrr#',
      '....#rrr#',
      '.....#r#',
      '......#',
    ],
  },
  key: {
    accept: ['key'],
    rows: [
      '',
      '....####',
      '...#yyyy#',
      '..#yy##yy#',
      '..#y#..#y#',
      '..#yy##yy#',
      '...#yyyy#',
      '....#yy#',
      '....#yy#',
      '....#yy#',
      '....#yy###',
      '....#yyyy#',
      '....#yy##',
      '....#yyyy#',
      '....#####',
    ],
  },
  sword: {
    accept: ['sword', 'blade', 'dagger', 'knife'],
    rows: [
      '.............##',
      '............#s#',
      '...........#sS#',
      '..........#sS#',
      '.........#sS#',
      '........#sS#',
      '.......#sS#',
      '..##..#sS#',
      '..#b##sS#',
      '...#bbS#',
      '....#bb#',
      '...#b#bb#',
      '..#b#.#b#',
      '.#b#...##',
      '.##',
    ],
  },
  potion: {
    accept: ['potion', 'flask', 'bottle', 'vial', 'elixir'],
    rows: [
      '',
      '.....####',
      '.....#cc#',
      '.....####',
      '.....#ww#',
      '.....#ww#',
      '....#wwww#',
      '...#pppppp#',
      '..#pppppppp#',
      '..#pPpppppp#',
      '..#pPpppppp#',
      '..#pppppppp#',
      '...#pppppp#',
      '....######',
    ],
  },
  coin: {
    accept: ['coin', 'token', 'medal', 'gold'],
    rows: [
      '',
      '',
      '....######',
      '...#yyyyyy#',
      '..#yyYYYYyy#',
      '..#yYyyyyYy#',
      '..#yYyyyyYy#',
      '..#yYyyyyYy#',
      '..#yYyyyyYy#',
      '..#yyYYYYyy#',
      '...#yyyyyy#',
      '....######',
    ],
  },
  tree: {
    accept: ['tree', 'bush', 'oak', 'plant'],
    rows: [
      '......####',
      '....##gggg##',
      '...#gggggggg#',
      '..#ggGgggggGg#',
      '..#gggggGgggg#',
      '..#gGgggggggg#',
      '...#gggggGgg#',
      '....##gggg##',
      '......#bb#',
      '......#bb#',
      '......#bb#',
      '.....#bbbb#',
      '.....######',
    ],
  },
  skull: {
    accept: ['skull', 'skeleton', 'bone'],
    rows: [
      '',
      '....######',
      '...#wwwwww#',
      '..#wwwwwwww#',
      '..#w##ww##w#',
      '..#w##ww##w#',
      '..#wwww#www#',
      '..#wwwwwwww#',
      '...#wwwwww#',
      '...#w#ww#w#',
      '....######',
    ],
  },
  star: {
    accept: ['star'],
    rows: [
      '.......#',
      '......#y#',
      '......#y#',
      '.....#yyy#',
      '.#####yyy#####',
      '.#yyyyyyyyyyy#',
      '..#yyyyyyyyy#',
      '...#yyyyyyy#',
      '....#yyyyy#',
      '...#yyyyyyy#',
      '...#yyy#yyy#',
      '..#yy##.##yy#',
      '..###.....###',
    ],
  },
  chest: {
    accept: ['chest', 'crate', 'box', 'trunk', 'treasure'],
    rows: [
      '',
      '',
      '..############',
      '.#bbbbbbbbbbbb#',
      '.#bBBBBBBBBBBb#',
      '.#bbbbbbbbbbbb#',
      '.##############',
      '.#bbbbb##bbbbb#',
      '.#bbbbb#yy#bbbb#',
      '.#bbbbb##bbbbb#',
      '.#bbbbbbbbbbbb#',
      '.#bbbbbbbbbbbb#',
      '.##############',
    ],
  },
  mushroom: {
    accept: ['mushroom', 'toadstool', 'shroom', 'fungus'],
    rows: [
      '',
      '.....######',
      '...##rrrrrr##',
      '..#rrwwrrrrrr#',
      '.#rrrwwrrrwwrr#',
      '.#rrrrrrrrwwrr#',
      '.#rrrrrrrrrrrr#',
      '..############',
      '.....#wwww#',
      '.....#wwww#',
      '.....#wwww#',
      '....#wwwwww#',
      '....########',
    ],
  },
};
function iconSprite(name) {
  const img = png.create(16, 16);
  ICONS[name].rows.forEach((row, y) => {
    for (let x = 0; x < Math.min(16, row.length); x++) {
      const c = ICON_COLORS[row[x]];
      if (c) setPixel(img, x, y, c);
    }
  });
  return img;
}

// ---------------------------------------------------------------- sheet ----
class Sheet {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.img = png.create(w, h);
    this.gt = new Int32Array(w * h);
    this.objects = [];
  }
  add(sp, x, y, kind, extra = {}) {
    const gid = this.objects.length + 1;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (let sy = 0; sy < sp.height; sy++)
      for (let sx = 0; sx < sp.width; sx++) {
        const so = (sy * sp.width + sx) * 4;
        const a = sp.data[so + 3];
        if (!a) continue;
        const px = x + sx;
        const py = y + sy;
        if (px < 0 || py < 0 || px >= this.w || py >= this.h) continue;
        const i = py * this.w + px;
        const ea = this.img.data[i * 4 + 3];
        if (a < 255) {
          if (ea) continue; // a shadow never covers artwork or an earlier shadow
        } else if (ea === 255) throw new Error(`generator bug: opaque overlap at ${px},${py}`);
        sp.data.copy(this.img.data, i * 4, so, so + 4);
        this.gt[i] = gid;
        x0 = Math.min(x0, px);
        x1 = Math.max(x1, px);
        y0 = Math.min(y0, py);
        y1 = Math.max(y1, py);
      }
    this.objects.push({ gid, kind, bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], ...extra });
    return gid;
  }
}
// Occupancy of a cw x ch lattice of cells.
function occupancyGrid(cw, ch) {
  const occ = new Uint8Array(cw * ch);
  const free = (cx, cy, w, h) => {
    if (cx + w > cw || cy + h > ch) return false;
    for (let y = cy; y < cy + h; y++)
      for (let x = cx; x < cx + w; x++) if (occ[y * cw + x]) return false;
    return true;
  };
  return {
    free,
    // the w x h block plus a one-cell margin, clipped to the lattice
    freeAround(cx, cy, w, h) {
      const x0 = Math.max(0, cx - 1);
      const y0 = Math.max(0, cy - 1);
      return free(x0, y0, Math.min(cw - x0, w + 2), Math.min(ch - y0, h + 2));
    },
    take(cx, cy, w, h) {
      for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) occ[y * cw + x] = 1;
    },
    // shrink a w x h block until it fits at (cx, cy); the cell itself must be free
    fit(cx, cy, w, h) {
      while (!free(cx, cy, w, h)) {
        if (w > 1) w--;
        else h--;
      }
      return [w, h];
    },
  };
}
function randomShape(w, h, r, o) {
  const kind = r();
  const mask =
    w >= 10 && h >= 8 && kind < 0.18
      ? splitMask(w, h, r)
      : kind < 0.3 && Math.min(w, h) >= 8
        ? stickMask(w, h)
        : kind < 0.65
          ? ellipseMask(w, h, r)
          : rectMask(w, h);
  return paint(mask, w, h, r, o);
}

// -------------------------------------------------------------- layouts ----
// objects on the lattice, each inset so neighbours never touch
function gridGap(seed, cw, ch, opt = {}) {
  const r = rng(seed);
  const s = new Sheet(cw * T, ch * T);
  const g = occupancyGrid(cw, ch);
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      if (!g.free(cx, cy, 1, 1)) continue;
      const [w, h] = g.fit(cx, cy, pick(r, [1, 1, 2, 2, 3]), pick(r, [1, 1, 2, 2, 3]));
      g.take(cx, cy, w, h);
      if (r() < 0.15) continue;
      const inset = randInt(r, 1, 2);
      const sp = randomShape(w * T - 2 * inset, h * T - 2 * inset, r, {
        outline: BLACK,
        base: pick(r, BASES),
      });
      if (opt.shadows && r() < 0.7)
        s.add(withShadow(sp), cx * T + inset - 2, cy * T + inset, 'object');
      else s.add(sp, cx * T + inset, cy * T + inset, 'object');
    }
  return s;
}
// outlined boxes that fill their cells and abut their neighbours: the dense case
function packedTouching(seed, cw, ch, opt = {}) {
  const r = rng(seed);
  const s = new Sheet(cw * T, ch * T);
  const g = occupancyGrid(cw, ch);
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      if (!g.free(cx, cy, 1, 1)) continue;
      const [w, h] = g.fit(cx, cy, pick(r, [1, 2, 2, 3]), pick(r, [1, 2, 2, 3]));
      g.take(cx, cy, w, h);
      const roll = r();
      if (roll < 0.12) continue;
      const o = { outline: opt.noOutline ? null : BLACK, base: pick(r, BASES) };
      if (roll < 0.8)
        s.add(paint(rectMask(w * T, h * T), w * T, h * T, r, o), cx * T, cy * T, 'object');
      else s.add(randomShape(w * T - 4, h * T - 4, r, o), cx * T + 2, cy * T + 2, 'object');
    }
  return s;
}
// 16px icon grid: label boxes, single icons and icons made of two loose parts
function iconGrid(seed, cw, ch) {
  const r = rng(seed);
  const s = new Sheet(cw * T, ch * T);
  for (let cy = 0; cy < ch; cy++) {
    const labelRow = cy % 3 === 0;
    for (let cx = 0; cx < cw; cx++) {
      if (labelRow && (cx === 0 || cx === 7)) {
        s.add(labelSprite(2 * T, T, r), cx * T, cy * T, 'label');
        cx++;
        continue;
      }
      if (cx === 6 || r() < 0.25) continue;
      const w = randInt(r, 10, 14);
      const h = randInt(r, 10, 14);
      const mask =
        r() < 0.35 ? splitMask(w, h, r) : r() < 0.3 ? stickMask(w, h) : ellipseMask(w, h, r);
      s.add(
        paint(mask, w, h, r, { outline: BLACK, base: pick(r, BASES) }),
        cx * T + randInt(r, 0, 16 - w),
        cy * T + randInt(r, 0, 16 - h),
        'object',
      );
    }
  }
  return s;
}
// blocks of outline-less terrain tiles plus a few ordinary objects
function tileset(seed, cw, ch) {
  const r = rng(seed);
  const s = new Sheet(cw * T, ch * T);
  const g = occupancyGrid(cw, ch);
  for (let n = 0; n < 5; n++) {
    const w = randInt(r, 2, 5);
    const h = randInt(r, 2, 4);
    for (let tries = 0; tries < 40; tries++) {
      const cx = randInt(r, 0, cw - w);
      const cy = randInt(r, 0, ch - h);
      if (!g.freeAround(cx, cy, w, h)) continue;
      g.take(cx, cy, w, h);
      const base = pick(r, BASES);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          s.add(tileSprite(T, shade(base, 0.9 + 0.2 * r()), r), (cx + x) * T, (cy + y) * T, 'tile');
      break;
    }
  }
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      if (!g.freeAround(cx, cy, 1, 1) || r() < 0.55) continue;
      g.take(cx, cy, 1, 1);
      s.add(
        randomShape(12, 12, r, { outline: BLACK, base: pick(r, BASES) }),
        cx * T + 2,
        cy * T + 2,
        'object',
      );
    }
  return s;
}
// free placement with gaps, no lattice at all
function loose(seed, W, H, n) {
  const r = rng(seed);
  const s = new Sheet(W, H);
  const boxes = [];
  for (let k = 0; k < n * 30 && boxes.length < n; k++) {
    const w = randInt(r, 7, 40);
    const h = randInt(r, 7, 40);
    const x = randInt(r, 1, W - w - 1);
    const y = randInt(r, 1, H - h - 1);
    if (
      boxes.some(
        (b) => x < b.x + b.w + 3 && b.x < x + w + 3 && y < b.y + b.h + 3 && b.y < y + h + 3,
      )
    )
      continue;
    boxes.push({ x, y, w, h });
    s.add(randomShape(w, h, r, { outline: BLACK, base: pick(r, BASES) }), x, y, 'object');
  }
  return s;
}
// outlined boxes of arbitrary size abutting in rows: touching, but on no lattice
function offGrid(seed, W, H) {
  const r = rng(seed);
  const s = new Sheet(W, H);
  let y = randInt(r, 2, 6);
  while (y + 32 < H) {
    const rowH = randInt(r, 13, 30);
    let x = randInt(r, 2, 9);
    while (x + 10 < W - 2) {
      const w = Math.min(randInt(r, 9, 38), W - 2 - x);
      if (r() < 0.15) {
        x += w + randInt(r, 2, 6);
        continue;
      }
      const h = randInt(r, Math.max(8, rowH - 8), rowH);
      s.add(
        paint(rectMask(w, h), w, h, r, { outline: BLACK, base: pick(r, BASES) }),
        x,
        y + rowH - h,
        'object',
      );
      x += w;
    }
    y += rowH + randInt(r, 3, 6);
  }
  return s;
}
function semanticIcons() {
  const names = Object.keys(ICONS);
  const s = new Sheet(10 * T, 4 * T);
  names.forEach((n, i) =>
    s.add(iconSprite(n), (i % 5) * 2 * T, Math.floor(i / 5) * 2 * T, 'object', {
      name: n,
      accept: ICONS[n].accept,
    }),
  );
  return s;
}

// ------------------------------------------------------------- variants ----
function flatten(img, bgAt) {
  const out = png.create(img.width, img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] === 255) img.data.copy(out.data, o, o, o + 4);
      else setPixel(out, x, y, bgAt(x, y));
    }
  return out;
}
function upscale(img, k) {
  const out = png.create(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const src = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4;
      img.data.copy(out.data, (y * out.width + x) * 4, src, src + 4);
    }
  return out;
}
const MAGENTA = () => [255, 0, 255];
const CHECKER = (x, y) => ((((x >> 3) + (y >> 3)) & 1) === 0 ? [204, 204, 204] : [255, 255, 255]);

const GRID_HINT = 'Pixel art. Everything is drawn on a 16x16 pixel tile grid.';
const cases = [];
const defineCase = (name, family, build, meta) => cases.push({ name, family, build, meta });
const SEEDS = process.argv[3] ? process.argv[3].split(',').map(Number) : [11, 12, 13];
for (const seed of SEEDS) {
  defineCase(`loose_${seed}`, 'loose', () => ({ sheet: loose(seed, 320, 240, 45) }), {
    tile: null,
    hint: 'Pixel art props placed freely with gaps. There is no tile grid.',
  });
  defineCase(`gridgap_${seed}`, 'gridgap', () => ({ sheet: gridGap(seed, 20, 14) }), {
    tile: 16,
    hint: GRID_HINT,
  });
  defineCase(`packed_${seed}`, 'packed', () => ({ sheet: packedTouching(seed, 20, 14) }), {
    tile: 16,
    hint: GRID_HINT + ' Furniture pieces are packed edge to edge.',
  });
  defineCase(`icons_${seed}`, 'icons', () => ({ sheet: iconGrid(seed, 14, 12) }), {
    tile: 16,
    hint: '16x16 crafting icons, one icon per cell. Some icons are drawn as two loose pieces. The pale boxes are category labels, not assets.',
  });
  defineCase(
    `shadows_${seed}`,
    'shadows',
    () => ({ sheet: gridGap(seed + 100, 20, 14, { shadows: true }) }),
    { tile: 16, hint: GRID_HINT + ' Objects have soft drop shadows.' },
  );
  defineCase(`tileset_${seed}`, 'tileset', () => ({ sheet: tileset(seed, 20, 14) }), {
    tile: 16,
    hint:
      GRID_HINT +
      ' Terrain blocks are meant to be used as individual 16x16 tiles; the small outlined props are separate objects.',
  });
  defineCase(
    `upscaled_${seed}`,
    'upscaled',
    () => {
      const sheet = packedTouching(seed + 200, 16, 12);
      return { sheet, image: upscale(flatten(sheet.img, MAGENTA), 3) };
    },
    {
      tile: 16,
      hint: GRID_HINT + ' This preview was enlarged and has a solid magenta background.',
    },
  );
  defineCase(
    `checker_${seed}`,
    'checker',
    () => {
      const sheet = gridGap(seed + 300, 20, 14);
      return { sheet, image: flatten(sheet.img, CHECKER) };
    },
    { tile: 16, hint: GRID_HINT + ' The transparency checkerboard was baked into the image.' },
  );
  defineCase(
    `nooutline_${seed}`,
    'nooutline',
    () => ({ sheet: packedTouching(seed + 400, 20, 14, { noOutline: true }) }),
    { tile: 16, hint: GRID_HINT + ' Flat-shaded pieces without outlines, packed edge to edge.' },
  );
  defineCase(`offgrid_${seed}`, 'offgrid', () => ({ sheet: offGrid(seed, 320, 240) }), {
    tile: null,
    hint: 'Pixel art crates of assorted sizes lined up edge to edge in rows. There is no tile grid.',
  });
}
if (!process.argv[3]) {
  defineCase('semantic_icons', 'semantic', () => ({ sheet: semanticIcons() }), {
    tile: 16,
    hint: '16x16 item icons, one per cell.',
  });
  defineCase('large_2048', 'large', () => ({ sheet: gridGap(777, 128, 128) }), {
    tile: 16,
    hint: GRID_HINT,
  });
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node test/gen.js <out-dir> [seed,seed,...]');
  process.exit(1);
}
for (const c of cases) {
  const { sheet, image } = c.build();
  const dir = path.join(outDir, c.name);
  fs.mkdirSync(dir, { recursive: true });
  png.write(path.join(dir, 'sheet.png'), image || sheet.img);
  fs.writeFileSync(path.join(dir, 'gt.bin'), Buffer.from(sheet.gt.buffer));
  png.write(path.join(dir, 'gt_native.png'), sheet.img); // used for scoring only
  fs.writeFileSync(
    path.join(dir, 'gt.json'),
    JSON.stringify(
      {
        name: c.name,
        family: c.family,
        nativeSize: [sheet.w, sheet.h],
        ...c.meta,
        objects: sheet.objects,
      },
      null,
      1,
    ),
  );
  const kinds = {};
  for (const o of sheet.objects) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  console.log(
    `${c.name.padEnd(16)} ${String(sheet.w).padStart(4)}x${String(sheet.h).padEnd(4)} ${JSON.stringify(kinds)}`,
  );
}
