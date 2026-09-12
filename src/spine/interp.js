// Monotone table lookup -- MATLAB's interp1 for the one case the methods need.
//
// Several methods build a table mapping a control parameter to the tone it
// produces (wavelength to coverage, radius to coverage, amplitude to area
// ratio), then invert it by looking up the tone they want. That is always a
// lookup into a monotone table with linear interpolation and clamping at both
// ends, and this is the one implementation of it. A zero-width span returns
// `ys[lo]` rather than dividing by zero.

/**
 * Interpolate ys at v, where xs is monotone in EITHER direction.
 *
 * Descending tables matter because an inverted tone relation is common here:
 * coverage falls as spacing grows, so the table that maps brightness back to a
 * parameter naturally runs downhill.
 *
 * @param {ArrayLike<number>} xs  monotone, ascending or descending
 * @param {ArrayLike<number>} ys  same length
 * @param {number} v              clamped to the table's range
 */
export function interpTable(xs, ys, v) {
  const n = xs.length;
  const asc = xs[n - 1] >= xs[0];
  const get = (i) => (asc ? xs[i] : xs[n - 1 - i]);
  const val = (i) => (asc ? ys[i] : ys[n - 1 - i]);
  if (v <= get(0)) return val(0);
  if (v >= get(n - 1)) return val(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (get(mid) <= v) lo = mid; else hi = mid;
  }
  const span = get(hi) - get(lo);
  const t = span === 0 ? 0 : (v - get(lo)) / span;
  return val(lo) + t * (val(hi) - val(lo));
}
