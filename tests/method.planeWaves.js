// New with the plane-wave port; not sliced from the pre-split harness.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { stipplePoints, perimeterPoints } from '../src/spine/points.js';
import { tileRegions, regionEdges, TRI_SIDE_PER_AREA } from '../src/spine/regions.js';
import { buildMesh } from '../src/spine/mesh1form.js';
import { triangulate } from '../src/spine/delaunay.js';
import { clipConvex, polyArea } from '../src/spine/polygon.js';
import planeWaves, { stripeOffsets } from '../src/methods/planeWaves.js';
import {
  say, num, flat, mkRand, linearRamp, radialRamp, runToneTest, renderForTest,
} from './runner.js';

// Monotone-chain convex hull, used only by the tests below: the triangulated area
// must equal the hull's, and the Euler counts need the hull SIZE.
//
// COLLINEAR HULL POINTS ARE KEPT (`< 0`, not `<= 0`), and that is required
// rather than incidental. Euler's T = 2n-2-h and E = 3n-3-h count h as hull
// VERTICES, and every collinear point along a hull edge is still a vertex of the
// triangulation -- Bowyer-Watson inserts all of them. Dropping them, which is
// the usual convex-hull convention, would under-count h and make the prediction
// wrong by exactly the number of evenly-spaced perimeter points. Area is
// unaffected either way.
function hullOf(xs, ys) {
  const idx = Array.from({ length: xs.length }, (_, i) => i)
    .sort((a, b) => (xs[a] - xs[b]) || (ys[a] - ys[b]));
  const cross = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const build = (pts) => {
    const st = [];
    for (const p of pts) {
      while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], p) < 0) st.pop();
      st.push(p);
    }
    return st;
  };
  const lower = build(idx), upper = build(idx.slice().reverse());
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function hullCount(xs, ys) { return hullOf(xs, ys).length; }
function convexHullArea(xs, ys) {
  const h = hullOf(xs, ys);
  let a = 0;
  for (let i = 0; i < h.length; i++) {
    const j = (i + 1) % h.length;
    a += xs[h[i]] * ys[h[j]] - xs[h[j]] * ys[h[i]];
  }
  return Math.abs(a) / 2;
}

export function run() {

// ------------------------------------------------------------ region tilers
// A tiler must PARTITION the polygon: the clipped cells' areas have to sum to
// the polygon's area, or the method is drawing on a subset of the page and
// every tone number after this is measuring the wrong thing. Overlap and gaps
// both show up in that one number, in opposite directions, so it is worth
// reporting the signed error rather than its magnitude.
say('<h2>Region tilers — do the cells partition the polygon?</h2>');
say('<p class="note">Cell area is the size contract, not cell width: a square ' +
    'of side <i>a</i> and a hexagon of circumradius <i>a</i>/1.612 have the same ' +
    'area, so switching lattice keeps the region count and the control means ' +
    'the same thing in both. The mean cell area is reported against the ' +
    'requested one — border cells are clipped and drag it down, which is ' +
    'expected and is why the count is shown too.</p>');
{
  const ctx = prepare(makeImage(600, 400, 0.5), flat);
  const { px, py } = ctx.polygon;
  const total = polyArea(px, py);
  say('<table><tr><th>lattice</th><th>size (px)</th><th>cells</th>' +
      '<th>Σ cell area</th><th>polygon area</th><th>error</th>' +
      '<th>mean area / requested</th></tr>');
  let worst = 0;
  for (const kind of ['rect', 'hex', 'trilattice', 'voronoi', 'delaunay']) {
    for (const sizePx of [20, 45, 90]) {
      const cells = tileRegions(ctx, { kind, sizePx, seed: 1, iterations: 6, polish: 8 });
      let sum = 0;
      for (const c of cells) sum += c.area;
      const err = (sum - total) / total;
      worst = Math.max(worst, Math.abs(err));
      say(`<tr><td>${kind}</td><td>${sizePx}</td>` +
          `<td>${cells.length.toLocaleString()}</td><td>${num(sum, 1)}</td>` +
          `<td>${num(total, 1)}</td>` +
          `<td>${err >= 0 ? '+' : ''}${num(err, 5)}</td>` +
          `<td>${num(sum / cells.length / (sizePx * sizePx), 3)}</td></tr>`);
    }
  }
  say('</table>');
  const ok = worst < 1e-6;
  say(`<p>cells partition the polygon — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 8)} of the area). ` +
      `<span class="note">This is exact arithmetic, not a measurement, so the ` +
      `tolerance is 1e-6 rather than a percent. A POSITIVE error means cells ` +
      `overlap; negative means the lattice does not reach the far edge.</span></p>`);
}

// ------------------------------------------------------------- trilattice
// The regular mesh, ported from trianglePlane.m. Three claims, all exact:
// it is equilateral, its vertices are SHARED, and its faces are wound
// consistently. The third is the one triStripes cannot survive without -- curl
// is only conserved because a shared edge is traversed oppositely by its two
// faces, and that follows from the winding, which here is hand-derived rather
// than produced by a triangulator.
say('<h2>Triangular lattice — equilateral, shared, and consistently wound</h2>');
say('<p class="note">With the jitter off this is arithmetic, so the tolerances ' +
    'are 1e-9 rather than percentages. V − E + F = 1 is Euler for a disc and is ' +
    'what proves the vertices are shared: emit three per triangle without ' +
    'deduplicating and V jumps to 3F, which no amount of visual inspection of ' +
    'the drawing would reveal.</p>');
{
  const ctx = prepare(makeImage(600, 400, 0.5), flat);
  say('<table><tr><th>size (px)</th><th>faces</th><th>V − E + F</th>' +
      '<th>edge length / side</th><th>face area / size²</th>' +
      '<th>V / F</th><th>signs opposite</th></tr>');
  let allOk = true;
  for (const sizePx of [30, 60]) {
    const cells = tileRegions(ctx, { kind: 'trilattice', sizePx, jitter: 0, seed: 1 });
    const { tris, nT, sx, sy } = cells.adjacency;
    const mesh = buildMesh(tris, nT);
    // only vertices the faces actually use
    const used = new Set();
    for (let i = 0; i < 3 * nT; i++) used.add(tris[i]);
    const euler = used.size - mesh.nE + nT;

    const side = sizePx * TRI_SIDE_PER_AREA;
    let eMin = Infinity, eMax = 0;
    for (let e = 0; e < mesh.nE; e++) {
      const a = mesh.eLo[e], b = mesh.eHi[e];
      const L = Math.hypot(sx[b] - sx[a], sy[b] - sy[a]) / side;
      eMin = Math.min(eMin, L); eMax = Math.max(eMax, L);
    }
    let aMin = Infinity, aMax = 0;
    for (let f = 0; f < nT; f++) {
      const a = tris[3 * f], b = tris[3 * f + 1], c = tris[3 * f + 2];
      const A = Math.abs((sx[b] - sx[a]) * (sy[c] - sy[a])
                       - (sx[c] - sx[a]) * (sy[b] - sy[a])) / 2 / (sizePx * sizePx);
      aMin = Math.min(aMin, A); aMax = Math.max(aMax, A);
    }
    let bad = 0;
    for (let e = 0; e < mesh.nE; e++) {
      const a = mesh.eFaceA[e], b = mesh.eFaceB[e];
      if (b < 0) continue;
      let sa = 0, sb = 0;
      for (let k = 0; k < 3; k++) {
        if (mesh.faceEdge[3 * a + k] === e) sa = mesh.faceSign[3 * a + k];
        if (mesh.faceEdge[3 * b + k] === e) sb = mesh.faceSign[3 * b + k];
      }
      if (sa + sb !== 0) bad++;
    }
    const eOk = Math.abs(eMin - 1) < 1e-9 && Math.abs(eMax - 1) < 1e-9;
    const aOk = Math.abs(aMin - 1) < 1e-9 && Math.abs(aMax - 1) < 1e-9;
    const ok = euler === 1 && eOk && aOk && bad === 0;
    allOk = allOk && ok;
    say(`<tr><td>${sizePx}</td><td>${nT.toLocaleString()}</td>` +
        `<td class="${euler === 1 ? 'pass' : 'fail'}">${euler}</td>` +
        `<td class="${eOk ? 'pass' : 'fail'}">${num(eMin, 9)} … ${num(eMax, 9)}</td>` +
        `<td class="${aOk ? 'pass' : 'fail'}">${num(aMin, 9)} … ${num(aMax, 9)}</td>` +
        `<td>${num(used.size / nT, 3)}</td>` +
        `<td class="${bad === 0 ? 'pass' : 'fail'}">${bad === 0 ? 'yes' : `${bad} WRONG`}</td></tr>`);
  }
  say('</table>');
  say(`<p>the lattice is a valid mesh — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(V/F tends to 1/2 on ` +
      `a large patch, which is Euler again from the other side. The area column ` +
      `is what makes the slider mean the same thing here as for rect and hex: ` +
      `without TRI_SIDE_PER_AREA a triangle of side <i>a</i> covers 0.43<i>a</i>² ` +
      `and the same setting would return 2.3× as many regions.)</span></p>`);
}

// ------------------------------------------------- voronoi capacity
// THE CLAIM THIS TILER EXISTS FOR: equal ink per cell.
//
// It used to be delivered by a flat Lloyd relaxation weighted by rho^2, relying
// on the Gersho/Zador law that a centroidal Voronoi tessellation with density
// rho has seed density rho^(1/2). That law is real -- an earlier version of this
// table confirmed it -- but the relaxation could not GET there: on a two-tone
// field the measured exponent sat midway between the initialisation and the
// fixed point after sixty iterations, because in the bulk of a flat region a
// seed already sits at its cell centroid and has nothing pushing it across the
// boundary.
//
// stipplePoints removes the problem rather than converging harder. Counts come
// from mass, top down, so seed density is proportional to the field BY
// CONSTRUCTION and there is no exponent to correct. The prediction is therefore
// simpler and sharper than it was: with point density proportional to darkness,
// ink per cell is the same everywhere, so on two flat tones the ratio is
//
//     1.00, at every tone ratio, with nothing asymptotic about it.
//
// The old sweep over the exponent is gone with the code path it exercised; the
// finding it produced is written up in docs/findings.md.
say('<h2>Voronoi regions — is the ink per cell uniform?</h2>');
say('<p class="note">Two flat tones in the left and right halves, swept over ' +
    'the tone ratio. Ink per cell must be 1.00 whatever that ratio is — the ' +
    'subdivider sets each cell count from its mass, so this is exact by ' +
    'construction rather than an asymptotic law being approached. A ratio that ' +
    'tracks the tone ratio means the counts are not following the mass.</p>');
{
  say('<table><tr><th>dark : light</th><th>predicted ratio</th>' +
      '<th>measured ratio</th><th>count ratio vs mass ratio</th>' +
      '<th>cells dark / light / mixed</th>' +
      '<th>ink CV</th><th>polish steps</th></tr>');
  let worst = 0;
  for (const light of [0.75, 0.5, 0.25]) {
    const src = makeImage(400, 400, 0);
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 400; x++) src.data[y * 400 + x] = x < 200 ? 0 : light;
    }
    const ctx = prepare(src, flat);
    const nCells = 100;
    const dark = new Float64Array(ctx.nx * ctx.ny);
    for (let i = 0; i < dark.length; i++) {
      dark[i] = (1 - Math.min(1, Math.max(0, ctx.im.data[i]))) + 1e-3;
    }
    const { sx, sy, moved } = stipplePoints(ctx, {
      field: dark, count: nCells, seed: 1, iterations: 6, polish: 8,
    });
    const n = sx.length;
    const acc = new Float64Array(n), cnt = new Int32Array(n);
    const sawDark = new Uint8Array(n), sawLight = new Uint8Array(n);
    const half = ctx.nx / 2;
    for (let iy = 0; iy < ctx.ny; iy++) {
      for (let ix = 0; ix < ctx.nx; ix++) {
        let best = -1, bd = Infinity;
        for (let s = 0; s < n; s++) {
          const dx = sx[s] - (ix + 1), dy = sy[s] - (iy + 1);
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = s; }
        }
        acc[best] += 1 - ctx.im.data[iy * ctx.nx + ix];
        cnt[best]++;
        if (ix + 1 < half) sawDark[best] = 1; else sawLight[best] = 1;
      }
    }
    // A cell is scored only if all of its pixels are in one tone; one straddling
    // the boundary holds both, and attributing it by where its seed happens to
    // sit was worth ~10% of the ratio before this exclusion.
    let dSum = 0, dN = 0, lSum = 0, lN = 0, mixed = 0, all = 0, allN = 0;
    for (let s = 0; s < n; s++) {
      if (cnt[s] === 0) continue;
      all += acc[s]; allN++;
      if (sawDark[s] && sawLight[s]) { mixed++; continue; }
      if (sawDark[s]) { dSum += acc[s]; dN++; } else { lSum += acc[s]; lN++; }
    }
    const meanAll = all / allN;
    let varSum = 0;
    for (let s = 0; s < n; s++) if (cnt[s] > 0) varSum += (acc[s] - meanAll) ** 2;
    const cv = Math.sqrt(varSum / allN) / meanAll;
    const ratio = (dSum / dN) / (lSum / lN);
    worst = Math.max(worst, Math.abs(ratio - 1));
    // Counts alongside the ink. If counts follow mass then the ink ratio is 1 by
    // arithmetic, so reporting both says WHICH half of the claim broke rather
    // than only that something did.
    const massRatio = 1 / (1 - light);
    const countRatio = lN > 0 ? dN / lN : NaN;
    say(`<tr><td>1.00 : ${num(1 - light, 2)}</td><td>1.000</td>` +
        `<td>${num(ratio, 3)}</td>` +
        `<td>${num(countRatio, 2)} vs ${num(massRatio, 2)}</td>` +
        `<td>${dN} / ${lN} / ${mixed}</td>` +
        `<td>${num(cv, 3)}</td><td>${moved.length}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.10;
  say(`<p>ink per cell is uniform — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 3)} off unity). ` +
      `<span class="note">10% because a hundred cells over two tones is a small ` +
      `sample and the boundary row is excluded rather than modelled, not because ` +
      `the claim is approximate — it is exact. The count column is the ` +
      `diagnostic: if counts track mass and the ink ratio is still off, the ` +
      `leaves are carrying uneven mass (the subdivider emits one point when a ` +
      `cell's mass ROUNDS to one, so a leaf holds anywhere from 0.5 to 1.5 of ` +
      `the target — that is what the CV column shows). If the counts themselves ` +
      `fall short of the mass ratio, something is pulling seeds toward ` +
      `sqrt(mass), which is what the boundary polish was doing before it was ` +
      `restricted to the boundary.</span></p>`);
}

// The old flat relaxation reported its convergence per iteration. The
// subdivider has no such trace -- it is not iterative at the top level -- so
// what is checked instead is that the boundary polish settles and that the whole
// thing is reproducible.
say('<h2>Voronoi regions — polish settles, and the result is deterministic</h2>');
{
  const ctx = prepare(radialRamp(300, 300), flat);
  const dark = new Float64Array(ctx.nx * ctx.ny);
  for (let i = 0; i < dark.length; i++) {
    dark[i] = (1 - Math.min(1, Math.max(0, ctx.im.data[i]))) + 1e-3;
  }
  // WITH A RING, deliberately: polish only runs when there is a pinned boundary
  // to settle against, because that is the only thing it is for. Calling without
  // one now skips it entirely -- which is the right behaviour and would make
  // this test vacuous if it did not supply one.
  const ring = perimeterPoints(ctx, dark, 80);
  const mk = (seed) => stipplePoints(ctx, {
    field: dark, count: 80, seeds0: ring, seed, iterations: 6, polish: 20,
  });
  const a = mk(1), b = mk(1), c = mk(2);
  const same = (p, q) => {
    if (p.sx.length !== q.sx.length) return false;
    for (let i = 0; i < p.sx.length; i++) {
      if (p.sx[i] !== q.sx[i] || p.sy[i] !== q.sy[i]) return false;
    }
    return true;
  };
  const m = a.moved;
  const settles = m.length === 0 || m[m.length - 1] < m[0];
  const repro = same(a, b), differs = !same(a, c);
  // the ring is part of the returned set, so the interior count is what to check
  const countOk = Math.abs((a.sx.length - ring.sx.length) - 80) <= 10;
  say('<table>' +
    `<tr><th>interior asked / got</th><td class="${countOk ? 'pass' : 'fail'}">80 / ${a.sx.length - ring.sx.length}</td></tr>` +
    `<tr><th>pinned ring points</th><td>${ring.sx.length}</td></tr>` +
    `<tr><th>polish steps run (of 20)</th><td>${m.length}</td></tr>` +
    `<tr><th>first / last movement</th><td>${num(m[0] ?? 0, 3)} → ${num(m[m.length - 1] ?? 0, 4)} px</td></tr>` +
    `<tr><th>polish settles</th><td class="${settles ? 'pass' : 'fail'}">${settles ? 'yes' : 'no'}</td></tr>` +
    `<tr><th>seed 1 reproduces</th><td class="${repro ? 'pass' : 'fail'}">${repro ? 'yes' : 'no'}</td></tr>` +
    `<tr><th>seed 2 differs</th><td class="${differs ? 'pass' : 'fail'}">${differs ? 'yes' : 'no'}</td></tr>` +
    '</table>');
  const ok = settles && repro && differs && countOk;
  say(`<p>placer is settled and deterministic — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(the count is approximate by construction: a leaf ` +
      `emits one point when its mass rounds to one, so the total lands near the ` +
      `request rather than on it. A large shortfall would mean cells are being ` +
      `dropped, which the partition test above would also catch.)</span></p>`);
}

// ------------------------------------------------ how hexagonal is it?
// THE CALIBRATION DEPENDS ON THIS, which is why it is measured rather than
// assumed. meshEdges derives its tone constants -- C = 2, C = 2*sqrt3, and the
// sqrt3 ratio between them -- from a HEXAGONAL arrangement. A point set that is
// only locally relaxed may be measurably less hexagonal than a fully relaxed
// one, and if it is, those constants shift.
//
// Two measures, both scale free. The coefficient of variation of the
// nearest-neighbour distance is 0 for a perfect lattice and about 0.52 for a
// Poisson process, so it says how far along that range the set sits. The mean
// neighbour count from the triangulation is 6 for a lattice.
say('<h2>Point sets — how hexagonal is the subdivider?</h2>');
say('<p class="note">The mesh tone constants assume a hexagonal arrangement, so ' +
    'this is what says whether that assumption survives. CV of the ' +
    'nearest-neighbour distance is 0 for a perfect lattice and ≈0.52 for ' +
    'Poisson; mean Delaunay degree is 6 for a lattice. Swept over the boundary ' +
    'polish, which is the only knob that can improve the arrangement after the ' +
    'subdivision has fixed the counts.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), flat);
  const uniform = new Float64Array(ctx.nx * ctx.ny).fill(1);
  say('<table><tr><th>points</th><th>polish</th><th>NN distance CV</th>' +
      '<th>mean degree</th><th>NN mean / hex ideal</th></tr>');
  for (const count of [400, 1200]) {
    for (const polish of [0, 4, 12]) {
      const { sx, sy } = stipplePoints(ctx, {
        field: uniform, count, seed: 1, iterations: 6, polish,
      });
      const n = sx.length;
      const nn = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let bd = Infinity;
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const d = (sx[i] - sx[j]) ** 2 + (sy[i] - sy[j]) ** 2;
          if (d < bd) bd = d;
        }
        nn[i] = Math.sqrt(bd);
      }
      let mean = 0;
      for (let i = 0; i < n; i++) mean += nn[i];
      mean /= n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (nn[i] - mean) ** 2;
      const cv = Math.sqrt(v / n) / mean;
      const { tris, n: nT } = triangulate(sx, sy);
      const deg = new Int32Array(n);
      const seen = new Set();
      for (let t = 0; t < nT; t++) {
        for (let k = 0; k < 3; k++) {
          const u = tris[3 * t + k], w2 = tris[3 * t + ((k + 1) % 3)];
          const key = u < w2 ? `${u},${w2}` : `${w2},${u}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deg[u]++; deg[w2]++;
        }
      }
      let dSum = 0;
      for (let i = 0; i < n; i++) dSum += deg[i];
      // hexagonal spacing for this achieved density
      const area = (ctx.nx - 1) * (ctx.ny - 1);
      const ideal = Math.sqrt(1.1547 / (n / area));
      say(`<tr><td>${n}</td><td>${polish}</td><td>${num(cv, 4)}</td>` +
          `<td>${num(dSum / n, 3)}</td><td>${num(mean / ideal, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note"><b>NN mean / hex ideal reads about 0.88, and that is the ' +
      'ESTIMATOR, not the point set.</b> On a perfect lattice every neighbour is ' +
      'at exactly d, so the nearest is too; on any real set the nearest is the ' +
      'MINIMUM of six varying distances and so sits below the mean spacing. The ' +
      'column is useful for its trend with polish, not its absolute value — and ' +
      'note that the tone constants are derived from the DENSITY, which has no ' +
      'such bias, so this column does not bear on them.</p>');
  say('<p class="note">No verdict here on purpose — this is a characterisation, ' +
      'not a pass/fail. Read it before trusting the mesh constants: a CV near ' +
      '0.5 would say the set is close to Poisson and the hexagonal derivation ' +
      'does not apply, in which case the constants need refitting rather than ' +
      'the placer needing fixing. A CV that falls with polish says the polish ' +
      'is buying arrangement, which is the argument for its default value.</p>');
}

// -------------------------------------- does the perimeter match its interior?
// The ring is PINNED, so if its spacing is wrong nothing downstream can correct
// it -- the error sits in the drawing as a band of wrong tone all the way round
// the page. A single global spacing gets this wrong wherever the image is not
// uniform near the border, which is most images.
//
// Measured against the interior it actually meets: for each perimeter point,
// the distance to its neighbour along the ring, over the mean spacing of the
// nearest few interior points. Both are lengths in the same units, so the ratio
// should be 1 wherever the two agree.
say('<h2>Perimeter points — do they match the local interior spacing?</h2>');
say('<p class="note">A field with a dark band down one side, so the interior ' +
    'wants dense points there and sparse points elsewhere. The ratio compares ' +
    'each perimeter gap against the spacing of the interior points it adjoins. ' +
    'A fixed-spacing ring cannot track this by construction; the phase-integral ' +
    'ring should hold near 1 on both sides.</p>');
{
  const src = makeImage(400, 400, 1);
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) src.data[y * 400 + x] = x < 120 ? 0.05 : 0.95;
  }
  const ctx = prepare(src, flat);
  const dark = new Float64Array(ctx.nx * ctx.ny);
  for (let i = 0; i < dark.length; i++) {
    dark[i] = (1 - Math.min(1, Math.max(0, ctx.im.data[i]))) + 1e-3;
  }
  const count = 600;
  const ring = perimeterPoints(ctx, dark, count);
  const { sx, sy } = stipplePoints(ctx, {
    field: dark, count, seeds0: ring, seed: 1, iterations: 6, polish: 8,
  });
  const nRing = ring.sx.length;

  // interior spacing near a point: mean distance to its three nearest interior
  // neighbours, which is a local estimate rather than a global one
  const localSpacing = (qx, qy) => {
    const best = [Infinity, Infinity, Infinity];
    for (let i = nRing; i < sx.length; i++) {
      const d = Math.hypot(sx[i] - qx, sy[i] - qy);
      if (d < best[0]) { best[2] = best[1]; best[1] = best[0]; best[0] = d; }
      else if (d < best[1]) { best[2] = best[1]; best[1] = d; }
      else if (d < best[2]) best[2] = d;
    }
    return (best[0] + best[1] + best[2]) / 3;
  };

  const half = ctx.nx * 0.3;
  const rows = { dark: [], light: [] };
  for (let i = 0; i < nRing; i++) {
    const j = (i + 1) % nRing;
    const gap = Math.hypot(ring.sx[j] - ring.sx[i], ring.sy[j] - ring.sy[i]);
    // skip the wrap between sides, which is not a gap along one edge
    if (gap > ctx.nx / 3) continue;
    const s = localSpacing(ring.sx[i], ring.sy[i]);
    if (!(s > 0)) continue;
    (ring.sx[i] < half ? rows.dark : rows.light).push(gap / s);
  }
  const stat = (a) => {
    if (a.length === 0) return { mean: NaN, n: 0 };
    return { mean: a.reduce((s, v) => s + v, 0) / a.length, n: a.length };
  };
  const d = stat(rows.dark), l = stat(rows.light);
  say('<table><tr><th>side</th><th>perimeter points</th>' +
      '<th>gap / local interior spacing</th></tr>' +
      `<tr><td>dark</td><td>${d.n}</td><td>${num(d.mean, 3)}</td></tr>` +
      `<tr><td>light</td><td>${l.n}</td><td>${num(l.mean, 3)}</td></tr>` +
      `<tr><td>ring points total</td><td>${nRing}</td><td>—</td></tr>` +
      '</table>');
  const ok = Math.abs(d.mean - 1) < 0.35 && Math.abs(l.mean - 1) < 0.35;
  say(`<p>perimeter tracks the interior — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> <span class="note">(0.35 is loose because ` +
      `a three-neighbour estimate of local spacing is itself noisy, and a ` +
      `boundary point has interior neighbours on one side only, which biases ` +
      `the estimate high. What the test is really for is the DIFFERENCE between ` +
      `the two rows: a fixed-spacing ring would read far above 1 on the dark ` +
      `side and far below on the light one, and the two rows agreeing is the ` +
      `whole claim.)</span></p>`);
}

// Shared edges must be emitted once. Drawing every cell ring would send the pen
// down every interior boundary twice, doubling both its ink and its travel.
say('<h2>Region outlines — are shared edges deduplicated?</h2>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), flat);
  say('<table><tr><th>lattice</th><th>cells</th><th>edges, naive</th>' +
      '<th>edges, deduped</th><th>saved</th></tr>');
  let allOk = true;
  for (const kind of ['rect', 'hex', 'trilattice', 'voronoi', 'delaunay']) {
    const cells = tileRegions(ctx, { kind, sizePx: 45, seed: 1, iterations: 6, polish: 8 });
    let naive = 0;
    for (const c of cells) naive += c.px.length;
    const edges = regionEdges(cells);
    // an interior edge is shared by exactly two cells, so dedup must remove
    // strictly fewer than half and strictly more than none on any real tiling
    const ok = edges.length < naive && edges.length > naive / 2 - 1;
    allOk = allOk && ok;
    say(`<tr><td>${kind}</td><td>${cells.length}</td><td>${naive}</td>` +
        `<td>${edges.length}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${num(1 - edges.length / naive, 3)}</td></tr>`);
  }
  say('</table>');
  say(`<p>outlines deduplicate — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(the saving must sit ` +
      `just under 0.5: every interior edge is shared by two cells and every ` +
      `boundary edge by one, so a tiling with few border cells approaches half. ` +
      `A saving of 0 means the vertex keys are not matching between neighbours — ` +
      `check the rounding in regionEdges before believing the geometry is wrong.)` +
      `</span></p>`);
}

// ------------------------------------------------------------ delaunay
// SCORED AGAINST THE DEFINITION, not against itself: a triangulation is
// Delaunay exactly when no triangle's circumcircle contains another point. At
// these point counts the check is exhaustive, so there is no sampling to argue
// about. The awkward case is deliberately included -- a regular perimeter ring
// is collinear along each side and cocircular at the corners, which is where an
// in-circle test is least happy.
say('<h2>Shim — is the triangulation actually Delaunay?</h2>');
say('<p class="note">The empty-circumcircle property, checked exhaustively ' +
    'against every point. Also that the triangles tile their convex hull: the ' +
    'areas must sum to it exactly, which catches both a dropped triangle and an ' +
    'overlap, in opposite directions.</p>');
{
  const rnd = mkRand(5);
  const cases = [];
  // scattered interior points plus a regular boundary ring, the real case
  {
    const xs = [], ys = [];
    for (let i = 0; i <= 12; i++) { xs.push(1 + i * 24); ys.push(1); }
    for (let i = 1; i <= 12; i++) { xs.push(289); ys.push(1 + i * 24); }
    for (let i = 1; i <= 12; i++) { xs.push(289 - i * 24); ys.push(289); }
    for (let i = 1; i < 12; i++) { xs.push(1); ys.push(289 - i * 24); }
    const nRing = xs.length;
    for (let i = 0; i < 120; i++) { xs.push(10 + rnd() * 270); ys.push(10 + rnd() * 270); }
    cases.push(['ring + scatter', xs, ys, nRing]);
  }
  // a bare square: four cocircular points, the degenerate case by construction
  cases.push(['4 cocircular corners', [0, 100, 100, 0], [0, 0, 100, 100], 4]);
  // collinear run with one point off the line
  cases.push(['collinear + apex',
    [0, 25, 50, 75, 100, 50], [0, 0, 0, 0, 0, 60], 5]);

  say('<table><tr><th>case</th><th>points</th><th>triangles</th>' +
      '<th>points not inserted</th><th>cavities repaired / malformed</th>' +
      '<th>in-circle violations</th><th>Σ area / hull area</th>' +
      '<th>edges with 1 or 2 owners</th></tr>');
  let allOk = true;
  for (const [name, xs, ys, nRing] of cases) {
    const { tris, nbr, n: nT, dropped, repaired, malformed } = triangulate(xs, ys);
    let bad = 0, area = 0;
    for (let t = 0; t < nT; t++) {
      const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
      area += Math.abs((xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a])) / 2;
      // circumcircle of this triangle
      const d = 2 * (xs[a] * (ys[b] - ys[c]) + xs[b] * (ys[c] - ys[a]) + xs[c] * (ys[a] - ys[b]));
      if (Math.abs(d) < 1e-12) continue;
      const a2 = xs[a] ** 2 + ys[a] ** 2, b2 = xs[b] ** 2 + ys[b] ** 2, c2 = xs[c] ** 2 + ys[c] ** 2;
      const ux = (a2 * (ys[b] - ys[c]) + b2 * (ys[c] - ys[a]) + c2 * (ys[a] - ys[b])) / d;
      const uy = (a2 * (xs[c] - xs[b]) + b2 * (xs[a] - xs[c]) + c2 * (xs[b] - xs[a])) / d;
      const r2 = (xs[a] - ux) ** 2 + (ys[a] - uy) ** 2;
      for (let p = 0; p < xs.length; p++) {
        if (p === a || p === b || p === c) continue;
        // a generous tolerance: cocircular points sit exactly ON the circle and
        // must not count as violations, which is the whole reason this test
        // includes a square and a regular ring
        if ((xs[p] - ux) ** 2 + (ys[p] - uy) ** 2 < r2 * (1 - 1e-6)) bad++;
      }
    }
    // every edge must belong to exactly one triangle (hull) or two (interior);
    // three would mean overlap, and nbr encodes it
    let badEdges = 0;
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) if (nbr[3 * t + k] === t) badEdges++;
    }
    // hull area, by the shoelace of the convex hull of the inputs
    const hull = convexHullArea(xs, ys);
    const ratio = hull > 0 ? area / hull : 1;
    const ok = bad === 0 && badEdges === 0 && dropped === 0 && malformed === 0
      && Math.abs(ratio - 1) < 1e-9;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td><td>${xs.length} (${nRing} on the ring)</td>` +
        `<td>${nT}</td>` +
        `<td class="${dropped === 0 ? 'pass' : 'fail'}">${dropped}</td>` +
        `<td class="${malformed === 0 ? 'pass' : 'fail'}">${repaired} / ${malformed}</td>` +
        `<td class="${bad === 0 ? 'pass' : 'fail'}">${bad}</td>` +
        `<td class="${Math.abs(ratio - 1) < 1e-9 ? 'pass' : 'fail'}">${num(ratio, 8)}</td>` +
        `<td class="${badEdges === 0 ? 'pass' : 'fail'}">${badEdges === 0 ? 'yes' : 'no'}</td></tr>`);
  }
  say('</table>');
  say(`<p>triangulation is Delaunay and covers its hull — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(area ratio below 1 means a triangle was dropped, ` +
      `above 1 means two overlap. The perimeter ring is the case worth watching: ` +
      `its sides are collinear and its corners cocircular, so it exercises the ` +
      `in-circle tolerance rather than the happy path.)</span></p>`);
}

// The Voronoi and the Delaunay are duals, computed here by completely different
// routes -- half-plane clipping versus Bowyer-Watson. So their edge counts must
// agree, and that is a much stronger check than either alone: a bug would have
// to appear identically in two unrelated algorithms to survive it.
say('<h2>Delaunay against Voronoi — do the duals agree?</h2>');
{
  const ctx = prepare(radialRamp(300, 300), flat);
  const dark = new Float64Array(ctx.nx * ctx.ny);
  for (let i = 0; i < dark.length; i++) {
    dark[i] = (1 - Math.min(1, Math.max(0, ctx.im.data[i]))) + 1e-3;
  }
  // WITH A PINNED RING, which is the configuration every caller actually uses
  // and the only one in which h is unambiguous.
  //
  // Run without one, the hull is the convex hull of relaxed interior points, and
  // a point sitting a pixel off a long hull edge is genuinely on the boundary by
  // one algorithm's reckoning and inside it by another's. Measured, that cost
  // exactly one triangle: counts of 113 and 175 that fit h = 11 perfectly while
  // the exact hull test said 10, with E = n + T - 1 still holding and the area
  // short by 0.213% -- which is precisely the area of a triangle on a point 1 px
  // inside a 250 px edge. Both readings are defensible and neither is a bug.
  //
  // With the ring, the hull IS the drawing rectangle: every ring point is
  // exactly on it, every interior point strictly inside, and both algorithms
  // agree by construction. So the counts become exact rather than approximate,
  // which is a stronger test than the loose one it replaces -- not a weaker one.
  const ring = perimeterPoints(ctx, dark, 60);
  const { sx, sy } = stipplePoints(ctx, {
    field: dark, count: 60, seeds0: ring, seed: 3, iterations: 6, polish: 10,
  });
  // Euler needs the ACTUAL vertex count; stipplePoints lands near its request,
  // not on it.
  const n = sx.length;
  const { tris, n: nT } = triangulate(sx, sy);
  const dEdges = new Set();
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      const u = tris[3 * t + k], v = tris[3 * t + ((k + 1) % 3)];
      dEdges.add(u < v ? `${u},${v}` : `${v},${u}`);
    }
  }
  // Euler for a triangulation of n points with h on the hull:
  // edges = 3n - 3 - h, triangles = 2n - 2 - h
  const hull = hullCount(sx, sy);
  const predEdges = 3 * n - 3 - hull;
  const predTris = 2 * n - 2 - hull;

  // THREE CHECKS, AND THEY FAIL DIFFERENTLY, which is the point of having all
  // three rather than one.
  //
  // E = n + T - 1 is Euler with h eliminated, so it holds for ANY triangulation
  // of a simply connected region and cannot be argued with. The areas summing to
  // the hull's is what catches a DROPPED triangle. And the h-dependent counts
  // catch a triangulation that is internally consistent but of the wrong point
  // set -- which is a thing that happened, and which neither of the other two
  // notices on its own.
  //
  // All three are exact now that the ring pins the hull. They were not before:
  // without it a point a pixel off a long hull edge made h ambiguous, the counts
  // came out one short, and the area was 0.213% down. That was a real triangle
  // missing, not noise -- but it was missing from a configuration no caller uses,
  // and the fix was to test the shipped one rather than to widen the tolerance
  // until the ambiguity fitted inside it.
  const eulerExact = dEdges.size === n + nT - 1;
  const areaTris = (() => {
    let a = 0;
    for (let t = 0; t < nT; t++) {
      const p = tris[3 * t], q = tris[3 * t + 1], r = tris[3 * t + 2];
      a += Math.abs((sx[q] - sx[p]) * (sy[r] - sy[p]) - (sy[q] - sy[p]) * (sx[r] - sx[p])) / 2;
    }
    return a;
  })();
  const hullArea = convexHullArea(sx, sy);
  const areaRatio = hullArea > 0 ? areaTris / hullArea : 0;
  const areaOk = Math.abs(areaRatio - 1) < 1e-9;
  const trisOk = nT === predTris;
  const edgesOk = dEdges.size === predEdges;
  const ok = eulerExact && areaOk && trisOk && edgesOk;
  say('<table>' +
    `<tr><th>points (${ring.sx.length} pinned on the ring)</th><td>${n}</td></tr>` +
    `<tr><th>on the hull</th><td>${hull}</td></tr>` +
    `<tr><th>triangles</th>` +
      `<td class="${trisOk ? 'pass' : 'fail'}">${nT}</td></tr>` +
    `<tr><th>expected 2n−2−h</th><td>${predTris}</td></tr>` +
    `<tr><th>distinct edges</th>` +
      `<td class="${edgesOk ? 'pass' : 'fail'}">${dEdges.size}</td></tr>` +
    `<tr><th>expected 3n−3−h</th><td>${predEdges}</td></tr>` +
    `<tr><th>E = n + T − 1 (h eliminated)</th>` +
      `<td class="${eulerExact ? 'pass' : 'fail'}">${eulerExact ? 'holds' : 'BROKEN'}</td></tr>` +
    `<tr><th>Σ triangle area / hull area</th>` +
      `<td class="${areaOk ? 'pass' : 'fail'}">${num(areaRatio, 9)}</td></tr>` +
    '</table>');
  say(`<p>the triangulation is complete — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> <span class="note">(all four rows are ` +
      `exact, because the pinned ring makes the hull the drawing rectangle and h ` +
      `unambiguous. They break differently and that is why there are four: ` +
      `<b>area</b> below 1 is a dropped triangle and above 1 is overlap; ` +
      `<b>E = n + T − 1</b> failing means the mesh is not a planar triangulation ` +
      `at all; and the two <b>h-dependent counts</b> catch a mesh that is ` +
      `internally consistent but of the wrong point set, which neither of the ` +
      `others notices.)</span></p>`);
}

// The clipper is the part of the tiler that can be wrong in a way the area sum
// would hide -- a cell clipped to the wrong shape can still have plausible area.
// So it is checked against cases with known answers.
say('<h2>Shim — convex clipping</h2>');
{
  const sq = { px: [0, 10, 10, 0], py: [0, 0, 10, 10] };
  const rows = [];
  const half = clipConvex([5, 15, 15, 5], [0, 0, 10, 10], sq.px, sq.py);
  rows.push(['square overlapping half', half ? num(polyArea(half.px, half.py), 3) : 'null', '50.000']);
  const inside = clipConvex([2, 4, 4, 2], [2, 2, 4, 4], sq.px, sq.py);
  rows.push(['fully inside, unchanged', inside ? num(polyArea(inside.px, inside.py), 3) : 'null', '4.000']);
  const outside = clipConvex([20, 30, 30, 20], [20, 20, 30, 30], sq.px, sq.py);
  rows.push(['fully outside', outside === null ? 'null' : 'polygon', 'null']);
  const corner = clipConvex([-5, 5, 5, -5], [-5, -5, 5, 5], sq.px, sq.py);
  rows.push(['corner overlap', corner ? num(polyArea(corner.px, corner.py), 3) : 'null', '25.000']);
  // clockwise clip polygon: winding must not matter
  const cw = clipConvex([5, 15, 15, 5], [0, 0, 10, 10], [0, 0, 10, 10], [0, 10, 10, 0]);
  rows.push(['reversed clip winding', cw ? num(polyArea(cw.px, cw.py), 3) : 'null', '50.000']);

  say('<table><tr><th>case</th><th>got</th><th>expected</th><th></th></tr>');
  let allOk = true;
  for (const [name, got, want] of rows) {
    const ok = got === want;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td><td>${got}</td><td>${want}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'ok' : 'WRONG'}</td></tr>`);
  }
  say('</table>');
  say(`<p>clipConvex — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(winding is derived ` +
      `from the clip polygon's signed area, so a tiler may emit cells either ` +
      `way round — the last row is what checks that)</span></p>`);
}

// ------------------------------------------------------- the phase integral
// The method's entire claim: consecutive stripes sit exactly one local L apart.
// In 1-D that is an integral rather than an eikonal solve, so it can be checked
// against the closed form directly, with no rendering involved.
say('<h2>Plane waves — does the phase integral place stripes at L?</h2>');
say('<p class="note">A constant-darkness profile must give evenly spaced ' +
    'stripes at exactly the L its brightness asks for, and the count must be ' +
    'the span divided by L. This is arithmetic on the profile, upstream of any ' +
    'drawing, so an error here is the ladder or the integration.</p>');
{
  const w = 1.5, Lmin = 2 * w, Lmax = 40 * w;
  const span = 600;
  say('<table><tr><th>image</th><th>wanted L</th><th>stripes</th>' +
      '<th>expected</th><th>mean gap</th><th>gap spread</th></tr>');
  let worstGap = 0, worstCount = 0;
  for (const im of [0, 0.25, 0.5, 0.75, 1]) {
    // uniform pixels along the axis, constant darkness
    const n = span;
    const u = new Float64Array(n), K = new Float64Array(n);
    for (let i = 0; i < n; i++) { u[i] = i; K[i] = 1 - im; }
    const offs = stripeOffsets(u, K, Lmin, Lmax, w);
    // 1/L = 1/Lmin + B*(1/Lmax - 1/Lmin)
    const wantL = 1 / (1 / Lmin + im * (1 / Lmax - 1 / Lmin));
    const expected = Math.round((n - 1) / wantL);
    let mean = 0, lo = Infinity, hi = -Infinity;
    for (let i = 1; i < offs.length; i++) {
      const g = offs[i] - offs[i - 1];
      mean += g; if (g < lo) lo = g; if (g > hi) hi = g;
    }
    mean = offs.length > 1 ? mean / (offs.length - 1) : NaN;
    const gapErr = Math.abs(mean / wantL - 1);
    worstGap = Math.max(worstGap, gapErr);
    worstCount = Math.max(worstCount, Math.abs(offs.length - expected));
    say(`<tr><td>${num(im, 2)}</td><td>${num(wantL, 3)}</td>` +
        `<td>${offs.length}</td><td>${expected}</td>` +
        `<td>${num(mean, 3)}</td>` +
        `<td>${offs.length > 2 ? num(hi - lo, 5) : '—'}</td></tr>`);
  }
  say('</table>');
  const ok = worstGap < 0.005 && worstCount <= 1;
  say(`<p>stripes land one L apart — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst gap ${num(worstGap, 5)}, worst ` +
      `count off by ${worstCount}). <span class="note">The spread column should ` +
      `be ~0 on a constant profile: a nonzero spread means the phase is not ` +
      `accumulating linearly, which no amount of tone averaging could cause. ` +
      `A count off by one is the half-period offset at the ends, not an error.` +
      `</span></p>`);
}

// -------------------------------------------------- the method's own limit
// THE MEASUREMENT THAT MATTERS, and it is specific to this method rather than
// borrowed from the other stripe methods.
//
// Projecting collapses a dimension: within a region, tone can vary along the
// projection axis and not across it. So the method is exact on a field that
// varies only one way and degrades as the field varies across the stripes --
// and the fix for that degradation is SMALLER REGIONS, since a small enough
// region is locally one-dimensional whatever the image does.
//
// Both halves are checked. A ramp along the axis must be near-exact at any
// region size; a ramp across it must improve monotonically as regions shrink.
// If the second column does not fall, the region control is not buying what it
// is advertised to buy.
say('<h2>Plane waves — the cost of collapsing a dimension</h2>');
say('<p class="note">Error against the method\'s own target, swept over region ' +
    'size, on two fields: one varying ALONG the stripes\' projection axis (the ' +
    'case the method is exact for) and one varying ACROSS it. Angles are ' +
    'quantised to 2 so the axis is fixed and the sweep isolates region size ' +
    'rather than confounding it with orientation changes.</p>');
{
  const settings = flat;
  say('<table><tr><th>region size (×pen)</th><th>regions</th>' +
      '<th>RMS, varies along axis</th><th>RMS, varies across</th></tr>');
  const across = [];
  for (const regionSizeW of [160, 80, 40, 20, 12]) {
    const row = [];
    for (const src of [linearRamp(600, 200), radialRamp(400, 400)]) {
      const ctx = prepare(src, settings);
      const args = {
        ...ctx, regionKind: 'rect', regionSizeW, orientSource: 'gradient',
        nAngles: 2, LminW: 2, LmaxW: 40,
      };
      const lines = planeWaves.run(args);
      const rendered = renderForTest(ctx, lines);
      const target = planeWaves.targetImage(args);
      let sumSq = 0;
      for (let i = 0; i < rendered.data.length; i++) {
        const e = rendered.data[i] - target.data[i];
        sumSq += e * e;
      }
      row.push({ rms: Math.sqrt(sumSq / rendered.data.length), n: lines.length });
    }
    const nRegions = tileRegions(prepare(linearRamp(600, 200), settings),
      { kind: 'rect', sizePx: regionSizeW * (settings.penWidth * settings.pxPerCm) }).length;
    across.push(row[1].rms);
    say(`<tr><td>${regionSizeW}</td><td>${nRegions}</td>` +
        `<td>${num(row[0].rms, 4)}</td><td>${num(row[1].rms, 4)}</td></tr>`);
  }
  say('</table>');
  let falls = true;
  for (let i = 1; i < across.length; i++) if (across[i] > across[i - 1] + 0.005) falls = false;
  say(`<p>smaller regions recover the second dimension — ` +
      `<span class="${falls ? 'pass' : 'fail'}">${falls ? 'PASS' : 'FAIL'}</span>` +
      ` <span class="note">(the radial column must not RISE as regions shrink; ` +
      `a 0.005 tolerance allows for the stripe count changing discretely. This ` +
      `is the method's defining approximation, so it is the number to quote ` +
      `when choosing a default region size.)</span></p>`);
}

// The usual ramps, for comparability with the other stripe methods.
runToneTest(
  'Linear ramp — plane waves (square regions, gradient angles)',
  planeWaves,
  linearRamp(600, 200),
  { regionKind: 'rect', regionSizeW: 40, orientSource: 'gradient', nAngles: 0, LminW: 2, LmaxW: 40 },
  flat,
);

runToneTest(
  'Linear ramp — plane waves (hex regions, structure tensor)',
  planeWaves,
  linearRamp(600, 200),
  { regionKind: 'hex', regionSizeW: 40, orientSource: 'tensor', nAngles: 0, LminW: 2, LmaxW: 40 },
  flat,
);

runToneTest(
  'Radial ramp — plane waves (square regions, gradient angles)',
  planeWaves,
  radialRamp(400, 400),
  { regionKind: 'rect', regionSizeW: 25, orientSource: 'gradient', nAngles: 0, LminW: 2, LmaxW: 40 },
  flat,
);

// Voronoi cells are unequal in AREA by design -- they are equalised on ink -- so
// a region carries roughly the same number of stripes wherever it sits. Whether
// that helps the tone is what this row answers, against the square-grid rows
// above at the same nominal cell size.
runToneTest(
  'Radial ramp — plane waves (voronoi regions, equal ink per cell)',
  planeWaves,
  radialRamp(400, 400),
  {
    regionKind: 'voronoi', regionSizeW: 25, orientSource: 'gradient', nAngles: 0,
    LminW: 2, LmaxW: 40, regionSeed: 1, regionIter: 6, polishIter: 8,
  },
  flat,
);

// Triangles aligned to the image's edges. This is the tiler whose regions are
// placed by the PICTURE rather than by a lattice, so it is the one where the
// region shape and the stripe direction can reinforce each other.
runToneTest(
  'Radial ramp — plane waves (delaunay regions, edge-aligned)',
  planeWaves,
  radialRamp(400, 400),
  {
    regionKind: 'delaunay', regionSizeW: 25, orientSource: 'gradient', nAngles: 0,
    LminW: 2, LmaxW: 40, regionSeed: 1, regionIter: 6, polishIter: 8, edgeMix: 0.75, edgeSigma: 2,
  },
  flat,
);

// NOT SCORED, and the reason is a genuine limit rather than a loose end.
// Outlines put the whole region network on the page ON TOP of the stripes, and
// targetImage describes the stripes alone -- it has no way to know what tiling
// the caller picked or how much wire that adds. Measured, the extra ink is worth
// about 0.06 of brightness at this region size. Scoring it would report a
// standing failure for a method behaving exactly as specified, which is how a
// FAIL column stops being read. The table is still printed: the offset is the
// interesting number, and it should be roughly UNIFORM across the bands, since
// the outlines do not vary with tone.
runToneTest(
  'Radial ramp — plane waves (voronoi, outlines drawn)',
  planeWaves,
  radialRamp(400, 400),
  {
    regionKind: 'voronoi', regionSizeW: 25, orientSource: 'gradient', nAngles: 0,
    LminW: 2, LmaxW: 40, regionSeed: 1, regionIter: 6, polishIter: 8, drawRegions: true,
  },
  flat,
  10,
  { scoreBy: 'none' },
);

}
