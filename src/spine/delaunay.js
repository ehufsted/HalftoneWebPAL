// Delaunay triangulation, Bowyer-Watson.
//
// Not dualised from the Voronoi cells regions.js already builds, though two seeds
// are Delaunay neighbours exactly when their cells share an edge: clipHalfPlane
// does not record which seed produced each surviving edge, so the adjacency would
// have to be threaded through a shared primitive, and recovering triangles would
// then rest on separately-clipped cells agreeing on a vertex position to the last
// bit. Bowyer-Watson is self-contained and has a definitional test — no triangle's
// circumcircle may contain any other point — which at the couple of hundred points
// used here is exhaustive and instant.
//
// The two structures being independent is worth something on its own: the Delaunay
// edge count and the distinct shared boundaries of the Voronoi cells must agree, a
// cross-check between two things computed different ways.
//
// Adjacency is carried for the stripe methods, which treat stripe continuity
// across a triangulation as an integer edge-matching condition. Tiling does not
// need it; building the neighbour indices costs one hash pass.

/**
 * Is q strictly inside the circumcircle of the COUNTER-CLOCKWISE triangle abc?
 *
 * The determinant form, translated to q, rather than comparing |q - centre|
 * against the circumradius. The centre involves a division by
 * 2*(ax(by-cy) + ...) that goes to zero for a thin triangle, and the coordinates
 * fed to it include the super-triangle's, twenty times the page span; above about
 * 1500 points that finds the cavity for a new point incorrectly, drops triangles,
 * and leaves the network 29% short of its own dual's length.
 *
 * This form has everything relative to q, so magnitudes are the size of a
 * triangle rather than of the page, and there is no division. It needs the
 * triangle wound counter-clockwise, which is why every triangle below is
 * oriented on creation rather than at the end.
 */
function inCircle(ax, ay, bx, by, cx, cy, qx, qy) {
  const adx = ax - qx, ady = ay - qy;
  const bdx = bx - qx, bdy = by - qy;
  const cdx = cx - qx, cdy = cy - qy;
  const ad = adx * adx + ady * ady;
  const bd = bdx * bdx + bdy * bdy;
  const cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy)
       - ady * (bdx * cd - bd * cdx)
       + ad * (bdx * cdy - bdy * cdx);
}

/** Twice the signed area; positive for a counter-clockwise winding. */
function cross2(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @returns {{tris:Int32Array, nbr:Int32Array, n:number, dropped:number,
 *           repaired:number, malformed:number}} `tris` is 3 vertex
 *          indices per triangle; `nbr` is 3 triangle indices per triangle, -1
 *          where the edge is on the hull. nbr[3t+k] is the triangle across the
 *          edge OPPOSITE vertex tris[3t+k], the usual convention.
 */
export function triangulate(xs, ys) {
  const n = xs.length;
  if (n < 3) {
    return { tris: new Int32Array(0), nbr: new Int32Array(0), n: 0, dropped: 0, repaired: 0, malformed: 0 };
  }

  // super-triangle, big enough that its vertices are never inside any real
  // circumcircle. Points 0..n-1 are real; n, n+1, n+2 are the super-triangle.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < x0) x0 = xs[i];
    if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i];
    if (ys[i] > y1) y1 = ys[i];
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const R = Math.max(x1 - x0, y1 - y0, 1e-6) * 20;
  const px = new Float64Array(n + 3), py = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) { px[i] = xs[i]; py[i] = ys[i]; }
  px[n] = mx - R; py[n] = my - R;
  px[n + 1] = mx + R; py[n + 1] = my - R;
  px[n + 2] = mx; py[n + 2] = my + R;

  // Live triangles as flat triples, kept COUNTER-CLOCKWISE throughout so the
  // in-circle determinant can be read without re-deriving an orientation.
  let tv = [];
  {
    const a = n, b = n + 1, c = n + 2;
    if (cross2(px[a], py[a], px[b], py[b], px[c], py[c]) > 0) tv = [a, b, c];
    else tv = [a, c, b];
  }

  const bad = [];
  const edges = [];
  let dropped = 0;
  let repaired = 0;
  let malformed = 0;
  const depth = [];
  for (let i = 0; i < n; i++) {
    const qx = px[i], qy = py[i];
    bad.length = 0;
    depth.length = 0;
    const nT0 = tv.length / 3;
    for (let t = 0; t < nT0; t++) {
      const a = tv[3 * t], b = tv[3 * t + 1], c = tv[3 * t + 2];
      const v = inCircle(px[a], py[a], px[b], py[b], px[c], py[c], qx, qy);
      // TOLERANCE, and the perimeter ring is why it is here: evenly spaced
      // points along a straight edge are collinear and the four corners of a
      // rectangle are cocircular, which are precisely the cases where this test
      // is deciding between "on" and "just inside" the circle. Treating a point
      // on the circle as inside re-triangulates the neighbourhood, which is
      // harmless; the alternative -- treating it as outside -- leaves a hole.
      //
      // RELATIVE, not absolute. The determinant scales as the fourth power of
      // the distances involved, so a fixed 1e-9 is an exact predicate at one
      // scale and meaningless at another -- and an exact predicate in floating
      // point gets near-cocircular cases wrong by SIGN, which is what breaks the
      // cavity below.
      const ad = (px[a] - qx) ** 2 + (py[a] - qy) ** 2;
      const bd = (px[b] - qx) ** 2 + (py[b] - qy) ** 2;
      const cd = (px[c] - qx) ** 2 + (py[c] - qy) ** 2;
      const scale = ad + bd + cd;
      if (v > -1e-10 * scale * scale) { bad.push(t); depth.push(v); }
    }
    // A point inside the super-triangle is inside SOME circumcircle, so an empty
    // cavity means the test failed rather than that the point was redundant.
    // Counted rather than ignored: the caller can see it, and a nonzero count is
    // the first thing to look at if the mesh comes out short.
    if (bad.length === 0) { dropped++; continue; }

    // The cavity must be connected, which is what makes this survive at scale.
    // If floating point puts one distant triangle's circumcircle wrongly around
    // q, the bad set gains an island, its boundary is not a simple cycle, and
    // stitching q to it produces OVERLAPPING triangles — measured, that doubles
    // the distinct edge count (effective C reading 7.21 against 3.57) while the
    // Voronoi built from the same seeds stays correct.
    //
    // Keeping only the component containing the most deeply-containing triangle
    // discards exactly the islands. |bad| is a handful, so the quadratic
    // adjacency scan costs nothing.
    if (bad.length > 1) {
      let seed = 0;
      for (let k = 1; k < bad.length; k++) if (depth[k] > depth[seed]) seed = k;
      const shares = (p, q2) => {
        let hits = 0;
        for (let k = 0; k < 3; k++) {
          const u = tv[3 * bad[p] + k];
          for (let m = 0; m < 3; m++) if (tv[3 * bad[q2] + m] === u) hits++;
        }
        return hits >= 2;                          // two shared vertices = an edge
      };
      const seen = new Uint8Array(bad.length);
      const stack = [seed];
      seen[seed] = 1;
      while (stack.length > 0) {
        const p = stack.pop();
        for (let k = 0; k < bad.length; k++) {
          if (seen[k] || !shares(p, k)) continue;
          seen[k] = 1; stack.push(k);
        }
      }
      let kept = 0;
      for (let k = 0; k < bad.length; k++) if (seen[k]) bad[kept++] = bad[k];
      if (kept !== bad.length) repaired++;
      bad.length = kept;
    }

    // the cavity boundary: edges of bad triangles that no OTHER bad triangle
    // shares. Anything shared is interior to the cavity and disappears with it.
    edges.length = 0;
    for (const t of bad) {
      for (let k = 0; k < 3; k++) {
        edges.push(tv[3 * t + k], tv[3 * t + ((k + 1) % 3)]);
      }
    }
    const keep = [];
    for (let a = 0; a < edges.length; a += 2) {
      const u = edges[a], v = edges[a + 1];
      let shared = false;
      for (let b = 0; b < edges.length; b += 2) {
        if (a === b) continue;
        if ((edges[b] === u && edges[b + 1] === v) || (edges[b] === v && edges[b + 1] === u)) {
          shared = true; break;
        }
      }
      if (!shared) keep.push(u, v);
    }

    // A well-formed cavity boundary is a single closed cycle, so every vertex on
    // it appears exactly twice. Counted rather than repaired: the connectivity
    // pass above removes the cause, and a nonzero count here says it did not.
    {
      const deg = new Map();
      for (let a = 0; a < keep.length; a++) deg.set(keep[a], (deg.get(keep[a]) ?? 0) + 1);
      for (const v of deg.values()) if (v !== 2) { malformed++; break; }
    }

    const dead = new Set(bad);
    const nv = [];
    for (let t = 0; t < nT0; t++) {
      if (dead.has(t)) continue;
      nv.push(tv[3 * t], tv[3 * t + 1], tv[3 * t + 2]);
    }
    // The cavity boundary is wound consistently by construction, so (u, v, i) is
    // already counter-clockwise -- but check rather than assume, because a
    // single flipped triangle silently poisons every later in-circle test.
    for (let a = 0; a < keep.length; a += 2) {
      const u = keep[a], v = keep[a + 1];
      if (cross2(px[u], py[u], px[v], py[v], qx, qy) > 0) nv.push(u, v, i);
      else nv.push(v, u, i);
    }
    tv = nv;
  }

  // drop anything still touching the super-triangle. Everything alive is already
  // counter-clockwise, so downstream area and centroid signs are predictable.
  const outTris = [];
  const nAlive = tv.length / 3;
  for (let t = 0; t < nAlive; t++) {
    const a = tv[3 * t], b = tv[3 * t + 1], c = tv[3 * t + 2];
    if (a >= n || b >= n || c >= n) continue;
    // A TRUE zero-area triangle only arises from coincident or exactly collinear
    // input, which the perimeter ring can produce. The threshold is relative to
    // the triangle's own scale rather than absolute: an absolute 1e-12 means
    // nothing when a legitimate triangle at this app's resolution has an area of
    // tens of square pixels, and would silently discard real geometry on a
    // finely-spaced mesh.
    const cross = cross2(px[a], py[a], px[b], py[b], px[c], py[c]);
    const scale = Math.max(
      Math.hypot(px[b] - px[a], py[b] - py[a]),
      Math.hypot(px[c] - px[b], py[c] - py[b]),
      Math.hypot(px[a] - px[c], py[a] - py[c]),
    );
    if (Math.abs(cross) < 1e-9 * scale * scale) continue;
    outTris.push(a, b, c);
  }

  const tris = Int32Array.from(outTris);
  const nT = tris.length / 3;
  const nbr = new Int32Array(tris.length).fill(-1);
  const seen = new Map();
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      // the edge opposite vertex k
      const u = tris[3 * t + ((k + 1) % 3)], v = tris[3 * t + ((k + 2) % 3)];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const prev = seen.get(key);
      if (prev === undefined) { seen.set(key, 3 * t + k); continue; }
      nbr[prev] = t;
      nbr[3 * t + k] = (prev / 3) | 0;
    }
  }
  // `dropped` should always be 0. It is returned rather than asserted because
  // this module has no way to report, and a caller that cares can check it --
  // verify.html does.
  // All three should be 0 in a healthy run. `repaired` counts cavities that had
  // an island removed -- harmless, but a rising count means the in-circle
  // predicate is struggling. `malformed` counts boundaries that were still not a
  // simple cycle afterwards, which is the one that invalidates the result.
  return { tris, nbr, n: nT, dropped, repaired, malformed };
}
