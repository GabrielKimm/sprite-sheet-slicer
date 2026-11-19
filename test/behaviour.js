'use strict';
// Behaviour tests for the commands and every edit op, on tiny hand-built sheets
// where the right answer is obvious.
//   node test/behaviour.js [scratch-dir]
// The tests run in a fresh folder inside scratch-dir, or inside the system temp
// directory when none is given; in the latter case it is removed again when
// every test passes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const LIB =
  process.env.SLICER_LIB || path.join(__dirname, '..', 'skills', 'sprite-sheet-slicer', 'scripts');
const png = require(path.join(LIB, 'png.js'));
const SHEET = path.join(LIB, 'sheet.js');

const givenScratch = process.argv[2];
if (givenScratch) fs.mkdirSync(givenScratch, { recursive: true });
const scratch = fs.mkdtempSync(path.join(givenScratch || os.tmpdir(), 'slicer-behaviour-'));

const BLACK = [0, 0, 0];
function canvas(w, h) {
  const img = png.create(w, h);
  const put = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    img.data[o] = c[0];
    img.data[o + 1] = c[1];
    img.data[o + 2] = c[2];
    img.data[o + 3] = a;
  };
  return {
    img,
    put,
    // outlined box: black rim, coloured fill
    box(x, y, bw, bh, c) {
      for (let j = 0; j < bh; j++)
        for (let i = 0; i < bw; i++)
          put(x + i, y + j, i === 0 || j === 0 || i === bw - 1 || j === bh - 1 ? BLACK : c);
    },
    flat(x, y, bw, bh, c, a = 255) {
      for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) put(x + i, y + j, c, a);
    },
  };
}
const save = (name, cv) => {
  const f = path.join(scratch, name + '.png');
  png.write(f, cv.img);
  return f;
};
const run = (...args) => {
  const r = spawnSync(process.execPath, [SHEET, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const state = (w) => readJson(w, 'state.json');
const objs = (w) => readJson(w, 'objects.json');
const catalogue = (outDir) => readJson(outDir, 'assets.json');
const live = (w) => {
  run('review', '--work', w);
  return objs(w).objects;
};
const at = (w, x, y) => {
  const hits = objs(w).objects.filter(
    (o) =>
      x >= o.bbox[0] && y >= o.bbox[1] && x < o.bbox[0] + o.bbox[2] && y < o.bbox[1] + o.bbox[3],
  );
  return hits.sort((p, q) => p.area - q.area)[0];
};
let opsFiles = 0;
const apply = (w, ops) => {
  const f = path.join(w, `ops_${++opsFiles}.json`);
  fs.writeFileSync(f, JSON.stringify({ rev: state(w).rev, ops }));
  return run('apply', '--work', w, '--ops', f);
};

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push([true, name, '']);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
};
const has = (text, needle, what) => {
  if (!text.includes(needle))
    throw new Error(
      `${what}: expected to find "${needle}" in: ${text.trim().split('\n').slice(-2).join(' / ')}`,
    );
};

// ---- sheet A: 16px lattice ------------------------------------------------
// row 0: two outlined boxes side by side, an icon in two pieces, two flat terrain cells
// row 1: an outlined box with a soft shadow under it;  row 2: a pale label box
const A = canvas(128, 48);
A.box(0, 0, 16, 16, [200, 80, 60]);
A.box(16, 0, 16, 16, [60, 120, 200]);
A.box(49, 2, 5, 9, [90, 170, 90]);
A.box(56, 4, 6, 9, [90, 170, 90]);
A.flat(80, 0, 16, 16, [170, 150, 110]);
A.flat(96, 0, 16, 16, [150, 130, 95]);
A.box(66, 18, 12, 10, [150, 90, 180]);
A.flat(65, 28, 14, 3, BLACK, 90);
A.flat(0, 32, 32, 16, [236, 232, 214]);
const fileA = save('a', A);
const wa = path.join(scratch, 'a');
const outA = path.join(scratch, 'a_out');

test('detect separates two outlined boxes that share an edge', () => {
  const r = run('detect', fileA, '--work', wa, '--tile', '16');
  eq(r.code, 0, 'exit code');
  live(wa);
  if (at(wa, 4, 4).id === at(wa, 20, 4).id) throw new Error('the two boxes are one object');
});
test('flat cells of different colour are cut per cell and marked as tiles', () => {
  const l = at(wa, 84, 4);
  const r = at(wa, 100, 4);
  if (l.id === r.id) throw new Error('block not cut on the lattice');
  eq(l.kind, 'tile', 'kind');
});
test('shadow belongs to the object above it, body box excludes it', () => {
  const o = at(wa, 70, 22);
  eq(o.bbox[3], 13, 'bbox height with shadow');
  eq(o.body[3], 10, 'body height');
});
test('review reports the two-piece icon: shares a cell, same colours, close together', () => {
  const o = objs(wa);
  eq(o.hints.objectsSharingACell.split(' ').length, 2, 'objects sharing a cell');
  has(
    o.hints.closePairsSharingColours,
    '@2px=13x11',
    'shared-colour pair hint with the size together',
  );
});
test('stale ops file is rejected', () => {
  const f = path.join(wa, 'stale.json');
  fs.writeFileSync(f, JSON.stringify({ rev: 7, ops: [{ op: 'cells' }] }));
  const r = run('apply', '--work', wa, '--ops', f);
  eq(r.code, 1, 'exit code');
  has(r.out, 'rev 7', 'message');
});
test('ops file without rev is rejected', () => {
  const f = path.join(wa, 'norev.json');
  fs.writeFileSync(f, JSON.stringify([{ op: 'cells' }]));
  eq(run('apply', '--work', wa, '--ops', f).code, 1, 'exit code');
});
test('unknown id is rejected and nothing changes', () => {
  const before = state(wa).rev;
  const r = apply(wa, [{ op: 'merge', ids: [1, 99999] }]);
  eq(r.code, 1, 'exit code');
  eq(state(wa).rev, before, 'revision');
});
test('cells joins the pieces of the icon and keeps the smallest id', () => {
  const a = at(wa, 50, 5).id;
  const b = at(wa, 58, 8).id;
  eq(apply(wa, [{ op: 'cells' }]).code, 0, 'exit code');
  live(wa);
  eq(at(wa, 50, 5).id, Math.min(a, b), 'kept id');
  eq(at(wa, 58, 8).id, Math.min(a, b), 'second piece id');
});
test('split undoes it', () => {
  const id = at(wa, 50, 5).id;
  eq(apply(wa, [{ op: 'split', id }]).code, 0, 'exit code');
  live(wa);
  if (at(wa, 50, 5).id === at(wa, 58, 8).id) throw new Error('still one object');
});
test('near joins pieces 2px apart, and smallerThan keeps full-size neighbours apart', () => {
  eq(apply(wa, [{ op: 'near', px: 2, smallerThan: 12 }]).code, 0, 'exit code');
  live(wa);
  eq(at(wa, 50, 5).id, at(wa, 58, 8).id, 'icon pieces');
  if (at(wa, 4, 4).id === at(wa, 20, 4).id) throw new Error('the two 16px boxes were joined');
});
test('merging two tiles keeps them a tile; tiles splits them again', () => {
  const l = at(wa, 84, 4).id;
  const r = at(wa, 100, 4).id;
  eq(apply(wa, [{ op: 'merge', ids: [l, r] }]).code, 0, 'merge');
  live(wa);
  const id = at(wa, 84, 4).id;
  eq(at(wa, 84, 4).kind, 'tile', 'kind after merging two tiles');
  eq(apply(wa, [{ op: 'tiles', ids: [id] }]).code, 0, 'tiles');
  live(wa);
  if (at(wa, 84, 4).id === at(wa, 100, 4).id) throw new Error('tiles did not split');
  eq(at(wa, 84, 4).kind, 'tile', 'kind');
});
test('cut with a cell list makes pieces left to right and retires the id', () => {
  const l = at(wa, 84, 4).id;
  const r = at(wa, 100, 4).id;
  apply(wa, [{ op: 'merge', ids: [l, r] }]);
  live(wa);
  const id = at(wa, 84, 4).id;
  const res = apply(wa, [{ op: 'cut', id, axis: 'x', cells: [6] }]);
  eq(res.code, 0, 'exit code');
  has(res.out, 'retired', 'output');
  live(wa);
  if (at(wa, 84, 4).id >= at(wa, 100, 4).id)
    throw new Error('pieces are not numbered left to right');
  if (objs(wa).objects.some((o) => o.id === id)) throw new Error('old id still alive');
});
test('cut on a line outside the object is rejected with the span', () => {
  const id = at(wa, 4, 4).id;
  const r = apply(wa, [{ op: 'cut', id, axis: 'x', cell: 5 }]);
  eq(r.code, 1, 'exit code');
  has(r.out, 'does not pass through', 'message');
});
test('drop removes the label from export, restore brings it back', () => {
  const id = at(wa, 4, 36).id;
  eq(apply(wa, [{ op: 'drop', ids: [id], reason: 'label' }]).code, 0, 'drop');
  let r = run('export', '--work', wa, '--out', outA);
  eq(r.code, 0, 'export');
  const cat = catalogue(outA);
  if (cat.assets.some((s) => s.id === id)) throw new Error('dropped object exported');
  eq(cat.coverage.complete, true, 'coverage');
  eq(cat.coverage.droppedPixels, 512, 'dropped pixels');
  eq(
    png.read(path.join(outA, 'sheet.png')).data[(36 * 128 + 4) * 4 + 3],
    0,
    'label alpha in sheet.png',
  );
  eq(apply(wa, [{ op: 'restore', ids: [id] }]).code, 0, 'restore');
  r = run('export', '--work', wa, '--out', outA);
  eq(catalogue(outA).coverage.droppedPixels, 0, 'dropped pixels after restore');
});
test('export: tiles are whole cells, --pad cell pads everything, footprint uses the body, contact sheet written', () => {
  // the two terrain cells were cut apart as plain pieces above: mark them as tiles again
  live(wa);
  eq(
    apply(wa, [{ op: 'tiles', ids: [at(wa, 84, 4).id, at(wa, 100, 4).id] }]).code,
    0,
    'tiles on single cells',
  );
  eq(run('export', '--work', wa, '--out', outA).code, 0, 'export');
  let cat = catalogue(outA);
  const tile = cat.assets.find((s) => s.kind === 'tile');
  eq(png.read(path.join(outA, tile.file)).width, 16, 'tile sprite width');
  const shadowed = cat.assets.find((s) => s.hasShadow);
  eq(shadowed.footprintTiles.join('x'), '1x1', 'footprint of the shadowed box');
  eq(fs.existsSync(path.join(outA, 'contact_01.png')), true, 'contact sheet');
  eq(run('export', '--work', wa, '--out', outA, '--pad', 'cell').code, 0, 'export --pad cell');
  cat = catalogue(outA);
  for (const s of cat.assets) {
    const im = png.read(path.join(outA, s.file));
    if (im.width % 16 || im.height % 16) throw new Error(`${s.name} is ${im.width}x${im.height}`);
    eq(im.width, s.sourceRect.w, 'sprite width against sourceRect');
  }
  eq(cat.coverage.complete, true, 'coverage');
});
test('export validates names before touching the output folder and leaves other files alone', () => {
  fs.writeFileSync(path.join(outA, 'mine.txt'), 'keep');
  const before = fs.readdirSync(path.join(outA, 'sprites')).length;
  run('review', '--work', wa);
  const id = objs(wa).objects[0].id;
  const exportWithNames = (assets) => {
    const names = path.join(wa, 'names.json');
    fs.writeFileSync(names, JSON.stringify({ rev: state(wa).rev, assets }));
    return run('export', '--work', wa, '--out', outA, '--names', names);
  };
  eq(exportWithNames({ [id]: { name: 'Bad Name' } }).code, 1, 'bad name exit code');
  eq(fs.readdirSync(path.join(outA, 'sprites')).length, before, 'sprites untouched');
  eq(exportWithNames({ ['0' + id]: { name: 'a_b' } }).code, 1, 'zero-padded key');
  eq(exportWithNames({ [id]: { name: 'a_b', variantOf: 'nope' } }).code, 1, 'unknown variantOf');
  eq(
    exportWithNames({ [id]: { name: 'crate_red', confidence: 'high' } }).code,
    0,
    'export with a good name',
  );
  eq(fs.existsSync(path.join(outA, 'mine.txt')), true, 'other file kept');
  eq(catalogue(outA).assets.find((s) => s.id === id).confidence, 'high', 'confidence carried');
});
test('names for another revision are rejected', () => {
  const f = path.join(wa, 'oldnames.json');
  fs.writeFileSync(f, JSON.stringify({ rev: state(wa).rev + 3, assets: {} }));
  eq(run('export', '--work', wa, '--out', outA, '--names', f).code, 1, 'exit code');
});
test("export refuses a folder of someone else's files, and the work folder", () => {
  const foreign = path.join(scratch, 'foreign');
  fs.mkdirSync(path.join(foreign, 'sprites'), { recursive: true });
  fs.writeFileSync(path.join(foreign, 'sheet.png'), 'precious');
  fs.writeFileSync(path.join(foreign, 'sprites', 'hero.png'), 'precious');
  eq(run('export', '--work', wa, '--out', foreign).code, 1, 'exit code');
  eq(fs.readFileSync(path.join(foreign, 'sheet.png'), 'utf8'), 'precious', 'sheet.png untouched');
  eq(fs.existsSync(path.join(foreign, 'sprites', 'hero.png')), true, 'foreign sprite untouched');
  eq(run('export', '--work', wa, '--out', wa).code, 1, 'work folder as out');
});
test('ops: region on the wrong op, a tile override, a repeated id and a no-op are handled', () => {
  run('review', '--work', wa);
  const list = objs(wa).objects;
  eq(
    apply(wa, [{ op: 'merge', ids: [list[0].id, list[1].id], region: [0, 0, 1, 1] }]).code,
    1,
    'region on merge',
  );
  eq(apply(wa, [{ op: 'cells', tile: 8 }]).code, 1, 'tile override');
  eq(apply(wa, [{ op: 'merge', ids: [list[0].id, list[0].id] }]).code, 1, 'merge of one id twice');
  eq(apply(wa, [{ op: 'cells', region: [3, 3, 1, 1] }]).code, 1, 'reversed region');
  const rev = state(wa).rev;
  const r = apply(wa, [{ op: 'near', px: 0, region: [6, 2, 7, 2] }]);
  has(r.out, 'no change', 'output');
  eq(state(wa).rev, rev, 'revision after a no-op');
});
test('a bad --page is refused and does not break later reviews', () => {
  eq(run('review', '--work', wa, '--page', 'abc').code, 1, 'exit code');
  eq(run('review', '--work', wa).code, 0, 'plain review afterwards');
  eq(
    run('review', '--work', wa, '--zoom', '16', '--page', '400').code,
    0,
    'about one cell per page',
  );
});
test('review --ids writes one focus page and leaves the rest alone', () => {
  run('review', '--work', wa);
  const before = fs.readdirSync(path.join(wa, 'pages')).length;
  const id = objs(wa).objects[0].id;
  eq(run('review', '--work', wa, '--ids', String(id)).code, 0, 'exit code');
  eq(fs.readdirSync(path.join(wa, 'pages')).length, before + 1, 'page count');
});
test('unknown and mistyped options are refused; --tile=16 is understood', () => {
  const wx = path.join(scratch, 'x1');
  let r = run('detect', fileA, '--work', wx, '--tiel', '16');
  eq(r.code, 1, 'exit code for --tiel');
  has(r.out, '--tiel', 'message');
  r = run('detect', fileA, '--work', wx, '--tile=16');
  has(r.out, 'tile: 16px (argument)', 'summary');
  eq(run('detect', fileA, '--work', wx, '--tile', '7.5').code, 1, 'exit code for --tile 7.5');
});
test('rerunning detect keeps counting revisions, so old ops are refused', () => {
  const wv = path.join(scratch, 'v');
  run('detect', fileA, '--work', wv, '--tile', '16');
  const f = path.join(wv, 'old.json');
  fs.writeFileSync(f, JSON.stringify({ rev: 0, ops: [{ op: 'cells' }] }));
  run('detect', fileA, '--work', wv, '--tile', '16');
  eq(state(wv).rev, 1, 'revision after the second detect');
  eq(run('apply', '--work', wv, '--ops', f).code, 1, 'old ops file');
});

// ---- sheet B: walls centred on lattice lines -------------------------------
test('tiles refuses to halve walls that straddle the lattice, force overrides', () => {
  const B = canvas(64, 64);
  B.flat(13, 0, 6, 64, [110, 110, 110]); // 6px wall straddling x=16
  B.flat(0, 29, 64, 6, [110, 110, 110]); // and one straddling y=32
  const wb = path.join(scratch, 'b');
  run('detect', save('b', B), '--work', wb, '--tile', '16');
  eq(state(wb).nativeSize.join('x'), '64x64', 'not read as an enlargement');
  const list = live(wb);
  const r = apply(wb, [{ op: 'tiles', ids: list.map((o) => o.id) }]);
  eq(r.code, 1, 'exit code');
  has(r.out, 'slivers', 'message');
  eq(apply(wb, [{ op: 'tiles', ids: list.map((o) => o.id), force: true }]).code, 0, 'force');
});

// ---- sheet C: no lattice ----------------------------------------------------
const C = canvas(80, 40);
C.box(5, 6, 17, 20, [200, 160, 60]);
C.box(22, 9, 23, 17, [70, 150, 160]);
C.box(50, 5, 12, 12, [180, 90, 90]);
const fileC = save('c', C);
const wc = path.join(scratch, 'c');
test('without a lattice, touching outlined boxes are separated on the seam', () => {
  const r = run('detect', fileC, '--work', wc, '--tile', 'none');
  has(r.out, 'tile: none', 'summary');
  live(wc);
  eq(objs(wc).rulerUnit, 'px', 'ruler unit');
  if (at(wc, 8, 12).id === at(wc, 30, 15).id) throw new Error('boxes still fused');
});
test('cut by px moves to the seam, and refuses to shave a 1px sliver', () => {
  run('detect', fileC, '--work', wc, '--no-split', '--tile', 'none');
  live(wc);
  const id = at(wc, 8, 12).id;
  eq(id, at(wc, 30, 15).id, 'fused before the cut');
  eq(apply(wc, [{ op: 'cut', id, axis: 'x', px: 5 }]).code, 1, 'cut at the very edge');
  const r = apply(wc, [{ op: 'cut', id, axis: 'x', px: 20 }]);
  eq(r.code, 0, 'exit code');
  has(r.out, 'moved to the seam at 22', 'output');
  live(wc);
  eq(at(wc, 8, 12).bbox[2], 17, 'left box width');
});
test('cells explains that it needs a tile size', () => {
  const r = apply(wc, [{ op: 'cells' }]);
  eq(r.code, 1, 'exit code');
  has(r.out, 'no tile size', 'message');
});

// ---- backgrounds and scale --------------------------------------------------
test('opaque sheet on magenta, enlarged x3, comes back at native size with the key removed', () => {
  const D = canvas(64, 32);
  D.flat(0, 0, 64, 32, [255, 0, 255]);
  D.box(0, 0, 16, 16, [200, 80, 60]);
  D.box(16, 0, 16, 16, [60, 120, 200]);
  D.box(34, 2, 12, 12, [90, 170, 90]);
  for (let y = 3; y < 13; y++)
    for (let x = 35; x < 45; x++) if ((x + y) % 2) D.put(x, y, [60, 130, 60]); // dithered fill: plenty of edges
  D.box(2, 18, 58, 12, [120, 80, 40]);
  for (let y = 19; y < 29; y++)
    for (let x = 3; x < 59; x++) if ((x * 7 + y * 3) % 5 === 0) D.put(x, y, [150, 110, 60]);
  const big = png.create(192, 96);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 192; x++) {
      const src = (Math.floor(y / 3) * 64 + Math.floor(x / 3)) * 4;
      D.img.data.copy(big.data, (y * 192 + x) * 4, src, src + 4);
    }
  const f = path.join(scratch, 'd.png');
  png.write(f, big);
  const wd = path.join(scratch, 'd');
  const r = run('detect', f, '--work', wd, '--tile', '16');
  has(r.out, 'enlarged x3', 'summary');
  has(r.out, 'background: colorkey', 'summary');
  eq(state(wd).nativeSize.join('x'), '64x32', 'native size');
  live(wd);
  if (at(wd, 4, 4).id === at(wd, 20, 4).id) throw new Error('the two boxes are one object');
  eq(at(wd, 38, 6).bbox[2], 12, 'third box width');
});
test('a native image with few edges is not mistaken for an enlargement; --scale overrides', () => {
  const Q = canvas(64, 64);
  Q.flat(4, 4, 56, 56, [200, 80, 60]);
  const f = save('q', Q);
  const wq = path.join(scratch, 'q');
  const r = run('detect', f, '--work', wq);
  if (r.out.includes('enlarged')) throw new Error('read as an enlargement');
  eq(state(wq).nativeSize.join('x'), '64x64', 'native size');
  run('detect', f, '--work', wq, '--scale', '4');
  eq(state(wq).nativeSize.join('x'), '16x16', 'native size with --scale 4');
});
test('--bg names the background when it cannot be recognised, and a bad value is refused', () => {
  const E = canvas(48, 16);
  E.flat(0, 0, 48, 16, [40, 90, 40]);
  E.flat(2, 2, 12, 12, [200, 200, 80]);
  E.flat(18, 2, 12, 12, [200, 200, 80]);
  E.flat(34, 2, 12, 12, [80, 80, 200]);
  const f = save('e', E);
  const we = path.join(scratch, 'e');
  run('detect', f, '--work', we, '--bg', '285a28');
  eq(live(we).length, 3, 'objects with --bg');
  eq(run('detect', f, '--work', we, '--bg', 'nope').code, 1, 'bad --bg exit code');
  has(
    run('detect', f, '--work', we, '--bg', '123456').out,
    'does not occur',
    'warning for an absent colour',
  );
});
test('--bg is honoured on a sheet that also has transparent pixels', () => {
  const M = canvas(50, 50);
  M.flat(0, 2, 50, 48, [255, 0, 255]);
  M.flat(8, 10, 10, 10, [200, 30, 30]);
  M.flat(30, 10, 10, 10, [200, 30, 30]);
  const wm = path.join(scratch, 'm');
  run('detect', save('m', M), '--work', wm, '--bg', 'ff00ff', '--tile', 'none');
  eq(live(wm).length, 2, 'objects');
});
test('transparent pixels on a mostly opaque sheet are background, not artwork', () => {
  const H = canvas(100, 100);
  H.flat(0, 0, 100, 100, [255, 0, 255]);
  H.flat(10, 10, 10, 10, [40, 60, 200]);
  H.flat(21, 10, 10, 10, [40, 160, 60]);
  for (let y = 10; y < 20; y++) H.put(20, y, BLACK, 0);
  for (let y = 60; y < 63; y++) for (let x = 60; x < 63; x++) H.put(x, y, BLACK, 0);
  const wh = path.join(scratch, 'h');
  run('detect', save('h', H), '--work', wh, '--tile', 'none');
  eq(live(wh).length, 2, 'objects');
  has(
    run('export', '--work', wh, '--out', path.join(scratch, 'h_out')).out,
    '"emptySprites":0',
    'coverage',
  );
});
test('sheet packed to its edges with 1px key-colour gutters: gutters are background, outlines survive', () => {
  const P = canvas(8 * 14 + 7, 6 * 14 + 5);
  P.flat(0, 0, P.img.width, P.img.height, [255, 0, 255]);
  for (let r = 0; r < 6; r++)
    for (let c = 0; c < 8; c++) P.box(c * 15, r * 15, 14, 14, [60 + c * 20, 120, 200 - r * 20]);
  const wp = path.join(scratch, 'p');
  const r = run('detect', save('p', P), '--work', wp, '--tile', 'none');
  has(r.out, 'background: colorkey #ff00ffff', 'summary');
  const list = live(wp);
  eq(list.length, 48, 'objects');
  eq(
    list.every((o) => o.area === 196),
    true,
    'every box keeps its outline',
  );
});
test('a thin artwork colour touching the border beside the real background is not background', () => {
  const N = canvas(160, 96);
  N.flat(0, 0, 160, 96, [255, 0, 255]);
  // blades clipped by the top edge
  for (let s = 0; s < 8; s++)
    for (let y = 0; y < 30; y++) {
      N.put(10 + s * 18, y, [180, 190, 200]);
      N.put(11 + s * 18, y, [180, 190, 200]);
    }
  for (let s = 0; s < 4; s++) N.box(20 + s * 30, 50, 12, 20, [120, 80, 40]);
  const wn = path.join(scratch, 'n');
  const r = run('detect', save('n', N), '--work', wn, '--tile', 'none');
  has(r.out, 'background: colorkey #ff00ffff', 'summary');
  eq(live(wn).length, 12, 'objects');
});
test('a glow that touches nothing solid is its own object; merge then split restores it with unique ids', () => {
  const G = canvas(48, 16);
  G.box(2, 2, 12, 12, [200, 80, 60]);
  G.flat(24, 4, 8, 8, [255, 240, 120], 128);
  for (let i = 0; i < 40; i++) G.put(40 + (i % 4), 1 + Math.floor(i / 4), BLACK, 60); // enough soft pixels to count as a layer
  const wg = path.join(scratch, 'g');
  run('detect', save('g', G), '--work', wg, '--tile', 'none');
  has(
    run('export', '--work', wg, '--out', path.join(scratch, 'g_out')).out,
    '"complete":true',
    'coverage',
  );
  const list = live(wg);
  const boxId = at(wg, 5, 5).id;
  const glowId = at(wg, 26, 6).id;
  eq(apply(wg, [{ op: 'merge', ids: [boxId, glowId] }]).code, 0, 'merge');
  live(wg);
  eq(apply(wg, [{ op: 'split', id: at(wg, 5, 5).id }]).code, 0, 'split');
  const after = live(wg);
  eq(after.length, list.length, 'object count after merge and split');
  eq(new Set(after.map((o) => o.id)).size, after.length, 'unique ids');
  if (Math.max(...after.map((o) => o.id)) >= state(wg).nextId)
    throw new Error('an id at or above nextId is in use');
});

// ---- lattice edge cases -------------------------------------------------------
test('a 1px diagonal stroke crossing lattice lines stays one object', () => {
  const Z = canvas(64, 64);
  for (let i = 4; i < 44; i++) Z.put(i, i, [200, 200, 80]);
  for (let s = 0; s < 14; s++) Z.box(50, 1 + s * 4, 3, 3, [60, 120, 200]); // company, so the sheet is not taken for a scene
  const wz = path.join(scratch, 'z');
  run('detect', save('z', Z), '--work', wz, '--tile', '16');
  live(wz);
  eq(at(wz, 6, 6).id, at(wz, 40, 40).id, 'both ends of the stroke');
});
test('outlined boxes standing on flat artwork are never fused with it silently', () => {
  // The pixels cannot say whether rim-against-fill is two assets or one (a table
  // top on its frame), so either answer is allowed, but a fused result must be flagged.
  for (const [name, boxes] of [
    ['f1', [[0, 0]]],
    [
      'f2',
      [
        [0, 0],
        [16, 0],
      ],
    ],
  ]) {
    const F = canvas(64, 48);
    for (const [x, y] of boxes) F.box(x, y, 16, 16, [200, 80, 60]);
    F.flat(0, 16, 32, 16, [236, 232, 214]);
    F.box(40, 4, 10, 10, [60, 120, 200]);
    F.box(40, 30, 10, 10, [60, 120, 200]);
    const wf = path.join(scratch, name);
    run('detect', save(name, F), '--work', wf, '--tile', '16');
    live(wf);
    const o = at(wf, 4, 4);
    if (o.id === at(wf, 20, 20).id && !(o.flags || []).includes('doubtful_border'))
      throw new Error(`${name}: fused without a flag: ${JSON.stringify(o.flags)}`);
  }
});
test('every part of the sheet is on some page, including the far edge', () => {
  const R = canvas(277, 41);
  R.box(2, 5, 10, 10, [200, 80, 60]);
  R.box(130, 5, 10, 10, [60, 120, 200]);
  R.box(272, 5, 5, 10, [90, 170, 90]);
  const wr = path.join(scratch, 'r');
  run('detect', save('r', R), '--work', wr, '--tile', 'none');
  run('review', '--work', wr, '--zoom', '4');
  const o = objs(wr);
  if (!o.objects.some((q) => q.bbox[0] === 272)) throw new Error('edge object missing');
  if (!o.pages.some((p) => p.covers.px[0] <= 272 && p.covers.px[2] >= 276))
    throw new Error('no page covers x 272..276');
});

// ---- command line -------------------------------------------------------------
test('--help exits 0 and lists the commands', () => {
  const r = run('--help');
  eq(r.code, 0, 'exit code');
  has(r.out, 'status --work', 'usage');
});
test('not a PNG, and a missing file, fail with a plain message', () => {
  const f = path.join(scratch, 'fake.png');
  fs.writeFileSync(f, 'JFIF not a png');
  let r = run('detect', f, '--work', path.join(scratch, 'x'));
  eq(r.code, 1, 'exit code');
  has(r.out, 'not a PNG', 'message');
  r = run('detect', path.join(scratch, 'missing.png'), '--work', path.join(scratch, 'x'));
  eq(r.code, 1, 'exit code for a missing file');
  if (r.out.includes('    at ')) throw new Error('stack trace shown for a missing file');
});

const failed = results.filter(([ok]) => !ok).length;
for (const [ok, name, msg] of results)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${msg ? '  ' + msg : ''}`);
console.log(`${results.length - failed}/${results.length} passed`);
if (!givenScratch && !failed) fs.rmSync(scratch, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
