// Port of singleWidthLines/code/fixCirclePackingScan.m
//
// A greedy circle packing built by a single top-to-bottom scan. For each row it
// keeps, per column, the distance to the nearest already-placed circle's
// SURFACE (and to the page edge); wherever that distance reaches the locally
// required radius R, a circle drops in and the row's distances are updated in
// place. No relaxation, no iteration -- one pass.
//
// The tone relation is 1/R linear in brightness, which is what the source's
// radius formula says in disguise:
//
//     R = rMin/(1 - im*(1 - rMin/rMax))   <=>   1/R = 1/rMin + im*(1/rMax - 1/rMin)
//
// An outline of radius r lays 2*pi*r*w of ink into a cell of area pi*r^2/phi,
// where phi is the packing's area fraction, so its coverage is 2*phi*w/R --
// inversely proportional to the radius, NOT to its square. Linear 1/R therefore
// gives linear coverage, and darker means SMALLER circles. That inversion is the
// interesting part of the method and it is easy to misread as a bug.
//
// phi has no closed form. It does not affect the drawing at all -- R(im) is
// computed without it -- only the claim about what tone the drawing achieves,
// which is why it lives in one constant below and is measured by verify.html
// rather than derived.

import { trimLineSegsToPolygon } from '../spine/geometry.js';
import { makeImage } from '../shim/image.js';

export const id = 'circlePacking';
export const label = 'Circle packing';

export const params = [
  // Pen-relative, like every other spacing control here: the tone limits
  // (2*phi*w/r) are only constant in units of the pen width.
  // min 2 is measured, not taste: below 3w the tone ladder starts to bow (the
  // tangency term is sub-linear in 1/R), reaching 0.033 of non-linearity at 2w,
  // and below 2w the outline is closer to a filled blob than a ring.
  { key: 'rMinW', label: 'Min radius', type: 'range', min: 2, max: 5, step: 0.1, def: 3, unit: '×pen' },
  { key: 'rMaxW', label: 'Max radius', type: 'range', min: 3, max: 40, step: 0.5, def: 12, unit: '×pen' },
];

/**
 * Sub-row placement. The MATLAB carries this as `fineTuneY` (line 11), sets it
 * to 1, and then never reads it -- both branches of the `if` at lines 135-145
 * are commented out, so every circle snaps to an integer scanline. At this
 * app's scale a 1 px row quantum is ~20% of the smallest radius, which biases
 * every circle downward and spaces the packing loose, so it is enabled here.
 *
 * SET THIS TO false TO GET THE MATLAB'S BEHAVIOUR BACK. If the packing fraction
 * or the tone sweep ever looks wrong, this is the first thing to try, because
 * it is the one place the port moves geometry the source did not.
 */
const FINE_TUNE_Y = true;

/** MATLAB `cutoffVal`: 0 means circles are placed exactly tangent. */
const CUTOFF = 0;

/**
 * Largest chord error allowed when tessellating a circle, in pen widths.
 *
 * At 0.25 a circle of the minimum radius comes out an octagon — the rule bottoms
 * out on the 8-point floor below — and reads as visibly faceted rather than round.
 * 0.05 puts an 18-gon there and a 35-gon at 12 pen widths.
 *
 * Note the ceiling this runs into: `simplifyAll` re-checks every path against a
 * Visvalingam area of (w/2)^2, which for a circle of radius r admits a step of
 * about (0.5 w^2/r^2)^(1/3) — roughly 16 points at r = 3w. Below that radius the
 * extra points here are trimmed straight back out again, which is correct and is
 * why the floor is not raised further.
 */
const SAGITTA = 0.05;

/** Guard against pathological settings producing millions of circles. */
const CIRCLE_BUDGET = 200000;

const BIG = 1e9;

/**
 * Area fraction of the greedy packing. MEASURED by verify.html on flat fields
 * (the quantity the MATLAB prints at line 199 and never uses): 0.766-0.820
 * across radii from 2w to 12w, i.e. steady, which is what makes 1/R linear in
 * brightness the right ladder. The one outlier, 0.633, is fourteen circles in
 * the whole field and is small-number noise, not a drift.
 *
 * Only toneBand/targetImage depend on it; the geometry does not.
 */
export const PACKING_FRACTION = 0.78;

/**
 * Tangencies per circle. This scan places each circle tangent to exactly ONE
 * existing constraint -- the nearest circle, or the page edge -- so k should sit
 * a little above 1, the excess being circles that happen to land tangent to a
 * second neighbour. 1.25 reproduced the measurement across r/w = 3..6 and is the
 * only free number in the coverage law.
 *
 * verify.html now COUNTS this rather than assuming it. If the counted value
 * disagrees, put the counted one here -- it is an observable, not a fit
 * parameter, which is the whole reason for preferring this form.
 */
export const TANGENCIES_PER_CIRCLE = 1.25;

/**
 * Coverage of a packing of radius-r outlines.
 *
 * The naive law is 2*phi*w/r -- ink 2*pi*r*w into a cell of area pi*r^2/phi --
 * and the measurement showed it over-predicting by 15% at r = 3w, rising to 25%
 * at 2w. The missing term is stroke overlap at the tangencies, and it is
 * derivable rather than fitted:
 *
 *   Two tangent circles osculate, so their centrelines separate as x^2/r. Their
 *   strokes overlap wherever that is under w, i.e. |x| < sqrt(r w), and the
 *   doubled-counted area is the integral of (w - x^2/r), or (4/3) w^1.5 r^0.5
 *   per tangency. Multiply by k tangencies for each of phi*area/(pi r^2)
 *   circles and divide by the naive coverage, and the deficit RATIO is
 *
 *       (2k / 3pi) * sqrt(w/r)
 *
 * Note the consequence for the ladder: the deficit goes as (w/r)^1.5 while the
 * base term goes as w/r, so tone is not exactly linear in 1/R. Measured, the bow
 * is within +-0.006 for rMin >= 3w and reaches 0.033 at rMin = 2w -- which is
 * why the radius slider stops at 2.
 */
export function coverageOf(w, r, phi = PACKING_FRACTION) {
  if (!(r > 0)) return 1;
  const base = (2 * phi * w) / r;
  const keep = 1 - ((2 * TANGENCIES_PER_CIRCLE) / (3 * Math.PI)) * Math.sqrt(w / r);
  return Math.min(1, Math.max(0, base * Math.max(0, keep)));
}

/** Radii in pixels, from the pen-relative params. */
function radiiOf(ctx) {
  const w = ctx.w;
  const rMin = Math.max(w, (ctx.rMinW ?? 3) * w);
  const rMax = Math.max(rMin * 1.2, (ctx.rMaxW ?? 12) * w);
  return { w, rMin, rMax };
}

/**
 * The brightness band the method can reach: the darkest tone comes from rMin and
 * the brightest from rMax.
 *
 * This method is fundamentally light. It cannot draw white — a circle of any size
 * still lays ink — and cannot get near black either: measured, the floor is about
 * 0.42 at rMin = 2w and 0.56 at 3w. The naive law suggests coverage reaches 1 at
 * r = 2*phi*w, but that extrapolates past where it holds, and with the tangency
 * term it tops out well short. Budget for a pale drawing, or use it over another
 * method rather than alone.
 */
export function toneBand(ctx, phi = PACKING_FRACTION) {
  const { w, rMin, rMax } = radiiOf(ctx);
  return {
    min: 1 - coverageOf(w, rMin, phi),
    max: 1 - coverageOf(w, rMax, phi),
  };
}

/**
 * What the method is aiming for, per pixel.
 *
 * Evaluated through the coverage law at each pixel's own radius rather than as
 * an affine remap between the band ends. Those differ: the tangency term makes
 * coverage slightly sub-linear in 1/R, so the achieved ramp bows away from the
 * straight line between the endpoints, and this captures the bow. No remap
 * happens before the geometry -- R(im) already spans the method's whole range,
 * so this only describes the result.
 *
 * So this is the one method that does NOT use spine/tone.js affineTarget: the
 * bow is exactly what the affine version would throw away.
 */
export function targetImage(ctx) {
  const { w, rMin, rMax } = radiiOf(ctx);
  const R = radiusMap(ctx, rMin, rMax);
  const out = makeImage(ctx.nx, ctx.ny);
  for (let i = 0; i < out.data.length; i++) out.data[i] = 1 - coverageOf(w, R[i]);
  return out;
}

/** Required radius per pixel: 1/R linear in brightness (MATLAB line 48). */
function radiusMap(ctx, rMin, rMax) {
  const { nx, ny, im } = ctx;
  const R = new Float64Array(nx * ny);
  const k = 1 - rMin / rMax;
  for (let i = 0; i < R.length; i++) {
    const v = Math.min(1, Math.max(0, im.data[i]));
    const r = rMin / (1 - v * k);
    R[i] = r < rMin ? rMin : r > rMax ? rMax : r;
  }
  return R;
}

/**
 * Lower `d` with one circle's surface distance across the row at `y`.
 *
 * Only the window |x - cx| < rMax + r is touched, as the MATLAB does: outside
 * it the circle is further than rMax away, so it can never block a circle of
 * radius <= rMax and the row's value there does not matter. This is what keeps
 * the scan near-linear rather than O(rows x circles x width).
 */
function lowerRow(d, nx, cx, cy, r, rMax, y) {
  const reach = rMax + r;
  const dy = y - cy;
  const ix1 = Math.max(0, Math.floor(cx - reach) - 1);
  const ix2 = Math.min(nx - 1, Math.ceil(cx + reach) - 1);
  for (let ixz = ix1; ixz <= ix2; ixz++) {
    const dx = ixz + 1 - cx;
    const v = Math.sqrt(dx * dx + dy * dy) - r;
    if (v < d[ixz]) d[ixz] = v;
  }
}

/**
 * The scan. Exported separately so the harness can measure the packing fraction
 * without paying for the tessellation.
 * @returns {{cx:Float64Array, cy:Float64Array, cr:Float64Array, n:number}}
 */
export function packCircles(ctx) {
  const { nx, ny } = ctx;
  const { rMin, rMax } = radiiOf(ctx);
  const R = radiusMap(ctx, rMin, rMax);

  const cx = [], cy = [], cr = [];
  let live = [];
  const d = new Float64Array(nx);
  let dPrev = new Float64Array(nx);
  let havePrev = false;

  for (let iyz = 0; iyz < ny; iyz++) {
    const y = iyz + 1;
    const rowOff = iyz * nx;

    // --- distances from the live circles, then from the page edge.
    // The edge term is exact and always finite, which matters: it is what
    // guarantees d is a real bound everywhere, and a circle placed where
    // d >= R is therefore wholly inside the rectangle with no clipping test.
    d.fill(BIG);
    for (let k = 0; k < live.length; k++) {
      const j = live[k];
      lowerRow(d, nx, cx[j], cy[j], cr[j], rMax, y);
    }
    const eY = Math.min(iyz, ny - 1 - iyz);
    for (let ixz = 0; ixz < nx; ixz++) {
      const e = Math.min(ixz, nx - 1 - ixz, eY);
      if (e < d[ixz]) d[ixz] = e;
    }

    // --- place circles, leftmost first.
    // A single left-to-right pass is equivalent to the MATLAB's repeated
    // find(newPts,1,'first'): placing only ever LOWERS d, so no column to the
    // left can become feasible, and the column just used cannot stay feasible.
    for (let ixz = 0; ixz < nx; ixz++) {
      const need = R[rowOff + ixz];
      if (d[ixz] - need < CUTOFF) continue;
      if (cx.length >= CIRCLE_BUDGET) break;

      let py = y, pr = need;
      if (FINE_TUNE_Y && havePrev) {
        // Linear back-interpolation to where (d - R) crosses zero, which
        // happened somewhere between the previous row and this one.
        //
        // The MATLAB's own version of this block additionally re-picks the
        // candidate by min(dy) -- the one that would have fitted highest.
        // That is a different tiebreak from the leftmost rule used everywhere
        // else here, so it is deliberately not adopted: the choice of WHICH
        // column stays leftmost, and only the y of that column is refined.
        const gD = d[ixz] - dPrev[ixz];
        const gR = iyz > 0 ? need - R[rowOff - nx + ixz] : 0;
        const slope = gD - gR;
        if (slope > 0) {
          let dy = -(d[ixz] - need) / slope;
          if (dy < -1) dy = -1;
          if (dy > 0) dy = 0;
          py = y + dy;
          pr = Math.min(rMax, Math.max(rMin, need + gR * dy));
        }
      }

      cx.push(ixz + 1); cy.push(py); cr.push(pr);
      const j = cx.length - 1;
      live.push(j);
      lowerRow(d, nx, cx[j], cy[j], cr[j], rMax, y);
    }

    dPrev.set(d);
    havePrev = true;

    // --- prune, on the exact criterion rather than the MATLAB's heuristic.
    //
    // fixCirclePackingScan.m keeps `unique(subI)`: the circles that are nearest
    // to some pixel of the row just finished. But "shadowed everywhere at row i"
    // does not imply "irrelevant at row i+k", and a dropped circle stops
    // blocking, so a later circle can be placed overlapping it. A circle's
    // smallest possible surface distance to the next row is (y+1 - cy) - r, so
    // it can still matter only while that is <= rMax. Cheap, exact, and it
    // removes the overlap failure mode entirely.
    const next = [];
    for (let k = 0; k < live.length; k++) {
      const j = live[k];
      if (y + 1 - cy[j] - cr[j] <= rMax) next.push(j);
    }
    live = next;
  }

  return {
    cx: Float64Array.from(cx),
    cy: Float64Array.from(cy),
    cr: Float64Array.from(cr),
    n: cx.length,
  };
}

/**
 * Circle as a closed polyline, with the point count set by chord error rather
 * than fixed. The MATLAB uses 16 for every circle regardless of size, which
 * wastes points on the small ones and facets the large ones.
 */
function circlePoints(x, y, r, w) {
  const sag = Math.min(r * 0.5, SAGITTA * w);
  const theta = 2 * Math.acos(Math.max(-1, 1 - sag / r));
  const n = Math.max(24, Math.min(256, Math.ceil((2 * Math.PI) / theta)));
  const pts = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts[i] = [x + r * Math.cos(t), y + r * Math.sin(t)];
  }
  return pts;
}

export function run(ctx) {
  const { w } = radiiOf(ctx);
  const { cx, cy, cr, n } = packCircles(ctx);
  const { px, py } = ctx.polygon;

  // Circles are whole by construction: the edge term in the scan means a circle
  // is only placed where its radius fits inside the rectangle.
  //
  // TODO general polygons. Two things change: the edge distance becomes a
  // point-to-polygon distance rather than the analytic min over four sides, and
  // circles must be REJECTED where they do not fit rather than trimmed -- a
  // clipped circle reads as broken geometry in a way a clipped hatch line does
  // not. The trim below is a backstop for the rectangle case only; if it ever
  // actually cuts a circle, the edge term is wrong.
  const rectOnly = px.length === 4;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const pts = circlePoints(cx[i], cy[i], cr[i], w);
    if (rectOnly) { lines.push(pts); continue; }
    const segs = [];
    for (let k = 0; k < pts.length - 1; k++) {
      segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
    }
    for (const s of trimLineSegsToPolygon(segs, px, py)) {
      lines.push([[s[0], s[1]], [s[2], s[3]]]);
    }
  }
  return lines;
}

export default { id, label, params, run, targetImage };
