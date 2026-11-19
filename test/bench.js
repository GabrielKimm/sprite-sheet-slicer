'use strict';
// Script-only benchmark: run `detect` on every generated case and score it
// against the ground truth, next to two free baselines.
//   node test/bench.js <cases-dir> <work-dir> [--mode hint|auto|nosplit|gridcell] [--only substring] [--json out.json]
// hint     the tile size from the pack description is passed, as the skill instructs
// auto     no tile size is passed, the slicer has to infer it
// nosplit  baseline: plain connected components (what a ten-line script or an editor's auto-slice does)
// gridcell baseline: every occupied tile cell is one sprite (what a grid import does); needs a tile size
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const LIB =
  process.env.SLICER_LIB || path.join(__dirname, '..', 'skills', 'sprite-sheet-slicer', 'scripts');
const { score, scoreLabels, loadTruth, failedResult, countAssets } = require('./score');

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : fallback;
const [casesDir, workDir] = args;
const mode = option('mode', 'hint');
const only = option('only', '');

// Label each non-empty tile cell as its own object.
function gridCellLabels({ meta, gt, alpha }) {
  const width = meta.nativeSize[0];
  const tile = meta.tile;
  const cellsPerRow = Math.ceil(width / tile);
  const labels = new Int32Array(gt.length);
  for (let i = 0; i < gt.length; i++) {
    if (!alpha[i]) continue;
    const row = Math.floor(i / width / tile);
    const col = Math.floor((i % width) / tile);
    labels[i] = 1 + row * cellsPerRow + col;
  }
  return labels;
}

function detectArgs(sheetFile, work, meta) {
  const cmd = [path.join(LIB, 'sheet.js'), 'detect', sheetFile, '--work', work];
  if ((mode === 'hint' || mode === 'nosplit') && meta.tile) cmd.push('--tile', String(meta.tile));
  if (mode === 'hint' && !meta.tile) cmd.push('--tile', 'none');
  if (mode === 'nosplit') cmd.push('--no-split');
  return cmd;
}

function runCase(name, caseDir, meta) {
  if (mode === 'gridcell') {
    if (!meta.tile) {
      return { name, family: meta.family, gtAssets: countAssets(meta), skipped: 'no tile size' };
    }
    const truth = loadTruth(caseDir);
    return scoreLabels(truth, gridCellLabels(truth)).result;
  }
  const work = path.join(workDir, mode, name);
  fs.rmSync(work, { recursive: true, force: true });
  try {
    execFileSync(process.execPath, detectArgs(path.join(caseDir, 'sheet.png'), work, meta), {
      stdio: 'pipe',
    });
  } catch (e) {
    return failedResult(meta, (e.stderr || e.message).toString().trim().split('\n').pop());
  }
  return score(caseDir, work);
}

const rows = [];
for (const name of fs.readdirSync(casesDir).sort()) {
  if (only && !name.includes(only)) continue;
  const caseDir = path.join(casesDir, name);
  if (!fs.existsSync(path.join(caseDir, 'gt.json'))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(caseDir, 'gt.json'), 'utf8'));
  const start = process.hrtime.bigint();
  const row = runCase(name, caseDir, meta);
  row.ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
  rows.push(row);
}

const pct = (v) => (Number.isFinite(v) ? (100 * v).toFixed(1) : '  -  ').padStart(5) + '%';
const cell = (v, width) => String(v ?? '-').padStart(width);
const ratio = (exact, n) => `${String(exact).padStart(5)}/${String(n).padEnd(5)}`;

console.log(`mode=${mode}`);
console.log(
  'case              assets pred  exact  merged split mixed  exact%  precision  ms   note',
);
for (const s of rows) {
  const note =
    s.error || s.skipped || (s.fgLost || s.bgAsFg ? `fgLost=${s.fgLost} bgAsFg=${s.bgAsFg}` : '');
  console.log(
    `${s.name.padEnd(17)} ${cell(s.gtAssets, 6)} ${cell(s.predAssets, 4)} ${cell(s.exact, 6)} ${cell(s.merged, 6)} ${cell(s.split, 5)} ${cell(s.mixed, 5)}  ${pct(s.exactRate)}   ${pct(s.precision)}  ${cell(s.ms, 5)}  ${note}`,
  );
}

const families = new Map();
for (const s of rows.filter((r) => !r.skipped)) {
  const f = families.get(s.family) || {
    sheets: 0,
    assets: 0,
    exact: 0,
    predicted: 0,
    singleN: 0,
    singleExact: 0,
    multiN: 0,
    multiExact: 0,
  };
  f.sheets++;
  f.assets += s.gtAssets;
  f.exact += s.exact || 0;
  f.predicted += s.predAssets || 0;
  if (s.single) {
    f.singleN += s.single.n;
    f.singleExact += s.single.exact;
    f.multiN += s.multi.n;
    f.multiExact += s.multi.exact;
  }
  families.set(s.family, f);
}

console.log(
  '\nfamily      sheets assets  exact%  precision  single-piece assets   multi-piece assets',
);
const pooled = {
  sheets: 0,
  assets: 0,
  exact: 0,
  singleN: 0,
  singleExact: 0,
  multiN: 0,
  multiExact: 0,
};
const familyRates = [];
for (const [name, f] of families) {
  console.log(
    `${name.padEnd(11)} ${cell(f.sheets, 6)} ${cell(f.assets, 6)}  ${pct(f.exact / Math.max(1, f.assets))}    ${pct(f.exact / Math.max(1, f.predicted))}   ${ratio(f.singleExact, f.singleN)} ${pct(f.singleExact / Math.max(1, f.singleN))}   ${ratio(f.multiExact, f.multiN)} ${f.multiN ? pct(f.multiExact / f.multiN) : ''}`,
  );
  for (const key of Object.keys(pooled)) pooled[key] += f[key];
  familyRates.push(f.exact / Math.max(1, f.assets));
}
console.log(
  `${'POOLED'.padEnd(11)} ${cell(pooled.sheets, 6)} ${cell(pooled.assets, 6)}  ${pct(pooled.exact / Math.max(1, pooled.assets))}               ${ratio(pooled.singleExact, pooled.singleN)} ${pct(pooled.singleExact / Math.max(1, pooled.singleN))}   ${ratio(pooled.multiExact, pooled.multiN)} ${pooled.multiN ? pct(pooled.multiExact / pooled.multiN) : ''}`,
);
const macroMean = familyRates.reduce((a, b) => a + b, 0) / Math.max(1, familyRates.length);
console.log(
  `MACRO MEAN over ${familyRates.length} families: ${pct(macroMean)}   (each family counts once, so one huge sheet cannot dominate)`,
);

const jsonFile = option('json', null);
if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify({ mode, macroMean, rows }, null, 1));
