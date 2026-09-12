// Port of singleWidthLines/code/hilbertCurve.m
//
//   z = 0;  a = 1+1i;  b = 1-1i;
//   for k = 2:nIter
//       w = 1i*conj(z);
//       z = [w-a; z-b; z+a; b-w]/2;
//   end
//
// Each iteration quadruples the point count, so nIter gives 4^(nIter-1) points,
// exactly one per cell of a 2^(nIter-1) square over [-1,1].
//
// The points are CELL CENTRES, so they span [-1 + w/2, 1 - w/2] and not [-1, 1]:
// the extreme point sits half a cell inside the box, which is what `w` in the
// return value measures. Both callers (sfcCollapse, wigglyLines) rescale as
// though the span were [-1, 1], giving a half-cell offset and about 1%
// compression that the clip currently absorbs. Correcting them is a measurement
// rather than an edit.
//
// The Moore variant assembles four rotated copies into a closed loop, so the
// pen returns to where it started. It packs 4x the points into the same span,
// which is why callers must shift the iteration count by one to get a given
// grid resolution (see gridSideFor below).

/**
 * @param {number} nIter
 * @param {boolean} moore
 * @returns {{x: Float64Array, y: Float64Array, w: number}} cell centres over the
 *          box [-1,1], so the coordinates themselves span [-1 + w/2, 1 - w/2];
 *          `w` is the cell width.
 */
export function hilbertCurve(nIter, moore = false) {
  let re = Float64Array.from([0]);
  let im = Float64Array.from([0]);

  for (let k = 2; k <= nIter; k++) {
    const n = re.length;
    const nr = new Float64Array(n * 4);
    const ni = new Float64Array(n * 4);
    for (let j = 0; j < n; j++) {
      const zr = re[j], zi = im[j];
      // w = 1i*conj(z): conj is (zr, -zi), times i gives (zi, zr)
      const wr = zi, wi = zr;
      nr[j] = (wr - 1) / 2;             ni[j] = (wi - 1) / 2;            // w - a
      nr[n + j] = (zr - 1) / 2;         ni[n + j] = (zi + 1) / 2;        // z - b
      nr[2 * n + j] = (zr + 1) / 2;     ni[2 * n + j] = (zi + 1) / 2;    // z + a
      nr[3 * n + j] = (1 - wr) / 2;     ni[3 * n + j] = (-1 - wi) / 2;   // b - w
    }
    re = nr; im = ni;
  }

  if (!moore) {
    return { x: re, y: im, w: Math.pow(2, 2 - nIter) };
  }

  // four copies, then repeat the first point to close the loop
  const n = re.length;
  const x = new Float64Array(n * 4 + 1);
  const y = new Float64Array(n * 4 + 1);
  const offs = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
  for (let q = 0; q < 4; q++) {
    const sign = q < 2 ? 0.5 : -0.5;
    const [ox, oy] = offs[q];
    for (let j = 0; j < n; j++) {
      x[q * n + j] = re[j] * sign + ox;
      y[q * n + j] = im[j] * sign + oy;
    }
  }
  x[n * 4] = x[0];
  y[n * 4] = y[0];
  return { x, y, w: Math.pow(2, 1 - nIter) };
}

/**
 * Iteration count and grid side for a requested rectangle.
 * Plain Hilbert reaches side 2^(nIter-1); Moore reaches 2^nIter for the same
 * nIter, so it needs one fewer iteration to land on the same grid.
 */
export function hilbertParamsFor(nx, ny, moore) {
  const m = Math.max(1, Math.ceil(Math.log2(Math.max(nx, ny))));
  return { side: Math.pow(2, m), nIter: moore ? m : m + 1 };
}

/**
 * The Hilbert INDEX of a grid cell: the inverse of the curve above.
 *
 * hilbertCurve generates the path; this answers "how far along that path does
 * this cell sit" without generating anything. Sorting points by it is what turns
 * a point set into a tour, and doing it this way costs O(N log N) instead of
 * building a 2^2m curve and searching it -- which for a few thousand points is
 * the difference between instant and unusable.
 *
 * Standard bit-interleave-with-rotation. `side` must be a power of two, and x
 * and y integers in [0, side).
 */
export function hilbertIndex(side, x, y) {
  let d = 0;
  let px = x | 0, py = y | 0;
  for (let s = side >> 1; s > 0; s >>= 1) {
    const rx = (px & s) > 0 ? 1 : 0;
    const ry = (py & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // rotate the quadrant so the curve stays continuous across it
    if (ry === 0) {
      if (rx === 1) { px = s - 1 - px; py = s - 1 - py; }
      const t = px; px = py; py = t;
    }
  }
  return d;
}
