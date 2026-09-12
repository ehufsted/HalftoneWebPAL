// Port of singleWidthLines/code/stripesFromTrisFn.m
//
// The idea it rests on: stripe continuity is an INTEGER condition. Every other
// stripe method in this app either solves a global PDE
// (eikonalStripes) or gives up on continuity across region boundaries
// (planeWaves, which lets the seams show). This one asks how many times a stripe
// crosses each mesh edge, and that is a whole number, so neighbouring triangles
// agree exactly or not at all -- there is no tolerance to tune and no drift.
//
// The invariant the whole construction rests on: everything is evaluated at the
// shared edge MIDPOINT — length, image value, orientation — and the
// crossing count is even under the pi flip between the two traversal directions,
// so the two faces sharing an edge compute the same count without communicating.
// Node positions agree for the same reason: t = (i+0.5)/n from one side is
// exactly 1-t from the other. Evaluate the orientation at a face CENTROID instead
// and this silently collapses — stripes stop meeting at edges and the drawing
// fragments into unconnected triangles. The midpoint is canonical by
// construction: nodes are indexed along the edge's low-to-high vertex direction,
// which both faces compute identically.
//
// Reformulated from the source, which takes abs() of a signed quantity and so
// needs a four-case analysis and two undocumented interior-point weights.
//
// E*cos(EAngle - Ttri) is the edge's span along the stripe NORMAL: a signed phase
// change. Keep the sign and the whole thing collapses to one rule. Each node is
// an up- or down-crossing of the phase; matching them within a face is
// balanced-parenthesis matching off a stack, which is non-crossing by
// construction; and the consistency condition states itself, because phase is
// single-valued, so THE SIGNED CROSSINGS AROUND EACH FACE SUM TO ZERO. That
// single rule reproduces all four of the source's cases (its `n1 >= n2+n3` is
// "leftovers of one sign on the dominant side", its equal cases are "perfectly
// balanced", its last is the generic match) and the weights disappear.
//
// So the object is an integer 1-form on the mesh, the constraint is zero curl per
// face, independent per-edge round() is what violates it, and repairing that is a
// min-cost flow on the dual graph. All of that lives in spine/mesh1form.js, which
// draws nothing and was tested before this file existed.
//
// Where it cannot work is the point. spine/field.js returns theta as an
// ORIENTATION, valid mod pi. Signing a crossing needs the field oriented,
// and a line field admits no global orientation where it has odd-index defects.
// Those are not failures to paper over: they are the places a stripe genuinely
// has to end, the way a fingerprint ridge stops. orientField finds them and
// roundToClosed is told to leave them alone.

import { structureTensorField } from '../spine/field.js';
import { placerParam, usesSubdivide, usesRelaxation } from '../spine/points.js';
import { tileRegions } from '../spine/regions.js';
import { buildMesh, orientField, roundToClosed } from '../spine/mesh1form.js';
import { clipPolyline } from '../spine/geometry.js';
import {
  affineTarget, stripeSpacings, stripeBand, harmonicInvSpacing,
} from '../spine/tone.js';

export const id = 'triStripes';
export const label = 'Stripes across a triangulation';

export const params = [
  {
    key: 'meshKind', label: 'Mesh', type: 'select', def: 'delaunay',
    options: [
      { value: 'delaunay', label: 'Delaunay (aligned to image edges)' },
      { value: 'trilattice', label: 'Triangular lattice (regular)' },
    ],
  },
  // sqrt of the face AREA, as everywhere else in regions.js. Unrelated to the
  // spacing controls: the mesh only has to be fine enough to resolve how the
  // orientation turns, which says nothing about how far apart stripes end up.
  { key: 'meshSizeW', label: 'Mesh size', type: 'range', min: 6, max: 40, step: 2, def: 10, unit: '×pen' },
  // min 1 is the merge floor, as in eikonalStripes and planeWaves: at L = w
  // adjacent stripes touch and the face is solid.
  { key: 'LminW', label: 'Min spacing', type: 'range', min: 1, max: 5, step: 0.1, def: 2, unit: '×pen' },
  { key: 'LmaxW', label: 'Max spacing', type: 'range', min: 4, max: 40, step: 1, def: 10, unit: '×pen' },
  // The control the reformulation buys. See roundToClosed: it is a threshold on
  // the cost of repairing a face, so low means many stripe ends with accurate
  // spacing, high means few ends with spacing bent to achieve it. 1.0 is the
  // knee of the measured sweep in tests/spine.mesh1form.js.
  { key: 'defectPrice', label: 'Cost of a stripe end', type: 'range', min: 0.1, max: 8, step: 0.1, def: 1 },
  { key: 'crossStripes', label: 'Cross stripes', type: 'checkbox', def: false },
  // trilattice only.
  { key: 'jitter', label: 'Lattice jitter', type: 'range', min: 0, max: 0.25, step: 0.01, def: 0.15,
    when: (p) => p.meshKind === 'trilattice' },
  // delaunay only; the lattice ignores them. That was a comment before and is a
  // visibility gate now -- the controls go away rather than sitting there inert.
  { key: 'edgeMix', label: 'Edge alignment', type: 'range', min: 0, max: 1, step: 0.05, def: 0.75,
    when: (p) => p.meshKind !== 'trilattice' },
  // Delaunay places points, so the placer applies; under the subdivider there is
  // no seed and no relaxation to set.
  { key: 'meshSeed', label: 'Mesh seed', type: 'range', min: 1, max: 999, step: 1, def: 1,
    when: (p) => p.meshKind !== 'trilattice' && !usesSubdivide(p) },
  placerParam((p) => p.meshKind !== 'trilattice'),

  // Kept at their defaults and not offered. These three tune the mesh rather
  // than the drawing, and on this method the difference is not visible enough to
  // be worth a control -- the stripes follow the orientation field, which the
  // mesh only has to be fine enough to resolve. `when` hides rather than removes,
  // so `run` still reads each of them and the values below are what it gets.
  { key: 'edgeSigma', label: 'Edge scale', type: 'range', min: 1, max: 12, step: 0.5, def: 2, unit: 'px',
    when: () => false },
  { key: 'meshIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: () => false },
  { key: 'polishIter', label: 'Boundary polish', type: 'range', min: 0, max: 30, step: 1, def: 8, unit: 'iters',
    when: () => false },
];

const spacingsOf = (ctx) => stripeSpacings(ctx);

/**
 * Reachable brightness band.
 *
 * One layer covers w/L -- the shared stripe band, the same one eikonalStripes
 * and planeWaves use. WITH CROSS STRIPES IT IS THE SQUARE of that.
 * Two stripe sets at right angles are independent to first order, so the light
 * that survives both is the product: B = B1 * B2 = B1^2. Squaring the band is
 * what lets the cross mode reach genuinely darker tone rather than merely
 * doubling the ink and clipping.
 */
export function toneBand(ctx) {
  const { w, Lmin, Lmax } = spacingsOf(ctx);
  const { min, max } = stripeBand(w, Lmin, Lmax);
  return ctx.crossStripes ? { min: min * min, max: max * max } : { min, max };
}

/**
 * The tone the method aims for: the affine band, nothing more.
 *
 * The rounding to integers is NOT folded in. It is an error of at most half a
 * crossing per edge and it averages out over a face, but more importantly a
 * target that included it would be scoring the method against its own
 * approximation. The kappa measurement in the harness is what quantifies it.
 */
export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/** Nearest-pixel sample, 1-based pixel coordinates, clamped to the image. */
function sampleAt(data, nx, ny, x, y) {
  let j = Math.round(x) - 1, i = Math.round(y) - 1;
  if (j < 0) j = 0; else if (j >= nx) j = nx - 1;
  if (i < 0) i = 0; else if (i >= ny) i = ny - 1;
  return data[i * nx + j];
}

/**
 * Match a face's boundary crossings into non-crossing chords.
 *
 * The nodes come in boundary order with a sign each, and the signs sum to zero
 * on a closed face. Push onto a stack; when the incoming node has the opposite
 * sign to the top, pop and pair. That is balanced-parenthesis matching, and the
 * chords it produces cannot cross -- which matters geometrically, because two
 * crossing chords inside one triangle would be two stripes intersecting, and
 * stripes are level sets of one function.
 *
 * Leftovers are only possible on an open face. If the curl is zero the stack
 * empties completely; anything left over is exactly the residue roundToClosed
 * bought or was forced into. Adjacent leftovers are folded into hairpins so a
 * residue of +-2 costs one fold rather than two loose ends, and at most one node
 * is left genuinely unmatched.
 *
 * @param {Array<{id:number, sign:number}>} nodes  in boundary order
 * @returns {{pairs:number[][], open:number[]}}
 */
export function matchNodes(nodes) {
  const stack = [];
  const pairs = [];
  for (const nd of nodes) {
    if (stack.length > 0 && stack[stack.length - 1].sign === -nd.sign) {
      pairs.push([stack.pop().id, nd.id]);
    } else {
      stack.push(nd);
    }
  }
  // same-sign remainder: fold neighbouring pairs into hairpins
  const open = [];
  for (let i = 0; i + 1 < stack.length; i += 2) pairs.push([stack[i].id, stack[i + 1].id]);
  if (stack.length % 2 === 1) open.push(stack[stack.length - 1].id);
  return { pairs, open };
}

/**
 * Everything up to the geometry: mesh, integer 1-form, chords, chains.
 *
 * Exported whole because the harness needs the intermediate counts -- open
 * faces, defects, node totals -- to check conservation rather than only looking
 * at the picture.
 */
export function stripeChains(ctx, angleOffset = 0) {
  const { nx, ny, w } = ctx;
  const { Lmin, Lmax } = spacingsOf(ctx);
  const band = toneBand(ctx);
  const cross = !!ctx.crossStripes;

  const cells = tileRegions(ctx, {
    kind: ctx.meshKind === 'trilattice' ? 'trilattice' : 'delaunay',
    // Reaches stipplePoints only on the delaunay branch; the lattice ignores it.
    mode: ctx.placer,
    sizePx: Math.max(3 * w, (ctx.meshSizeW ?? 24) * w),
    seed: Math.round(ctx.meshSeed ?? 1),
    iterations: Math.round(ctx.meshIter ?? 6),
    polish: Math.round(ctx.polishIter ?? 8),
    edgeMix: ctx.edgeMix ?? 0.75,
    edgeSigma: ctx.edgeSigma ?? 2,
    jitter: ctx.jitter ?? 0.15,
  });
  const adj = cells.adjacency;
  if (!adj || adj.nT === 0) return null;
  const { tris, nT, sx, sy } = adj;
  const mesh = buildMesh(tris, nT);

  // The orientation field, sampled at edge midpoints AND at vertices. The
  // midpoint values are what the crossing counts use, so both faces of an edge
  // see one number. The vertex values are used only by the winding test, which
  // needs six samples round a face -- see orientField on why three is not enough.
  const field = structureTensorField(ctx.im, Math.max(1, w), Math.max(1.5, w * 2));
  const base = angleOffset;
  const eTheta = new Float64Array(mesh.nE);
  const eInvL = new Float64Array(mesh.nE);
  const tgt = affineTarget(ctx, band);
  // the SINGLE-layer band, which is what one layer's spacing ladder spans
  const bMin = Math.max(0, 1 - ctx.w / Lmin), bMax = Math.max(0, 1 - ctx.w / Lmax);
  for (let e = 0; e < mesh.nE; e++) {
    const a = mesh.eLo[e], b = mesh.eHi[e];
    const mx = (sx[a] + sx[b]) / 2, my = (sy[a] + sy[b]) / 2;
    eTheta[e] = sampleAt(field.theta, nx, ny, mx, my) + base;
    // The brightness this layer must deliver, taken from targetImage's own
    // values so the method and the thing scoring it cannot drift apart. Under
    // cross stripes the two layers multiply, so each aims at the square root of
    // the combined target.
    let B = sampleAt(tgt.data, nx, ny, mx, my);
    if (B < 0) B = 0; else if (B > 1) B = 1;
    if (cross) B = Math.sqrt(B);
    // Undo the band to recover the ladder's argument, which must be the raw
    // [0,1] value and not a brightness — see `harmonicSpacing`. For a single
    // layer this returns the source pixel exactly. Skipping it hands the ladder
    // the midpoint of its own range instead of its floor at the dark end, so
    // spacing comes out about double where the image is black and nearly right
    // where it is white.
    let r = (B - bMin) / Math.max(1e-9, bMax - bMin);
    if (r < 0) r = 0; else if (r > 1) r = 1;
    eInvL[e] = harmonicInvSpacing(r, Lmin, Lmax);
  }
  const vTheta = new Float64Array(sx.length);
  for (let i = 0; i < sx.length; i++) {
    vTheta[i] = sampleAt(field.theta, nx, ny, sx[i], sy[i]) + base;
  }

  const { sign, defect, nDefect } = orientField(eTheta, vTheta, mesh);

  // Desired signed crossings: the edge's span along the stripe NORMAL, divided
  // by the local spacing. theta is the stripe direction (the structure tensor's
  // tangent, so stripes follow image edges), and the normal is that turned by
  // pi/2. This is where the sign is kept rather than thrown away -- the one
  // change that removes the source's four-case analysis.
  const g = new Float64Array(mesh.nE);
  for (let e = 0; e < mesh.nE; e++) {
    const a = mesh.eLo[e], b = mesh.eHi[e];
    const th = eTheta[e] + (sign[e] < 0 ? Math.PI : 0);
    const nxh = -Math.sin(th), nyh = Math.cos(th);
    g[e] = ((sx[b] - sx[a]) * nxh + (sy[b] - sy[a]) * nyh) * eInvL[e];
  }

  const { m, residual, nOpen } = roundToClosed(g, mesh, {
    defectPrice: Math.max(0.05, ctx.defectPrice ?? 1),
    defect,
  });

  // ---- nodes: identified by (edge, index along the edge), never by position.
  // docs/findings.md records this from spine/contour.js: identify by index and
  // the linking is exact integer bookkeeping with no tolerance to tune. It also
  // replaces the source's O(E^2) intersect(...,'rows') loop at lines 305-321.
  const nodeBase = new Int32Array(mesh.nE + 1);
  for (let e = 0; e < mesh.nE; e++) nodeBase[e + 1] = nodeBase[e] + Math.abs(m[e]);
  const nNodes = nodeBase[mesh.nE];
  const nodeX = new Float64Array(nNodes), nodeY = new Float64Array(nNodes);
  for (let e = 0; e < mesh.nE; e++) {
    const n = Math.abs(m[e]);
    if (n === 0) continue;
    const a = mesh.eLo[e], b = mesh.eHi[e];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      nodeX[nodeBase[e] + i] = sx[a] + (sx[b] - sx[a]) * t;
      nodeY[nodeBase[e] + i] = sy[a] + (sy[b] - sy[a]) * t;
    }
  }

  // ---- chords, one face at a time
  const chords = [];
  let nOpenNodes = 0;
  for (let f = 0; f < nT; f++) {
    const nodes = [];
    for (let k = 0; k < 3; k++) {
      // slot k runs from vertex k to vertex k+1, so the three slots are already
      // in boundary order -- see buildMesh
      const e = mesh.faceEdge[3 * f + k], s = mesh.faceSign[3 * f + k];
      const n = Math.abs(m[e]);
      if (n === 0) continue;
      const sg = Math.sign(m[e]) * s;          // crossing sense along THIS walk
      for (let i = 0; i < n; i++) {
        // traversed against the canonical direction: visit the nodes in reverse
        const idx = s > 0 ? i : n - 1 - i;
        nodes.push({ id: nodeBase[e] + idx, sign: sg });
      }
    }
    if (nodes.length === 0) continue;
    const { pairs, open } = matchNodes(nodes);
    for (const p of pairs) chords.push(p);
    nOpenNodes += open.length;
  }

  // ---- chain chords into polylines by node id
  const nodeChord = new Int32Array(2 * nNodes).fill(-1);
  for (let c = 0; c < chords.length; c++) {
    for (const nd of chords[c]) {
      if (nodeChord[2 * nd] < 0) nodeChord[2 * nd] = c;
      else if (nodeChord[2 * nd + 1] < 0) nodeChord[2 * nd + 1] = c;
    }
  }
  const other = (nd, c) => {
    const a = nodeChord[2 * nd], b = nodeChord[2 * nd + 1];
    return a === c ? b : (b === c ? a : -1);
  };
  const used = new Uint8Array(chords.length);
  const chains = [];
  const walk = (c0, start) => {
    const pts = [[nodeX[start], nodeY[start]]];
    let c = c0, nd = start;
    while (c >= 0 && !used[c]) {
      used[c] = 1;
      const nxt = chords[c][0] === nd ? chords[c][1] : chords[c][0];
      pts.push([nodeX[nxt], nodeY[nxt]]);
      nd = nxt;
      c = other(nd, c);
    }
    return pts;
  };
  // open chains first, so a stripe that ends somewhere is drawn end to end
  for (let nd = 0; nd < nNodes; nd++) {
    const a = nodeChord[2 * nd], b = nodeChord[2 * nd + 1];
    if (a >= 0 && b < 0 && !used[a]) chains.push(walk(a, nd));
  }
  // whatever is left is a closed loop
  for (let c = 0; c < chords.length; c++) {
    if (used[c]) continue;
    const pts = walk(c, chords[c][0]);
    pts.push(pts[0].slice());
    chains.push(pts);
  }

  // Total chord length, measured BEFORE chaining. The harness compares it
  // against the chained polylines: chaining is a pure restructuring and must not
  // create or lose a millimetre. That conserved quantity is what caught
  // treeEdges dropping every branch edge, which looked entirely plausible.
  let chordLength = 0;
  for (const [a, b] of chords) {
    chordLength += Math.hypot(nodeX[b] - nodeX[a], nodeY[b] - nodeY[a]);
  }

  return {
    chains, mesh, m, residual, nOpen, nDefect,
    nNodes, chords, nOpenNodes, chordLength, sx, sy, nT,
  };
}

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const layers = ctx.crossStripes ? [0, Math.PI / 2] : [0];
  const out = [];
  for (const a of layers) {
    const built = stripeChains(ctx, a);
    if (!built) continue;
    for (const chain of built.chains) {
      // The mesh overruns the polygon (the lattice by a margin, the Delaunay by
      // its hull), so the drawing is clipped rather than the mesh: clipping the
      // mesh would move the boundary vertices and change the crossing counts of
      // every face that touches it.
      for (const piece of clipPolyline(chain, px, py)) out.push(piece);
    }
  }
  return out;
}

export default { id, label, params, run, targetImage };
