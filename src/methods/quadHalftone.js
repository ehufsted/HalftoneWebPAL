// Port of "etc code"/subdivideQuadHalftone.m
//
// The only closed-loop halftoner in the collection. At each node it draws a
// cross, measures whether the *rendered* result got closer to the target, and
// subdivides only if it did:
//
//     if (abs(si-sp) < abs(si-sp2) || min(size(im)<=w))
//         patternOut = pattern;        % stop, and DISCARD the tested cross
//     else
//         ... recurse into four quadrants with pattern2 (cross committed)
//
// There is no tone curve and no calibration constant anywhere in it. It
// measures. That also means the cross is committed only when the recursion
// continues -- leaves never get their own cross, and inverting that is the
// easiest mistake to make here.
//
// Two deliberate departures from the source:
//
//  1. It returns line segments, not a raster. The accumulator below exists only
//     to evaluate the criterion.
//  2. The MATLAB calls renderLineSegment at every node, which supersamples the
//     *entire passed pattern* up and back down each time -- a nine-level
//     recursion resamples the same raster nine times and progressively blurs
//     it. That is an artefact of calling a whole-image renderer inside a
//     recursion, not a design choice. One shared accumulator is used instead.

import { regionMask, whitenOutside } from '../spine/mask.js';
import { cloneImage } from '../shim/image.js';
import { bayerThresholds } from '../shim/bayer.js';
import { mergeCollinear } from '../spine/merge.js';
import { COINCIDENT_PENS } from '../spine/pathOptimizer.js';

export const id = 'quadHalftone';
export const label = 'Quadtree crosses';

export const params = [
  { key: 'maxDepth', label: 'Max depth', type: 'range', min: 1, max: 12, step: 1, def: 9 },
  // off = the MATLAB's accept/reject rule, which runs systematically light
  { key: 'ditherDecisions', label: 'Dither', type: 'checkbox', def: false },
];

/** Supersampling of the ink accumulator, reduced if the canvas is large. */
function chooseSuper(nx, ny) {
  let s = 3;
  while (s > 1 && nx * ny * s * s > 12e6) s--;
  return s;
}

/**
 * Draw one butt-capped segment into the accumulator, returning the total value
 * it zeroed and recording the indices it changed so the caller can undo.
 *
 * Already-inked cells contribute nothing, so overlap is accounted for rather
 * than double-counted -- that self-accounting is what closes the loop. It is
 * also why the two arms must be drawn for real rather than measured
 * independently: measure them separately and the w-by-w square where they cross
 * is counted twice, every decision over-estimates the ink a cross would add,
 * and the recursion stops too early and under-inks.
 */
function applySegment(acc, W, H, S, x1, y1, x2, y2, wPix, changed) {
  const r = (wPix * S) / 2;
  const ax = (x1 - 1) * S + 1, ay = (y1 - 1) * S + 1;
  const bx = (x2 - 1) * S + 1, by = (y2 - 1) * S + 1;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;

  const i1 = Math.max(0, Math.floor(Math.min(ay, by) - r) - 1);
  const i2 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r) - 1);
  const j1 = Math.max(0, Math.floor(Math.min(ax, bx) - r) - 1);
  const j2 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r) - 1);

  let removed = 0;
  for (let iy = i1; iy <= i2; iy++) {
    const py = iy + 1;
    const row = iy * W;
    for (let ix = j1; ix <= j2; ix++) {
      const v = acc[row + ix];
      if (v === 0) continue;
      const px = ix + 1;
      const t = ((px - ax) * dx + (py - ay) * dy) / len2;
      if (t < 0 || t > 1) continue;            // butt caps, as the MATLAB
      const cx = ax + dx * t, cy = ay + dy * t;
      if ((px - cx) ** 2 + (py - cy) ** 2 >= r * r) continue;
      removed += v;
      acc[row + ix] = 0;
      changed.push(row + ix);
    }
  }
  return removed;
}

/** Sum of the accumulator over a block given in 1-based image pixels. */
function blockSum(acc, W, S, cx0, cy0, bw, bh) {
  const j1 = (cx0 - 1) * S, j2 = Math.min(W, (cx0 - 1 + bw) * S);
  const i1 = (cy0 - 1) * S, i2 = (cy0 - 1 + bh) * S;
  let sum = 0;
  for (let iy = i1; iy < i2; iy++) {
    const row = iy * W;
    for (let ix = j1; ix < j2; ix++) sum += acc[row + ix];
  }
  return sum;
}

export function run(ctx) {
  const { nx, ny, w, polygon } = ctx;
  const { px, py } = polygon;
  const maxDepth = Math.max(1, Math.round(ctx.maxDepth ?? 9));

  // whiten outside the polygon, so the criterion never asks for ink there
  const target = whitenOutside(cloneImage(ctx.im), regionMask(ctx));

  // integral image, so a block's target mean is O(1)
  const iw = nx + 1;
  const integral = new Float64Array(iw * (ny + 1));
  for (let y = 0; y < ny; y++) {
    let rowSum = 0;
    for (let x = 0; x < nx; x++) {
      rowSum += target.data[y * nx + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  const targetMean = (cx0, cy0, bw, bh) => {
    const x0 = cx0 - 1, y0 = cy0 - 1, x1 = x0 + bw, y1 = y0 + bh;
    const s = integral[y1 * iw + x1] - integral[y0 * iw + x1]
            - integral[y1 * iw + x0] + integral[y0 * iw + x0];
    return s / (bw * bh);
  };

  const S = chooseSuper(nx, ny);
  // Declared before `recurse` closes over them, not beside the call.
  let inkCommitted = 0, crosses = 0, declined = 0;
  const W = nx * S, H = ny * S;
  const acc = new Float32Array(W * H).fill(1);

  // Toggled from the UI, and switched off by the harness to measure what the
  // correction is worth against the faithful rule.
  const dither = ctx.ditherDecisions !== false;
  const { n: bn, t: bt } = bayerThresholds(2);   // 8x8

  const segments = [];

  // cx0, cy0 are 1-based; bw, bh are sizes in image pixels
  const recurse = (cx0, cy0, bw, bh, depth) => {
    if (bw < 1 || bh < 1) return;

    const cellsInBlock = bw * S * bh * S;
    const si = targetMean(cx0, cy0, bw, bh);
    const spSum = blockSum(acc, W, S, cx0, cy0, bw, bh);
    const sp = spSum / cellsInBlock;

    // the cross: full-height vertical and full-width horizontal, block-centred.
    // Drawn for real so the second arm sees the first arm's ink at the crossing.
    const vx = cx0 + (bw - 1) / 2;
    const hy = cy0 + (bh - 1) / 2;
    const changed = [];
    const trial =
      applySegment(acc, W, H, S, vx, cy0, vx, cy0 + bh - 1, w, changed) +
      applySegment(acc, W, H, S, cx0, hy, cx0 + bw - 1, hy, w, changed);
    const sp2 = (spSum - trial) / cellsInBlock;

    // Hard limits: block smaller than the pen in BOTH dimensions (the MATLAB
    // uses min, i.e. and), or the depth cap.
    const tooSmall = bw <= w && bh <= w;
    let commit = !(tooSmall || depth >= maxDepth);

    if (commit) {
      if (dither) {
        // The MATLAB rule -- commit iff |si-sp2| < |si-sp| -- stops as soon as
        // the cross would overshoot by more than the shortfall. Since ink is
        // only ever added, the residual at that moment is always on the light
        // side, so the drawing runs systematically light by up to half a cross.
        //
        // Instead, commit when the shortfall is a large enough fraction of what
        // a cross would add, against an ordered threshold keyed on the block's
        // position at its own level. Expected ink is then (e/delta)*delta = e,
        // so the bias cancels and the residual is spread across neighbouring
        // blocks rather than accumulating in every one of them.
        const delta = trial / cellsInBlock;
        const e = sp - si;                      // positive = still too light
        if (delta <= 0 || e <= 0) {
          commit = false;
        } else {
          const bxi = Math.floor((cx0 - 1) / Math.max(1, bw)) % bn;
          const byi = Math.floor((cy0 - 1) / Math.max(1, bh)) % bn;
          commit = e / delta > bt[byi * bn + bxi];
        }
      } else {
        commit = !(Math.abs(si - sp) < Math.abs(si - sp2));
      }
    }

    // On stopping the tested cross is discarded -- the MATLAB returns
    // `pattern`, not `pattern2` -- so undo it.
    if (!commit) {
      for (const i of changed) acc[i] = 1;
      declined++;
      return;
    }
    // `trial` is what the accumulator says this cross ADDED -- already-inked
    // cells contribute nothing, so overlap is netted out rather than counted
    // twice. Summing it over committed nodes is the method's own account of the
    // ink it laid, which is the quantity a tone number cannot separate from the
    // ink the page received.
    inkCommitted += trial;
    crosses++;

    segments.push([[vx, cy0], [vx, cy0 + bh - 1]]);
    segments.push([[cx0, hy], [cx0 + bw - 1, hy]]);

    // MATLAB: xs = round(linspace(1, W+1, 3)), so the split lands at
    // round((W+2)/2) in block-local 1-based terms
    const mw = Math.round((bw + 2) / 2) - 1;
    const mh = Math.round((bh + 2) / 2) - 1;
    if (mw < 1 || mh < 1 || mw >= bw || mh >= bh) return;

    recurse(cx0, cy0, mw, mh, depth + 1);
    recurse(cx0 + mw, cy0, bw - mw, mh, depth + 1);
    recurse(cx0, cy0 + mh, mw, bh - mh, depth + 1);
    recurse(cx0 + mw, cy0 + mh, bw - mw, bh - mh, depth + 1);
  };

  recurse(1, 1, nx, ny, 0);

  // Harness-only diagnostics, on the same opt-in channel streamlines and
  // dashedStreamlines use. Nothing reads it back to make a decision.
  if (ctx.quadTally) {
    let asked = 0;
    for (let i = 0; i < ctx.im.data.length; i++) {
      asked += 1 - Math.min(1, Math.max(0, ctx.im.data[i]));
    }
    Object.assign(ctx.quadTally, {
      crosses, declined, asked,
      // acc cells are supersampled; S^2 of them to the pixel
      committed: inkCommitted / (S * S),
    });
  }

  // Vertically stacked siblings share a centre x, so their arms are collinear
  // and touching; merging turns the stubs into long strokes. Not a UI option --
  // there is no reason to want the stubs -- but the harness switches it off to
  // measure what it saves.
  if (ctx.mergeStrokes === false) return segments;
  return mergeCollinear(segments, Math.max(1e-6, w * 0.01));
}

/**
 * Only an exactly shared endpoint may join, as in polygonSubdivision.
 *
 * The marks are a cross per quadtree node, and `mergeCollinear` has already taken
 * every join that is real: it finds the stubs that are collinear AND touching --
 * vertically stacked siblings share a centre x, so their vertical arms run into
 * each other -- and welds them into single strokes. Whatever survives that is a
 * separate mark by construction.
 *
 * So at the pipeline's default of 1.5 pen widths the only joins left to make are
 * wrong ones. The node grid puts stroke ends a fixed small distance apart all
 * over the drawing, and `joinCoincidentLines` appends the next path from its
 * SECOND point, so each bridge both adds ink the ink model never budgeted and
 * drops the point it skipped. The two arms of one cross are not a counter-example:
 * they meet at their midpoints, not at their endpoints, so nothing legitimate is
 * lost by refusing.
 */
export function maxJoinPens() {
  return COINCIDENT_PENS;
}

export default { id, label, params, run, maxJoinPens };
