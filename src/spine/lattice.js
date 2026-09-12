// Regular point sets in a disc, and the rows you can draw them along.
//
// Three arrangements, all parameterised by ONE number: the mean spacing `d`,
// defined so that each point owns an area of exactly d^2. That definition is
// what makes them interchangeable -- swap square for hex for phyllotaxis and the
// point count, the density and therefore the tone all stay put, which is the
// same contract regions.js uses for its tilers.
//
// Parameterising by nearest-neighbour distance instead, as the source does,
// needs a correction constant to make the hex lattice match the square's
// density; the derived value below (sqrt(2/sqrt(3)) = 1.074570) removes it.

/**
 * Nearest-neighbour spacing of a triangular lattice whose points each own d^2.
 *
 * A triangular lattice with nearest-neighbour distance a has one point per
 * rhombus of area (sqrt(3)/2) a^2. Setting that to d^2 gives a = d sqrt(2/sqrt(3)).
 */
export const HEX_A_PER_SPACING = Math.sqrt(2 / Math.sqrt(3));

/**
 * Vogel-spiral scale: r_i = c sqrt(i) puts the i-th point on a disc of area
 * pi c^2 i, so each point owns pi c^2. For d^2 that gives c = d/sqrt(pi).
 */
export const PHYLLO_C_PER_SPACING = 1 / Math.sqrt(Math.PI);

/** The golden angle, pi(3 - sqrt(5)) ~ 137.508 degrees. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Fibonacci numbers, for choosing which parastichy to draw. */
const FIB = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];

/**
 * Points of a regular arrangement filling a disc of the given radius, centred on
 * the origin, together with the rows they can be drawn along.
 *
 * `rows` is a list of index lists, each one a run of points that are neighbours
 * in the arrangement and can be joined into a polyline. For the two lattices
 * those are the obvious straight rows; for phyllotaxis they are the parastichy
 * spirals — the arcs the eye already sees in a sunflower head, at Fibonacci index
 * strides. Only one family is emitted per arrangement: a square lattice has two
 * orthogonal families and a triangular one has three, and drawing them all
 * multiplies the ink by that factor.
 *
 * @param {'square'|'hex'|'phyllotaxis'} kind
 * @param {number} radius   disc radius, pixels
 * @param {number} spacing  mean spacing d: each point owns d^2
 */
export function latticeInDisc(kind, radius, spacing) {
  const d = Math.max(1e-6, spacing);
  const R = Math.max(d, radius);
  const x = [], y = [], rows = [];

  if (kind === 'phyllotaxis') {
    const c = d * PHYLLO_C_PER_SPACING;
    const n = Math.max(1, Math.floor((R / c) * (R / c)));
    for (let i = 0; i < n; i++) {
      // i + 0.5 rather than i: the point at i = 0 would sit exactly on the
      // centre, which is a singularity for the radial transport downstream and
      // an unsightly blob in the drawing. Half-integer offsets give the same
      // density with no point at r = 0.
      const r = c * Math.sqrt(i + 0.5);
      const t = (i + 0.5) * GOLDEN_ANGLE;
      x.push(r * Math.cos(t));
      y.push(r * Math.sin(t));
    }
    // Parastichies: join i to i+F for a Fibonacci F. Larger F gives spirals that
    // wind more tightly; sqrt(n) is where the two visible families cross over,
    // so the nearest Fibonacci below it is the one that reads as "the" spiral.
    let F = FIB[0];
    for (const f of FIB) if (f * f <= n) F = f;
    const used = new Uint8Array(n);
    for (let s = 0; s < F && s < n; s++) {
      const run = [];
      for (let i = s; i < n; i += F) { run.push(i); used[i] = 1; }
      if (run.length > 1) rows.push(run);
    }
    return { x: Float64Array.from(x), y: Float64Array.from(y), n: x.length, rows };
  }

  if (kind === 'hex') {
    const a = d * HEX_A_PER_SPACING;
    const rowPitch = a * Math.sqrt(3) / 2;
    const jMax = Math.ceil(R / rowPitch) + 1;
    for (let j = -jMax; j <= jMax; j++) {
      const yy = j * rowPitch;
      const off = (j & 1) ? a / 2 : 0;
      const half = Math.sqrt(Math.max(0, R * R - yy * yy));
      const iLo = Math.ceil((-half - off) / a), iHi = Math.floor((half - off) / a);
      const run = [];
      for (let i = iLo; i <= iHi; i++) {
        run.push(x.length);
        x.push(i * a + off);
        y.push(yy);
      }
      if (run.length > 1) rows.push(run);
    }
    return { x: Float64Array.from(x), y: Float64Array.from(y), n: x.length, rows };
  }

  // square
  const jMax = Math.ceil(R / d) + 1;
  for (let j = -jMax; j <= jMax; j++) {
    const yy = j * d;
    const half = Math.sqrt(Math.max(0, R * R - yy * yy));
    const iLo = Math.ceil(-half / d), iHi = Math.floor(half / d);
    const run = [];
    for (let i = iLo; i <= iHi; i++) {
      run.push(x.length);
      x.push(i * d);
      y.push(yy);
    }
    if (run.length > 1) rows.push(run);
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y), n: x.length, rows };
}
