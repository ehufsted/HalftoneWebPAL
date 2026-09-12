// Moving seeds around: Lloyd relaxation, the anisotropic metric it can run
// under, and the pinned polish both point placers finish with.
//
// Every point placer depends on this module; no region tiler does.
//
// The traps here do not announce themselves, and all four are in
// docs/architecture.md rather than repeated at each function:
//
//   - the metric must be FROZEN for the run (correctness, not thrift: the
//     mass-weighted centroid is the argmin only while M is held fixed);
//   - `det M = 1` removes the isotropic dilation component, and is not about
//     preserving cell areas;
//   - `alignPoints` is gated on its ITERATION count, not on anisotropy strength,
//     because at strength 0 it is still a worthwhile damped Lloyd polish;
//   - the anisotropic metric's sign is the opposite formula from `treeEdges`',
//     and both mean "+1 follows the image".

import { polygonMask } from './mask.js';
import { distToSegmentSq } from './geometry.js';
import { structureTensorField } from './field.js';

/** Seeds move less than this many pixels and the polish stops. */
const SETTLE_TOL = 0.05;

/**
 * Largest axis ratio the anisotropy slider can ask for, as rho at full strength.
 *
 * 4 is a 2:1 ellipse, and the cap is derived rather than chosen. Anisotropy packs
 * dots tighter along one axis by sqrt(rho), so dots that were tangent at rho = 1
 * OVERLAP beyond it, and overlapping ink is ink the tone model counted and the
 * paper did not receive. No overlap needs 2*rDot <= spacing/sqrt(rho), i.e.
 *
 *     rho <= (spacing / 2*rDot)^2  =  pi / (4K)   at the tone model's own density
 *
 * so rho = 4 is comfortable in highlights and any anisotropy overlaps once
 * darkness passes pi/4 = 0.785. That is a fact about equal circles rather than
 * about this code — stippleGrowing accepts the same shortfall at high density,
 * and anisotropy makes it bite at lighter tones. tests/spine.aniso.js measures
 * where.
 */
const RHO_MAX = 4;

/**
 * Per-site anisotropic metrics, from the structure tensor.
 *
 * No angle is ever formed. `structureTensorField` collapses its smoothed
 * components to `theta` with an atan2, after which every consumer has to remember
 * the mod-pi rule — double before averaging, never interpolate the angle itself.
 * `(t11 - t22, 2*t12)` is the doubled-angle vector already, so building the
 * metric straight from the components skips the round trip and the hazard with
 * it, along with two transcendental calls per site.
 *
 * The metric, with `u` along the local edge tangent:
 *
 *     M = ((rho + 1/rho)/2) I + ((rho - 1/rho)/2) [[cos2t, sin2t], [sin2t, -cos2t]]
 *
 * which has eigenvalues rho and 1/rho, so det M = 1 exactly by construction. That
 * does not preserve each cell's area — with per-site metrics the diagram is
 * asymmetric, and two neighbours at rho = 4 and rho = 1 both have det 1 while
 * still not splitting their shared territory evenly. What it removes is the
 * isotropic dilation component, the one that would move the Gersho drift
 * `relaxSeeds` documents. The dot count is safe for an unrelated reason:
 * `stipplePoints` apportions by mass top-down and never by area.
 *
 * Sign: rho > 1 weights the along-tangent component more, so distance grows
 * faster along the tangent, cells are short that way, and dots pack tight along
 * the tangent — rows that follow the form. This is the opposite formula from
 * `treeEdges`' `anisotropy`, where +1 makes an along-tangent edge cheap. Both
 * mean "+1 follows the image": a tree metric picks which edges are drawn and a
 * Voronoi metric picks cell shape, and those want opposite signs.
 *
 * The strength gate is two-part, because coherence alone is scale-free — it
 * divides by the trace — so a nearly flat region with a slight directional bias
 * reads as fully coherent and sensor noise becomes directional pattern in exactly
 * the areas that should stay blue-noise. Gating on energy as well, relative to
 * the image's own median, makes "flat" mean flat for this picture.
 *
 * @param {number} strength signed, [-1, +1]; 0 never reaches here
 * @returns {{m11,m12,m22:Float64Array, rhoMaxSqrt:number}} per site
 */
export function siteMetrics(ctx, sx, sy, n, strength, rTensorPx) {
  const { nx, ny } = ctx;
  const f = structureTensorField(
    ctx.im,
    Math.max(1, ctx.w),
    // Smoothed at the point spacing, not at the pen width: the other callers use
    // 2*w, calibrated for pen-scale features, but a cell here spans several pen
    // widths and an anisotropic diagram misbehaves when the metric varies fast
    // relative to the spacing.
    Math.max(1.5, rTensorPx),
  );

  // Median energy, for the gate. Sampled rather than fully sorted: the gate only
  // needs a scale, and a sort of every pixel would cost more than the metric.
  const energies = [];
  for (let i = 0; i < f.t11.length; i += 7) energies.push(f.t11[i] + f.t22[i]);
  energies.sort((a, b) => a - b);
  const medE = energies.length ? energies[energies.length >> 1] : 0;

  const m11 = new Float64Array(n), m12 = new Float64Array(n), m22 = new Float64Array(n);
  let rhoMax = 1;
  const logR = Math.log(RHO_MAX);
  for (let i = 0; i < n; i++) {
    // Nearest pixel at the site's own position, as treeEdges and lappingShapes
    // do. No interpolation, so no mod-pi question even in principle.
    const jx = Math.min(nx - 1, Math.max(0, Math.round(sx[i]) - 1));
    const iy = Math.min(ny - 1, Math.max(0, Math.round(sy[i]) - 1));
    const c = iy * nx + jx;
    const a = f.t11[c], b = f.t12[c], d = f.t22[c];
    const spread = Math.hypot(a - d, 2 * b);
    const trace = a + d;
    const coh = trace > 0 ? spread / trace : 0;
    // smoothstep on energy against the image's own median
    const e = medE > 0 ? Math.min(1, (trace / medE) / 2) : 0;
    const gate = coh * (e * e * (3 - 2 * e));

    const rho = Math.exp(strength * gate * logR);
    if (rho > rhoMax) rhoMax = rho;
    if (1 / rho > rhoMax) rhoMax = 1 / rho;

    // Doubled-angle unit vector of the GRADIENT; the tangent is that turned by
    // pi/2, which doubles to a turn by pi -- i.e. negate both components.
    const inv = spread > 0 ? 1 / spread : 0;
    const cos2 = -(a - d) * inv, sin2 = -(2 * b) * inv;

    const half = (rho + 1 / rho) / 2, dif = (rho - 1 / rho) / 2;
    m11[i] = half + dif * cos2;
    m12[i] = dif * sin2;
    m22[i] = half - dif * cos2;
  }
  return { m11, m12, m22, rhoMaxSqrt: Math.sqrt(rhoMax) };
}

/**
 * Nearest-seed label per pixel, over a bucket grid.
 *
 * Equivalent to "which clipped cell is this pixel in", exactly and not
 * approximately, because an unweighted Voronoi cell IS the nearest-seed set --
 * and only pixels inside the drawing polygon are labelled, which is where the
 * clip would otherwise disagree. That equivalence is what allows the cheap
 * assignment here to stand in for rasterising the polygons.
 *
 * That equivalence holds only when `metric` is null. Under a per-site anisotropic
 * metric the bisector between two sites is a conic rather than a line, cells need
 * not be convex or even connected, and `voronoiCells` — which builds cells by
 * half-plane clipping — computes something else entirely. Pairing this label map
 * with those polygons is wrong under anisotropy.
 *
 * Brute force would be nPixels*nSeeds -- 9M per iteration at 300x300 and 100
 * seeds, times however many iterations. The grid searches buckets in expanding
 * rings and stops once the next ring cannot hold anything closer.
 *
 * @param {?{m11,m12,m22:Float64Array, rhoMaxSqrt:number}} [metric] per-site
 *        ellipse metrics from `siteMetrics`. Null takes the Euclidean path
 *        verbatim — the same expression, not an equivalent one — because at
 *        rho = 1 the elliptical form is algebraically dx*dx + dy*dy but not
 *        bitwise: `c*c + s*s !== 1` in general and the cross terms round
 *        independently before they cancel. The branch keeps isotropic drawings
 *        bit-identical, so it is structural rather than a fast path.
 */
export function nearestSeedMap(nx, ny, inside, sx, sy, n, metric = null) {
  const cell = Math.max(1, Math.sqrt((nx * ny) / Math.max(1, n)));
  const gw = Math.max(1, Math.ceil(nx / cell));
  const gh = Math.max(1, Math.ceil(ny / cell));
  const bucketOf = (x, y) => Math.min(gh - 1, Math.max(0, Math.floor((y - 1) / cell))) * gw
                           + Math.min(gw - 1, Math.max(0, Math.floor((x - 1) / cell)));

  const start = new Int32Array(gw * gh + 1);
  for (let i = 0; i < n; i++) start[bucketOf(sx[i], sy[i]) + 1]++;
  for (let b = 0; b < gw * gh; b++) start[b + 1] += start[b];
  const items = new Int32Array(n);
  const fill = Int32Array.from(start);
  for (let i = 0; i < n; i++) items[fill[bucketOf(sx[i], sy[i])]++] = i;

  const label = new Int32Array(nx * ny).fill(-1);
  const maxR = gw + gh;
  // Hoisted so the inner loop tests one predictable boolean rather than
  // dereferencing an object. `reach` is exactly 1 without a metric, and
  // multiplying by 1 is exact in IEEE, so the isotropic bound is unchanged.
  const m11 = metric ? metric.m11 : null;
  const m12 = metric ? metric.m12 : null;
  const m22 = metric ? metric.m22 : null;
  const reach = metric ? metric.rhoMaxSqrt : 1;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!inside[c]) continue;
      const qx = ix + 1, qy = iy + 1;
      const gx = Math.min(gw - 1, Math.floor(ix / cell));
      const gy = Math.min(gh - 1, Math.floor(iy / cell));
      let best = -1, bestD = Infinity;
      for (let r = 0; r <= maxR; r++) {
        // A seed in ring r is at least (r-1)*cell away in EUCLIDEAN terms, so
        // once the best found is closer than that, no further ring can improve
        // on it. Under a metric the stored best is a metric distance, and since
        // d^2 >= min(rho, 1/rho) * |delta|^2 the Euclidean reach of a metric ball
        // of radius `best` is best*sqrt(rho_max) -- so the bound scales and stays
        // a true lower bound. Cost: radius grows by sqrt(rho_max), buckets by
        // rho_max, and in the worst case by rho_max^2, because `best` can itself
        // be sqrt(rho) times the Euclidean distance to the winner.
        if (best >= 0 && (r - 1) * cell > Math.sqrt(bestD) * reach) break;
        for (let yy = gy - r; yy <= gy + r; yy++) {
          if (yy < 0 || yy >= gh) continue;
          const onYEdge = (yy === gy - r || yy === gy + r);
          for (let xx = gx - r; xx <= gx + r; xx++) {
            if (xx < 0 || xx >= gw) continue;
            if (r > 0 && !onYEdge && xx !== gx - r && xx !== gx + r) continue;
            const b = yy * gw + xx;
            for (let k = start[b]; k < start[b + 1]; k++) {
              const s = items[k];
              const dx = sx[s] - qx, dy = sy[s] - qy;
              const d = m11
                ? m11[s] * dx * dx + 2 * m12[s] * dx * dy + m22[s] * dy * dy
                : dx * dx + dy * dy;
              if (d < bestD) { bestD = d; best = s; }
            }
          }
        }
      }
      label[c] = best;
    }
  }
  return label;
}

/**
 * Plain mass-weighted Lloyd over every point, in place.
 *
 * What it is for: softening the subdivider's lattice. A leaf is an axis-aligned
 * box, so on flat tone the points land on a two-aspect grid; a few Lloyd steps
 * pull them into an even, organic packing instead.
 *
 * What it costs: flat mass-weighted Lloyd has its fixed point at the Gersho
 * distribution `field^(1/2)`, which is precisely the distribution the subdivider
 * exists to avoid, so every step drags points a little way back toward it. Seeds
 * are never created or destroyed, so the count survives exactly; the density
 * drifts, because points cross tone boundaries. Measured: eight steps put the
 * ink-per-cell ratio at 1.18 on a four-to-one field where it should be 1.00,
 * growing with the tone ratio as a pull toward sqrt(mass) would.
 *
 * So this is a look control that trades the placer's headline property for
 * arrangement, and it defaults to zero everywhere it is offered;
 * tests/spine.subdivide.js says what a given number of steps costs.
 *
 * The Lloyd updates are centroids and draw from the RNG not at all. The jitter
 * that must precede them does — seeded, so a relaxed subdivision is reproducible,
 * but no longer the same drawing at every seed.
 *
 * With a metric this becomes anisotropic Lloyd, and two things are worth knowing.
 *
 * The update itself does not change. Minimising sum m(p) (p-s)^T M (p-s) over s
 * gives M * sum m(p) (p-s) = 0, and M is invertible, so it cancels and the answer
 * is the plain mass-weighted Euclidean centroid — for any invertible M, not
 * because det M = 1. The metric enters only through which pixels a site owns.
 *
 * The metric is frozen for the run, as a correctness requirement rather than an
 * optimisation: the centroid is the argmin only while M is held fixed, and
 * re-sampling the field at each site's new position adds a dM/ds term the update
 * silently drops, so the iteration stops being a descent step for any energy at
 * all. At SETTLE_TOL = 0.05 px the sites barely move, so a frozen metric is never
 * meaningfully stale.
 *
 * Damping and the step clamp bound the case where an anisotropic cell is
 * non-convex or disconnected and its centroid lands in a gap owned by someone
 * else. Both are inert at alpha = 1 and an infinite clamp, which is what the
 * isotropic path passes.
 *
 * @returns {{worst:number[], mean:number[], nAbove:number[]}} per-iteration
 *          movement — the harness's only window onto whether the relaxation is
 *          converging or merely running.
 */
export function relaxSeeds(ctx, inside, massOf, sx, sy, iterations, opts = {}) {
  const { nx, ny } = ctx;
  const n = sx.length;
  const trace = { worst: [], mean: [], nAbove: [] };
  if (n === 0 || iterations <= 0) return trace;
  const metric = opts.metric ?? null;
  const alpha = opts.damping ?? 1;
  const maxStep = opts.maxStep ?? Infinity;
  // Neither damped nor clamped: take the original assignment, bit for bit.
  const plain = alpha === 1 && !(maxStep < Infinity);
  const a0 = new Float64Array(n), a1x = new Float64Array(n), a1y = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const label = nearestSeedMap(nx, ny, inside, sx, sy, n, metric);
    a0.fill(0); a1x.fill(0); a1y.fill(0);
    for (let c = 0; c < label.length; c++) {
      const s = label[c];
      if (s < 0) continue;
      const m = massOf(c);
      a0[s] += m; a1x[s] += m * ((c % nx) + 1); a1y[s] += m * (Math.floor(c / nx) + 1);
    }
    let worst = 0, sum = 0, above = 0;
    for (let i = 0; i < n; i++) {
      // A seed that claimed no mass has no centroid to move to; leaving it put
      // keeps the count exact, where dropping it would be the one way this pass
      // could destroy a point. Under anisotropy a site that loses all its mass
      // to a neighbour's elongated cell freezes here permanently — still counted,
      // no longer participating — which the damping and clamp exist to prevent.
      if (!(a0[i] > 0)) continue;
      const cx = a1x[i] / a0[i], cy = a1y[i] / a0[i];
      let moved;
      if (plain) {
        // The undamped path assigns rather than adds: `sx[i] + (cx - sx[i])` is
        // not bitwise `cx`, and writing the increment here would move every
        // existing relaxed drawing by an ulp.
        moved = Math.hypot(cx - sx[i], cy - sy[i]);
        sx[i] = cx; sy[i] = cy;
      } else {
        let dx = (cx - sx[i]) * alpha, dy = (cy - sy[i]) * alpha;
        const step = Math.hypot(dx, dy);
        if (step > maxStep) { const k = maxStep / step; dx *= k; dy *= k; }
        moved = Math.hypot(dx, dy);
        sx[i] += dx; sy[i] += dy;
      }
      if (moved > worst) worst = moved;
      sum += moved;
      if (moved > SETTLE_TOL) above++;
    }
    trace.worst.push(worst);
    trace.mean.push(n > 0 ? sum / n : 0);
    trace.nAbove.push(above);
    if (worst < SETTLE_TOL) break;
  }
  return trace;
}

/**
 * Anisotropic Lloyd over an existing point set, in place.
 *
 * A post-placement pass rather than a fifth placer: the metric belongs to the
 * relaxation and not to how the points were first laid down, so every placement
 * can be aligned and none of them has to know the metric exists.
 *
 * It also has to be a separate pass to be visible at all. The only relaxation
 * inside `stipplePoints` is the k = 3 local k-means within one subdivision cell,
 * where the hierarchy decides arrangement and three seeds have almost nothing to
 * say about it, and `placedStipple` passes no perimeter ring, so the pinned
 * polish never runs either.
 *
 * @param {Float64Array} sx,sy  mutated in place; count is never changed
 * @param {object} opts
 * @param {Float64Array} opts.field    mass per pixel, as the placers take it
 * @param {number} opts.strength       signed [-1, +1]; 0 must not reach here
 * @param {number} opts.iterations     Lloyd steps
 * @param {number} opts.spacing        mean point spacing, px -- sets both the
 *        tensor smoothing scale and the step clamp
 * @returns {{worst,mean,nAbove:number[]}} per-iteration movement trace
 *
 * Gated on iterations, not on strength. At strength 0 the metric is the identity
 * and this is an ordinary damped Lloyd polish, which is worth having on its own:
 * measured, it cuts the dot-overlap shortfall 4.6x at coverage 0.7 and 36x at
 * 0.45, because evening the spacing puts ink the budget already counted back on
 * the paper. Strength decides only whether the metric is anisotropic; iterations
 * decide whether anything runs.
 */
export function alignPoints(ctx, sx, sy, opts = {}) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const field = opts.field ?? null;
  const strength = opts.strength ?? 0;
  const iterations = Math.max(0, Math.round(opts.iterations ?? 0));
  const spacing = Math.max(1, opts.spacing ?? 1);
  if (iterations === 0 || sx.length === 0) return { worst: [], mean: [], nAbove: [] };

  // Frozen for the whole run — see relaxSeeds on why that is correctness rather
  // than thrift — and smoothed at the point spacing rather than the pen width.
  // Null at strength 0, so the isotropic case takes nearestSeedMap's Euclidean
  // path rather than an identity metric it would have to multiply through.
  const metric = strength !== 0
    ? siteMetrics(ctx, sx, sy, sx.length, strength, spacing)
    : null;

  const inside = polygonMask(nx, ny, px, py);
  const massOf = (c) => (field ? Math.max(0, field[c]) : 1);

  return relaxSeeds(ctx, inside, massOf, sx, sy, iterations, {
    metric,
    // Half-steps and a cap at a third of a spacing. An anisotropic cell can be
    // non-convex or disconnected, so an undamped centroid can sit in a gap owned
    // by someone else and the site teleports; these bound that without the cost
    // of restricting each centroid to its own connected component.
    damping: 0.5,
    maxStep: spacing / 3,
  });
}

/**
 * The pinned polish, shared by both placers.
 *
 * A placer knows nothing about the perimeter ring, so the interior points
 * nearest the border are placed as if the page went on forever. A short flat
 * relaxation with the ring pinned settles that interface: the ring shapes its
 * neighbours' cells without moving itself.
 *
 * It must not touch the interior. Flat mass-weighted Lloyd has its fixed point
 * at the Gersho distribution field^(1/2) — precisely the distribution the
 * subdivider exists to avoid — so every step drags seeds back toward it. Seeds
 * cannot be created or destroyed, but they can drift across a tone boundary, and
 * eight unrestricted steps put the ink-per-cell ratio at 1.18 on a four-to-one
 * field where it should be 1.00. Restricting the polish to seeds within a few
 * spacings of the polygon edge does its actual job and removes the drift: the
 * interior keeps the counts the placer gave it.
 *
 * Points are moved, never created or destroyed, which is what lets
 * `subdividePoints` run it and still deliver its exact count.
 */
export function withPinnedPolish(ctx, inside, massOf, outX, outY, opts) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const ring = opts.seeds0;
  const pinned = ring ? ring.sx.length : 0;
  const n = pinned + outX.length;
  const sx = new Float64Array(n), sy = new Float64Array(n);
  for (let i = 0; i < pinned; i++) { sx[i] = ring.sx[i]; sy[i] = ring.sy[i]; }
  for (let i = 0; i < outX.length; i++) { sx[pinned + i] = outX[i]; sy[pinned + i] = outY[i]; }

  const moved = [];
  const nPolish = Math.max(0, Math.round(opts.polish ?? 8));
  if (n > 0 && nPolish > 0 && pinned > 0) {
    // How far in the polish reaches. Three spacings is enough for the ring's
    // influence to have died away -- a pinned point only distorts its immediate
    // neighbours and their neighbours -- and short enough that the bulk of the
    // interior is never touched.
    const areaEst = (nx - 1) * (ny - 1);
    const reach = 3 * Math.sqrt(areaEst / Math.max(1, n));
    const movable = new Uint8Array(n);
    for (let i = pinned; i < n; i++) {
      let best = Infinity;
      for (let e = 0; e < px.length; e++) {
        const f = (e + 1) % px.length;
        best = Math.min(best, Math.sqrt(distToSegmentSq(sx[i], sy[i], px[e], py[e], px[f], py[f])));
      }
      movable[i] = best <= reach ? 1 : 0;
    }

    const a0 = new Float64Array(n), a1x = new Float64Array(n), a1y = new Float64Array(n);
    for (let it = 0; it < nPolish; it++) {
      const label = nearestSeedMap(nx, ny, inside, sx, sy, n);
      a0.fill(0); a1x.fill(0); a1y.fill(0);
      for (let c = 0; c < label.length; c++) {
        const s = label[c];
        if (s < 0) continue;
        const m = massOf(c);
        a0[s] += m; a1x[s] += m * ((c % nx) + 1); a1y[s] += m * (Math.floor(c / nx) + 1);
      }
      let worst = 0;
      for (let i = pinned; i < n; i++) {
        if (!movable[i] || !(a0[i] > 0)) continue;
        const cx = a1x[i] / a0[i], cy = a1y[i] / a0[i];
        worst = Math.max(worst, Math.hypot(cx - sx[i], cy - sy[i]));
        sx[i] = cx; sy[i] = cy;
      }
      moved.push(worst);
      if (worst < SETTLE_TOL) break;
    }
  }
  return { sx, sy, moved };
}
