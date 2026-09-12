// Port of singleWidthLines/code/regionsSFCcollapse.m
// Header: "decently calibrated ... hilbert: generally good."
//
// The drawing is one continuous stroke -- no pen lifts -- which is the plotter
// ideal.
//
// How it works, which the name undersells: the image is rescaled so the pen is
// exactly one pixel, a space-filling curve is laid over it, and every segment is
// given a spring whose *rest length is proportional to the local darkness*. A
// damped relaxation then runs. Where the image is dark the rest length is the
// full segment length, so the curve keeps its space-filling wiggle and lays down
// ink; where it is bright the rest length goes to nearly zero and the curve
// contracts, vacating the area. That contraction is the "collapse".
//
// Curves offered: H-curve (fills a rectangle directly), Hilbert (power-of-two
// square, overhang clipped, as the MATLAB does), and Moore (closed-loop
// Hilbert, so the pen returns to its start). Not offered: the maze path (needs
// randomised Prim's plus a bwtraceboundary shim, and carries a documented tone
// shortfall above 0.7 brightness) and the fourth MATLAB mode, a
// cheapest-insertion TSP over every pixel -- an abandoned experiment at O(n^2)
// over ~400k points.
//
// Note: disentangleLine is NOT a dependency. The call at MATLAB lines 105-106 is
// commented out.

import { polygonMask, whitenOutside } from '../spine/mask.js';
import { interp2, resize, cloneImage, makeImage } from '../shim/image.js';
import { hCurve, countJumps } from '../curves/hcurve.js';
import { hilbertCurve, hilbertParamsFor } from '../curves/hilbert.js';
import { simplifyLineArea } from '../spine/simplify.js';

export const id = 'sfcCollapse';
export const label = 'Space-filling curve (collapse)';

export const params = [
  {
    key: 'curve', label: 'Curve', type: 'select', def: 'hcurve',
    options: [
      { value: 'hcurve', label: 'H-curve (fits rectangle)' },
      { value: 'hilbert', label: 'Hilbert (clipped)' },
      { value: 'moore', label: 'Moore (closed loop)' },
    ],
  },
  { key: 'iterations', label: 'Relax steps', type: 'range', min: 10, max: 400, step: 10, def: 100 },
  { key: 'damping', label: 'Damping', type: 'range', min: 0.02, max: 0.5, step: 0.01, def: 0.1 },
  { key: 'splitAtJumps', label: 'Split at edge gaps', type: 'checkbox', def: true },
  // Not the pipeline's "Simplify paths", despite the name, so it is kept on
  // rather than dropped: that one runs at the end, in centimetres, at a
  // Visvalingam scale of half the pen width. This one runs inside the relaxation,
  // in pixel space, at a tolerance of 0.5 chosen because a right-angle turn on a
  // unit-step curve has triangle area exactly 0.5 — the turns are what carry the
  // shadows, and at 0.75 every one of them is erased. Hidden because the two read
  // as the same control and are not.
  { key: 'simplifyPath', label: 'Simplify path', type: 'checkbox', def: true,
    when: () => false },
];

// MATLAB values, not exposed: a timestep the user can set badly is a way to
// make the relaxation diverge.
const DT = 0.01;
const FMAX = 10;
const DL_MIN = 0.01;
const JUMP_THRESHOLD = 1.5;   // grid steps are ~1 in rescaled units
const MIN_RUN = 4;

/** Points beyond which the relaxation gets slow enough to hurt interactivity. */
const POINT_BUDGET = 400000;

/** Working scale: the pen becomes one pixel, subject to a total point budget. */
function workingScale(w, nx0, ny0) {
  let scale = 1 / w;
  if (nx0 * scale * ny0 * scale > POINT_BUDGET) {
    scale = Math.sqrt(POINT_BUDGET / (nx0 * ny0));
  }
  return scale;
}

/**
 * Build the base curve over an nx-by-ny grid, in 1-based coordinates.
 * Hilbert and Moore cover a power-of-two square and have their overhang
 * discarded with a strict `<`, exactly as regionsSFCcollapse.m line 62 does --
 * which also means the last row and column are never visited.
 */
export function buildCurve(kind, nx, ny) {
  if (kind !== 'hilbert' && kind !== 'moore') return hCurve(nx, ny);

  const moore = kind === 'moore';
  const { side, nIter } = hilbertParamsFor(nx, ny, moore);
  const c = hilbertCurve(nIter, moore);
  const xs = [], ys = [];
  for (let i = 0; i < c.x.length; i++) {
    const X = (c.x[i] / 2 + 0.5) * (side - 1) + 1;
    const Y = (c.y[i] / 2 + 0.5) * (side - 1) + 1;
    if (X < nx && Y < ny) { xs.push(X); ys.push(Y); }
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: xs.length };
}

/**
 * Index ranges of contiguous runs, broken wherever clipping left a gap.
 *
 * This must happen BEFORE the bright-region point removal below. Those two
 * produce gaps that look identical in the point list but mean opposite things:
 * a clip gap is an artefact of discarding the overhang and survives relaxation
 * as a straight chord across the drawing, while a bright-region gap is the
 * collapse itself -- the spring pulling the curve out of white paper. Splitting
 * the second would destroy the method.
 */
function runsBetweenJumps(x, y, split) {
  if (!split) return [[0, x.length]];
  const runs = [];
  let start = 0;
  for (let i = 1; i < x.length; i++) {
    if (Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) > JUMP_THRESHOLD) {
      runs.push([start, i]);
      start = i;
    }
  }
  runs.push([start, x.length]);
  return runs;
}

/** Pass 1 + relaxation + simplify for one contiguous run. Returns a polyline or null. */
function processRun(x, y, from, to, Kim, scale, iterations, damp, simplify) {
  // --- collapse pass 1: drop points where there is essentially no ink to lay
  const px = [], py = [];
  {
    const n = to - from;
    if (n < MIN_RUN) return null;
    const dT = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const a = from + i;
      const v = interp2(Kim, (x[a] + x[a + 1]) / 2, (y[a] + y[a + 1]) / 2);
      dT[i] = isFinite(v) ? v : 0;
    }
    // MATLAB line 92: endpoints keep their single neighbour's value, interior
    // points the sum of the two straddling midpoints
    for (let i = 0; i < n; i++) {
      const keep = i === 0 ? dT[0] > DL_MIN
        : i === n - 1 ? dT[n - 2] > DL_MIN
        : dT[i - 1] + dT[i] > DL_MIN;
      if (keep) { px.push(x[from + i]); py.push(y[from + i]); }
    }
  }
  const n = px.length;
  if (n < MIN_RUN) return null;

  // --- target segment lengths: local darkness times the current length
  const dLTarget = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dL0 = Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]);
    const k = interp2(Kim, (px[i] + px[i + 1]) / 2, (py[i] + py[i + 1]) / 2);
    dLTarget[i] = Math.max((isFinite(k) ? k : 0) * dL0, DL_MIN);
  }

  // --- damped spring relaxation (MATLAB lines 112-163)
  const zx = Float64Array.from(px), zy = Float64Array.from(py);
  const vx = new Float64Array(n), vy = new Float64Array(n);
  const fx = new Float64Array(n), fy = new Float64Array(n);

  for (let it = 0; it < iterations; it++) {
    fx.fill(0); fy.fill(0);
    for (let i = 0; i < n - 1; i++) {
      const dx = zx[i + 1] - zx[i], dy = zy[i + 1] - zy[i];
      const dL = Math.hypot(dx, dy);
      const t = dLTarget[i];
      const g = ((dL - t) / t) * 3;
      const gx = dx * g, gy = dy * g;
      fx[i] -= gx; fy[i] -= gy;
      fx[i + 1] += gx; fy[i + 1] += gy;
    }
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(fx[i], fy[i]);
      if (m > FMAX) { fx[i] = (fx[i] / m) * FMAX; fy[i] = (fy[i] / m) * FMAX; }
      // the MATLAB negates after clamping; with the accumulation above this
      // leaves a stretched spring pulling its nodes toward each other
      vx[i] = vx[i] * (1 - damp) - fx[i] * DT;
      vy[i] = vy[i] * (1 - damp) - fy[i] * DT;
      zx[i] += vx[i];
      zy[i] += vy[i];
    }
  }

  let out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [zx[i] / scale, zy[i] / scale];

  if (simplify) {
    // Tolerance 0.5, applied to coordinates already back in ORIGINAL units --
    // which is what the MATLAB executes (`wLine/2` with wLine clobbered to 1 by
    // the rescale). Visvalingam's threshold is Amin = Lscale^2, and a
    // right-angle turn on a unit-step curve has triangle area exactly 0.5: at
    // 0.5 the turns survive, at 0.75 every one of them is erased along with the
    // ink that carries the shadows.
    out = simplifyLineArea(out, 0.5);
  }
  return out.length >= 2 ? out : null;
}

export function run(ctx) {
  const { nx: nx0, ny: ny0, w, polygon } = ctx;
  const { px, py } = polygon;
  const iterations = Math.max(1, Math.round(ctx.iterations ?? 100));
  const damp = Math.min(0.9, Math.max(0.01, ctx.damping ?? 0.1));
  const kind = ctx.curve ?? 'hcurve';

  // whiten outside the polygon so the curve collapses out of it
  const masked = whitenOutside(cloneImage(ctx.im), polygonMask(nx0, ny0, px, py));

  const scale = workingScale(w, nx0, ny0);
  const im = scale !== 1
    ? resize(masked, Math.max(4, Math.round(nx0 * scale)), Math.max(4, Math.round(ny0 * scale)))
    : masked;
  const nx = im.w, ny = im.h;

  const Kim = makeImage(nx, ny);
  for (let i = 0; i < Kim.data.length; i++) Kim.data[i] = 1 - im.data[i];

  const curve = buildCurve(kind, nx, ny);
  if (curve.n < MIN_RUN) return [];

  const runs = runsBetweenJumps(curve.x, curve.y, ctx.splitAtJumps !== false);
  const lines = [];
  for (const [from, to] of runs) {
    const line = processRun(
      curve.x, curve.y, from, to, Kim, scale,
      iterations, damp, ctx.simplifyPath !== false,
    );
    if (line) lines.push(line);
  }
  return lines;
}

/** Diagnostic for the harness: curve size and how badly the clip fragmented it. */
export function curveStats(ctx, kind = 'hcurve') {
  const scale = workingScale(ctx.w, ctx.nx, ctx.ny);
  const nx = Math.max(4, Math.round(ctx.nx * scale));
  const ny = Math.max(4, Math.round(ctx.ny * scale));
  const c = buildCurve(kind, nx, ny);
  const stats = countJumps(c.x, c.y, JUMP_THRESHOLD);
  return { grid: [nx, ny], scale, cells: nx * ny, ...stats };
}

export default { id, label, params, run };
