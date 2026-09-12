// Port of singleWidthLines/code/regionsCrosshatchingQuantized.m
// Header: "This is properly calibrated. It quantizes the levels in the image,
// then properly matches those levels."
//
// Tone is carried by how many hatch layers overlap. The important part is that
// the level ladder accounts for overlap: layers do not add linearly, they
// compose as 1-(1-x)^n, so the MATLAB spaces the levels as
//
//     Ks = 1 - (1-Kmax)^(i/N)          coverage after i layers
//     dL = w / (1 - (1-Kmax)^(1/N))    spacing that gives each layer its share
//
// which makes every layer contribute equal *multiplicative* coverage. Kmax caps
// it short of solid ink. This is the same order-statistic argument derived in
// thresholding/code/overlapping.m -- already applied here, so do not add a
// second correction on top.
//
// The MATLAB draws each layer by contouring a linear ramp masked with NaN, which
// yields parallel lines already clipped to the layer's region. This port does
// the equivalent by walking each candidate line and keeping the runs where the
// layer mask holds, then bisecting at the run ends to recover the sub-pixel
// endpoints the contour gave for free. Contours of a *linear* ramp are exactly
// straight, so the MATLAB's simplifyLineArea pass collapses them to two points
// -- which is what this produces directly.

import { regionMask, whitenOutside } from '../spine/mask.js';
import { medfilt2, makeImage } from '../shim/image.js';
import { interpTable } from '../spine/interp.js';
import { bayerThresholds } from '../shim/bayer.js';

export const id = 'crosshatchQuantized';
export const label = 'Crosshatching (quantised)';

export const params = [
  { key: 'nLevels', label: 'Levels', type: 'range', min: 2, max: 12, step: 1, def: 5 },
  { key: 'maxCoverage', label: 'Max coverage', type: 'range', min: 0.5, max: 0.99, step: 0.01, def: 0.95 },
  { key: 'ditherLevels', label: 'Dither levels', type: 'checkbox', def: false },
];


/**
 * Greedy most-orthogonal ordering of the layer angles (MATLAB lines 62-68):
 * each successive angle is the one farthest from every angle already chosen,
 * measured as |sin(theta_a - theta_b)|. Same principle as the bit-reversal in
 * parallelHatching -- a partial drawing then looks evenly hatched rather than
 * biased to one direction.
 */
function mostOrthogonalOrder(ths) {
  const n = ths.length;
  const out = new Float64Array(n);
  const ds = new Float64Array(n);
  out[0] = ths[0];
  for (let i = 0; i < n; i++) ds[i] = Math.abs(Math.sin(ths[i] - ths[0]));
  for (let i = 1; i < n; i++) {
    let j = 0, best = -Infinity;
    for (let k = 0; k < n; k++) if (ds[k] > best) { best = ds[k]; j = k; }
    out[i] = ths[j];
    for (let k = 0; k < n; k++) {
      ds[k] = Math.min(ds[k], Math.abs(Math.sin(ths[k] - ths[j])));
    }
  }
  return out;
}

/**
 * The quantisation half of the method: median filter, polygon whitening, and
 * the level ladder. Exported separately so the verification harness can run the
 * per-level check the MATLAB sketches in its commented-out validation block
 * (lines 119-135) -- the claim "properly calibrated" is per *level*, not
 * against a continuous ramp, because the output is deliberately quantised.
 */
export function computeLevels(ctx, nLevels, Kmax, dither = false) {
  const { nx, ny, w, polygon } = ctx;
  const { px, py } = polygon;

  // median filter at pen scale, then whiten outside the polygon so the mask
  // does the clipping (MATLAB lines 38-43)
  const wFilt = Math.max(3, Math.round(w / 2) * 2 + 1);
  const med = medfilt2(ctx.im, wFilt);
  whitenOutside(med, regionMask(ctx));

  // the level ladder (MATLAB lines 46-51)
  const dL = w / (1 - Math.pow(1 - Kmax, 1 / nLevels));
  const Ks = new Float64Array(nLevels + 1);
  const idx = new Float64Array(nLevels + 1);
  for (let i = 0; i <= nLevels; i++) {
    Ks[i] = 1 - Math.pow(1 - Kmax, i / nLevels);
    idx[i] = i;
  }
  const nLevelMap = new Int16Array(nx * ny);
  if (!dither) {
    for (let i = 0; i < nLevelMap.length; i++) {
      nLevelMap[i] = Math.round(interpTable(Ks, idx, (1 - med.data[i]) * Kmax));
    }
  } else {
    // Dither between adjacent levels instead of rounding to the nearest, so a
    // tone between two rungs of the ladder is reproduced as a mixture rather
    // than snapped -- this is what recovers the highlights (at 5 levels,
    // rounding sends everything above ~0.78 brightness to level 0, i.e. blank
    // paper) and removes the contour banding at level boundaries.
    //
    // The dither cell is dL across, NOT one pixel. Per-pixel dithering would
    // speckle the layer masks and the run-walk would return thousands of
    // pixel-length dashes -- most of them below segMinLength, so the result
    // would be both lighter than asked for and appalling to plot. At dL the
    // patches still hold whole hatch strokes.
    const { n, t } = bayerThresholds(2);        // 8x8
    const cell = Math.max(2, Math.round(dL));
    for (let iy = 0; iy < ny; iy++) {
      const ty = Math.floor(iy / cell) % n;
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix;
        const exact = interpTable(Ks, idx, (1 - med.data[i]) * Kmax);
        const lo = Math.floor(exact);
        const frac = exact - lo;
        const tx = Math.floor(ix / cell) % n;
        nLevelMap[i] = lo + (t[ty * n + tx] < frac ? 1 : 0);
      }
    }
  }
  return { nLevelMap, Ks, dL, med };
}

/**
 * The brightness this method is actually aiming for, per pixel.
 *
 * Without dithering the output is a staircase, so the honest target is the
 * quantised one -- comparing against a continuous ramp only measures the
 * quantisation, which is by design. With dithering the mixture restores the
 * average, so the continuous image is the right target again.
 *
 * The verification harness uses this instead of ctx.im when a method provides it.
 */
export function targetImage(ctx) {
  const nLevels = Math.max(2, Math.round(ctx.nLevels ?? 5));
  const Kmax = Math.min(0.99, Math.max(0.5, ctx.maxCoverage ?? 0.95));
  if (ctx.ditherLevels) return ctx.im;

  const { nLevelMap, Ks } = computeLevels(ctx, nLevels, Kmax, false);
  const out = makeImage(ctx.nx, ctx.ny);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = 1 - Ks[Math.max(0, Math.min(nLevels, nLevelMap[i]))];
  }
  return out;
}

export function run(ctx) {
  const { nx, ny, w } = ctx;
  const nLevels = Math.max(2, Math.round(ctx.nLevels ?? 5));
  const Kmax = Math.min(0.99, Math.max(0.5, ctx.maxCoverage ?? 0.95));

  const { nLevelMap, dL } = computeLevels(ctx, nLevels, Kmax, !!ctx.ditherLevels);

  // layer angles and phases (MATLAB lines 57-71)
  const thsRaw = new Float64Array(nLevels);
  for (let i = 0; i < nLevels; i++) thsRaw[i] = (Math.PI * i) / nLevels;
  const ths = mostOrthogonalOrder(thsRaw);
  const dx0 = new Float64Array(nLevels);
  for (let i = 0; i < nLevels; i++) {
    dx0[i] = (nLevels === 1 ? 1 : i / (nLevels - 1)) * dL;
  }

  const segMinLength2 = w * w;
  const step = 0.5;                 // sampling step along a line, pixels
  const lines = [];

  const maskAt = (x, y) => {
    const ix = Math.round(x) - 1, iy = Math.round(y) - 1;
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return -1;
    return nLevelMap[iy * nx + ix];
  };

  for (let layer = 1; layer <= nLevels; layer++) {
    const t = ths[layer - 1];
    const c = Math.cos(t), s = Math.sin(t);
    const phase = dx0[layer - 1];

    // extent of f = x*cos(t) + y*sin(t) + phase over this layer's mask
    let minf = Infinity, maxf = -Infinity;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (nLevelMap[iy * nx + ix] < layer) continue;
        const f = (ix + 1) * c + (iy + 1) * s + phase;
        if (f < minf) minf = f;
        if (f > maxf) maxf = f;
      }
    }
    if (!isFinite(minf)) continue;   // nothing dark enough for this layer

    // s-range along the line direction (-sin t, cos t), from the image corners
    let smin = Infinity, smax = -Infinity;
    for (const [cx, cy] of [[1, 1], [nx, 1], [1, ny], [nx, ny]]) {
      const sv = -s * cx + c * cy;
      if (sv < smin) smin = sv;
      if (sv > smax) smax = sv;
    }

    const v0 = Math.floor(minf / dL) * dL + dL / 2;
    for (let v = v0; v <= maxf; v += dL) {
      const p = v - phase;
      const ox = p * c, oy = p * s;
      const pointAt = (u) => [ox - s * u, oy + c * u];

      let runStart = null;
      let prevU = smin;
      for (let u = smin; u <= smax; u += step) {
        const [x, y] = pointAt(u);
        const on = maskAt(x, y) >= layer;
        if (on && runStart === null) {
          runStart = refineEdge(pointAt, prevU, u, layer, maskAt);
        } else if (!on && runStart !== null) {
          const end = refineEdge(pointAt, u, prevU, layer, maskAt);
          pushRun(lines, pointAt, runStart, end, segMinLength2);
          runStart = null;
        }
        prevU = u;
      }
      if (runStart !== null) pushRun(lines, pointAt, runStart, smax, segMinLength2);
    }
  }

  return lines;
}

/**
 * Bisect between an off-sample and an on-sample to place the endpoint at the
 * mask boundary, recovering the sub-pixel precision the contour approach had.
 */
function refineEdge(pointAt, uOff, uOn, layer, maskAt) {
  let a = uOff, b = uOn;
  for (let k = 0; k < 8; k++) {
    const m = (a + b) / 2;
    const [x, y] = pointAt(m);
    if (maskAt(x, y) >= layer) b = m; else a = m;
  }
  return b;
}

function pushRun(lines, pointAt, u1, u2, segMinLength2) {
  const a = pointAt(u1), b = pointAt(u2);
  const d2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (d2 > segMinLength2) lines.push([a, b]);
}

export default { id, label, params, run, targetImage };
