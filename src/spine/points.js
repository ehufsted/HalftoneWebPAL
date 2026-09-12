// The point placers: three ways to scatter points at a density the image asks
// for, behind one contract.
//
// The relaxation machinery they share is in relax.js; the region tilers that
// consume them are in regions.js.
//
// They are not interchangeable in a released drawing, and docs/architecture.md
// says so at length: `stipplePoints` (local k-means per cell, seeded) is the
// calibrated default and every constant in the methods offering it was measured
// against the point set it produces; `bestCandidatePoints` is the only
// progressive one, so a count slider adds points at the margin rather than
// re-rolling the drawing; `subdividePoints` is exact in its count and draws from
// the RNG zero times, at the cost of leaving flat tone on a two-aspect lattice.
// Their density guarantees differ in kind — the subdivider constructs it, the
// other two approach it — so the harness holds them to different bars.

import { polygonMask } from './mask.js';
import { boundsOfPolygon } from './polygon.js';
import { interpTable } from './interp.js';
import { mulberry32 } from './random.js';
import { relaxSeeds, withPinnedPolish } from './relax.js';

// ------------------------------------------------------- placing the points
//
// Uniform ink per cell is not what plain Lloyd gives, which is why every placer
// here subdivides by mass instead.
//
// Moving each seed to the darkness-weighted centroid of its cell converges to a
// centroidal Voronoi tessellation, whose fixed point obeys the Gersho/Zador law:
// seed density goes as rho^(d/(d+2)), in two dimensions rho^(1/2). Cell area then
// goes as rho^(-1/2) and ink per cell as rho^(1/2) — a cell in a region four
// times darker holds twice the ink, not the same amount. Relaxing on rho^2
// instead puts the fixed point at rho, but the relaxation cannot reach it in any
// reasonable number of iterations: a seed in the bulk of a flat region already
// sits at its cell centroid and has nothing pushing it anywhere. Measured, on a
// two-tone field the exponent sat at 0.75e after sixty iterations, midway between
// the initialisation and the answer.
//
// Splitting by mass top down needs no convergence at all: counts are right at
// every level and Lloyd is left with only the local arrangement, so the Gersho
// exponent does not arise.
//
// If ink per cell ever needs to be exact rather than near-exact, the remaining
// option is a capacity-constrained power diagram: give each seed an additive
// weight, use |p-s|^2 - w_s, and drive the weights until every cell holds the
// mean. Cells stay convex so nothing downstream changes, and `clipHalfPlane`
// already takes an arbitrary boundary line.

/**
 * How many pieces a cell splits into per level. Fixed, not a control.
 *
 * It sets the tree depth (log_nSplit of the point count) and nothing else that
 * matters: counts are exact at every level whatever it is, because they come from
 * mass rather than from relaxation. Smaller means a deeper tree and more passes
 * over the pixels; larger means each local Lloyd has more seeds to settle. No
 * accuracy argument either way, which is why it is not exposed.
 */
const N_SPLIT = 3;

/**
 * Points at a prescribed density, by recursive mass subdivision.
 *
 * Port of singleWidthLines/code/pointsSubdivideStipple.m.
 *
 * A cell splits into N_SPLIT children by mass, top down, so the number of points
 * in every region is right by construction at every level; Lloyd runs only inside
 * a cell, over three seeds and that cell's own pixels, where a handful of
 * iterations is enough because local arrangement is all it has to do. The
 * hierarchy does the global work and Lloyd the local work, and neither is asked
 * to do the other job — see the note above on why flat Lloyd cannot.
 *
 * Cost is one pass over the pixels per level, with log_3(count) levels.
 *
 * Two consequences for callers. There is no density exponent: the count in a
 * region is its mass, so point density is proportional to `field` directly, and
 * `field` means exactly "how many points per pixel I want, up to a scale". And no
 * point is emitted where the field is zero — no ink, no point — so a caller
 * needing the whole polygon covered whatever the image does, as a region tiler
 * does, must supply its own floor.
 *
 * @param {object} opts
 * @param {Float64Array} opts.field  desired points per pixel, any scale
 * @param {number} opts.count        total points wanted (interior only)
 * @param {number} [opts.iterations] local Lloyd steps per split
 * @param {number} [opts.polish]     final pinned relaxation steps, see below
 * @param {{sx:number[],sy:number[]}} [opts.seeds0] points to pin, placed first
 * @returns {{sx:Float64Array, sy:Float64Array, moved:number[]}} `moved` is the
 *          worst movement at each POLISH step; the subdivision itself has no
 *          per-iteration movement to report.
 */
export function stipplePoints(ctx, opts = {}) {
  // The binary subdivider is a second placer behind this same contract. It is
  // opt-in and nothing selects it yet: the default path below is the calibrated
  // one, every constant in the app was measured against it, and switching a
  // caller re-rolls that method's whole realisation.
  if (opts.mode === 'subdivide') return subdividePoints(ctx, opts);
  if (opts.mode === 'bestCandidate') return bestCandidatePoints(ctx, opts);

  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const field = opts.field ?? null;
  const nIter = Math.max(1, Math.round(opts.iterations ?? 6));
  const rand = mulberry32(Math.round(opts.seed ?? 1));
  const massOf = (c) => (field ? Math.max(0, field[c]) : 1);

  const inside = polygonMask(nx, ny, px, py);   // shared and cached; read-only
  const idx0 = [];
  let total = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!inside[c]) continue;
      const m = massOf(c);
      if (!(m > 0)) continue;
      idx0.push(c);
      total += m;
    }
  }

  const want = Math.max(1, Math.round(opts.count ?? 100));
  const outX = [], outY = [];
  if (total > 0 && idx0.length > 0) {
    const massPerPoint = total / want;
    const centroid = (cell) => {
      let m0 = 0, mx = 0, my = 0;
      for (let i = 0; i < cell.length; i++) {
        const c = cell[i], m = massOf(c);
        m0 += m; mx += m * ((c % nx) + 1); my += m * (Math.floor(c / nx) + 1);
      }
      return m0 > 0 ? [mx / m0, my / m0] : null;
    };

    // Depth first, popping from the end, exactly as the source does
    // (`i = numel(pts)`). The order is not arbitrary: it fixes the sequence in
    // which the RNG is drawn from, and the call sequence is the invariant that
    // keeps this app reproducible. See spine/random.js.
    const stack = [Int32Array.from(idx0)];
    while (stack.length > 0) {
      const cell = stack.pop();
      let S = 0;
      for (let i = 0; i < cell.length; i++) S += massOf(cell[i]);
      const k = Math.min(N_SPLIT, Math.round(S / massPerPoint));
      if (k <= 1 || cell.length < k) {
        const c = centroid(cell);
        if (c) { outX.push(c[0]); outY.push(c[1]); }
        continue;
      }

      const vx = new Float64Array(k), vy = new Float64Array(k);
      for (let j = 0; j < k; j++) {
        const c = cell[Math.min(cell.length - 1, Math.floor(rand() * cell.length))];
        vx[j] = (c % nx) + 1; vy[j] = Math.floor(c / nx) + 1;
      }

      const lab = new Int32Array(cell.length);
      const m0 = new Float64Array(k), m1x = new Float64Array(k), m1y = new Float64Array(k);
      for (let it = 0; it <= nIter; it++) {
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          const qx = (c % nx) + 1, qy = Math.floor(c / nx) + 1;
          let best = 0, bd = Infinity;
          for (let j = 0; j < k; j++) {
            const dx = vx[j] - qx, dy = vy[j] - qy;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = j; }
          }
          lab[i] = best;
        }
        if (it === nIter) break;
        m0.fill(0); m1x.fill(0); m1y.fill(0);
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i], m = massOf(c), j = lab[i];
          m0[j] += m; m1x[j] += m * ((c % nx) + 1); m1y[j] += m * (Math.floor(c / nx) + 1);
        }
        for (let j = 0; j < k; j++) {
          if (m0[j] > 0) { vx[j] = m1x[j] / m0[j]; vy[j] = m1y[j] / m0[j]; }
        }
      }

      const counts = new Int32Array(k);
      for (let i = 0; i < cell.length; i++) counts[lab[i]]++;
      let nonEmpty = 0;
      for (let j = 0; j < k; j++) if (counts[j] > 0) nonEmpty++;
      // Termination: if the local relaxation collapses every pixel onto one
      // seed, pushing the result back would push the same cell again forever.
      // A cell that cannot be split is a leaf whatever its mass says.
      if (nonEmpty <= 1) {
        const c = centroid(cell);
        if (c) { outX.push(c[0]); outY.push(c[1]); }
        continue;
      }
      const subs = [];
      for (let j = 0; j < k; j++) subs.push(new Int32Array(counts[j]));
      const fill = new Int32Array(k);
      for (let i = 0; i < cell.length; i++) {
        const j = lab[i];
        subs[j][fill[j]++] = cell[i];
      }
      for (let j = 0; j < k; j++) if (subs[j].length > 0) stack.push(subs[j]);
    }
  }

  return withPinnedPolish(ctx, inside, massOf, outX, outY, opts);
}

/**
 * Jitter applied before relaxation, as a fraction of the leaf cell's own size.
 *
 * Without it the relaxation largely does nothing: a regular lattice is a fixed
 * point of Lloyd, since on uniform mass each point already sits at the centroid
 * of its own Voronoi cell, so the flat-tone grid survives any number of
 * iterations. Breaking the symmetry first gives the relaxation something to push
 * against, and it settles into an even organic packing instead.
 *
 * A quarter of the cell: big enough that no point stays on the lattice, small
 * enough that a jittered point remains inside the cell it was allocated to —
 * enforced by the clamp, not hoped for — so the placement's density survives as
 * the starting condition rather than arriving already smeared across a tone
 * boundary.
 *
 * Applied per axis, so a 2:1 cell is jittered twice as far along its long side,
 * keeping the displacement proportional to the local spacing in each direction.
 */
const JITTER_FRACTION = 0.25;

/**
 * The UI control that chooses between the placers, defined once here because
 * five methods offer it and the option it sets belongs to this module. The
 * labels name what you get rather than the algorithm, and they are the only
 * explanation the user gets of a genuinely subtle choice.
 *
 * "Relaxed" is the calibrated default; every measured constant in the app was
 * taken against it.
 *
 * @param {(params: object) => boolean} [when] optional visibility gate, for the
 *        methods where the placer only applies to some of their tilers
 */
export function placerParam(when) {
  return {
    key: 'placer', label: 'Point placer', type: 'select', def: 'lloyd',
    options: [
      { value: 'lloyd', label: 'Relaxed — organic spacing' },
      { value: 'bestCandidate', label: 'Blue noise — even, never periodic' },
      { value: 'subdivide', label: 'Subdivided — exact count, faster' },
    ],
    when,
  };
}

/**
 * True when the placer control is set to the box subdivider.
 *
 * The methods pass `mode: ctx.placer` straight through and `stipplePoints` tests
 * for one value at a time, so an absent or unrecognised setting is the default
 * rather than an error. This exists for the `when` gates, which need to hide the
 * seed control the subdivider has no use for.
 */
export const usesSubdivide = (params) => params.placer === 'subdivide';

/**
 * True when the placer runs local Lloyd relaxation, which only the default does.
 *
 * Not the same test as `!usesSubdivide`: the iteration-count controls belong to
 * the relaxed placer alone, since the subdivider has no relaxation and
 * best-candidate gets its arrangement from the max-min rule rather than by
 * settling.
 */
export const usesRelaxation = (params) => (params.placer ?? 'lloyd') === 'lloyd';

/**
 * Inclusive-box sums of mass and of mass-weighted position, each in O(1).
 *
 * Three integral images, because the subdivider needs a cell's mass to allocate
 * points and its first moments to place them, and both are wanted at every node
 * of a tree with as many nodes as there are points.
 */
function massIntegrals(nx, ny, mass) {
  const iw = nx + 1;
  const S = new Float64Array(iw * (ny + 1));
  const Sx = new Float64Array(iw * (ny + 1));
  const Sy = new Float64Array(iw * (ny + 1));
  for (let iy = 0; iy < ny; iy++) {
    let r0 = 0, rx = 0, ry = 0;
    for (let ix = 0; ix < nx; ix++) {
      const m = mass[iy * nx + ix];
      r0 += m; rx += m * (ix + 1); ry += m * (iy + 1);   // 1-based pixel centres
      const k = (iy + 1) * iw + (ix + 1), up = iy * iw + (ix + 1);
      S[k] = S[up] + r0;
      Sx[k] = Sx[up] + rx;
      Sy[k] = Sy[up] + ry;
    }
  }
  const box = (T, x0, y0, x1, y1) =>
    T[(y1 + 1) * iw + (x1 + 1)] - T[y0 * iw + (x1 + 1)]
    - T[(y1 + 1) * iw + x0] + T[y0 * iw + x0];
  return {
    m: (x0, y0, x1, y1) => box(S, x0, y0, x1, y1),
    mx: (x0, y0, x1, y1) => box(Sx, x0, y0, x1, y1),
    my: (x0, y0, x1, y1) => box(Sy, x0, y0, x1, y1),
  };
}

/**
 * Points at a prescribed density, by recursive binary subdivision of the raster.
 *
 * Port of singleWidthLines/code/regionsDitherQuadtree.m, as a second placer
 * behind the same `{ field, count }` contract as `stipplePoints`. Reach it with
 * `stipplePoints(ctx, { mode: 'subdivide', ... })` or by calling this directly.
 *
 * Next to the Lloyd placer: both are recursive mass subdivision and both get
 * density right by construction, but this one splits an axis-aligned box rather
 * than running a local k-means inside each cell, making it O(1) per node instead
 * of O(pixels x iterations) and — at its default settings — drawing from the RNG
 * exactly zero times. What it gives up is arrangement; see the artefact note at
 * the bottom.
 *
 * The RNG claim is conditional on `relax` being 0, which it is by default. Above
 * zero the softening pass jitters before it relaxes, seeded from `opts.seed`, so
 * the result stays reproducible but is no longer independent of the seed.
 * Placement itself never draws.
 *
 * The count is exact, which is the reason to have it: rescale the darkness field
 * so the total is a whole number of dots, then apportion by largest remainder at
 * every node — floor each child, hand the surplus to the child with the biggest
 * fraction. The count cannot drift at any level, so exactly `count` interior
 * points come back rather than something near it.
 *
 * No mutated field is needed. Renormalising the darkness inside every child gives
 * a factor `nPts*kDot/S(cell)` over a sum of the original field, so the inherited
 * factor cancels and a static integral image answers every query. The centroid
 * needs it even less: `sum(K2*x)/sum(K2)` cancels the factor exactly, so first
 * moments come off two more integral images.
 *
 * Binary on the longer axis rather than a quadtree. A quadtree without a padded
 * power-of-two square raster gives every cell the page's aspect ratio, so a 4:1
 * page puts flat tone on a 4:1 lattice. Splitting the longer side bounds the
 * aspect at 2 on any page, with the same exactness and cost and no padding. It
 * bounds the aspect; it does not make cells square, and on a nearly-square page
 * it is the weaker choice.
 *
 * Ties break by index, deliberately — see the determinism trap in
 * docs/architecture.md. Diffing against the MATLAB, note that it sorted
 * column-major where this splits in two, so ties land differently.
 *
 * @param {object} opts
 * @param {Float64Array} opts.field  desired points per pixel, any scale
 * @param {number} opts.count        total points wanted; delivered exactly
 * @param {boolean} [opts.centreOfMass]  default true, see below
 * @param {number} [opts.relax]      Lloyd steps over ALL points, default 0. Trades
 *                                   this placer's density accuracy for a softer
 *                                   arrangement -- see relaxSeeds. The count is
 *                                   unaffected.
 * @param {number} [opts.polish]     final pinned relaxation steps
 * @param {{sx:number[],sy:number[]}} [opts.seeds0] points to pin, placed first
 * @returns {{sx:Float64Array, sy:Float64Array, moved:number[]}}
 */
export function subdividePoints(ctx, opts = {}) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const field = opts.field ?? null;
  const massOf = (c) => (field ? Math.max(0, field[c]) : 1);
  const useCM = opts.centreOfMass !== false;

  const inside = polygonMask(nx, ny, px, py);

  // Mass, zeroed outside the polygon. Masking before the allocation rather than
  // discarding stray points afterwards is what makes the `sum(nPts) == N`
  // identity true of the output and not merely of the allocation.
  const mass = new Float64Array(nx * ny);
  let total = 0, live = 0;
  for (let c = 0; c < mass.length; c++) {
    if (!inside[c]) continue;
    const m = massOf(c);
    if (!(m > 0)) continue;
    mass[c] = m; total += m; live++;
  }

  const relax = Math.max(0, Math.round(opts.relax ?? 0));
  const outX = [], outY = [];
  // Leaf boxes, recorded ONLY when they will be used. The jitter needs each
  // point's own cell to size its displacement and to clamp it, and there is no
  // reason to build the array on the default path that never jitters.
  const outBox = relax > 0 ? [] : null;
  const noteBox = (x0, y0, x1, y1) => {
    if (outBox) outBox.push(x0, y0, x1, y1);
  };
  if (total > 0 && live > 0) {
    // Capped at the number of pixels that could hold a point. Above that the
    // raster cannot express the request at all; the Lloyd placer runs into the
    // same wall through `cell.length < k` and also quietly delivers fewer.
    const want = Math.max(1, Math.min(live, Math.round(opts.count ?? 100)));
    const I = massIntegrals(nx, ny, mass);

    // A cell is its box plus the integer number of points owed to it. Depth
    // first, popping from the end, as the source and `stipplePoints` both do.
    const stack = [[0, 0, nx - 1, ny - 1, want]];
    while (stack.length > 0) {
      const [x0, y0, x1, y1, n] = stack.pop();
      if (n <= 0) continue;

      const wCell = x1 - x0 + 1, hCell = y1 - y0 + 1;

      if (n === 1) {
        const m0 = I.m(x0, y0, x1, y1);
        if (useCM && m0 > 0) {
          // Centre of mass, which acts at edges and nowhere else.
          //
          // Measured at 800 points on a 360x270 page. On a flat field it moves
          // nothing at all — uniform mass puts the centroid on the box centre,
          // so the displacement is exactly 0.000. On a smooth gradient it moves
          // 0.115 px against a 9.0 px spacing, 1.2%, because a leaf spans about
          // 11 px and the field changes ~4.5% across it. On a step of 8:1 the
          // cells within one spacing of the discontinuity move 0.809 px against
          // an 8.06 px spacing, 10%, while the average over every cell reads
          // 0.049 — and those two reconcile exactly (48 * 0.809 / 800 = 0.0485),
          // so cells away from the step contribute essentially nothing.
          //
          // The cost is 0.5% on the nearest-neighbour spread (4.581 against
          // 4.559): pulling a point toward the dark side of an edge makes it
          // slightly less evenly spaced against its neighbours.
          outX.push(I.mx(x0, y0, x1, y1) / m0);
          outY.push(I.my(x0, y0, x1, y1) / m0);
        } else {
          outX.push((x0 + x1) / 2 + 1);
          outY.push((y0 + y1) / 2 + 1);
        }
        noteBox(x0, y0, x1, y1);
        continue;
      }

      if (wCell === 1 && hCell === 1) {
        // One pixel owing several points, reachable whenever the field is spiky
        // enough that a single pixel holds more than two points' worth of mass.
        // Dropping the surplus would break the count identity this placer exists
        // for, so they go on a lattice inside the pixel: distinct positions,
        // exact count, and a shape that says plainly what happened.
        const k = Math.ceil(Math.sqrt(n));
        for (let i = 0; i < n; i++) {
          const a = i % k, b = Math.floor(i / k);
          outX.push(x0 + 0.5 + (a + 0.5) / k);
          outY.push(y0 + 0.5 + (b + 0.5) / k);
          noteBox(x0, y0, x1, y1);
        }
        continue;
      }

      // Split the longer side; ties go to x. Same arithmetic as quadHalftone's
      // `mw = round((bw + 2) / 2) - 1`, so the two quadtrees agree about where
      // an odd cell divides.
      const splitX = wCell >= hCell;
      const half = splitX ? (wCell + 1) >> 1 : (hCell + 1) >> 1;
      const aBox = splitX ? [x0, y0, x0 + half - 1, y1] : [x0, y0, x1, y0 + half - 1];
      const bBox = splitX ? [x0 + half, y0, x1, y1] : [x0, y0 + half, x1, y1];

      const sA = I.m(aBox[0], aBox[1], aBox[2], aBox[3]);
      const sB = I.m(bBox[0], bBox[1], bBox[2], bBox[3]);
      const sum = sA + sB;
      // Unreachable: a cell only receives points from a parent that saw mass in
      // it, and the child re-reads that mass from the same integral image, so
      // the two agree bit for bit. Kept because were it ever to fire the points
      // owed here would vanish, and the harness checks the count identity with
      // no tolerance, so the failure would be loud.
      if (!(sum > 0)) continue;
      const fA = (n * sA) / sum, fB = n - fA;
      let nA = Math.floor(fA), nB = Math.floor(fB);
      const rA = fA - nA, rB = fB - nB;
      // Largest remainder. The surplus is 0 or 1, and it may only go to a child
      // that has mass -- without that guard an empty child with remainder 0 can
      // win the comparison against a full one and be handed a point it has
      // nowhere to put.
      let surplus = n - nA - nB;
      while (surplus > 0) {
        if (sA > 0 && (!(sB > 0) || rA >= rB) && nA < n) nA++;
        else if (sB > 0) nB++;
        else break;
        surplus--;
      }

      stack.push([bBox[0], bBox[1], bBox[2], bBox[3], nB]);
      stack.push([aBox[0], aBox[1], aBox[2], aBox[3], nA]);
    }
  }

  // Optional softening of the lattice, off by default. It preserves the count
  // and costs density -- see relaxSeeds, which is where the trade is written
  // down. Run before the pinned polish, in the same order the Lloyd placer's
  // own arrangement work happens before it.
  if (relax > 0 && outX.length > 0) {
    const rx = Float64Array.from(outX), ry = Float64Array.from(outY);

    // Jitter first, or the relaxation has nothing to do — see JITTER_FRACTION.
    // Seeded, and clamped into each point's own leaf box so no point can cross
    // into a neighbouring cell before the relaxation has run once, which is what
    // keeps the starting density the one the placement produced.
    const rand = mulberry32(Math.round(opts.seed ?? 1));
    for (let i = 0; i < rx.length; i++) {
      const b = i * 4;
      const x0 = outBox[b], y0 = outBox[b + 1], x1 = outBox[b + 2], y1 = outBox[b + 3];
      const dx = (rand() * 2 - 1) * JITTER_FRACTION * (x1 - x0 + 1);
      const dy = (rand() * 2 - 1) * JITTER_FRACTION * (y1 - y0 + 1);
      rx[i] = Math.min(x1 + 1.5, Math.max(x0 + 0.5, rx[i] + dx));
      ry[i] = Math.min(y1 + 1.5, Math.max(y0 + 0.5, ry[i] + dy));
    }

    relaxSeeds(ctx, inside, massOf, rx, ry, relax);
    return withPinnedPolish(ctx, inside, massOf, rx, ry, opts);
  }
  return withPinnedPolish(ctx, inside, massOf, outX, outY, opts);
}

// The artefact this placer leaves on flat tone, and the reason to keep the other
// two.
//
// It is not a single lattice: at 800 points on a 360x270 page the
// nearest-neighbour distances have mean 9.34 and sd 1.485, a 16% spread where a
// lattice would be near zero. The mean identifies it. At that density the area
// per point is 121.5 px, so a square lattice would sit at sqrt(121.5) = 11.02 and
// a 2:1 one at sqrt(121.5/2) = 7.79 along its short axis. The measurement lands
// between them, because a binary split alternates axes and the recursion stops at
// n = 1 wherever it happens to be in that alternation — so the leaves are two
// interleaved lattices, roughly-square and roughly-2:1 boxes mixed.
//
// That also settles what splitting the longer side buys: an aspect ratio bounded
// at 2 rather than square cells. It is the best a binary split can do, and it is
// what makes the rule robust on a 4:1 page where a quadtree would give every cell
// a 4:1 aspect. On a nearly-square page — 360x270 being exactly that — it is the
// weaker choice, so the figures above are near this rule's worst case.
//
// Centre of mass cannot break it up: uniform mass puts the centroid on the box
// centre, so on flat tone it moves nothing at all and on a smooth gradient 1.2%
// of a spacing. The lattice is what this placer costs on flat tone, permanently,
// and the answer is the Lloyd placer where that matters.

/**
 * Candidates drawn per placed point. Mitchell's own figure, and the only free
 * parameter in the placer below: it trades arrangement quality against time and
 * nothing else. Left as a constant rather than a slider until the sweep in
 * tests/spine.bestCandidate.js says the difference is worth a control.
 */
const BEST_CANDIDATE_K = 10;

/**
 * Points at a prescribed density, by Mitchell's best-candidate rule.
 *
 * Blue noise, which neither of the other placers produces: Lloyd converges toward
 * hexagonal patches and reads as texture, and the subdivider leaves a lattice.
 * This one is even without being periodic, which is what a hand-placed stipple
 * looks like.
 *
 * To place each point, draw k candidates from the field's own distribution, keep
 * the one farthest from everything already placed, repeat.
 *
 * Two details make it correct rather than nearly so. The score is distance
 * normalised by the local target spacing: raw distance always favours the light
 * regions, whose points are further apart, so every candidate there wins and the
 * density comes out inverted. Dividing by sqrt(massPerPoint / mass) makes a
 * candidate at 0.9 of its own local spacing score the same in shadow as in
 * highlight. And candidates are drawn from the field's CDF, which is what makes
 * the proposal density right; the normalised max-min only adds the blue-noise
 * rejection on top.
 *
 * Density is approached, not constructed, which is the honest difference from
 * `subdividePoints`: no step hands a region its exact share, but a region that
 * has fallen behind has larger normalised distances and wins candidates more
 * often until it catches up. The harness measures how close it gets rather than
 * asserting an identity.
 *
 * The count is exact, because the loop simply places `want` of them.
 *
 * And it is progressive, which comes for free: `massPerPoint` is a global
 * constant, so it divides every score equally and cannot change which candidate
 * wins. The chosen sequence is identical whatever `count` is asked for, so a run
 * of 400 points is a bit-for-bit prefix of a run of 1200 and dragging the count
 * slider adds and removes points at the margin instead of re-rolling the drawing.
 * That rests on two things: the RNG is drawn from a fixed number of times per
 * point (exactly 3k), and `nearestD2` is an exact nearest-neighbour query rather
 * than an approximation, since the grid it searches is sized from `want`.
 *
 * @param {object} opts
 * @param {Float64Array} opts.field  desired points per pixel, any scale
 * @param {number} opts.count        total points wanted; delivered exactly
 * @param {number} [opts.candidates] candidates per point, default 10
 * @param {number} [opts.seed]       seeded; unlike the subdivider this one draws
 * @param {number} [opts.polish]     final pinned relaxation steps
 * @param {{sx:number[],sy:number[]}} [opts.seeds0] points to pin, placed first
 * @returns {{sx:Float64Array, sy:Float64Array, moved:number[]}}
 */
export function bestCandidatePoints(ctx, opts = {}) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const field = opts.field ?? null;
  const massOf = (c) => (field ? Math.max(0, field[c]) : 1);
  const inside = polygonMask(nx, ny, px, py);

  // Live pixels and the running mass total over them, which is the CDF the
  // candidates are drawn from. Zero-mass pixels are left out entirely rather
  // than given zero width, so a sample can never land on one.
  const idx = [];
  const cum = [];
  let total = 0;
  for (let c = 0; c < nx * ny; c++) {
    if (!inside[c]) continue;
    const m = massOf(c);
    if (!(m > 0)) continue;
    total += m;
    idx.push(c);
    cum.push(total);
  }
  const live = idx.length;

  const outX = [], outY = [];
  if (total > 0 && live > 0) {
    const want = Math.max(1, Math.min(live, Math.round(opts.count ?? 100)));
    const k = Math.max(1, Math.round(opts.candidates ?? BEST_CANDIDATE_K));
    const rand = mulberry32(Math.round(opts.seed ?? 1));
    const massPerPoint = total / want;
    const idxA = Int32Array.from(idx);
    const cumA = Float64Array.from(cum);

    const samplePixel = () => {
      const t = rand() * total;
      let lo = 0, hi = live - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumA[mid] < t) lo = mid + 1; else hi = mid;
      }
      return idxA[lo];
    };

    // Uniform grid over the placed points, built incrementally. Sized from the
    // mean spacing, which is only a speed choice -- the query below is exact.
    const cellSize = Math.max(1, Math.sqrt((nx * ny) / want));
    const gw = Math.max(1, Math.ceil(nx / cellSize));
    const gh = Math.max(1, Math.ceil(ny / cellSize));
    const bins = new Array(gw * gh).fill(null);
    const cellOf = (x, y) => {
      const gx = Math.min(gw - 1, Math.max(0, Math.floor((x - 1) / cellSize)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor((y - 1) / cellSize)));
      return gy * gw + gx;
    };

    /**
     * Squared distance to the nearest placed point — exact, not approximate,
     * because the grid is sized from `want` and an approximation would make the
     * answer depend on the count, costing the progressive property. Same ring
     * bound as pathOptimizer's EndpointGrid: a point in ring r is at least
     * (r-1) cells away along one axis, so once that exceeds the best found, no
     * later ring can beat it.
     */
    const nearestD2 = (qx, qy) => {
      const cx = Math.min(gw - 1, Math.max(0, Math.floor((qx - 1) / cellSize)));
      const cy = Math.min(gh - 1, Math.max(0, Math.floor((qy - 1) / cellSize)));
      let best = Infinity;
      const maxR = gw + gh;
      for (let r = 0; r <= maxR; r++) {
        if (best < Infinity && (r - 1) * cellSize > Math.sqrt(best)) break;
        for (let gy = cy - r; gy <= cy + r; gy++) {
          if (gy < 0 || gy >= gh) continue;
          const edgeRow = gy === cy - r || gy === cy + r;
          for (let gx = cx - r; gx <= cx + r; gx++) {
            if (gx < 0 || gx >= gw) continue;
            if (!edgeRow && gx !== cx - r && gx !== cx + r) continue;
            const bin = bins[gy * gw + gx];
            if (!bin) continue;
            for (let j = 0; j < bin.length; j++) {
              const p = bin[j];
              const dx = outX[p] - qx, dy = outY[p] - qy;
              const d = dx * dx + dy * dy;
              if (d < best) best = d;
            }
          }
        }
      }
      return best;
    };

    for (let i = 0; i < want; i++) {
      let bestScore = -Infinity, bx = 0, by = 0;
      // Always exactly k candidates, never short-circuited: the RNG draw count
      // per point has to be fixed or the sequence stops being a prefix of
      // itself. For the first point every candidate scores Infinity and the
      // first one wins, since Infinity > Infinity is false.
      for (let t = 0; t < k; t++) {
        const c = samplePixel();
        // Sub-pixel, so points are not pinned to pixel centres -- at typical
        // spacings that quantisation would be a visible tenth of a spacing.
        const qx = (c % nx) + 1 + (rand() - 0.5);
        const qy = Math.floor(c / nx) + 1 + (rand() - 0.5);
        const spacing = Math.sqrt(massPerPoint / massOf(c));
        const d2 = i === 0 ? Infinity : nearestD2(qx, qy);
        const score = d2 === Infinity ? Infinity : Math.sqrt(d2) / spacing;
        if (score > bestScore) { bestScore = score; bx = qx; by = qy; }
      }
      const p = outX.length;
      outX.push(bx); outY.push(by);
      const b = cellOf(bx, by);
      if (bins[b]) bins[b].push(p); else bins[b] = [p];
    }
  }

  return withPinnedPolish(ctx, inside, massOf, outX, outY, opts);
}

/**
 * Points around the drawing's perimeter, to be pinned.
 *
 * Without these the triangulation does not cover the page: the convex hull of a
 * relaxed interior point set falls short of the rectangle, leaving the corners
 * and the strips along each edge untriangulated. Adding the four corners and a
 * run of points along each side makes the hull equal the rectangle, so the
 * triangulation tiles the drawing exactly and no clipping step is needed. Keeping
 * the edge triangles from being slivers is the second reason.
 *
 * Spacing follows the local density rather than one global figure: a perimeter at
 * a fixed spacing meets a dense interior with long boundary edges and a sparse
 * one with crowded edges, and either way the first row of triangles is the wrong
 * shape. Walking the phase integral puts consecutive perimeter points one local
 * spacing apart — the same trick planeWaves uses along its projection axis, since
 * in one dimension the spacing condition is just an integral.
 */
export function perimeterPoints(ctx, field, count) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { x0, y0, x1, y1 } = boundsOfPolygon(px, py);

  // The field is a density up to a scale, as stipplePoints takes it; normalising
  // against the interior count turns it into real points per pixel, without
  // which the spacings here would be in arbitrary units.
  const mask = polygonMask(nx, ny, px, py);
  let total = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!mask[c]) continue;
      total += field ? Math.max(0, field[c]) : 1;
    }
  }
  const norm = total > 0 ? Math.max(1, count) / total : 0;
  const spacingAt = (x, y) => {
    const j = Math.min(nx - 1, Math.max(0, Math.round(x) - 1));
    const i = Math.min(ny - 1, Math.max(0, Math.round(y) - 1));
    const n = Math.max(1e-9, (field ? Math.max(0, field[i * nx + j]) : 1) * norm);
    return Math.sqrt(1.1547 / n);          // hexagonal spacing at that density
  };

  const sx = [], sy = [];
  const side = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (!(len > 0)) return;
    // Accumulated phase along the side: one unit of phase per local spacing.
    // Sampled at the MIDPOINT of each step, which makes the sum a midpoint rule
    // rather than a left-endpoint one and costs nothing.
    const steps = Math.max(2, Math.ceil(len));
    const ds = len / steps;
    const arc = new Float64Array(steps + 1);
    const phase = new Float64Array(steps + 1);
    for (let i = 1; i <= steps; i++) {
      const tm = (i - 0.5) / steps;
      arc[i] = (i / steps) * len;
      phase[i] = phase[i - 1] + ds / spacingAt(ax + (bx - ax) * tm, ay + (by - ay) * tm);
    }
    const P = phase[steps];
    // Round the count and distribute evenly in phase, not in arc length, which
    // keeps the corner exactly on the corner while leaving no crowded pair at
    // the far end.
    const k = Math.max(1, Math.round(P));
    for (let i = 0; i < k; i++) {                 // start inclusive, end exclusive
      const s = P > 0 ? interpTable(phase, arc, (i * P) / k) : (i / k) * len;
      const t = s / len;
      sx.push(ax + (bx - ax) * t);
      sy.push(ay + (by - ay) * t);
    }
  };
  side(x0, y0, x1, y0);
  side(x1, y0, x1, y1);
  side(x1, y1, x0, y1);
  side(x0, y1, x0, y0);
  return { sx, sy };
}
