// Grey-weighted geodesic distance -- MATLAB's graydist, 'quasi-euclidean'.
//
// Despite the name, graydist is NOT fast marching. It is Dijkstra on the
// 8-connected pixel grid, where the cost of stepping between adjacent pixels p
// and q is the mean of their weights times the step length (1 orthogonally,
// sqrt(2) diagonally). That is exactly reproducible, which is why this is the
// faithful port rather than a solver for the eikonal PDE.
//
// What it costs: a grid graph cannot represent distance isotropically. With
// steps of (1, sqrt2), the cheapest path to a point at angle theta costs
// r*(cos t + (sqrt2-1) sin t) folded into 0..45 degrees, which peaks at
//
//     sqrt(1 + (sqrt2 - 1)^2) = 1.0824      i.e. +8.24%, at 22.5 degrees
//
// exact on the axes and the diagonals, and measured to match that curve to two
// decimals across ten angles.
//
// That is not cosmetic here: perpendicular spacing between contours is
// 2*pi/|grad P|, and |grad P| depends on the wavefront orientation — exactly w
// for an axis-aligned front, 1.0824w for one at 22.5 degrees. So 8-connected
// stripes run up to 8% tighter in the grid-diagonal directions: structured,
// axis-locked banding in a method whose whole claim is exact spacing.
//
// The fix is a bigger neighbourhood rather than a different algorithm. Adding the
// eight knight moves (length sqrt5) gives ray directions every ~26.6 degrees
// instead of every 45, and the same derivation gives a worst case of
//
//     sqrt(1 + (sqrt5 - 2)^2) = 1.02749     i.e. +2.75%, at ~13.3 degrees
//
// Since the ratio runs over [1, 1.0275] rather than straddling 1, scaling every
// edge by 2/(1+maxRatio) recentres it to +-1.36%. That factor is derived, not
// fitted. Fast marching remains the upgrade if even that shows, and drops in
// behind this same interface.
//
// Connectivity 8 with normalise:false reproduces MATLAB's graydist exactly, and
// is kept for that reason.

/** Binary min-heap over (key, value) pairs, with lazy deletion. */
function makeHeap(cap) {
  let k = new Float64Array(cap);
  let v = new Int32Array(cap);
  let n = 0;
  return {
    get size() { return n; },
    push(key, val) {
      if (n === k.length) {
        const k2 = new Float64Array(n * 2); k2.set(k); k = k2;
        const v2 = new Int32Array(n * 2); v2.set(v); v = v2;
      }
      let i = n++;
      k[i] = key; v[i] = val;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= k[i]) break;
        const tk = k[p]; k[p] = k[i]; k[i] = tk;
        const tv = v[p]; v[p] = v[i]; v[i] = tv;
        i = p;
      }
    },
    pop() {
      const top = v[0];
      n--;
      if (n > 0) {
        k[0] = k[n]; v[0] = v[n];
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let s = i;
          if (l < n && k[l] < k[s]) s = l;
          if (r < n && k[r] < k[s]) s = r;
          if (s === i) break;
          const tk = k[s]; k[s] = k[i]; k[i] = tk;
          const tv = v[s]; v[s] = v[i]; v[i] = tv;
          i = s;
        }
      }
      return top;
    },
    peekKey() { return k[0]; },
  };
}

const S2 = Math.SQRT2, S5 = Math.sqrt(5);

/**
 * Neighbourhoods and their worst-case distance ratio, from
 * max over t of (cos t + (step - k) sin t) within each ray sector.
 */
export const NEIGHBOURHOODS = {
  8: {
    dx: [-1, 0, 1, -1, 1, -1, 0, 1],
    dy: [-1, -1, -1, 0, 0, 1, 1, 1],
    len: [S2, 1, S2, 1, 1, S2, 1, S2],
    maxRatio: Math.sqrt(1 + (S2 - 1) * (S2 - 1)),        // 1.08239
  },
  16: {
    dx: [-1, 0, 1, -1, 1, -1, 0, 1, -1, 1, -2, 2, -2, 2, -1, 1],
    dy: [-1, -1, -1, 0, 0, 1, 1, 1, -2, -2, -1, -1, 1, 1, 2, 2],
    len: [S2, 1, S2, 1, 1, S2, 1, S2, S5, S5, S5, S5, S5, S5, S5, S5],
    maxRatio: Math.sqrt(1 + (S5 - 2) * (S5 - 2)),        // 1.02749
  },
};

/**
 * @param {ArrayLike<number>} weight  cost per unit length, one per pixel
 * @param {number} w,h                grid size
 * @param {ArrayLike<number>} seeds   truthy where distance is 0
 * @param {object} [opts]
 * @param {ArrayLike<number>} [opts.mask]  0 marks impassable pixels
 * @param {8|16} [opts.connectivity]  default 16; 8 + normalise:false is graydist
 * @param {boolean} [opts.normalise]  default true; recentres the ratio on 1
 * @returns {Float64Array} distance, Infinity where unreachable
 */
export function grayDist(weight, w, h, seeds, opts = {}) {
  const mask = opts.mask || null;
  const nb = NEIGHBOURHOODS[opts.connectivity === 8 ? 8 : 16];
  const NDX = nb.dx, NDY = nb.dy, NK = nb.dx.length;
  // recentre the [1, maxRatio] error band on 1, halving the worst case
  const scale = opts.normalise === false ? 1 : 2 / (1 + nb.maxRatio);
  const NLEN = nb.len.map((v) => v * scale);
  const n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  const settled = new Uint8Array(n);
  const heap = makeHeap(Math.max(64, Math.min(n, 1 << 16)));

  for (let i = 0; i < n; i++) {
    if (!seeds[i]) continue;
    if (mask && !mask[i]) continue;
    dist[i] = 0;
    heap.push(0, i);
  }

  while (heap.size > 0) {
    const key = heap.peekKey();
    const c = heap.pop();
    if (settled[c]) continue;         // lazy deletion: a stale entry
    if (key > dist[c]) continue;
    settled[c] = 1;

    const cy = (c / w) | 0, cx = c - cy * w;
    const wc = weight[c];
    for (let k = 0; k < NK; k++) {
      const ddx = NDX[k], ddy = NDY[k];
      const nx2 = cx + ddx, ny2 = cy + ddy;
      if (nx2 < 0 || ny2 < 0 || nx2 >= w || ny2 >= h) continue;
      const m = ny2 * w + nx2;
      if (settled[m]) continue;
      if (mask && !mask[m]) continue;
      // A knight move spans two cells, so with a mask it could otherwise jump a
      // barrier. Require the cells it passes between to be passable too.
      if (mask && (ddx * ddx + ddy * ddy) > 2) {
        // Blocked if EITHER intermediate is impassable. A knight move is cheaper
        // than any 8-connected way round a one-cell barrier (sqrt5 = 2.236
        // against 1 + sqrt2 = 2.414), so a laxer test would make the wavefront
        // prefer exactly the illegal path.
        const sx = Math.sign(ddx), sy = Math.sign(ddy);
        if (!mask[(cy + sy) * w + cx] || !mask[cy * w + (cx + sx)]) continue;
      }
      // graydist's edge cost: mean of the endpoint weights, times step length
      const step = ((wc + weight[m]) / 2) * NLEN[k];
      const nd = dist[c] + step;
      if (nd < dist[m]) {
        dist[m] = nd;
        heap.push(nd, m);
      }
    }
  }
  return dist;
}

/**
 * Convenience for the common case: distance with unit weights, i.e. the
 * quasi-euclidean chamfer distance. Exists so the harness can characterise the
 * grid's anisotropy against a closed-form answer.
 */
export function chamferDist(w, h, seeds, opts = {}) {
  const ones = new Float64Array(w * h).fill(1);
  return grayDist(ones, w, h, seeds, opts);
}

/**
 * Worst-case relative distance error for a neighbourhood, from the closed form
 * above. The harness compares the measurement against this rather than against
 * a remembered number.
 */
export function anisotropyBound(connectivity = 16, normalise = true) {
  const r = NEIGHBOURHOODS[connectivity === 8 ? 8 : 16].maxRatio;
  return normalise ? (r - 1) / (r + 1) : r - 1;
}
