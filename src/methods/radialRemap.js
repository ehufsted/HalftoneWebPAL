// Port of singleWidthLines/code/testRadialRemappingPoints.m
//
// Take a perfectly regular set of points and squeeze it radially until its
// density carries the image. Nothing is placed, nothing is relaxed, nothing is
// iterated to convergence -- the arrangement is decided in advance and the
// picture comes entirely from how it is DEFORMED. That is what makes it look
// unlike the other stipple methods here: stippleGrowing and the Voronoi tilers
// both produce blue noise, which has no structure to see, while this keeps its
// rows and spirals and lets you read the distortion directly.
//
// The transport itself is spine/radialTransport.js and the arrangements are
// spine/lattice.js, both tested before this file existed. What is left here is
// the tone model, the choice of centre, and the drawing.
//
// The tone ladder is 1/d^2, not 1/d, which is unique to this method. Every stroke
// method covers w/L — ink is a LENGTH times a width,
// so halving the spacing doubles the coverage. A dot covers pi*rDot^2 regardless
// of how far away the next dot is, so coverage is pi*rDot^2/d^2 and halving the
// spacing QUADRUPLES it. The consequence worth knowing: the useful spacing range
// is much narrower than a stripe method's, because tone runs from black to white
// over a factor of sqrt(dMax/dMin) rather than dMax/dMin.
//
// One pass only, and a second radial pass cannot work — written down because the
// idea is an obvious one to have.
//
// A radial pass makes the density exactly right along every ray and can only
// approximate it across rays -- mass never moves sideways. Repeating from a
// different centre looks like sliced optimal transport, which does converge. It
// does not work here, for a reason that is structural rather than a matter of
// tuning:
//
//   - A second pass needs the CURRENT density, which has to be estimated from
//     the points. The kernel must be about 1.5 spacings wide: narrower and the
//     estimate carries the lattice's own periodicity, which the next pass then
//     faithfully transports away, destroying the structure the method exists to
//     show.
//   - The residual left by the first pass is at roughly that same scale. So the
//     estimator is blind to precisely the error the pass is meant to fix, and
//     instead moves points in response to its own noise.
//   - A different centre does not rescue it. Every radial pass has the same
//     blind spot -- no tangential motion -- merely rotated, and two centres near
//     the middle of the page have blind spots that almost coincide.
//
// Measured on a linear ramp: density error 0.0666 at one pass, 0.0760 at two,
// 0.0736 at three, and the points visibly scrambled. Using point RANKS for the
// profile is far worse (0.172), for the reason radialTransport's header gives. If
// this is revisited, what would actually reduce the residual is a different
// SECOND STAGE — a few Lloyd steps,
// or genuinely linear slices -- not another radial pass.
//
// NOT PORTED: the animation loop at lines 121-147, which interpolates between
// the undeformed and deformed sets to make a GIF. It is a presentation of the
// result rather than part of it.

import { dotPath } from '../spine/dots.js';
import { affineTarget } from '../spine/tone.js';
import { regionMask } from '../spine/mask.js';
import { clipPolyline } from '../spine/geometry.js';
import { latticeInDisc, HEX_A_PER_SPACING } from '../spine/lattice.js';
import {
  massTable, sourceRadiusFor, transportRadial, uniformProfile,
} from '../spine/radialTransport.js';

export const id = 'radialRemap';
export const label = 'Radially remapped lattice';

/**
 * Measured correction between the ideal coverage pi*rDot^2/d^2 and what the
 * renderer lays down. dotPath already solves for the radius that makes a dot's
 * area exact (see its header), so this starts at 1 and the harness says whether
 * it should stay there.
 */
export const REMAP_KAPPA = 1;

/** Beyond this the transport is slower to run than the result is to look at. */
export const MAX_POINTS = 60000;

export const params = [
  {
    key: 'pointKind', label: 'Arrangement', type: 'select', def: 'phyllotaxis',
    options: [
      { value: 'phyllotaxis', label: 'Phyllotaxis (sunflower spiral)' },
      { value: 'hex', label: 'Triangular lattice' },
      { value: 'square', label: 'Square lattice' },
    ],
  },
  // Diameter, not radius, because that is what a merge floor is stated in: at
  // d = dotDW*w the dots touch. Minimum 1 is a single pen dot.
  { key: 'dotDW', label: 'Dot size', type: 'range', min: 1, max: 8, step: 0.1, def: 2.5, unit: '×pen' },
  { key: 'dMinW', label: 'Min spacing', type: 'range', min: 1, max: 10, step: 0.1, def: 3, unit: '×pen' },
  { key: 'dMaxW', label: 'Max spacing', type: 'range', min: 4, max: 80, step: 1, def: 14, unit: '×pen' },
  {
    key: 'centreMode', label: 'Centre', type: 'select', def: 'image',
    options: [
      { value: 'image', label: 'Centre of the page' },
      { value: 'top', label: 'Top edge, centred' },
      { value: 'corner', label: 'Top-left corner' },
    ],
  },
  // The deformed lattice is the most legible part of the effect, and this app is
  // about lines. One family of rows only -- see latticeInDisc on why.
  { key: 'drawLattice', label: 'Join the rows', type: 'checkbox', def: false },
];

/**
 * Drawn length per unit area, times the spacing, when the rows are joined.
 *
 * Derived, not fitted. A set of mean spacing d has A/d^2 points in area A, and
 * joining each to its neighbour along one row family draws one segment per
 * point, so the total length is (A/d^2) * (neighbour distance) and the length
 * per unit area is (neighbour distance)/d^2.
 *
 *   square      neighbours are d apart              -> C = 1
 *   hex         neighbours are d*sqrt(2/sqrt(3))    -> C = 1.0746
 *   phyllotaxis locally a triangular packing, so the same as hex
 *
 * The third is a prediction rather than an assumption: a Vogel spiral's
 * parastichy neighbours are its nearest neighbours, and a locally hexagonal
 * packing puts those at the triangular-lattice distance. If the harness measures
 * phyllotaxis nearer 1.00 than 1.07, the parastichy being drawn is not the
 * nearest-neighbour one and the Fibonacci stride in lattice.js is off by a term.
 */
export const ROW_C = {
  square: 1,
  hex: HEX_A_PER_SPACING,
  phyllotaxis: HEX_A_PER_SPACING,
};

function geometryOf(ctx) {
  const w = ctx.w;
  const rDot = Math.max(w / 2, ((ctx.dotDW ?? 2.5) * w) / 2);
  // The merge floor depends on what is being drawn, and both versions are
  // derived. Dots overlap below d = 2*rDot, where the coverage is pi/4. Joined
  // rows merge below d = C*w, where the coverage is 1 and the area is solid.
  // Using the dot floor in row mode would forbid perfectly good tone; using the
  // row floor in dot mode would promise tone the dots cannot deliver.
  const C = ROW_C[ctx.pointKind ?? 'phyllotaxis'] ?? 1;
  const floor = ctx.drawLattice ? C * w : 2 * rDot;
  const dMin = Math.max(floor, (ctx.dMinW ?? 3) * w);
  const dMax = Math.max(dMin * 1.5, (ctx.dMaxW ?? 14) * w);
  return { w, rDot, dMin, dMax, C };
}

/**
 * The two tone laws, and which one is in force.
 *
 * The mode changes the exponent. Dots cover pi*rDot^2 whatever the spacing, so
 * coverage is pi*rDot^2/d^2 -- halving the spacing QUADRUPLES the ink. Joined
 * rows cover w per unit length, so coverage is C*w/d and halving the spacing
 * merely doubles it. Same points, same transport, different ladder, and getting
 * this wrong would leave the row mode systematically dark at one end and light
 * at the other in exactly the shape of a squared error.
 */
function ladderOf(ctx) {
  const { w, rDot, dMin, dMax, C } = geometryOf(ctx);
  const k = REMAP_KAPPA;
  if (ctx.drawLattice) {
    return {
      dMin, dMax,
      cov: (d) => Math.min(1, (k * C * w) / d),
      dOf: (c) => (k * C * w) / Math.max(1e-6, c),
    };
  }
  return {
    dMin, dMax,
    cov: (d) => Math.min(1, (k * Math.PI * rDot * rDot) / (d * d)),
    dOf: (c) => rDot * Math.sqrt((k * Math.PI) / Math.max(1e-6, c)),
  };
}

/** Coverage of dots of radius rDot at mean spacing d. */
export function coverageOf(rDot, d, kappa = REMAP_KAPPA) {
  return Math.min(1, (kappa * Math.PI * rDot * rDot) / (d * d));
}

export function toneBand(ctx) {
  const L = ladderOf(ctx);
  return { min: 1 - L.cov(L.dMin), max: 1 - L.cov(L.dMax) };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Point density per pixel, from the tone the method is aiming for.
 *
 * Remapped into the reachable band BEFORE inverting, never clamped afterwards --
 * the trap meshEdges fell into. The spacing comes from whichever ladder is in
 * force; the density is always 1/d^2, because that is a fact about points rather
 * than about what is drawn through them.
 */
export function densityMap(ctx) {
  const L = ladderOf(ctx);
  const tgt = affineTarget(ctx, toneBand(ctx));
  const rho = new Float64Array(tgt.data.length);
  for (let i = 0; i < rho.length; i++) {
    const c = Math.min(1, Math.max(0, 1 - tgt.data[i]));
    const d = L.dOf(c);
    rho[i] = 1 / (d * d);
  }
  return rho;
}

/**
 * Where the pole goes.
 *
 * The centre is a singularity: it is the one point the transport cannot move,
 * and the lattice necessarily tears there. All three choices are corners or
 * midpoints of the drawing polygon's bounding box, so the pole is always at a
 * place the composition already has an edge or a centre at.
 *
 *   image   the page centre, which is what the source does. The rays radiate
 *           symmetrically and the tear sits in the middle of the picture.
 *   top     the middle of the top edge. Rays fan through a half turn.
 *   corner  the top-left corner. Rays fan through a quarter turn, which reads as
 *           a perspective or a raking light rather than as a radial burst.
 *
 * A pole on the boundary is well behaved: the mass
 * integral starts at zero there and grows as r^2, so the map is finite and the
 * density near the corner is as correct as anywhere else. What changes is only
 * that a smaller wedge of directions carries any image at all -- three quarters
 * of the source disc is generated and immediately discarded for `corner`, which
 * costs generation time and nothing else.
 */
export function centreOf(ctx, mode) {
  const { px, py } = ctx.polygon;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < px.length; i++) {
    if (px[i] < x0) x0 = px[i];
    if (px[i] > x1) x1 = px[i];
    if (py[i] < y0) y0 = py[i];
    if (py[i] > y1) y1 = py[i];
  }
  if (mode === 'corner') return [x0, y0];
  if (mode === 'top') return [(x0 + x1) / 2, y0];
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * The transported point set, and the row structure that survived it.
 *
 * Exported so the harness can measure the points directly rather than inferring
 * them from a rendered picture.
 */
export function remapPoints(ctx) {
  const { nx, ny } = ctx;
  const { rDot } = geometryOf(ctx);
  const kind = ctx.pointKind ?? 'phyllotaxis';
  const rho = densityMap(ctx);
  const mask = regionMask(ctx);

  // How many points the picture wants, and therefore the spacing that makes the
  // SOURCE closest to the answer. Starting from the mean target spacing rather
  // than from an arbitrary d0 minimises how far anything has to move, which is
  // what keeps the deformed lattice legible.
  let want = 0, areaIn = 0;
  for (let i = 0; i < rho.length; i++) if (mask[i]) { want += rho[i]; areaIn++; }
  if (!(want > 1) || areaIn === 0) return null;
  // Over budget, thin everything uniformly rather than returning nothing. A
  // drawing that is honestly too light is recoverable by moving a slider; an
  // empty canvas tells the user only that something went wrong somewhere.
  let capped = 0;
  if (want > MAX_POINTS) {
    capped = want;
    const scale = MAX_POINTS / want;
    for (let i = 0; i < rho.length; i++) rho[i] *= scale;
    want = MAX_POINTS;
  }
  const d0 = Math.sqrt(areaIn / want);

  const [cx0, cy0] = centreOf(ctx, ctx.centreMode ?? 'dark');
  const table0 = massTable(ctx, rho, cx0, cy0, { spacing: d0 });
  const S = sourceRadiusFor(table0, d0);
  const src = latticeInDisc(kind, S, d0);
  if (src.n === 0) return null;

  const sx0 = Float64Array.from(src.x, (v) => v + cx0);
  const sy0 = Float64Array.from(src.y, (v) => v + cy0);
  const moved = transportRadial(sx0, sy0, src.n, table0, uniformProfile(d0));
  const px = moved.x, py = moved.y;
  const n = px.length;
  if (n === 0) return null;
  // Index back into the lattice, so rows survive the transport's discards.
  const origin = moved.keep;
  const { dropped, short, shortfall } = moved;

  // Keep only what landed on the page. Points cannot land where rho is zero --
  // the mass stops accumulating there -- but the mask is per pixel and a point
  // can still come to rest just outside it.
  const kx = [], ky = [], ko = [];
  for (let i = 0; i < n; i++) {
    const jx = Math.round(px[i]) - 1, iy = Math.round(py[i]) - 1;
    if (jx < 0 || iy < 0 || jx >= nx || iy >= ny) continue;
    if (!mask[iy * nx + jx]) continue;
    kx.push(px[i]); ky.push(py[i]); ko.push(origin[i]);
  }

  return {
    x: Float64Array.from(kx),
    y: Float64Array.from(ky),
    origin: Int32Array.from(ko),
    n: kx.length,
    want, capped, d0, rDot, S,
    sourceN: src.n,
    rows: src.rows,
    dropped, short, shortfall,
  };
}

export function run(ctx) {
  const { px: polyX, py: polyY } = ctx.polygon;
  const built = remapPoints(ctx);
  if (!built) return [];
  const { x, y, n, origin, rDot, rows } = built;
  const w = ctx.w;

  if (!ctx.drawLattice) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(dotPath(x[i], y[i], rDot, w));
    return out;
  }

  // Rows, rebuilt through the transport. `origin` maps each surviving point back
  // to its index in the undeformed lattice, so a row is still a row -- but points
  // have been dropped along the way, and joining across a gap would draw a chord
  // through territory the transport deliberately emptied. Split there instead.
  const where = new Map();
  for (let i = 0; i < n; i++) where.set(origin[i], i);
  const out = [];
  for (const row of rows) {
    let run = [];
    for (const idx of row) {
      const i = where.get(idx);
      if (i === undefined) {
        if (run.length > 1) for (const p of clipPolyline(run, polyX, polyY)) out.push(p);
        run = [];
        continue;
      }
      run.push([x[i], y[i]]);
    }
    if (run.length > 1) for (const p of clipPolyline(run, polyX, polyY)) out.push(p);
  }
  return out;
}

export default { id, label, params, run, targetImage };
