// Port of simplifyLineArea.m (Visvalingam) and simplifyLineDistance.m.
// Threshold is Amin = Lscale^2, exactly as the MATLAB (line 20).

/** Triangle area for the point at i, using its neighbours. */
function triArea(pts, i1, i2, i3) {
  const ax = pts[i1][0] - pts[i3][0], ay = pts[i1][1] - pts[i3][1];
  const bx = pts[i2][0] - pts[i3][0], by = pts[i2][1] - pts[i3][1];
  return Math.abs(0.5 * (ax * by - ay * bx));
}

/**
 * Binary min-heap over (area, index, stamp) triples, with lazy invalidation:
 * a node whose area has been recomputed is re-pushed with a new stamp, and the
 * stale entry is skipped when it surfaces.
 *
 * Allocation-free on the hot path, which is the reason for the shape below: this
 * runs on single paths of 100k+ points, so a destructuring swap or an object
 * returned per pop is paid hundreds of thousands of times. `pop()` writes the top
 * into `topA/topI/topS` rather than returning it, and the swaps use scalar
 * temporaries.
 *
 * Tie order is load-bearing: `simplifyLineArea` removes points in heap order, so
 * equal keys popping in a different order changes which points survive. See
 * docs/architecture.md on why unifying this with geodesic.js's heap is a
 * separate, measurable change.
 */
class MinHeap {
  constructor() {
    this.a = []; this.i = []; this.s = [];
    this.topA = 0; this.topI = 0; this.topS = 0;
  }
  get size() { return this.a.length; }
  push(a, i, s) {
    const A = this.a, I = this.i, S = this.s;
    A.push(a); I.push(i); S.push(s);
    let c = A.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (A[p] <= A[c]) break;
      const ta = A[p]; A[p] = A[c]; A[c] = ta;
      const ti = I[p]; I[p] = I[c]; I[c] = ti;
      const ts = S[p]; S[p] = S[c]; S[c] = ts;
      c = p;
    }
  }
  /** Removes the minimum and leaves it in topA/topI/topS. */
  pop() {
    const A = this.a, I = this.i, S = this.s;
    this.topA = A[0]; this.topI = I[0]; this.topS = S[0];
    const lastA = A.pop(), lastI = I.pop(), lastS = S.pop();
    if (A.length > 0) {
      A[0] = lastA; I[0] = lastI; S[0] = lastS;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < A.length && A[l] < A[m]) m = l;
        if (r < A.length && A[r] < A[m]) m = r;
        if (m === p) break;
        const ta = A[p]; A[p] = A[m]; A[m] = ta;
        const ti = I[p]; I[p] = I[m]; I[m] = ti;
        const ts = S[p]; S[p] = S[m]; S[m] = ts;
        p = m;
      }
    }
  }
}

/**
 * simplifyLineArea.m -- remove points forming the flattest triangles until
 * none is below Lscale^2. Endpoints are never removed.
 *
 * Heap-based, O(n log n). The obvious implementation rescans for the minimum on
 * every removal, which is O(n^2) -- fine for the two-point segments hatching
 * produces, fatal for sfcCollapse, which returns a single path of 100k+ points.
 */
export function simplifyLineArea(points, Lscale) {
  const n = points.length;
  if (n < 3) return points.slice();
  const Amin = Lscale * Lscale;

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  const area = new Float64Array(n);
  const stamp = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1 < n ? i + 1 : -1;
  }

  const heap = new MinHeap();
  for (let i = 1; i < n - 1; i++) {
    area[i] = triArea(points, i - 1, i, i + 1);
    heap.push(area[i], i, 0);
  }

  let count = n;
  // `count > 2`, not `> 3`. Endpoints are never pushed onto the heap (the seed
  // loop runs i = 1 .. n-2), so they cannot be removed however low the threshold
  // goes; a tighter guard would refuse the last valid removal and leave a
  // spurious middle point on a path that should collapse to a straight line.
  while (heap.size > 0 && count > 2) {
    heap.pop();
    const a = heap.topA, i = heap.topI, s = heap.topS;
    if (!alive[i] || s !== stamp[i]) continue;   // stale entry
    if (a >= Amin) break;                        // heap min is the global min

    alive[i] = 0;
    count--;
    const p = prev[i], q = next[i];
    if (p >= 0) next[p] = q;
    if (q >= 0) prev[q] = p;

    // p then q, in that order: the two neighbours are re-pushed with fresh
    // stamps and heap order decides what survives. An index loop rather than
    // `for (const j of [p, q])`, which would allocate a pair per removal.
    for (let k = 0; k < 2; k++) {
      const j = k === 0 ? p : q;
      if (j <= 0 || j >= n - 1 || !alive[j]) continue;
      if (prev[j] < 0 || next[j] < 0) continue;
      area[j] = triArea(points, prev[j], j, next[j]);
      stamp[j]++;
      heap.push(area[j], j, stamp[j]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (alive[i]) out.push(points[i]);
  return out;
}

/**
 * simplifyLineDistance.m -- greedily remove the point whose removal costs the
 * least perpendicular deviation, until the cheapest removal would exceed
 * Lscale. Endpoints are never removed. Same shape as simplifyLineArea above,
 * with perpendicular distance in place of triangle area.
 *
 * The cost is recomputed against the surviving neighbours, which is the whole
 * mechanism: as points are removed the chords lengthen, so the remaining points'
 * costs grow, and that is what eventually stops the loop. Measuring against a
 * fixed two-step chord instead never accumulates deviation and collapses a whole
 * contour to [first, last].
 *
 * With the cost measured this way that collapse is impossible. When one interior
 * point is left on a closed loop its neighbours are the coincident endpoints, so
 * the chord has zero length and the cost is the distance to that point —
 * enormous, never removed.
 */
export function simplifyLineDistance(points, Lscale) {
  const n = points.length;
  if (n < 3) return points.slice();

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  const dist = new Float64Array(n);
  const stamp = new Int32Array(n);
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  next[n - 1] = -1;

  const perp = (i) => {
    const a = points[prev[i]], b = points[next[i]], p = points[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    return len === 0
      ? Math.hypot(p[0] - a[0], p[1] - a[1])
      : Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
  };

  const heap = new MinHeap();
  for (let i = 1; i < n - 1; i++) {
    dist[i] = perp(i);
    heap.push(dist[i], i, 0);
  }

  while (heap.size > 0) {
    heap.pop();
    const a = heap.topA, i = heap.topI, s = heap.topS;
    if (!alive[i] || s !== stamp[i]) continue;      // stale entry
    if (a >= Lscale) break;                          // cheapest is now too dear
    alive[i] = 0;
    const p = prev[i], q = next[i];
    next[p] = q;
    prev[q] = p;
    for (let k = 0; k < 2; k++) {
      const j = k === 0 ? p : q;
      if (j <= 0 || j >= n - 1 || !alive[j]) continue;
      dist[j] = perp(j);
      stamp[j]++;
      heap.push(dist[j], j, stamp[j]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (alive[i]) out.push(points[i]);
  return out;
}

/**
 * Apply the area simplifier across a set of polylines, dropping degenerate
 * results. Callers wanting the distance variant call simplifyLineDistance
 * directly, as eikonalStripes does.
 */
export function simplifyAll(lines, Lscale) {
  const out = [];
  for (const line of lines) {
    if (line.length <= 2) { out.push(line); continue; }
    const s = simplifyLineArea(line, Lscale);
    if (s.length >= 2) out.push(s);
  }
  return out;
}
