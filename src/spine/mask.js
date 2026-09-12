// Which pixels are inside the drawing polygon — the one answer, for every method.
//
// "Which pixels count" is a contract between the units layer and every method,
// and the 1-based pixel-centre convention (`inpolygon(ix+1, iy+1)`) is the part
// of it most able to drift: a method half a pixel out still draws a plausible
// picture, and only disagrees with `renderStrokes` about where the page edge is.
//
// Cached, because the scan is nx*ny point-in-polygon tests, each a loop over the
// polygon's edges.

import { inpolygon } from '../shim/image.js';

/**
 * Small LRU. Keyed on the polygon's actual coordinates rather than on object
 * identity, so a fresh `prepare()` with the same geometry still hits.
 *
 * Four entries, not four geometries: masks and index lists share this list under
 * different key prefixes (`m:` / `i:`), and building an index list also inserts
 * the mask it came from, so a method wanting both takes two slots. Effective
 * capacity is therefore two geometries — enough while the worker runs one method
 * at a time, and the number to raise if a method ever alternates between several
 * polygons in one pass.
 */
const CACHE = [];
const CACHE_MAX = 4;

function cached(key, build) {
  for (let i = 0; i < CACHE.length; i++) {
    if (CACHE[i].key !== key) continue;
    const hit = CACHE.splice(i, 1)[0];
    CACHE.unshift(hit);
    return hit.value;
  }
  const value = build();
  CACHE.unshift({ key, value });
  if (CACHE.length > CACHE_MAX) CACHE.length = CACHE_MAX;
  return value;
}

/**
 * 1 inside the polygon, 0 outside, one entry per pixel in row-major order.
 *
 * Treat the result as read-only: it is the cached array itself, not a copy, so a
 * caller that writes into it corrupts every later call with the same geometry.
 * `whitenOutside` mutates the image instead, which is the only mutation the call
 * sites want.
 *
 * Pixel centres are 1-based, matching the units contract -- pixel (0,0) of the
 * data array is the point (1,1) in method coordinates.
 */
export function polygonMask(nx, ny, px, py) {
  const key = `${nx}|${ny}|${px.join(',')}|${py.join(',')}`;
  return cached(`m:${key}`, () => {
    const mask = new Uint8Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (inpolygon(ix + 1, iy + 1, px, py)) mask[iy * nx + ix] = 1;
      }
    }
    return mask;
  });
}

/** The mask for a prepared context's own drawing polygon: the common case. */
export function regionMask(ctx) {
  return polygonMask(ctx.nx, ctx.ny, ctx.polygon.px, ctx.polygon.py);
}

/**
 * Flat indices of the pixels inside, ascending.
 *
 * Also read-only, and also cached: three methods want the list rather than the
 * mask, and one wants both.
 */
export function insideIndices(nx, ny, px, py) {
  const key = `${nx}|${ny}|${px.join(',')}|${py.join(',')}`;
  return cached(`i:${key}`, () => {
    const mask = polygonMask(nx, ny, px, py);
    let count = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
    const out = new Int32Array(count);
    let k = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) out[k++] = i;
    return out;
  });
}

/** Indices inside a prepared context's drawing polygon. */
export function regionIndices(ctx) {
  return insideIndices(ctx.nx, ctx.ny, ctx.polygon.px, ctx.polygon.py);
}

/**
 * Set every pixel outside the polygon to `value`, in place.
 *
 * White by default, which is what the callers want: an outside pixel that reads
 * as dark would ask the method for ink it must not lay down, and several methods
 * (polygonSubdivision, quadHalftone, sfcCollapse) depend on the outside being
 * literally 1 rather than merely skipped, because their subdivision and
 * collapse criteria integrate over it.
 *
 * @param {{data:ArrayLike<number>}} im  mutated
 */
export function whitenOutside(im, mask, value = 1) {
  const d = im.data;
  for (let i = 0; i < d.length; i++) if (!mask[i]) d[i] = value;
  return im;
}
