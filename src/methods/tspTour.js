// Port of singleWidthLines/code/TSPviaMST.m and TSPviaSFC.m, plus the local
// improvement the collection only sketches (testRandomTSPopt.m).
//
// TSP art: stipple the image, then join every dot with ONE closed line. The
// drawing is a single pen stroke from start to finish, which is the extreme case
// of what treeEdges and triStripes are each reaching for -- and unlike them it
// needs no continuity machinery at all, because a tour is continuous by
// definition. The whole problem moves into where the dots go and what order they
// are visited in.
//
// The tone model is the same harmonic ladder as everything else, and it falls out
// in two lines. A tour through N points spread over area A at mean spacing
// d = sqrt(A/N) has N edges each about d long, so its length is N*d and its
// length per unit area is 1/d. Coverage is therefore w/d -- the same 1/x law as
// circlePacking's 1/R, eikonalStripes' 1/L and treeEdges' 1/d. Set the point
// DENSITY from the tone and the tour draws the right amount of ink on its own.
//
// The constant in front is not 1 and is not universal, and it bounds the OPTIMAL
// tour only. Beardwood-Halton-Hammersley gives 0.7124 for uniform random points;
// a boustrophedon walk of a hexagonal lattice gives 1.0746, since the
// nearest-neighbour distance there is sqrt(2/sqrt(3)) times d. More regular point
// sets have LONGER optimal tours per point -- a clustered set offers shortcuts a
// lattice does not -- so blue noise sits between the two, measured at about 0.95.
//
// Neither number caps an ARBITRARY tour. A bad tour can be as long as it likes:
// the unimproved MST crawl measures 1.14 to 1.24, which is not a broken tour but
// the textbook approximation ratio of about 1.25. The ceiling applies after
// improvement; before it, the thing to check is the ratio.
//
// Two constructions, both ported. TSPviaMST builds a minimum spanning tree and
// walks it depth first, taking children in angular order about the direction back
// to the parent — that sort is what stops the tour crossing itself. TSPviaSFC
// sorts by position along a Hilbert curve instead. Neither source improves the
// tour afterwards beyond checking whether it beat the input ordering; the
// neighbour-limited 2-opt and Or-opt below are additions, and their cost in tone
// is measured rather than assumed.
//
// NOT PORTED: the maze variant of TSPviaSFC (needs mazeSimple, and sfcCollapse
// already declined the same path for the same reason) and the multi-layer
// overlays of testMultilayerTSP.m, which are a layering feature rather than part
// of the tour model.

import { stipplePoints, placerParam, usesSubdivide, usesRelaxation } from '../spine/points.js';
import { triangulate } from '../spine/delaunay.js';
import { spanningForest } from './treeEdges.js';
import { hilbertIndex } from '../curves/hilbert.js';
import { affineTarget, stripeSpacings } from '../spine/tone.js';
import { clipPolyline } from '../spine/geometry.js';

export const id = 'tspTour';
export const label = 'Travelling-salesman tour';

/**
 * Tour length per unit area is C/d, with C between the two limits above.
 *
 * `A` is the overlap term, in the same form as meshEdges and treeEdges: as d
 * approaches the pen width the tour's own strokes start covering each other, so
 * coverage saturates instead of passing 1. Both are measured in verify.html.
 */
export const TOUR_TONE = { C: 0.9587, A: 0.1415 };

/**
 * Not a fitted parameter, and that is the result rather than a convenience.
 *
 * The two constants above come from two independent measurements. C = 0.9587 is
 * pure geometry -- tour length times mean spacing over area, no rendering in it.
 * A comes from rendered ink: 1/coverage is linear in d, and the straight-line fit
 * gave slope 0.69094 and intercept 0.1476 (RMS residual 0.1048, about 1.5% of the
 * mean, so the coverage law itself holds).
 *
 * The slope determines the PRODUCT kappa*C = 1/(slope*w) = 0.9649. Against the
 * independently measured C = 0.9587 that leaves kappa = 1.006 -- so the ink a
 * tour lays down is accounted for by how long the tour is, to within 0.6%, which
 * is inside the scatter. kappa is therefore 1 exactly and there is nothing left
 * to fit. A future measurement that pushed it away from 1 would mean the two
 * measurements had started disagreeing, which is a real signal; keeping kappa as
 * a free parameter would have hidden it.
 *
 * A = 0.14 is also the SMALLEST overlap term in the app, and it should be:
 * meshEdges measures 0.58 for Voronoi and 1.05 for Delaunay because those
 * networks meet three or more strokes at every vertex, while a tour meets exactly
 * two at every point, which is the least possible.
 */
export const TOUR_KAPPA = 1;

/** Beyond this many points the tour is slower to build than to look at. */
export const MAX_POINTS = 20000;

export const params = [
  {
    key: 'tourKind', label: 'Tour from', type: 'select', def: 'mst',
    options: [
      { value: 'mst', label: 'Spanning tree, walked depth-first' },
      { value: 'hilbert', label: 'Hilbert curve order' },
    ],
  },
  // Point spacing, not stroke spacing -- but they are the same thing here, which
  // is the point of the ladder above. min 1 is the merge floor: at d = w the
  // tour's strokes touch and the area is solid.
  { key: 'dMinW', label: 'Min dot spacing', type: 'range', min: 1, max: 12, step: 0.1, def: 2, unit: '×pen' },
  { key: 'dMaxW', label: 'Max dot spacing', type: 'range', min: 4, max: 120, step: 1, def: 40, unit: '×pen' },
  {
    key: 'improve', label: 'Tour improvement', type: 'select', def: 'both',
    options: [
      { value: 'none', label: 'None (as constructed)' },
      { value: 'two', label: '2-opt only' },
      { value: 'both', label: '2-opt and Or-opt' },
    ],
  },
  { key: 'improvePasses', label: 'Improvement passes', type: 'range', min: 1, max: 12, step: 1, def: 4 },
  // Off is the classic single-stroke TSP drawing. On, the tour breaks wherever an
  // edge runs more than `cutFactor` local spacings, which stops a long chord from
  // inking an area the tone model says should be light -- at the cost of no
  // longer being one stroke.
  { key: 'cutLong', label: 'Cut long edges', type: 'checkbox', def: false },
  { key: 'cutFactor', label: 'Cut long edges over', type: 'range', min: 1, max: 12, step: 0.5, def: 3, unit: '×spacing',
    when: (p) => p.cutLong === true },
  // Both hidden under the subdivision placer: it has no relaxation and no seed.
  { key: 'tourSeed', label: 'Stipple seed', type: 'range', min: 1, max: 999, step: 1, def: 1,
    when: (p) => !usesSubdivide(p) },
  { key: 'stippleIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: usesRelaxation },
  // This method passes no perimeter ring, so the pinned pass never runs under
  // either placer. Hidden rather than removed, so `run` still reads it.
  { key: 'polishIter', label: 'Boundary polish', type: 'range', min: 0, max: 30, step: 1, def: 8, unit: 'iters',
    when: () => false },
  placerParam(),
];

// The spacing here is between POINTS rather than strokes, so the limits are
// named d rather than L -- but they are the shared stripe limits, floor and all.
// The BAND is this method's own: it goes through coverageOf, not w/L.
function spacingsOf(ctx) {
  const { w, Lmin, Lmax } = stripeSpacings(ctx, { minKey: 'dMinW', maxKey: 'dMaxW' });
  return { w, dMin: Lmin, dMax: Lmax };
}

/** Coverage of a tour whose points sit d apart. */
export function coverageOf(w, d, kappa = TOUR_KAPPA) {
  const { C, A } = TOUR_TONE;
  return Math.min(1, (kappa * C * w) / (d + A * w));
}

export function toneBand(ctx) {
  const { w, dMin, dMax } = spacingsOf(ctx);
  return { min: 1 - coverageOf(w, dMin), max: 1 - coverageOf(w, dMax) };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Point spacing per pixel, and from it the point DENSITY the stippler is given.
 *
 * Remapped into the reachable band before inverting, never clamped afterwards:
 * clamping produces a spacing map that disagrees with targetImage exactly where
 * the clamp bites, so the method is scored against a tone it was never asked to
 * draw. See the same note in meshEdges.
 */
export function spacingMap(ctx) {
  const { w } = spacingsOf(ctx);
  const { C, A } = TOUR_TONE;
  const tgt = affineTarget(ctx, toneBand(ctx));
  const d = new Float64Array(tgt.data.length);
  const rho = new Float64Array(tgt.data.length);
  for (let i = 0; i < d.length; i++) {
    const c = Math.min(0.999, Math.max(1e-6, 1 - tgt.data[i]));
    // invert coverage = kappa*C*w/(d + A*w)
    const di = Math.max(w * 0.25, (TOUR_KAPPA * C * w) / c - A * w);
    d[i] = di;
    rho[i] = 1 / (di * di);
  }
  return { d, rho };
}

/**
 * Depth-first crawl of a spanning tree, children taken in angular order.
 *
 * The angular sort is the whole trick and the source states it in one
 * uncommented line (TSPviaMST.m:29-33): order each node's children by their
 * bearing relative to the direction back to the parent, so the walk sweeps
 * consistently round each node instead of jumping across it. Without it the tour
 * is the same length but crosses itself constantly.
 *
 * Iterative rather than recursive: a stipple of several thousand points can
 * produce a tree deep enough to blow the stack, and this has to be safe on any
 * image rather than on the ones tried so far.
 *
 * @param {ArrayLike<number>} edges  FLAT pairs, as spanningForest returns them
 */
export function crawlTree(sx, sy, edges, n, root = 0) {
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(edges.length).fill(-1);
  const to = new Int32Array(edges.length);
  let ne = 0;
  const link = (a, b) => { to[ne] = b; next[ne] = head[a]; head[a] = ne++; };
  for (let e = 0; e + 1 < edges.length; e += 2) {
    link(edges[e], edges[e + 1]);
    link(edges[e + 1], edges[e]);
  }

  const parent = new Int32Array(n).fill(-2);
  const order = [];
  const seen = new Uint8Array(n);
  // BFS once to fix parents, so the angular sort has a direction to sort about
  const q = [root];
  parent[root] = -1; seen[root] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const u = q[qi];
    for (let e = head[u]; e >= 0; e = next[e]) {
      const v = to[e];
      if (seen[v]) continue;
      seen[v] = 1; parent[v] = u; q.push(v);
    }
  }
  // children, sorted by bearing relative to the way back to the parent
  const kids = new Map();
  for (let v = 0; v < n; v++) {
    const p = parent[v];
    if (p >= 0) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(v);
    }
  }
  for (const [p, list] of kids) {
    const back = parent[p] >= 0
      ? Math.atan2(sy[parent[p]] - sy[p], sx[parent[p]] - sx[p])
      : 0;
    const key = (v) => {
      let a = Math.atan2(sy[v] - sy[p], sx[v] - sx[p]) - back;
      a -= 2 * Math.PI * Math.floor(a / (2 * Math.PI));
      return a;
    };
    // index as the tie-break, so the tour is reproducible to the point
    list.sort((u, v) => (key(u) - key(v)) || (u - v));
  }

  const visited = new Uint8Array(n);
  const stack = [root];
  while (stack.length > 0) {
    const u = stack.pop();
    if (visited[u]) continue;
    visited[u] = 1;
    order.push(u);
    const list = kids.get(u);
    if (!list) continue;
    // pushed in reverse so the first child by angle comes off the stack first
    for (let i = list.length - 1; i >= 0; i--) if (!visited[list[i]]) stack.push(list[i]);
  }
  return order;
}

/** Point order along a Hilbert curve covering the point set's bounding box. */
export function hilbertOrder(sx, sy, n) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (sx[i] < x0) x0 = sx[i];
    if (sx[i] > x1) x1 = sx[i];
    if (sy[i] < y0) y0 = sy[i];
    if (sy[i] > y1) y1 = sy[i];
  }
  // One curve cell per point is too coarse -- ties then decide the order and the
  // tour zig-zags inside each cell. Four times as many cells per axis puts the
  // expected occupancy well under one and the ordering is essentially exact.
  let m = 1;
  while ((1 << m) * (1 << m) < 16 * Math.max(1, n)) m++;
  const side = 1 << m;
  const sw = Math.max(1e-9, Math.max(x1 - x0, y1 - y0));
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gx = Math.min(side - 1, Math.floor(((sx[i] - x0) / sw) * (side - 1)));
    const gy = Math.min(side - 1, Math.floor(((sy[i] - y0) / sw) * (side - 1)));
    key[i] = hilbertIndex(side, gx, gy);
  }
  const ord = Array.from({ length: n }, (_, i) => i);
  ord.sort((a, b) => (key[a] - key[b]) || (a - b));
  return ord;
}

/**
 * Neighbour-limited 2-opt and Or-opt on a closed tour.
 *
 * A full 2-opt is O(N^2) per sweep and unusable at a few thousand points, but
 * almost every improving move joins two points that are already close together,
 * so only Delaunay neighbours are considered as new partners. That turns the
 * sweep into O(N) candidate moves with the same result in practice.
 *
 * 2-opt reverses a run and removes crossings. Or-opt lifts a run of one to three
 * points and reinserts it elsewhere, which fixes the other common defect: a
 * small cluster visited as a detour rather than in passing. Neither can lengthen
 * the tour -- every move is applied only on a positive gain -- so the result is
 * monotone and the pass count is a budget rather than a tuning parameter.
 */
export function improveTour(ord, sx, sy, nbrOf, opts = {}) {
  const n = ord.length;
  if (n < 5) return { ord, gain: 0, moves: 0 };
  const useOr = opts.orOpt !== false;
  const passes = Math.max(1, Math.round(opts.passes ?? 4));
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[ord[i]] = i;
  const D = (a, b) => Math.hypot(sx[a] - sx[b], sy[a] - sy[b]);
  const at = (i) => ord[((i % n) + n) % n];

  let gain = 0, moves = 0;
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;

    // ---- 2-opt: replace (a,b) and (c,e) with (a,c) and (b,e), reversing b..c
    for (let i = 0; i < n; i++) {
      const a = at(i), b = at(i + 1);
      const dab = D(a, b);
      for (const c of nbrOf(a)) {
        const j = pos[c];
        if (j === i || j === ((i + 1) % n)) continue;
        const e = at(j + 1);
        if (e === a) continue;
        const delta = dab + D(c, e) - D(a, c) - D(b, e);
        if (!(delta > 1e-9)) continue;
        // reverse the shorter side, so a move is O(min(k, n-k))
        let lo = (i + 1) % n, hi = j;
        let inner = ((hi - lo + n) % n) + 1;
        if (inner > n - inner) { lo = (j + 1) % n; hi = i; inner = n - inner; }
        for (let k = 0; k < inner >> 1; k++) {
          const p = (lo + k) % n, q = ((hi - k) % n + n) % n;
          const t = ord[p]; ord[p] = ord[q]; ord[q] = t;
          pos[ord[p]] = p; pos[ord[q]] = q;
        }
        gain += delta; moves++; improved = true;
        break;
      }
    }

    // ---- Or-opt: lift a run of 1..3 and reinsert it next to a neighbour
    if (useOr) {
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i < n; i++) {
          const p = at(i - 1), s0 = at(i), s1 = at(i + len - 1), q = at(i + len);
          if (p === s1 || q === s0) continue;
          const removed = D(p, s0) + D(s1, q) - D(p, q);
          if (!(removed > 1e-9)) continue;
          let best = 0, bestJ = -1, bestRev = false;
          for (const c of nbrOf(s0)) {
            const j = pos[c];
            // the insertion point must lie outside the run being moved
            const rel = ((j - i) % n + n) % n;
            if (rel < len) continue;
            const e = at(j + 1);
            if (e === s0) continue;
            const dce = D(c, e);
            const fwd = removed - (D(c, s0) + D(s1, e) - dce);
            const rev = removed - (D(c, s1) + D(s0, e) - dce);
            if (fwd > best) { best = fwd; bestJ = j; bestRev = false; }
            if (rev > best) { best = rev; bestJ = j; bestRev = true; }
          }
          if (bestJ < 0) continue;
          // rebuild: cheaper and far easier to get right than in-place splicing,
          // and Or-opt moves are rare enough by this point that it does not show
          const run = [];
          for (let k = 0; k < len; k++) run.push(at(i + k));
          if (bestRev) run.reverse();
          const runSet = new Set(run);
          const rest = [];
          for (let k = 0; k < n; k++) { const v = ord[k]; if (!runSet.has(v)) rest.push(v); }
          const cAt = rest.indexOf(ord[bestJ]);
          rest.splice(cAt + 1, 0, ...run);
          for (let k = 0; k < n; k++) { ord[k] = rest[k]; pos[ord[k]] = k; }
          gain += best; moves++; improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { ord, gain, moves };
}

/** Tour length, closed. */
export function tourLength(ord, sx, sy) {
  let L = 0;
  for (let i = 0; i < ord.length; i++) {
    const a = ord[i], b = ord[(i + 1) % ord.length];
    L += Math.hypot(sx[a] - sx[b], sy[a] - sy[b]);
  }
  return L;
}

/**
 * Everything except the drawing. Exported so the harness can measure the tour
 * itself -- length, improvement gain, point count -- rather than inferring it
 * from a rendered picture.
 */
export function buildTour(ctx) {
  const { rho, d } = spacingMap(ctx);
  let total = 0;
  for (let i = 0; i < rho.length; i++) total += rho[i];
  const count = Math.max(4, Math.min(MAX_POINTS, Math.round(total)));

  const { sx, sy } = stipplePoints(ctx, {
    mode: ctx.placer,
    field: rho,
    count,
    seed: Math.round(ctx.tourSeed ?? 1),
    iterations: Math.round(ctx.stippleIter ?? 6),
    polish: Math.round(ctx.polishIter ?? 8),
  });
  const n = sx.length;
  if (n < 4) return null;

  const { tris, n: nT } = triangulate(sx, sy);

  // Delaunay neighbour lists: the candidate set for both the tree and the
  // improvement pass. An improving 2-opt move nearly always joins two points
  // that are already close, and on a planar point set "close" is "adjacent in
  // the Delaunay triangulation" -- which is why this is the right restriction
  // rather than a k-nearest cutoff with a k to guess.
  const nbrSet = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < nT; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    nbrSet[a].add(b); nbrSet[a].add(c);
    nbrSet[b].add(a); nbrSet[b].add(c);
    nbrSet[c].add(a); nbrSet[c].add(b);
  }
  const nbrs = nbrSet.map((s) => Array.from(s).sort((p, q) => p - q));
  const nbrOf = (i) => nbrs[i];

  let ord;
  if ((ctx.tourKind ?? 'mst') === 'hilbert') {
    ord = hilbertOrder(sx, sy, n);
  } else {
    // Plain Euclidean weight and no pruning: a TOUR has to reach every point, so
    // the long edges treeEdges optionally cuts must stay in the tree here. The
    // cut control below acts on the finished tour instead, where dropping an
    // edge costs a pen lift rather than an unreachable point.
    const { edges } = spanningForest(
      sx, sy, tris, nT,
      (u, v) => Math.hypot(sx[u] - sx[v], sy[u] - sy[v]),
      null,
    );
    ord = crawlTree(sx, sy, edges, n, 0);
    // A forest rather than a tree leaves points the crawl never reaches; append
    // them in Hilbert order so the tour is still Hamiltonian. This cannot happen
    // on a Delaunay triangulation of a connected point set, and is here because
    // the alternative failure is a silently incomplete drawing.
    if (ord.length < n) {
      const seen = new Uint8Array(n);
      for (const v of ord) seen[v] = 1;
      for (const v of hilbertOrder(sx, sy, n)) if (!seen[v]) ord.push(v);
    }
  }

  const before = tourLength(ord, sx, sy);
  const mode = ctx.improve ?? 'both';
  let gain = 0, moves = 0;
  if (mode !== 'none') {
    const r = improveTour(ord, sx, sy, nbrOf, {
      orOpt: mode === 'both',
      passes: Math.round(ctx.improvePasses ?? 4),
    });
    ord = r.ord; gain = r.gain; moves = r.moves;
  }
  const after = tourLength(ord, sx, sy);
  return { ord, sx, sy, n, before, after, gain, moves, d, count };
}

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const built = buildTour(ctx);
  if (!built) return [];
  const { ord, sx, sy, n, d } = built;
  const { nx, ny } = ctx;

  // With cutting off the tour stays whole, which is the classic single-stroke
  // drawing. On, it breaks wherever an edge runs more than `cutFactor` LOCAL
  // spacings -- local, because a fixed length would cut every edge in the light
  // areas, where long edges are correct.
  //
  // `cutLong` gates it, but a `cutFactor` passed without the flag still applies,
  // so the harness and older links keep the meaning they had: 0 is off.
  const wantCut = ctx.cutLong ?? (ctx.cutFactor ?? 0) > 0;
  const cut = wantCut ? Math.max(0, ctx.cutFactor ?? 3) : 0;
  const spacingAt = (i) => {
    let jx = Math.round(sx[i]) - 1, iy = Math.round(sy[i]) - 1;
    if (jx < 0) jx = 0; else if (jx >= nx) jx = nx - 1;
    if (iy < 0) iy = 0; else if (iy >= ny) iy = ny - 1;
    return d[iy * nx + jx];
  };

  const runs = [];
  let cur = [[sx[ord[0]], sy[ord[0]]]];
  for (let i = 0; i < n; i++) {
    const a = ord[i], b = ord[(i + 1) % n];
    const len = Math.hypot(sx[a] - sx[b], sy[a] - sy[b]);
    const lim = cut > 0 ? cut * ((spacingAt(a) + spacingAt(b)) / 2) : Infinity;
    if (len > lim) {
      if (cur.length > 1) runs.push(cur);
      cur = [[sx[b], sy[b]]];
    } else {
      cur.push([sx[b], sy[b]]);
    }
  }
  if (cur.length > 1) runs.push(cur);

  const out = [];
  for (const r of runs) for (const piece of clipPolyline(r, px, py)) out.push(piece);
  return out;
}

export default { id, label, params, run, targetImage };
