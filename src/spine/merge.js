// Merge collinear, touching segments into single strokes.
//
// Quadtree-style methods emit two short segments per node, and many of them lie
// on the same line and meet end to end -- vertically stacked sibling blocks
// share a centre x, so their vertical arms are collinear and touching. Left
// alone that is hundreds of thousands of stubs, each costing a pen lift.
//
// joinCoincidentLines cannot do this: it only chains end-to-start in the order
// it is given, so it catches a few of these and misses most.

/**
 * @param {Array<Array<[number,number]>>} lines  polylines; only 2-point
 *        entries are considered, longer ones pass through untouched
 * @param {number} [gap]  segments closer than this along the line are joined
 * @param {number} [tol]  tolerance for deciding two segments share a line
 */
export function mergeCollinear(lines, gap = 1e-6, tol = 1e-4) {
  const segs = [];
  const others = [];
  for (const l of lines) {
    if (l && l.length === 2) segs.push(l); else if (l && l.length) others.push(l);
  }
  if (segs.length === 0) return lines.slice();

  // bucket by (direction mod pi, perpendicular offset)
  const buckets = new Map();
  for (const [a, b] of segs) {
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < tol) continue;              // degenerate
    dx /= len; dy /= len;
    // canonical direction: mod pi, so a segment and its reverse agree
    if (dx < -tol || (Math.abs(dx) <= tol && dy < 0)) { dx = -dx; dy = -dy; }

    const off = -dy * a[0] + dx * a[1];   // signed distance from origin
    const key = `${Math.round(Math.atan2(dy, dx) / tol)}|${Math.round(off / tol)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { dx, dy, off, spans: [] }; buckets.set(key, bucket); }

    const t1 = dx * a[0] + dy * a[1];
    const t2 = dx * b[0] + dy * b[1];
    bucket.spans.push(t1 < t2 ? [t1, t2] : [t2, t1]);
  }

  const out = others;
  for (const { dx, dy, off, spans } of buckets.values()) {
    spans.sort((p, q) => p[0] - q[0]);
    let [lo, hi] = spans[0];
    const flush = () => {
      // point at parameter t: t*direction + off*normal, normal = (-dy, dx)
      out.push([
        [lo * dx - off * dy, lo * dy + off * dx],
        [hi * dx - off * dy, hi * dy + off * dx],
      ]);
    };
    for (let i = 1; i < spans.length; i++) {
      const [s, e] = spans[i];
      if (s <= hi + gap) {
        if (e > hi) hi = e;               // overlapping or touching: extend
      } else {
        flush();
        lo = s; hi = e;
      }
    }
    flush();
  }
  return out;
}
