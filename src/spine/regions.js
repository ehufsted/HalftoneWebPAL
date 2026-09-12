// Dividing the drawing into sub-regions.
//
// Several methods in the collection are "do X independently in each region":
// regionsPlaneWaveInPolygon is the first ported, regionsSpiralsInPolygon and
// regionsTriangleStripes want the same thing. So the divider is a separate
// concern with one interface, rather than something each method rolls.
//
// A tiler returns CONVEX polygons that partition the drawing polygon. Convexity
// is load-bearing downstream -- subdividePoly and principalAxis both assume it,
// and clipping a convex cell against a convex drawing polygon keeps it. So a
// future non-convex divider is a change here AND at those call sites, not a
// drop-in.
//
// Seams between regions are intended, at least for plane waves: each region works
// from its own phase origin, so stripes do not line up across a boundary and the
// lattice reads as a visible grid. Making stripes continuous across regions is a
// genuinely harder problem, and what `stripesFromTrisFn` exists to solve — so the
// seams are not a defect to be smoothed away here.
//
// The point placers this builds on are in points.js and the relaxation they share
// is in relax.js. Two of the five tilers place points; the other three are
// lattices and touch neither.

import { clipConvex, clipHalfPlane, polyArea, boundsOfPolygon } from './polygon.js';
import { mulberry32 } from './random.js';
import { edgeStrength } from './field.js';
import { triangulate } from './delaunay.js';
import { stipplePoints, perimeterPoints } from './points.js';

/**
 * Cell area is the size contract, not the cell's width.
 *
 * A square of side a and a hexagon of circumradius R have the same area when
 * R = a/sqrt(3*sqrt(3)/2) = a/1.6120. Matching on area rather than on width
 * means switching lattice keeps roughly the same number of regions, so the
 * control means the same thing in both -- which it would not if `size` were a
 * diameter, since a hexagon is 15% wider than the square of equal area.
 */
const HEX_R_PER_SIDE = 1 / Math.sqrt((3 * Math.sqrt(3)) / 2);

/**
 * Side of the equilateral triangle whose area is `size^2`, for the same reason:
 * area sqrt(3)/4 * s^2 = a^2 gives s = 2a/3^(1/4) = 1.5197a. Without it the
 * trilattice would return 2.3x as many regions as rect at the same slider
 * setting, since a triangle of side a has only 0.43 a^2 of area.
 */
export const TRI_SIDE_PER_AREA = 2 / Math.pow(3, 0.25);

/**
 * Square cells of side `side`, laid from the polygon's top-left corner.
 *
 * Cells keep their exact size and the lattice runs past the far edge, where the
 * clip cuts partial cells. Stretching cells to fit a whole number across instead
 * makes the two axes disagree and, for hex, cannot be done without distorting the
 * cell. Partial border cells are the caller's problem — see the small-region note
 * in planeWaves.
 */
function rectCells(bounds, side) {
  const { x0, y0, x1, y1 } = bounds;
  const out = [];
  for (let y = y0; y < y1; y += side) {
    for (let x = x0; x < x1; x += side) {
      out.push({
        px: [x, x + side, x + side, x],
        py: [y, y, y + side, y + side],
      });
    }
  }
  return out;
}

/**
 * Pointy-top hexagons of circumradius R: width sqrt(3)R, height 2R, columns
 * sqrt(3)R apart and rows 1.5R apart with every other row offset by half a
 * column. Vertices at 90 + 60k degrees.
 */
function hexCells(bounds, R) {
  const { x0, y0, x1, y1 } = bounds;
  const hStep = Math.sqrt(3) * R;
  const vStep = 1.5 * R;
  const out = [];
  const verts = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 3;
    verts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  for (let row = 0, cy = y0; cy - R < y1; row++, cy = y0 + row * vStep) {
    const off = (row & 1) ? hStep / 2 : 0;
    for (let cx = x0 - off; cx - hStep / 2 < x1; cx += hStep) {
      out.push({
        px: verts.map((v) => cx + v[0]),
        py: verts.map((v) => cy + v[1]),
      });
    }
  }
  return out;
}

/**
 * Voronoi cells as polygons, by half-plane clipping -- no Delaunay needed.
 *
 * Each cell starts as the drawing polygon and is cut by the bisector against
 * every other seed. That is O(n^2) in the worst case, but a cell stops being
 * cuttable once every one of its vertices is nearer to its own seed than half
 * the distance to the next candidate, so with the candidates sorted by distance
 * the loop breaks early and the real cost is close to linear.
 */
export function voronoiCells(ctx, sx, sy, n) {
  const { px, py } = ctx.polygon;
  const out = [];
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let cell = { px: Array.from(px), py: Array.from(py) };
    for (let k = 0; k < n; k++) order[k] = k;
    const di = new Float64Array(n);
    for (let k = 0; k < n; k++) di[k] = Math.hypot(sx[k] - sx[i], sy[k] - sy[i]);
    const sorted = Array.from(order).filter((k) => k !== i).sort((a, b) => di[a] - di[b]);
    for (const j of sorted) {
      // every vertex within maxR of the seed; the bisector sits at di/2
      let maxR = 0;
      for (let v = 0; v < cell.px.length; v++) {
        const r = Math.hypot(cell.px[v] - sx[i], cell.py[v] - sy[i]);
        if (r > maxR) maxR = r;
      }
      if (di[j] / 2 > maxR) break;                // and all later j are further
      const next = clipHalfPlane(
        cell.px, cell.py,
        (sx[i] + sx[j]) / 2, (sy[i] + sy[j]) / 2,
        sx[i] - sx[j], sy[i] - sy[j],
      );
      if (!next) { cell = null; break; }
      cell = next;
    }
    out.push(cell);
  }
  return out;
}

/**
 * All distinct cell boundaries, for the "draw region outline" option.
 *
 * Deduped, because neighbouring cells share an edge and emitting every ring would
 * send the pen down every interior boundary twice, doubling its ink and travel.
 * Endpoints are rounded to a grid before keying so two cells that computed the
 * same vertex by different routes still match.
 */
export function regionEdges(cells, opts = {}) {
  const seen = new Set();
  const out = [];
  const q = (v) => Math.round(v * 1e6) / 1e6;

  // Skipping the page border matters for tone. Cells are clipped to the drawing
  // polygon, so part of every outer cell's ring IS the polygon boundary — a clip
  // artefact, not a cell boundary. Measured, it was worth 596 px of ink on a
  // 150 px canvas, 0.040 of coverage: enough to put the Voronoi length 7-10% over
  // its closed form, drag the Delaunay/Voronoi ratio from sqrt3 to 1.56, and
  // drive the fitted overlap constant to -12. Any caller whose tone model counts
  // the network's length must skip it.
  const clip = opts.skipBoundary ?? null;
  const onBoundary = (ax, ay, bx, by) => {
    if (!clip) return false;
    const { px, py } = clip;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const EPS = 1e-6;
    for (let i = 0; i < px.length; i++) {
      const j = (i + 1) % px.length;
      const ex = px[j] - px[i], ey = py[j] - py[i];
      const len2 = ex * ex + ey * ey;
      if (len2 <= 0) continue;
      // the whole segment must lie on this polygon edge: test both endpoints
      // and the midpoint, so an edge merely TOUCHING the border at one vertex
      // is kept
      let onIt = true;
      for (const [x, y] of [[ax, ay], [bx, by], [mx, my]]) {
        const t = ((x - px[i]) * ex + (y - py[i]) * ey) / len2;
        if (t < -EPS || t > 1 + EPS) { onIt = false; break; }
        const cx = px[i] + ex * t, cy = py[i] + ey * t;
        if (Math.hypot(x - cx, y - cy) > 1e-6) { onIt = false; break; }
      }
      if (onIt) return true;
    }
    return false;
  };

  for (const cell of cells) {
    const n = cell.px.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (onBoundary(cell.px[i], cell.py[i], cell.px[j], cell.py[j])) continue;
      const a = [q(cell.px[i]), q(cell.py[i])];
      const b = [q(cell.px[j]), q(cell.py[j])];
      const key = (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]))
        ? `${a[0]},${a[1]}|${b[0]},${b[1]}`
        : `${b[0]},${b[1]}|${a[0]},${a[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([[cell.px[i], cell.py[i]], [cell.px[j], cell.py[j]]]);
    }
  }
  return out;
}

/**
 * Tile the drawing polygon.
 *
 * @param {{polygon:{px:number[],py:number[]}}} ctx
 * @param {object} opts
 * @param {'rect'|'hex'|'voronoi'} [opts.kind]  lattice
 * @param {number} opts.sizePx        sqrt of the cell AREA, in pixels. For
 *        voronoi this sets the cell COUNT (polygon area / sizePx^2) and so means
 *        the MEAN cell size -- capacity-balanced cells are deliberately unequal
 *        in area. One control, same meaning, all three lattices.
 * @param {number} [opts.seed]        voronoi only
 * @param {number} [opts.iterations]  voronoi only
 * @returns {Array<{px:number[], py:number[], cx:number, cy:number, area:number}>}
 *          cells clipped to the polygon, each with its centroid and area.
 *          Cells that fall entirely outside are dropped.
 */
/** Triangles as polygon cells, carrying the face index so a caller can reach
 *  back into the adjacency. Shared by the two mesh tilers. */
function trisAsCells(tris, nT, sx, sy) {
  const raw = [];
  for (let t = 0; t < nT; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    raw.push({ px: [sx[a], sx[b], sx[c]], py: [sy[a], sy[b], sy[c]], tri: t });
  }
  return raw;
}

/** Face adjacency across shared edges, in the slot order of the opposite vertex
 *  -- the convention `triangulate` returns, so both tilers hand back the same
 *  shape and nothing downstream has to ask which tiler it came from. */
function neighboursOf(tris, nT) {
  const nbr = new Int32Array(3 * nT).fill(-1);
  const seen = new Map();
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      // slot k is the edge OPPOSITE vertex k
      const a = tris[3 * t + (k + 1) % 3], b = tris[3 * t + (k + 2) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const prev = seen.get(key);
      if (prev === undefined) { seen.set(key, 3 * t + k); continue; }
      nbr[3 * t + k] = (prev / 3) | 0;
      nbr[prev] = t;
    }
  }
  return nbr;
}

export function tileRegions(ctx, opts = {}) {
  const { px, py } = ctx.polygon;
  const kind = opts.kind ?? 'rect';
  const size = Math.max(1, opts.sizePx ?? 20);
  const bounds = boundsOfPolygon(px, py);

  let raw;
  let adjacency = null;
  if (kind === 'voronoi') {
    const nCells = Math.max(1, Math.round(polyArea(px, py) / (size * size)));
    // Equal ink per cell, so point density is proportional to darkness: the
    // subdivider sets counts from mass directly, so the field is the density.
    //
    // The floor is required, not optional. stipplePoints emits no point where
    // the field is zero, which is right for a stipple and wrong for a tiler: a
    // white region would come back with no cells and the polygon would not be
    // partitioned.
    const dark = new Float64Array(ctx.nx * ctx.ny);
    for (let i = 0; i < dark.length; i++) {
      dark[i] = (1 - Math.min(1, Math.max(0, ctx.im.data[i]))) + 1e-3;
    }
    const { sx, sy } = stipplePoints(ctx, {
      ...opts, field: dark, count: nCells,
    });
    raw = voronoiCells(ctx, sx, sy, sx.length).filter(Boolean);
  } else if (kind === 'delaunay') {
    // The slider means seed count here, not cell area: by Euler a triangulation
    // of n points has about 2n triangles, so regions come out roughly half the
    // size the same slider gives the other tilers. The seeds are the thing being
    // placed and the triangles fall out of them.
    const nInterior = Math.max(1, Math.round(polyArea(px, py) / (size * size)));
    // Seeds are drawn to the image's edges rather than its dark areas, which is
    // what makes the mesh line up with the picture: vertices land in the two rows
    // flanking an edge (see edgeStrength on LoG versus |grad|), so a
    // triangulation edge runs along it. A uniform floor is mixed in because a
    // pure edge field puts no seeds in flat areas, and plane waves needs regions
    // small enough there for its 1-D projection to hold.
    const edge = edgeStrength(ctx.im, Math.max(1, opts.edgeSigma ?? 2));
    const mix = Math.min(1, Math.max(0, opts.edgeMix ?? 0.75));
    const field = new Float64Array(edge.length);
    for (let i = 0; i < field.length; i++) field[i] = (1 - mix) + mix * edge[i];

    // The ring is built from the same field and count as the interior, so its
    // spacing tracks the interior's wherever the two meet: dense where a picture
    // edge runs into the border, sparse where the border crosses flat paper.
    const ring = perimeterPoints(ctx, field, nInterior);
    const { sx, sy } = stipplePoints(ctx, {
      ...opts, field, count: nInterior, seeds0: ring,
    });
    const { tris, nbr, n: nT } = triangulate(sx, sy);
    adjacency = { tris, nbr, nT, sx, sy };
    raw = trisAsCells(tris, nT, sx, sy);
  } else if (kind === 'trilattice') {
    // A regular EQUILATERAL triangular lattice, rather than a square grid cut
    // along a diagonal: right isoceles cells give edges in only three directions,
    // two axis-aligned and the third √2 longer, and since stripe crossings are
    // placed on edges that anisotropy shows as a preferred stripe direction in
    // flat areas — exactly where a lattice is chosen for its evenness.
    //
    // Vertices are shared by construction, by indexing a grid. The ordering is
    // load-bearing: jittering before sharing would tear every triangle apart and
    // break the shared-midpoint invariant triStripes rests on.
    //
    // Side chosen so one triangle has area size^2, keeping the slider's meaning
    // the same as for rect and hex: it sets cell area, not cell width.
    const side = size * TRI_SIDE_PER_AREA;
    const rowPitch = side * Math.sqrt(3) / 2;
    // Two cells of margin on every side; one is not enough. The lattice's left
    // and right boundaries are sawtooth, since odd rows start half a side in from
    // even ones, so the deepest notch reaches a full side past the row start. At
    // one cell of margin that notch lands exactly on bounds.x0 with zero
    // clearance and the default jitter opens a sliver of uncovered polygon
    // (measured as a -0.0003 area deficit at sizePx 20). Surplus triangles clip
    // away to nothing, so the margin is free.
    const MARGIN = 2;
    const nCols = Math.ceil((bounds.x1 - bounds.x0) / side) + 2 * MARGIN + 1;
    const nRows = Math.ceil((bounds.y1 - bounds.y0) / rowPitch) + 2 * MARGIN + 1;
    const x0 = bounds.x0 - MARGIN * side, y0 = bounds.y0 - MARGIN * rowPitch;
    const nV = (nCols + 1) * (nRows + 1);
    const sx = new Float64Array(nV), sy = new Float64Array(nV);
    const rnd = mulberry32(opts.seed ?? 1);
    // Capped at a quarter of a side so no triangle can invert. Each vertex moves
    // at most j*sqrt(2), so two can close by 2*j*sqrt(2), and a vertex has to
    // cross the opposite edge — a height sqrt(3)/2 = 0.866 away — to flip. At
    // j = 0.25 the worst case is 0.707 and the winding is safe; by j = 0.31 it is
    // not, and an inverted face silently reverses its faceSign and breaks curl
    // conservation for its three edges.
    const jitter = Math.min(0.25, Math.max(0, opts.jitter ?? 0.15)) * side;
    const vid = (i, j) => j * (nCols + 1) + i;
    for (let j = 0; j <= nRows; j++) {
      for (let i = 0; i <= nCols; i++) {
        const k = vid(i, j);
        sx[k] = x0 + i * side + (j & 1 ? side / 2 : 0) + (rnd() - 0.5) * 2 * jitter;
        sy[k] = y0 + j * rowPitch + (rnd() - 0.5) * 2 * jitter;
      }
    }
    // Two triangles per cell, wound the same way so a shared edge is traversed
    // oppositely by its two faces -- the incidence buildMesh depends on.
    const tris = [];
    for (let j = 0; j < nRows; j++) {
      const o = j & 1;                       // this row's half-step offset
      for (let i = 0; i + o < nCols; i++) {
        tris.push(vid(i, j), vid(i + 1, j), vid(i + o, j + 1));
        tris.push(vid(i + 1, j), vid(i + o + 1, j + 1), vid(i + o, j + 1));
      }
    }
    const t32 = Int32Array.from(tris);
    const nT = t32.length / 3;
    adjacency = { tris: t32, nbr: neighboursOf(t32, nT), nT, sx, sy };
    raw = trisAsCells(t32, nT, sx, sy);
  } else if (kind === 'hex') {
    raw = hexCells(bounds, size * HEX_R_PER_SIDE);
  } else {
    raw = rectCells(bounds, size);
  }

  const out = [];
  for (const cell of raw) {
    const clipped = clipConvex(cell.px, cell.py, px, py);
    if (!clipped) continue;
    // shoelace centroid and area, from the CLIPPED cell -- a border cell's
    // centre is not its lattice centre, and the orientation fit is taken about
    // this point
    let a2 = 0, cx = 0, cy = 0;
    const n = clipped.px.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const cross = clipped.px[i] * clipped.py[j] - clipped.px[j] * clipped.py[i];
      a2 += cross;
      cx += (clipped.px[i] + clipped.px[j]) * cross;
      cy += (clipped.py[i] + clipped.py[j]) * cross;
    }
    const area = Math.abs(a2) / 2;
    if (!(area > 1e-9)) continue;
    out.push({
      px: clipped.px,
      py: clipped.py,
      cx: cx / (3 * a2),
      cy: cy / (3 * a2),
      area,
      // triangle index, so a caller can reach the adjacency below. Undefined for
      // the lattice tilers, which have no adjacency to carry.
      tri: cell.tri,
    });
  }
  // Adjacency rides along on the array rather than changing the return type:
  // every caller wants a plain list of polygons and only the stripe methods want
  // the mesh. out.adjacency is {tris, nbr, nT}.
  if (adjacency) out.adjacency = adjacency;
  return out;
}
