// Local orientation field.
//
// Six of the remaining methods need a direction field. This is the cheap one:
// the structure tensor from Gaussian derivatives. `edgeTangentFlow.m` (with
// `sg2dRadial.m` behind it) is the collection's own, better answer and is
// listed in the README as an elaboration -- it should slot in behind this same
// interface without touching any caller.
//
// The tensor components are smoothed AFTER the outer product, not before. That
// is what separates a working implementation from a broken one: it lets the
// tensor represent crossing edges instead of cancelling them.
//
// theta is an ORIENTATION, valid mod pi, not a vector direction. Averaging a
// set of these with a plain circular mean is wrong -- antiparallel entries
// cancel. Use meanOrientation below.
//
// The smoothed components are returned too, and a caller that needs a metric
// rather than an angle should use them: `(t11 - t22, 2*t12)` is the doubled-angle
// vector, the same quantity `theta` is recovered from with an atan2. Working with
// it directly never forms an angle, so the mod-pi hazard does not arise, and it
// interpolates linearly where an angle does not. `spine/relax.js` builds its
// anisotropic metric this way.

import { blurGaussian, makeImage } from '../shim/image.js';

/**
 * @param {{w:number,h:number,data:Float32Array}} im
 * @param {number} rGradient  differentiation scale, pixels
 * @param {number} rTensor    integration scale, pixels
 * @returns {{w,h,theta,coherence,t11,t12,t22}} theta = edge tangent
 *          (perpendicular to the gradient), mod pi; coherence in [0,1]; t11/t12/t22
 *          the smoothed tensor components, whose trace `t11 + t22` is the local
 *          gradient ENERGY -- the quantity coherence divides out and therefore
 *          cannot tell you (see the note on coherence below).
 */
export function structureTensorField(im, rGradient = 2, rTensor = 3) {
  const { w, h } = im;
  const sm = blurGaussian(im, Math.max(3, Math.round(rGradient * 3)), Math.max(0.5, rGradient));

  const s11 = makeImage(w, h), s12 = makeImage(w, h), s22 = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : 0;
    const yDn = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xL = x > 0 ? x - 1 : 0;
      const xR = x < w - 1 ? x + 1 : w - 1;
      const gx = (sm.data[y * w + xR] - sm.data[y * w + xL]) / 2;
      const gy = (sm.data[yDn * w + x] - sm.data[yUp * w + x]) / 2;
      const i = y * w + x;
      s11.data[i] = gx * gx;
      s12.data[i] = gx * gy;
      s22.data[i] = gy * gy;
    }
  }

  const k = Math.max(3, Math.round(rTensor * 3));
  const b11 = blurGaussian(s11, k, Math.max(0.5, rTensor));
  const b12 = blurGaussian(s12, k, Math.max(0.5, rTensor));
  const b22 = blurGaussian(s22, k, Math.max(0.5, rTensor));

  const theta = new Float32Array(w * h);
  const coherence = new Float32Array(w * h);
  for (let i = 0; i < theta.length; i++) {
    const a = b11.data[i], b = b12.data[i], c = b22.data[i];
    // eigenvector of the larger eigenvalue = dominant gradient direction
    const grad = 0.5 * Math.atan2(2 * b, a - c);
    theta[i] = grad + Math.PI / 2;            // tangent: along the edge
    // spread is lambda1 - lambda2 and (a + c) the trace, so this is the standard
    // normalised anisotropy. It is scale-free: dividing by the trace makes a
    // nearly flat patch with a slight directional bias read as fully coherent, so
    // a caller that must not turn noise into pattern has to gate on the energy
    // `t11 + t22` as well.
    const spread = Math.hypot(a - c, 2 * b);
    coherence[i] = spread / (a + c + 1e-12);
  }
  return { w, h, theta, coherence, t11: b11.data, t12: b12.data, t22: b22.data };
}

/**
 * Mean of a set of orientations, via the doubled angle -- the standard fix for
 * the mod-pi problem that recurs throughout the MATLAB. A plain circular mean
 * of orientations near 0 and near pi cancels to nothing.
 * @returns {number} orientation in [0, pi)
 */
export function meanOrientation(angles) {
  let sx = 0, sy = 0;
  for (let i = 0; i < angles.length; i++) {
    sx += Math.cos(2 * angles[i]);
    sy += Math.sin(2 * angles[i]);
  }
  if (sx === 0 && sy === 0) return 0;
  const t = 0.5 * Math.atan2(sy, sx);
  return t < 0 ? t + Math.PI : t;
}

/**
 * Edge strength, for placing tessellation seeds ON the image's edges.
 *
 * A Laplacian of Gaussian: blur, then the 3x3 discrete Laplacian, then take the
 * magnitude. The blur is what makes it usable -- a bare Laplacian is a
 * second-difference operator and amplifies pixel noise far more than it
 * amplifies real structure, so at this app's resolutions an unblurred version
 * seeds the tessellation on sensor grain.
 *
 * Laplacian rather than gradient magnitude: |grad| peaks on the edge, while |LoG|
 * peaks on both sides of it with a zero crossing at the edge itself. That puts
 * seeds in two rows flanking the edge, so the Delaunay triangulation lays a mesh
 * edge along the image edge rather than a row of vertices on top of it — which is
 * the whole point of relaxing against this field.
 *
 * Returned normalised to a maximum of 1, because callers blend it against a
 * uniform floor and the mixing weight has to mean the same thing whatever the
 * image's contrast.
 *
 * @param {{w:number,h:number,data:Float32Array}} im
 * @param {number} sigma  blur radius in pixels
 * @returns {Float64Array} |LoG|, normalised to [0,1]
 */
export function edgeStrength(im, sigma = 2) {
  const { w, h } = im;
  const sm = blurGaussian(im, Math.max(3, Math.round(sigma * 3)), Math.max(0.5, sigma));
  const out = new Float64Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : 0;
    const yDn = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xL = x > 0 ? x - 1 : 0;
      const xR = x < w - 1 ? x + 1 : w - 1;
      const i = y * w + x;
      const lap = sm.data[y * w + xL] + sm.data[y * w + xR]
                + sm.data[yUp * w + x] + sm.data[yDn * w + x]
                - 4 * sm.data[i];
      const v = Math.abs(lap);
      out[i] = v;
      if (v > max) max = v;
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}
