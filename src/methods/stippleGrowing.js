// Port of singleWidthLines/code/regionsStippleGrowing.m
//
// Region growing with an ink budget. Seed at the unclaimed pixel that comes
// first in the growth order, grow outward accumulating darkness, and stop when
// the running total reaches pi*rDot^2 -- exactly one dot's worth of ink. Place a
// dot at the darkness-weighted centroid of what was claimed, mark it all owned,
// repeat.
//
// So there is no tone curve here at all: the number of dots is sum(K)/(pi rDot^2)
// by construction, and in a uniform region of darkness K0 the dots-per-area is
// K0/(pi rDot^2) while each supplies pi rDot^2 of ink, giving an ink fraction of
// exactly K0.
//
// Unlike wigglyLines and circlePacking, this method spans the full tone range:
// white costs nothing (no dots at all) and black is reachable (cells shrink
// until their area equals the dot's). The one place it falls short is at high
// density, where cells of area pi*rDot^2 get a circle of that same area at their
// centroid -- equal circles do not tile, so neighbours overlap while cell corners
// stay bare. That error is accepted deliberately: correcting it would mean
// shrinking dots away from the size the budget calls for, which changes the look
// this method exists for. verify.html reports it rather than compensating.
//
// Four ways to place the dots, one tone model. Region growing is the ported one
// and the default. The others hand the same job to the point placers in
// spine/points.js, and the identity above survives the swap unchanged: ask for
// N = sum(K)/(pi rDot^2) points distributed in proportion to K, and a region of
// darkness K0 receives N * K0*area/sum(K) = K0*area/(pi rDot^2) of them, so the
// dots-per-area is K0/(pi rDot^2) and the ink fraction is K0. Same relation, same
// absence of a constant, same full tone range -- which is why these are modes
// here rather than methods of their own.
//
// What differs is arrangement, which is the whole reason to offer them: growing
// packs organically from a growth order, the relaxed placer settles three seeds
// per cell by local Lloyd and tends toward hexagonal patches, best-candidate
// gives blue noise, and the subdivider bisects boxes and leaves flat tone on a
// two-aspect lattice. See the artefact note in spine/points.js before assuming
// the last one is a bug.
//
// For dots specifically, blue noise is the one to reach for: it is the only one
// with no structure for the eye to find, and structure in a stipple reads as an
// artefact rather than as a texture. The default stays on the ported placement
// because that is what every measured number in this file was taken against.
//
// Anisotropic alignment sits on top of any of them: a relaxation under an
// elliptical metric aligned to the local image orientation, so dots pack tighter
// along one axis and the stipple follows the form. Off by default, and three
// things about it are worth knowing before turning it up.
//
// It is not tone-neutral. The count is safe — fixed by the ink budget before any
// placer runs, and no relaxation makes or loses a point — but
// `coverage = n*pi*rDot^2/area` assumes the dots do not overlap, and alignment
// exists precisely to shrink spacing along one axis by sqrt(rho). Dots tangent at
// rho = 1 overlap beyond it, overlapping ink is ink the model counted and the
// paper did not take, and the drawing goes light, worse as strength and darkness
// rise. The module already accepts this at high density; alignment brings it
// forward into the midtones. spine/relax.js RHO_MAX carries the derived cap.
//
// It re-rolls the drawing. The metric changes which pixels each site owns, hence
// the mass each subdivision child receives, hence its point count, hence how many
// times the RNG is drawn. Any nonzero strength is a different picture.
//
// It applies to all four placements, being a pass over the finished point set
// rather than a placer of its own — which is also the only way it could be
// visible, since inside `stipplePoints` the sole relaxation is a k = 3 local
// k-means within one subdivision cell and this method passes no perimeter ring.
//
// radialRemap is deliberately not folded in here. It floors spacing at
// d = 2*rDot so its dots may touch but never overlap, and that floor together
// with dMaxW is what gives it a reachable band and a targetImage. This method
// takes the opposite position on the same question, which is why it has no band;
// merging them would put two contradictory rules about dot overlap in one module.

import { regionMask } from '../spine/mask.js';
import { mulberry32 } from '../spine/random.js';
import { dotPath } from '../spine/dots.js';
import { alignPoints } from '../spine/relax.js';
import { stipplePoints, usesSubdivide } from '../spine/points.js';
export const id = 'stippleGrowing';
// The id stays `stippleGrowing` although the label does not say so: shared links
// carry `m=stippleGrowing`, and renaming it would break every one of them.
export const label = 'Stippling (dots)';

/**
 * The ported placement, and the default. Absent means growing, so an old link
 * that predates the control restores to exactly what it drew before.
 */
const isGrowing = (p) => (p.placer ?? 'growing') === 'growing';

export const params = [
  // Diameter, because that is what a dot looks like on the page; the tone model
  // below works in the radius. Floor 1 = a dot one pen width across, the smallest
  // mark a pen can make.
  { key: 'dDotW', label: 'Dot size', type: 'range', min: 1, max: 12, step: 0.1, def: 3, unit: '×pen' },
  // The only control every placement shares, because it sets the count:
  // N = sum(K)/(pi rDot^2). Everything below belongs to one placement or another.
  {
    key: 'placer', label: 'Placement', type: 'select', def: 'growing',
    options: [
      { value: 'growing', label: 'Grown — organic, ported' },
      { value: 'lloyd', label: 'Relaxed — organic, hierarchical' },
      { value: 'bestCandidate', label: 'Blue noise — even, never periodic' },
      { value: 'subdivide', label: 'Subdivided — exact count, faster' },
    ],
  },
  // How far a cell may grow, hence the lightest tone that still gets a dot:
  // past this the region is left blank. Also bounds the cost per dot.
  { key: 'rMaxMult', label: 'Search radius', type: 'range', min: 5, max: 20, step: 1, def: 20, unit: '×dot radius',
    when: isGrowing },
  {
    key: 'order', label: 'Growth order', type: 'select', def: 'centre',
    options: [
      { value: 'centre', label: 'Outward from centre' },
      { value: 'darkness', label: 'Outward from darkest mass' },
      { value: 'raster', label: 'Top to bottom' },
      { value: 'random', label: 'Random' },
    ],
    when: isGrowing,
  },
  // Growing draws from it for the random order and the tie-break noise, and the
  // relaxed placer for its seeds. The subdivider draws from it only when the
  // lattice relaxation below is on, because that jitters first -- so the control
  // reappears exactly when it starts doing something.
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1,
    when: (p) => !usesSubdivide(p) || (p.relaxAfter ?? 0) > 0 },
  // Relaxed only: the subdivider has no relaxation and growing has no seeds to
  // arrange. Small on purpose -- see the note in spine/points.js.
  { key: 'relaxIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: (p) => p.placer === 'lloyd' },
  // Subdivided placement only, and zero by default. Lloyd steps over the finished
  // point set, to soften the two-aspect lattice the box subdivision leaves on
  // flat tone. A different control from `relaxIter` above despite the similar
  // name: that one arranges three seeds inside one cell during placement, this
  // one relaxes every point afterwards. Hence the different defaults — 6 is
  // enough to settle a three-seed cell, and 0 is right here because every step
  // trades away accuracy.
  //
  // What it trades: mass-weighted Lloyd converges on the Gersho distribution
  // field^(1/2), which is exactly what the subdivider avoids by construction, so
  // each step pulls density back toward it. The count is untouched -- points
  // move, none are made or lost -- so the exact-count property survives. The
  // sweep in tests/spine.subdivide.js prices the steps.
  //
  // It also brings the Seed control back. Relaxation has to jitter before it
  // relaxes, because a regular lattice is a fixed point of Lloyd and would
  // otherwise survive it untouched; the jitter is seeded, so above zero this
  // placement stops being the same drawing at every seed.
  //
  // Each step is a nearest-seed pass over the whole raster, so the top of this
  // range costs about twenty of those on top of the placement itself. That is
  // the reason for a modest maximum rather than a large one.
  { key: 'relaxAfter', label: 'Lattice relaxation', type: 'range', min: 0, max: 20, step: 1, def: 0, unit: 'iters',
    when: usesSubdivide },

  // ---- anisotropic alignment. Off by default; see the header block below.
  //
  // Signed, and the opposite formula from treeEdges' `anisotropy` while meaning
  // the same thing to the eye. Here +1 makes distance grow FASTER along the local
  // edge tangent, so cells are short that way and dots pack tight along it — rows
  // that follow the form. In treeEdges +1 makes an along-tangent edge CHEAP. Both
  // are "+1 follows the image": a tree metric chooses which edges get drawn and a
  // Voronoi metric chooses cell shape, and those want opposite formulas. Do not
  // reconcile one to the other without reading spine/relax.js siteMetrics.
  //
  // The iteration count is the switch, not the alignment strength. At strength 0
  // this is an ordinary damped Lloyd polish, which measured cuts the dot-overlap
  // shortfall 4.6x at coverage 0.7 and 36x at 0.45 — evening the spacing puts ink
  // the budget already counted back on the paper — and that improvement to the
  // oldest weakness in this method needs no anisotropy at all. Zero by default,
  // so the drawings this file's numbers were measured against are unchanged.
  { key: 'alignIter', label: 'Relaxation', type: 'range', min: 0, max: 20, step: 1, def: 0, unit: 'iters' },
  // Only does anything once there are steps to do it in.
  { key: 'anisotropy', label: 'Align to image', type: 'range', min: -1, max: 1, step: 0.05, def: 0,
    when: (p) => Math.round(p.alignIter ?? 0) > 0 },
];

/**
 * Dither the partial cells instead of the MATLAB's hard 0.8 threshold.
 *
 * When a cell hits the search radius before filling its ink budget, the MATLAB
 * places a dot only if it gathered >= 0.8 of one, and throws the rest away --
 * a systematic lightening in dim regions, up to 0.8 of a dot per skipped cell.
 * Placing one with probability Knet/target instead makes the expected ink equal
 * the ink actually present.
 *
 * SET THIS TO false FOR THE FAITHFUL RULE. Kept as a constant rather than a
 * slider to leave the option open without adding UI; if the two turn out to look
 * meaningfully different it should be promoted to a param.
 */
const DITHER_PARTIAL_CELLS = true;

/** MATLAB's threshold, used only when the dither is off. */
const PARTIAL_THRESHOLD = 0.8;

/**
 * Per-pixel jitter added to the SQUARED distance, as the MATLAB does.
 *
 * The source builds a band-limited, histogram-equalised noise field for this, but
 * at amplitude 1 added to an INTEGER squared distance two pixels can only swap
 * order when their d^2 values are equal — so the band-limiting buys nothing and
 * white noise does the same job. Deforming the cell boundaries the way the field
 * looks like it should would need an amplitude well above 1.
 */
const NOISE_AMPLITUDE = 1;


/**
 * Offsets of a disc of radius Rmax, sorted by squared distance, with the index
 * where each distinct d^2 begins.
 *
 * Built once per run and reused for every seed. Sorting a whole Rmax-sized window
 * per dot, as the source does, is thousands of dots times ~14000 pixels at this
 * app's resolution and does not run interactively; walking a precomputed table in
 * d^2 order gives the identical ordering.
 */
function discOffsets(Rmax) {
  const R2 = Rmax * Rmax;
  const ri = Math.ceil(Rmax);

  let n = 0;
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= R2) n++;
  }
  const d2 = new Int32Array(n), sx = new Int32Array(n), sy = new Int32Array(n);
  let m = 0;
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      const v = dx * dx + dy * dy;
      if (v > R2) continue;
      d2[m] = v; sx[m] = dx; sy[m] = dy; m++;
    }
  }
  // sort an index array rather than an array of triples -- at the largest
  // allowed radius this table runs to a couple of hundred thousand entries, and
  // that many temporary arrays is the difference between fast and unusable
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => d2[a] - d2[b]);

  const dx = new Int32Array(n), dy = new Int32Array(n);
  const starts = [];
  let prev = -1, widest = 1;
  for (let i = 0; i < n; i++) {
    const j = idx[i];
    dx[i] = sx[j]; dy[i] = sy[j];
    if (d2[j] !== prev) {
      if (starts.length > 0) widest = Math.max(widest, i - starts[starts.length - 1]);
      starts.push(i);
      prev = d2[j];
    }
  }
  starts.push(n);
  widest = Math.max(widest, n - starts[starts.length - 2]);
  return { dx, dy, starts: Int32Array.from(starts), n, widest };
}

/** Ordering key per pixel; the MATLAB's D0, with its commented alternatives. */
function orderKeys(ctx, K, kind, rand) {
  const { nx, ny } = ctx;
  const key = new Float64Array(nx * ny);
  if (kind === 'raster') {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) key[iy * nx + ix] = iy * nx + ix;
    }
    return key;
  }
  if (kind === 'random') {
    for (let i = 0; i < key.length; i++) key[i] = rand();
    return key;
  }
  let cx = (1 + nx) / 2, cy = (1 + ny) / 2;
  if (kind === 'darkness') {
    // MATLAB lines 56-57: the darkness-weighted centroid
    let sx = 0, sy = 0, sk = 0;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const k = K[iy * nx + ix];
        sx += (ix + 1) * k; sy += (iy + 1) * k; sk += k;
      }
    }
    if (sk > 0) { cx = sx / sk; cy = sy / sk; }
  }
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const ax = ix + 1 - cx, ay = iy + 1 - cy;
      key[iy * nx + ix] = Math.sqrt(ax * ax + ay * ay);
    }
  }
  return key;
}

/**
 * Place the dot centres. Exported so the harness can measure dot counts and
 * spacing without paying for the spiral tessellation.
 * @returns {{x:Float64Array, y:Float64Array, n:number, skipped:number}}
 */
export function growStipple(ctx) {
  const { nx, ny, w } = ctx;
  const rDot = Math.max(w / 2, ((ctx.dDotW ?? 3) / 2) * w);
  // Growing past the image is pointless, and the offset table below is ~pi*R^2
  // entries, so cap it: at both sliders maxed (6 pen widths, 60 dots) the
  // uncapped radius would be 540 px and the table a million entries.
  const Rmax = Math.min(
    Math.hypot(nx, ny),
    Math.max(rDot * 2, (ctx.rMaxMult ?? 30) * rDot),
  );
  const target = Math.PI * rDot * rDot;
  const rand = mulberry32(Math.round(ctx.seed ?? 1));
  const { px, py } = ctx.polygon;

  // darkness, zeroed outside the region (MATLAB lines 42-43, 65)
  const K = new Float64Array(nx * ny);
  const owned = new Int32Array(nx * ny);
  const mask = regionMask(ctx);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iy * nx + ix;
      if (!mask[i]) { owned[i] = -1; continue; }
      K[i] = 1 - Math.min(1, Math.max(0, ctx.im.data[i]));
    }
  }

  const noise = new Float64Array(nx * ny);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * NOISE_AMPLITUDE;

  const key = orderKeys(ctx, K, ctx.order ?? 'centre', rand);
  const seedOrder = new Int32Array(nx * ny);
  for (let i = 0; i < seedOrder.length; i++) seedOrder[i] = i;
  seedOrder.sort((a, b) => key[a] - key[b]);

  const off = discOffsets(Rmax);
  const outX = [], outY = [];
  const claimed = new Int32Array(off.n);
  const buf = new Int32Array(off.widest);
  let skipped = 0;

  // The seed pointer only ever moves forward: pixels go unclaimed -> claimed and
  // never back, so the MATLAB's full-image argmin per dot (line 77) is exactly a
  // monotone walk over the ordered list.
  let ptr = 0;
  while (ptr < seedOrder.length) {
    const seedI = seedOrder[ptr];
    if (owned[seedI] !== 0) { ptr++; continue; }
    const sx0 = seedI % nx, sy0 = (seedI / nx) | 0;

    let knet = 0, nClaimed = 0;
    let cSumX = 0, cSumY = 0, cSumK = 0;
    let bracketed = false;

    for (let g = 0; g + 1 < off.starts.length && !bracketed; g++) {
      const g0 = off.starts[g], g1 = off.starts[g + 1];

      // gather this ring's in-bounds, unclaimed pixels and its total darkness
      let m = 0, groupK = 0;
      for (let t = g0; t < g1; t++) {
        const x = sx0 + off.dx[t], y = sy0 + off.dy[t];
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const i = y * nx + x;
        if (owned[i] !== 0) continue;
        buf[m++] = i;
        groupK += K[i];
      }
      if (m === 0) continue;

      if (knet + groupK <= target) {
        // the whole ring still undershoots, so every prefix of it does too --
        // take it wholesale and skip the within-ring ordering entirely
        for (let t = 0; t < m; t++) {
          const i = buf[t];
          claimed[nClaimed++] = i;
          const k = K[i];
          cSumX += ((i % nx) + 1) * k;
          cSumY += (((i / nx) | 0) + 1) * k;
          cSumK += k;
        }
        knet += groupK;
        continue;
      }

      // the budget is crossed inside this ring, so here the tie-break matters:
      // order by the jitter, exactly as adding it to d^2 would have done
      const ring = Array.prototype.slice.call(buf, 0, m);
      ring.sort((a, b) => noise[a] - noise[b]);
      let bestDiff = Math.abs(knet - target);
      for (let t = 0; t < m; t++) {
        const i = ring[t];
        const nd = Math.abs(knet + K[i] - target);
        if (nd > bestDiff) break;      // Knet is monotone, so this is the argmin
        bestDiff = nd;
        knet += K[i];
        claimed[nClaimed++] = i;
        const k = K[i];
        cSumX += ((i % nx) + 1) * k;
        cSumY += (((i / nx) | 0) + 1) * k;
        cSumK += k;
      }
      bracketed = true;
    }

    // --- did this cell earn a dot?
    let place;
    if (bracketed) {
      place = true;
    } else if (DITHER_PARTIAL_CELLS) {
      place = rand() < knet / target;
    } else {
      place = knet >= PARTIAL_THRESHOLD * target;
    }

    if (place) {
      // darkness-weighted centroid (MATLAB line 114), falling back to the plain
      // one where the cell is entirely white -- the source's `if ks==0` guard
      if (cSumK > 0) {
        outX.push(cSumX / cSumK);
        outY.push(cSumY / cSumK);
      } else if (nClaimed > 0) {
        let ax = 0, ay = 0;
        for (let t = 0; t < nClaimed; t++) {
          ax += (claimed[t] % nx) + 1;
          ay += ((claimed[t] / nx) | 0) + 1;
        }
        outX.push(ax / nClaimed);
        outY.push(ay / nClaimed);
      }
    } else {
      skipped++;
    }

    // Claim what was grown. When the budget was never reached the whole search
    // disc is taken -- the MATLAB reuses `r` from the PREVIOUS iteration here
    // (line 118), which is undefined on the first pass and arbitrary after, so
    // this is the history-free reading that still guarantees progress.
    for (let t = 0; t < nClaimed; t++) owned[claimed[t]] = 1;
    if (nClaimed === 0) owned[seedI] = 1;      // never stall
    ptr++;
  }

  return { x: Float64Array.from(outX), y: Float64Array.from(outY), n: outX.length, skipped };
}

/**
 * Dot centres from one of the point placers, at the density the ink budget asks
 * for.
 *
 * The count is the tone model, the same statement growing satisfies by
 * construction: N = sum(K)/(pi rDot^2) over the drawing polygon. Handing that N
 * to a placer together with `field = K` reproduces the identity exactly, because
 * the placers distribute points in proportion to mass — see the module header.
 *
 * Darkness outside the polygon is not counted and not placed into: the mask
 * zeroes it, so it contributes nothing to N either. Growing gets this by only
 * ever seeding inside the mask.
 *
 * Exported so the harness can check the count directly rather than inferring it
 * from a rendered picture.
 */
/**
 * Darkness inside the drawing polygon, and its total. This is the mass field the
 * placers take and the one the alignment pass relaxes against; the two have to
 * agree, or the alignment would settle toward a density the count did not come
 * from.
 */
export function darknessField(ctx) {
  const { nx, ny } = ctx;
  const mask = regionMask(ctx);
  const field = new Float64Array(nx * ny);
  let total = 0;
  for (let i = 0; i < field.length; i++) {
    if (!mask[i]) continue;
    const K = 1 - Math.min(1, Math.max(0, ctx.im.data[i]));
    if (K <= 0) continue;
    field[i] = K;
    total += K;
  }
  return { field, total };
}

export function placedStipple(ctx, rDot) {
  const { field, total } = darknessField(ctx);
  const count = Math.round(total / (Math.PI * rDot * rDot));
  if (!(count >= 1)) return { x: [], y: [], n: 0, count: 0 };

  const { sx, sy } = stipplePoints(ctx, {
    mode: ctx.placer,
    field,
    count,
    seed: Math.round(ctx.seed ?? 1),
    iterations: Math.round(ctx.relaxIter ?? 6),
    // Subdivided only; the Lloyd placer ignores it, having relaxed already.
    relax: Math.round(ctx.relaxAfter ?? 0),
    // No perimeter ring is passed, so the pinned polish never runs. That is
    // right here: the ring exists to make a TRIANGULATION cover the page, and
    // nothing is being triangulated -- a stipple wants no points forced onto
    // the boundary at all.
  });
  return { x: sx, y: sy, n: sx.length, count };
}

/**
 * Dot centres, after the optional anisotropic alignment pass.
 *
 * Exported so the harness can measure the point set directly -- the axis ratio a
 * given strength actually delivers is a claim about these coordinates, not about
 * a rendered picture.
 */
export function stipplePlacement(ctx, rDot) {
  const placed = isGrowing(ctx) ? growStipple(ctx) : placedStipple(ctx, rDot);
  const strength = ctx.anisotropy ?? 0;
  const iters = Math.round(ctx.alignIter ?? 0);
  // Iterations gate the pass; strength only decides whether it is anisotropic.
  if (iters === 0 || placed.n === 0) return { ...placed, trace: null };

  // Mean spacing sets both the tensor smoothing scale and the step clamp. Taken
  // from the count and the inked area rather than measured, so it is defined
  // before any relaxation has run.
  const { field } = darknessField(ctx);
  let live = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > 0) live++;
  const spacing = Math.sqrt(Math.max(1, live) / Math.max(1, placed.n));

  // Copies, because growStipple's arrays are its own and relaxSeeds mutates.
  const sx = Float64Array.from(placed.x), sy = Float64Array.from(placed.y);
  const trace = alignPoints(ctx, sx, sy, {
    field, strength, iterations: iters, spacing,
  });
  return { x: sx, y: sy, n: sx.length, trace };
}

export function run(ctx) {
  const w = ctx.w;
  const rDot = Math.max(w / 2, ((ctx.dDotW ?? 3) / 2) * w);
  const { x, y, n } = stipplePlacement(ctx, rDot);

  // TODO general polygons: a centroid within rDot of the boundary puts part of
  // its dot outside the region. Harmless on the full-image rectangle, where the
  // overhang is at most rDot at the very edge; for a real polygon the dot should
  // be pulled inside, not clipped -- a clipped dot reads as a broken mark.
  const lines = new Array(n);
  for (let i = 0; i < n; i++) lines[i] = dotPath(x[i], y[i], rDot, w);
  return lines;
}

// No targetImage, AND THAT HOLDS FOR ALL THREE PLACEMENTS: the ink budget aims
// at the source image exactly however the dots are arranged, and the shortfall
// at high density is accepted rather than modelled (see the header). A placement
// that needed a band would not belong in this module -- which is the test
// radialRemap fails.
export default { id, label, params, run };
