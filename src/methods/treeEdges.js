// Spanning trees as a drawing. The MST half of
// singleWidthLines/code/regionsVorDelMSTTSP.m (mode 2), via primMST.m.
//
// The tone constant is derived, completing the set the mesh methods start. A
// spanning tree on n points has exactly n-1 edges, and on a hexagonal
// arrangement with spacing d every one of them has length d, because each point
// joins a nearest neighbour. With n = 1.1547/d^2 points per unit area,
//
//     MST length per unit area = n*d = 1.1547/d = (2/sqrt3)/d
//
// so C = 2/sqrt3 = 1.1547 on a lattice.
//
// That is a lattice bound, not an identity. The tempting statement is
//
//     MST : Voronoi : Delaunay  =  1 : sqrt3 : 3
//
// and two thirds of it are true. Voronoi and Delaunay keep EVERY edge, so their
// totals are means over the whole edge-length distribution and stay near the
// lattice value on a relaxed set — measured, their ratio holds to within 1% of
// sqrt3. The MST does not keep every edge: it SELECTS the shortest n-1 of the
// Delaunay's 3n, and the mean of the lowest third of a distribution is far below
// the mean of all of it.
//
// On a perfect lattice the distinction vanishes, because all 3n edges are the
// same length and any third of them gives n*d. On a real point set it does not
// vanish and it does not shrink with n: it is an order statistic, not a lattice
// imperfection. Measured, MST/Delaunay comes out at 0.254 rather than 0.333 —
// a factor of 0.762, steady across a fivefold range of point count. For a roughly
// normal spread the lowest third averages 1 - 1.09*CV of the whole, so 0.762
// implies a coefficient of variation of about 0.22 in the Delaunay edge lengths,
// an ordinary spread for a relaxed set.
//
// So TREE_KAPPA is a different kind of constant from the mesh methods'. Theirs
// corrects a lattice idealisation and sits just above 1; this one absorbs an
// order statistic and sits well below.
//
// Kruskal rather than Prim, for the forest: sorting the candidate edges and
// accepting them under union-find gives the same tree, and stopping after n-k
// acceptances gives the k-component minimum spanning FOREST for nothing. A tree
// must connect everything, so it necessarily throws long edges across empty
// paper — the same complaint made of Delaunay in bright areas, but worse, since
// a tree has no choice. In Kruskal the forest is a loop bound.

import { regionMask } from '../spine/mask.js';
import { stipplePoints, placerParam, usesSubdivide, usesRelaxation } from '../spine/points.js';
import { triangulate } from '../spine/delaunay.js';
import { structureTensorField } from '../spine/field.js';
import { affineTarget } from '../spine/tone.js';

export const id = 'treeEdges';
export const label = 'Spanning tree';

/**
 * C is derived (see header). A is the overlap where strokes meet at a vertex.
 *
 * A is provisional. A tree has n vertices and n-1 edges, so the mean degree is
 * almost exactly 2 -- most junctions are two strokes meeting at an angle, where
 * the Voronoi's are three and the Delaunay's six. Two rays at 120 degrees
 * overlap in about w^2*cot(60)/2 = 0.29 w^2; with n vertices and a naive
 * coverage of 1.1547 w/d that is a deficit of about 0.3 w/d. But a tree's angles
 * are not 120 degrees -- they vary and can be shallow, which costs more -- so
 * this is an estimate to be measured, not a derivation to be trusted. Compare
 * the Voronoi case, where the same argument gave 0.69 and the measurement said
 * 0.58.
 */
export const TREE_TONE = { C: 2 / Math.sqrt(3), A: 0.3 };

/**
 * The relaxed-set correction, and it is BELOW 1 here where the mesh methods put
 * it above.
 *
 * MEASURED at 0.817, steady to 0.008 across a tenfold range of point count.
 *
 * The SIGN was predicted and the MAGNITUDE was not, in a way worth recording.
 * The prediction reasoned from nearest-neighbour distance measuring 0.88 of the
 * hexagonal ideal, and put the answer between 0.88 and 1. It came in below that,
 * because the MST does not spend one nearest-neighbour edge per point: wherever
 * i and j are each other's nearest neighbour, ONE edge serves both. So a tree
 * buys its connectivity more cheaply than summing per-point NN distances
 * suggests, and 0.88 was never a floor.
 */
export const TREE_KAPPA = 0.817;

export const params = [
  // -1 perpendicular, 0 isotropic, +1 parallel. The weight multiplier is
  // 1 - a*cos(2*phi) with phi the angle between the edge and the local image
  // tangent, so at a = +1 an along-tangent edge is free and a cross-tangent one
  // costs double. cos(2*phi) rather than cos(phi) because an orientation is
  // valid mod pi and a symmetric edge cannot tell one end from the other -- the
  // doubled angle is the same fix meanOrientation applies in the spine.
  {
    key: 'anisotropy', label: 'Follow the image', type: 'range',
    min: -1, max: 1, step: 0.05, def: 0,
  },
  { key: 'dMinW', label: 'Min spacing', type: 'range', min: 2, max: 24, step: 0.25, def: 2, unit: '×pen' },
  { key: 'dMaxW', label: 'Max spacing', type: 'range', min: 4, max: 50, step: 1, def: 5, unit: '×pen' },
  // The placer sits above the relaxation it governs; both hidden under the
  // subdivision placer, which has no relaxation and no seed.
  placerParam(),
  { key: 'relaxIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: usesRelaxation },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1,
    when: (p) => !usesSubdivide(p) },
  // As in meshEdges: a guard, not a tone control. Point count goes as 1/d^2 and
  // triangulate is superlinear in it.
  { key: 'maxPoints', label: 'Point budget', type: 'range', min: 500, max: 12000, step: 500, def: 6000 },
];

/**
 * What a unit of anisotropy adds to the tree's LENGTH, per unit |a|.
 *
 * The edge count is fixed at n-1 whatever the metric, so an anisotropic metric
 * cannot change how many edges there are -- only which ones, and the ones it
 * prefers are cheap in the metric and longer on the page. Measured on a radial
 * ramp: +7% at |a| = 0.25, +18% at 0.5, +30% at 1, which is close enough to
 * linear in |a| that a single coefficient carries it (the excess over |a| reads
 * 0.29, 0.36, 0.30).
 *
 * Corrected rather than documented, because 30% is far too much to leave in a
 * slider: uncorrected, turning the control up runs the drawing that far dark of
 * its own target.
 *
 * The coefficient is image-dependent, which is its weakness. It was measured
 * on a field with strong coherent structure; a picture with little orientation
 * for the tree to follow gives the metric less to bite on and the correction
 * will overshoot, leaving the drawing slightly light. That is the safer
 * direction, and a per-image measurement would mean building the tree twice.
 */
export const ANISO_COST = 0.3;

/** TREE_KAPPA with the anisotropy penalty folded in. */
function kappaOf(ctx) {
  const a = Math.abs(Math.max(-1, Math.min(1, ctx.anisotropy ?? 0)));
  return TREE_KAPPA * (1 + ANISO_COST * a);
}

function scalesOf(ctx) {
  const w = ctx.w;
  const { C, A } = TREE_TONE;
  const kappa = kappaOf(ctx);
  // merge floor: K reaches 1 at d = kappa*C*w, so there is nothing below it
  const dMin = Math.max(kappa * C * w, (ctx.dMinW ?? 6) * w);
  const dMax = Math.max(dMin * 1.5, (ctx.dMaxW ?? 60) * w);
  return { w, C, A, kappa, dMin, dMax };
}

/** Coverage of a tree at spacing d. Same three-factor form as meshEdges. */
export function coverageOf(w, d, kappa = TREE_KAPPA) {
  const { C, A } = TREE_TONE;
  return Math.min(1, (kappa * C * w) / (d + A * w));
}

export function toneBand(ctx) {
  const { w, kappa, dMin, dMax } = scalesOf(ctx);
  return {
    min: Math.max(0, 1 - coverageOf(w, dMin, kappa)),
    max: Math.max(0, 1 - coverageOf(w, dMax, kappa)),
  };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Point density per pixel, from the tone.
 *
 * Remapped into the reachable band BEFORE inverting, not clamped afterwards.
 * Clamping instead is what made meshEdges disagree with its own targetImage
 * across every tone the clamp touched -- most of the picture -- and it is worth
 * repeating the reason here because the two modules look similar enough to copy
 * the wrong one.
 */
export function spacingMap(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { w, C, A, kappa, dMin, dMax } = scalesOf(ctx);
  const band = toneBand(ctx);
  const dens = new Float64Array(nx * ny);
  const dMap = new Float64Array(nx * ny);
  const mask = regionMask(ctx);
  let total = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!mask[c]) continue;
      const B = Math.min(1, Math.max(0, ctx.im.data[c]));
      const B2 = B * (band.max - band.min) + band.min;
      const K2 = Math.max(1e-6, 1 - B2);
      const d = Math.min(dMax, Math.max(dMin, (kappa * C * w) / K2 - A * w));
      dMap[c] = d;
      dens[c] = 1.1547 / (d * d);
      total += dens[c];
    }
  }
  return { dens, dMap, total };
}

/** Union-find, path-compressed. Iterative, so a long chain cannot blow the stack. */
function makeDSU(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx2 = parent[a]; parent[a] = r; a = nx2; }
    return r;
  };
  return { find, union: (a, b) => { parent[find(a)] = find(b); } };
}

/**
 * Minimum spanning forest over the Delaunay edges.
 *
 * The Delaunay candidate set is exact for the Euclidean case only. The Euclidean
 * MST is a subgraph of the Delaunay triangulation, which is what makes searching
 * only those 3n edges lossless. Under an anisotropic metric that guarantee is
 * gone — it would return for a globally constant anisotropy by triangulating the
 * transformed points, but not for a spatially varying one — so with `anisotropy`
 * nonzero this returns an approximate minimum tree over a good candidate set.
 * The alternative is a complete graph at n^2 edges.
 *
 * @returns {{edges:number[], cut:number}} accepted edges as index pairs, and how
 *          many were rejected by the length threshold
 */
export function spanningForest(sx, sy, tris, nT, weightOf, maxLenOf) {
  const n = sx.length;
  const seen = new Set();
  const cand = [];
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      const u = tris[3 * t + k], v = tris[3 * t + ((k + 1) % 3)];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cand.push(u < v ? u : v, u < v ? v : u);
    }
  }

  const m = cand.length / 2;
  const wts = new Float64Array(m);
  for (let e = 0; e < m; e++) wts[e] = weightOf(cand[2 * e], cand[2 * e + 1]);

  // Sorted by weight, ties broken by index. Deterministic: two edges of equal
  // weight always resolve the same way, so the same seed gives the same tree.
  const order = Array.from({ length: m }, (_, i) => i)
    .sort((a, b) => (wts[a] - wts[b]) || (a - b));

  const dsu = makeDSU(n);
  const edges = [];
  let cut = 0;
  for (const e of order) {
    const u = cand[2 * e], v = cand[2 * e + 1];
    if (dsu.find(u) === dsu.find(v)) continue;
    // The pruning test is on the EUCLIDEAN length against the local spacing, not
    // on the anisotropic weight. What it exists to remove is a stroke visibly
    // crossing empty paper, and that is a fact about the page rather than about
    // the metric the tree was grown in.
    if (maxLenOf) {
      const len = Math.hypot(sx[u] - sx[v], sy[u] - sy[v]);
      if (len > maxLenOf(u, v)) { cut++; continue; }
    }
    dsu.union(u, v);
    edges.push(u, v);
  }
  return { edges, cut };
}

/**
 * Break a forest into polylines, walking from a root.
 *
 * A tree is not a set of segments to a plotter. Emitting n-1 separate edges would
 * make the optimiser rediscover the chains one join at a time; walking the tree
 * produces long strokes directly. At each node the walk continues into the
 * DEEPEST child and starts a new path for the others — the standard heavy-path
 * decomposition, which minimises the number of paths and so of pen lifts.
 *
 * This is also the only thing the root control actually changes. A minimum
 * spanning tree is unique when its edge weights are distinct, so the root cannot
 * alter WHICH tree is drawn; it alters how that tree is cut into strokes.
 */
export function treePaths(sx, sy, edges, n, rootPick) {
  const deg = new Int32Array(n);
  for (let i = 0; i < edges.length; i += 2) { deg[edges[i]]++; deg[edges[i + 1]]++; }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const adj = new Int32Array(edges.length);
  const fill = Int32Array.from(start);
  for (let i = 0; i < edges.length; i += 2) {
    adj[fill[edges[i]]++] = edges[i + 1];
    adj[fill[edges[i + 1]]++] = edges[i];
  }

  const seen = new Uint8Array(n);
  const parent = new Int32Array(n).fill(-1);
  const out = [];

  for (let c = 0; c < n; c++) {
    if (seen[c] || deg[c] === 0) continue;
    // one component; its root is whichever of its members the caller prefers
    const members = [];
    const stack = [c];
    seen[c] = 1;
    while (stack.length > 0) {
      const a = stack.pop();
      members.push(a);
      for (let k = start[a]; k < start[a + 1]; k++) {
        const b = adj[k];
        if (seen[b]) continue;
        seen[b] = 1; parent[b] = a; stack.push(b);
      }
    }
    const root = rootPick(members);

    // rebuild parents from the chosen root, then depth by longest descent
    const order = [root];
    const par = new Map([[root, -1]]);
    for (let qi = 0; qi < order.length; qi++) {
      const a = order[qi];
      for (let k = start[a]; k < start[a + 1]; k++) {
        const b = adj[k];
        if (par.has(b)) continue;
        par.set(b, a); order.push(b);
      }
    }
    const height = new Map();
    for (let qi = order.length - 1; qi >= 0; qi--) {
      const a = order[qi];
      let h = 0;
      for (let k = start[a]; k < start[a + 1]; k++) {
        const b = adj[k];
        if (par.get(b) !== a) continue;
        h = Math.max(h, (height.get(b) ?? 0) + Math.hypot(sx[a] - sx[b], sy[a] - sy[b]));
      }
      height.set(a, h);
    }

    // Heavy-path walk. EACH BRANCH PATH STARTS AT ITS PARENT, not at itself,
    // and that is not a detail: the edge from a branch point to a light child
    // belongs to no heavy path, so if the child's path begins at the child then
    // that edge is never drawn at all. The decomposition makes one path per
    // leaf, so it loses `leaves - 1` of the `n - 1` edges -- for a planar MST
    // something like a quarter of them, every one of them a branch. The drawing
    // comes out as disconnected polylines with the branching cut away, which is
    // exactly what it looked like.
    //
    // Carrying the parent makes every edge appear exactly once: heavy edges
    // inside a path, light edges as the first segment of the child's path. The
    // total is n - 1 by construction, which is what the harness now asserts
    // against the sum of the MST's own edge lengths.
    const pending = [[-1, root]];
    while (pending.length > 0) {
      const [from, head] = pending.pop();
      const path = from >= 0
        ? [[sx[from], sy[from]], [sx[head], sy[head]]]
        : [[sx[head], sy[head]]];
      let a = head;
      for (;;) {
        let best = -1, bestH = -1;
        for (let k = start[a]; k < start[a + 1]; k++) {
          const b = adj[k];
          if (par.get(b) !== a) continue;
          const h = height.get(b) ?? 0;
          if (h > bestH) { bestH = h; best = b; }
        }
        if (best < 0) break;
        for (let k = start[a]; k < start[a + 1]; k++) {
          const b = adj[k];
          if (par.get(b) === a && b !== best) pending.push([a, b]);
        }
        path.push([sx[best], sy[best]]);
        a = best;
      }
      if (path.length >= 2) out.push(path);
    }
  }
  return out;
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { w } = scalesOf(ctx);
  const aniso = Math.max(-1, Math.min(1, ctx.anisotropy ?? 0));

  const { dens, dMap, total } = spacingMap(ctx);
  const budget = Math.max(50, Math.round(ctx.maxPoints ?? 6000));
  const count = Math.max(3, Math.min(budget, Math.round(total)));

  // No perimeter ring, unlike the mesh methods. Ring points sit at one spacing
  // along a straight line, so they are each other's nearest neighbours and the
  // tree would chain them into a frame right round the drawing — perimeter/d
  // edges of pure border the tone model never asked for. A tree also has no
  // per-area boundary term to correct for: it is n-1 edges however the boundary
  // is shaped.
  const { sx, sy } = stipplePoints(ctx, {
    mode: ctx.placer,
    field: dens,
    count,
    seed: Math.round(ctx.seed ?? 1),
    iterations: Math.round(ctx.relaxIter ?? 6),
  });
  const n = sx.length;
  if (n < 3) return [];

  const { tris, n: nT } = triangulate(sx, sy);

  const field = aniso !== 0
    ? structureTensorField(ctx.im, Math.max(1, w), Math.max(1.5, w * 2))
    : null;
  const thetaAt = (x, y) => {
    const j = Math.min(nx - 1, Math.max(0, Math.round(x) - 1));
    const i = Math.min(ny - 1, Math.max(0, Math.round(y) - 1));
    return field.theta[i * nx + j];
  };
  const weightOf = (u, v) => {
    const dx = sx[v] - sx[u], dy = sy[v] - sy[u];
    const len = Math.hypot(dx, dy);
    if (!field || len === 0) return len;
    const th = thetaAt((sx[u] + sx[v]) / 2, (sy[u] + sy[v]) / 2);
    const cosPhi = (dx * Math.cos(th) + dy * Math.sin(th)) / len;
    return len * (1 - aniso * (2 * cosPhi * cosPhi - 1));
  };

  const dAt = (u, v) => {
    const j = Math.min(nx - 1, Math.max(0, Math.round((sx[u] + sx[v]) / 2) - 1));
    const i = Math.min(ny - 1, Math.max(0, Math.round((sy[u] + sy[v]) / 2) - 1));
    return dMap[i * nx + j] || 1;
  };
  // The forest, always on and no longer a control. Cutting long edges is what
  // stops the tree stringing a line across empty paper, and the threshold is in
  // multiples of the LOCAL spacing rather than in pixels, so it means the same
  // thing in a dark region and a pale one.
  //
  // It lightens the drawing, and the tone model does not account for it: `run`'s
  // note below reports how much length was cut, and the fidelity figure will sit
  // a little light as a result. Both keys are still read, so the harness can ask
  // for the unpruned baseline with `prune: false` and sweep the threshold.
  const pruneAt = (ctx.prune ?? true) ? Math.max(1.5, ctx.pruneAtW ?? 2) : 0;
  const maxLenOf = pruneAt > 0 ? (u, v) => pruneAt * dAt(u, v) : null;

  const { edges } = spanningForest(sx, sy, tris, nT, weightOf, maxLenOf);

  const rootPick = (members) => {
    const mode = ctx.rootMode ?? 'darkest';
    let best = members[0], bestScore = Infinity;
    for (const m of members) {
      const j = Math.min(nx - 1, Math.max(0, Math.round(sx[m]) - 1));
      const i = Math.min(ny - 1, Math.max(0, Math.round(sy[m]) - 1));
      let s;
      if (mode === 'centre') s = Math.hypot(sx[m] - nx / 2, sy[m] - ny / 2);
      else if (mode === 'corner') s = sx[m] + sy[m];
      else s = ctx.im.data[i * nx + j];            // darkest = smallest brightness
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  };

  return treePaths(sx, sy, edges, n, rootPick);
}

export default { id, label, params, run, targetImage };
