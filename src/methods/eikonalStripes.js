// Port of singleWidthLines/code/regionsEikonalStripes.m
// Header: "this is properly calibrated"
//
// THE IDEA, which the name states and the one-line summary undersells: the
// weight field 2*pi/L is integrated geodesically from a seed set, so P is an
// accumulated PHASE -- travelling one stripe spacing L costs exactly 2*pi. The
// eikonal condition |grad P| = 2*pi/L then makes the level sets at 2*pi
// intervals exactly L apart, everywhere, with no phase bookkeeping and no
// global optimisation. And because they are level sets of a single-valued
// function they cannot cross, cannot dead-end, and close on themselves.
//
// That is a stronger guarantee than any other stripe method here gets, which is
// why it was worth building two new spine components for.
//
// The tone ladder at line 52 is the same harmonic one circlePacking uses:
//
//     L = Lmin/(1 - im(1 - Lmin/Lmax))   <=>   1/L = 1/Lmin + im(1/Lmax - 1/Lmin)
//
// Stripes of pen width w at spacing L cover w/L, so linear 1/L gives linear
// coverage. Lmin is the merge floor -- at L = w adjacent stripes touch and the
// page is solid -- so unlike wigglyLines and circlePacking this method reaches
// black, and unlike stippleGrowing it cannot reach white (a stripe is always
// somewhere).
//
// refiningNoise's ladder LOOKS like this one and is not: it passes through the
// origin rather than interpolating between endpoints, which is what lets it
// reach white. See its header before factoring the two together.

import { regionMask } from '../spine/mask.js';
import { blurGaussian, makeImage } from '../shim/image.js';
import { grayDist } from '../spine/geodesic.js';
import { createContourWorkspace, contourLevel } from '../spine/contour.js';
import { simplifyLineDistance } from '../spine/simplify.js';
import { clipPolyline } from '../spine/geometry.js';
import { affineTarget, stripeSpacings, stripeBand, harmonicSpacing } from '../spine/tone.js';

export const id = 'eikonalStripes';
export const label = 'Eikonal stripes';

export const params = [
  { key: 'LminW', label: 'Min spacing', type: 'range', min: 1, max: 5, step: 0.1, def: 1.5, unit: '×pen' },
  { key: 'LmaxW', label: 'Max spacing', type: 'range', min: 4, max: 120, step: 1, def: 40, unit: '×pen' },
  {
    key: 'seedMode', label: 'Grow from', type: 'select', def: 'edges',
    options: [
      { value: 'edges', label: 'Region edge' },
      { value: 'centroid', label: 'Centroid' },
      { value: 'corners', label: 'Region corners' },
      { value: 'border', label: 'Image border' },
    ],
  },
  // MATLAB line 101 fixes this at Lmin/3. It trades contour smoothness against
  // spacing accuracy -- blurring P lowers |grad P| where the field curves, which
  // locally widens the stripes -- so it is worth being able to see the trade.
  // def sits ON the step grid. At 0.33 with step 0.05 the browser snapped the
  // slider to 0.35 while defaultsFor() still reported 0.33, so the declared
  // default and the one actually in force disagreed until the first drag.
  { key: 'smoothing', label: 'Field smoothing', type: 'range', min: 0, max: 1, step: 0.05, def: 0.35, unit: '×Lmin' },
];

// The `addSpiral` branch of the source is not ported. It shears the level sets
// into one continuous stroke by contouring triwave(P/2 + atan2(y-yc, x-xc)),
// which works out because a triangle wave crosses any interior level twice per
// period -- two interleaved spirals of pitch 2L, netting L. Removed on request
// after trying it: atan2 is genuinely singular at the centre, so the innermost
// turns are unreliable, and nested closed contours plot perfectly well.

/** Contours below this many points are noise, not stripes. */
const MIN_POINTS = 3;

const spacingsOf = (ctx) => stripeSpacings(ctx);

/** Reachable brightness band: coverage is w/L, so the shared stripe band. */
export function toneBand(ctx) {
  const { w, Lmin, Lmax } = spacingsOf(ctx);
  return stripeBand(w, Lmin, Lmax);
}

/** Since 1/L is linear in brightness, the achieved ramp IS the affine remap. */
export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Seed set.
 *
 * NOTE the source's `distMode = 2` ("from edges") has never run: line 74 is
 * `linspace(0, s(end), 0.5)`, and a non-integer count returns empty, so no
 * seeds are planted and control falls through to the `sum(D0(:))==0` guard at
 * lines 92-97 which seeds the whole image border instead. That fallback is what
 * the demo actually exercises. Both are offered here, separately and honestly:
 * 'edges' walks the polygon at one-pixel steps as intended, 'border' is the
 * fallback.
 */
function buildSeeds(ctx, mode, region) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const seeds = new Uint8Array(nx * ny);
  const mark = (x, y) => {
    const j = Math.round(x) - 1, i = Math.round(y) - 1;
    if (i < 0 || j < 0 || i >= ny || j >= nx) return;
    if (region[i * nx + j]) seeds[i * nx + j] = 1;
  };

  if (mode === 'border') {
    for (let j = 0; j < nx; j++) { mark(j + 1, 1); mark(j + 1, ny); }
    for (let i = 0; i < ny; i++) { mark(1, i + 1); mark(nx, i + 1); }
  } else if (mode === 'centroid') {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < ny; i++) {
      for (let j = 0; j < nx; j++) {
        if (region[i * nx + j]) { sx += j + 1; sy += i + 1; n++; }
      }
    }
    if (n > 0) mark(sx / n, sy / n);
  } else if (mode === 'corners') {
    for (let k = 0; k < px.length; k++) mark(px[k], py[k]);
  } else {
    // 'edges': walk the closed polygon at one-pixel steps
    for (let k = 0; k < px.length; k++) {
      const k2 = (k + 1) % px.length;
      const dx = px[k2] - px[k], dy = py[k2] - py[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
      for (let s = 0; s <= steps; s++) {
        mark(px[k] + (dx * s) / steps, py[k] + (dy * s) / steps);
      }
    }
  }

  // the source's own guard, kept: an empty seed set would give an all-Infinity
  // field and no stripes at all
  let any = 0;
  for (let i = 0; i < seeds.length; i++) any |= seeds[i];
  if (!any) {
    for (let j = 0; j < nx; j++) { mark(j + 1, 1); mark(j + 1, ny); }
    for (let i = 0; i < ny; i++) { mark(1, i + 1); mark(nx, i + 1); }
  }
  return seeds;
}

/** The phase field, exported so the harness can measure spacing against L. */
export function phaseField(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { Lmin, Lmax } = spacingsOf(ctx);

  // The shared mask, used directly rather than copied: nothing below writes to
  // it, and spine/mask.js documents the array as read-only.
  const region = regionMask(ctx);
  const L = new Float64Array(nx * ny);
  let nR = 0;
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const c = i * nx + j;
      const inside = region[c] === 1;
      const v = inside ? Math.min(1, Math.max(0, ctx.im.data[c])) : 1;
      // Clamped, unlike streamlines': the solver walks the whole raster, so the
      // outside has to carry a spacing rather than an extrapolation.
      L[c] = Math.min(Lmax, Math.max(Lmin, harmonicSpacing(v, Lmin, Lmax)));
      if (inside) nR++;
    }
  }
  if (nR === 0) return null;

  const weight = new Float64Array(nx * ny);
  for (let c = 0; c < weight.length; c++) weight[c] = (2 * Math.PI) / L[c];

  const seeds = buildSeeds(ctx, ctx.seedMode ?? 'edges', region);
  let P = grayDist(weight, nx, ny, seeds, { mask: region });

  // Unreachable cells would poison both the contouring and the level range.
  let maxFinite = 0;
  for (let c = 0; c < P.length; c++) if (isFinite(P[c]) && P[c] > maxFinite) maxFinite = P[c];
  for (let c = 0; c < P.length; c++) if (!isFinite(P[c])) P[c] = maxFinite;

  const sigma = (ctx.smoothing ?? 0.35) * Lmin;
  if (sigma > 0.01) {
    const img = makeImage(nx, ny);
    img.data.set(P);
    const blurred = blurGaussian(img, Math.max(3, Math.ceil(sigma * 3)), sigma);
    P = Float64Array.from(blurred.data);
  }

  // P and Lmin are what run() reads; L and region are here for the harness, which
  // checks measured stripe spacing against the L that was asked for. cx/cy went
  // with the removed addSpiral branch and cost a full accumulation pass.
  return { P, L, region, Lmin };
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const built = phaseField(ctx);
  if (!built) return [];
  const { P, Lmin } = built;

  const ws = createContourWorkspace(nx, ny);
  const raw = [];
  {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < P.length; c++) {
      if (P[c] < lo) lo = P[c];
      if (P[c] > hi) hi = P[c];
    }
    // MATLAB line 103: start half a period in, so the first stripe does not sit
    // on the seed itself
    const TWO_PI = 2 * Math.PI;
    for (let v = lo + Math.PI; v <= hi; v += TWO_PI) {
      const lines = contourLevel(P, v, ws);
      for (const l of lines) raw.push(l);
    }
  }

  // resample and simplify, as MATLAB lines 122-137
  const ds = Lmin / 2;
  const out = [];
  const tally = ctx.stageTally || null;
  const count = (k, lines) => {
    if (!tally) return;
    tally[k] = tally[k] || { lines: 0, points: 0 };
    tally[k].lines += lines.length;
    for (const l of lines) tally[k].points += l.length;
  };
  count('contoured', raw);

  for (const line of raw) {
    if (line.length < MIN_POINTS) continue;
    const pts = resampleUniform(line, ds);
    if (!pts || pts.length < 2) continue;
    count('resampled', [pts]);
    const simp = simplifyLineDistance(pts, Lmin / 2);
    count('simplified', [simp]);
    const runs = clipPolyline(simp, px, py);
    count('clipped', runs);
    for (const run2 of runs) {
      if (run2.length >= 2) out.push(run2);
    }
  }
  return out;
}

/** Even arc-length resampling of a polyline. */
function resampleUniform(pts, step) {
  const n = pts.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const total = cum[n - 1];
  if (!(total > 0)) return null;
  const m = Math.max(2, Math.ceil(total / step) + 1);
  const out = new Array(m);
  for (let k = 0, i = 1; k < m; k++) {
    const t = Math.min(total, (k * total) / (m - 1));
    while (i < n - 1 && cum[i] < t) i++;
    const seg = cum[i] - cum[i - 1];
    const f = seg > 0 ? (t - cum[i - 1]) / seg : 0;
    out[k] = [
      pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]),
      pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1]),
    ];
  }
  return out;
}

export default { id, label, params, run, targetImage };
