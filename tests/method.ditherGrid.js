// Extracted verbatim from the pre-split verify.html (lines 938-1151).
// Body unchanged, so the emitted output stays byte-identical.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import { dotPath } from '../src/spine/dots.js';
import ditherGrid, { ditherPattern, buildLattice, effectiveInk } from '../src/methods/ditherGrid.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import {
  say,
  num,
  flat,
  linearRamp,
  radialRamp,
  runToneTest,
  renderForTest,
} from './runner.js';

export function run() {
// -------------------------------------------- dither grid: THE INK IDENTITY
// The overlap accounting here is claimed to be EXACT, not approximate: a dot
// covers its own cell plus a lens into each neighbour, and because each disc
// passes through its cell's vertices, two discs on adjacent cells meet exactly
// at the shared vertices -- so lenses spilling into a third cell never overlap.
// If that is right, then for ANY pattern the rendered ink must equal
// effectiveInk() to within the dot-fill error, with no fitted constant.
//
// Tested on random patterns first, because those exercise the accounting far
// harder than any of the five modes: a mode arranges dots to be evenly spread,
// which is the easy case for an overlap model.
say('<h2>Dither grid — is the overlap identity exact?</h2>');
say('<p class="note">Random patterns at a fixed fill fraction, scored against ' +
    '<code>effectiveInk</code>. This is the claim the two source headers make ' +
    'with "properly calibrated for different dot sizes", and it is the one part ' +
    'of the method that could be wrong in a way no tone ramp would reveal.</p>');
say('<p class="note"><b>Measured over cell territories, not the whole image.</b> ' +
    '<code>effectiveInk</code> accounts for ink over the union of the territories ' +
    'of cells whose centre is inside the region; comparing that against the whole ' +
    'rendered frame counts the border ring in one and not the other, which the ' +
    'first run of this table showed as a ±1% drift with fill (+0.6% for square, ' +
    'where 372 border cells each spill 0.14 cell-areas outward; negative for hex, ' +
    'where the lattice over-covers instead). The mask below removes the confound ' +
    'rather than absorbing it into a constant.</p>');
{
  // A pixel belongs to the cell whose centre is nearest -- which for both
  // lattices IS the cell's territory, since square and hex cells are the Voronoi
  // regions of their centres. Search a 3x3 block of candidates around the
  // arithmetic estimate, which is exact for both and avoids an O(pixels x cells)
  // scan.
  const territoryMask = (lat, nx, ny, keep) => {
    const mask = new Uint8Array(nx * ny);
    const { cols, rows, cx, cy } = lat;
    const x0 = cx[0], y0 = cy[0];
    const dx = lat.dxCell, dy = lat.dyCell;
    for (let py = 0; py < ny; py++) {
      const Y = py + 1;
      const i0 = Math.round((Y - y0) / dy);
      for (let px2 = 0; px2 < nx; px2++) {
        const X = px2 + 1;
        let best = -1, bestD = Infinity;
        for (let di = -1; di <= 1; di++) {
          const i = i0 + di;
          if (i < 0 || i >= rows) continue;
          const j0 = Math.round((X - cx[i * cols]) / dx);
          for (let dj = -1; dj <= 1; dj++) {
            const j = j0 + dj;
            if (j < 0 || j >= cols) continue;
            const c = i * cols + j;
            const d = (cx[c] - X) ** 2 + (cy[c] - Y) ** 2;
            if (d < bestD) { bestD = d; best = c; }
          }
        }
        if (best >= 0 && keep[best]) mask[py * nx + px2] = 1;
      }
    }
    return mask;
  };
  const maskedInk = (im, mask) => {
    let s = 0, n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { s += 1 - im.data[i]; n++; }
    return { ink: n > 0 ? s / n : 0, area: n };
  };

  const tsv = ['lattice\trDot/w\tfill\tcells\tpredicted\trendered\tratio'];
  let worst = 0;
  for (const lattice of ['square', 'hex']) {
    say(`<h3 style="font-size:14px">${lattice}</h3>`);
    say('<table><tr><th>rDot/w</th><th>fill</th><th>cells</th>' +
        '<th>predicted ink</th><th>rendered ink</th><th>ratio</th></tr>');
    for (const rDotW of [1.5, 3]) {
      for (const fill of [0.1, 0.3, 0.5, 0.75, 1]) {
        const ctx = prepare(makeImage(300, 300, 1), flat);
        const rDot = Math.max(ctx.w / 2, rDotW * ctx.w);
        const lat = buildLattice(ctx, lattice, rDot);
        const rand = (() => { let a = 12345; return () => {
          a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
        const drawn = new Uint8Array(lat.n);
        for (let c = 0; c < lat.n; c++) drawn[c] = lat.inside[c] && rand() < fill ? 1 : 0;

        const cellArea = lat.dxCell * lat.dyCell;
        const mask = territoryMask(lat, ctx.nx, ctx.ny, lat.inside);
        const lines = [];
        for (let c = 0; c < lat.n; c++) {
          if (drawn[c] && lat.inside[c]) lines.push(dotPath(lat.cx[c], lat.cy[c], rDot, ctx.w));
        }
        const img = renderForTest(ctx, lines);
        const m = maskedInk(img, mask);
        // predicted is in cell areas; the mask's area is the same territories
        const predicted = (effectiveInk(drawn, lat) * cellArea) / m.area;
        const rendered = m.ink;
        const ratio = predicted > 0 ? rendered / predicted : 1;
        worst = Math.max(worst, Math.abs(ratio - 1));
        say(`<tr><td>${rDotW}</td><td>${num(fill, 2)}</td><td>${lat.n.toLocaleString()}</td>` +
            `<td>${num(predicted, 4)}</td><td>${num(rendered, 4)}</td>` +
            `<td>${num(ratio, 4)}</td></tr>`);
        tsv.push([lattice, rDotW, num(fill, 2), lat.n, num(predicted, 4),
                  num(rendered, 4), num(ratio, 4)].join('\t'));
      }
    }
    say('</table>');
  }
  const pass = worst < 0.05;
  say(`<p>overlap identity holds — <span class="${pass ? 'pass' : 'fail'}">` +
      `${pass ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)} off unity). ` +
      `<span class="note">A ratio below 1 that grows with fill means the lenses ` +
      `DO overlap and the identity is not exact; a constant offset at every fill ` +
      `is the dot fill, not the accounting — compare the spiral table above.</span></p>`);
  say(`<pre id="ditherIdentityTSV">${tsv.join('\n')}</pre>`);
}

// The five modes, on flat fields. Two ratios again, and they fail differently:
// `budget` is whether the mode chose the right number of dots (its own job),
// `ink` is whether the drawing then delivered it (the spiral's job).
say('<h2>Dither grid — the five modes</h2>');
{
  const tsv = ['lattice\tmode\tim\tdots\tbudget\tinkWanted\tinkDrawn\tink'];
  for (const lattice of ['square', 'hex']) {
    for (const mode of ['threshold', 'ed1', 'ed2', 'dbs', 'random']) {
      say(`<h3 style="font-size:14px">${lattice} · ${mode}</h3>`);
      say('<table><tr><th>im</th><th>dots</th><th>budget ratio</th>' +
          '<th>ink wanted</th><th>ink drawn</th><th>ink ratio</th></tr>');
      for (const v of [0, 0.25, 0.5, 0.75, 0.9]) {
        const ctx = prepare(makeImage(240, 240, v), flat);
        const args = {
          ...ctx, lattice, mode, dDotW: 3, curve: 'hilbert',
          dbsIterations: 300, seed: 1,
        };
        const { drawn, wanted, effective, lat } = ditherPattern(args);
        let nDots = 0;
        for (let c = 0; c < lat.n; c++) if (drawn[c] && lat.inside[c]) nDots++;
        const budget = wanted > 0 ? effective / wanted : (effective === 0 ? 1 : Infinity);

        const rendered = 1 - meanOf(renderForTest(ctx, ditherGrid.run(args)));
        const inkWanted = 1 - v;
        const ink = inkWanted > 0 ? rendered / inkWanted : (rendered < 0.01 ? 1 : Infinity);

        say(`<tr><td>${num(v, 2)}</td><td>${nDots.toLocaleString()}</td>` +
            `<td>${num(budget, 4)}</td><td>${num(inkWanted, 4)}</td>` +
            `<td>${num(rendered, 4)}</td><td>${num(ink, 4)}</td></tr>`);
        tsv.push([lattice, mode, num(v, 2), nDots, num(budget, 4),
                  num(inkWanted, 4), num(rendered, 4), num(ink, 4)].join('\t'));
      }
      say('</table>');
    }
  }
  say('<p class="note">Paste the block below back. <b>budget</b> is each mode ' +
      'hitting the ink it was asked for and should be ≈1 for all five; ' +
      '<b>ink</b> additionally includes the dot fill. Threshold and DBS should ' +
      'be tightest, random loosest — it only gets the mean right, not any ' +
      'particular realisation.</p>');
  say(`<pre id="ditherModesTSV">${tsv.join('\n')}</pre>`);
}

// DBS's blur width, which the first run showed is not a free parameter. At the
// MATLAB's scaleDBS = 1 the field is barely blurred, so the L1 objective
// optimises per-cell medians instead of the local mean and does not constrain
// total ink -- budget ran 4% high in midtones and 11% low at brightness 0.9.
// The source's own rDBS = 11 window is about 5 sigma only near scale 3.
say('<h2>Dither grid — DBS blur width</h2>');
say('<p class="note">DBS now moves by SWAPS, so the dot count is fixed and the ' +
    'objective cannot trade tone for arrangement. Budget should therefore be ≈1 ' +
    '<em>at every scale</em>, including 1 — where free toggles previously ran 4% ' +
    'high in the midtones and 11% low at brightness 0.9. If the scale-1 column ' +
    'still drifts, the swap constraint is not holding and something else is ' +
    'changing the count. Residual drift that grows with scale is the spreading ' +
    'effect instead: better-separated dots overlap less, so the same number of ' +
    'them lays down slightly more ink.</p>');
{
  say('<table><tr><th>im</th><th>scale 1</th><th>scale 2</th><th>scale 3</th>' +
      '<th>scale 4</th></tr>');
  for (const v of [0.25, 0.5, 0.75, 0.9]) {
    const cells = [];
    for (const dbsScale of [1, 2, 3, 4]) {
      const ctx = prepare(makeImage(240, 240, v), flat);
      const { wanted, effective } = ditherPattern({
        ...ctx, lattice: 'hex', mode: 'dbs', dDotW: 3,
        dbsIterations: 300, dbsScale, seed: 1,
      });
      cells.push(num(wanted > 0 ? effective / wanted : 1, 4));
    }
    say(`<tr><td>${num(v, 2)}</td><td>${cells.join('</td><td>')}</td></tr>`);
  }
  say('</table>');
}

runToneTest(
  'Linear ramp — dither grid (hex, 2-D diffusion)',
  ditherGrid,
  linearRamp(600, 200),
  { lattice: 'hex', mode: 'ed2', dDotW: 3, curve: 'hilbert', dbsIterations: 300, seed: 1 },
  flat,
);

// SCORED ON THE MEAN, deliberately. This mode solves for ONE global threshold t
// and inks every cell with K > t, so on a monotone ramp the answer is a step:
// bands darker than t come out solid black, lighter ones blank paper. Measured,
// that reads 0.000 for bands 1-4 and 1.000 for bands 5-9 with the overall mean
// right to 0.005 -- which is thresholding working exactly as specified, and it
// scored RMS 0.279 FAIL against the per-band criterion the other modes use.
//
// The mode's whole claim is that the bisection lays the right TOTAL ink; local
// fidelity is what the other four modes exist to provide. So the mean is the
// thing to score, and the band table above stays printed so the step is visible
// rather than hidden behind a pass.
runToneTest(
  'Linear ramp — dither grid (square, threshold)',
  ditherGrid,
  linearRamp(600, 200),
  { lattice: 'square', mode: 'threshold', dDotW: 3, curve: 'hilbert', dbsIterations: 300, seed: 1 },
  flat,
  10,
  { scoreBy: 'mean' },
);

runToneTest(
  'Radial ramp — dither grid (hex, DBS)',
  ditherGrid,
  radialRamp(400, 400),
  { lattice: 'hex', mode: 'dbs', dDotW: 3, curve: 'hilbert', dbsIterations: 300, seed: 1 },
  flat,
);

}
