// Port of singleWidthLines/code/regionsDitherGridSquare.m and
// regionsDitherGridHex.m, merged into one module.
// Header (both): "is properly calibrated for different dot sizes".
//
// A fixed lattice of candidate dot positions, and five different ways of
// deciding which of them to ink. The two source files share all five modes and
// the whole curve list; they differ only in the lattice's geometry and in one
// constant, so duplicating four hundred lines of dithering to change 0.571 into
// 0.209 would only invite drift.
//
// The tone model here is exact, which is unusual. The dot radius is the cell's
// CIRCUMRADIUS -- half the square's diagonal, or the hexagon's circumradius --
// so a dot covers its own cell entirely, plus one lens spilling into each
// neighbour. Write Kextra = Acircle/Acell - 1 (0.5708 square, 0.2092 hex) and
// the accounting is:
//
//     a drawn cell contributes 1, plus Kextra/deg into each UNDRAWN neighbour
//
// and that is not an approximation. Because each disc passes exactly through
// its cell's vertices, two discs on adjacent cells meet exactly at the two
// vertices of their shared edge -- so the lenses that two different neighbours
// spill into a third cell touch at a single point and never overlap, and a
// drawn neighbour's lens adds nothing because its own disc already covers it.
// Every mode below is bookkeeping over that one exact identity.
//
// It also means full black is reachable: discs circumscribing the cells of a
// tiling cover the plane.

import { resize, interp2, inpolygon } from '../shim/image.js';
import { mulberry32 } from '../spine/random.js';
import { hilbertCurve, hilbertParamsFor } from '../curves/hilbert.js';
import { dotPath } from '../spine/dots.js';

export const id = 'ditherGrid';
export const label = 'Dither grid (dots)';

export const params = [
  {
    key: 'lattice', label: 'Lattice', type: 'select', def: 'hex',
    options: [
      { value: 'square', label: 'Square' },
      { value: 'hex', label: 'Hexagonal' },
    ],
  },
  // The dot's DIAMETER, which is what it looks like on the page; the tone model
  // below works in its radius, the cell's circumradius. It sets the grid too --
  // cells are rDot*sqrt(2) (square) or rDot*sqrt(3) (hex) across -- so dot size
  // and resolution are the same knob here, unlike stippleGrowing.
  { key: 'dDotW', label: 'Dot size', type: 'range', min: 1, max: 12, step: 0.1, def: 3, unit: '×pen' },
  {
    key: 'mode', label: 'Mode', type: 'select', def: 'ed2',
    options: [
      { value: 'threshold', label: 'Threshold' },
      { value: 'ed1', label: 'Error diffusion (1-D, along curve)' },
      { value: 'ed2', label: 'Error diffusion (2-D)' },
      { value: 'dbs', label: 'Test and reject (DBS)' },
      { value: 'random', label: 'Random' },
    ],
  },
  // The diffusion path is what the two error-diffusion modes walk. DBS does not
  // walk anything -- it swaps cells against a blurred objective -- and the other
  // two modes decide each cell on its own, so the control only applies here.
  {
    key: 'curve', label: 'Diffusion path', type: 'select', def: 'hilbert',
    options: [
      { value: 'hilbert', label: 'Hilbert' },
      { value: 'horizontal', label: 'Horizontal serpentine' },
      { value: 'vertical', label: 'Vertical serpentine' },
      { value: 'raster', label: 'Raster' },
    ],
    when: (p) => p.mode === 'ed1' || p.mode === 'ed2',
  },
  { key: 'dbsIterations', label: 'DBS steps', type: 'range', min: 50, max: 2000, step: 50, def: 600,
    when: (p) => p.mode === 'dbs' },
  { key: 'dbsScale', label: 'DBS blur', type: 'range', min: 1, max: 6, step: 0.5, def: 3, unit: ' cells',
    when: (p) => p.mode === 'dbs' },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1 },
];

/**
 * MATLAB `ignoreOverlaps`, a debug flag meaning "pretend the dots are squares".
 * Hardcoded off: with it on the tone is simply wrong, and the whole calibration
 * claim in both headers is about having it off.
 */
const ACCOUNT_FOR_OVERLAPS = true;

/**
 * Tie-break noise for the threshold mode.
 *
 * On a flat field every cell has the same K, so `K > t` is all-or-nothing and
 * thresholding cannot produce an intermediate tone at all -- measured, it gave
 * 8649 dots or zero, nothing between. The MATLAB assumes the CALLER has broken
 * the ties: line 31 of its demo preamble is `im = im+randn(size(im))*1e-6`, and
 * the app supplies no such thing. Same amplitude, applied inside the mode where
 * it belongs.
 *
 * Note what this implies about the mode: in a genuinely flat region the choice
 * of which cells to ink is then purely random, so threshold degenerates to
 * random dithering there. That is the honest behaviour of thresholding, not a
 * defect of the tie-break.
 */
const THRESHOLD_JITTER = 1e-6;

/**
 * DBS neighbourhood width in cells, as the fallback when the caller sets none.
 * The slider defaults wider than this; the trade is below.
 *
 * A narrow kernel is what keeps the dots apart. At sigma = 0.71 cells an undrawn
 * cell with two drawn neighbours reads 2s = 0.285 against a target of maybe 0.1,
 * so adjacency is punished hard, and that penalty is the anti-clumping force
 * this mode exists for. Widening it to 3 measurably improves the tone and just as
 * measurably produces clumps: the same blur that lets the objective see "right
 * on average" makes it blind to arrangement below its own scale, where a clump
 * of three and three spread dots blur to the same field. The slider's default of
 * 3 takes the tone end of that trade.
 *
 * The tone drift a narrow kernel causes is NOT a median-versus-mean effect (an
 * earlier note here said so, wrongly -- that result is about fitting one value
 * to many observations, and here every cell has its own residual). It is that an
 * unblurred error norm gives no credit for a pattern that averages to the
 * target. At K = 0.1 on the square lattice, drawing nothing scores 0.1 per cell
 * while the correct dither scores 0.16, so the optimum is to draw nothing --
 * which is precisely the 11% shortfall measured at brightness 0.9. L2 prefers
 * the same thing (0.01 against 0.09), so the norm is not the lever; only the
 * blur is.
 *
 * One scalar cannot both constrain the mean and resolve the arrangement, so the
 * total is taken out of the objective's hands entirely -- see the swap moves in
 * modeDBS -- and this stays narrow, doing the one job it is good at.
 */
const DBS_SCALE = 1;


// ------------------------------------------------------------------ lattice

/**
 * Candidate dot positions, their darkness, and their adjacency.
 *
 * Square: spacing rDot*sqrt(2), so the dot radius is half the cell diagonal and
 * Acircle/Acell = pi/2. Hex: horizontal spacing rDot*sqrt(3) with rows
 * sqrt(3)/2 of that apart and alternate rows offset half a cell, so the dot
 * radius is the hexagon's circumradius and Acircle/Acell = 2pi/(3 sqrt 3).
 */
export function buildLattice(ctx, kind, rDot) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const hex = kind === 'hex';

  const dxCell = rDot * (hex ? Math.sqrt(3) : Math.SQRT2);
  const dyCell = hex ? (Math.sqrt(3) / 2) * dxCell : dxCell;
  const cols = Math.max(2, Math.round((nx - 1) / dxCell) + 1);
  const rows = Math.max(2, Math.round((ny - 1) / dyCell) + 1);
  const x0 = 1 + (nx - 1 - (cols - 1) * dxCell) / 2;
  const y0 = 1 + (ny - 1 - (rows - 1) * dyCell) / 2;
  const n = cols * rows;

  const Kextra = ACCOUNT_FOR_OVERLAPS
    ? (Math.PI * rDot * rDot) / (dxCell * dyCell) - 1
    : 0;
  const maxDeg = hex ? 6 : 4;

  // One resized pixel per cell, so the downsample area-averages rather than
  // point-sampling -- the MATLAB's imresize. Odd hex rows are then sampled half
  // a cell to the right, which is what its interp2 onto the hex grid does.
  const small = resize(ctx.im, cols, rows);

  const cx = new Float64Array(n), cy = new Float64Array(n);
  const K = new Float64Array(n);
  const inside = new Uint8Array(n);
  for (let i = 0; i < rows; i++) {
    const shift = hex && i % 2 === 1 ? 0.5 : 0;
    for (let j = 0; j < cols; j++) {
      const c = i * cols + j;
      const X = x0 + (j + shift) * dxCell;
      const Y = y0 + i * dyCell;
      cx[c] = X; cy[c] = Y;
      if (!inpolygon(X, Y, px, py)) continue;
      inside[c] = 1;
      const sxp = Math.min(cols, Math.max(1, j + 1 + shift));
      let v = interp2(small, sxp, i + 1);
      if (!isFinite(v)) v = 1;
      K[c] = 1 - Math.min(1, Math.max(0, v));
    }
  }

  // adjacency; -1 marks a missing neighbour, whose share of the spillover is
  // simply lost, as the MATLAB's array shifts also lose it at the border
  const neigh = new Int32Array(n * maxDeg).fill(-1);
  const at = (i, j) => (i < 0 || j < 0 || i >= rows || j >= cols ? -1 : i * cols + j);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const c = i * cols + j;
      const b = c * maxDeg;
      if (!hex) {
        neigh[b] = at(i - 1, j); neigh[b + 1] = at(i + 1, j);
        neigh[b + 2] = at(i, j - 1); neigh[b + 3] = at(i, j + 1);
      } else {
        // odd rows sit half a cell right, so their diagonal neighbours are
        // (j, j+1) in the rows above and below; even rows' are (j-1, j)
        const d = i % 2 === 1 ? 1 : -1;
        neigh[b] = at(i, j - 1); neigh[b + 1] = at(i, j + 1);
        neigh[b + 2] = at(i - 1, j); neigh[b + 3] = at(i - 1, j + d);
        neigh[b + 4] = at(i + 1, j); neigh[b + 5] = at(i + 1, j + d);
      }
    }
  }

  return { n, cols, rows, cx, cy, K, inside, neigh, maxDeg, Kextra, dxCell, dyCell };
}

/**
 * Total effective ink of a pattern, in cell areas, over the region only.
 * This is the exact identity described in the header, not an estimate.
 */
export function effectiveInk(drawn, lat) {
  const { n, neigh, maxDeg, Kextra, inside } = lat;
  const share = Kextra / maxDeg;
  let total = 0;
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    if (drawn[c]) { total += 1; continue; }
    if (share === 0) continue;
    const b = c * maxDeg;
    for (let k = 0; k < maxDeg; k++) {
      const m = neigh[b + k];
      if (m >= 0 && drawn[m]) total += share;
    }
  }
  return total;
}

/** Ink wanted: the darkness actually present in the region. */
function wantedInk(lat) {
  let s = 0;
  for (let c = 0; c < lat.n; c++) if (lat.inside[c]) s += lat.K[c];
  return s;
}

// ------------------------------------------------------------------- curves

/** Visit order over the lattice for the error-diffusion modes. */
function visitOrder(lat, kind) {
  const { cols, rows, n } = lat;
  const order = new Int32Array(n);
  let p = 0;

  if (kind === 'hilbert') {
    const { side, nIter } = hilbertParamsFor(cols, rows, false);
    const c = hilbertCurve(nIter, false);
    const seen = new Uint8Array(n);
    for (let i = 0; i < c.x.length; i++) {
      const X = Math.round((c.x[i] / 2 + 0.5) * (side - 1));
      const Y = Math.round((c.y[i] / 2 + 0.5) * (side - 1));
      if (X < 0 || Y < 0 || X >= cols || Y >= rows) continue;
      const idx = Y * cols + X;
      if (seen[idx]) continue;
      seen[idx] = 1;
      order[p++] = idx;
    }
    // the power-of-two clip can miss cells; sweep up whatever it left
    for (let i = 0; i < n; i++) if (!seen[i]) order[p++] = i;
    return order;
  }

  if (kind === 'vertical') {
    for (let j = 0; j < cols; j++) {
      for (let t = 0; t < rows; t++) {
        const i = j % 2 === 0 ? t : rows - 1 - t;
        order[p++] = i * cols + j;
      }
    }
    return order;
  }

  // horizontal serpentine, or plain raster
  const serpentine = kind !== 'raster';
  for (let i = 0; i < rows; i++) {
    for (let t = 0; t < cols; t++) {
      const j = serpentine && i % 2 === 1 ? cols - 1 - t : t;
      order[p++] = i * cols + j;
    }
  }
  return order;
}

// -------------------------------------------------------------------- modes

/**
 * Mode 0. Find the threshold whose pattern lays down the ink the image asks
 * for. effectiveInk is monotonically non-increasing in t, so this is a plain
 * bisection -- the MATLAB reaches the same place by a seven-step bracket whose
 * bounds are only ever assigned on the first iteration and which finishes with a
 * linear extrapolation across the last bracket instead of the midpoint.
 */
function modeThreshold(lat, rand) {
  const want = wantedInk(lat);
  const drawn = new Uint8Array(lat.n);
  // ties broken so a flat region can take an intermediate tone at all
  const K = new Float64Array(lat.n);
  for (let c = 0; c < lat.n; c++) K[c] = lat.K[c] + (rand() - 0.5) * THRESHOLD_JITTER;
  const fill = (t) => {
    for (let c = 0; c < lat.n; c++) drawn[c] = lat.inside[c] && K[c] > t ? 1 : 0;
    return effectiveInk(drawn, lat);
  };

  let lo = 0, hi = 1;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (fill(mid) < want) hi = mid; else lo = mid;
  }
  // land on whichever side of the bracket is closer
  const eLo = fill(lo), dLo = Math.abs(eLo - want);
  const eHi = fill(hi), dHi = Math.abs(eHi - want);
  if (dLo < dHi) fill(lo);
  return drawn;
}

/**
 * Modes 1 and 2. Walk the lattice along a curve carrying an error term; ink a
 * cell when doing so brings the running error closer to zero.
 *
 * The ink a cell adds is not 1: it is 1, PLUS its own spillover into every
 * undrawn neighbour, MINUS the spillover those neighbours were already
 * contributing to it (which its own disc now covers). That signed term is what
 * makes the accounting exact.
 */
function modeErrorDiffusion(lat, twoD, curve) {
  const { n, neigh, maxDeg, Kextra, K, inside } = lat;
  const share = Kextra / maxDeg;
  const order = visitOrder(lat, curve);
  const drawn = new Uint8Array(n);
  const done = new Uint8Array(n);
  const acc = Float64Array.from(K);
  let err = 0;

  for (let t = 0; t < n; t++) {
    const c = order[t];
    done[c] = 1;
    if (!inside[c]) continue;
    err += acc[c];

    let add = 1;
    const b = c * maxDeg;
    if (share !== 0) {
      for (let k = 0; k < maxDeg; k++) {
        const m = neigh[b + k];
        if (m < 0) continue;
        add += drawn[m] ? -share : share;
      }
    }

    if (Math.abs(err - add) < Math.abs(err)) {
      drawn[c] = 1;
      err -= add;
    }

    if (twoD) {
      let cnt = 0;
      for (let k = 0; k < maxDeg; k++) {
        const m = neigh[b + k];
        if (m >= 0 && !done[m]) cnt++;
      }
      if (cnt > 0) {
        const part = err / cnt;
        for (let k = 0; k < maxDeg; k++) {
          const m = neigh[b + k];
          if (m >= 0 && !done[m]) acc[m] += part;
        }
        err = 0;
      }
    }
  }
  return drawn;
}

/**
 * Mode 4. Ink each cell independently with the probability that makes the
 * EXPECTED ink correct.
 *
 * Expected ink per cell is p*(1 + Kextra*(1-p)), so setting that equal to K and
 * solving gives the density. The MATLAB tabulates the same root at a hundred
 * points and interpolates; solving it directly is exact and shorter. Its square
 * version writes the root out longhand as
 * (pi - sqrt(pi^2 - 8k(pi-2)))/(2(pi-2)), which is this formula with
 * Kextra = pi/2 - 1 -- worth checking if you touch it, because it is the one
 * place the overlap model is stated in closed form.
 */
function modeRandom(lat, rand) {
  const { n, K, inside, Kextra } = lat;
  const drawn = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    const k = Math.min(1, Math.max(0, K[c]));
    let p;
    if (Kextra <= 1e-12) {
      p = k;
    } else {
      const b = 1 + Kextra;
      const disc = Math.max(0, b * b - 4 * Kextra * k);
      p = (b - Math.sqrt(disc)) / (2 * Kextra);
    }
    drawn[c] = rand() < p ? 1 : 0;
  }
  return drawn;
}

/**
 * Mode 3, direct binary search: start from the random dither and repeatedly
 * flip cells, keeping a flip only when it reduces the blurred error.
 *
 * The MATLAB re-convolves the WHOLE grid every iteration, a thousand times -- at
 * this app's resolution that is billions of operations. Flipping a cell only
 * perturbs the effective ink at that cell and its neighbours, so the blurred
 * field changes only within one kernel radius of those, and the error can be
 * updated incrementally. The trial is scored into a scratch buffer and committed
 * only if it wins, so a rejected step costs nothing to undo.
 *
 * Note scaleDBS = 1 makes the kernel very narrow indeed (sigma = 0.71 cells), so
 * this is much more local than "direct binary search" usually implies. Faithful.
 */
function modeDBS(lat, rand, iterations, scale) {
  const { n, cols, rows, inside } = lat;
  const DBS_SCALE = scale;

  const kr = Math.min(8, Math.max(1, Math.round(2.5 * DBS_SCALE)));
  const kw = 2 * kr + 1;
  const ws = new Float64Array(kw * kw);
  let wsum = 0;
  for (let dy = -kr; dy <= kr; dy++) {
    for (let dx = -kr; dx <= kr; dx++) {
      const v = Math.exp(-(dx * dx + dy * dy) / (DBS_SCALE * DBS_SCALE));
      ws[(dy + kr) * kw + (dx + kr)] = v;
      wsum += v;
    }
  }
  for (let i = 0; i < ws.length; i++) ws[i] /= wsum;

  const blur = (src) => {
    const out = new Float64Array(n);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        let s = 0;
        for (let dy = -kr; dy <= kr; dy++) {
          const iy = Math.min(rows - 1, Math.max(0, i + dy));
          for (let dx = -kr; dx <= kr; dx++) {
            const ix = Math.min(cols - 1, Math.max(0, j + dx));
            s += src[iy * cols + ix] * ws[(dy + kr) * kw + (dx + kr)];
          }
        }
        out[i * cols + j] = s;
      }
    }
    return out;
  };

  const cellInk = (drawn, c) => {
    if (!inside[c]) return 0;
    if (drawn[c]) return 1;
    const share = lat.Kextra / lat.maxDeg;
    if (share === 0) return 0;
    let s = 0;
    const b = c * lat.maxDeg;
    for (let k = 0; k < lat.maxDeg; k++) {
      const m = lat.neigh[b + k];
      if (m >= 0 && drawn[m]) s += share;
    }
    return s;
  };

  const drawn = modeRandom(lat, rand);
  const target = blur(lat.K);
  const keff = new Float64Array(n);
  for (let c = 0; c < n; c++) keff[c] = cellInk(drawn, c);
  const avg = blur(keff);

  let want = 0;
  for (let c = 0; c < n; c++) if (inside[c]) want += lat.K[c];
  const maxFlips = Math.max(1, Math.round(0.01 * want));
  const minFlips = 5;

  const touched = new Int32Array(n);
  const stamp = new Int32Array(n);
  const cumOn = new Float64Array(n);
  const cumOff = new Float64Array(n);
  let epoch = 0;
  const delta = new Float64Array(n);
  const flips = new Int32Array(Math.max(minFlips, maxFlips));
  const affected = new Int32Array((lat.maxDeg + 1) * flips.length);

  for (let it = 0; it < iterations; it++) {
    const decay = Math.exp(-(it / iterations) / 0.1);
    const nFlip = Math.max(minFlips, Math.round(minFlips + (maxFlips - minFlips) * decay));

    // SWAP MOVES, not free toggles. The MATLAB flips cells independently, which
    // lets the objective change the dot count -- and with a narrow kernel it
    // always wants to, because an unblurred norm scores "draw nothing" better
    // than any dither. Turning one cell on where the field is too light and one
    // off where it is too dark keeps the count fixed, so the tone is inherited
    // from the random start (correct in expectation) and the search is left to
    // do only the arrangement, which is what it is good at. This is also the
    // standard DBS move set.
    //
    // Both cumulatives are built ONCE per iteration and binary searched. The
    // MATLAB rescans the whole grid inside its per-flip loop
    // (`find(rand*err3(end)<err3,1,'first')`), which is O(cells x flips) per
    // iteration -- 466M operations over a default run here.
    let totOn = 0, totOff = 0;
    for (let c = 0; c < n; c++) {
      const e = target[c] - avg[c];              // positive: too light here
      if (inside[c] && e > 0 && !drawn[c]) totOn += e * e;
      if (inside[c] && e < 0 && drawn[c]) totOff += e * e;
      cumOn[c] = totOn;
      cumOff[c] = totOff;
    }
    if (!(totOn > 0) || !(totOff > 0)) break;

    const pick = (cumArr, tot) => {
      const r = rand() * tot;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumArr[mid] < r) lo = mid + 1; else hi = mid;
      }
      return lo;
    };

    epoch++;
    let nf = 0;
    for (let k = 0; k < Math.max(1, nFlip >> 1) && nf + 1 < flips.length; k++) {
      const a = pick(cumOn, totOn);
      const b = pick(cumOff, totOff);
      // a cell chosen twice in one step would cancel itself out
      if (a === b || stamp[a] === epoch || stamp[b] === epoch) continue;
      stamp[a] = epoch; stamp[b] = epoch;
      flips[nf++] = a;
      flips[nf++] = b;
    }
    if (nf === 0) continue;

    // effective ink changes only at the flipped cells and their neighbours
    epoch++;
    let nAff = 0;
    for (let k = 0; k < nf; k++) drawn[flips[k]] ^= 1;
    for (let k = 0; k < nf; k++) {
      const c = flips[k];
      const b = c * lat.maxDeg;
      for (let q = -1; q < lat.maxDeg; q++) {
        const m = q < 0 ? c : lat.neigh[b + q];
        if (m < 0 || stamp[m] === epoch) continue;
        stamp[m] = epoch;
        delta[m] = cellInk(drawn, m) - keff[m];
        if (delta[m] !== 0) affected[nAff++] = m;
      }
    }

    // score the trial into the blurred field without committing
    epoch++;
    let nT = 0, dE = 0;
    for (let a = 0; a < nAff; a++) {
      const c = affected[a];
      const ci = (c / cols) | 0, cj = c % cols;
      for (let dy = -kr; dy <= kr; dy++) {
        const iy = ci + dy;
        if (iy < 0 || iy >= rows) continue;
        for (let dx = -kr; dx <= kr; dx++) {
          const ix = cj + dx;
          if (ix < 0 || ix >= cols) continue;
          const b2 = iy * cols + ix;
          if (stamp[b2] !== epoch) { stamp[b2] = epoch; touched[nT++] = b2; }
        }
      }
    }
    for (let t = 0; t < nT; t++) dE -= Math.abs(avg[touched[t]] - target[touched[t]]);
    for (let a = 0; a < nAff; a++) {
      const c = affected[a];
      const ci = (c / cols) | 0, cj = c % cols;
      for (let dy = -kr; dy <= kr; dy++) {
        const iy = ci + dy;
        if (iy < 0 || iy >= rows) continue;
        for (let dx = -kr; dx <= kr; dx++) {
          const ix = cj + dx;
          if (ix < 0 || ix >= cols) continue;
          avg[iy * cols + ix] += delta[c] * ws[(dy + kr) * kw + (dx + kr)];
        }
      }
    }
    for (let t = 0; t < nT; t++) dE += Math.abs(avg[touched[t]] - target[touched[t]]);

    if (dE < 0) {
      for (let a = 0; a < nAff; a++) keff[affected[a]] += delta[affected[a]];
      // (the running total E was maintained here and never read; dE alone decides)
    } else {
      // roll back: undo the blur contributions and the flips
      for (let a = 0; a < nAff; a++) {
        const c = affected[a];
        const ci = (c / cols) | 0, cj = c % cols;
        for (let dy = -kr; dy <= kr; dy++) {
          const iy = ci + dy;
          if (iy < 0 || iy >= rows) continue;
          for (let dx = -kr; dx <= kr; dx++) {
            const ix = cj + dx;
            if (ix < 0 || ix >= cols) continue;
            avg[iy * cols + ix] -= delta[c] * ws[(dy + kr) * kw + (dx + kr)];
          }
        }
      }
      for (let k = 0; k < nf; k++) drawn[flips[k]] ^= 1;
    }
  }
  return drawn;
}

// ---------------------------------------------------------------------- run

/** Which cells get a dot. Exported so the harness can score the ink identity. */
export function ditherPattern(ctx) {
  const rDot = Math.max(ctx.w / 2, ((ctx.dDotW ?? 3) / 2) * ctx.w);
  const lat = buildLattice(ctx, ctx.lattice ?? 'hex', rDot);
  const rand = mulberry32(Math.round(ctx.seed ?? 1));
  const mode = ctx.mode ?? 'ed2';

  let drawn;
  if (mode === 'threshold') drawn = modeThreshold(lat, rand);
  else if (mode === 'ed1') drawn = modeErrorDiffusion(lat, false, ctx.curve ?? 'hilbert');
  else if (mode === 'ed2') drawn = modeErrorDiffusion(lat, true, ctx.curve ?? 'hilbert');
  else if (mode === 'dbs') {
    drawn = modeDBS(lat, rand, Math.round(ctx.dbsIterations ?? 600),
                    ctx.dbsScale ?? DBS_SCALE);
  } else drawn = modeRandom(lat, rand);

  return { lat, drawn, rDot, wanted: wantedInk(lat), effective: effectiveInk(drawn, lat) };
}

export function run(ctx) {
  const { lat, drawn, rDot } = ditherPattern(ctx);
  const w = ctx.w;
  const lines = [];
  for (let c = 0; c < lat.n; c++) {
    if (!drawn[c] || !lat.inside[c]) continue;
    lines.push(dotPath(lat.cx[c], lat.cy[c], rDot, w));
  }
  return lines;
}

// No targetImage: every mode aims at the source image exactly, and the overlap
// accounting above is exact rather than a correction to be modelled.
export default { id, label, params, run };
