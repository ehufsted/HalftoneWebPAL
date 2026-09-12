// Port of singleWidthLines/code/regionsLappingShapes.m
// Header: "calibrated" -- and unusually, without qualification. See below.
//
// Overlapping scales. A shape is grown at the most "central" unclaimed pixel,
// claims everything it covers, and the next one grows in what is left; because
// each shape can only take unclaimed ground, every shape is occluded by the ones
// before it, and drawing only the visible part of each rim gives the lapping.
//
// The radius choice is what earns "calibrated". Minimising |1 - P/A - B/A| over
// candidate radii, where A is the newly claimed area, B the brightness summed
// over it, and P the area of the rim annulus, rearranges to A - P = B; and since
// A - B is the summed darkness of the region while P is the ink the outline will
// lay, the condition is exactly
//
//     ink laid = darkness owed
//
// shape by shape, with no constant and nothing fitted. Every other tone model in
// this app is a law with a measured coefficient; this one is an identity.
//
// The port measures the ink rather than estimating it. The annulus area is a
// stand-in for the length of the visible rim, and the two agree exactly for a
// shape standing alone — for a square of size r inset by w/2, both come to
// 12r - 9 at w = 1.5. They part company once an earlier shape cuts into the
// annulus at some radii but not others, which in a dense drawing is most shapes.
// So the annulus picks a starting radius and a short search around it scores
// candidates on the visible outline itself.
//
// The band follows from the same algebra. An isolated shape of size r has
// coverage perimeter*w/area = C*w/r, with C = 2 for a circle or a square and
// 2*sqrt(2) for a diamond. Both ends are that expression at the two size limits:
// the smallest shape sets the darkest tone, the largest the lightest, and white
// is not reachable because there is always an outline somewhere.
//
// A shape's rim is traced only where it borders later shapes and unclaimed
// ground, never where an earlier shape overlaps it, because that shape has
// already drawn its own rim there. Every shape here is a LEVEL SET of its own
// distance field, so the outline is walked directly — exactly round for a circle,
// exactly straight for a square — and the visible part found by asking who owns
// each point, rather than by contouring or by analytic occlusion tests.
//
// Arc sections and petals (the source's metrics 5 and 6) are not ported: they
// measure distance in polar coordinates about the image centre, which makes them
// the only two that depend on where the drawing is rather than what is in it.
//
// Blobs (metric 7) are not ported either. They replace the analytic distance with
// a geodesic one from grayDist, and geodesic distance is not displacement: a
// distance field satisfies |grad R| = cost, so a geodesic annulus of width w is
// only w/cost pixels wide, its area is L*w/cost rather than L*w, and an inset of
// w/2 in level units moves w/(2*cost) px. Correcting all of those still leaves
// the level sets themselves faceted by grayDist's 16-neighbourhood at exactly the
// scale a pen stroke resolves. A smooth outline needs a smooth distance field,
// which is a different solver.

import { regionMask } from '../spine/mask.js';
import { affineTarget } from '../spine/tone.js';
import { clipPolyline } from '../spine/geometry.js';
import { structureTensorField } from '../spine/field.js';
import { mulberry32 } from '../spine/random.js';
import { SAGITTA } from '../spine/dots.js';

export const id = 'lappingShapes';
export const label = 'Lapping shapes';

/**
 * Perimeter of a shape of size r, over r. Circle 2*pi; square of half-width r
 * has four sides of 2r, so 8; diamond four sides of r*sqrt(2), so 4*sqrt(2).
 */
export const PERIM_C = {
  circle: 2 * Math.PI,
  square: 8,
  diamond: 4 * Math.SQRT2,
  angled: 8,
};

/**
 * |grad m| for each metric: how much metric distance one pixel of GEOMETRY buys.
 *
 * The rim is a metric band and the pen covers a geometric one. The band
 * `r <= m < r + d` has geometric width `d / |grad m|`, so covering a strip one
 * pen wide needs a band of `w * |grad m|` in metric units. Chebyshev (square,
 * angled) has |grad m| = 1 on a face and Euclidean (circle) has it everywhere, so
 * `d = w` is right for those. The diamond is L1: its faces have normal
 * (1,1)/sqrt2, so |grad m| = sqrt2 and a band of metric width w is only w/sqrt2
 * of paper.
 *
 * Without the correction, the ratio of rim area laid to darkness owed measures
 * circle 1.033, angled 0.998, square 0.937 — and diamond 0.867, the only one
 * outside what the quarter-pen radius ladder can explain. The tell is that the
 * error is shape-dependent, where a quantisation error would fall on all four
 * alike.
 */
export const METRIC_GRAD = {
  circle: 1,
  square: 1,
  diamond: Math.SQRT2,
  angled: 1,
};

/** Area of a shape of size r, over r^2. */
export const AREA_C = {
  circle: Math.PI,
  square: 4,
  diamond: 2,
  angled: 4,
};

/**
 * Coverage of an isolated shape, times r/w -- which is what sets the reachable
 * band. Ink is perimeter*w and area is AREA_C*r^2, so coverage is
 * (PERIM_C/AREA_C) * w/r.
 *
 * Derived from the other two rather than written out, because the two constants
 * are easy to confuse and confusing them is silent: used as a perimeter, this one
 * understates a circle's outline by a factor of pi, making a correctly occluded
 * drawing look as though nothing had been occluded at all.
 */
export const SHAPE_C = Object.fromEntries(
  Object.keys(PERIM_C).map((k) => [k, PERIM_C[k] / AREA_C[k]]),
);

/** Candidate radii step, as a fraction of the pen width. The source uses 0.25. */
const R_STEP = 0.25;

/** Spacing of outline samples, in pixels. Sub-pixel: see outlinePoints. */
const OUTLINE_STEP = 0.5;

/**
 * Subsamples per pixel edge when measuring the rim area.
 *
 * The annulus is an AREA and a count of pixel centres is not one -- at r = 2.5
 * and w = 1.5 a square annulus is 21 px^2 while 24 pixel centres fall inside it.
 * The identity then balances against ink that never gets laid, and the drawing
 * comes out light exactly where the shapes are smallest. The adaptive window is
 * what makes three-by-three affordable.
 */
const SS = 3;

/** Radii either side of the annulus estimate that the outline search tries. */
const REFINE = 4;

export const params = [
  {
    key: 'shapeKind', label: 'Shape', type: 'select', def: 'circle',
    options: [
      { value: 'circle', label: 'Circles' },
      { value: 'square', label: 'Squares' },
      { value: 'diamond', label: 'Diamonds' },
      { value: 'angled', label: 'Angled squares' },
    ],
  },
  { key: 'RminW', label: 'Smallest shape', type: 'range', min: 1, max: 12, step: 0.25, def: 2, unit: '×pen' },
  { key: 'RmaxW', label: 'Largest shape', type: 'range', min: 4, max: 80, step: 1, def: 30, unit: '×pen' },
  {
    key: 'placeOrder', label: 'Lapping order', type: 'select', def: 'centre',
    options: [
      { value: 'centre', label: 'Outward from the centre' },
      { value: 'down', label: 'Downward, like tiles' },
      { value: 'rings', label: 'Square rings' },
      { value: 'random', label: 'Scattered' },
    ],
  },
  // Angled squares only: the other three shapes have no angle to set.
  {
    key: 'angleFrom', label: 'Square angle from', type: 'select', def: 'place',
    options: [
      { value: 'place', label: 'The lapping order' },
      { value: 'image', label: 'The image (structure tensor)' },
    ],
    when: (p) => p.shapeKind === 'angled',
  },
  { key: 'shapeSeed', label: 'Scatter seed', type: 'range', min: 1, max: 999, step: 1, def: 1 },
];

function settingsOf(ctx) {
  const w = ctx.w;
  return {
    w,
    kind: ctx.shapeKind ?? 'circle',
    Rmin: Math.max(w, (ctx.RminW ?? 1) * w),
    Rmax: Math.max(3 * w, (ctx.RmaxW ?? 30) * w),
    order: ctx.placeOrder ?? 'centre',
    angleFrom: ctx.angleFrom ?? 'place',
    seed: Math.round(ctx.shapeSeed ?? 1),
  };
}

export function toneBand(ctx) {
  const { w, kind, Rmin, Rmax } = settingsOf(ctx);
  const C = SHAPE_C[kind] ?? 2;
  // Coverage is C*w/r, so the smallest shape sets the darkest tone and the
  // largest the lightest. At Rmin = w the coverage exceeds 1 and clips, which is
  // why black is reachable only while the smallest shape is about a pen wide.
  return {
    min: Math.max(0, 1 - Math.min(1, (C * w) / Rmin)),
    max: Math.max(0, 1 - (C * w) / Math.max(Rmin, Rmax)),
  };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * The field that decides which unclaimed pixel gets the next shape.
 *
 * This is the composition control: it is the direction the scales lap, and it
 * changes the drawing more than the shape does. The source's default is distance
 * from the image centre, with three alternatives commented out at lines 85-88.
 */
export function placementField(ctx, order, seed) {
  const { nx, ny } = ctx;
  const d = new Float64Array(nx * ny);
  const cx = (nx + 1) / 2, cy = (ny + 1) / 2;
  const rand = mulberry32(seed);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const dx = ix + 1 - cx, dy = iy + 1 - cy;
      let v;
      if (order === 'down') v = iy;
      else if (order === 'rings') v = Math.max(Math.abs(dx), Math.abs(dy));
      else if (order === 'random') v = rand();
      else v = Math.hypot(dx, dy);
      d[iy * nx + ix] = v;
    }
  }
  return d;
}

/** Distance in the shape's own metric. Floats: the binning samples between centres. */
function metricAt(kind, px, py, ang, fx, fy) {
  const dx = fx - px, dy = fy - py;
  if (kind === 'square') return Math.max(Math.abs(dx), Math.abs(dy));
  if (kind === 'diamond') return Math.abs(dx) + Math.abs(dy);
  if (kind === 'angled') {
    const c = Math.cos(ang), s = Math.sin(ang);
    return Math.max(Math.abs(dx * c - dy * s), Math.abs(dx * s + dy * c));
  }
  return Math.hypot(dx, dy);
}

/**
 * The shape's outline as a dense closed polyline of size rD.
 *
 * Sampled sub-pixel: the visibility test can only cut the outline where it has a
 * sample, so a visible arc shorter than the step is missed entirely — and in dark
 * areas, where a shape is a couple of pixels across and mostly overlapped, that
 * is most of the rim.
 */
function outlinePoints(kind, x, y, rD, ang) {
  const pts = [];
  if (rD <= 0) return pts;
  if (kind === 'circle') {
    const sag = SAGITTA * 1.5;
    const stepA = Math.min(0.35, OUTLINE_STEP / rD,
                           2 * Math.acos(Math.max(-1, 1 - sag / rD)));
    const n = Math.max(12, Math.ceil((2 * Math.PI) / stepA));
    for (let k = 0; k <= n; k++) {
      const a = (2 * Math.PI * k) / n;
      pts.push([x + rD * Math.cos(a), y + rD * Math.sin(a)]);
    }
    return pts;
  }
  const corners = kind === 'diamond'
    ? [[rD, 0], [0, rD], [-rD, 0], [0, -rD]]
    : [[-rD, -rD], [rD, -rD], [rD, rD], [-rD, rD]];
  const c = Math.cos(-ang), s = Math.sin(-ang);
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k], [bx, by] = corners[(k + 1) % 4];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / OUTLINE_STEP));
    for (let t = 0; t < n; t++) {
      const u = t / n;
      const qx = ax + (bx - ax) * u, qy = ay + (by - ay) * u;
      pts.push(kind === 'angled'
        ? [x + qx * c - qy * s, y + qx * s + qy * c]
        : [x + qx, y + qy]);
    }
  }
  pts.push(pts[0].slice());
  return pts;
}

/**
 * Place the shapes, and record who owns what.
 *
 * Two full-image scans per shape are avoided here.
 *
 * Finding the most central unclaimed pixel: sorting every pixel by the placement
 * field once and walking a pointer past the claimed ones does the same total work
 * as a single scan.
 *
 * Choosing the radius, which is otherwise a scan per candidate and about 120 of
 * them per shape: A(r) and B(r) are cumulative in r, so binning the window's
 * pixels by distance once gives every candidate at a stroke.
 */
export function placeShapes(ctx) {
  const { nx, ny } = ctx;
  const { w, kind, Rmin, Rmax, order, angleFrom, seed } = settingsOf(ctx);
  const mask = regionMask(ctx);
  const tgt = targetImage(ctx);

  const own = new Int32Array(nx * ny).fill(0);
  for (let i = 0; i < own.length; i++) if (!mask[i]) own[i] = -1;

  const D0 = placementField(ctx, order, seed);
  const seq = new Int32Array(nx * ny);
  for (let i = 0; i < seq.length; i++) seq[i] = i;
  const sorted = Array.from(seq).sort((a, b) => (D0[a] - D0[b]) || (a - b));

  const field = (kind === 'angled' && angleFrom === 'image')
    ? structureTensorField(ctx.im, Math.max(1, w), Math.max(1.5, w * 2))
    : null;

  const step = w * R_STEP;
  const nBins = Math.max(4, Math.ceil(Rmax / step) + 2);
  const cntBin = new Float64Array(nBins);
  const briBin = new Float64Array(nBins);
  const Acum = new Float64Array(nBins);
  const Bcum = new Float64Array(nBins);

  const shapes = [];
  let ptr = 0;
  for (;;) {
    while (ptr < sorted.length && own[sorted[ptr]] !== 0) ptr++;
    if (ptr >= sorted.length) break;
    const ip = sorted[ptr];
    const px = (ip % nx) + 1, py = Math.floor(ip / nx) + 1;
    const idx = shapes.length + 1;

    // the shape's angle, for the one metric that has one
    let ang = 0;
    if (kind === 'angled') {
      let base;
      if (field) base = field.theta[ip];
      else {
        // gradient of the placement field, as the source does
        const jx = Math.min(nx - 2, Math.max(1, px - 1));
        const jy = Math.min(ny - 2, Math.max(1, py - 1));
        const gx = D0[jy * nx + jx + 1] - D0[jy * nx + jx - 1];
        const gy = D0[(jy + 1) * nx + jx] - D0[(jy - 1) * nx + jx];
        base = Math.atan2(-gy, gx);
      }
      // Turned a quarter turn against the field: squares sit square-on to the
      // lapping direction rather than corner-on, which is the alignment the
      // pattern reads better in.
      ang = Math.PI / 2 - base;
    }

    // ---- the window, grown only if the shape needs it
    //
    // Sizing every window at Rmax charges the smallest shape what the largest one
    // costs, and on any real image most shapes are small, so nearly all the work
    // went on ground the shape was never going to claim.
    let winR = Math.min(Rmax, Math.max(4 * w, 2 * Rmin));
    let j0, j1, i0, i1, bestR = Rmin, bestB = 0;
    for (;;) {
      j0 = Math.max(0, Math.floor(px - 1 - winR));
      j1 = Math.min(nx - 1, Math.ceil(px - 1 + winR));
      i0 = Math.max(0, Math.floor(py - 1 - winR));
      i1 = Math.min(ny - 1, Math.ceil(py - 1 + winR));

      const sw = 1 / (SS * SS);
      cntBin.fill(0); briBin.fill(0);
      for (let iy = i0; iy <= i1; iy++) {
        for (let jx = j0; jx <= j1; jx++) {
          const c = iy * nx + jx;
          if (own[c] !== 0) continue;
          const bri = Math.min(1, Math.max(0, tgt.data[c]));
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const fx = jx + 1 + (sx + 0.5) / SS - 0.5;
              const fy = iy + 1 + (sy + 0.5) / SS - 0.5;
              const d = metricAt(kind, px, py, ang, fx, fy);
              if (!(d <= Rmax)) continue;
              const b = Math.min(nBins - 1, Math.floor(d / step));
              cntBin[b] += sw;
              briBin[b] += bri * sw;
            }
          }
        }
      }

      // ---- a starting radius, from the annulus
      // A band one PEN wide on the paper, which in metric units is w*|grad m|.
      // See METRIC_GRAD: only the diamond's is not 1.
      const wBins = Math.max(1, Math.round((w * METRIC_GRAD[kind]) / step));
      let A = 0, B = 0, best = Infinity, b0 = -1;
      for (let b = 0; b < nBins; b++) {
        A += cntBin[b]; B += briBin[b];
        Acum[b] = A; Bcum[b] = B;
        const r = (b + 1) * step;
        if (r < Rmin || A <= 0) continue;
        const P = A - (b >= wBins ? Acum[b - wBins] : 0);
        const err = Math.abs((A - P - B) / A);
        if (err < best) { best = err; b0 = b; }
      }
      if (b0 < 0) b0 = Math.max(0, Math.round(Rmin / step) - 1);

      // ---- then score candidates on the INK, which is what the identity is about
      //
      // The annulus area equals the rim's ink for a shape standing alone, and
      // parts from it once an earlier shape cuts into the annulus at some radii
      // and not others. Walking the outline and measuring the visible part
      // answers the question directly. `own === 0` is the right test here: at
      // this moment the ground this shape is about to take is exactly the ground
      // nobody holds.
      let bestErr = Infinity;
      for (let b = Math.max(0, b0 - REFINE); b <= Math.min(nBins - 1, b0 + REFINE); b++) {
        const r = (b + 1) * step;
        if (r < Rmin || r > Rmax || Acum[b] <= 0) continue;
        const rD = Math.max(w / 2, r - w / 2);
        let len = 0, prevX = 0, prevY = 0, prevVis = false, first = true;
        for (const [qx, qy] of outlinePoints(kind, px, py, rD, ang)) {
          const jx = Math.round(qx) - 1, iy = Math.round(qy) - 1;
          const vis = jx >= 0 && iy >= 0 && jx < nx && iy < ny && own[iy * nx + jx] === 0;
          if (!first && vis && prevVis) len += Math.hypot(qx - prevX, qy - prevY);
          prevX = qx; prevY = qy; prevVis = vis; first = false;
        }
        const err = Math.abs(len * w - (Acum[b] - Bcum[b])) / Math.max(1, Acum[b]);
        if (err < bestErr) { bestErr = err; bestR = r; bestB = b; }
      }

      // ---- did the shape run into the edge of its window?
      let touches = false;
      if (winR < Rmax) {
        for (let jx = j0; jx <= j1 && !touches; jx++) {
          if (i0 > 0 && metricAt(kind, px, py, ang, jx + 1, i0 + 1) <= bestR) touches = true;
          if (i1 < ny - 1 && metricAt(kind, px, py, ang, jx + 1, i1 + 1) <= bestR) touches = true;
        }
        for (let iy = i0; iy <= i1 && !touches; iy++) {
          if (j0 > 0 && metricAt(kind, px, py, ang, j0 + 1, iy + 1) <= bestR) touches = true;
          if (j1 < nx - 1 && metricAt(kind, px, py, ang, j1 + 1, iy + 1) <= bestR) touches = true;
        }
      }
      if (!touches || winR >= Rmax) break;
      winR = Math.min(Rmax, winR * 2);
    }

    // ---- claim, and record
    for (let iy = i0; iy <= i1; iy++) {
      for (let jx = j0; jx <= j1; jx++) {
        const c = iy * nx + jx;
        if (own[c] !== 0) continue;
        if (metricAt(kind, px, py, ang, jx + 1, iy + 1) <= bestR) own[c] = idx;
      }
    }
    // A shape must always take at least its own seed, or the walk never ends.
    if (own[ip] === 0) own[ip] = idx;
    shapes.push({ x: px, y: py, r: bestR, ang, idx });
  }
  return { shapes, own, w, kind, Rmin, Rmax };
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { px: polyX, py: polyY } = ctx.polygon;
  const built = placeShapes(ctx);
  const { shapes, own, w, kind } = built;

  const out = [];
  for (const shape of shapes) {
    // Drawn at r - w/2, not r. The rim the radius search priced is the annulus
    // [r-w, r], so its centre line is half a pen width inside the claimed
    // boundary; drawing at r would put the stroke half outside the region it was
    // charged for.
    const rD = Math.max(w / 2, shape.r - w / 2);
    let run_ = [];
    for (const [qx, qy] of outlinePoints(kind, shape.x, shape.y, rD, shape.ang)) {
      const jx = Math.round(qx) - 1, iy = Math.round(qy) - 1;
      // Occlusion is only ever by earlier shapes, so the test is `>= idx`, not
      // `=== idx`. Rounding a sample to the nearest pixel can move it up to
      // 0.707 px outward while the outline sits only w/2 inside the boundary, so
      // whenever w < 1.414 the sample lands on a pixel a LATER shape took and an
      // exact match would drop it, leaving gaps in outlines nothing is in front of.
      const inside = jx >= 0 && iy >= 0 && jx < nx && iy < ny
        && own[iy * nx + jx] >= shape.idx;
      if (inside) run_.push([qx, qy]);
      else {
        // A lone visible sample is a dot, not nothing: renderStrokes stamps a
        // one-point path as a disc of radius w/2 and svg.js writes it as a
        // zero-length round-capped path, so keeping it is both legal and right.
        if (run_.length > 0) out.push(run_);
        run_ = [];
      }
    }
    if (run_.length > 0) out.push(run_);
  }

  const clipped = [];
  for (const line of out) for (const piece of clipPolyline(line, polyX, polyY)) clipped.push(piece);
  return clipped;
}

export default { id, label, params, run, targetImage };
