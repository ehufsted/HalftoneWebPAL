// Extracted verbatim from the pre-split verify.html (lines 643-827).
// Body unchanged, so the emitted output stays byte-identical.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare, toPhysical } from '../src/spine/units.js';
import { optimizeOrder } from '../src/spine/pathOptimizer.js';
import { travelLength } from '../src/spine/geometry.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import circlePacking, {
  packCircles,
  PACKING_FRACTION,
  TANGENCIES_PER_CIRCLE,
} from '../src/methods/circlePacking.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

export function run() {
// ------------------------------------------- circle packing: PACKING FRACTION
// THE MEASUREMENT. Coverage of an outline of radius r is 2*phi*w/r, where phi
// is the packing's area fraction -- the one quantity in this method with no
// closed form. fixCirclePackingScan.m computes it at line 199 and never uses
// it. Everything here turns on whether phi is (a) large and (b) CONSTANT as the
// radius changes: if it drifts with r, then 1/R linear in brightness does not
// give linear tone and the ladder needs reshaping.
//
// Flat fields, so the packing is uniform and phi is unambiguous.
say('<h2>Circle packing — packing fraction φ</h2>');
say('<p class="note">φ = Σπr²/area, measured on flat grey fields. ' +
    'The tone claim is coverage = 2φw/r, so the columns to watch are whether φ ' +
    'holds steady down the table and whether measured brightness tracks the ' +
    'prediction built from the <em>measured</em> φ. ' +
    `The method currently ships φ = ${num(PACKING_FRACTION, 3)} as a placeholder.</p>`);
{
  const flatField = (v, w = 300, h = 300) => {
    const im = makeImage(w, h);
    im.data.fill(v);
    return im;
  };

  // Tangencies per circle -- the k in the coverage law's overlap term. The scan
  // places each circle tangent to exactly one existing constraint, so this
  // should sit a little above 1; circles tangent only to the page edge are NOT
  // counted, because there is no second stroke there to overlap with.
  const countTangencies = (cx, cy, cr, n, tol) => {
    let pairs = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dy = cy[j] - cy[i];
        if (Math.abs(dy) > cr[i] + cr[j] + tol) continue;
        const gap = Math.hypot(cx[j] - cx[i], dy) - cr[i] - cr[j];
        if (Math.abs(gap) < tol) pairs++;
      }
    }
    return n > 0 ? pairs / n : 0;
  };

  const tsv = ['rMin/w\trMax/w\tim\tR/w\tcircles\tphi\tk\tpred(measphi,k)\tmeasured\terror'];
  let phiMin = 1, phiMax = 0;
  let kMin = 99, kMax = 0;

  for (const [rMinW, rMaxW] of [[3, 12], [2, 6], [4, 24]]) {
    say(`<h3 style="font-size:14px">rMin = ${rMinW}w, rMax = ${rMaxW}w</h3>`);
    say('<table><tr><th>im</th><th>R/w</th><th>circles</th><th>φ</th><th>k</th>' +
        '<th>predicted</th><th>measured</th><th>error</th></tr>');
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const ctx = prepare(flatField(v), flat);
      const args = { ...ctx, rMinW, rMaxW };
      const { cx, cy, cr, n } = packCircles(args);

      let area = 0;
      for (let i = 0; i < n; i++) area += Math.PI * cr[i] * cr[i];
      const phi = area / (ctx.nx * ctx.ny);
      phiMin = Math.min(phiMin, phi); phiMax = Math.max(phiMax, phi);

      const lines = circlePacking.run(args);
      const rendered = renderForTest(ctx, lines);
      // mean radius actually used, and the coverage that predicts
      let rBar = 0;
      for (let i = 0; i < n; i++) rBar += cr[i];
      rBar = n > 0 ? rBar / n : 0;
      const k = countTangencies(cx, cy, cr, n, ctx.w * 0.05);
      if (n > 100) { kMin = Math.min(kMin, k); kMax = Math.max(kMax, k); }
      // predicted from the MEASURED phi and the MEASURED k, so this tests the
      // shape of the coverage law rather than the two constants shipped
      const keep = 1 - ((2 * k) / (3 * Math.PI)) * Math.sqrt(ctx.w / rBar);
      const predicted = n > 0
        ? Math.max(0, 1 - Math.min(1, ((2 * phi * ctx.w) / rBar) * Math.max(0, keep)))
        : 1;
      const measured = meanOf(rendered);
      const e = measured - predicted;

      say(`<tr><td>${num(v, 2)}</td><td>${num(rBar / ctx.w, 2)}</td>` +
          `<td>${n.toLocaleString()}</td><td>${num(phi, 4)}</td><td>${num(k, 3)}</td>` +
          `<td>${num(predicted, 4)}</td><td>${num(measured, 4)}</td>` +
          `<td>${e >= 0 ? '+' : ''}${num(e, 4)}</td></tr>`);
      tsv.push([rMinW, rMaxW, num(v, 2), num(rBar / ctx.w, 2), n,
                num(phi, 4), num(k, 3), num(predicted, 4), num(measured, 4),
                num(e, 4)].join('\t'));
    }
    say('</table>');
  }

  const steady = phiMax - phiMin < 0.05;
  say(`<p>φ ranges ${num(phiMin, 4)}–${num(phiMax, 4)} — ` +
      `<span class="${steady ? 'pass' : 'fail'}">${steady ? 'STEADY' : 'DRIFTS'}</span>` +
      `<span class="note"> (steady is what makes 1/R linear in brightness the ` +
      `right ladder; a drift with radius means the ladder needs reshaping, not ` +
      `just a different constant)</span></p>`);
  say(`<p>tangencies per circle counted at ${num(kMin, 3)}–${num(kMax, 3)}, ` +
      `shipped as ${num(TANGENCIES_PER_CIRCLE, 3)} — ` +
      `<span class="${Math.abs((kMin + kMax) / 2 - TANGENCIES_PER_CIRCLE) < 0.15 ? 'pass' : 'fail'}">` +
      `${Math.abs((kMin + kMax) / 2 - TANGENCIES_PER_CIRCLE) < 0.15 ? 'AGREES' : 'DISAGREES'}</span>` +
      `<span class="note"> (k is an observable, not a fit parameter — the scan ` +
      `places each circle tangent to exactly one constraint, so a value just ` +
      `over 1 is what the algorithm implies. If this disagrees, put the counted ` +
      `value in <code>TANGENCIES_PER_CIRCLE</code>; if it lands nowhere near 1, ` +
      `the overlap derivation is wrong, not the constant.)</span></p>`);
  say('<p class="note">Paste the block below back. φ and k are both measured ' +
      'here and fed into the prediction, so the error column tests the SHAPE of ' +
      'the coverage law — 2φw/r·(1−2k/3π·√(w/r)) — independently of the two ' +
      'constants the method ships.</p>');
  say(`<pre id="packingTSV">${tsv.join('\n')}</pre>`);
}

// The tone ramp. Scored against targetImage, which is the source mapped into
// [1-2φw/rMin, 1-2φw/rMax] -- and since 1/R is linear in brightness that band
// IS the achieved tone, so this checks the whole chain at once.
runToneTest(
  'Linear ramp — circle packing',
  circlePacking,
  linearRamp(600, 200),
  { rMinW: 3, rMaxW: 12 },
  flat,
);

runToneTest(
  'Radial ramp — circle packing',
  circlePacking,
  radialRamp(400, 400),
  { rMinW: 3, rMaxW: 12 },
  flat,
);

// Overlap check: the port replaced the MATLAB's `unique(subI)` tracking with an
// exact retirement test, because a circle dropped too early stops blocking and
// a later one can be placed on top of it. Nothing here should overlap at all.
say('<h2>Circle packing — overlaps and travel</h2>');
{
  const ctx = prepare(radialRamp(400, 400), flat);
  const args = { ...ctx, rMinW: 3, rMaxW: 12 };
  const { cx, cy, cr, n } = packCircles(args);

  // TOLERANCE IS DERIVED, and the first version of this test did not have one.
  // The scan keeps the row's distance-to-nearest-surface per INTEGER COLUMN and
  // places a circle where that reaches R, so tangency is exact only at the
  // sampled column. Half a column of offset on two circles of radius r near
  // tangency buries them by about (1/2)^2/(2r) = 1/(8r). So penetration up to
  // 1/(8*rMin) px is the sampling grid, not the placement rule; beyond that a
  // circle really was dropped too early and got built over.
  //
  // At -1e-6 this read 306 "overlapping" pairs whose worst penetration was
  // -0.011 px -- i.e. tangent to a hundredth of a pixel -- and reported FAIL on
  // a correct packing. A test that fires on exact tangency cannot see the bug it
  // exists for.
  let rMin = Infinity;
  for (let i = 0; i < n; i++) if (cr[i] < rMin) rMin = cr[i];
  const tol = 1 / (8 * rMin);

  // brute force, but only against circles within reach in y
  let worst = 0, overlaps = 0, grazes = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(cy[j] - cy[i]) > cr[i] + cr[j]) continue;
      const gap = Math.hypot(cx[j] - cx[i], cy[j] - cy[i]) - cr[i] - cr[j];
      if (gap >= -1e-6) continue;
      worst = Math.min(worst, gap);
      if (gap < -tol) overlaps++; else grazes++;
    }
  }
  const clean = overlaps === 0;

  // The MATLAB's own travel heuristic (lines 218-229): band the centres by a
  // reference radius and serpentine. Kept as a baseline for the app's optimiser,
  // which is a free comparison the source already set up.
  const rRef = Math.sqrt((ctx.nx * ctx.ny) / (n * Math.PI)) * 2;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ka = Math.round(cy[a] / rRef), kb = Math.round(cy[b] / rRef);
    const sa = ka * ctx.nx + (ka % 2 === 0 ? cx[a] : ctx.nx - cx[a]);
    const sb = kb * ctx.nx + (kb % 2 === 0 ? cx[b] : ctx.nx - cx[b]);
    return sa - sb;
  });
  const travelOf = (idx) => {
    let s = 0;
    for (let i = 1; i < idx.length; i++) {
      s += Math.hypot(cx[idx[i]] - cx[idx[i - 1]], cy[idx[i]] - cy[idx[i - 1]]);
    }
    return s;
  };
  const raw = travelOf(Array.from({ length: n }, (_, i) => i));
  const banded = travelOf(order);

  const cm = toPhysical(circlePacking.run(args), ctx.pxPerCm);
  const appTravel = travelLength(optimizeOrder(cm)) * ctx.pxPerCm;

  say('<table>' +
    `<tr><th>circles</th><td>${n.toLocaleString()}</td></tr>` +
    `<tr><th>overlapping pairs (deeper than ${num(tol, 4)} px)</th>` +
      `<td class="${clean ? 'pass' : 'fail'}">${overlaps}</td></tr>` +
    `<tr><th>tangent pairs within tolerance</th><td>${grazes}</td></tr>` +
    `<tr><th>worst penetration</th><td>${num(worst, 4)} px</td></tr>` +
    `<tr><th>column-sampling bound 1/(8·rMin)</th><td>${num(tol, 4)} px</td></tr>` +
    `<tr><th>travel, placement order</th><td>${num(raw / 100, 1)} (px×100)</td></tr>` +
    `<tr><th>travel, MATLAB band sort</th><td>${num(banded / 100, 1)}</td></tr>` +
    `<tr><th>travel, app optimiser</th><td>${num(appTravel / 100, 1)}</td></tr>` +
    '</table>');
  say(`<p>packing is non-overlapping — ` +
      `<span class="${clean ? 'pass' : 'fail'}">${clean ? 'PASS' : 'FAIL'}</span>` +
      `<span class="note"> (a failure here means the retirement test is wrong, ` +
      `not the placement rule. Pairs within ${num(tol, 4)} px are counted as ` +
      `tangent, not overlapping: that is the column-sampling bound 1/(8·rMin), ` +
      `and circles are placed tangent by construction. Watch the worst-penetration ` +
      `row — if it grows past the bound, a circle is being retired too early.)` +
      `</span></p>`);
}

}
