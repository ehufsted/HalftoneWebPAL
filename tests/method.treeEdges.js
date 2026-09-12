// New with the spanning-tree port; not sliced from the pre-split harness.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength, trimLineSegsToPolygon } from '../src/spine/geometry.js';
import { stipplePoints, perimeterPoints } from '../src/spine/points.js';
import { voronoiCells, regionEdges } from '../src/spine/regions.js';
import { triangulate } from '../src/spine/delaunay.js';
import treeEdges, {
  TREE_TONE, TREE_KAPPA, ANISO_COST, spanningForest, treePaths,
} from '../src/methods/treeEdges.js';
import { MESH_TONE } from '../src/methods/meshEdges.js';
import {
  say, num, flat, linearRamp, radialRamp, runToneTest,
} from './runner.js';

const small = { ...flat, drawingWidth: 5 };

export function run() {

// ------------------------------------------- which of these ratios is real
// ONE OF THE THREE IS AN IDENTITY AND TWO ARE NOT, which is not what this
// section first claimed. The tempting statement over one point set is
//
//     MST : Voronoi : Delaunay  =  1 : sqrt3 : 3
//
// Voronoi to Delaunay holds, because both keep EVERY edge and their totals are
// therefore means over the whole edge-length distribution. Measured, within 1%.
//
// The two MST ratios do not hold, and not by a little: MST/Delaunay reads 0.254
// against 0.333, steady across a fivefold range of point count. The tree keeps
// the SHORTEST third of the Delaunay's edges, and the mean of the lowest third of
// a distribution is well below the mean of all of it. On a perfect lattice the
// two coincide; on any real point set they do not, and the gap does not shrink
// with n because it is an order statistic rather than a lattice imperfection.
//
// So Vor/Del is scored and the MST columns are reported. The next section takes
// them apart.
say('<h2>Tree — which of the three ratios is actually an identity?</h2>');
say('<p class="note">One relaxed point set, three networks, measured on an ' +
    'interior window so no boundary effect reaches any of them. Only ' +
    '<b>Vor/Del</b> is scored: it is the one whose two networks both keep every ' +
    'edge. The MST columns are here to be read, and the section after this one ' +
    'explains why they sit below their lattice bound.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const uniform = new Float64Array(ctx.nx * ctx.ny).fill(1);
  say('<table><tr><th>points</th><th>window pts</th><th>MST</th><th>Voronoi</th>' +
      '<th>Delaunay</th><th>MST/Del</th><th>1/3</th>' +
      '<th>MST/Vor</th><th>1/√3</th><th>Vor/Del</th><th>1/√3</th></tr>');
  const errs = [];
  for (const nPts of [300, 700, 1400]) {
    // A RING, AND AN INTERIOR WINDOW, and the first version of this table had
    // neither. Two of the three networks need a bounded neighbourhood to be
    // well-formed: without a ring the outermost Voronoi cells are unbounded and
    // get clipped to the page, contributing very long peripheral edges, and the
    // Delaunay gains long thin hull triangles. Measured ringless, the Delaunay
    // ran 11.6% over its own prediction against 2-3% in the mesh section, and
    // Voronoi/Delaunay read 1.896 where the same identity passes at 1.732 there.
    //
    // The MST is immune -- it selects short edges -- so BOTH ratios came out low
    // and it looked as though the tree were at fault. It was not: the tree was
    // being compared against two inflated networks.
    //
    // Windowing fixes all three at once and needs no ring-versus-no-ring
    // argument: whatever the boundary does, it is not inside the window.
    const ring = perimeterPoints(ctx, uniform, nPts);
    const { sx, sy } = stipplePoints(ctx, {
      field: uniform, count: nPts, seeds0: ring, seed: 1, iterations: 6, polish: 12,
    });
    const n = sx.length;
    const area = (ctx.nx - 1) * (ctx.ny - 1);
    const d = Math.sqrt(1.1547 / (n / area));
    const inset = Math.min(ctx.nx / 3, 3 * d);
    const wx0 = 1 + inset, wy0 = 1 + inset;
    const wx1 = ctx.nx - inset, wy1 = ctx.ny - inset;
    const winPx = [wx0, wx1, wx1, wx0], winPy = [wy0, wy0, wy1, wy1];
    const clipLen = (segs) => pathLength(
      trimLineSegsToPolygon(segs, winPx, winPy).map((s) => [[s[0], s[1]], [s[2], s[3]]]),
    );

    const { tris, n: nT } = triangulate(sx, sy);
    const { edges } = spanningForest(sx, sy, tris, nT,
      (u, v) => Math.hypot(sx[u] - sx[v], sy[u] - sy[v]), null);
    const mstSegs = [];
    for (let i = 0; i < edges.length; i += 2) {
      mstSegs.push([sx[edges[i]], sy[edges[i]], sx[edges[i + 1]], sy[edges[i + 1]]]);
    }
    const mstL = clipLen(mstSegs);

    const seen = new Set();
    const delSegs = [];
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const u = tris[3 * t + k], v = tris[3 * t + ((k + 1) % 3)];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (seen.has(key)) continue;
        seen.add(key);
        delSegs.push([sx[u], sy[u], sx[v], sy[v]]);
      }
    }
    const delL = clipLen(delSegs);

    const vCells = voronoiCells(ctx, sx, sy, n).filter(Boolean);
    const vorSegs = regionEdges(vCells, { skipBoundary: ctx.polygon })
      .map((e) => [e[0][0], e[0][1], e[1][0], e[1][1]]);
    const vorL = clipLen(vorSegs);

    const winPts = Math.round((((wx1 - wx0) * (wy1 - wy0)) * 1.1547) / (d * d));
    const rDel = mstL / delL, rVor = mstL / vorL, rVD = vorL / delL;
    // The identity that actually holds is Voronoi to Delaunay -- both keep every
    // edge. The MST ratio is scored nowhere; it is decomposed below instead.
    errs.push(Math.abs(rVD / (1 / Math.sqrt(3)) - 1));
    say(`<tr><td>${n}</td><td>${winPts}</td><td>${num(mstL, 1)}</td>` +
        `<td>${num(vorL, 1)}</td><td>${num(delL, 1)}</td>` +
        `<td>${num(rDel, 4)}</td><td>0.3333</td>` +
        `<td>${num(rVor, 4)}</td><td>0.5774</td>` +
        `<td>${num(rVD, 4)}</td><td>0.5774</td></tr>`);
  }
  say('</table>');
  const last = errs[errs.length - 1];
  const ok = last < 0.03;
  say(`<p>Voronoi is √3 of the Delaunay — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (densest row ${num(last, 4)} off). ` +
      `<span class="note"><b>That is the identity, and it is the only one of the ` +
      `three columns scored.</b> Both those networks keep EVERY edge, so their ` +
      `totals are means over the whole edge-length distribution and stay near ` +
      `the lattice value. The MST columns are reported, not asserted: an earlier ` +
      `version demanded 1/3 of them and failed at 0.254, and the reason it ` +
      `failed is the next table rather than anything wrong here — the tree does ` +
      `not keep every edge, it keeps the SHORTEST THIRD, and the mean of the ` +
      `lowest third of a distribution is not the mean of the distribution.` +
      `</span></p>`);
}

// ------------------------------------- why the MST is not a third, exactly
// A DECOMPOSITION, NOT A VERDICT. The tree takes n-1 of the Delaunay's 3n edges
// and it takes them from the bottom of the length distribution, so its share of
// the total length is below its share of the count. That gap is the whole of
// TREE_KAPPA, and it splits cleanly into two parts that can each be measured:
//
//   order statistic     mean of the shortest n-1 edges, over the mean of all
//   connectivity premium  how much longer the MST is than just taking those,
//                         because a tree must connect and cannot simply keep
//                         the n-1 cheapest edges in the graph
//
// Their product is MST/Delaunay times 3. Reporting both says WHICH of them a
// future change moved -- a different point placer shifts the first, a different
// spanning rule shifts the second.
say('<h2>Tree — the shortfall, split into its two causes</h2>');
say('<p class="note">The MST keeps a third of the Delaunay\'s edges but far ' +
    'less than a third of its length. This is where that goes. The two factors ' +
    'multiply to <i>3 × MST/Delaunay</i>, so they account for the ratio exactly ' +
    'rather than approximately.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const uniform = new Float64Array(ctx.nx * ctx.ny).fill(1);
  say('<table><tr><th>points</th><th>Delaunay edges</th><th>edge length CV</th>' +
      '<th>order statistic</th><th>connectivity premium</th>' +
      '<th>product</th><th>3 × MST/Del</th></tr>');
  for (const nPts of [400, 1200]) {
    const { sx, sy } = stipplePoints(ctx, {
      field: uniform, count: nPts, seed: 1, iterations: 6,
    });
    const { tris, n: nT } = triangulate(sx, sy);
    const seen = new Set();
    const lens = [];
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const u = tris[3 * t + k], v = tris[3 * t + ((k + 1) % 3)];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lens.push(Math.hypot(sx[u] - sx[v], sy[u] - sy[v]));
      }
    }
    const meanAll = lens.reduce((s, v) => s + v, 0) / lens.length;
    let varSum = 0;
    for (const L of lens) varSum += (L - meanAll) ** 2;
    const cv = Math.sqrt(varSum / lens.length) / meanAll;

    const { edges } = spanningForest(sx, sy, tris, nT,
      (u, v) => Math.hypot(sx[u] - sx[v], sy[u] - sy[v]), null);
    const nTree = edges.length / 2;
    let mstL = 0;
    for (let i = 0; i < edges.length; i += 2) {
      mstL += Math.hypot(sx[edges[i]] - sx[edges[i + 1]], sy[edges[i]] - sy[edges[i + 1]]);
    }
    // the shortest nTree edges, ignoring whether they form a tree at all
    const sorted = lens.slice().sort((a, b) => a - b);
    const cheapest = sorted.slice(0, nTree).reduce((s, v) => s + v, 0);

    const orderStat = (cheapest / nTree) / meanAll;
    const premium = mstL / cheapest;
    const delL = lens.reduce((s, v) => s + v, 0);
    say(`<tr><td>${sx.length}</td><td>${lens.length}</td><td>${num(cv, 3)}</td>` +
        `<td>${num(orderStat, 4)}</td><td>${num(premium, 4)}</td>` +
        `<td>${num(orderStat * premium * (nTree / lens.length) * 3, 4)}</td>` +
        `<td>${num(3 * mstL / delL, 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">No verdict — this explains a constant rather than ' +
      'checking one. The <b>CV</b> column is the underlying fact: a coefficient ' +
      'of variation near 0.22 in the Delaunay edge lengths is what makes the ' +
      'lowest third average about 0.76 of the whole, and on a perfect lattice it ' +
      'would be 0 and the ratio would be exactly 1/3. The <b>premium</b> is ' +
      'above 1 by construction — a tree cannot simply take the cheapest edges, ' +
      'it has to connect — and a premium near 1 would mean the point set is so ' +
      'regular that connectivity costs nothing.</p>');
}

// -------------------------------------- does the drawing contain the tree?
// THE CHECK THAT WAS MISSING, and the bug it now catches was found by eye
// instead. treePaths cuts the tree into polylines for the plotter, and the first
// version started each branch path AT THE CHILD rather than at the parent -- so
// the edge joining a branch to its trunk was in no path and never drawn. The
// decomposition makes one path per leaf, so it silently dropped `leaves - 1` of
// the `n - 1` edges: about a quarter of a planar MST, and every one of them a
// branch. The drawing came out as disconnected polylines with no visible
// branching at all.
//
// Total drawn length against the sum of the tree's own edge lengths is exact
// arithmetic and catches it immediately. Edge COUNT alone would not: a path of k
// points contributes k-1 segments however it was assembled, so a decomposition
// that loses edges still looks self-consistent from inside.
say('<h2>Tree — does the decomposition draw every edge, exactly once?</h2>');
say('<p class="note">The polylines handed to the plotter must contain the whole ' +
    'tree and no more of it. Short means edges were dropped when the tree was ' +
    'cut into strokes; long means one was drawn twice. Exact arithmetic — the ' +
    'two quantities are sums of the same segment lengths.</p>');
{
  const ctx = prepare(radialRamp(300, 300), small);
  const uniform = new Float64Array(ctx.nx * ctx.ny).fill(1);
  say('<table><tr><th>points</th><th>tree edges</th><th>strokes</th>' +
      '<th>segments drawn</th><th>Σ edge length</th><th>Σ drawn length</th>' +
      '<th>ratio</th></tr>');
  let worst = 0;
  for (const nPts of [200, 800]) {
    const { sx, sy } = stipplePoints(ctx, {
      field: uniform, count: nPts, seed: 1, iterations: 6,
    });
    const { tris, n: nT } = triangulate(sx, sy);
    const { edges } = spanningForest(sx, sy, tris, nT,
      (u, v) => Math.hypot(sx[u] - sx[v], sy[u] - sy[v]), null);
    let treeL = 0;
    for (let i = 0; i < edges.length; i += 2) {
      treeL += Math.hypot(sx[edges[i]] - sx[edges[i + 1]], sy[edges[i]] - sy[edges[i + 1]]);
    }
    // the decomposition applied to THAT tree, so the two sides are the same
    // segments summed two ways rather than two independent computations
    const paths = treePaths(sx, sy, edges, sx.length, (members) => members[0]);
    const drawnL = pathLength(paths);
    let segs = 0;
    for (const p of paths) segs += p.length - 1;
    const ratio = treeL > 0 ? drawnL / treeL : 0;
    worst = Math.max(worst, Math.abs(ratio - 1));
    say(`<tr><td>${sx.length}</td><td>${edges.length / 2}</td>` +
        `<td>${paths.length}</td>` +
        `<td class="${segs === edges.length / 2 ? 'pass' : 'fail'}">${segs}</td>` +
        `<td>${num(treeL, 2)}</td>` +
        `<td>${num(drawnL, 2)}</td><td>${num(ratio, 8)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 1e-9;
  say(`<p>every edge drawn exactly once — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 10)}). ` +
      `<span class="note">A ratio near 0.75 is the signature of the branch bug: ` +
      `one lost edge per leaf. Near 2 would mean the walk is revisiting.` +
      `</span></p>`);
}

// ------------------------------------------------------ length per unit area
// C is derived at 2/sqrt3 for a lattice; TREE_KAPPA is the measured amount by
// which a relaxed set falls SHORT of it. That sign is the prediction: the mesh
// methods measured +4% because a relaxed network wanders, and a tree should
// measure negative because it selects among the short edges instead.
say('<h2>Tree — length per unit area against C/d</h2>');
say('<p class="note">On the polylines, before rendering. Effective C is ' +
    '<i>measured length × spacing</i>; paste it back into TREE_KAPPA as ' +
    'effC / 1.1547. A value ABOVE 1.1547 would falsify the argument that a tree ' +
    'is shorter than the lattice ideal, not merely refine the number.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const uniform = new Float64Array(ctx.nx * ctx.ny).fill(1);
  const area = (ctx.nx - 1) * (ctx.ny - 1);
  const tsv = ['nPts\td\tpredLen\tmeasLen\tratio\teffC\tkappa'];
  say('<table><tr><th>points</th><th>spacing d</th><th>predicted C/d</th>' +
      '<th>measured</th><th>ratio</th><th>effective C</th>' +
      '<th>implied κ</th></tr>');
  for (const nPts of [200, 500, 1000, 2000]) {
    const { sx, sy } = stipplePoints(ctx, {
      field: uniform, count: nPts, seed: 1, iterations: 6,
    });
    const n = sx.length;
    const { tris, n: nT } = triangulate(sx, sy);
    const { edges } = spanningForest(sx, sy, tris, nT,
      (u, v) => Math.hypot(sx[u] - sx[v], sy[u] - sy[v]), null);
    let L = 0;
    for (let i = 0; i < edges.length; i += 2) {
      L += Math.hypot(sx[edges[i]] - sx[edges[i + 1]], sy[edges[i]] - sy[edges[i + 1]]);
    }
    const d = Math.sqrt(1.1547 / (n / area));
    const pred = TREE_TONE.C / d;
    const meas = L / area;
    const effC = meas * d;
    say(`<tr><td>${n}</td><td>${num(d, 2)}</td><td>${num(pred, 5)}</td>` +
        `<td>${num(meas, 5)}</td><td>${num(meas / pred, 4)}</td>` +
        `<td>${num(effC, 4)}</td><td>${num(effC / TREE_TONE.C, 4)}</td></tr>`);
    tsv.push([n, num(d, 2), num(pred, 5), num(meas, 5), num(meas / pred, 4),
              num(effC, 4), num(effC / TREE_TONE.C, 4)].join('\t'));
  }
  say('</table>');
  say(`<p class="note">Shipping TREE_KAPPA = ${TREE_KAPPA}. No verdict here — ` +
      `this table sets the constant rather than checking it, and the sign is ` +
      `what was predicted. Compare MESH_TONE's κ of 1.04, measured on the same ` +
      `point sets for networks that keep every edge.</p>`);
  say(`<pre id="treeLengthTSV">${tsv.join('\n')}</pre>`);
}

// ------------------------------------------------------------- anisotropy
// ANISOTROPY IS A LOOK CONTROL THAT ALSO MOVES THE TONE, and pretending
// otherwise would put a slider in the UI that silently breaks the calibration.
//
// The tree still has n-1 edges whatever the metric, but an anisotropic metric
// makes it choose edges that are cheap in that metric and therefore LONGER in
// pixels. So drawn length rises with |a| while the tone model, which knows only
// about d, does not move. This table is how much.
say('<h2>Tree — what anisotropy costs the tone</h2>');
say('<p class="note">Edge count is fixed at n−1, so any change here is edge ' +
    'LENGTH: the metric picks edges that are cheap in it and longer on the page. ' +
    'The tone model knows only about spacing, so this whole column is error the ' +
    'drawing carries and the target does not.</p>');
{
  // DENSE ENOUGH TO MEAN SOMETHING. The first version of this table ran at the
  // default spacing on a half-size canvas and got about 110 points, so a
  // "20% length change" rested on a hundred edges. Forcing a tight spacing
  // gives a couple of thousand.
  const ctx = prepare(radialRamp(300, 300), flat);
  const lengths = [];
  say('<table><tr><th>anisotropy</th><th>strokes</th><th>drawn length</th>' +
      '<th>vs isotropic</th></tr>');
  for (const a of [-1, -0.5, -0.25, 0, 0.25, 0.5, 1]) {
    const lines = treeEdges.run({
      ...ctx, anisotropy: a, dMinW: 3, dMaxW: 24, seed: 1, maxPoints: 8000,
    });
    lengths.push({ a, L: pathLength(lines), n: lines.length });
  }
  const base = lengths.find((r) => r.a === 0).L;
  for (const r of lengths) {
    say(`<tr><td>${num(r.a, 2)}</td><td>${r.n}</td><td>${num(r.L, 1)}</td>` +
        `<td>${num(r.L / base, 4)}</td></tr>`);
  }
  say('</table>');
  const worst = Math.max(...lengths.map((r) => Math.abs(r.L / base - 1)));
  // Symmetry is now reported rather than scored, and the ±1 rows are excluded
  // from it: see the note below for why that one point is degenerate.
  const pairs = [[1, 5], [2, 4]];        // ±0.5 and ±0.25
  let asym = 0;
  for (const [i, j] of pairs) {
    asym = Math.max(asym, Math.abs(lengths[i].L - lengths[j].L) / base);
  }
  say(`<p class="note"><b>The ±a rows come out very nearly symmetric once the ` +
      `tree is dense enough</b> — worst mismatch ${num(asym, 4)} across ±0.25 and ` +
      `±0.5. An earlier version scored asymmetry as a FAILURE, and then, when it ` +
      `failed, explained it away as a structural effect of the radial field. ` +
      `Both were wrong: that run had about 110 points and the asymmetry was ` +
      `sparsity. Only ±1 still differs, by about 5%, and that one IS real — the ` +
      `weight 1 − a·cos2φ reaches exactly ZERO for a perfectly aligned edge, so ` +
      `Kruskal is choosing among ties rather than among costs. It is the one ` +
      `degenerate point on the slider.</p>`);
  say(`<p class="note">Worst departure from the isotropic tree: ` +
      `<b>${num(worst, 3)}</b>, against a shipped ANISO_COST of ${ANISO_COST} per ` +
      `unit |a| — so the correction expects about ${num(ANISO_COST, 2)} at the ` +
      `extremes. This table sizes the effect; it does not check the fix, because ` +
      `the correction is applied to the point DENSITY and therefore shows up in ` +
      `the tone rows at the end. If those come out flat across the anisotropy ` +
      `sweep, the coefficient is right for this image.</p>`);
}

// ------------------------------------------------------------- the forest
// Pruning removes ink the tone model counted on, so it lightens the drawing.
// Reported rather than corrected: what fraction goes is the number that decides
// whether it can be left uncorrected.
say('<h2>Tree — what the forest option removes</h2>');
say('<p class="note">Edges longer than a multiple of the LOCAL spacing are cut, ' +
    'which is what stops a tree stringing a stroke across empty paper. The ' +
    'threshold is relative to the local spacing so it means the same thing in a ' +
    'dark region and a pale one.</p>');
{
  const ctx = prepare(radialRamp(300, 300), small);
  say('<table><tr><th>cut above</th><th>strokes</th><th>drawn length</th>' +
      '<th>fraction kept</th></tr>');
  const full = pathLength(treeEdges.run({ ...ctx, prune: false }));
  say(`<tr><td>off</td><td>—</td><td>${num(full, 1)}</td><td>1.0000</td></tr>`);
  for (const p of [6, 4, 3, 2]) {
    const lines = treeEdges.run({ ...ctx, prune: true, pruneAtW: p });
    const L = pathLength(lines);
    say(`<tr><td>${p}×d</td><td>${lines.length}</td><td>${num(L, 1)}</td>` +
        `<td>${num(L / full, 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">No verdict — this is a look control. Read the fraction ' +
      'kept as the tone penalty: at 3×d on a radial ramp it should be small, ' +
      'because a well-relaxed tree has few edges that long, and a threshold that ' +
      'removes a lot is cutting real structure rather than stray connections.</p>');
}

// SCORED UNPRUNED, which is what the tone model describes: TREE_KAPPA counts the
// n-1 edges of a spanning tree, and the forest deliberately drops some of them.
// The app prunes by default and comes out correspondingly light; the sweep above
// is where that cost is measured. Setting `prune: false` here keeps these rows
// about the tone relation rather than about the forest.
runToneTest(
  'Linear ramp — spanning tree',
  treeEdges,
  linearRamp(600, 200),
  { dMinW: 6, dMaxW: 60, anisotropy: 0, seed: 1, maxPoints: 8000, prune: false },
  flat,
);

runToneTest(
  'Radial ramp — spanning tree',
  treeEdges,
  radialRamp(400, 400),
  { dMinW: 6, dMaxW: 60, anisotropy: 0, seed: 1, maxPoints: 8000, prune: false },
  flat,
);

// THE ANISOTROPY CORRECTION IS CHECKED HERE, not in the length table. ANISO_COST
// adjusts the point DENSITY, so its effect appears as tone: if the coefficient is
// right these three rows have the same error as each other, and if it is wrong
// the error grows with |a|.
runToneTest(
  'Radial ramp — spanning tree (following the image, a = 0.5)',
  treeEdges,
  radialRamp(400, 400),
  { dMinW: 6, dMaxW: 60, anisotropy: 0.5, seed: 1, maxPoints: 8000, prune: false },
  flat,
);

runToneTest(
  'Radial ramp — spanning tree (across the image, a = −0.5)',
  treeEdges,
  radialRamp(400, 400),
  { dMinW: 6, dMaxW: 60, anisotropy: -0.5, seed: 1, maxPoints: 8000, prune: false },
  flat,
);

}
