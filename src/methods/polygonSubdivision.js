// Port of singleWidthLines/code/regionsPolygonSubdivision.m
// Header: "Well calibrated when the line is thin."
//
// Halftoning by cutting. A polygon is split repeatedly, and the cuts themselves
// are the drawing. Two tests drive it, and both are ratios of ink to darkness
// rather than tuned constants:
//
//   stop if  P*w/2 > B      the perimeter alone already lays down more ink than
//                           the darkness calls for (half, because every edge is
//                           shared with a neighbour)
//
//   cut at   argmin |B_A/P_A - B_B/P_B|      equalise darkness-per-perimeter
//                                            between the two halves
//
//   keep it only if that brings (B_A/P_A + B_B/P_B)/2 closer to that rate than
//   the undivided polygon's B/P -- otherwise the split makes matters worse.
//
// That is why it is calibrated: added ink tracks the image automatically.
//
// THE "WHEN THE LINE IS THIN" CAVEAT IS NOW PAID FOR RATHER THAN NOTED. `P*w/2`
// counts each edge's stroke separately, and edges that meet SHARE PAPER, so at
// the densities this method's own default reaches the model believed it had laid
// far more ink than the page received -- it therefore stopped splitting early and
// the drawing came out light, by 0.225 in the darkest band of a ramp.
//
// Measured against the drawn geometry at three supersample factors, the shortfall
// was flat in the factor (0.787, 0.783, 0.784 on a dark field), which rules out
// the renderer's sampling and leaves the geometry.
//
// The excess is ONE PEN SQUARED PER EDGE, which is a derivation and not a fit:
// two strokes of width w crossing at a vertex share w^2 of paper, half of that is
// charged to each edge, and an edge has two ends. Measured across a range of
// densities it came out at 0.99, 0.95 and 0.91 w^2 per edge -- constant, as a
// per-VERTEX effect must be, where a per-length or per-area error could not be.
//
// So a polygon with V vertices is charged `P*w/2 - V*w^2/2`, and per unit
// perimeter that is
//
//     rate = (w/2) * (1 - w/Lbar),    Lbar = P/V, the mean edge length
//
// which is w/2 for long edges and falls away as the edges approach the pen --
// exactly the regime the source's header was warning about.

import { polygonMask, insideIndices, whitenOutside } from '../spine/mask.js';
import { COINCIDENT_PENS } from '../spine/pathOptimizer.js';
import { cloneImage } from '../shim/image.js';
import { structureTensorField, meanOrientation } from '../spine/field.js';
import {
  polyPerimeter, polyArea, polyCentroid, subdividePoly, principalAxis,
} from '../spine/polygon.js';

/**
 * Ink a polygon's share of its own boundary actually lays, per unit perimeter.
 *
 * `w/2` is the thin-line answer: half a stroke of width w, the other half
 * belonging to the neighbour across the edge. The correction is the paper shared
 * at the VERTICES -- w^2 per edge, halved because the edge is shared -- which
 * starts to matter once edges come within a few pen widths of each other. See the
 * module header for the derivation and the measurement behind it.
 *
 * CLAMPED, because the derivation is first-order. At `Lbar = w` the formula
 * reaches zero and below it would go negative, which would claim a polygon lays
 * no ink at all and stop the recursion for entirely the wrong reason. Polygons
 * that small are already solid; the floor keeps the rate positive so the ordinary
 * "enough ink already" test is what stops them.
 */
function inkRate(P, V, w) {
  const shared = P > 0 ? (V * w) / P : 1;          // w / mean edge length
  return (w / 2) * Math.max(0.1, 1 - shared);
}

export const id = 'polygonSubdivision';
export const label = 'Polygon subdivision';

/**
 * Every cut is a separate mark, so only an exactly shared endpoint may join.
 *
 * `run` emits one two-point segment per cut, and two cut ends are never the two
 * ends of one interrupted stroke: each chord belongs to a different polygon. At
 * the pipeline's default of 1.5 pen widths, `joinCoincidentLines` chains two
 * merely-NEARBY ends into one path — and it appends the next path from its SECOND
 * point, so the pen is walked straight from one cut's end to the middle of the
 * next, drawing a bridge at whatever angle lies between them and dropping the
 * point it skipped.
 *
 * This construction manufactures near-misses. A child's cut ends on the edge its
 * parent's cut created, so cut ends land on other cuts constantly, and two
 * siblings routinely finish a fraction of a pen width apart on their shared edge.
 * The bridges get commoner as the recursion deepens.
 *
 * Under 'Follow the field' every cut has its own angle and a stray bridge is
 * invisible among them. Quantised, every legitimate line lies on a handful of
 * directions and the bridge is the one stroke that does not — which is what a
 * tilted line in a quantised drawing actually is.
 *
 * At `COINCIDENT_PENS` two cuts still join where they genuinely meet, which costs
 * nothing: the bridge has zero length and both segments are drawn in full.
 */
export function maxJoinPens() {
  return COINCIDENT_PENS;
}

export const params = [
  { key: 'nIterMax', label: 'Max splits', type: 'range', min: 1, max: 20, step: 1, def: 13 },
  // The label is half the value, which is the label being right rather than the
  // value being wrong. `nAngles` is a step of 2*pi/n, but a cut is an
  // ORIENTATION and has no far end, so n steps round a full turn land on only
  // n/2 distinct cut directions: 8 gives 0, 45, 90, 135 and nothing else. The
  // labels count the directions you actually get.
  //
  // Do not "correct" the values to match. Changing the step to pi/n would move
  // every quantised drawing; `planeWaves.quantise` uses that form already, so
  // between the two methods the VALUES differ and the labels agree, which is the
  // way round that matters to whoever is reading the menu.
  {
    key: 'nAngles', label: 'Cut angles', type: 'select', def: 0,
    options: [
      { value: 0, label: 'Follow the field' },
      { value: 4, label: 'Quantise to 2' },
      { value: 6, label: 'Quantise to 3' },
      { value: 8, label: 'Quantise to 4' },
      { value: 12, label: 'Quantise to 6' },
    ],
  },
  { key: 'drawOutline', label: 'Draw region outline', type: 'checkbox', def: false,
    when: () => false },
];

const N_SWEEP = 30;

export function run(ctx) {
  const { nx, ny, w, polygon } = ctx;
  const nIterMax = Math.max(1, Math.round(ctx.nIterMax ?? 13));
  const nAngles = Math.round(ctx.nAngles ?? 0);

  // whiten outside the region so its darkness never asks for cuts
  const mask = polygonMask(nx, ny, polygon.px, polygon.py);
  const im = whitenOutside(cloneImage(ctx.im), mask);

  const field = structureTensorField(im, Math.max(1, w), Math.max(1.5, w * 2));

  // Each polygon carries the pixels inside it, as indices. The MATLAB jitters
  // the sample coordinates to keep cuts off exact vertices; the same jitter is
  // applied here when a pixel's position is used.
  const jitter = 1e-5;
  const pxOf = (i) => (i % nx) + 1 + ((i * 2654435761) % 1000) / 1000 * jitter;
  const pyOf = (i) => Math.floor(i / nx) + 1;

  // The same mask again, which is why it is cached: otherwise a second full
  // inpolygon scan of the raster.
  const rootIdx = Array.from(insideIndices(nx, ny, polygon.px, polygon.py));

  const lines = [];
  if (ctx.drawOutline) {
    const ring = polygon.px.map((v, i) => [v, polygon.py[i]]);
    ring.push([polygon.px[0], polygon.py[0]]);
    lines.push(ring);
  }

  const L = nx + ny;               // long enough for the cut line to span
  let polys = [{
    px: polygon.px.slice(), py: polygon.py.slice(), idx: Int32Array.from(rootIdx),
  }];

  for (let iter = 0; iter < nIterMax && polys.length > 0; iter++) {
    const next = [];
    for (const poly of polys) {
      const { px, py, idx } = poly;
      if (idx.length < 4) continue;

      const P = polyPerimeter(px, py);
      if (polyArea(px, py) <= 0) continue;

      let B = 0;
      for (let k = 0; k < idx.length; k++) B += 1 - im.data[idx[k]];
      const rate = inkRate(P, px.length, w);
      if (P * rate > B) continue;                    // enough ink already

      // --- choose the cut direction
      const xs = new Float64Array(idx.length), ys = new Float64Array(idx.length);
      const angles = new Float64Array(idx.length);
      for (let k = 0; k < idx.length; k++) {
        xs[k] = pxOf(idx[k]);
        ys[k] = pyOf(idx[k]);
        angles[k] = field.theta[idx[k]];
      }
      const longAxis = principalAxis(xs, ys, idx.length);
      let t = meanOrientation(angles);
      let cand = [t, t + Math.PI / 2];
      if (nAngles > 0) {
        const q = (a) => Math.round((a * nAngles) / (2 * Math.PI)) * ((2 * Math.PI) / nAngles);
        cand = [q(cand[0]), q(cand[1])];
      }
      // cut across the long axis -- that is what keeps the pieces roughly square
      const dot = (a) => Math.abs(Math.cos(a) * Math.cos(longAxis) + Math.sin(a) * Math.sin(longAxis));
      t = dot(cand[0]) <= dot(cand[1]) ? cand[0] : cand[1];

      // --- sweep candidate cut positions along the cut normal
      const nxv = -Math.sin(t), nyv = Math.cos(t);
      let cLo = Infinity, cHi = -Infinity, iLo = 0, iHi = 0;
      for (let i = 0; i < px.length; i++) {
        const c = nxv * px[i] + nyv * py[i];
        if (c < cLo) { cLo = c; iLo = i; }
        if (c > cHi) { cHi = c; iHi = i; }
      }

      // cumulative darkness along the SAME axis the cut sweeps along.
      // (The MATLAB projects onto x*cos(t) - y*sin(t), which is neither the cut
      // direction nor its normal -- a sign slip, so its darkness split is
      // measured on the wrong axis. Corrected here.)
      const order = Array.from(idx.keys()).sort(
        (a, b) => (nxv * xs[a] + nyv * ys[a]) - (nxv * xs[b] + nyv * ys[b]),
      );
      const projSorted = new Float64Array(order.length);
      const cumDark = new Float64Array(order.length + 1);
      for (let k = 0; k < order.length; k++) {
        const j = order[k];
        projSorted[k] = nxv * xs[j] + nyv * ys[j];
        cumDark[k + 1] = cumDark[k] + (1 - im.data[idx[j]]);
      }
      const darkBelow = (c) => {
        let lo = 0, hi = projSorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (projSorted[mid] < c) lo = mid + 1; else hi = mid;
        }
        return cumDark[lo];
      };

      let best = null;
      for (let s = 1; s <= N_SWEEP; s++) {
        const f = s / (N_SWEEP + 1);
        const x0 = px[iLo] + f * (px[iHi] - px[iLo]);
        const y0 = py[iLo] + f * (py[iHi] - py[iLo]);
        const cut = subdividePoly(px, py, x0, y0, t, L);
        if (!cut) continue;

        const cAt = nxv * x0 + nyv * y0;
        const below = darkBelow(cAt);
        const PA = polyPerimeter(cut.A.px, cut.A.py);
        const PB = polyPerimeter(cut.B.px, cut.B.py);
        if (PA <= 0 || PB <= 0) continue;

        // which half is on which side -- A/B come from vertex order, not geometry
        const ca = polyCentroid(cut.A.px, cut.A.py);
        const aIsBelow = nxv * ca[0] + nyv * ca[1] < cAt;
        const BA = aIsBelow ? below : B - below;
        const BB = B - BA;

        const score = Math.abs(BB / PB - BA / PA);
        if (!best || score < best.score) {
          best = { score, cut, PA, PB, BA, BB, aIsBelow, cAt };
        }
      }
      if (!best) continue;

      // --- keep the split only if it improves the ink-to-darkness match
      //
      // AGAINST w/2, DELIBERATELY, even though the stop rule above now uses the
      // corrected rate. The two tests ask different questions. The stop rule is
      // absolute -- "have I already laid the ink this darkness wants" -- and must
      // use the ink that actually reaches the paper. This one is a COMPARISON
      // between a polygon and the two halves it would become, and its job is to
      // reject a split that makes the match worse.
      //
      // Feeding it the corrected rate as well was measured and was wrong: the
      // rate falls as edges shorten, so every split lowered the bar it was being
      // judged against, and the recursion ran to the depth cap. Both the black
      // and the quarter-grey field hit 8191 strokes -- 2^13 - 1, a complete
      // subdivision -- and the midtones came out 0.16 too DARK where they had
      // been too light. One correction, one place.
      const mixed = (best.BB / best.PB + best.BA / best.PA) / 2;
      if (Math.abs(w / 2 - mixed) > Math.abs(w / 2 - B / P)) continue;

      lines.push(best.cut.seg);

      // hand each half its own pixels, by side of the cut
      const aIdx = [], bIdx = [];
      for (let k = 0; k < idx.length; k++) {
        const below = nxv * xs[k] + nyv * ys[k] < best.cAt;
        (below === best.aIsBelow ? aIdx : bIdx).push(idx[k]);
      }
      next.push({ px: best.cut.A.px, py: best.cut.A.py, idx: Int32Array.from(aIdx) });
      next.push({ px: best.cut.B.px, py: best.cut.B.py, idx: Int32Array.from(bIdx) });
    }
    polys = next;
  }

  return lines;
}

export default { id, label, params, run, maxJoinPens };
