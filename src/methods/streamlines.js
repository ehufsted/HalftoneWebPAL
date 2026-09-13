// Evenly-spaced streamlines of the orientation field -- Jobard & Lefer, 1997.
//
// Not a port, and the only method here that FOLLOWS the orientation field rather
// than using it to orient something else.
//
// The construction: integrate a streamline until it comes within d_test of a line
// already drawn, then seed new ones at ±d_sep perpendicular offsets along it.
// Spacing is even by construction rather than by relaxation, and with d_sep = w/K
// the coverage is the tone.
//
// The tone model is the same harmonic ladder as eikonalStripes and planeWaves —
// strokes of width w at spacing L cover w/L, so linear 1/L gives linear coverage.
// What differs is the guarantee behind it, and that is why this is a separate
// module rather than a mode of eikonalStripes: that method's level sets cannot
// cross, dead-end, or fail to close, so its w/L band carries no term for line
// ends. Streamlines terminate — at the polygon, at a neighbour, and wherever the
// field turns them back on themselves — so reusing that band unchanged would
// predict systematically too dark wherever the lines come out short.
//
// The shortfall is not folded into targetImage: toneBand states the
// specification w/L, and how far short the drawing falls is measured in
// tests/spine.streamlines.js and reported rather than modelled. Folding it in
// would be scoring the method against its own error.
//
// The mod-pi problem is solved locally: a streamline never needs a global
// orientation, only the one arrow that continues the curve it is already on,
// which is `if (t . prevDir < 0) t = -t` and no bookkeeping. A half-index
// singularity then curls the line back on itself, which is what fingerprint
// ridges do at a delta and the right visual behaviour rather than a failure.
//
// No RNG at all: seeds are ordered by darkness and everything after is queue
// order, so there is no `seed` param and two runs are bit-identical.

import { regionMask } from '../spine/mask.js';
import { structureTensorField } from '../spine/field.js';
import { simplifyLineDistance } from '../spine/simplify.js';
import { clipPolyline } from '../spine/geometry.js';
import { affineTarget, stripeSpacings, stripeBand, harmonicSpacing } from '../spine/tone.js';
import { setNote } from '../spine/notes.js';

export const id = 'streamlines';
export const label = 'Streamlines (flow hatching)';
// `angleOffset` changes the hatching's relationship to the image's own field
// (tangent vs gradient), not a plain direction -- `flatAngle` is the one true
// absolute angle here, the fallback used where the field has no direction to
// follow. See methods/index.js.
//
// PARTIAL, NOT COMPLETE, DECORRELATION. blendedField() blends flatAngle with
// the tangent/gradient direction weighted by coherence, so on a photo with
// real edges and gradients -- most of them -- flatAngle's contribution shrinks
// wherever the image already has a strong direction of its own, and CMYK's
// "rotate/shift" checkbox correspondingly loses effect there. It still fully
// controls flat/uniform regions, so it is a genuine capability, just not the
// uniform four-way separation a hatch angle gives across the whole page.
export const rotationParam = 'flatAngle';

export const params = [
  // Same names, ranges and floors as eikonalStripes and planeWaves. The limits
  // themselves now come from spine/tone.js `stripeSpacings`, which all three
  // share; only the ranges the user sees are stated here.
  { key: 'LminW', label: 'Min spacing', type: 'range', min: 1, max: 5, step: 0.1, def: 1.5, unit: '×pen' },
  { key: 'LmaxW', label: 'Max spacing', type: 'range', min: 4, max: 40, step: 1, def: 10, unit: '×pen' },
  // 0 follows the edge tangent, so the hatching runs ALONG the form. 90 follows
  // the gradient, which is the engraving look -- lines across the form.
  { key: 'angleOffset', label: 'Stroke angle', type: 'range', min: 0, max: 180, step: 5, def: 0, unit: '°' },
  // Where the picture is flat there is no orientation to follow; see blendedField.
  { key: 'flatAngle', label: 'Angle in flat areas', type: 'range', min: 0, max: 180, step: 5, def: 45, unit: '°' },
  { key: 'minLenW', label: 'Shortest stroke', type: 'range', min: 1, max: 40, step: 1, def: 4, unit: '×pen' },
];

/**
 * How close a streamline may come to an existing one, as a fraction of the local
 * spacing.
 *
 * The one free constant in the method, and a trade rather than a derivation: at
 * alpha → 1 a line terminates as soon as it runs alongside a neighbour at the
 * intended spacing, so every stroke is a stub; at alpha → 0 lines run forever and
 * pack far tighter than the tone asked for. 0.5 is Jobard & Lefer's own figure.
 *
 * A constant rather than a slider until the sweep in tests/spine.streamlines.js —
 * which reports realised spacing spread against mean stroke length, exactly this
 * trade — says both ends of the range are worth having.
 */
const D_TEST_FRACTION = 0.5;

/**
 * Integration step, as a fraction of the pen width.
 *
 * From a chord-error budget rather than taste: a polyline chord across a turn of
 * radius r sags by about s^2/8r, so the step follows from the sag the pen can
 * resolve. dots.js uses SAGITTA = 0.03 for a spiral FILL, where a sag comparable
 * to the pitch opens a gap on every turn; circlePacking uses 0.25 for an
 * OUTLINE, which only has to look round. A streamline is an outline.
 */
const STEP_FRACTION = 0.25;

/** Samples dropped into the index per step, as a fraction of d_test. */
const INDEX_FRACTION = 0.5;

/** A closed orbit would integrate forever; cap it at this many image diagonals. */
const MAX_LENGTH_DIAGONALS = 2;

const spacingsOf = (ctx) => stripeSpacings(ctx);

/**
 * Reachable brightness band: coverage is w/L, the shared stripe band.
 *
 * This is the specification, not the achieved tone. Streamlines terminate, and a
 * terminated line lays less ink than the band assumes, so the drawing runs light
 * by an amount that grows with how often the field turns lines back. That is the
 * method's error rather than its target — see the module header — and the harness
 * measures against this rather than this being adjusted to match.
 */
export function toneBand(ctx) {
  const { w, Lmin, Lmax } = spacingsOf(ctx);
  return stripeBand(w, Lmin, Lmax);
}

/** Since 1/L is linear in brightness, the achieved ramp IS the affine remap. */
export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Target spacing per pixel, from the harmonic ladder.
 *
 * Unclamped: nothing here reads outside the region, so the ladder's own range is
 * the whole range. See `harmonicSpacing` for why its argument is the raw image
 * value and never the remapped target.
 */
function spacingMap(ctx) {
  const { Lmin, Lmax } = spacingsOf(ctx);
  const n = ctx.nx * ctx.ny;
  const L = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(0, ctx.im.data[i]));
    L[i] = harmonicSpacing(v, Lmin, Lmax);
  }
  return L;
}

/**
 * The direction field, as a doubled-angle vector, with the flat-region fallback
 * already blended in.
 *
 * No angle is formed here, which is what makes the blend correct.
 * `(t11 - t22, 2*t12)` is the structure tensor's doubled-angle vector — the same
 * quantity `theta` is recovered from with an atan2 — and it interpolates linearly
 * where an angle does not. Blending two orientations by averaging their angles is
 * the mod-pi bug: near 0 and near pi they cancel to nothing.
 *
 * The fallback exists because coherence is (l1-l2)/(l1+l2), so a flat region — a
 * sky, a smooth background, most of the frame on a real photograph — has no
 * gradient and its orientation is noise, and the streamlines there knot and
 * wander exactly where the picture is calmest. Blending toward a fixed angle
 * weighted by coherence degrades the method into ordinary parallel hatching
 * instead, and lets the user pick the hatching angle, which is a composition
 * decision rather than something to derive.
 *
 * @returns {{cx:Float64Array, cy:Float64Array}} unit doubled-angle vectors
 */
function blendedField(ctx, rTensorPx) {
  const n = ctx.nx * ctx.ny;
  const f = structureTensorField(ctx.im, Math.max(1, ctx.w), Math.max(1.5, rTensorPx));
  const phi = (((ctx.flatAngle ?? 45) * Math.PI) / 180) * 2;   // doubled
  const fx = Math.cos(phi), fy = Math.sin(phi);
  const cx = new Float64Array(n), cy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = f.t11[i], b = f.t12[i], d = f.t22[i];
    const spread = Math.hypot(a - d, 2 * b);
    const trace = a + d;
    const coh = trace > 0 ? spread / trace : 0;
    // The tensor's vector points along the GRADIENT orientation; the tangent is
    // that turned by pi/2, which doubles to a turn by pi -- negate both.
    const inv = spread > 0 ? 1 / spread : 0;
    const ux = -(a - d) * inv, uy = -(2 * b) * inv;
    let bx = coh * ux + (1 - coh) * fx;
    let by = coh * uy + (1 - coh) * fy;
    const m = Math.hypot(bx, by);
    if (m > 0) { bx /= m; by /= m; } else { bx = fx; by = fy; }
    cx[i] = bx; cy[i] = by;
  }
  return { cx, cy };
}

/**
 * Incremental bucket grid over the samples of accepted streamlines.
 *
 * Written inline rather than shared with pathOptimizer's EndpointGrid or
 * bestCandidatePoints' equivalent, because this one needs incremental insertion.
 * Extracting a single shared index is the right end state, but it is a change to
 * calibrated code and belongs on its own with a test behind it.
 *
 * The early-exit bound is the same one both siblings use: a point in ring r is
 * at least (r-1) cells away, so once the best found is nearer than that, no
 * later ring can beat it.
 */
function makeIndex(nx, ny, cellSize) {
  const cell = Math.max(1, cellSize);
  const gw = Math.max(1, Math.ceil(nx / cell));
  const gh = Math.max(1, Math.ceil(ny / cell));
  const bins = new Array(gw * gh).fill(null);
  const cellOf = (x, y) => {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor((x - 1) / cell)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor((y - 1) / cell)));
    return gy * gw + gx;
  };
  return {
    add(x, y) {
      const b = cellOf(x, y);
      if (bins[b]) bins[b].push(x, y); else bins[b] = [x, y];
    },
    /** True if any stored sample lies within `r` of (qx, qy). */
    within(qx, qy, r) {
      const r2 = r * r;
      const cxi = Math.min(gw - 1, Math.max(0, Math.floor((qx - 1) / cell)));
      const cyi = Math.min(gh - 1, Math.max(0, Math.floor((qy - 1) / cell)));
      const maxR = Math.ceil(r / cell) + 1;
      for (let ring = 0; ring <= maxR; ring++) {
        if ((ring - 1) * cell > r) break;
        for (let gy = cyi - ring; gy <= cyi + ring; gy++) {
          if (gy < 0 || gy >= gh) continue;
          const edge = gy === cyi - ring || gy === cyi + ring;
          for (let gx = cxi - ring; gx <= cxi + ring; gx++) {
            if (gx < 0 || gx >= gw) continue;
            if (!edge && gx !== cxi - ring && gx !== cxi + ring) continue;
            const bin = bins[gy * gw + gx];
            if (!bin) continue;
            for (let i = 0; i < bin.length; i += 2) {
              const dx = bin[i] - qx, dy = bin[i + 1] - qy;
              if (dx * dx + dy * dy < r2) return true;
            }
          }
        }
      }
      return false;
    },
  };
}

/**
 * The streamlines and the seeds that produced them.
 *
 * Exported so the harness can measure the geometry directly -- realised spacing,
 * stroke length, direction against the field -- rather than inferring any of it
 * from a rendered picture.
 */
export function traceStreamlines(ctx, opts = {}) {
  const { nx, ny } = ctx;
  // Optional override, defaulting to this method's own ladder.
  // `dashedStreamlines` packs at a CONSTANT separation and carries tone in dashes
  // instead, so it needs the integrator with a flat spacing field.
  //
  // A uniform field also settles the seeding for free: the darkness sort below
  // keys on L, so with every entry equal it falls back to the index tiebreak and
  // becomes raster order, which is the plain Jobard-Lefer fill this method's
  // variable spacing is the deliberate departure from.
  const { w, Lmin, Lmax } = opts.spacings ?? spacingsOf(ctx);
  const mask = regionMask(ctx);
  const L = opts.spacing ?? spacingMap(ctx);

  // Smoothed at the mean spacing, not at the pen width. If the field varies
  // faster than d_sep, adjacent streamlines diverge before they have run a
  // spacing's length and the even spacing breaks down. Same argument as
  // siteMetrics in spine/relax.js: structureTensorField takes one scale and this
  // one varies with tone, so use the mean.
  let sumL = 0, nIn = 0;
  for (let i = 0; i < L.length; i++) if (mask[i]) { sumL += L[i]; nIn++; }
  const meanL = nIn > 0 ? sumL / nIn : Lmin;
  const { cx, cy } = blendedField(ctx, meanL);

  const offset = (((ctx.angleOffset ?? 0) * Math.PI) / 180) * 2;   // doubled
  const cosO = Math.cos(offset), sinO = Math.sin(offset);

  /** Unit tangent at a sub-pixel position, by bilinear on the doubled angle. */
  const tangentAt = (x, y) => {
    const fx = Math.min(nx - 1, Math.max(0, x - 1));
    const fy = Math.min(ny - 1, Math.max(0, y - 1));
    const ix = Math.min(nx - 2, Math.floor(fx)), iy = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy;
    const i00 = iy * nx + ix, i10 = i00 + 1, i01 = i00 + nx, i11 = i01 + 1;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty, w11 = tx * ty;
    let dx = cx[i00] * w00 + cx[i10] * w10 + cx[i01] * w01 + cx[i11] * w11;
    let dy = cy[i00] * w00 + cy[i10] * w10 + cy[i01] * w01 + cy[i11] * w11;
    // Rotate the doubled angle by the offset, then halve back to a direction.
    const rx = dx * cosO - dy * sinO, ry = dx * sinO + dy * cosO;
    const th = 0.5 * Math.atan2(ry, rx);
    return [Math.cos(th), Math.sin(th)];
  };

  const spacingAt = (x, y) => {
    let j = Math.round(x) - 1, i = Math.round(y) - 1;
    if (j < 0) j = 0; else if (j >= nx) j = nx - 1;
    if (i < 0) i = 0; else if (i >= ny) i = ny - 1;
    return L[i * nx + j];
  };
  const insideAt = (x, y) => {
    const j = Math.round(x) - 1, i = Math.round(y) - 1;
    if (j < 0 || i < 0 || j >= nx || i >= ny) return false;
    return mask[i * nx + j] === 1;
  };

  const step = Math.max(0.15, STEP_FRACTION * w);
  const maxLen = MAX_LENGTH_DIAGONALS * Math.hypot(nx, ny);
  const index = makeIndex(nx, ny, Math.max(1, Lmin * D_TEST_FRACTION));

  /**
   * Integrate one half-streamline from (x0, y0), RK2, in `dir` (+1 or -1).
   *
   * The sign rule is the whole of the mod-pi handling: the field returns a LINE,
   * and the arrow that continues this curve is whichever of the two agrees with
   * the step just taken.
   */
  const halfLine = (x0, y0, dir, other = null) => {
    // Why it stopped, not just that it did. A stroke ending at the page edge lays
    // its full ink; one that stops against a neighbour leaves a gap the tone model
    // did not account for. Only the second kind is a premature end.
    let why = 'length';
    const pts = [];
    let x = x0, y = y0;
    let px = null, py = null;
    let len = 0;
    for (;;) {
      let [ux, uy] = tangentAt(x, y);
      if (px !== null && ux * px + uy * py < 0) { ux = -ux; uy = -uy; }
      if (px === null) { ux *= dir; uy *= dir; }
      // RK2: sample the field again at the midpoint of an Euler step.
      const hx = x + ux * step * 0.5, hy = y + uy * step * 0.5;
      let [mx, my] = tangentAt(hx, hy);
      if (mx * ux + my * uy < 0) { mx = -mx; my = -my; }
      const nxp = x + mx * step, nyp = y + my * step;
      if (!insideAt(nxp, nyp)) { why = 'boundary'; break; }
      // The proximity test uses the TIP's own spacing. Which of the two spacings
      // to use where they differ is a real choice -- see the plan -- and this is
      // the one that makes density right where the ink is actually being laid.
      const dTest = D_TEST_FRACTION * spacingAt(nxp, nyp);
      if (index.within(nxp, nyp, dTest)) { why = 'proximity'; break; }
      // And against itself, which the shared index cannot do: a line's samples
      // are only inserted once it is accepted, so without this a curling field
      // lets a streamline spiral into its own tail and draw a knot. The recent
      // past is excluded because consecutive samples are a step apart and would
      // otherwise stop the line immediately; two dTest of backtrack is the
      // smallest window that cannot trigger on the curve's own thickness.
      //
      // Strided, with the approximation bounded. Scanning every stored point is
      // O(n^2) in the stroke length, reaching a few hundred million comparisons
      // at the spacing floor on a dark image. Samples sit `step` apart along the
      // curve, so testing every k-th of them against radius dTest can only miss
      // an approach by k*step/2; choosing k so that is dTest/4 keeps the guard
      // well inside the spacing it protects.
      const skip = Math.ceil((2 * dTest) / step);
      const stride = Math.max(1, Math.floor(dTest / (2 * step)));
      let hitSelf = false;
      for (let i = 0; i < pts.length - skip; i += stride) {
        const dxs = pts[i][0] - nxp, dys = pts[i][1] - nyp;
        if (dxs * dxs + dys * dys < dTest * dTest) { hitSelf = true; break; }
      }
      // And against the other half of this same streamline, which nothing else
      // checks. The two halves are traced independently and neither is in the
      // shared index yet, so on a closed orbit each half would run the whole way
      // round and the concatenated polyline would be two loops of one circle laid
      // on top of each other. Measured on a radial ramp, whose streamlines are
      // exact circles: 15% of the ink drawn twice, paid for by the budget and
      // received once by the paper.
      //
      // The first `skip` points are excluded for the same reason they are above:
      // both halves start at the shared seed and are legitimately adjacent there.
      if (!hitSelf && other) {
        for (let i = skip; i < other.length; i += stride) {
          const dxo = other[i][0] - nxp, dyo = other[i][1] - nyp;
          if (dxo * dxo + dyo * dyo < dTest * dTest) { hitSelf = true; break; }
        }
      }
      if (hitSelf) { why = 'self'; break; }
      pts.push([nxp, nyp]);
      px = mx; py = my;
      x = nxp; y = nyp;
      len += step;
      if (len > maxLen) break;
    }
    return { pts, why };
  };

  // Seeds darkest first. With variable spacing the order matters more than in
  // uniform Jobard-Lefer: the proximity test above uses the tip's own spacing, so
  // a line growing out of a dark region into a light one stops early against
  // whatever is already there. Laying the tight packing down first and filling
  // the light areas around it keeps the shadows from being under-inked at tone
  // boundaries. Sorting is by darkness and then by index, so it is total and
  // deterministic -- there is no RNG anywhere in this method.
  const seeds = [];
  for (let i = 0; i < L.length; i++) if (mask[i]) seeds.push(i);
  seeds.sort((a, b) => (L[a] - L[b]) || (a - b));

  const lines = [];
  const queue = [];
  let qHead = 0;
  const minLen = Math.max(w, (ctx.minLenW ?? 4) * w);
  const indexStep = Math.max(0.5, INDEX_FRACTION * D_TEST_FRACTION * Lmin);
  let seedPtr = 0;
  let premature = 0;

  /**
   * @param {number} [dSep] the separation this seed was placed at. A queued seed
   *        carries its own, because in a spacing GRADIENT the offset it was
   *        pushed to and the spacing where it landed are different numbers --
   *        see the seeding loop. A fallback seed has no parent, so the local
   *        spacing is all there is.
   */
  const grow = (sx, sy, dSep) => {
    if (!insideAt(sx, sy)) return;
    const sep = dSep ?? spacingAt(sx, sy);
    // Tested at the full spacing, not the test distance, and the difference is
    // the whole of the method's tone accuracy. Jobard & Lefer use two distances
    // for two jobs: a candidate seed must be d_sep clear of everything, while an
    // already growing line may run in to d_test before it stops. Using d_test
    // here as well lets a new line be planted in the middle of an existing gap,
    // so the packing settles at d_test rather than d_sep — measured, realised
    // spacing of 2.18 px against a requested 3.93 at the dark end, and every tone
    // over-inked. It bites hardest in shadows, where seeds are plentiful enough
    // to find the gaps.
    if (index.within(sx, sy, sep)) return;
    const back = halfLine(sx, sy, -1);
    const fwd = halfLine(sx, sy, +1, back.pts);   // see halfLine on closed orbits
    back.pts.reverse();
    const pts = back.pts.concat([[sx, sy]], fwd.pts);
    if (pts.length < 2) return;
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    if (len < minLen) return;

    lines.push(pts);
    if (back.why !== 'boundary') premature++;
    if (fwd.why !== 'boundary') premature++;

    // Index the accepted line, and offer seeds either side of it. Both use the
    // local tangent from the polyline itself, so no resampling is needed -- and
    // adding a third resampleUniform is exactly what the README warns against,
    // the two existing ones having different endpoint semantics.
    let acc = 0, accSeed = 0;
    index.add(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1];
      const bx = pts[i][0], by = pts[i][1];
      const seg = Math.hypot(bx - ax, by - ay);
      acc += seg; accSeed += seg;
      if (acc >= indexStep) { index.add(bx, by); acc = 0; }
      if (accSeed >= spacingAt(bx, by)) {
        accSeed = 0;
        const t = seg > 0 ? [(bx - ax) / seg, (by - ay) / seg] : [1, 0];
        const px1 = -t[1], py1 = t[0];
        // The offset is refined at the midpoint, each side separately.
        //
        // A seed pushed at the PARENT's spacing lands where the spacing may be
        // different — that is what a spacing gradient means — and is then judged
        // against the spacing where it landed. On the light side of any ramp the
        // local spacing is the larger of the two, so the seed sits inside its own
        // rejection radius and is thrown away: measured, a linear ramp drew 55
        // strokes where the ladder asks for about 63, coming out 0.073 light.
        //
        // One fixed-point step settles it: evaluate the spacing halfway out,
        // offer the seed at that distance, and carry the distance with the seed
        // so the rejection test uses the same number the placement did. Neither
        // the parent's spacing nor the seed's is privileged, which is the honest
        // reading of "the spacing between two lines" when the two disagree.
        const d0 = spacingAt(bx, by);
        for (const s of [1, -1]) {
          const mx = bx + s * px1 * d0 * 0.5, my = by + s * py1 * d0 * 0.5;
          const d = spacingAt(mx, my);
          queue.push([bx + s * px1 * d, by + s * py1 * d, d]);
        }
      }
    }
    index.add(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  };

  // Drain the queue, refilling from the darkness-ordered seed list whenever it
  // empties, so every part of the drawing gets covered rather than only whatever
  // the first streamline could reach.
  for (;;) {
    if (qHead < queue.length) {
      const [sx, sy, sep] = queue[qHead++];
      grow(sx, sy, sep);
      continue;
    }
    let placed = false;
    while (seedPtr < seeds.length) {
      const c = seeds[seedPtr++];
      const sx = (c % nx) + 1, sy = Math.floor(c / nx) + 1;
      // Full spacing again, for the reason in `grow`. This scan is where the
      // collapse actually happened: the queue propagates outward at d_sep on its
      // own, but the darkness-ordered fallback goes looking for any free pixel,
      // and with a d_test radius "free" included the middle of every gap.
      if (index.within(sx, sy, spacingAt(sx, sy))) continue;
      grow(sx, sy);
      placed = true;
      break;
    }
    if (!placed && seedPtr >= seeds.length) break;
  }

  return { lines, premature, meanL, Lmin, Lmax, w };
}

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const { w } = spacingsOf(ctx);
  const built = traceStreamlines(ctx);
  const tally = ctx.stageTally;
  const count = (key, arr) => { if (tally) tally[key] = arr.length; };
  count('traced', built.lines);

  const out = [];
  let drawn = 0;
  for (const line of built.lines) {
    // The integrator emits a point every 0.25*w, so a 100 px stroke arrives with
    // 400 of them. This thins at the same threshold the worker's simplifyAll
    // uses -- half a pen width, below which a deviation cannot be seen -- so it
    // changes nothing downstream and simply spares the path optimiser the other
    // 380 points. eikonalStripes pre-thins for the same reason.
    const simp = simplifyLineDistance(line, w / 2);
    if (simp.length < 2) continue;
    // clipPolyline, not trimLineSegsToPolygon: this is a continuous stroke and
    // the point order carries the drawing. Mostly a safety net, since the
    // integrator already stops at the polygon.
    for (const run2 of clipPolyline(simp, px, py)) {
      if (run2.length >= 2) { out.push(run2); drawn++; }
    }
  }
  count('clipped', out);

  setNote(`${drawn} strokes, ${built.premature} stopped early`);
  return out;
}

export default { id, label, params, run, targetImage, rotationParam };
