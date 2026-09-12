// Port of singleWidthLines/code/regionsParallelHatchingInPolygon.m
// Header: "does a good job of hatching."
//
// Tone comes from the number of overlaid hatch layers: nLocal = round((1-im)*N)
// gives a local layer count, and a candidate line is drawn where the local count
// reaches that line's index. The index sequence is bit-reversed (line 92 of the
// MATLAB, "this line is key for making it smoother") so that any prefix of the
// layers is evenly spread across the page rather than bunched -- the same
// argument as furthestCircularSpacing.m, in one dimension.

import { regionMask } from '../spine/mask.js';
import { blurGaussian, interp2, inpolygon, dilate3, makeImage } from '../shim/image.js';
import { trimLineSegsToPolygon } from '../spine/geometry.js';
import { COINCIDENT_PENS } from '../spine/pathOptimizer.js';

export const id = 'parallelHatching';
export const label = 'Parallel hatching';

export const params = [
  { key: 'angleDeg', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, def: 26, unit: '°' },
  {
    key: 'maxNlevels', label: 'Max layers', type: 'select', def: 16,
    // powers of two only -- see the divergence note in run()
    options: [2, 4, 8, 16, 32],
  },
];

/**
 * Bit-reversal permutation of 0..N-1. N must be a power of two, which is what
 * makes this a permutation of exactly the reachable index range.
 */
function bitReversedOrder(N) {
  const bits = Math.round(Math.log2(N));
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    order[i] = r;
  }
  return order;
}

/**
 * Only genuinely coincident endpoints may be joined. See `COINCIDENT_PENS`.
 *
 * The candidate lines are one pen width apart — `x2L[i] = (i + 1) * w` below —
 * and tone comes from drawing a subset of them, so in shadow the drawn lines are
 * adjacent. Run ends quantise to the `y2L` sampling grid, so two segments on
 * neighbouring lines routinely end at the same row, exactly w apart. That is
 * inside the pipeline's default 1.5 pen widths, and since `optimizeOrder`
 * reverses whichever line it reaches second, the join is a hairpin across the
 * grain rather than a continuation.
 *
 * No join here is ever legitimate, which is what makes the tight bound safe:
 * `trimLineSegsToPolygon` emits separate segments that share no endpoints, and
 * two runs on the SAME line are at least one `y2L` step apart by construction.
 * So bridging any gap adds ink the layer count never budgeted.
 */
export function maxJoinPens() {
  return COINCIDENT_PENS;
}

export function run(ctx) {
  const { im, nx, ny, w, polygon } = ctx;
  const th = ((ctx.angleDeg ?? 26) * Math.PI) / 180;
  const { px, py } = polygon;

  // Deliberate divergence from the MATLAB, verified by the ramp test.
  //
  // The original builds the bit-reversal over maxN2 = 2^nextpow2(maxNlevels)
  // but compares against nLocal, which only reaches maxNlevels. When
  // maxNlevels is not a power of two the two ranges disagree: with
  // maxNlevels = 20 the index values run 0..30, so six of the twenty lines can
  // never be drawn, coverage caps at 14/20, and the tone curve is compressed
  // (measured: 0.35 at black instead of 0.05, matching that model to within
  // 0.006 across ten bands). The MATLAB's own worked example uses 2^3, where
  // the bug is invisible.
  //
  // Fix: make the cycle length and the level count the same power of two, so
  // rev() is a permutation of exactly the reachable indices...
  const requested = Math.max(2, Math.round(ctx.maxNlevels ?? 16));
  const N = 1 << Math.ceil(Math.log2(requested));

  // region mask + centroid of the region (MATLAB lines 56, 70-71)
  let sumX = 0, sumY = 0, nRegion = 0;
  const region = regionMask(ctx);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (region[iy * nx + ix]) { sumX += ix + 1; sumY += iy + 1; nRegion++; }
    }
  }
  if (nRegion === 0) return [];
  const xm = sumX / nRegion, ym = sumY / nRegion;

  // local layer count (lines 63-67)
  const filtWidth = Math.max(3, Math.round((w * N) / 3));
  const im2 = blurGaussian(im, filtWidth, filtWidth / 2);
  const nLocal = makeImage(nx, ny);
  for (let i = 0; i < nLocal.data.length; i++) {
    nLocal.data[i] = Math.round((1 - im2.data[i]) * N);
  }

  // rotated extent of the region (lines 75-83)
  const c = Math.cos(th), s = Math.sin(th);
  let x2min = Infinity, x2max = -Infinity, y2min = Infinity, y2max = -Infinity;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!region[iy * nx + ix]) continue;
      const dx = ix + 1 - xm, dy = iy + 1 - ym;
      const x2 = c * dx - s * dy;
      const y2 = s * dx + c * dy;
      if (x2 < x2min) x2min = x2;
      if (x2 > x2max) x2max = x2;
      if (y2 < y2min) y2min = y2;
      if (y2 > y2max) y2max = y2;
    }
  }

  // candidate line positions, spaced by the pen width (lines 87-95)
  const nL = Math.max(1, Math.round((x2max - x2min) / w + 1));
  const order = bitReversedOrder(N);
  const x2L = new Float64Array(nL);
  const idxLine = new Int32Array(nL);
  let sumL = 0;
  for (let i = 0; i < nL; i++) {
    x2L[i] = (i + 1) * w;
    sumL += x2L[i];
    idxLine[i] = order[i % N];
  }
  const meanL = sumL / nL;
  const centre = (x2min + x2max) / 2;
  for (let i = 0; i < nL; i++) x2L[i] += centre - meanL;

  // sample positions along each line (line 96)
  const y2L = [];
  for (let v = y2min - 2 * w; v <= y2max + 2 * w; v += 2 * w) y2L.push(v);
  if (y2L.length < 2) return [];
  const nY = y2L.length;

  // rotate back into image space (lines 100-104)
  const xL = new Float64Array(nL * nY);
  const yL = new Float64Array(nL * nY);
  for (let iy = 0; iy < nY; iy++) {
    for (let ix = 0; ix < nL; ix++) {
      const a = x2L[ix], b = y2L[iy];
      xL[iy * nL + ix] = c * a + s * b + xm;   // R' * [a; b]
      yL[iy * nL + ix] = -s * a + c * b + ym;
    }
  }

  // which sample points get inked (lines 106-108).
  // ...and use a strict comparison. The MATLAB's `>=` always draws index 0, so
  // pure white still receives one line in N; with `>`, the drawn fraction is
  // exactly nLocal/N, linear from blank to solid.
  const kept = new Uint8Array(nL * nY);
  for (let i = 0; i < kept.length; i++) {
    let v = interp2(nLocal, xL[i], yL[i]);
    if (!isFinite(v)) v = 0;
    kept[i] = v > idxLine[i % nL] ? 1 : 0;
  }

  // inside mask, dilated by one sample so strokes reach the polygon edge
  // before trimming (lines 127-128)
  const insideMask = new Uint8Array(nL * nY);
  for (let i = 0; i < insideMask.length; i++) {
    insideMask[i] = inpolygon(xL[i], yL[i], px, py) ? 1 : 0;
  }
  const insideDil = dilate3(insideMask, nL, nY);

  // walk each column collecting runs (lines 130-147).
  // NOTE: the MATLAB's start detection fires one sample *before* the run begins
  // (diff(okPts)==1 marks the last off-sample), so segments extend half a step
  // early. Reproduced deliberately -- it is part of what was calibrated.
  const segs = [];
  const okCol = new Uint8Array(nY);
  for (let ix = 0; ix < nL; ix++) {
    for (let iy = 0; iy < nY; iy++) {
      okCol[iy] = kept[iy * nL + ix] && insideDil[iy * nL + ix] ? 1 : 0;
    }
    const starts = [], ends = [];
    if (okCol[0]) starts.push(0);
    for (let iy = 0; iy < nY - 1; iy++) {
      const d = okCol[iy + 1] - okCol[iy];
      if (d === 1) starts.push(iy);
      if (d === -1) ends.push(iy);
    }
    if (okCol[nY - 1]) ends.push(nY - 1);

    const n = Math.min(starts.length, ends.length);
    for (let k = 0; k < n; k++) {
      const i1 = starts[k], i2 = ends[k];
      if (i2 <= i1) continue;
      segs.push([
        xL[i1 * nL + ix], yL[i1 * nL + ix],
        xL[i2 * nL + ix], yL[i2 * nL + ix],
      ]);
    }
  }

  const trimmed = trimLineSegsToPolygon(segs, px, py);
  return trimmed.map((s) => [[s[0], s[1]], [s[2], s[3]]]);
}

export default { id, label, params, run, maxJoinPens };
