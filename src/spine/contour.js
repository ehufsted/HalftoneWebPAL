// Marching squares with contour linking.
//
// crosshatchQuantized does without it: its contours are level sets of a linear
// ramp, so a run-walk along each candidate line finds them. That does not
// generalise — for an arbitrary field the segments have to be generated per cell
// and then chained into ordered polylines.
//
// Crossings are identified by GRID EDGE, not by coordinate. Every crossing lies
// on one horizontal or vertical edge between adjacent samples, and an interior
// edge is shared by exactly two cells -- so linking is exact integer bookkeeping
// with no floating-point point-matching and no tolerance to tune. That is the
// whole reason this is tractable to get right.

/**
 * Segment list per marching-squares case, as pairs of edge slots.
 * Slots: 0 = top, 1 = right, 2 = bottom, 3 = left.
 * Case bits: 1 = top-left above, 2 = top-right, 4 = bottom-right, 8 = bottom-left.
 * Cases 5 and 10 are the saddles and are resolved at run time from the centre.
 */
const CASES = [
  [],            // 0  ....
  [[3, 0]],      // 1  TL
  [[0, 1]],      // 2  TR
  [[3, 1]],      // 3  TL TR
  [[1, 2]],      // 4  BR
  null,          // 5  TL BR      saddle
  [[0, 2]],      // 6  TR BR
  [[3, 2]],      // 7  TL TR BR
  [[2, 3]],      // 8  BL
  [[0, 2]],      // 9  TL BL
  null,          // 10 TR BL      saddle
  [[1, 2]],      // 11 TL TR BL
  [[3, 1]],      // 12 BR BL
  [[0, 1]],      // 13 TL BR BL
  [[3, 0]],      // 14 TR BR BL
  [],            // 15 all
];

// Saddle resolutions. When the cell centre is on the same side as a pair of
// diagonal corners, that pair is connected through the middle and the contour
// wraps the two lone corners separately.
const SADDLE_5_HI = [[0, 1], [2, 3]];
const SADDLE_5_LO = [[3, 0], [1, 2]];
const SADDLE_10_HI = [[3, 0], [1, 2]];
const SADDLE_10_LO = [[0, 1], [2, 3]];

/** Reusable buffers, so contouring sixty levels does not allocate sixty times. */
export function createContourWorkspace(w, h) {
  const nH = h * (w - 1);
  const nE = nH + (h - 1) * w;
  return {
    w, h, nH, nE,
    px: new Float64Array(nE),
    py: new Float64Array(nE),
    stamp: new Int32Array(nE),
    visit: new Int32Array(nE),
    link0: new Int32Array(nE),
    link1: new Int32Array(nE),
    active: new Int32Array(nE),
    epoch: 0,
  };
}

/**
 * One level. Returns closed loops with their first point repeated at the end,
 * and open polylines (which reach the grid border) without.
 *
 * @param {ArrayLike<number>} field  row-major, w*h
 * @param {number} level
 * @param {object} ws  from createContourWorkspace
 * @returns {Array<Array<[number,number]>>} polylines in 1-based pixel coords
 */
export function contourLevel(field, level, ws) {
  const { w, h, nH, px, py, stamp, visit, link0, link1, active } = ws;
  const ep = ++ws.epoch;
  let nActive = 0;

  const hid = (i, j) => i * (w - 1) + j;
  const vid = (i, j) => nH + i * w + j;

  const place = (id) => {
    if (stamp[id] === ep) return;
    stamp[id] = ep;
    link0[id] = -1;
    link1[id] = -1;
    active[nActive++] = id;
    if (id < nH) {
      const i = (id / (w - 1)) | 0, j = id % (w - 1);
      const a = field[i * w + j], b = field[i * w + j + 1];
      let t = (level - a) / (b - a);
      if (!isFinite(t)) t = 0.5;
      px[id] = j + 1 + Math.min(1, Math.max(0, t));
      py[id] = i + 1;
    } else {
      const k = id - nH;
      const i = (k / w) | 0, j = k % w;
      const a = field[i * w + j], b = field[(i + 1) * w + j];
      let t = (level - a) / (b - a);
      if (!isFinite(t)) t = 0.5;
      px[id] = j + 1;
      py[id] = i + 1 + Math.min(1, Math.max(0, t));
    }
  };

  const join = (a, b) => {
    if (link0[a] === -1) link0[a] = b; else if (link1[a] === -1) link1[a] = b;
    if (link0[b] === -1) link0[b] = a; else if (link1[b] === -1) link1[b] = a;
  };

  for (let i = 0; i < h - 1; i++) {
    for (let j = 0; j < w - 1; j++) {
      const tl = field[i * w + j];
      const tr = field[i * w + j + 1];
      const br = field[(i + 1) * w + j + 1];
      const bl = field[(i + 1) * w + j];
      let idx = 0;
      if (tl >= level) idx |= 1;
      if (tr >= level) idx |= 2;
      if (br >= level) idx |= 4;
      if (bl >= level) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      let segs = CASES[idx];
      if (segs === null) {
        const centreHigh = (tl + tr + br + bl) / 4 >= level;
        segs = idx === 5
          ? (centreHigh ? SADDLE_5_HI : SADDLE_5_LO)
          : (centreHigh ? SADDLE_10_HI : SADDLE_10_LO);
      }

      const slot = [hid(i, j), vid(i, j + 1), hid(i + 1, j), vid(i, j)];
      for (let s = 0; s < segs.length; s++) {
        const a = slot[segs[s][0]], b = slot[segs[s][1]];
        place(a); place(b);
        join(a, b);
      }
    }
  }

  // --- trace. Open runs first, from their endpoints, so a polyline that meets
  // the border is not started in the middle and split into two.
  const out = [];
  const walk = (start) => {
    const poly = [];
    let cur = start, prev = -1;
    for (;;) {
      visit[cur] = ep;
      poly.push([px[cur], py[cur]]);
      const nxt = link0[cur] === prev ? link1[cur] : link0[cur];
      if (nxt === -1) break;
      if (visit[nxt] === ep) {
        if (nxt === start) poly.push([px[start], py[start]]);  // closed loop
        break;
      }
      prev = cur;
      cur = nxt;
    }
    if (poly.length > 1) out.push(poly);
  };

  for (let k = 0; k < nActive; k++) {
    const id = active[k];
    if (visit[id] === ep) continue;
    if (link1[id] === -1) walk(id);          // degree 1: an open end
  }
  for (let k = 0; k < nActive; k++) {
    const id = active[k];
    if (visit[id] === ep) continue;
    walk(id);                                 // whatever is left is a loop
  }
  return out;
}
