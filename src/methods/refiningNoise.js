// A reworking of singleWidthLines/code/regionsRefiningNoise.m.
// Header: "scalings work pretty well."
//
// Same drawing -- the zero contour of a noise field whose wavelength shortens
// where the image darkens -- but built on sums of sinusoids rather than inverse
// FFTs, which makes the calibration a closed form instead of a fit.
//
// The tone relation is derived. By Kac-Rice, the zero contour of an isotropic
// Gaussian field has expected length pi/(sqrt2 * lambda) per unit area, so a pen
// of width w covers
//
//     K = 2.2214 w / lambda        =>        lambda = 2.2214 w / K
//
// which is 1/lambda linear in darkness -- the harmonic ladder circlePacking and
// eikonalStripes also use, and the third time that form has turned up.
//
// It is not the same ladder, though, and the three must not be factored together.
// Those two interpolate between two chosen endpoints:
//
//     1/L = 1/Lmin + im*(1/Lmax - 1/Lmin)
//
// so the reachable band is [1-w/Lmin, 1-w/Lmax] and white is unreachable by
// construction. This one passes through the ORIGIN:
//
//     1/lambda = K/(C*w)
//
// with no interpolation and no bright endpoint -- lambdaMax is a CUTOFF applied
// afterwards, not a ladder end. That is precisely what lets this method reach
// true white, and why its targetImage is not spine/tone.js affineTarget. Anyone
// unifying the three would silently move this method's bright end.
//
// Two limits fall out of it rather than being chosen. Black is reached exactly
// at lambda = 2.2214 w, and that is exactly the merge floor: the contour density
// pi/(sqrt2 lambda) is the same as parallel lines at spacing lambda/2.2214,
// which equals w there. So lambdaMin is not a taste parameter. And lambdaMax is
// the white cutoff -- past it no contour is drawn at all, which is what lets
// this method reach true white.
//
// The source's tone ladder is not ported: it remaps the image through
// `sqrt(1-(2*wLine)/Lmin)` and inverts with `(2*wLine)./(1-sqrt(im))`, a square
// root applied twice where inverting that remap wants `(1-2w/Lmin)^2`, so
// `Lmax = 40*wLine` produces about 157 w. Its constant is also 2 rather than
// 2.2214, a further 10%.

import { regionMask } from '../spine/mask.js';
import { blurGaussian, makeImage } from '../shim/image.js';
import { mulberry32 } from '../spine/random.js';
import { createContourWorkspace, contourLevel } from '../spine/contour.js';
import { clipPolyline } from '../spine/geometry.js';
import { variableWaveField, ZERO_CONTOUR_CONST, DEFAULT_LEVELS } from '../spine/waveNoise.js';

export const id = 'refiningNoise';
export const label = 'Refining noise contours';

export const params = [
  // Floor is the derived black point, 2.2214 w. Raising it only makes the
  // darkest tone lighter; there is nothing useful below it.
  { key: 'lambdaMinW', label: 'Min wavelength', type: 'range', min: 2.25, max: 20, step: 0.25, def: 2.25, unit: '×pen' },
  // The white cutoff: past this wavelength no contour is drawn at all.
  { key: 'lambdaMaxW', label: 'Max wavelength', type: 'range', min: 10, max: 40, step: 2, def: 40, unit: '×pen' },
  // 2 to 8. Above ~8 the look stops changing, because the field is already
  // Gaussian and further waves only reduce its variance; the interesting range
  // is the small one, where 2 waves give a plaid and 3 a triangular weave.
  //
  // That is also where the constant stops being exact. pi/sqrt2 is the large-N
  // limit, and the far end is known in closed form: a single plane wave has a
  // zero set of parallel lines lambda/2 apart, i.e. 2/lambda, exactly 10% below.
  // (Its distribution is arcsine, not Gaussian, so the density at zero is
  // 1/(pi sqrt2) rather than 1/sqrt(2 pi); times E|f'| = sqrt2 k that gives
  // k/pi = 2/lambda.) So the whole usable range is bracketed between 2.0 and
  // 2.2214 -- at most a 10% tone error, and less than that above N = 2.
  // verify.html reports the effective constant per N so the correction, if it
  // is worth making, can be read straight off.
  { key: 'nWaves', label: 'Waves', type: 'range', min: 2, max: 8, step: 1, def: 4 },
  // In PEN WIDTHS, absolute. See wavelengthMap: the criterion this exists to
  // satisfy is |grad lambda| <~ 1, which does not scale with lambda, so a fixed
  // pixel radius is the right form.
  { key: 'smoothW', label: 'Wavelength smoothing', type: 'range', min: 0, max: 20, step: 0.5, def: 2, unit: '×pen' },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1 },
];


function scalesOf(ctx) {
  const w = ctx.w;
  const lambdaMin = Math.max(ZERO_CONTOUR_CONST * w, (ctx.lambdaMinW ?? 2.25) * w);
  const lambdaMax = Math.max(lambdaMin * 2, (ctx.lambdaMaxW ?? 60) * w);
  return { w, lambdaMin, lambdaMax };
}

/**
 * Wavelength per pixel, plus the mask of pixels that get a contour at all.
 *
 * Shared by run() and targetImage() so the two cannot drift. The wavelength map
 * is smoothed before use because the blend weights vary with it, and a varying
 * weight adds f1*grad(a) + f2*grad(b) to grad(f) -- inflating lambda2 and
 * darkening wherever the image changes quickly. The condition for that to be
 * negligible is roughly |grad lambda| << 1, which smooth images satisfy easily
 * and hard edges do not.
 *
 * Sigma is an absolute pixel radius, not a fraction of the wavelength, and the
 * derivation says it must be. The blend weight a changes over roughly one level
 * spacing, d(lambda)/lambda ~ 0.2, so grad(a) ~ grad(lambda)/(0.2 lambda);
 * against the wave's own k = 2 pi/lambda that ratio is grad(lambda)/1.26. The
 * lambda cancels: the condition is |grad lambda| <~ 1 in pixels per pixel,
 * independent of scale.
 *
 * A fraction of the MEAN wavelength would be wrong: lambda = 2.2214 w/K blows up
 * as K → 0, so on any image with highlights the mean sits near the lambdaMax cap,
 * sigma reaches ~45 px — a 135-tap kernel — and the map is smeared toward that
 * capped value across the whole picture, visibly lengthening the wavelength near
 * the right and bottom edges where replicate padding pulls hardest.
 */
export function wavelengthMap(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { w, lambdaMin, lambdaMax } = scalesOf(ctx);
  const n = nx * ny;

  // The shared mask, used directly rather than copied: nothing below writes to
  // it, and spine/mask.js documents the array as read-only.
  const region = regionMask(ctx);
  const lam = new Float64Array(n);
  let cnt = 0;
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const c = i * nx + j;
      const inside = region[c] === 1;
      const v = inside ? Math.min(1, Math.max(0, ctx.im.data[c])) : 1;
      const K = 1 - v;
      // lambda = 2.2214 w / K, capped both ways
      const raw = K > 1e-6 ? (ZERO_CONTOUR_CONST * w) / K : Infinity;
      lam[c] = Math.min(lambdaMax, Math.max(lambdaMin, raw));
      if (inside) cnt++;
    }
  }
  if (cnt === 0) return null;

  const sigma = (ctx.smoothW ?? 2) * w;
  let lamS = lam;
  if (sigma > 0.01) {
    const img = makeImage(nx, ny);
    img.data.set(lam);
    const b = blurGaussian(img, Math.max(3, Math.ceil(sigma * 3)), sigma);
    lamS = Float64Array.from(b.data);
    for (let c = 0; c < n; c++) {
      lamS[c] = Math.min(lambdaMax, Math.max(lambdaMin, lamS[c]));
    }
  }

  // The white cutoff, tied to lambdaMax: where the UNSMOOTHED requirement was
  // already past lambdaMax the region is too bright to carry a contour, and
  // drawing one there would only add ink the image did not ask for.
  const Kcut = (ZERO_CONTOUR_CONST * w) / lambdaMax;
  const keep = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    const K = 1 - Math.min(1, Math.max(0, ctx.im.data[c]));
    keep[c] = region[c] && K >= Kcut ? 1 : 0;
  }

  return { lam: lamS, keep, region, w, lambdaMin, lambdaMax, Kcut };
}

/**
 * Achieved brightness, per pixel: 1 - 2.2214 w / lambda where a contour is
 * drawn, and 1 where the cutoff blanked it. Below the cutoff the ladder is
 * exact by construction, so this equals the source image except where either
 * limit binds -- which is the honest thing to score against.
 */
export function targetImage(ctx) {
  const built = wavelengthMap(ctx);
  const out = makeImage(ctx.nx, ctx.ny);
  if (!built) { out.data.fill(1); return out; }
  const { lam, keep, w } = built;
  for (let c = 0; c < out.data.length; c++) {
    out.data[c] = keep[c] ? 1 - Math.min(1, (ZERO_CONTOUR_CONST * w) / lam[c]) : 1;
  }
  return out;
}

/** Split a polyline wherever it leaves the keep mask. */
function splitByMask(pts, keep, nx, ny) {
  const runs = [];
  let cur = [];
  const at = (p) => {
    const j = Math.round(p[0]) - 1, i = Math.round(p[1]) - 1;
    if (i < 0 || j < 0 || i >= ny || j >= nx) return 0;
    return keep[i * nx + j];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const ok = at(pts[i]) && at(pts[i + 1]);
    if (ok) {
      if (cur.length === 0) cur.push(pts[i]);
      cur.push(pts[i + 1]);
    } else if (cur.length > 1) {
      runs.push(cur); cur = [];
    } else {
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const built = wavelengthMap(ctx);
  if (!built) return [];
  const { lam, keep } = built;

  const kMap = new Float64Array(nx * ny);
  for (let c = 0; c < kMap.length; c++) kMap[c] = (2 * Math.PI) / lam[c];

  const field = variableWaveField(nx, ny, kMap, built.region, {
    // Fallback matches the declared default. It read 48 -- six times the
    // declared maximum, and a different tone constant from the one targetImage
    // scores against -- left over from when the slider ran 8..128.
    nWaves: Math.round(ctx.nWaves ?? 4),
    nLevels: DEFAULT_LEVELS,
    rand: mulberry32(Math.round(ctx.seed ?? 1)),
  });

  // Contour the WHOLE field, then discard what falls outside the keep mask.
  // Forcing the field high in blanked areas -- as the source does, `im2(im>...)
  // = 1` -- would put a spurious contour right around every highlight, because
  // marching squares finds the crossing at that artificial cliff.
  const ws = createContourWorkspace(nx, ny);
  const raw = contourLevel(field, 0, ws);

  const out = [];
  for (const line of raw) {
    for (const seg of splitByMask(line, keep, nx, ny)) {
      for (const run2 of clipPolyline(seg, px, py)) {
        if (run2.length >= 2) out.push(run2);
      }
    }
  }
  return out;
}

// No in-method simplify: the contour comes out at grid resolution and the
// worker already runs simplifyAll at penWidth/2. Adding a second, coarser pass
// is what collapsed eikonalStripes.
export default { id, label, params, run, targetImage };
