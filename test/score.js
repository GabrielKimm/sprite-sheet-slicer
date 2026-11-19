'use strict';
// Score a slicer work folder against the ground truth written by gen.js.
//   node test/score.js <case-dir> <work-dir> [--export <export-dir>]
// An asset counts as exact only when one predicted object owns exactly its
// pixels and nothing else. Reported on solid pixels, and again with shadows.
const fs = require('fs');
const path = require('path');
const LIB =
  process.env.SLICER_LIB || path.join(__dirname, '..', 'skills', 'sprite-sheet-slicer', 'scripts');
const png = require(path.join(LIB, 'png.js'));

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readInt32 = (file) => {
  const b = fs.readFileSync(file);
  return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};

function loadTruth(caseDir) {
  const meta = readJson(path.join(caseDir, 'gt.json'));
  const gt = readInt32(path.join(caseDir, 'gt.bin'));
  const native = png.read(path.join(caseDir, 'gt_native.png'));
  const alpha = new Uint8Array(gt.length);
  for (let i = 0; i < gt.length; i++) alpha[i] = native.data[i * 4 + 3];
  return { meta, gt, alpha };
}

// Compare predicted labels with the truth. Without `withShadow`, pixels that
// are only partly opaque are ignored; with it they count as artwork.
function tally({ meta, gt, alpha }, pred, dropped, withShadow) {
  const gtArea = new Map();
  const predArea = new Map();
  const overlap = new Map(); // truth id -> Map(predicted id -> pixel count)
  let fgLost = 0;
  let bgAsFg = 0;
  for (let i = 0; i < gt.length; i++) {
    const a = alpha[i];
    if (!withShadow && a > 0 && a < 255) continue;
    const g = (withShadow ? a > 0 : a === 255) ? gt[i] : 0;
    const p = pred[i];
    if (p) predArea.set(p, (predArea.get(p) || 0) + 1);
    if (!g) {
      if (p) bgAsFg++;
      continue;
    }
    gtArea.set(g, (gtArea.get(g) || 0) + 1);
    if (!p) {
      fgLost++;
      continue;
    }
    if (!overlap.has(g)) overlap.set(g, new Map());
    const m = overlap.get(g);
    m.set(p, (m.get(p) || 0) + 1);
  }
  const r = {
    assets: 0,
    exact: 0,
    merged: 0,
    split: 0,
    mixed: 0,
    missing: 0,
    assetsDropped: 0,
    labels: 0,
    labelsDropped: 0,
    fgLost,
    bgAsFg,
    perObject: {},
  };
  for (const o of meta.objects) {
    const area = gtArea.get(o.gid) || 0;
    const preds = [...(overlap.get(o.gid) || [])];
    if (o.kind === 'label') {
      r.labels++;
      if (preds.length && preds.every(([p]) => dropped[p])) r.labelsDropped++;
      continue;
    }
    r.assets++;
    let verdict;
    if (!area || !preds.length) verdict = 'missing';
    else if (preds.some(([p]) => dropped[p])) verdict = 'dropped';
    else {
      const covered = preds.reduce((sum, [, c]) => sum + c, 0) === area;
      const pure = preds.every(([p, c]) => predArea.get(p) === c);
      if (preds.length === 1 && covered && pure) verdict = 'exact';
      else if (preds.length === 1 && covered) verdict = 'merged';
      else if (pure) verdict = 'split';
      else verdict = 'mixed';
    }
    if (verdict === 'dropped') r.assetsDropped++;
    else r[verdict]++;
    preds.sort((a, b) => b[1] - a[1]);
    r.perObject[o.gid] = { verdict, best: preds[0]?.[0] || 0 };
  }
  return r;
}

// Number of 8-connected solid pieces each ground-truth asset is drawn as.
function pieceCounts(gt, alpha, w, h) {
  const seen = new Uint8Array(gt.length);
  const pieces = new Map();
  for (let start = 0; start < gt.length; start++) {
    if (!gt[start] || alpha[start] !== 255 || seen[start]) continue;
    const g = gt[start];
    pieces.set(g, (pieces.get(g) || 0) + 1);
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (gt[j] === g && alpha[j] === 255 && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
  }
  return pieces;
}

// Score a label image (one id per native pixel, 0 for background) against the
// truth. `dropped` maps ids the slicer excluded from export.
function scoreLabels(truth, pred, dropped = {}) {
  const { meta, gt, alpha } = truth;
  const solid = tally(truth, pred, dropped, false);
  const withShadow = tally(truth, pred, dropped, true);
  const live = new Set();
  for (let i = 0; i < pred.length; i++) if (pred[i] && !dropped[pred[i]]) live.add(pred[i]);

  const result = {
    name: meta.name,
    family: meta.family,
    gtAssets: countAssets(meta),
  };
  // Shadow pixels: share that went to the object owning the shadow in the truth.
  // Where two shadows overlap the truth itself is arbitrary, so this is reported
  // per pixel instead of demanding an exact match per object.
  let shadowPx = 0;
  let shadowOk = 0;
  for (let i = 0; i < gt.length; i++) {
    if (!(alpha[i] > 0 && alpha[i] < 255) || !gt[i]) continue;
    shadowPx++;
    if (pred[i] && solid.perObject[gt[i]]?.best === pred[i]) shadowOk++;
  }
  if (shadowPx) result.shadowPixelAccuracy = +(shadowOk / shadowPx).toFixed(4);
  Object.assign(result, {
    predAssets: live.size,
    exact: solid.exact,
    merged: solid.merged,
    split: solid.split,
    mixed: solid.mixed,
    missing: solid.missing,
    assetsDropped: solid.assetsDropped,
    labels: solid.labels,
    labelsDropped: solid.labelsDropped,
    fgLost: solid.fgLost,
    bgAsFg: solid.bgAsFg,
    exactRate: +(solid.exact / Math.max(1, solid.assets)).toFixed(4),
    precision: +(solid.exact / Math.max(1, live.size)).toFixed(4),
    exactRateWithShadow: +(withShadow.exact / Math.max(1, withShadow.assets)).toFixed(4),
  });

  // Single-piece assets are the script's job; multi-piece ones need the review loop.
  const pieces = pieceCounts(gt, alpha, meta.nativeSize[0], meta.nativeSize[1]);
  result.single = { n: 0, exact: 0 };
  result.multi = { n: 0, exact: 0 };
  for (const o of meta.objects) {
    if (o.kind === 'label') continue;
    const bucket = (pieces.get(o.gid) || 1) > 1 ? result.multi : result.single;
    bucket.n++;
    if (solid.perObject[o.gid]?.verdict === 'exact') bucket.exact++;
  }
  return { result, perObject: solid.perObject };
}

// Naming is checked only for truth objects that carry accepted words.
function scoreNames(meta, perObject, catalog) {
  const named = meta.objects.filter((o) => o.accept);
  const detail = [];
  let hits = 0;
  for (const o of named) {
    const id = perObject[o.gid]?.best;
    const asset = catalog?.assets.find((a) => a.id === id);
    const text = asset
      ? [asset.name, asset.category, ...(asset.tags || []), asset.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
      : '';
    const hit = o.accept.some((word) => text.includes(word));
    if (hit) hits++;
    detail.push({ truth: o.name, got: asset ? asset.name : null, hit });
  }
  return { nameable: named.length, nameHits: hits, nameDetail: detail };
}

const countAssets = (meta) => meta.objects.filter((o) => o.kind !== 'label').length;

// Result row for a case that could not be scored.
function failedResult(meta, error) {
  return {
    name: meta.name,
    family: meta.family,
    gtAssets: countAssets(meta),
    error,
    exactRate: 0,
    exactRateWithShadow: 0,
  };
}

function score(caseDir, workDir, exportDir) {
  const truth = loadTruth(caseDir);
  const { meta } = truth;
  let state;
  try {
    state = readJson(path.join(workDir, 'state.json'));
  } catch {
    return failedResult(meta, 'no state.json');
  }
  const info = {
    rev: state.rev,
    tileUsed: state.grid.tile,
    scale: state.pixelScale.scale,
    sheetKind: state.diagnosis.sheetKind,
  };
  if (state.nativeSize[0] !== meta.nativeSize[0] || state.nativeSize[1] !== meta.nativeSize[1])
    return {
      ...failedResult(meta, `native size ${state.nativeSize} != truth ${meta.nativeSize}`),
      ...info,
    };

  const labels = readInt32(path.join(workDir, 'labels.bin'));
  const { result, perObject } = scoreLabels(truth, labels, state.dropped);
  const scored = { ...info, ...result };

  if (!meta.objects.some((o) => o.accept)) return scored;
  let catalog = null;
  try {
    catalog = readJson(path.join(exportDir || path.join(workDir, '..', 'export'), 'assets.json'));
  } catch {
    // no export yet: every name counts as a miss
  }
  return { ...scored, ...scoreNames(meta, perObject, catalog) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--export');
  const exportDir = flag >= 0 ? args[flag + 1] : null;
  console.log(JSON.stringify(score(args[0], args[1], exportDir), null, 1));
}
module.exports = { score, scoreLabels, loadTruth, failedResult, countAssets };
