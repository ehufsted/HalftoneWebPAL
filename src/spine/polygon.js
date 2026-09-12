// Polygon helpers.
// Ports of polyCentroid.m, polygonIntersectFn.m and subdividePolyFn.m,
// plus polyarea (shoelace) and the 2-D principal axis.

import { intersectLine } from './geometry.js';

export function polyPerimeter(px, py) {
  let p = 0;
  const n = px.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(px[j] - px[i], py[j] - py[i]);
  }
  return p;
}

/**
 * Axis-aligned bounding box.
 *
 * Lives here rather than with the tilers that lay grids inside it, because the
 * point placers want it too -- `perimeterPoints` walks the box to space a ring
 * round the polygon. Keeping it in `regions.js` would have made `points.js`
 * import from the module that imports it.
 */
export function boundsOfPolygon(px, py) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < px.length; i++) {
    if (px[i] < x0) x0 = px[i];
    if (px[i] > x1) x1 = px[i];
    if (py[i] < y0) y0 = py[i];
    if (py[i] > y1) y1 = py[i];
  }
  return { x0, y0, x1, y1 };
}

/** polyarea, shoelace, unsigned. */
export function polyArea(px, py) {
  let a = 0;
  const n = px.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += px[i] * py[j] - px[j] * py[i];
  }
  return Math.abs(a) / 2;
}

/** polyCentroid.m -- the true centroid, not the vertex average. */
export function polyCentroid(px, py) {
  const n = px.length;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = px[i] * py[j] - px[j] * py[i];
    a += cross;
    cx += (px[i] + px[j]) * cross;
    cy += (py[i] + py[j]) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-12) {                 // degenerate: fall back to the mean
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += px[i]; my += py[i]; }
    return [mx / n, my / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * polygonIntersectFn.m -- where a segment crosses a polygon's edges.
 * The MATLAB's header admits "has problems with intersections at vertices";
 * here a crossing landing exactly on a vertex is attributed to the edge that
 * *starts* at it, consistently, rather than being decided by an epsilon.
 * @returns {Array<{x:number,y:number,edge:number}>} in edge order
 */
function polygonIntersect(px, py, lx, ly) {
  const n = px.length;
  const hits = [];
  const line2 = [lx[0], ly[0], lx[1], ly[1]];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = intersectLine([px[i], py[i], px[j], py[j]], line2);
    if (!p) continue;
    // a hit exactly on the end vertex belongs to the next edge, not this one
    if (Math.hypot(p[0] - px[j], p[1] - py[j]) < 1e-9) continue;
    hits.push({ x: p[0], y: p[1], edge: i });
  }
  return hits;
}

/**
 * subdividePolyFn.m -- cut a convex polygon with a line through (x0,y0) at
 * angle t, returning the two halves and the cut segment.
 *
 * Assumes exactly two crossings, i.e. a convex polygon. That holds throughout
 * this method: cutting a convex polygon with a straight line yields convex
 * children, and both region dividers produce convex cells.
 *
 * @returns {{A:{px,py}, B:{px,py}, seg:[[number,number],[number,number]]}|null}
 */
export function subdividePoly(px, py, x0, y0, t, L) {
  const lx = [x0 - L * Math.cos(t), x0 + L * Math.cos(t)];
  const ly = [y0 - L * Math.sin(t), y0 + L * Math.sin(t)];
  const hits = polygonIntersect(px, py, lx, ly);
  if (hits.length !== 2) return null;

  const [h1, h2] = hits[0].edge <= hits[1].edge ? hits : [hits[1], hits[0]];
  const i1 = h1.edge, i2 = h2.edge;
  if (i1 === i2) return null;

  // A: vertices 0..i1, the two crossings, then i2+1..end
  const apx = [], apy = [];
  for (let i = 0; i <= i1; i++) { apx.push(px[i]); apy.push(py[i]); }
  apx.push(h1.x, h2.x); apy.push(h1.y, h2.y);
  for (let i = i2 + 1; i < px.length; i++) { apx.push(px[i]); apy.push(py[i]); }

  // B: the two crossings reversed, then i1+1..i2
  const bpx = [h2.x, h1.x], bpy = [h2.y, h1.y];
  for (let i = i1 + 1; i <= i2; i++) { bpx.push(px[i]); bpy.push(py[i]); }

  if (apx.length < 3 || bpx.length < 3) return null;
  return {
    A: { px: apx, py: apy },
    B: { px: bpx, py: bpy },
    seg: [[h1.x, h1.y], [h2.x, h2.y]],
  };
}

/**
 * Angle of maximum variance of a point cloud.
 *
 * The MATLAB reaches for `svd`; in two dimensions this is the closed-form
 * eigenvector of the 2x2 covariance, the same formula as the structure tensor.
 * This is the LONG axis; callers cut perpendicular to it, which is what makes the
 * pieces roughly square.
 */
export function principalAxis(xs, ys, count) {
  let mx = 0, my = 0;
  for (let i = 0; i < count; i++) { mx += xs[i]; my += ys[i]; }
  mx /= count; my /= count;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

/**
 * Sutherland-Hodgman: clip a polygon against a CONVEX one.
 *
 * Added for the region tilers, which lay a lattice over the drawing's bounding
 * box and then cut every tile to the drawing polygon. The clip polygon must be
 * convex -- the algorithm works by intersecting the subject with each clip edge's
 * half-plane in turn, which is only the polygon itself when the halfplanes'
 * intersection is. `fullPolygon` is a rectangle, and `isConvex` is there to
 * check anything else.
 *
 * The subject need not be convex, but every caller here passes a lattice cell,
 * and the result of clipping a convex subject stays convex -- which matters,
 * because `subdividePoly` and `principalAxis` downstream assume it.
 *
 * Winding is derived from the clip polygon's signed area rather than assumed, so
 * a tiler may emit its cells in either direction.
 *
 * @returns {{px:number[], py:number[]}|null} null if nothing survives
 */
export function clipConvex(spx, spy, cpx, cpy) {
  let a2 = 0;
  for (let i = 0; i < cpx.length; i++) {
    const j = (i + 1) % cpx.length;
    a2 += cpx[i] * cpy[j] - cpx[j] * cpy[i];
  }
  const s = a2 >= 0 ? 1 : -1;

  let cur = { px: Array.from(spx), py: Array.from(spy) };
  for (let i = 0; i < cpx.length; i++) {
    const j = (i + 1) % cpx.length;
    const ex = cpx[j] - cpx[i], ey = cpy[j] - cpy[i];
    // inward normal: for a counter-clockwise ring the interior is left of the
    // edge, and left of (ex,ey) is (-ey,ex). `s` flips it for the other winding.
    cur = clipHalfPlane(cur.px, cur.py, cpx[i], cpy[i], -s * ey, s * ex);
    if (!cur) return null;
  }
  return cur;
}

/**
 * Clip a polygon to one half-plane: keep the side where (p - a)·n >= 0.
 *
 * The primitive `clipConvex` is built from, and the one the Voronoi tiler needs
 * directly. A Voronoi cell is the drawing polygon cut by the perpendicular
 * bisector against every other seed, so with this in hand there is no need for a
 * Delaunay triangulation at all -- which is the whole reason the tessellation
 * fits in this app without a geometry library.
 *
 * For seeds si and sj the cell of si keeps |p-si|^2 <= |p-sj|^2, which rearranges
 * to (p - m)·(si - sj) >= 0 with m the midpoint. So `a` is the midpoint and `n`
 * is si - sj; no normalisation needed, since only the sign is read.
 *
 * @param {number} ax,ay  a point on the boundary line
 * @param {number} nx,ny  normal pointing into the half-plane to KEEP
 * @returns {{px:number[], py:number[]}|null} null if nothing survives
 */
export function clipHalfPlane(px, py, ax, ay, nx, ny) {
  const EPS = 1e-9;
  const n = px.length;
  if (n === 0) return null;
  const ox = [], oy = [];
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const d1 = nx * (px[k] - ax) + ny * (py[k] - ay);
    const d2 = nx * (px[k2] - ax) + ny * (py[k2] - ay);
    if (d1 >= -EPS) { ox.push(px[k]); oy.push(py[k]); }
    if ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) {
      const t = d1 / (d1 - d2);
      ox.push(px[k] + t * (px[k2] - px[k]));
      oy.push(py[k] + t * (py[k2] - py[k]));
    }
  }
  return ox.length >= 3 ? { px: ox, py: oy } : null;
}
