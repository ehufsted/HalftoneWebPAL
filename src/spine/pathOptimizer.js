// Port of pathOptimizer.m (path mode) + pathOptimizerFromLines.m + joinCoincidentLines.m.
//
// The MATLAB's non-loop segment branch (lines 268-297) is a greedy
// nearest-endpoint selection sort: from the end of the current segment, find the
// closest endpoint among all remaining segments, swap it into place, and reverse
// it if the match was its far end. Reproduced here, with the spatial hash the
// MATLAB gates behind >10k points (findNearestHashPoint.m) always on, since it
// only changes speed and not the result.
//
// Order matters: optimise first, THEN join. joinCoincidentLines only chains in
// the order it is given.

/**
 * Endpoints closer than this many pen widths are the same point. A method asks
 * for it by exporting `maxJoinPens`; the pipeline's default of 1.5 is the looser
 * reading. The two answer different questions:
 *
 *   1.5  "these are two ends of one interrupted stroke, so close the gap" —
 *        right for a network method, where joining at a shared vertex is what
 *        the corner is for, and where the slop absorbs the clip and the trim.
 *   0.05 "these are the same point" — right for any method whose strokes are
 *        separate marks by construction. `joinCoincidentLines` appends the next
 *        path from its second point, so the pen draws the gap it bridges; for a
 *        hatching or dashed method that gap is exactly where the tone model said
 *        there should be no ink.
 *
 * parallelHatching (candidates one pen width apart), dashHatching (spacing
 * control flooring at one pen width) and dashedStreamlines (neighbours traced in
 * arbitrary directions, so a weld can be a 177-degree reversal) all need the
 * tight value.
 *
 * It is deliberately not derived from any spacing: a bound computed from a
 * method's own geometry goes stale when that geometry changes — half the carrier
 * spacing is correct for straight carriers and wrong for curved ones. This one
 * only has to absorb rounding through the clip and the trim.
 */
export const COINCIDENT_PENS = 0.05;

/** Uniform grid over segment endpoints, supporting removal. */
class EndpointGrid {
  constructor(items, targetPerCell = 4) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const it of items) {
      for (const [x, y] of [it.a, it.b]) {
        if (x < xmin) xmin = x;
        if (y < ymin) ymin = y;
        if (x > xmax) xmax = x;
        if (y > ymax) ymax = y;
      }
    }
    const w = Math.max(1e-9, xmax - xmin);
    const h = Math.max(1e-9, ymax - ymin);
    const nCells = Math.max(1, Math.round(items.length / targetPerCell));
    // Clamp to nCells in each axis. A degenerate bounding box — every endpoint
    // sharing a y, which an all-horizontal drawing produces — otherwise gives
    // h = 1e-9 and an nx of order sqrt(nCells * w * 1e9), around a million
    // columns for a thousand strokes, after which `nearest` expands up to
    // `maxRing` rings per query and the optimiser hangs.
    this.nx = Math.min(nCells, Math.max(1, Math.round(Math.sqrt((nCells * w) / h))));
    this.ny = Math.min(nCells, Math.max(1, Math.round(nCells / this.nx)));
    this.minx = xmin; this.miny = ymin;
    this.dx = w / this.nx; this.dy = h / this.ny;
    // The smaller cell dimension, since this is a lower bound on how far away
    // ring r can be: a point in ring r is at least (r-1) cells away along one
    // axis, so the guaranteed distance is (r-1)*min(dx,dy). Using the max
    // overstates it and lets `nearest` stop early. Cells are only square when
    // the bounding box happens to match nx/ny.
    this.cell = Math.min(this.dx, this.dy);
    this.bins = new Map();
    for (const it of items) this.insert(it);
  }

  key(ix, iy) { return iy * this.nx + ix; }

  cellOf(x, y) {
    const ix = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minx) / this.dx)));
    const iy = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.miny) / this.dy)));
    return [ix, iy];
  }

  insert(item) {
    for (const p of [item.a, item.b]) {
      const [ix, iy] = this.cellOf(p[0], p[1]);
      const k = this.key(ix, iy);
      let bin = this.bins.get(k);
      if (!bin) { bin = new Set(); this.bins.set(k, bin); }
      bin.add(item);
    }
  }

  remove(item) {
    for (const p of [item.a, item.b]) {
      const [ix, iy] = this.cellOf(p[0], p[1]);
      const bin = this.bins.get(this.key(ix, iy));
      if (bin) bin.delete(item);
    }
  }

  /** Nearest remaining item to (x,y); returns {item, reversed}. */
  nearest(x, y) {
    const [cx, cy] = this.cellOf(x, y);
    let best = null, bestD = Infinity, bestRev = false;
    const maxRing = Math.max(this.nx, this.ny);
    for (let r = 0; r <= maxRing; r++) {
      // once the ring's minimum possible distance exceeds the best found, stop
      if (best && (r - 1) * this.cell > Math.sqrt(bestD)) break;
      for (let iy = cy - r; iy <= cy + r; iy++) {
        if (iy < 0 || iy >= this.ny) continue;
        const edgeRow = iy === cy - r || iy === cy + r;
        for (let ix = cx - r; ix <= cx + r; ix++) {
          if (ix < 0 || ix >= this.nx) continue;
          if (!edgeRow && ix !== cx - r && ix !== cx + r) continue; // ring only
          const bin = this.bins.get(this.key(ix, iy));
          if (!bin) continue;
          for (const it of bin) {
            const da = (it.a[0] - x) ** 2 + (it.a[1] - y) ** 2;
            const db = (it.b[0] - x) ** 2 + (it.b[1] - y) ** 2;
            const d = Math.min(da, db);
            if (d < bestD) { bestD = d; best = it; bestRev = db < da; }
          }
        }
      }
    }
    return best ? { item: best, reversed: bestRev } : null;
  }
}

/**
 * Reorder polylines (reversing where it helps) to minimise pen-up travel.
 * @param {Array<Array<[number,number]>>} lines
 * @param {[number,number]} [start] pen home position
 */
export function optimizeOrder(lines, start = [0, 0]) {
  const items = lines
    .filter((l) => l && l.length > 0)
    .map((l, i) => ({ i, line: l, a: l[0], b: l[l.length - 1] }));
  // The filtered lines, not the originals: an empty polyline surviving this
  // short-circuit reaches joinCoincidentLines, which reads `cur[cur.length - 1]`
  // and throws. Empty lines carry no ink, so both paths drop them.
  if (items.length < 2) return items.map((it) => it.line);

  const grid = new EndpointGrid(items);
  const out = [];
  let cur = start;
  let remaining = items.length;
  while (remaining > 0) {
    const hit = grid.nearest(cur[0], cur[1]);
    if (!hit) break;
    grid.remove(hit.item);
    remaining--;
    const line = hit.reversed ? hit.item.line.slice().reverse() : hit.item.line;
    out.push(line);
    cur = line[line.length - 1];
  }
  return out;
}

/**
 * joinCoincidentLines.m -- chain consecutive polylines whose endpoints touch.
 * Must run after optimizeOrder.
 */
export function joinCoincidentLines(lines, minDist) {
  // Filtered rather than trusting optimizeOrder to have done it: the seed below
  // slices `src[0]` unguarded, so one empty polyline here is a throw.
  const src = lines.filter((l) => l && l.length > 0);
  if (src.length === 0) return [];
  const out = [];
  let cur = src[0].slice();
  const tol2 = minDist * minDist;
  for (let i = 1; i < src.length; i++) {
    const line = src[i];
    const end = cur[cur.length - 1];
    const d2 = (end[0] - line[0][0]) ** 2 + (end[1] - line[0][1]) ** 2;
    // A single-point path is a dot and can never be joined: the append loop
    // starts at k = 1, so a one-point line would copy nothing and the dot would
    // be absorbed into `cur` and silently deleted. stippleGrowing and ditherGrid
    // both emit one-point paths at their smallest dot size, and optimizeOrder
    // puts near items next to each other, so the test passes constantly.
    if (d2 < tol2 && line.length > 1) {
      for (let k = 1; k < line.length; k++) cur.push(line[k]);
    } else {
      out.push(cur);
      cur = line.slice();
    }
  }
  out.push(cur);
  return out;
}
