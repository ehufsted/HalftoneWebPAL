// The shared half of the targetImage contract.
//
// A method's targetImage() answers "what tone is this method actually aiming
// for, per pixel" — distinct from the source image, which it may be unable to
// express. The worker scores fidelity against it, so getting it right is what
// keeps a band-limited method from being condemned by a stat it cannot satisfy.
//
// Most methods answer it the same way: a reachable brightness band [min, max],
// with the source image squeezed affinely into it. That squeeze lives here,
// along with the one band shared by the stripe-spacing methods. No other band
// belongs here — each method computes its own from its own tone model, and they
// are not interchangeable.
//
// Not every method is affine. circlePacking evaluates its coverage law at each
// pixel's own radius, because the tangency term makes coverage sub-linear in 1/R
// and the achieved ramp bows away from the straight line between the endpoints.
// If a method's tone relation is not linear in the quantity it modulates, this
// helper is the wrong answer for it.

import { makeImage } from '../shim/image.js';

/**
 * The source image remapped affinely into a reachable band.
 *
 * @param {{nx:number, ny:number, im:{data:ArrayLike<number>}}} ctx
 * @param {{min:number, max:number}} band  brightness at black and at white
 */
export function affineTarget(ctx, band) {
  const { min, max } = band;
  const out = makeImage(ctx.nx, ctx.ny);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = ctx.im.data[i] * (max - min) + min;
  }
  return out;
}

/**
 * The spacing limits of a stroke-spacing method, in pixels.
 *
 * Shared by eikonalStripes, planeWaves, triStripes and streamlines under
 * `LminW`/`LmaxW`, and by tspTour under `dMinW`/`dMaxW`. The two floors are the
 * point: the lower one is the merge floor (`w`, where adjacent strokes touch on
 * paper) and the upper one keeps a usable band open (`1.5 x Lmin`) however the
 * user drags the two sliders past each other.
 *
 * This is not the tone model, only its two endpoints. The band they imply is
 * `stripeBand` below, which is right for a method whose coverage is `w/L` and
 * nothing else — meshEdges, treeEdges, refiningNoise and wigglyLines each derive
 * a different floor from their own tone model and keep their own `scalesOf`.
 *
 * @param {{w:number}} ctx
 * @param {{minKey?:string, maxKey?:string, minDef?:number, maxDef?:number}} [opts]
 * @returns {{w:number, Lmin:number, Lmax:number}} in pixels
 */
export function stripeSpacings(ctx, opts = {}) {
  const { minKey = 'LminW', maxKey = 'LmaxW', minDef = 2, maxDef = 40 } = opts;
  const w = ctx.w;
  const Lmin = Math.max(w, (ctx[minKey] ?? minDef) * w);
  const Lmax = Math.max(Lmin * 1.5, (ctx[maxKey] ?? maxDef) * w);
  return { w, Lmin, Lmax };
}

/**
 * The brightness band of a method whose coverage is `w/L`.
 *
 * Darkest is `1 - w/Lmin` (black at Lmin = w, the merge floor), brightest
 * `1 - w/Lmax`. White is unreachable by construction, since a stroke is always
 * somewhere. Because `1/L` is linear in brightness the achieved ramp *is* the
 * affine remap, so these methods pass this straight to `affineTarget`.
 *
 * A method that lays more than one layer must combine bands itself rather than
 * widen this one -- triStripes squares it, because two independent stripe sets
 * multiply the light that survives both.
 */
export function stripeBand(w, Lmin, Lmax) {
  return { min: Math.max(0, 1 - w / Lmin), max: Math.max(0, 1 - w / Lmax) };
}

/**
 * The harmonic ladder: `1/L` linear in the value, between two chosen endpoints.
 *
 * This is the recurring tone-model shape of the app — coverage is inversely
 * proportional to a spacing, so a ladder linear in `1/L` gives a coverage linear
 * in the value. When reading a drawing, that means darker is tighter.
 *
 * The argument is the raw [0,1] value, never an already-remapped brightness. The
 * ladder's own affine map *is* the remap into [Lmin, Lmax], so a value already
 * squeezed into the band gets the squeeze twice: correct at the white end, out
 * by the full band width at the black end. A method that needs the remapped
 * target for another reason must undo the band before calling here.
 *
 * Clamping to [Lmin, Lmax] is the caller's choice: `eikonalStripes` clamps
 * because its solver integrates the field outside the region too, `streamlines`
 * does not.
 *
 * The two forms are algebraically the same ladder but not bit-identical, since a
 * reciprocal rounds differently. Each caller keeps the form it was measured in:
 * a phase field accumulating `2*pi/L` wants the inverse form, a spacing map
 * wants the spacing.
 *
 * Not every 1/x tone model is this ladder. `refiningNoise`'s passes through the
 * origin (`1/lambda = K/(C*w)`) with its maximum applied afterwards as a cutoff
 * rather than as an endpoint, which is what lets it reach true white; do not
 * route it through here.
 *
 * @param {number} v     the raw value, 0 = black, 1 = white
 * @param {number} Lmin  spacing at v = 0
 * @param {number} Lmax  spacing at v = 1
 */
export function harmonicSpacing(v, Lmin, Lmax) {
  return Lmin / (1 - v * (1 - Lmin / Lmax));
}

/** The same ladder as `harmonicSpacing`, evaluated as 1/L. Read its notes. */
export function harmonicInvSpacing(v, Lmin, Lmax) {
  const invMin = 1 / Lmin, invMax = 1 / Lmax;
  return invMin + v * (invMax - invMin);
}
