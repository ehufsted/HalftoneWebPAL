// Port of singleWidthLines/code/demoWigglyLinesHalftoning.m, with the amplitude
// encoding from fixwigglyLinesHalftoningVaryAmplitude.m folded in.
// Write-up: singleWidthLines.tex, "Seismographs: Paths through an image".
//
// A carrier path is followed and a wave is superimposed on it, riding the
// carrier's left normal. Tone comes from how much extra ink the wiggle lays
// down per unit of carrier: either the WAVELENGTH shortens as the image darkens
// (fixed full-envelope amplitude) or the AMPLITUDE grows (fixed wavelength).
// One continuous stroke for the whole drawing is the plotter ideal, and this is
// the method that delivers it -- pen lifts appear only where the polygon clip
// forces them.
//
// UNITS TRAP, and the easiest sign error in the source: throughout the write-up
// `A` is the PEAK-TO-PEAK amplitude, capped at H-w, while every MATLAB script
// keeps the HALF-amplitude (H-w)/2 in its local variable. The three area-ratio
// expressions are consistent once you see that -- demoWigglyLines line 127 uses
// 4*(H-w)^2 for 4A^2, evaluateWigglyHalftoning line 57 uses 16*Ahalf^2 for the
// same thing. Here `A` always means peak-to-peak and `ampHalf` always means the
// geometric offset, and the two are never spelled the same way.
//
// The tone model is the closed form. The square wave has its own area ratio; the
// sine borrows the sawtooth's, as the source does, because it is a surprisingly
// good approximation. The source's undocumented `phi = phi*.95` fudge on the
// sine's phase is not reproduced — verify.html measures the true area ratio with
// the renderer, so any correction can be fitted to data instead of guessed.

import { interp2 } from '../shim/image.js';
import { interpTable } from '../spine/interp.js';
import { affineTarget } from '../spine/tone.js';
import { hCurve } from '../curves/hcurve.js';
import { hilbertCurve, hilbertParamsFor } from '../curves/hilbert.js';
import { clipPolyline } from '../spine/geometry.js';

export const id = 'wigglyLines';
export const label = 'Wiggly lines (seismograph)';

export const params = [
  {
    key: 'carrier', label: 'Carrier', type: 'select', def: 'spiral',
    options: [
      { value: 'spiral', label: 'Spiral' },
      { value: 'scan', label: 'Horizontal scan' },
      { value: 'hcurve', label: 'H-curve (fits rectangle)' },
      { value: 'hilbert', label: 'Hilbert (clipped)' },
      { value: 'moore', label: 'Moore (closed loop)' },
    ],
  },
  {
    key: 'waveform', label: 'Waveform', type: 'select', def: 'sawtooth',
    options: [
      { value: 'square', label: 'Square' },
      { value: 'sawtooth', label: 'Sawtooth' },
      { value: 'sine', label: 'Sine' },
    ],
  },
  {
    key: 'modulation', label: 'Tone from', type: 'select', def: 'wavelength',
    options: [
      { value: 'wavelength', label: 'Wavelength (fixed amplitude)' },
      { value: 'amplitude', label: 'Amplitude (fixed wavelength)' },
    ],
  },
  // Both spacings are in multiples of the pen width, which is the only frame in
  // which this method's limits are constant: the tone ceiling is 1-w/H, so
  // "spacing" IS the ceiling, and the wavelength floor is a fixed number of pen
  // widths below which the wave folds onto itself. No dynamic bounds needed.
  { key: 'spacingW', label: 'Line spacing', type: 'range', min: 2, max: 10, step: 0.5, def: 8, unit: '×pen' },
  // min 2 is a merge floor, not a taste call: below L = 2w the half-periods sit
  // closer together than the pen is wide, so the wave fills solid on paper.
  { key: 'wavelengthW', label: 'Wavelength', type: 'range', min: 2, max: 10, step: 0.5, def: 3, unit: '×pen' },
];

/** Carrier sample step, as the MATLAB's sine branch uses (line 172). */
const STEP_DIV = 3;
const POINT_BUDGET = 400000;
/** Grid steps further apart than this mean the curve was clipped, not walked. */
const JUMP_THRESHOLD = 1.5;

// ---------------------------------------------------------------- tone model

function areaRatioSquare(w, H, A, L) {
  return (w * (2 * A + L)) / (H * L) - (w * w * (4 - Math.PI)) / (4 * H * L);
}

function areaRatioSawtooth(w, H, A, L) {
  return (w * (4 * L * Math.sqrt(4 * A * A + L * L) - 4 * w * A
              + w * L * (Math.PI - 2 * Math.atan(L / (2 * A)))))
       / (4 * H * L * L);
}

// Simpson nodes for the sine's arc-length integral. Fixed abscissae, so the
// cosines are computed once.
const ARC_N = 64;
const ARC_H = Math.PI / 2 / ARC_N;
const ARC_COS2 = (() => {
  const c = new Float64Array(ARC_N + 1);
  for (let i = 0; i <= ARC_N; i++) { const v = Math.cos(i * ARC_H); c[i] = v * v; }
  return c;
})();

/**
 * Arc length of one sine period, per unit wavelength: the mean of
 * sqrt(1 + k^2 cos^2 u) over a period, with k = pi*A/L the peak slope of
 * y = (A/2) sin(2 pi x / L). Equals 1 for a straight line.
 *
 * This is (2/pi)*sqrt(1+k^2)*E(k^2/(1+k^2)) in closed form; Simpson over a
 * quarter period is shorter than carrying an elliptic-integral routine and is
 * exact to ~1e-9 here, and the table it feeds is built a couple of hundred
 * times per run.
 */
export function sineArcFactor(k) {
  let sum = 0;
  for (let i = 0; i <= ARC_N; i++) {
    const f = Math.sqrt(1 + k * k * ARC_COS2[i]);
    sum += f * (i === 0 || i === ARC_N ? 1 : (i % 2 ? 4 : 2));
  }
  return (2 / Math.PI) * (ARC_H / 3) * sum;
}

// Sine peak self-overlap. THESE TWO CONSTANTS ARE FITTED, and this comment is
// the price of that -- see the README for the table they came from.
//
// The VARIABLE is derived, which is what makes the fit trustworthy: a pen of
// radius w/2 sweeping a curve of radius R doubles back on itself once R < w/2,
// and a sine's peak radius is R = L^2/(2 pi^2 A). So rho = 2R/w = L^2/(pi^2 A w)
// is 1 exactly at onset, and the measurement's onset lands there -- the excess
// is nil at rho > 1 and rises steeply below it, at every envelope height.
// Rewriting the measured excess in rho collapses three envelope heights onto one
// curve, which is what says the variable is the right one.
//
// Fitted on that curve: 0.0278*w^2*(1/rho-1)^1.35 of over-counted area per peak,
// two peaks per period. Residuals <= 0.0011 for L/w >= 3, growing to 0.044 at
// L/w = 2 where coverage is saturating anyway. Below L/w = 2 the half-periods
// are closer together than the pen is wide, so the result is solid ink whatever
// the model says; the wavelength slider stops there.
const SINE_OVERLAP_C = 0.0278;
const SINE_OVERLAP_P = 1.35;

function sineOverlap(w, H, A, L) {
  const rho = (L * L) / (Math.PI * Math.PI * A * w);
  if (!(rho < 1)) return 0;
  const excess = SINE_OVERLAP_C * w * w * Math.pow(1 / rho - 1, SINE_OVERLAP_P);
  return (2 * excess) / (H * L);
}

/**
 * Coverage of one wave period, as a fraction of its H-by-lambda envelope.
 * `A` is PEAK-TO-PEAK.
 *
 * MEASURED, against the renderer, by verify.html's sweep -- see the README.
 * The sawtooth's closed form came back accurate to the measurement floor and is
 * used as the write-up derives it. The sine does NOT share it, though the
 * MATLAB makes it (line 158): two things go wrong at once.
 *
 *   1. A sine is longer than the triangle through the same extremes -- the arc
 *      integral above against sqrt(1+4(A/L)^2) -- so it lays more ink.
 *   2. Worse, the sawtooth's `-4wA + wL(pi-2atan(L/2A))` terms subtract the
 *      overlap where two straight arms meet at a VERTEX. A sine has no vertex,
 *      so subtracting it is simply wrong, and it is the larger of the two
 *      errors.
 *
 * Dropping the vertex terms and taking the exact arc length gave
 * (w/H)*I(pi A/L), exact for L/w >= 6 -- and a re-measurement then showed the
 * error had changed SIGN at short wavelengths, which is what located the last
 * term. A sine has no vertex but it does have a peak, and once the peak's radius
 * falls below the pen's the stroke doubles back on itself. `sineOverlap` above
 * carries that; its onset is derived, its magnitude is fitted.
 *
 * A wave can never lay down less ink than the straight line through it, which is
 * the floor applied below.
 */
export function areaRatio(waveform, w, H, A, L) {
  if (!(L > 0)) return 1;
  const flat = Math.min(1, w / H);
  if (!(A > 0)) return flat;                     // straight line still lays ink
  let ar;
  if (waveform === 'square') {
    ar = areaRatioSquare(w, H, A, L);
  } else if (waveform === 'sine') {
    ar = (w / H) * sineArcFactor((Math.PI * A) / L) - sineOverlap(w, H, A, L);
    ar = Math.max(flat, ar);
  } else {
    ar = areaRatioSawtooth(w, H, A, L);
  }
  return Math.min(1, Math.max(0, ar));
}

/** Envelope height and pen width in pixels, from the pen-relative params. */
function scalesOf(ctx) {
  const w = ctx.w;
  const H = Math.max(w * 1.5, (ctx.spacingW ?? 8) * w);
  const L0 = Math.max(w, (ctx.wavelengthW ?? 3) * w);
  return { w, H, L0, Amax: Math.max(0, H - w) };
}

/**
 * The brightness band this method can actually reach.
 *
 * The floor on coverage is w/H -- an unmodulated line still lays down ink -- so
 * this method can never draw white, and the ceiling moves with the line
 * spacing. The MATLAB's wavelength script maps tone in multiplicatively
 * (`B2 = BL*Bmax`), which lands white correctly but sends black to a coverage
 * the wavelength clamp cannot reach; its amplitude script does the affine remap
 * the write-up actually prescribes ("rescale the desired blackness to be within
 * those bounds"). Both use the affine one here.
 */
export function toneBand(ctx) {
  const { w, H, L0, Amax } = scalesOf(ctx);
  const waveform = ctx.waveform ?? 'sawtooth';
  if ((ctx.modulation ?? 'wavelength') === 'amplitude') {
    return {
      max: 1 - areaRatio(waveform, w, H, 0, L0),
      min: 1 - areaRatio(waveform, w, H, Amax, L0),
    };
  }
  return {
    max: 1 - areaRatio(waveform, w, H, Amax, 5 * H),
    min: 1 - areaRatio(waveform, w, H, Amax, L0),
  };
}
/** What the method is aiming for: the image squeezed into the reachable band. */
export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}


// ------------------------------------------------------------------ carriers

/** Resample a polyline to a uniform arc-length step, with its unit left normal. */
function resampleUniform(xs, ys, step) {
  const n = xs.length;
  if (n < 2) return null;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const total = cum[n - 1];
  if (!(total > 0)) return null;
  const m = Math.max(2, Math.floor(total / step) + 1);

  const x = new Float64Array(m), y = new Float64Array(m), s = new Float64Array(m);
  for (let k = 0, i = 1; k < m; k++) {
    const target = Math.min(total, k * step);
    while (i < n - 1 && cum[i] < target) i++;
    const seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? (target - cum[i - 1]) / seg : 0;
    x[k] = xs[i - 1] + t * (xs[i] - xs[i - 1]);
    y[k] = ys[i - 1] + t * (ys[i] - ys[i - 1]);
    s[k] = target;
  }

  // Unit left normal, by central difference. The MATLAB takes
  // unwrap(-atan2(dy,dx)) and interp1s the angle; going straight to the vector
  // skips both the unwrap and the angular interpolation, which is where mod-2pi
  // bugs live -- and the offset it wants, (sin th, cos th), IS the left normal.
  const nxv = new Float64Array(m), nyv = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1);
    const dx = x[b] - x[a], dy = y[b] - y[a];
    const len = Math.hypot(dx, dy) || 1;
    nxv[k] = -dy / len;
    nyv[k] = dx / len;
  }
  return { x, y, s, nx: nxv, ny: nyv, n: m };
}

/**
 * Archimedean spiral of pitch H, centred, large enough to cover the corners
 * (the MATLAB's includeCorners = 1 case; the inscribed variant is not offered,
 * since it leaves most of a non-square page blank).
 *
 * t is advanced ADAPTIVELY rather than in equal increments. For r = Ht/2pi the
 * arc element is ds/dt = (H/2pi)*sqrt(1+t^2), so a fixed dt that resolves the
 * outermost turn wastes tens of thousands of points on the innermost one, and a
 * fixed dt that is affordable leaves the outer turns visibly faceted -- at the
 * harness's ramp settings, 8 px chords against a 1.5 px pen. Stepping by
 * dt = step/(ds/dt) samples every turn at the same arc length.
 */
function spiralCarrier(nx, ny, H, step) {
  const cx = (1 + nx) / 2, cy = (1 + ny) / 2;
  const tMax = 2 * Math.PI * ((Math.hypot(nx, ny) / 2 + H) / H);
  const k = H / (2 * Math.PI);
  const xs = [], ys = [];
  for (let t = 0; t < tMax; t += Math.max(1e-4, step / (k * Math.sqrt(1 + t * t)))) {
    const r = k * t;
    xs.push(cx + r * Math.cos(t));
    ys.push(cy + r * Math.sin(t));
  }
  const r = k * tMax;
  xs.push(cx + r * Math.cos(tMax));
  ys.push(cy + r * Math.sin(tMax));
  return [{ xs: Float64Array.from(xs), ys: Float64Array.from(ys) }];
}

/** Serpentine horizontal rows, H apart, joined at the ends. */
function scanCarrier(nx, ny, H) {
  const rows = Math.max(1, Math.floor((ny - 1) / H) + 1);
  const y0 = (1 + ny) / 2 - ((rows - 1) * H) / 2;
  const xs = [], ys = [];
  for (let r = 0; r < rows; r++) {
    const yv = y0 + r * H;
    const left = r % 2 === 0;
    xs.push(left ? 1 : nx, left ? nx : 1);
    ys.push(yv, yv);
  }
  return [{ xs: Float64Array.from(xs), ys: Float64Array.from(ys) }];
}

/**
 * A space-filling curve at pitch H. The curve is built on a coarse grid whose
 * cell is H across, then scaled up -- so neighbouring passes sit exactly H
 * apart and the envelope argument carries over unchanged.
 *
 * Hilbert and Moore are clipped to a power-of-two square, and a clip gap is a
 * jump, not a walk. Riding a wiggle along that chord would draw a modulated
 * line straight across the picture, so the carrier is split there and the
 * pieces are returned separately -- the same distinction sfcCollapse draws.
 */
function sfcCarrier(kind, nx, ny, H) {
  const gx = Math.max(2, Math.round((nx - 1) / H) + 1);
  const gy = Math.max(2, Math.round((ny - 1) / H) + 1);

  let g;
  if (kind === 'hcurve') {
    g = hCurve(gx, gy);
  } else {
    const moore = kind === 'moore';
    const { side, nIter } = hilbertParamsFor(gx, gy, moore);
    const c = hilbertCurve(nIter, moore);
    const xs = [], ys = [];
    for (let i = 0; i < c.x.length; i++) {
      const X = (c.x[i] / 2 + 0.5) * (side - 1) + 1;
      const Y = (c.y[i] / 2 + 0.5) * (side - 1) + 1;
      if (X < gx && Y < gy) { xs.push(X); ys.push(Y); }
    }
    g = { x: Float64Array.from(xs), y: Float64Array.from(ys), n: xs.length };
  }
  if (g.n < 2) return [];

  const ox = (1 + nx) / 2 - ((gx - 1) * H) / 2;
  const oy = (1 + ny) / 2 - ((gy - 1) * H) / 2;
  const out = [];
  let xs = [], ys = [];
  for (let i = 0; i < g.n; i++) {
    if (i > 0 && Math.hypot(g.x[i] - g.x[i - 1], g.y[i] - g.y[i - 1]) > JUMP_THRESHOLD) {
      if (xs.length > 1) out.push({ xs: Float64Array.from(xs), ys: Float64Array.from(ys) });
      xs = []; ys = [];
    }
    xs.push(ox + (g.x[i] - 1) * H);
    ys.push(oy + (g.y[i] - 1) * H);
  }
  if (xs.length > 1) out.push({ xs: Float64Array.from(xs), ys: Float64Array.from(ys) });
  return out;
}

/** All carriers, uniformly resampled. Exported so the harness can measure them. */
export function buildCarriers(ctx, H, step) {
  const { nx, ny } = ctx;
  const kind = ctx.carrier ?? 'spiral';
  const raw = kind === 'spiral' ? spiralCarrier(nx, ny, H, step)
            : kind === 'scan' ? scanCarrier(nx, ny, H)
            : sfcCarrier(kind, nx, ny, H);
  const out = [];
  for (const r of raw) {
    const c = resampleUniform(r.xs, r.ys, step);
    if (c) out.push(c);
  }
  return out;
}

// ----------------------------------------------------------------- the wave

/**
 * All three waveforms put their special points at phi = k*pi, which is what
 * lets one corner-insertion loop serve both piecewise-linear cases:
 *   square   flips level there,
 *   sawtooth reaches an extremum there (it is a symmetric TRIANGLE wave -- the
 *            write-up calls it a sawtooth, and both MATLAB scripts build it
 *            that way, extrema at multiples of pi, starting at -1),
 *   sine     merely crosses zero, so it needs no inserted points at all.
 */
const waveValue = {
  sine: (phi) => Math.sin(phi),
  sawtooth: (phi) => (2 / Math.PI) * Math.asin(Math.sin(phi - Math.PI / 2)),
  square: (phi) => (Math.sin(phi) >= 0 ? 1 : -1),
};

/**
 * Lay the wave onto one carrier.
 *
 * Every carrier sample gets a point, and the exact turning points at
 * phi = k*pi are inserted on top -- so a square wave gets its vertical jump as
 * two coincident-in-s points at opposite levels, and a sawtooth gets a sharp
 * peak, while the runs between corners follow the carrier rather than chording
 * across it. The MATLAB emits only the corners and lets straight chords join
 * them, which is fine on a gentle spiral and wrong near its centre, where a
 * chord can cut into the neighbouring turn. The extra points cost nothing
 * downstream: the simplify pass collapses the collinear ones again.
 *
 * @param {object} carrier  from buildCarriers
 * @param {Float64Array} phi      phase at each carrier sample, non-decreasing
 * @param {Float64Array} ampHalf  half-amplitude at each carrier sample, pixels
 */
export function modulate(carrier, phi, ampHalf, waveform) {
  const f = waveValue[waveform] || waveValue.sawtooth;
  const { x, y, nx, ny, n } = carrier;
  const pts = [];
  const emit = (px, py, nX, nY, a, v) => pts.push([px + nX * a * v, py + nY * a * v]);

  emit(x[0], y[0], nx[0], ny[0], ampHalf[0], f(phi[0]));
  for (let i = 1; i < n; i++) {
    // corners of the piecewise-linear waveforms fall at phi = k*pi
    if (waveform !== 'sine') {
      const kStart = Math.floor(phi[i - 1] / Math.PI) + 1;
      const kEnd = Math.floor(phi[i] / Math.PI);
      for (let k = kStart; k <= kEnd; k++) {
        const span = phi[i] - phi[i - 1];
        const t = span > 0 ? (k * Math.PI - phi[i - 1]) / span : 0;
        const cxp = x[i - 1] + t * (x[i] - x[i - 1]);
        const cyp = y[i - 1] + t * (y[i] - y[i - 1]);
        let cnx = nx[i - 1] + t * (nx[i] - nx[i - 1]);
        let cny = ny[i - 1] + t * (ny[i] - ny[i - 1]);
        const len = Math.hypot(cnx, cny) || 1;
        cnx /= len; cny /= len;
        const amp = ampHalf[i - 1] + t * (ampHalf[i] - ampHalf[i - 1]);
        // The level held on ((k-1)pi, k pi) is (-1)^(k-1), which is also the
        // triangle's extremum at k pi. So both waveforms arrive at `e`; only the
        // square leaves at -e, and that second point is the riser -- the 2A term
        // in its area ratio.
        const e = k % 2 === 0 ? -1 : 1;
        emit(cxp, cyp, cnx, cny, amp, e);
        if (waveform === 'square') emit(cxp, cyp, cnx, cny, amp, -e);
      }
    }
    emit(x[i], y[i], nx[i], ny[i], ampHalf[i], f(phi[i]));
  }
  return pts;
}


// --------------------------------------------------------------------- run

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const { w, H, L0, Amax } = scalesOf(ctx);
  const waveform = ctx.waveform ?? 'sawtooth';
  const byAmplitude = (ctx.modulation ?? 'wavelength') === 'amplitude';
  if (!(Amax > 0)) return [];

  let step = w / STEP_DIV;
  const carriers = buildCarriers(ctx, H, step);
  if (carriers.length === 0) return [];

  // guard the point count before committing to the dense sampling
  const totalSamples = carriers.reduce((a, c) => a + c.n, 0);
  if (totalSamples > POINT_BUDGET) {
    step *= totalSamples / POINT_BUDGET;
  }
  const cs = step === w / STEP_DIV ? carriers : buildCarriers(ctx, H, step);

  // the tone table, inverted once and shared by every carrier sample
  const band = toneBand(ctx);
  const nTab = 200;
  const tabX = new Float64Array(nTab);   // brightness
  const tabY = new Float64Array(nTab);   // wavelength, or half-amplitude
  for (let i = 0; i < nTab; i++) {
    const t = i / (nTab - 1);
    if (byAmplitude) {
      const ah = t * (Amax / 2);
      tabY[i] = ah;
      tabX[i] = 1 - areaRatio(waveform, w, H, 2 * ah, L0);
    } else {
      const L = L0 + t * (5 * H - L0);
      tabY[i] = L;
      tabX[i] = 1 - areaRatio(waveform, w, H, Amax, L);
    }
  }

  const out = [];
  for (const c of cs) {
    const phi = new Float64Array(c.n);
    const ampHalf = new Float64Array(c.n);

    // sample the image along the carrier, clamped to the frame as the MATLAB
    // does (lines 79-80) so the outer turns read the border rather than NaN
    let prevRate = 0;
    for (let i = 0; i < c.n; i++) {
      const sx = Math.min(ctx.nx, Math.max(1, c.x[i]));
      const sy = Math.min(ctx.ny, Math.max(1, c.y[i]));
      let b = interp2(ctx.im, sx, sy);
      if (!isFinite(b)) b = 1;
      const target = Math.min(1, Math.max(0, b)) * (band.max - band.min) + band.min;

      let rate;
      if (byAmplitude) {
        ampHalf[i] = interpTable(tabX, tabY, target);
        rate = (2 * Math.PI) / L0;
      } else {
        ampHalf[i] = Amax / 2;
        const L = Math.max(L0, interpTable(tabX, tabY, target));
        rate = (2 * Math.PI) / L;
      }
      // cumtrapz(s, dPhi) -- the phase integral, MATLAB line 103/135/169
      phi[i] = i === 0 ? 0 : phi[i - 1] + ((rate + prevRate) / 2) * (c.s[i] - c.s[i - 1]);
      prevRate = rate;
    }

    const pts = modulate(c, phi, ampHalf, waveform);
    for (const runPts of clipPolyline(pts, px, py)) out.push(runPts);
  }
  return out;
}

export default { id, label, params, run, targetImage };
