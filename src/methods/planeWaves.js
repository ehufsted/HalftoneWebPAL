// Port of singleWidthLines/code/regionsPlaneWaveInPolygon.m
// Header: "stripes. Works well."
//
// THIS IS eikonalStripes IN ONE DIMENSION, and saying so is the fastest way to
// understand it. Pick an axis, project the region's pixels onto it, average the
// darkness into slabs -- and you have a 1-D brightness profile. Integrate the
// local wavenumber 2*pi/L along that profile to get accumulated phase, and put a
// line wherever the phase crosses a multiple of 2*pi. Exactly the same guarantee
// (consecutive level sets sit exactly L apart) with none of the machinery,
// because in one dimension the eikonal equation |grad P| = 2*pi/L is just an
// integral. No geodesic solver, no contouring.
//
// WHAT IT COSTS is the whole reason for the regions. Projecting collapses one
// dimension: inside a region, tone can vary ALONG the projection axis and not
// across it, because everything across it has been averaged into the profile.
// The method is therefore only as good as the assumption that each region is
// locally one-dimensional -- which is what the region size control buys, and why
// it is a quality knob rather than a cosmetic one. verify.html measures exactly
// this by sweeping region size against a field that varies the wrong way.
//
// The tone ladder is the interpolating harmonic one. Coverage of stripes at
// spacing L is w/L, so brightness B = 1 - w/L inverts to L = w/(1-B). Remapping
// the image into [Bmin, Bmax] = [1-w/Lmin, 1-w/Lmax] first gives
//
//     1/L = 1/Lmin + B*(1/Lmax - 1/Lmin)
//
// which is character-identical to eikonalStripes and circlePacking. (Not
// refiningNoise's -- see docs/architecture.md.)
//
// The source's ladder is `L = Lmin./(1-B2)`, where inverting B = 1-w/L gives
// `L = w/(1-B)`. The two agree only when Lmin = w, which its demo happens to set;
// with any other Lmin the spacing is wrong at both ends, producing Lmin*Lmax/w
// instead of Lmax at B2 = Bmax. Ported as w/(1-B2), which spans [Lmin, Lmax] on
// its own because the remap already did the clamping.
//
// NOT PORTED: the multi-angle overlay loop (lines 62-73), which draws at one
// angle, renders those strokes, lightens the image by them and draws again at
// another angle. It is what produces the woven texture in the source's example
// output, and it is a layering feature rather than part of the stripe model.
// Left out on request; the hook for it is that `run` is already a pure function
// of (image, region set, angle).

import { regionIndices } from '../spine/mask.js';
import { inpolygon } from '../shim/image.js';
import { structureTensorField, meanOrientation } from '../spine/field.js';
import { placerParam, usesSubdivide, usesRelaxation } from '../spine/points.js';
import { tileRegions, regionEdges } from '../spine/regions.js';
import { trimLineSegsToPolygon } from '../spine/geometry.js';
import { interpTable } from '../spine/interp.js';
import {
  affineTarget, stripeSpacings, stripeBand, harmonicInvSpacing,
} from '../spine/tone.js';

export const id = 'planeWaves';
export const label = 'Plane waves in regions';

/**
 * The tilers that place POINTS, as opposed to laying down a fixed lattice.
 * Only these reach `stipplePoints`, so only these are affected by the placer,
 * its relaxation count or its seed.
 */
const PLACED_KINDS = new Set(['voronoi', 'delaunay']);

export const params = [
  {
    key: 'regionKind', label: 'Regions', type: 'select', def: 'rect',
    options: [
      { value: 'rect', label: 'Square grid' },
      { value: 'hex', label: 'Hex grid' },
      { value: 'trilattice', label: 'Triangular lattice' },
      { value: 'voronoi', label: 'Voronoi (equal ink per cell)' },
      { value: 'delaunay', label: 'Delaunay triangles (aligned to edges)' },
    ],
  },
  // sqrt of the cell AREA, so the two lattices stay comparable. Independent of
  // the spacing controls: a region wants to be small enough that the image is
  // locally 1-D across it, which has nothing to do with how far apart the
  // stripes inside it end up.
  { key: 'regionSizeW', label: 'Region size', type: 'range', min: 8, max: 40, step: 2, def: 10, unit: '×pen' },
  {
    key: 'orientSource', label: 'Stripe angle from', type: 'select', def: 'gradient',
    options: [
      { value: 'gradient', label: 'Darkness gradient (plane fit)' },
      { value: 'tensor', label: 'Structure tensor' },
    ],
  },
  {
    key: 'nAngles', label: 'Angle quantisation', type: 'select', def: 0,
    options: [
      { value: 0, label: 'Follow the region' },
      { value: 2, label: 'Quantise to 2' },
      { value: 4, label: 'Quantise to 4' },
      { value: 6, label: 'Quantise to 6' },
      { value: 12, label: 'Quantise to 12' },
    ],
  },
  // min 1 is the merge floor, as in eikonalStripes: at L = w adjacent stripes
  // touch and the region is solid.
  { key: 'LminW', label: 'Min spacing', type: 'range', min: 1, max: 12, step: 0.1, def: 1.5, unit: '×pen' },
  { key: 'LmaxW', label: 'Max spacing', type: 'range', min: 4, max: 20, step: 1, def: 10, unit: '×pen' },
  // The next three reach the point placer, so they are shown only for the two
  // tilers that place points; the three lattices ignore them.
  //
  // Local Lloyd steps inside each subdivision, not a global relaxation count: the
  // placer settles counts by mass and leaves Lloyd only the arrangement of three
  // seeds within one cell, which needs a handful of steps rather than dozens.
  { key: 'regionIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: (p) => PLACED_KINDS.has(p.regionKind) && usesRelaxation(p) },
  // The pinned pass that settles the interface with the perimeter ring, so not
  // gated on the placer. In truth it is delaunay-only, since the Voronoi tiler
  // passes no perimeter ring and the pass needs one; tightening this to
  // `=== 'delaunay'` is a one-word change and its own separate measurement.
  { key: 'polishIter', label: 'Boundary polish', type: 'range', min: 0, max: 30, step: 1, def: 8, unit: 'iters',
    when: (p) => PLACED_KINDS.has(p.regionKind) },
  { key: 'regionSeed', label: 'Voronoi seed', type: 'range', min: 1, max: 999, step: 1, def: 1,
    when: (p) => PLACED_KINDS.has(p.regionKind) && !usesSubdivide(p) },
  placerParam((p) => PLACED_KINDS.has(p.regionKind)),
  // Delaunay only. edgeMix blends the edge field against a uniform floor: at 1
  // the flat areas get NO seeds at all and their triangles grow without bound,
  // which breaks the 1-D projection this method depends on.
  { key: 'edgeMix', label: 'Edge alignment', type: 'range', min: 0, max: 1, step: 0.05, def: 0.75 },
  { key: 'edgeSigma', label: 'Edge scale', type: 'range', min: 1, max: 12, step: 0.5, def: 2, unit: 'px' },
  // Cell boundaries are a plausible drawing in their own right -- the
  // collection ships gradient3_voronoiLines.svg -- and are near-free once the
  // polygons exist. Deduped, so the pen does not go down every shared edge
  // twice; see regionEdges.
  { key: 'drawRegions', label: 'Draw region outlines', type: 'checkbox', def: false },
];

/**
 * A region with fewer than this many pixels does not get its own angle.
 *
 * Border cells come back as slivers after clipping, and both orientation
 * estimates degrade there for the same reason: a plane fit through a handful of
 * nearly-collinear points is dominated by noise, and a mean orientation over the
 * same handful has no statistics behind it. Such a cell falls back to the
 * orientation of the whole drawing, which is stable by construction. 24 is about
 * a 5x5 patch -- small enough that it only ever catches genuine slivers.
 */
const MIN_REGION_PIXELS = 24;

/** Profile bins, in pen widths. The source hardcodes 1.5 px against w = 2. */
const BIN_W = 1;

const spacingsOf = (ctx) => stripeSpacings(ctx);

/** Reachable brightness band: coverage is w/L, the same band as eikonalStripes. */
export function toneBand(ctx) {
  const { w, Lmin, Lmax } = spacingsOf(ctx);
  return stripeBand(w, Lmin, Lmax);
}

/**
 * The tone the method aims for.
 *
 * The affine band only. The 1-D projection is an APPROXIMATION, not a target:
 * where a region is not locally one-dimensional the result is wrong, and folding
 * that into the target would be scoring the method against its own error. The
 * region-size sweep in verify.html is what measures it instead.
 */
export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Projection axis for one set of pixels: the direction along which tone varies,
 * so that stripes (drawn perpendicular to it) run along iso-brightness.
 *
 * Two answers, and they are not the same thing.
 *
 * 'gradient' is a least squares fit of a plane to the darkness, then the gradient
 * direction. This is the choice that
 * makes the method's own assumption most nearly true -- projecting along the
 * gradient means the perpendicular direction is the one with least variation, so
 * the averaging destroys as little as possible.
 *
 * 'tensor' is what the rest of the app uses (polygonSubdivision, 10 PRINT): the
 * structure tensor's orientation, which is the local EDGE TANGENT. Stripes then
 * follow edges. The projection axis is the tangent turned by pi/2.
 *
 * @returns {number|null} the axis angle, or null if the fit is degenerate
 */
function axisFor(mode, idx, count, nx, im, field, cx, cy) {
  if (mode === 'tensor') {
    const angles = new Float64Array(count);
    for (let k = 0; k < count; k++) angles[k] = field.theta[idx[k]];
    return meanOrientation(angles) + Math.PI / 2;
  }
  // least squares plane through the darkness: minimise |A*[a b c]' - K|
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, s1 = 0;
  let sxz = 0, syz = 0, sz = 0;
  for (let k = 0; k < count; k++) {
    const c = idx[k];
    const dx = (c % nx) + 1 - cx;
    const dy = Math.floor(c / nx) + 1 - cy;
    const z = 1 - im.data[c];                       // darkness
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    sx += dx; sy += dy; s1 += 1;
    sxz += dx * z; syz += dy * z; sz += z;
  }
  // solve the 3x3 normal equations by Cramer; dx/dy are already centred, so sx
  // and sy are ~0 and the system is well conditioned unless the pixels are
  // collinear -- which the determinant check catches
  const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, s1]];
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const detA = sxz * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
             - m[0][1] * (syz * m[2][2] - m[1][2] * sz)
             + m[0][2] * (syz * m[2][1] - m[1][1] * sz);
  const detB = m[0][0] * (syz * m[2][2] - m[1][2] * sz)
             - sxz * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
             + m[0][2] * (m[1][0] * sz - syz * m[2][0]);
  const a = detA / det, b = detB / det;
  if (!(Math.abs(a) > 1e-12 || Math.abs(b) > 1e-12)) return null;   // flat region
  return Math.atan2(b, a);
}

/** Quantise an axis angle. Stripes are symmetric, so the modulus is pi. */
function quantise(t, nAngles) {
  if (!(nAngles > 0)) return t;
  const step = Math.PI / nAngles;
  return Math.round(t / step) * step;
}

/**
 * Stripe offsets along the projection axis, for one region.
 *
 * Exported so the harness can check the phase integral directly: the number of
 * lines must be round(total phase / 2*pi), and consecutive offsets must sit
 * exactly one local L apart.
 */
export function stripeOffsets(u, K, Lmin, Lmax, binPx) {
  let uMin = Infinity, uMax = -Infinity;
  for (let i = 0; i < u.length; i++) {
    if (u[i] < uMin) uMin = u[i];
    if (u[i] > uMax) uMax = u[i];
  }
  const span = uMax - uMin;
  if (!(span > 0)) return [];
  const nBins = Math.max(2, Math.round(span / binPx));
  const du = span / nBins;

  const sum = new Float64Array(nBins), cnt = new Float64Array(nBins);
  for (let i = 0; i < u.length; i++) {
    let b = Math.floor((u[i] - uMin) / du);
    if (b < 0) b = 0; else if (b >= nBins) b = nBins - 1;
    sum[b] += K[i]; cnt[b] += 1;
  }
  // Empty bins take the nearest occupied value rather than zero. A gap is a
  // region whose shape leaves a slab unoccupied -- a hexagon's corners do this
  // constantly -- and zero darkness there would open a false light band.
  const Kb = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) Kb[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  let last = NaN;
  for (let i = 0; i < nBins; i++) { if (!Number.isNaN(Kb[i])) last = Kb[i]; else Kb[i] = last; }
  last = NaN;
  for (let i = nBins - 1; i >= 0; i--) { if (!Number.isNaN(Kb[i])) last = Kb[i]; else Kb[i] = last; }
  for (let i = 0; i < nBins; i++) if (Number.isNaN(Kb[i])) Kb[i] = 0;

  // The shared harmonic ladder, in its 1/L form because what accumulates below
  // is phase. Kb is coverage, so `1 - Kb` is the raw brightness the ladder wants.
  const centres = new Float64Array(nBins);
  const k = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    centres[i] = uMin + (i + 0.5) * du;
    const B = 1 - Math.min(1, Math.max(0, Kb[i]));
    k[i] = 2 * Math.PI * harmonicInvSpacing(B, Lmin, Lmax);
  }

  // accumulated phase, trapezoid
  const p = new Float64Array(nBins);
  for (let i = 1; i < nBins; i++) p[i] = p[i - 1] + ((k[i - 1] + k[i]) / 2) * du;

  const total = p[nBins - 1];
  const nLines = Math.round(total / (2 * Math.PI));
  const out = [];
  for (let i = 1; i <= nLines; i++) {
    out.push(interpTable(p, centres, (i - 0.5) * 2 * Math.PI));
  }
  return out;
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { w, Lmin, Lmax } = spacingsOf(ctx);
  const mode = ctx.orientSource ?? 'gradient';
  const nAngles = Math.round(ctx.nAngles ?? 0);
  const binPx = Math.max(1, BIN_W * w);

  const regions = tileRegions(ctx, {
    kind: ctx.regionKind ?? 'rect',
    // Spread into stipplePoints by the two tilers that place points; the three
    // lattices never look at it.
    mode: ctx.placer,
    sizePx: Math.max(4 * w, (ctx.regionSizeW ?? 40) * w),
    seed: Math.round(ctx.regionSeed ?? 1),
    iterations: Math.round(ctx.regionIter ?? 6),
    polish: Math.round(ctx.polishIter ?? 8),
    edgeMix: ctx.edgeMix ?? 0.75,
    edgeSigma: ctx.edgeSigma ?? 2,
  });
  if (regions.length === 0) return [];

  const field = mode === 'tensor'
    ? structureTensorField(ctx.im, Math.max(1, w), Math.max(1.5, w * 2))
    : null;

  // Whole-drawing fallback, computed once: a sliver cell borrows this rather
  // than fitting a plane through six nearly-collinear pixels.
  const allIdx = regionIndices(ctx);
  if (allIdx.length === 0) return [];
  let gcx = 0, gcy = 0;
  for (const c of allIdx) { gcx += (c % nx) + 1; gcy += Math.floor(c / nx) + 1; }
  gcx /= allIdx.length; gcy /= allIdx.length;
  const globalAxis = axisFor(mode, allIdx, allIdx.length, nx, ctx.im, field, gcx, gcy) ?? 0;

  const out = [];
  if (ctx.drawRegions) for (const e of regionEdges(regions)) out.push(e);
  for (const region of regions) {
    // pixels of this region, over its own bounding box
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < region.px.length; i++) {
      if (region.px[i] < bx0) bx0 = region.px[i];
      if (region.px[i] > bx1) bx1 = region.px[i];
      if (region.py[i] < by0) by0 = region.py[i];
      if (region.py[i] > by1) by1 = region.py[i];
    }
    const j0 = Math.max(1, Math.floor(bx0)), j1 = Math.min(nx, Math.ceil(bx1));
    const i0 = Math.max(1, Math.floor(by0)), i1 = Math.min(ny, Math.ceil(by1));
    const idx = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (inpolygon(j, i, region.px, region.py)) idx.push((i - 1) * nx + (j - 1));
      }
    }
    if (idx.length < 2) continue;

    const axis = idx.length >= MIN_REGION_PIXELS
      ? (axisFor(mode, idx, idx.length, nx, ctx.im, field, region.cx, region.cy) ?? globalAxis)
      : globalAxis;
    const t = quantise(axis, nAngles);
    const ct = Math.cos(t), st = Math.sin(t);

    // project onto the axis, about the CLIPPED cell's centroid
    const u = new Float64Array(idx.length);
    const K = new Float64Array(idx.length);
    for (let m = 0; m < idx.length; m++) {
      const c = idx[m];
      const dx = (c % nx) + 1 - region.cx;
      const dy = Math.floor(c / nx) + 1 - region.cy;
      u[m] = dx * ct + dy * st;
      K[m] = 1 - Math.min(1, Math.max(0, ctx.im.data[c]));
    }

    const offsets = stripeOffsets(u, K, Lmin, Lmax, binPx);
    if (offsets.length === 0) continue;

    // each stripe is a full line perpendicular to the axis, trimmed to the cell
    const reach = Math.hypot(bx1 - bx0, by1 - by0);
    const segs = [];
    for (const off of offsets) {
      const mx = region.cx + off * ct, my = region.cy + off * st;
      segs.push([mx + reach * st, my - reach * ct, mx - reach * st, my + reach * ct]);
    }
    for (const s of trimLineSegsToPolygon(segs, region.px, region.py)) {
      out.push([[s[0], s[1]], [s[2], s[3]]]);
    }
  }
  return out;
}

export default { id, label, params, run, targetImage };
