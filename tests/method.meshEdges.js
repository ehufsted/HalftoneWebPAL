// New with the Voronoi/Delaunay web port; not sliced from the pre-split harness.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength, trimLineSegsToPolygon } from '../src/spine/geometry.js';
import { stipplePoints, perimeterPoints } from '../src/spine/points.js';
import { voronoiCells, regionEdges } from '../src/spine/regions.js';
import { triangulate } from '../src/spine/delaunay.js';
import meshEdges, { MESH_TONE, LATTICE_KAPPA } from '../src/methods/meshEdges.js';
import {
  say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest,
} from './runner.js';

// HALF THE DRAWING WIDTH, for the sweeps only. Point count goes as 1/d^2 and
// triangulate is O(n^2) in it, so a 300px canvas at the spacing floor costs
// minutes across a twelve-row sweep. At 150px the same geometry is measured on a
// quarter of the pixels and the constants under test are scale-free, so nothing
// is lost. The ramps below still run at full size.
const small = { ...flat, drawingWidth: 5 };

/** Both networks over ONE relaxed point set, so the two are directly comparable. */
function bothNetworks(ctx, nPts, seed) {
  const area = (ctx.nx - 1) * (ctx.ny - 1);
  const flatField = new Float64Array(ctx.nx * ctx.ny).fill(1);
  const ring = perimeterPoints(ctx, flatField, nPts);
  const { sx, sy } = stipplePoints(ctx, {
    field: flatField, count: nPts, seeds0: ring, seed, iterations: 6, polish: 12,
  });
  // The ACHIEVED count, not the requested one: a leaf emits a point when its
  // mass rounds to one, so the total lands near the request rather than on it.
  // Every density and spacing below is derived from this, so using the request
  // would put a few percent of error into the constants under test.
  const nAll = sx.length;

  const vCells = voronoiCells(ctx, sx, sy, nAll).filter(Boolean);
  // skipBoundary, for the same reason meshEdges skips it: the page edge is where
  // the cells were CLIPPED, not a Voronoi edge. Counting it added a constant 596
  // px here and was most of why this ratio first read 1.56 instead of 1.73.
  const vEdges = regionEdges(vCells, { skipBoundary: ctx.polygon });

  const tri = triangulate(sx, sy);
  const { tris, n: nT } = tri;
  const seen = new Set();
  const dEdges = [];
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      const u = tris[3 * t + k], v = tris[3 * t + ((k + 1) % 3)];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dEdges.push([[sx[u], sy[u]], [sx[v], sy[v]]]);
    }
  }
  return { sx, sy, nAll, vEdges, dEdges, area, tri };
}

export function run() {

// ------------------------------------------------------- the sqrt3 invariant
// THE SHARPEST CHECK AVAILABLE HERE, and the reason to run it first: on a
// hexagonal arrangement each Delaunay edge is perpendicular to its dual Voronoi
// edge and longer by sqrt3, and the two networks have the same number of edges.
// So their total lengths are in the ratio sqrt3 = 1.7321 -- independent of the
// pen width, of the spacing, and of BOTH tone constants. Nothing to fit, and a
// relaxed point set is near-hexagonal enough that it should hold closely.
//
// If this ratio is right and the individual constants are wrong, the error is in
// the length-to-coverage step (overlap). If the ratio itself is wrong, the
// hexagonal assumption is wrong and both constants need rederiving, not
// refitting.
say('<h2>Mesh — is the Delaunay exactly √3 longer than the Voronoi?</h2>');
say('<p class="note">Both networks measured over the SAME relaxed point set, on ' +
    'a flat field so the arrangement is as hexagonal as Lloyd can make it. The ' +
    'ratio is a pure geometric identity with no constant in it, so it separates ' +
    '“the length model is wrong” from “the overlap correction is wrong”.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  say('<table><tr><th>interior points</th><th>Voronoi length</th>' +
      '<th>Delaunay length</th><th>ratio</th><th>√3</th><th>error</th></tr>');
  const errs = [];
  for (const nPts of [150, 400, 800, 1200]) {
    const { vEdges, dEdges } = bothNetworks(ctx, nPts, 1);
    const vL = pathLength(vEdges), dL = pathLength(dEdges);
    const ratio = dL / vL;
    const err = ratio / Math.sqrt(3) - 1;
    errs.push(Math.abs(err));
    say(`<tr><td>${nPts}</td><td>${num(vL, 1)}</td><td>${num(dL, 1)}</td>` +
        `<td>${num(ratio, 4)}</td><td>1.7321</td>` +
        `<td>${err >= 0 ? '+' : ''}${num(err, 4)}</td></tr>`);
  }
  say('</table>');
  // SCORED ON THE LARGEST ROW AND ON THE TREND, not on the worst row. The
  // identity is asymptotic in the point count and the pinned ring is a fixed
  // cost, so the sparsest row is expected to be the furthest out -- taking the
  // worst of the four would be scoring the row with the least data in it. What
  // must hold is that the densest row is close AND that the error is shrinking,
  // which together are much harder to satisfy by accident than either alone.
  const last = errs[errs.length - 1];
  const shrinking = errs[0] > errs[errs.length - 1];
  const ok = last < 0.03 && shrinking;
  say(`<p>ratio is √3 — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (densest row ${num(last, 4)}, ` +
      `${shrinking ? 'shrinking' : 'NOT shrinking'} with point count). ` +
      `<span class="note">A ratio that is flat and wrong means the dual ` +
      `relationship is broken — check that the Voronoi cells and the ` +
      `triangulation are built from the same seeds, and that both are skipping ` +
      `the page border, before suspecting the geometry. Counting the border was ` +
      `what first dragged this to 1.56.</span></p>`);
}

// --------------------------------------------------- length per unit area
// The two derived constants, checked one level below coverage so that stroke
// overlap cannot contaminate them. Length per unit area should be C/d exactly,
// with C = 2 and 2*sqrt3 and NO overlap term -- overlap affects how much of the
// page a given length of wire covers, not how much wire there is.
say('<h2>Mesh — length per unit area against C/d</h2>');
say('<p class="note">Measured on the drawn polylines, before any rendering, so ' +
    'this isolates the geometry from the ink. C is derived: 2 for Voronoi and ' +
    '2√3 = 3.4641 for Delaunay. The effective C column is <i>measured length × ' +
    'mean spacing</i>, which is what to paste back if the constants need ' +
    'changing.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const tsv = ['nPts\tspacing\tmode\tpredLen\tmeasLen\tratio\teffC\thealth'];
  say('<table><tr><th>points</th><th>mean spacing d</th><th>mode</th>' +
      '<th>predicted C/d</th><th>measured</th><th>ratio</th>' +
      '<th>effective C</th><th>dropped / repaired / malformed</th></tr>');
  let worst = 0;
  let anyMalformed = false;
  for (const nPts of [200, 600, 1200]) {
    const { vEdges, dEdges, area, nAll, tri } = bothNetworks(ctx, nPts, 1);
    // hexagonal spacing implied by the achieved point density
    const d = Math.sqrt(1.1547 / (nAll / area));
    for (const [mode, edges] of [['voronoi', vEdges], ['delaunay', dEdges]]) {
      const C = MESH_TONE[mode].C;
      const pred = C / d;
      const meas = pathLength(edges) / area;
      const ratio = meas / pred;
      worst = Math.max(worst, Math.abs(ratio - 1));
      // The triangulator's health counters, on the Delaunay row only. This is
      // where a broken cavity shows first and most loudly: a disconnected bad
      // set stitches overlapping triangles, roughly doubling the distinct edge
      // count while the Voronoi built from the SAME seeds stays correct. That is
      // exactly what happened at one point count out of three -- effective C
      // read 7.21 against 3.57 -- so the counters live next to the number they
      // explain rather than in a section of their own.
      if (tri.malformed > 0) anyMalformed = true;
      const health = mode === 'delaunay'
        ? ` /  / `
        : '—';
      say(`<tr><td>${nAll}</td><td>${num(d, 2)}</td><td>${mode}</td>` +
          `<td>${num(pred, 5)}</td><td>${num(meas, 5)}</td>` +
          `<td>${num(ratio, 4)}</td><td>${num(meas * d, 4)}</td>` +
          `<td class="${tri.malformed === 0 ? 'pass' : 'fail'}">${health}</td></tr>`);
      tsv.push([nAll, num(d, 2), mode, num(pred, 5), num(meas, 5),
                num(ratio, 4), num(meas * d, 4), health].join('\t'));
    }
  }
  say('</table>');
  // A malformed cavity invalidates the row entirely, so it fails the section
  // regardless of how the ratio happens to land.
  const ok = worst < 0.08 && !anyMalformed;
  say(`<p>length follows C/d — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)}). ` +
      `<span class="note">A constant offset in BOTH modes is the hexagonal ` +
      `idealisation — a relaxed set is not a perfect lattice — and is now shipped ` +
      `as LATTICE_KAPPA = ${LATTICE_KAPPA}, measured at +3 to +4%. So these ` +
      `ratios SHOULD read about 1.04 against the bare derived C, and a ratio near ` +
      `1.00 would mean KAPPA is now double-counting. An offset in one mode only ` +
      `would instead mean that network is being built wrong.</span></p>`);
  say(`<pre id="meshLengthTSV">${tsv.join('\n')}</pre>`);
}

// ------------------------------------------------------ the overlap term
// THE PART THAT IS ACTUALLY BEING FITTED, and the first run of this table
// measured almost entirely confounds rather than overlap.
//
// Two of them, both at the page border. The Voronoi network included the CLIP
// BOUNDARY -- cells are cut to the drawing polygon, so part of every outer ring
// is the page edge rather than a cell edge -- worth 0.040 of coverage on this
// canvas, against a signal of the same size at the sparse end. And the pinned
// perimeter ring adds points at a rate of perimeter/d against the interior's
// 1.1547*area/d^2, so it is half the point count when d is large. Fitted A came
// out at -12 with a spread of 12, which is what a fixed offset in the
// denominator looks like when the thing it is fitting is not the overlap.
//
// Both are BORDER effects, so both go away on an interior window. And the
// measurement is now made directly rather than through a density estimate:
//
//     overlap factor = rendered coverage / (w * measured length per unit area)
//
// which needs neither C nor d nor the point distribution. Length is geometry and
// was already checked above; this is the one remaining step, exactly as
// refiningNoise separates "is the contour the right length" from "does that
// length cover the right area".
say('<h2>Mesh — the overlap correction, measured on an interior window</h2>');
say('<p class="note">Rendered ink against <i>w</i> × drawn length, both over a ' +
    'window inset three spacings from the page edge. A ratio of 1 means strokes ' +
    'never overlap; below 1 is the ink counted twice where edges meet. Fitted ' +
    '<i>A</i> follows from it, and the column to watch is whether A is steady — ' +
    'a drift means <code>K = C·w/(d + A·w)</code> is the wrong shape rather ' +
    'than A being the wrong number.</p>');
{
  const tsv = ['mode\tdW\td\tlenPerArea\tcovFromLen\tcovRendered\toverlap\tA_fitted'];
  say('<table><tr><th>mode</th><th>d (×pen)</th><th>pts in window</th>' +
      '<th>length/area</th><th>effective C</th>' +
      '<th>w×length</th><th>rendered</th><th>overlap ratio</th>' +
      '<th>A fitted</th></tr>');
  const fitted = { voronoi: [], delaunay: [] };
  for (const mode of ['voronoi', 'delaunay']) {
    for (const dW of [4, 5, 6, 8, 12]) {
      // FULL SIZE, not `small`, and a narrower d range. The window is inset
      // three spacings, so on a 150 px canvas the sparse rows enclosed about
      // four points at dW = 18 and one at dW = 32 -- which is where the fitted
      // A of -2.05 and -6.99 came from. The window point count is reported so a
      // thin row is visible as a thin row rather than as a wrong number.
      const ctx = prepare(makeImage(400, 400, 0.5), flat);
      const w = ctx.w;
      const d = dW * w;
      const args = {
        ...ctx, mode, dMinW: dW, dMaxW: dW, relaxIter: 6, polishIter: 8,
        seed: 1, maxPoints: 12000,
      };
      const lines = meshEdges.run(args);

      // interior window, inset three spacings: far enough that neither the clip
      // boundary nor the ring's extra row of points reaches into it
      const inset = Math.min(ctx.nx / 3, 3 * d);
      const wx0 = 1 + inset, wy0 = 1 + inset;
      const wx1 = ctx.nx - inset, wy1 = ctx.ny - inset;
      if (!(wx1 > wx0 + 4 && wy1 > wy0 + 4)) continue;
      const winPx = [wx0, wx1, wx1, wx0], winPy = [wy0, wy0, wy1, wy1];
      const winArea = (wx1 - wx0) * (wy1 - wy0);

      const segs = lines.map((l) => [l[0][0], l[0][1], l[1][0], l[1][1]]);
      const kept = trimLineSegsToPolygon(segs, winPx, winPy)
        .map((s) => [[s[0], s[1]], [s[2], s[3]]]);
      const lenPerArea = pathLength(kept) / winArea;

      const rendered = renderForTest(ctx, kept, { wLine: w });
      let ink = 0, nPx = 0;
      const j0 = Math.max(0, Math.round(wx0) - 1), j1 = Math.min(ctx.nx - 1, Math.round(wx1) - 1);
      const i0 = Math.max(0, Math.round(wy0) - 1), i1 = Math.min(ctx.ny - 1, Math.round(wy1) - 1);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) { ink += 1 - rendered.data[i * ctx.nx + j]; nPx++; }
      }
      const covRendered = nPx > 0 ? ink / nPx : 0;
      const covFromLen = w * lenPerArea;
      const overlap = covFromLen > 0 ? covRendered / covFromLen : NaN;

      // A FROM THE OVERLAP RATIO, not from the coverage. Solving
      // A = (C*w/K - d)/w brings in C and the REQUESTED d, so any error in the
      // achieved point density lands in A -- which is how the first run of this
      // table produced values that swung by 12. The overlap ratio has neither in
      // it: K = C*w/(d + A*w) = (C*w/d)/(1 + A*w/d), and the first factor IS
      // w*length, so overlap = 1/(1 + A*w/d) and A = (1/overlap - 1)*d/w.
      const aFit = overlap > 0 ? ((1 / overlap) - 1) * (d / w) : NaN;
      // effective C, so the leading constant is visible in the same table as the
      // correction rather than only in the length section
      const effC = lenPerArea * d;
      // how much the window actually contains, at the achieved density
      const winPts = Math.round((winArea * 1.1547) / (d * d));
      fitted[mode].push(aFit);
      say(`<tr><td>${mode}</td><td>${dW}</td><td>${winPts}</td>` +
          `<td>${num(lenPerArea, 5)}</td><td>${num(effC, 3)}</td>` +
          `<td>${num(covFromLen, 4)}</td><td>${num(covRendered, 4)}</td>` +
          `<td>${num(overlap, 4)}</td><td>${num(aFit, 3)}</td></tr>`);
      tsv.push([mode, dW, num(d, 2), winPts, num(lenPerArea, 5), num(effC, 3),
                num(covFromLen, 4), num(covRendered, 4), num(overlap, 4),
                num(aFit, 3)].join('\t'));
    }
  }
  say('</table>');
  const stat = (xs) => {
    const g = xs.filter((v) => Number.isFinite(v));
    if (g.length === 0) return { mean: NaN, spread: NaN };
    return {
      mean: g.reduce((s, v) => s + v, 0) / g.length,
      spread: Math.max(...g) - Math.min(...g),
    };
  };
  const fv = stat(fitted.voronoi), fd = stat(fitted.delaunay);
  say(`<p>fitted A — voronoi <b>${num(fv.mean, 3)}</b> (spread ` +
      `${num(fv.spread, 3)}, shipping ${MESH_TONE.voronoi.A}), delaunay ` +
      `<b>${num(fd.mean, 3)}</b> (spread ${num(fd.spread, 3)}, shipping ` +
      `${MESH_TONE.delaunay.A}). <span class="note">Put the means into ` +
      `MESH_TONE if the spreads are small. The overlap ratio column is the ` +
      `physically meaningful one: it must be ≤ 1 and approach 1 as d grows, ` +
      `since a sparser network has proportionally fewer junctions. A ratio ` +
      `ABOVE 1 would mean ink is appearing that no drawn line accounts for — ` +
      `look for a border effect leaking into the window before believing it.` +
      `</span></p>`);
  say(`<pre id="meshOverlapTSV">${tsv.join('\n')}</pre>`);
}

runToneTest(
  'Linear ramp — mesh edges (Voronoi)',
  meshEdges,
  linearRamp(600, 200),
  { mode: 'voronoi', dMinW: 4, dMaxW: 60, relaxIter: 6, polishIter: 8, seed: 1, maxPoints: 8000 },
  flat,
);

runToneTest(
  'Linear ramp — mesh edges (Delaunay)',
  meshEdges,
  linearRamp(600, 200),
  { mode: 'delaunay', dMinW: 5, dMaxW: 60, relaxIter: 6, polishIter: 8, seed: 1, maxPoints: 8000 },
  flat,
);

runToneTest(
  'Radial ramp — mesh edges (Voronoi)',
  meshEdges,
  radialRamp(400, 400),
  { mode: 'voronoi', dMinW: 4, dMaxW: 60, relaxIter: 6, polishIter: 8, seed: 1, maxPoints: 8000 },
  flat,
);

}
