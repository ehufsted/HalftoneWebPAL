// Port of the Voronoi and Delaunay halves of
// singleWidthLines/code/regionsVorDelMSTTSP.m
// Header: "calibrated / Delaunay avoids very bright areas"
//
// The drawing IS the mesh. Points are scattered at a spacing set by the local
// darkness and then either their Voronoi cell boundaries or their Delaunay edges
// are drawn; tone comes from how much wire per unit area that network carries.
// (The source's MST and TSP modes are not here -- they are different graphs over
// the same point set and are getting their own module.)
//
// The tone relation is derived where the source fits it: a relaxed point set is
// near-hexagonal, and both networks then have closed forms.
//
// Take a hexagonal arrangement with nearest-neighbour spacing d. Its Voronoi
// cells are regular hexagons of side s = d/sqrt3, area (3sqrt3/2)s^2, perimeter
// 6s. With n = 1/area cells per unit area and every edge shared by two of them,
//
//     Voronoi length per unit area = 3*n*s = 2/d          exactly
//
// The Delaunay is its dual: the same number of edges, each perpendicular to its
// Voronoi partner and longer by d/s = sqrt3. So
//
//     Delaunay length per unit area = 2*sqrt3/d           exactly
//
// A pen of width w therefore covers
//
//     K = C*w/d,      C = 2 (Voronoi) or 2*sqrt3 = 3.4641 (Delaunay)
//
// and the ratio between the two modes is sqrt3 = 1.7321, with no free parameter
// at all. verify.html measures that ratio directly; it is the sharpest check
// available here because it is independent of w, of d, and of both constants.
//
// THE SOURCE'S CONSTANTS ARE THIS PLUS AN OVERLAP TERM. Its `R` is a radius,
// d/2, so `K = w/(R + w/2)` is K = 2w/(d + w) -- the derived numerator 2, with
// an overlap correction in the denominator. Its Delaunay line, K = 1.94w/(R+w),
// is K = 3.88w/(d + 2w) against a derived numerator of 3.4641. So the fit and
// the derivation agree to 12% on the leading term and differ on how much overlap
// to subtract, which is exactly the split this port makes explicit: C is
// derived and A is measured.
//
// The overlap is real and is the same shape as circlePacking's tangency term.
// Voronoi vertices have three edges meeting at 120 degrees; Delaunay vertices
// have about six. Where strokes meet, ink is counted twice.
//
// White is not reached, deliberately. In a near-white region the points are far
// apart and the network stretches into long edges crossing empty paper rather
// than fading out; those long edges are part of the look.

import { regionMask } from '../spine/mask.js';
import {
  stipplePoints,
  perimeterPoints,
  placerParam,
  usesSubdivide,
  usesRelaxation,
} from '../spine/points.js';
import { voronoiCells, regionEdges } from '../spine/regions.js';
import { triangulate } from '../spine/delaunay.js';
import { trimLineSegsToPolygon } from '../spine/geometry.js';
import { affineTarget } from '../spine/tone.js';

export const id = 'meshEdges';
export const label = 'Voronoi / Delaunay web';

/**
 * Tone constants per mode, as K = C*w/(d + A*w).
 *
 * C IS DERIVED and should not be touched without redoing the hexagonal
 * argument in the header: 2 and 2*sqrt3, with their ratio sqrt3 exactly.
 *
 * A is the overlap correction, derived and then measured. See coverageOf for the
 * ray-versus-line argument that puts Voronoi at 0.69; measured 0.61 to 0.75.
 * Delaunay measures about 1.2.
 *
 * These are not the source's values, whose fits imply roughly double in both
 * modes. Those make every drawing come out dark, because a denominator that is
 * too large predicts too little ink and the method packs the points tighter to
 * compensate.
 */
export const MESH_TONE = {
  // Voronoi is settled: measured 0.581, 0.589, 0.578, 0.570, 0.579 across a
  // five-fold range of spacing -- a spread of 0.020, against a derivation that
  // predicted 0.69. Close enough to the derived value to trust the mechanism,
  // far enough to be worth measuring.
  voronoi: { C: 2, A: 0.58 },
  // Delaunay is provisional: its three well-sampled rows give 1.115, 1.058 and
  // 1.037, and the two densest rows are contaminated by the triangulation
  // dropping edges above ~1500 points.
  delaunay: { C: 2 * Math.sqrt(3), A: 1.05 },
};

/**
 * How much longer a RELAXED point set's network is than the hexagonal ideal.
 *
 * C is derived for a perfect lattice; the sets this method actually places are
 * locally relaxed and globally not. Measured, length x spacing comes out at 2.05
 * to 2.08 against a derived 2, and about 3.6 against 3.46 -- the same +3 to +4%
 * in BOTH modes, which is the signature of the point set rather than of either
 * network. So it is one factor, named separately, rather than two adjusted Cs:
 * keeping C exact means the hexagonal argument stays checkable, and any future
 * change to the placer moves KAPPA and nothing else.
 */
export const LATTICE_KAPPA = 1.04;

export const params = [
  {
    key: 'mode', label: 'Network', type: 'select', def: 'voronoi',
    options: [
      { value: 'voronoi', label: 'Voronoi cell edges' },
      { value: 'delaunay', label: 'Delaunay edges' },
    ],
  },
  // In pen widths, like every other spacing control here. The floor is the merge
  // point and is derived rather than chosen: K = C*w/d reaches 1 at d = C*w, so
  // below that the network is solid ink whatever the model says. It differs
  // between the modes because C does -- 2w for Voronoi, 3.46w for Delaunay --
  // and the slider is clamped per mode rather than at a single compromise.
  { key: 'dMinW', label: 'Min spacing', type: 'range', min: 2, max: 10, step: 0.25, def: 4, unit: '×pen' },
  { key: 'dMaxW', label: 'Max spacing', type: 'range', min: 6, max: 40, step: 2, def: 40, unit: '×pen' },
  // Local Lloyd steps inside each split. Small on purpose: the subdivider only
  // asks it to arrange three seeds within one cell, which is a job that settles
  // in a handful of steps. It is NOT doing the global redistribution a flat
  // relaxation would need dozens of iterations for.
  // Both hidden under the subdivision placer, which has no local relaxation to
  // run and no seed to draw from.
  { key: 'relaxIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: usesRelaxation },
  // Pinned polish at the end, to settle the interface between the perimeter ring
  // and the interior points, which were placed without knowing the ring exists.
  // Kept at its default and not offered: it applies to both placers and tunes the
  // point set rather than the drawing. `when` hides rather than removes, so `run`
  // still reads it and gets the value below.
  { key: 'polishIter', label: 'Boundary polish', type: 'range', min: 0, max: 30, step: 1, def: 8, unit: 'iters',
    when: () => false },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1,
    when: (p) => !usesSubdivide(p) },
  placerParam(),
  // A GUARD, not a tone control. Point count goes as 1/d^2, so the dark end is
  // quadratically expensive and `triangulate` is O(n^2) in the point count as
  // written. At the default settings a 300x300 drawing wants a few thousand
  // points; a black field at the spacing floor wants tens of thousands, which
  // would hang the worker. Hitting this cap makes the drawing LIGHTER than
  // asked, which is the safe direction, and the harness reports when it binds.
  { key: 'maxPoints', label: 'Point budget', type: 'range', min: 500, max: 12000, step: 500, def: 6000 },
];

function scalesOf(ctx) {
  const w = ctx.w;
  const mode = ctx.mode ?? 'voronoi';
  const { C, A } = MESH_TONE[mode] ?? MESH_TONE.voronoi;
  // the merge floor is C*w, per mode
  const dMin = Math.max(C * w, (ctx.dMinW ?? 4) * w);
  const dMax = Math.max(dMin * 1.5, (ctx.dMaxW ?? 60) * w);
  return { w, mode, C, A, dMin, dMax };
}

/**
 * Coverage of a network of spacing d.
 *
 * K = KAPPA*C*w/(d + A*w) -- three factors with three different warrants. C is
 * derived exactly for a hexagonal lattice; KAPPA is the measured amount by which
 * a relaxed set exceeds that; A is the measured overlap where strokes meet.
 *
 * A is smaller than the source implies, and there is a derivation for that. The
 * three edges at a Voronoi vertex are RAYS, not crossing lines: two half-bands of
 * width w at 120 degrees overlap in about w^2*cot(60)/2 = 0.29 w^2, so ~0.6 w^2
 * per vertex after inclusion-exclusion. With 2n vertices and n = 1.1547/d^2 that
 * is a deficit of 0.693*w/d, i.e. A = 0.69, measured at 0.61 to 0.75 over the
 * well-sampled rows. Treating them as crossing lines instead gives 3.0*w/d, four
 * times too much.
 *
 * Delaunay puts six rays at one vertex rather than three at two, overlapping
 * more; measured A is about 1.2.
 */
export function coverageOf(C, A, w, d) {
  return Math.min(1, (LATTICE_KAPPA * C * w) / (d + A * w));
}

/**
 * Reachable brightness band. Black at the merge floor, and white unreachable --
 * at any finite spacing the network still lays wire.
 */
export function toneBand(ctx) {
  const { w, C, A, dMin, dMax } = scalesOf(ctx);
  return {
    min: Math.max(0, 1 - coverageOf(C, A, w, dMin)),
    max: Math.max(0, 1 - coverageOf(C, A, w, dMax)),
  };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Point spacing per pixel, and the density that follows from it.
 *
 * Note the exponent: it is not the one the Voronoi region tiler uses. There the
 * goal is equal INK per cell, which wants point density proportional to darkness.
 * Here the goal is correct tone from an edge network whose length goes as
 * sqrt(density), so
 *
 *     K = C*w*sqrt(n)*const   =>   n proportional to K^2
 *
 * Two methods, two different point distributions from the same placer. The field
 * handed to stipplePoints IS the density: the subdivider sets each cell count
 * from its mass, so no exponent correction is involved.
 */
export function spacingMap(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { w, C, A, dMin, dMax } = scalesOf(ctx);
  const band = toneBand(ctx);
  const n = nx * ny;
  const dens = new Float64Array(n);
  const mask = regionMask(ctx);
  let total = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!mask[c]) continue;
      // Remap into the reachable band first, then invert. Clamping d afterwards
      // instead makes the method disagree with its own targetImage everywhere the
      // clamp bites, which is most of the picture: at Lmin = 4 pen widths every
      // tone darker than mid-grey wants a spacing below the floor, so all of it
      // comes out at the floor while affineTarget goes on ramping smoothly.
      // Measured, band 5 of a linear ramp targeted 0.218 coverage against 0.449
      // rendered, and 0.449 is exactly what the floor spacing predicts.
      //
      // eikonalStripes and planeWaves both remap; this one did not. Doing it
      // makes the clamp redundant -- B = 0 gives dMin and B = 1 gives dMax by
      // construction -- which is the tell that it is the correct form.
      const B = Math.min(1, Math.max(0, ctx.im.data[c]));
      const B2 = B * (band.max - band.min) + band.min;
      const K2 = Math.max(1e-6, 1 - B2);
      const d = Math.min(dMax, Math.max(dMin, (LATTICE_KAPPA * C * w) / K2 - A * w));
      // hexagonal packing: n points per unit area at nearest-neighbour spacing d
      dens[c] = 1.1547 / (d * d);
      total += dens[c];
    }
  }
  return { dens, total };
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { mode } = scalesOf(ctx);

  const { dens, total } = spacingMap(ctx);
  const budget = Math.max(50, Math.round(ctx.maxPoints ?? 6000));

  // The perimeter ring follows the LOCAL interior density -- `dens` is the same
  // field the interior points are placed from, so the two spacings match
  // wherever they meet. That matters more here than for a region tiler: these
  // edges ARE the drawing, so a boundary at the wrong spacing is a visible band
  // of wrong tone all the way round the page rather than a few odd triangles.
  //
  // The count is set before the budget is applied, so if the budget binds the
  // ring is a little denser than the interior it ends up joining. That is the
  // safe direction -- a sparse border on a dark drawing would read as a light
  // frame -- and the budget is a guard rather than a setting anyone tunes.
  const wanted = Math.max(1, Math.min(budget, Math.round(total)));
  const ring = perimeterPoints(ctx, dens, wanted);

  const nInterior = Math.max(1, Math.min(budget - ring.sx.length, wanted));
  const nAll = ring.sx.length + nInterior;
  if (nAll < 4) return [];

  const { sx, sy } = stipplePoints(ctx, {
    // Anything but 'subdivide' is the calibrated default, so an absent or
    // unrecognised setting falls through to it rather than failing.
    mode: ctx.placer,
    field: dens,
    count: nInterior,
    seeds0: ring,
    seed: Math.round(ctx.seed ?? 1),
    iterations: Math.round(ctx.relaxIter ?? 6),
    polish: Math.round(ctx.polishIter ?? 8),
  });

  const segs = [];
  if (mode === 'delaunay') {
    const { tris, n: nT } = triangulate(sx, sy);
    const seen = new Set();
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const u = tris[3 * t + k], v = tris[3 * t + ((k + 1) % 3)];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (seen.has(key)) continue;
        seen.add(key);
        segs.push([sx[u], sy[u], sx[v], sy[v]]);
      }
    }
  } else {
    // Reuses the tiler's cell builder and its edge deduplication rather than
    // dualising the triangulation: those cells are already clipped to the
    // drawing polygon, and regionEdges already emits each shared boundary once.
    // Drawing every cell ring instead would put the pen down every interior
    // edge twice -- doubling the ink, which here IS the tone.
    const cells = voronoiCells(ctx, sx, sy, sx.length).filter(Boolean);
    // skipBoundary: the page edge is a clip artefact, not a Voronoi edge, and
    // counting it would put a fixed band of extra ink round the drawing that no
    // part of the tone model accounts for
    for (const e of regionEdges(cells, { skipBoundary: ctx.polygon })) {
      segs.push([e[0][0], e[0][1], e[1][0], e[1][1]]);
    }
  }

  const out = [];
  for (const s of trimLineSegsToPolygon(segs, px, py)) {
    out.push([[s[0], s[1]], [s[2], s[3]]]);
  }
  return out;
}

export default { id, label, params, run, targetImage };
