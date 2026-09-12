// Integer 1-forms on a triangle mesh, for stripe fields.
//
// A stripe pattern is the level sets of a phase. Cut the plane into triangles and
// the whole pattern is determined by ONE INTEGER PER EDGE: how many stripes cross
// it, signed by which way the phase runs. Everything hard about laying out
// stripes globally — keeping them parallel, keeping them from crossing, keeping
// spacing right as the image changes — collapses to choosing those integers well.
//
// The constraint is that phase is single-valued. Walk the three edges of a face
// and the signed crossings must sum to zero, or the phase disagrees with itself
// on the way round. In the language of forms: the 1-form is CLOSED, its curl
// vanishes on every face. Choosing each edge's integer independently — which is
// what a plain round() does — violates that on about a third of faces, and each
// violation is a place where a stripe has nowhere to go.
//
// So the job here is to round a real-valued 1-form to an integer one that is
// closed, changing it as little as possible. That is a min-cost flow on the dual
// graph, because flipping one edge's integer moves curl between exactly the two
// faces that share it — by equal and opposite amounts, since the two faces
// traverse a shared edge in opposite directions.
//
// It cannot always be done, which is the interesting part rather than a
// limitation. Where the direction field has a genuine singularity, no choice of
// integers closes the form, because the phase really is multivalued there. Those
// faces are where a stripe must end — a dislocation, the same defect a fingerprint
// has where a ridge stops. orientField finds them; roundToClosed leaves them alone.
//
// Nothing here draws anything. It is the piece that gets tested first.

/**
 * Edge list and face-edge incidence.
 *
 * Edge k of face f runs from vertex k to vertex k+1 in the face's own
 * counter-clockwise order. Each edge also has a CANONICAL direction, low vertex
 * index to high, and `faceSign` records whether the face agrees with it. A
 * shared edge therefore always has opposite signs in its two faces -- which is
 * exactly what makes flipping its integer move curl from one to the other, and
 * is worth checking if the flow below ever looks wrong.
 *
 * @param {Int32Array} tris  3 vertex indices per face
 * @param {number} nT        face count
 */
export function buildMesh(tris, nT) {
  const key = new Map();
  const lo = [], hi = [], fA = [], fB = [];
  const faceEdge = new Int32Array(3 * nT);
  const faceSign = new Int8Array(3 * nT);

  for (let f = 0; f < nT; f++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[3 * f + k], b = tris[3 * f + ((k + 1) % 3)];
      const l = Math.min(a, b), h = Math.max(a, b);
      const kk = `${l},${h}`;
      let e = key.get(kk);
      if (e === undefined) {
        e = lo.length;
        key.set(kk, e);
        lo.push(l); hi.push(h); fA.push(f); fB.push(-1);
      } else if (fB[e] === -1 && fA[e] !== f) {
        fB[e] = f;
      }
      faceEdge[3 * f + k] = e;
      faceSign[3 * f + k] = a === l ? 1 : -1;
    }
  }
  return {
    nT,
    tris,                 // carried through: orientField needs vertex ids too
    nE: lo.length,
    eLo: Int32Array.from(lo),
    eHi: Int32Array.from(hi),
    eFaceA: Int32Array.from(fA),
    eFaceB: Int32Array.from(fB),
    faceEdge,
    faceSign,
  };
}

/**
 * Lift a mod-pi orientation field to a signed one, and find where it cannot be.
 *
 * THE PROBLEM. structureTensorField returns an ORIENTATION, valid mod pi -- a
 * line, not an arrow. A signed crossing count needs an arrow: which way the
 * phase increases. Picking one per edge is easy; picking them CONSISTENTLY over
 * the whole mesh is what a line field may not allow. A field with a half-index
 * singularity cannot be oriented at all in any neighbourhood enclosing it,
 * however the choices are made.
 *
 * Frustration is local, which is what makes this cheap: it is the WINDING of the
 * orientation round one face's boundary. Lift each step between consecutive
 * samples into (-pi/2, pi/2] -- the smallest rotation carrying one line to the
 * next -- and add them up. A field with no singularity inside returns to where
 * it started, so the sum is 0. A half-index singularity brings the line back to
 * itself with its arrow reversed, so the sum is +-pi.
 *
 * Six samples, not three. Sampling only the three edge midpoints tests the
 * winding round the MEDIAL triangle, a quarter of the face's area, so a
 * singularity in one of the three corner regions is not enclosed at all and fires
 * no frustration — a field with a known half-index defect reports zero. Vertices
 * and midpoints alternating enclose anything inside the face.
 *
 * The signs themselves are then assigned by walking the dual graph, and a
 * frustrated face is simply where the walk is allowed to contradict itself.
 *
 * @param {Float64Array} eTheta  orientation at each EDGE MIDPOINT, mod pi.
 *        Midpoints, not centroids: see triStripes for why the whole method rests
 *        on both faces seeing the same value there.
 * @param {Float64Array} vTheta  orientation at each VERTEX, mod pi. Used only
 *        for the winding test, never for a crossing count.
 * @returns {{sign:Int8Array, defect:Uint8Array, nDefect:number}} `sign[e]` is +1
 *        if eTheta[e] should be read as-is and -1 if it should be read as
 *        eTheta[e] + pi; `defect[f]` marks faces no assignment can satisfy.
 */
export function orientField(eTheta, vTheta, mesh) {
  const { nT, nE, tris, faceEdge, eFaceA, eFaceB } = mesh;
  const rel = (a, b) => (Math.cos(eTheta[a] - eTheta[b]) >= 0 ? 1 : -1);
  /** the smallest rotation carrying line a onto line b */
  const step = (a, b) => {
    const d = b - a;
    return d - Math.PI * Math.round(d / Math.PI);
  };

  const defect = new Uint8Array(nT);
  let nDefect = 0;
  const ring = new Float64Array(6);
  for (let f = 0; f < nT; f++) {
    for (let k = 0; k < 3; k++) {
      ring[2 * k] = vTheta[tris[3 * f + k]];
      ring[2 * k + 1] = eTheta[faceEdge[3 * f + k]];
    }
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += step(ring[k], ring[(k + 1) % 6]);
    if (Math.abs(sum) > Math.PI / 2) { defect[f] = 1; nDefect++; }
  }

  // Assign arrows by breadth-first walk over the dual graph. Entering a face
  // through an edge whose sign is already fixed determines the other two, up to
  // the frustration above.
  const sign = new Int8Array(nE);
  const seenE = new Uint8Array(nE);
  const seenF = new Uint8Array(nT);
  const queue = [];
  for (let f0 = 0; f0 < nT; f0++) {
    if (seenF[f0]) continue;
    // a fresh component: fix its first edge arbitrarily
    sign[faceEdge[3 * f0]] = 1;
    seenE[faceEdge[3 * f0]] = 1;
    seenF[f0] = 1;
    queue.length = 0;
    queue.push(f0);
    while (queue.length > 0) {
      const f = queue.pop();
      const es = [faceEdge[3 * f], faceEdge[3 * f + 1], faceEdge[3 * f + 2]];
      let anchor = -1;
      for (const e of es) if (seenE[e]) { anchor = e; break; }
      if (anchor < 0) { sign[es[0]] = 1; seenE[es[0]] = 1; anchor = es[0]; }
      for (const e of es) {
        if (seenE[e]) continue;
        sign[e] = sign[anchor] * rel(e, anchor);
        seenE[e] = 1;
      }
      for (const e of es) {
        for (const g of [eFaceA[e], eFaceB[e]]) {
          if (g >= 0 && !seenF[g]) { seenF[g] = 1; queue.push(g); }
        }
      }
    }
  }
  return { sign, defect, nDefect };
}

/** curl of an integer 1-form on one face: the signed sum round its three edges. */
export function curlOf(m, mesh, f) {
  const { faceEdge, faceSign } = mesh;
  return faceSign[3 * f] * m[faceEdge[3 * f]]
       + faceSign[3 * f + 1] * m[faceEdge[3 * f + 1]]
       + faceSign[3 * f + 2] * m[faceEdge[3 * f + 2]];
}

/**
 * Round a real 1-form to a CLOSED integer one, at least cost.
 *
 * `round()` alone leaves about a third of faces with curl +-1, because the true
 * signed sum is zero and three roundings of under a half can add to one. Each
 * such face is a stripe with nowhere to go.
 *
 * The fix is a flow, and the reason is one line of bookkeeping: a shared edge is
 * traversed in opposite directions by its two faces, so faceSign differs, so
 * adding 1 to that edge's integer raises one face's curl by 1 and lowers the
 * other's by 1. Curl is therefore conserved and can only be MOVED -- from a face
 * that has too much to one that has too little, along a path in the dual graph,
 * or out through the boundary.
 *
 * Two passes, because the cheap one does most of the work:
 *
 *   1. Adjacent faces with opposite curl are fixed by flipping the single edge
 *      between them. O(E), and it clears the large majority.
 *   2. What is left goes by successive shortest paths -- Dijkstra on the dual,
 *      each dual step priced at the extra rounding error that flip would cost.
 *
 * `defectPrice` is the escape hatch and the control. Every face also has the
 * option of simply keeping its curl, at that price, which draws as a stripe
 * ending. Low price: many dislocations, spacing stays accurate. High price: few
 * dislocations, spacing bends to achieve it. Faces flagged by orientField get
 * that option FREE, because no rounding can close a form around a genuine
 * singularity and charging for the impossible would only distort everything
 * nearby.
 *
 * @param {Float64Array} g  desired signed crossings per edge, real
 * @returns {{m:Int32Array, residual:Int32Array, nOpen:number, cost:number}}
 *        `residual[f]` is the curl left on face f -- zero except where a
 *        dislocation was bought or forced.
 */
export function roundToClosed(g, mesh, opts = {}) {
  const { nT, nE, faceEdge, faceSign, eFaceA, eFaceB } = mesh;
  const defectPrice = opts.defectPrice ?? 1.0;
  const free = opts.defect ?? null;

  const m = new Int32Array(nE);
  for (let e = 0; e < nE; e++) m[e] = Math.round(g[e]);

  const curl = new Int32Array(nT);
  for (let f = 0; f < nT; f++) curl[f] = curlOf(m, mesh, f);

  // cost of moving this edge's integer by delta, as extra rounding error
  const stepCost = (e, delta) => Math.abs(g[e] - (m[e] + delta)) - Math.abs(g[e] - m[e]);

  // ---- pass 1: adjacent opposite curls, one flip each
  for (let e = 0; e < nE; e++) {
    const a = eFaceA[e], b = eFaceB[e];
    if (a < 0 || b < 0) continue;
    if (curl[a] === 0 || curl[b] === 0) continue;
    if (Math.sign(curl[a]) === Math.sign(curl[b])) continue;
    if (free && (free[a] || free[b])) continue;
    // find this edge's slot in face a, to read its sign there
    let sa = 0;
    for (let k = 0; k < 3; k++) if (faceEdge[3 * a + k] === e) sa = faceSign[3 * a + k];
    const delta = -Math.sign(curl[a]) * sa;
    m[e] += delta;
    curl[a] += sa * delta;
    curl[b] -= sa * delta;
  }

  // ---- pass 2: successive shortest paths for what remains
  //
  // One unit at a time from a face with nonzero curl, to whichever sink is
  // cheapest: a face with the opposite curl, or OUT THROUGH THE PAGE EDGE.
  //
  // The boundary is a real sink and must be one. Summing curl over every face
  // telescopes to the flux through the boundary edges, and for a general field
  // that total is not zero — some stripes genuinely run off the page. A boundary
  // edge has only one face, so flipping its integer changes that one curl and
  // nothing else: the unit leaves the mesh. Without this arc a linear phase
  // leaves ~20 faces of 1276 permanently open, since curl that belonged outside
  // could only ever be paid for as a dislocation.
  //
  // `defectPrice` is then a simple threshold rather than a graph arc: if the
  // cheapest real sink costs more than that, keep the curl and draw a stripe
  // ending. Low price: many dislocations, spacing stays accurate. High price:
  // few dislocations, spacing bends to achieve it. Faces flagged by orientField
  // are never pushed at all, because no rounding can close a form around a
  // genuine singularity and trying would only distort everything nearby.
  const OUT = nT;
  const dist = new Float64Array(nT + 1);
  const fromEdge = new Int32Array(nT + 1);
  const fromFace = new Int32Array(nT + 1);
  let totalCost = 0;

  const sources = [];
  for (let f = 0; f < nT; f++) {
    if (curl[f] !== 0 && !(free && free[f])) sources.push(f);
  }

  for (const s of sources) {
    while (curl[s] !== 0 && !(free && free[s])) {
      const want = Math.sign(curl[s]);
      dist.fill(Infinity);
      fromEdge.fill(-1);
      fromFace.fill(-1);
      dist[s] = 0;
      // small graph, few units: a linear-scan Dijkstra is simpler than a heap
      // and its determinism is easier to argue about (see spine/random.js on why
      // tie order is load-bearing in this app).
      const done = new Uint8Array(nT + 1);
      let sink = -1;
      for (;;) {
        let u = -1, best = Infinity;
        for (let i = 0; i <= nT; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0) break;
        done[u] = 1;
        if (u === OUT) { sink = OUT; break; }
        if (u !== s && (curl[u] === 0 ? false : Math.sign(curl[u]) === -want)) { sink = u; break; }
        for (let k = 0; k < 3; k++) {
          const e = faceEdge[3 * u + k];
          const v = eFaceA[e] === u ? eFaceB[e] : eFaceA[e];
          const delta = -want * faceSign[3 * u + k];
          // Clamped at zero so Dijkstra stays valid. A flip can genuinely
          // IMPROVE the rounding once pass 1 has already moved that edge off
          // round(g), which would be a negative cost; treating it as free is a
          // small pessimism and keeps the shortest-path argument sound.
          const c = Math.max(0, stepCost(e, delta));
          // v < 0 means e is on the hull: crossing it sends the unit off the
          // page, which is a legitimate destination rather than a dead end.
          const t = v < 0 ? OUT : v;
          if (done[t]) continue;
          if (dist[u] + c < dist[t]) {
            dist[t] = dist[u] + c; fromFace[t] = u; fromEdge[t] = e;
          }
        }
      }
      // Nowhere to send it, or nowhere cheap enough: keep the curl and draw a
      // stripe ending. The comparison against defectPrice is the whole control.
      if (sink < 0 || dist[sink] > defectPrice) break;
      totalCost += dist[sink];

      // Walk back, applying the flips. OUT is reached through a real boundary
      // edge, so it needs no special case: fromEdge[OUT] is that edge and
      // fromFace[OUT] the face it leaves, and the loop flips it like any other.
      let cur = sink;
      while (cur !== s && cur >= 0) {
        const p = fromFace[cur], e = fromEdge[cur];
        if (p < 0 || e < 0) break;
        let sp = 0;
        for (let k = 0; k < 3; k++) if (faceEdge[3 * p + k] === e) sp = faceSign[3 * p + k];
        const delta = -want * sp;
        m[e] += delta;
        curl[p] += sp * delta;
        const other = eFaceA[e] === p ? eFaceB[e] : eFaceA[e];
        if (other >= 0) curl[other] -= sp * delta;
        cur = p;
      }
    }
  }

  const residual = new Int32Array(nT);
  let nOpen = 0;
  for (let f = 0; f < nT; f++) {
    residual[f] = curlOf(m, mesh, f);
    if (residual[f] !== 0) nOpen++;
  }
  return { m, residual, nOpen, cost: totalCost };
}
