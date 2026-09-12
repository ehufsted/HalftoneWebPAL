// Isotropic Gaussian random fields as sums of plane waves, and the closed form
// for the length of their zero contour.
//
// Sums of sinusoids rather than an inverse FFT, which removes two dependencies.
// There is no FFT to shim, because a plane wave is separable:
//
//     cos(k(x cos t + y sin t) + p) = cosA[x] cosB[y] - sinA[x] sinB[y]
//
// so each wave costs nx+ny trig calls and two multiplies per pixel, with no trig
// in the inner loop. And the sum of many waves is Gaussian by the central limit
// theorem, so its median is exactly 0 -- the uniform-CDF transform the FFT
// version needs in order to have a meaningful 0.5 level goes away with it.
//
// The contour length is derived, not measured. By the Kac-Rice formula, the
// expected length of the zero level set of a stationary Gaussian field, per unit
// area, is
//
//     E[L]/A = (1/2) sqrt(lambda2 / lambda0)
//
// where lambda0 is the variance of the field and lambda2 the variance of one
// partial derivative. For a unit-variance random-wave field at wavenumber k with
// isotropic directions, lambda0 = 1 and lambda2 = k^2 <cos^2 t> = k^2/2, so
//
//     E[L]/A = k/(2 sqrt2) = pi/(sqrt2 * wavelength) = 2.2214 / wavelength
//
// Drawing that contour with a pen of width w therefore covers 2.2214 w/lambda of
// the page. Note ISOTROPY IS AN ASSUMPTION of that derivation, not a detail:
// lambda2 = k^2/2 only holds when the directions average <cos^2 t> = 1/2, which
// is why the directions below are stratified rather than merely random.

/** pi/sqrt(2): zero-contour length per unit area, times wavelength. */
export const ZERO_CONTOUR_CONST = Math.PI / Math.SQRT2;

/**
 * Add nWaves plane waves at wavenumber k into `out`, optionally only at the
 * pixels listed in idx[from..to) and scaled by the matching entry of wts.
 *
 * Directions are STRATIFIED over [0, pi) -- one per equal slice, jittered within
 * it -- so <cos^2 t> = 1/2 holds at finite N instead of only in expectation.
 * With purely random directions the second spectral moment fluctuates by
 * O(1/sqrt N) and the contour length drifts with it. Half a turn is the whole
 * range: a plane wave in direction -u is the same wave as in +u, phase-shifted.
 */
function addWaves(out, nx, ny, k, nWaves, rand, idx, wts, from, to) {
  const cosA = new Float64Array(nx), sinA = new Float64Array(nx);
  const cosB = new Float64Array(ny), sinB = new Float64Array(ny);
  const amp = Math.sqrt(2 / nWaves);

  for (let n = 0; n < nWaves; n++) {
    const th = (Math.PI * (n + rand())) / nWaves;
    const ph = rand() * 2 * Math.PI;
    const kx = k * Math.cos(th), ky = k * Math.sin(th);
    for (let x = 0; x < nx; x++) {
      const a = kx * (x + 1);
      cosA[x] = Math.cos(a); sinA[x] = Math.sin(a);
    }
    for (let y = 0; y < ny; y++) {
      const b = ky * (y + 1) + ph;
      cosB[y] = Math.cos(b); sinB[y] = Math.sin(b);
    }

    if (idx) {
      for (let t = from; t < to; t++) {
        const c = idx[t];
        const y = (c / nx) | 0, x = c - y * nx;
        out[c] += amp * wts[t] * (cosA[x] * cosB[y] - sinA[x] * sinB[y]);
      }
    } else {
      for (let y = 0; y < ny; y++) {
        const cb = cosB[y], sb = sinB[y], row = y * nx;
        for (let x = 0; x < nx; x++) {
          out[row + x] += amp * (cosA[x] * cb - sinA[x] * sb);
        }
      }
    }
  }
}

/**
 * Unit-variance isotropic Gaussian field at a single wavenumber.
 * Its zero contour should measure ZERO_CONTOUR_CONST/wavelength per unit area.
 */
export function waveField(nx, ny, k, nWaves, rand) {
  const out = new Float64Array(nx * ny);
  addWaves(out, nx, ny, k, nWaves, rand, null, null, 0, 0);
  return out;
}

/**
 * Default number of scales in the stack.
 *
 * Arbitrary, and nothing has been measured against it. Tone does not depend on it
 * at all — the blend below is exact at any count — so this is purely about
 * appearance, and could probably come down a long way before the two-scale look
 * becomes visible.
 */
export const DEFAULT_LEVELS = 19;

/**
 * Field whose local wavenumber follows kMap, built by blending a geometric
 * stack of independent single-scale fields.
 *
 * The blend is in RMS, not linear, which is what keeps the tone exact.
 * Independent unit-variance fields combine as
 *
 *     k_eff^2 = a^2 k1^2 + b^2 k2^2,   a^2 + b^2 = 1
 *
 * because variances add: lambda0 stays 1 and lambda2 becomes the weighted mean
 * of k1^2/2 and k2^2/2. So to hit a target kt between two levels,
 * a^2 = (k2^2 - kt^2)/(k2^2 - k1^2). Substituting back into the Kac-Rice formula
 * returns exactly k_t/(2 sqrt2) -- the single-scale answer -- so the contour
 * length is right at every blend point, for any number of levels. A linear
 * blend would NOT have that property.
 *
 * The spectrum at a blend point is bimodal even though its second moment is
 * correct, so what the level count buys is appearance rather than tone.
 *
 * Only the two bracketing levels are non-zero at any pixel, so each level is
 * evaluated on a scattered index list and the total work is 2*nx*ny*nWaves
 * regardless of the stack depth. Memory is one output buffer, not a stack.
 *
 * @param {Float64Array} kMap    target wavenumber per pixel
 * @param {Uint8Array} active    pixels that matter (others still get a value)
 */
export function variableWaveField(nx, ny, kMap, active, opts = {}) {
  const nWaves = Math.max(2, Math.round(opts.nWaves ?? 4));
  // REQUIRED, like waveField's. It defaulted to Math.random, which would have
  // made output irreproducible the moment a caller forgot the seed -- and the
  // harness's whole regression check rests on this app being deterministic.
  // Failing loudly is better than silently losing that.
  if (typeof opts.rand !== 'function') {
    throw new TypeError('variableWaveField: opts.rand is required (seeded PRNG)');
  }
  const rand = opts.rand;
  const n = nx * ny;
  const out = new Float64Array(n);

  let kLo = Infinity, kHi = -Infinity;
  for (let c = 0; c < n; c++) {
    if (active && !active[c]) continue;
    const v = kMap[c];
    if (!(v > 0)) continue;
    if (v < kLo) kLo = v;
    if (v > kHi) kHi = v;
  }
  if (!(kHi > 0)) return out;

  let nLevels = Math.max(1, Math.round(opts.nLevels ?? DEFAULT_LEVELS));
  if (kHi / kLo < 1.001) nLevels = 1;

  const ks = new Float64Array(nLevels);
  if (nLevels === 1) {
    ks[0] = kHi;
  } else {
    const r = Math.pow(kHi / kLo, 1 / (nLevels - 1));
    for (let l = 0; l < nLevels; l++) ks[l] = kLo * Math.pow(r, l);
    ks[nLevels - 1] = kHi;
  }

  // per-pixel bracketing level and RMS weights, bucketed by level
  const counts = new Int32Array(nLevels + 1);
  const lvl = new Int32Array(n);
  const wa = new Float64Array(n), wb = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const kt = Math.min(kHi, Math.max(kLo, kMap[c] > 0 ? kMap[c] : kLo));
    let l = 0;
    if (nLevels > 1) {
      // ks is ascending; find l with ks[l] <= kt <= ks[l+1]
      let lo = 0, hi = nLevels - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ks[mid] <= kt) lo = mid; else hi = mid;
      }
      l = lo;
      const k1 = ks[l], k2 = ks[l + 1];
      const den = k2 * k2 - k1 * k1;
      let a2 = den > 0 ? (k2 * k2 - kt * kt) / den : 1;
      a2 = Math.min(1, Math.max(0, a2));
      wa[c] = Math.sqrt(a2);
      wb[c] = Math.sqrt(1 - a2);
      counts[l]++;
      counts[l + 1]++;
    } else {
      wa[c] = 1; wb[c] = 0;
      counts[0]++;
    }
    lvl[c] = l;
  }

  const start = new Int32Array(nLevels + 1);
  for (let l = 0, acc = 0; l <= nLevels; l++) { start[l] = acc; acc += counts[l] || 0; }
  const total = start[nLevels] + (counts[nLevels] || 0);
  const idx = new Int32Array(total);
  const wts = new Float64Array(total);
  const fill = start.slice();
  for (let c = 0; c < n; c++) {
    const l = lvl[c];
    let p = fill[l]++;
    idx[p] = c; wts[p] = wa[c];
    if (nLevels > 1) {
      p = fill[l + 1]++;
      idx[p] = c; wts[p] = wb[c];
    }
  }

  for (let l = 0; l < nLevels; l++) {
    const from = start[l], to = from + (counts[l] || 0);
    if (to <= from) continue;
    addWaves(out, nx, ny, ks[l], nWaves, rand, idx, wts, from, to);
  }
  return out;
}
