// The units contract, lifted from superRegions.m (lines 13-68 and 254-258).
//
// Everything the user sets is physical (centimetres). Everything a method sees
// is pixels. This module is the only place that converts, and the conversion
// must stay exactly as the MATLAB does it or the calibration claims in the
// method headers stop being true.
//
//   1. greyscale, [0,1]
//   2. nxEst = round(pxPerCm * drawingWidth); resize to that width
//   3. recompute pxPerCm = nx / drawingWidth from the ACTUAL resized width
//   4. gaussian pre-smooth at rSmooth
//   5. darkness gamma: im = 1 - (1-im)^gamma
//   6. cm -> px: w = penWidth * pxPerCm, Lmin *= pxPerCm, Lmax *= pxPerCm
//   7. run the method in pixel space
//   8. px -> cm: line = (line - 1) / pxPerCm
//   9. verification render at renderScale, w2 = penWidth * pxPerCm * renderScale

import { resize, blurGaussian, cloneImage } from '../shim/image.js';

/**
 * MATLAB defaults from superRegions.m, in centimetres unless noted.
 *
 * Plain values only. A getter here would be evaluated at spread time against
 * this object rather than against the caller's settings, freezing anything
 * derived from `penWidth` at the default pen. Derived quantities are the
 * functions below instead.
 */
export const DEFAULTS = {
  drawingWidth: 5,
  penWidth: 0.05,
  pxPerCm: 30,
  gamma: 1.4,
  rSmooth: 1.5,          // pixels
  renderScale: 2,
  Lmax: 10,
};

/** The merge-prevention floor: below this, adjacent strokes touch on paper. */
export const lminFor = (penWidth) => penWidth * 1.1;

/** Visvalingam scale for simplifyAll, in the same units as the pen. */
export const simplifyLengthFor = (penWidth) => penWidth / 2;

/**
 * The largest compute raster prepare() will build, in pixels.
 *
 * `nx` follows from the paper width and the detail slider, so it is bounded by
 * the controls; `ny` follows from the source image's aspect ratio, which is not
 * bounded by anything. A tall crop at A3 and 80 px/cm asks for tens of millions
 * of pixels per buffer and several buffers per run — 200x1400 gives ny = 23520.
 *
 * Set above every raster the sliders can reach at an ordinary aspect ratio
 * (3360 px wide and square is 11.3M), so it bites only on an extreme crop, where
 * scaling the whole raster down costs detail and keeps the tab alive. Step 3
 * recomputes pxPerCm from the actual width, so the physical scale still holds.
 */
const MAX_COMPUTE_PIXELS = 16e6;

/**
 * Steps 1-6. Returns everything a method needs, in pixel space.
 * @param {{w:number,h:number,data:Float32Array}} image greyscale [0,1]
 */
export function prepare(image, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const drawingWidth = s.drawingWidth;
  const penWidth = s.penWidth;

  // 2: resize to the requested physical resolution
  let nxEst = Math.max(2, Math.round(s.pxPerCm * drawingWidth));
  let nyEst = Math.max(2, Math.round((image.h * nxEst) / image.w));
  if (nxEst * nyEst > MAX_COMPUTE_PIXELS) {
    const k = Math.sqrt(MAX_COMPUTE_PIXELS / (nxEst * nyEst));
    nxEst = Math.max(2, Math.round(nxEst * k));
    nyEst = Math.max(2, Math.round(nyEst * k));
  }
  let im = resize(image, nxEst, nyEst);

  // 3: the true pixels-per-cm, after rounding
  const pxPerCm = im.w / drawingWidth;
  const nx = im.w, ny = im.h;

  // 4: pre-smooth
  if (s.rSmooth > 0) {
    im = blurGaussian(im, Math.max(3, Math.round(s.rSmooth * 2)), s.rSmooth / 3);
  }

  // clamp then 5: darkness gamma
  const out = cloneImage(im);
  for (let i = 0; i < out.data.length; i++) {
    const v = Math.max(0, Math.min(1, out.data[i]));
    out.data[i] = 1 - Math.pow(1 - v, s.gamma);
  }

  // 6: physical params into pixels. The floor tracks the pen width actually in
  // use, unless the caller overrode it.
  const LminCm = settings.Lmin !== undefined ? settings.Lmin : lminFor(penWidth);
  const Lmin = LminCm * pxPerCm;
  const Lmax = s.Lmax * pxPerCm;
  const w = penWidth * pxPerCm;

  return {
    im: out,
    nx, ny, pxPerCm,
    // The max() enforces the merge floor rather than applying it twice: on the
    // default path both terms are penWidth * 1.1 * pxPerCm, and it only bites
    // when a caller passes an Lmin below the floor.
    w, Lmin: Math.max(w * 1.1, Lmin), Lmax,
    drawingWidth,
    drawingHeight: ny / pxPerCm,
    penWidth,
    settings: s,
    polygon: fullPolygon(nx, ny),
  };
}

/** The whole-image polygon superRegions uses when npts === 1. */
export function fullPolygon(nx, ny) {
  return { px: [1, nx, nx, 1], py: [1, 1, ny, ny] };
}

/** Step 8: pixel space back to centimetres. */
export function toPhysical(lines, pxPerCm) {
  return lines.map((line) => line.map(([x, y]) => [(x - 1) / pxPerCm, (y - 1) / pxPerCm]));
}

/**
 * The inverse, for rendering. Path work (ordering, joining, simplifying) happens
 * in centimetres and the renderer works in pixels, so previewing what will
 * actually be plotted means converting back.
 */
export function toPixels(lines, pxPerCm) {
  return lines.map((line) => line.map(([x, y]) => [x * pxPerCm + 1, y * pxPerCm + 1]));
}
