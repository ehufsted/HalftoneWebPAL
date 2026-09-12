// One-dimensional optimal transport along rays from a centre.
//
// Port of the core of singleWidthLines/code/testRadialRemappingPoints.m, which
// squeezes a uniform point set radially until its density matches an image.
//
// The idea. Along a fixed ray, "how many points
// should lie inside radius r" is a single increasing function
//
//     M(r, theta) = integral_0^r rho(r', theta) r' dr'
//
// and sending each point to the radius where M reaches the mass it already
// carried makes its density exactly rho. That is 1-D optimal transport, done
// independently on every ray. It costs one integral and one inversion, and there
// is nothing to converge.
//
// What it cannot do is move mass sideways: a ray keeps its own points. The
// angular distribution is still handled, but indirectly -- a ray needing more
// ink simply recruits more of the points available along it, and the ones it
// cannot use are discarded. So the source set must be generously larger than the
// output, which is why `sourceRadiusFor` exists.
//
// The map is RADIUS to radius, not RANK to radius, and the difference is the
// whole method. Given a source whose cumulative mass along the ray is S(s), the
// point at radius s goes to the r where M(r) = S(s). Because S is a continuous
// increasing function of s, the deformation is smooth and a lattice stays a
// lattice — stretched and squeezed, but still legibly a lattice. Placing the i-th
// point where the mass reaches i + 1/2 instead discards the point's own radius,
// making the map identical for every ray with the same mass profile: on a flat
// field, where the answer is "move nothing", every ray puts its first point at
// the same radius and the result is concentric rings around an empty disc.
//
// S is a parameter rather than baked in. Hard-coding the uniform-lattice case is
// what forces a fudge constant to make a hex lattice pass for a square one;
// passing a profile makes a square lattice, a triangular one and a phyllotactic
// spiral the same code path with no constant to correct, because spine/lattice.js
// defines all three so that a point owns d^2 and `uniformProfile(d)` is exact for
// every one of them.
//
// A second transport pass, using an estimate of the current density as its
// profile, was built on this and removed: see radialRemap's header for why it
// cannot work. The profile stays a parameter regardless, since that is what
// makes the three arrangements interchangeable.

import { regionMask } from './mask.js';
import { interpTable } from './interp.js';

/** Angular bins. Fewer than this and the rays are visibly blocky. */
const MIN_BINS = 96;
const MAX_BINS = 720;
/** Radial samples per ray. */
const N_R = 256;

/**
 * Cumulative point-count mass along each ray.
 *
 * `rho` is points per unit area, sampled per pixel. Outside the drawing polygon
 * it is taken as ZERO rather than extrapolated -- the source fills the last
 * valid value forward (lines 48-51), which invents ink demand between the image
 * edge and the corner radius and biases every ray that does not point at a
 * corner.
 *
 * @returns {{nT:number, nR:number, dTheta:number, radii:Float64Array,
 *            M:Float64Array, total:Float64Array}}
 *          `M[t*nR + k]` is the mass inside radii[k] on ray t, per unit angle.
 */
export function massTable(ctx, rho, cx, cy, opts = {}) {
  const { nx, ny } = ctx;
  const mask = regionMask(ctx);

  // far enough to reach every corner of the drawing polygon
  let rMax = 0;
  for (const [qx, qy] of [[1, 1], [nx, 1], [1, ny], [nx, ny]]) {
    rMax = Math.max(rMax, Math.hypot(qx - cx, qy - cy));
  }
  // Angular resolution is set by the point spacing, not chosen. A bin of width
  // dTheta is only r*dTheta across, and once that is narrower than the spacing
  // the outer end of a wedge is a thin strip through a regular grid: whether it
  // contains a point is deterministic aliasing rather than chance, and no margin
  // on the source disc removes it. Measured at 360 bins with spacing 6, the
  // wedge was 4.15 px wide against a 6 px lattice and four rays came up short on
  // both lattices, while phyllotaxis -- which has no rows to fall between --
  // stayed clean.
  //
  // Sizing bins at TWO spacings across at the far radius is the derived answer:
  // nT = 2*pi*rMax / (2*d) = pi*rMax/d.
  const bins = opts.bins ?? (opts.spacing > 0
    ? Math.round((Math.PI * rMax) / opts.spacing)
    : 360);
  const nT = Math.min(MAX_BINS, Math.max(MIN_BINS, Math.round(bins)));
  const nR = N_R;
  const dTheta = (2 * Math.PI) / nT;
  const radii = new Float64Array(nR);
  for (let k = 0; k < nR; k++) radii[k] = (k * rMax) / (nR - 1);

  const M = new Float64Array(nT * nR);
  const total = new Float64Array(nT);
  for (let t = 0; t < nT; t++) {
    // bin CENTRE, so the sampled ray represents the wedge it stands for
    const th = -Math.PI + (t + 0.5) * dTheta;
    const ct = Math.cos(th), st = Math.sin(th);
    let acc = 0;
    let prev = 0;                       // rho*r at radii[0] = 0 is 0
    for (let k = 1; k < nR; k++) {
      const r = radii[k];
      const x = cx + r * ct, y = cy + r * st;
      const jx = Math.round(x) - 1, iy = Math.round(y) - 1;
      let v = 0;
      if (jx >= 0 && iy >= 0 && jx < nx && iy < ny && mask[iy * nx + jx]) {
        v = rho[iy * nx + jx] * r;
      }
      acc += ((prev + v) / 2) * (radii[k] - radii[k - 1]);
      prev = v;
      M[t * nR + k] = acc;
    }
    total[t] = acc;
  }
  return { nT, nR, dTheta, radii, M, total, rMax, cx, cy };
}

/**
 * Radius of the source disc that can supply every ray.
 *
 * A ray needs `total[t] * dTheta` points. A set of mean spacing `d` puts
 * `(S^2/2) * dTheta / d^2` points in that wedge inside radius S, so the radius
 * the hungriest ray strictly requires is `d sqrt(2 max(total))`.
 *
 * The margin on top is additive, not a percentage. A bin of angular width dTheta
 * is only `r * dTheta` across, which at the radii involved here is narrower than
 * the spacing — 3.8 px against 6 in one measured case — so the outermost annulus
 * of a thin wedge is often simply empty, and the shortfall is measured in lattice
 * spacings rather than in percent of the radius. A multiplicative 8% margin
 * leaves 8 rays of 360 short on a square lattice and 4 on a triangular one, while
 * phyllotaxis stays at zero because a spiral spreads itself far more evenly in
 * angle out there.
 *
 * The annulus of depth `extra` in one bin has area about `extra * need *
 * dTheta`, holding `extra * need * dTheta / d^2` points. Solving for `safety`
 * points gives the expression below; the floor of two spacings covers the case
 * where `need` is small enough to make that term meaningless.
 */
export function sourceRadiusFor(table, spacing, safety = 3) {
  let worst = 0;
  for (let t = 0; t < table.nT; t++) worst = Math.max(worst, table.total[t]);
  const need = spacing * Math.sqrt(2 * worst);
  const extra = (safety * spacing * spacing) / Math.max(1e-6, need * table.dTheta);
  return need + Math.max(extra, 2 * spacing);
}

/**
 * Cumulative source mass for a set of mean spacing `d`: S(s) = s^2 / (2 d^2).
 *
 * Exact for all three arrangements in spine/lattice.js, because each is defined
 * so that a point owns d^2 -- which is precisely why they are defined that way.
 * Independent of the ray, so the same S serves every angle.
 */
export function uniformProfile(spacing) {
  const inv = 1 / (2 * spacing * spacing);
  return { massAt: (t, s) => s * s * inv };
}

/**
 * Move points radially so their density matches the one the table describes.
 *
 * Each point keeps its angle and moves to the radius where the target's
 * cumulative mass equals the source's at the radius it came from. A point whose
 * source mass exceeds everything the ray has to give lands outside the drawing
 * and is dropped -- that is the slack `sourceRadiusFor` deliberately provides.
 *
 * DETERMINISTIC: no ordering, no ties, no sorting. Every point is mapped
 * independently of every other, which is a property the rank-based version did
 * not have and could not easily be given.
 *
 * @returns {{x:Float64Array, y:Float64Array, keep:Int32Array, dropped:number,
 *            short:number}} `keep` maps each output point back to its input
 *          index, which is what lets a caller reconstruct lattice rows. `short`
 *          counts rays whose outermost source point still mapped INSIDE, meaning
 *          the source disc was too small and that ray will draw light.
 */
export function transportRadial(xs, ys, n, table, profile) {
  const { nT, nR, dTheta, radii, M, total, cx, cy } = table;
  const ox = [], oy = [], keep = [];
  let dropped = 0;
  const reach = new Float64Array(nT);          // largest source mass seen per ray

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx, dy = ys[i] - cy;
    const s = Math.hypot(dx, dy);
    let t = Math.floor((Math.atan2(dy, dx) + Math.PI) / dTheta);
    if (t < 0) t = 0; else if (t >= nT) t = nT - 1;
    const m = profile.massAt(t, s);
    if (m > reach[t]) reach[t] = m;
    if (m > total[t]) { dropped++; continue; }
    // A view, not a copy: points arrive in no particular ray order, so caching
    // one column would miss more often than it hit.
    const col = M.subarray(t * nR, (t + 1) * nR);
    // The mass column is non-decreasing by construction (rho >= 0), so the
    // inverse is well defined without the source's `+ (0:n-1)*1e-6` monotonicity
    // hack -- that epsilon exists to unstick duplicate values created by
    // extrapolating outside the image, which this does not do.
    const r = interpTable(col, radii, m);
    const th = Math.atan2(dy, dx);
    ox.push(cx + r * Math.cos(th));
    oy.push(cy + r * Math.sin(th));
    keep.push(i);
  }
  // Two numbers, because a count alone cannot tell a ray missing its single
  // outermost dot from a ray missing half its length. `shortfall` is the worst
  // fraction of a ray's mass that had no source point to supply it, which is
  // directly how light that ray draws.
  let short = 0, shortfall = 0;
  for (let t = 0; t < nT; t++) {
    if (reach[t] >= total[t]) continue;
    short++;
    if (total[t] > 0) shortfall = Math.max(shortfall, (total[t] - reach[t]) / total[t]);
  }
  return {
    x: Float64Array.from(ox),
    y: Float64Array.from(oy),
    keep: Int32Array.from(keep),
    dropped,
    short,
    shortfall,
  };
}
