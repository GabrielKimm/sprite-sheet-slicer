'use strict';
// Renders review pages. The artwork keeps its true colours; each object is marked
// by a contour along the edge of its pixels and by its id. A tint would distort the
// colours a reviewer names things by.
const png = require('./png');

const FONT = {
  0: '111101101101111',
  1: '010110010010111',
  2: '111001111100111',
  3: '111001111001111',
  4: '101101111001001',
  5: '111100111001111',
  6: '111100111101111',
  7: '111001001001001',
  8: '111101111101111',
  9: '111101111001111',
};

const PALETTE = [
  [255, 64, 64],
  [64, 200, 255],
  [255, 208, 0],
  [96, 255, 96],
  [255, 96, 224],
  [255, 144, 32],
  [170, 140, 255],
  [0, 255, 200],
];

function set(img, x, y, c, a = 255) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  const t = a / 255;
  img.data[o] = Math.round(img.data[o] * (1 - t) + c[0] * t);
  img.data[o + 1] = Math.round(img.data[o + 1] * (1 - t) + c[1] * t);
  img.data[o + 2] = Math.round(img.data[o + 2] * (1 - t) + c[2] * t);
  img.data[o + 3] = 255;
}
function fill(img, x0, y0, w, h, c, a = 255) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(img, x, y, c, a);
}
function rect(img, x0, y0, w, h, c) {
  for (let x = x0; x < x0 + w; x++) {
    set(img, x, y0, c);
    set(img, x, y0 + h - 1, c);
  }
  for (let y = y0; y < y0 + h; y++) {
    set(img, x0, y, c);
    set(img, x0 + w - 1, y, c);
  }
}
// Digits from a 3x5 font, scaled by `scale`, on a dark backing box.
const textSize = (str, scale) => [str.length * 4 * scale + scale, 7 * scale];
function text(img, x, y, str, c, scale) {
  const [tw, th] = textSize(str, scale);
  fill(img, x, y, tw, th, [0, 0, 0], 235);
  let cx = x + scale;
  for (const ch of str) {
    const glyph = FONT[ch];
    if (glyph)
      for (let r = 0; r < 5; r++)
        for (let q = 0; q < 3; q++)
          if (glyph[r * 3 + q] === '1')
            fill(img, cx + q * scale, y + scale + r * scale, scale, scale, c);
    cx += 4 * scale;
  }
}

const labelAt = (src, labels, x, y) =>
  x < 0 || y < 0 || x >= src.width || y >= src.height ? 0 : labels[y * src.width + x];

// One page: region `reg` of the sheet at zoom k.
//   opts.tile      lattice pitch for rulers and grid lines (required)
//   opts.rulerPx   rulers show pixels instead of cells (sheet without a lattice)
//   opts.dropped   {id: reason}: drawn dimmed, no contour, no id (required)
//   opts.flagged   Set of ids drawn with a white double box (required)
//   opts.ambiguous doubtful lattice borders (magenta bars), optional
//   opts.seams     seams cut on a lattice-free sheet (cyan dashes), optional
function page(src, labels, objs, reg, k, opts) {
  const T = opts.tile;
  const textScale = k >= 3 ? 2 : 1;
  // room for the widest ruler number: 4 digits in pixels, 3 in cells
  const margin = (opts.rulerPx ? 4 : 3) * 4 * textScale + textScale + 3;
  const dropped = opts.dropped;
  const W = src.width;
  const out = png.create(reg.w * k + margin, reg.h * k + margin);
  fill(out, 0, 0, out.width, out.height, [18, 18, 22]);

  // artwork on a neutral checker, true colours
  for (let y = 0; y < reg.h * k; y++)
    for (let x = 0; x < reg.w * k; x++) {
      const sx = reg.x + ((x / k) | 0);
      const sy = reg.y + ((y / k) | 0);
      const dark = (((sx >> 2) + (sy >> 2)) & 1) === 0;
      set(out, margin + x, margin + y, dark ? [44, 44, 50] : [58, 58, 64]);
      const so = (sy * W + sx) * 4;
      const a = src.data[so + 3];
      if (a)
        set(
          out,
          margin + x,
          margin + y,
          [src.data[so], src.data[so + 1], src.data[so + 2]],
          dropped[labels[sy * W + sx]] ? Math.round(a * 0.3) : a,
        );
    }

  // lattice and rulers
  const tick = (v) => String(opts.rulerPx ? v * T : v);
  for (let c = Math.ceil(reg.x / T); c * T < reg.x + reg.w; c++) {
    const px = margin + (c * T - reg.x) * k;
    for (let y = margin; y < out.height; y += 3) set(out, px, y, [255, 255, 255], 60);
    text(out, px + 1, 1, tick(c), [255, 255, 255], textScale);
  }
  for (let r = Math.ceil(reg.y / T); r * T < reg.y + reg.h; r++) {
    const py = margin + (r * T - reg.y) * k;
    for (let x = margin; x < out.width; x += 3) set(out, x, py, [255, 255, 255], 60);
    text(out, 0, py + 1, tick(r), [255, 255, 255], textScale);
  }

  // contours: a line on the inside of every pixel edge where the object ends
  for (let sy = reg.y; sy < reg.y + reg.h; sy++)
    for (let sx = reg.x; sx < reg.x + reg.w; sx++) {
      const l = labels[sy * W + sx];
      if (!l || dropped[l]) continue;
      const c = PALETTE[l % PALETTE.length];
      const px = margin + (sx - reg.x) * k;
      const py = margin + (sy - reg.y) * k;
      if (labelAt(src, labels, sx - 1, sy) !== l) fill(out, px, py, 1, k, c);
      if (labelAt(src, labels, sx + 1, sy) !== l) fill(out, px + k - 1, py, 1, k, c);
      if (labelAt(src, labels, sx, sy - 1) !== l) fill(out, px, py, k, 1, c);
      if (labelAt(src, labels, sx, sy + 1) !== l) fill(out, px, py + k - 1, k, 1, c);
    }

  drawMarks(out, reg, k, margin, T, opts);

  const visible = objs.filter(
    (o) =>
      o &&
      !dropped[o.id] &&
      o.x1 >= reg.x &&
      o.x0 < reg.x + reg.w &&
      o.y1 >= reg.y &&
      o.y0 < reg.y + reg.h,
  );
  for (const o of visible) {
    if (!opts.flagged.has(o.id)) continue;
    const bx = margin + (o.x0 - reg.x) * k;
    const by = margin + (o.y0 - reg.y) * k;
    const bw = (o.x1 - o.x0 + 1) * k;
    const bh = (o.y1 - o.y0 + 1) * k;
    rect(out, bx - 2, by - 2, bw + 4, bh + 4, [255, 255, 255]);
    rect(out, bx - 4, by - 4, bw + 8, bh + 8, [255, 255, 255]);
  }

  placeIds(out, src, labels, visible, reg, k, margin, textScale);
  return { image: out, ids: visible.map((o) => o.id) };
}

// Doubtful lattice borders (magenta bars) and seams cut on a lattice-free sheet
// (cyan dashes), both clipped to the page.
function drawMarks(out, reg, k, margin, T, opts) {
  for (const e of opts.ambiguous || []) {
    const [cx, cy] = e.cell;
    if (e.orient === 'v') {
      const y0 = Math.max(cy * T, reg.y);
      const y1 = Math.min(cy * T + T, reg.y + reg.h);
      if (e.pos > reg.x && e.pos < reg.x + reg.w && y1 > y0)
        fill(
          out,
          margin + (e.pos - reg.x) * k - 1,
          margin + (y0 - reg.y) * k,
          3,
          (y1 - y0) * k,
          [255, 0, 255],
          220,
        );
    } else {
      const x0 = Math.max(cx * T, reg.x);
      const x1 = Math.min(cx * T + T, reg.x + reg.w);
      if (e.pos > reg.y && e.pos < reg.y + reg.h && x1 > x0)
        fill(
          out,
          margin + (x0 - reg.x) * k,
          margin + (e.pos - reg.y) * k - 1,
          (x1 - x0) * k,
          3,
          [255, 0, 255],
          220,
        );
    }
  }
  // seams cut by the script on a lattice-free sheet: cyan dashes over the contours
  const dash = (i) => (i >> 2) % 2 === 0;
  for (const s of opts.seams || []) {
    if (s.orient === 'v') {
      if (s.pos <= reg.x || s.pos >= reg.x + reg.w) continue;
      for (let y = Math.max(s.from, reg.y) * k; y < Math.min(s.to + 1, reg.y + reg.h) * k; y++)
        if (dash(y))
          fill(out, margin + (s.pos - reg.x) * k - 1, margin + y - reg.y * k, 3, 1, [0, 255, 255]);
    } else {
      if (s.pos <= reg.y || s.pos >= reg.y + reg.h) continue;
      for (let x = Math.max(s.from, reg.x) * k; x < Math.min(s.to + 1, reg.x + reg.w) * k; x++)
        if (dash(x))
          fill(out, margin + x - reg.x * k, margin + (s.pos - reg.y) * k - 1, 1, 3, [0, 255, 255]);
    }
  }
}

// Object ids. The anchor is the object's own first solid pixel, so the number
// always touches its object. Prefer a spot just outside the object over empty
// background; never cover another id. Small objects choose first.
function placeIds(out, src, labels, visible, reg, k, margin, textScale) {
  const W = src.width;
  const placed = [];
  const clash = (x, y, w, h) =>
    placed.some((p) => x < p[0] + p[2] && p[0] < x + w && y < p[1] + p[3] && p[1] < y + h);
  const emptyUnder = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy += Math.max(1, k >> 1))
      for (let xx = x; xx < x + w; xx += Math.max(1, k >> 1)) {
        const sx = reg.x + Math.floor((xx - margin) / k);
        const sy = reg.y + Math.floor((yy - margin) / k);
        if (labelAt(src, labels, sx, sy)) return false;
      }
    return true;
  };
  for (const o of [...visible].sort((a, b) => a.area - b.area)) {
    const str = String(o.id);
    const [tw, th] = textSize(str, textScale);
    // anchor on the object itself: its first solid pixel, or when that lies off
    // this page, the first of its pixels that is on the page
    let px = o.ax;
    let py = o.ay;
    if (px < reg.x || py < reg.y || px >= reg.x + reg.w || py >= reg.y + reg.h) {
      px = -1;
      for (let sy = Math.max(o.y0, reg.y); sy <= Math.min(o.y1, reg.y + reg.h - 1) && px < 0; sy++)
        for (let sx = Math.max(o.x0, reg.x); sx <= Math.min(o.x1, reg.x + reg.w - 1); sx++)
          if (labels[sy * W + sx] === o.id) {
            px = sx;
            py = sy;
            break;
          }
      if (px < 0) continue; // its box reaches this page but none of its pixels do
    }
    const ax = margin + (px - reg.x) * k;
    const ay = margin + (py - reg.y) * k;
    const bx = margin + (Math.max(o.x0, reg.x) - reg.x) * k;
    const by1 = margin + (Math.min(o.y1 + 1, reg.y + reg.h) - reg.y) * k;
    const inPage = (x, y) =>
      x >= margin && y >= margin && x + tw <= out.width && y + th <= out.height;
    const outside = [
      [ax, ay - th - 1],
      [ax - tw - 1, ay],
      [bx, by1 + 1],
      [ax + k, ay - th - 1],
    ];
    const inside = [
      [ax + 1, ay + 1],
      [ax + 1, ay + th + 2],
      [ax + tw + 2, ay + 1],
    ];
    const freeOutside = () =>
      outside.find(([x, y]) => inPage(x, y) && !clash(x, y, tw, th) && emptyUnder(x, y, tw, th));
    const freeInside = () => inside.find(([x, y]) => inPage(x, y) && !clash(x, y, tw, th));
    // on a large object the number hides little and is unmistakably its own, so it
    // goes inside; on a small one it would hide the sprite, so it goes beside it
    const roomy = o.area * k * k >= tw * th * 12;
    let spot = roomy ? freeInside() || freeOutside() : freeOutside() || freeInside();
    if (!spot) {
      // crowded: walk down from the anchor until the number no longer covers another one
      const x = Math.min(Math.max(ax + 1, margin), out.width - tw);
      let y = Math.min(Math.max(ay + 1, margin), out.height - th);
      for (
        let tries = 0;
        tries < 12 && clash(x, y, tw, th) && y + th * 2 + 1 <= out.height;
        tries++
      )
        y += th + 1;
      spot = [x, y];
    }
    placed.push([spot[0], spot[1], tw, th]);
    text(out, spot[0], spot[1], str, PALETTE[o.id % PALETTE.length], textScale);
  }
}

module.exports = { page };
