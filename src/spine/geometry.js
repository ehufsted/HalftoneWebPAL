// Geometry primitives.
// Ports of intersectLine.m, trimLineSegsToPolygon.m, pointOnSegClosestToPoint.m
// from singleWidthLines/code/.

import { inpolygon } from '../shim/image.js';

/**
 * intersectLine.m -- segment/segment intersection.
 * line = [x1, y1, x2, y2]. Returns null or [x, y].
 */
export function intersectLine(line1, line2) {
  const [x1a, y1a, x1b, y1b] = line1;
  const [x2a, y2a, x2b, y2b] = line2;
  const den = -(x2a - x2b) * (y1a - y1b) + (x1a - x1b) * (y2a - y2b);
  if (den === 0) return null;
  const t1 = (x2b * (y1a - y2a) + x1a * (y2a - y2b) + x2a * (-y1a + y2b)) / den;
  const t2 = (x2a * (y1a - y1b) + x1a * (y1b - y2a) + x1b * (-y1a + y2a)) / -den;
  if (!(isFinite(t1) && isFinite(t2))) return null;
  if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) return null;
  return [x1a + (x1b - x1a) * t1, y1a + (y1b - y1a) * t1];
}

/**
 * trimLineSegsToPolygon.m -- clip segments to a polygon, keeping the inside
 * pieces. `lines` is an array of [x1,y1,x2,y2].
 */
export function trimLineSegsToPolygon(lines, px, py) {
  const np = px.length;
  const out = [];
  for (const line1 of lines) {
    const pts = [[line1[0], line1[1]], [line1[2], line1[3]]];
    for (let iP = 0; iP < np; iP++) {
      const iP2 = (iP + 1) % np;
      const hit = intersectLine(line1, [px[iP], py[iP], px[iP2], py[iP2]]);
      if (hit) pts.push(hit);
    }
    let ordered = pts;
    if (pts.length > 2) {
      // round to 10 decimals + unique, as the MATLAB does, so a crossing that
      // lands exactly on an endpoint does not produce a zero-length piece
      const seen = new Map();
      for (const p of pts) {
        const key = `${p[0].toFixed(10)},${p[1].toFixed(10)}`;
        if (!seen.has(key)) seen.set(key, p);
      }
      ordered = [...seen.values()].sort((a, b) => {
        const da = (a[0] - line1[0]) ** 2 + (a[1] - line1[1]) ** 2;
        const db = (b[0] - line1[0]) ** 2 + (b[1] - line1[1]) ** 2;
        return da - db;
      });
    }
    for (let j = 0; j < ordered.length - 1; j++) {
      const a = ordered[j], b = ordered[j + 1];
      if (inpolygon((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, px, py)) {
        out.push([a[0], a[1], b[0], b[1]]);
      }
    }
  }
  return out;
}

/** True if the vertex list turns the same way all the way round. */
export function isConvex(px, py) {
  const n = px.length;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = (i + 1) % n, b = (i + 2) % n;
    const cross = (px[a] - px[i]) * (py[b] - py[a]) - (py[a] - py[i]) * (px[b] - px[a]);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/**
 * Clip a POLYLINE to a polygon, returning the inside runs.
 *
 * `trimLineSegsToPolygon` above handles loose segments; this keeps a path's
 * ordering, which matters for anything drawn as a continuous stroke. Shared by
 * wigglyLines (modulated carriers) and eikonalStripes (contours).
 *
 * These are very long point lists -- tens of thousands of samples -- and running
 * the full segment/polygon intersection on every one of them dominates the
 * caller. On a CONVEX polygon a segment with both endpoints inside cannot leave,
 * so those skip straight through; the general path still runs for everything
 * else, and for every segment when the polygon is not convex. Convexity is
 * tested, not assumed.
 */
export function clipPolyline(pts, px, py) {
  const runs = [];
  const convex = isConvex(px, py);
  const inside = convex ? pts.map((p) => inpolygon(p[0], p[1], px, py)) : null;
  let cur = [];
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (convex && inside[i] && inside[i + 1]) {
      if (cur.length === 0) cur.push(a);
      cur.push(b);
      continue;
    }
    const pieces = trimLineSegsToPolygon([[a[0], a[1], b[0], b[1]]], px, py);
    if (pieces.length === 0) { flush(); continue; }
    for (const [x1, y1, x2, y2] of pieces) {
      if (cur.length === 0) cur.push([x1, y1]);
      else {
        const last = cur[cur.length - 1];
        if (Math.hypot(last[0] - x1, last[1] - y1) > 1e-9) { flush(); cur.push([x1, y1]); }
      }
      cur.push([x2, y2]);
    }
  }
  flush();
  return runs;
}

/** pointOnSegClosestToPoint.m, returning the squared distance. */
export function distToSegmentSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = x1 + dx * t, cy = y1 + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** Total drawn length of a set of polylines. */
export function pathLength(lines) {
  let total = 0;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      total += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    }
  }
  return total;
}

/** Pen-up travel: the distance between the end of one path and the start of the next. */
export function travelLength(lines, start = [0, 0]) {
  let total = 0;
  let cur = start;
  for (const line of lines) {
    if (!line.length) continue;
    total += Math.hypot(line[0][0] - cur[0], line[0][1] - cur[1]);
    cur = line[line.length - 1];
  }
  return total;
}
