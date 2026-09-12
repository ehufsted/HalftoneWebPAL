// Port of singleWidthLines/code/HCurve.m
// which credits https://observablehq.com/@jobleonard/a-simple-algorithm-to-generate-h-curves
//
// A space-filling curve that targets a rectangle, where the Hilbert curve is
// limited to a power-of-two square. Each cell of a square grid holds an
// (entry, exit) direction pair packed as entry*16 + exit; a 4x4 base tile is
// stamped over the grid, then a recursive merge rewrites a 4x2 patch at the
// centre of each subgrid to stitch the tiles into one continuous path.
//
// The grid side is 4*2^k >= max(nxOut, nyOut), and points falling outside the
// requested rectangle are dropped at the end -- exactly as the MATLAB does.
// Dropping interior points can leave a jump between surviving neighbours; the
// verification harness measures how often that happens.

const T = 1, R = 2, B = 4, L = 8;
const TR = T * 16 + R, TB = T * 16 + B, TL = T * 16 + L;
const RB = R * 16 + B, RT = R * 16 + T;
const BL = B * 16 + L, BT = B * 16 + T, BR = B * 16 + R;
const LT = L * 16 + T, LB = L * 16 + B;

// MATLAB HCurve.m lines 30-33
const LOOKUP = [
  BR, LB, BR, LB,
  BT, TR, LT, TB,
  BT, RB, BL, TB,
  RT, TL, RT, TL,
];

/**
 * @param {number} nxOut, nyOut  requested rectangle
 * @returns {{x: Float64Array, y: Float64Array, n: number}} 1-based coordinates
 */
export function hCurve(nxOut, nyOut) {
  const k = Math.max(0, Math.ceil(Math.log2(Math.max(nxOut, nyOut) / 4)));
  const nx = 4 * Math.pow(2, k);
  const total = nx * nx;

  // base tiling: index = y*nx + x
  const grid = new Int32Array(total);
  for (let y = 0, ctr = 0; y < nx; y++) {
    for (let x = 0; x < nx; x++, ctr++) {
      grid[ctr] = LOOKUP[(y % 4) * 4 + (x % 4)];
    }
  }

  // merge the tiles into a single circuit
  const stack = [[nx / 2 - 2, nx / 2 - 1, nx / 2]];
  while (stack.length > 0) {
    const [x, y, subgridsize] = stack.pop();
    const idx = x + y * nx;
    if (idx < 0 || idx + nx + 3 >= total) continue;
    grid[idx] = BT;      grid[idx + 1] = TR;      grid[idx + 2] = LT;      grid[idx + 3] = TB;
    grid[idx + nx] = BT; grid[idx + nx + 1] = RB; grid[idx + nx + 2] = BL; grid[idx + nx + 3] = TB;
    if (subgridsize > 4) {
      const s = subgridsize / 2;
      stack.push([x - s, y - s, s], [x + s, y - s, s], [x - s, y + s, s], [x + s, y + s, s]);
    }
  }

  // walk the circuit, recording the grid cell visited at each step
  const lineToGrid = new Int32Array(total);
  let idx = 0;
  for (let i = 0; i < total; i++) {
    lineToGrid[i] = idx;
    const dir = grid[idx] % 16;
    if (dir === T) idx -= nx;
    else if (dir === R) idx += 1;
    else if (dir === B) idx += nx;
    else if (dir === L) idx -= 1;
    else break;
    if (idx < 0 || idx >= total) {          // walked off the grid: stop cleanly
      if (i + 1 < total) return finish(lineToGrid.subarray(0, i + 1), nx, nxOut, nyOut);
      break;
    }
  }
  return finish(lineToGrid, nx, nxOut, nyOut);
}

/**
 * Grid index -> coordinates, then clip to the requested rectangle.
 * The MATLAB reads x from the row and y from the column (a transpose of the
 * fill order); reproduced so the clip lands on the same rectangle.
 */
function finish(lineToGrid, nx, nxOut, nyOut) {
  const xs = [], ys = [];
  for (let i = 0; i < lineToGrid.length; i++) {
    const li = lineToGrid[i];
    const y = (li % nx) + 1;
    const x = Math.floor(li / nx) + 1;
    if (x <= nxOut && y <= nyOut) { xs.push(x); ys.push(y); }
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: xs.length };
}

/**
 * Diagnostic: how many consecutive points are further apart than a grid step.
 * Clipping a space-filling curve to a rectangle can leave these jumps, and in
 * sfcCollapse a jump survives as a straight chord across the drawing.
 */
export function countJumps(x, y, threshold = 1.5) {
  let jumps = 0, longest = 0;
  for (let i = 1; i < x.length; i++) {
    const d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    if (d > threshold) { jumps++; if (d > longest) longest = d; }
  }
  return { jumps, longest, points: x.length };
}
