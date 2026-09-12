// New with the binary subdivision placer; not sliced from the pre-split harness.
//
// `subdividePoints` is the second placer behind the `{ field, count }` contract
// that `stipplePoints` defines. It exists for one claim the Lloyd placer cannot
// make -- the count is EXACT, not approximate -- and for two properties that
// follow from how it gets there: placement never draws from the RNG, and it
// costs O(1) per node rather than a local k-means per cell.
//
// So this file asks five things. Is the count exactly what was asked for? Is
// point density proportional to the field, which is the whole job? What does the
// optional relaxation cost, and does it in fact break the lattice it exists to
// break? Does the seed reach only the parts it should? And what does
// centre-of-mass placement actually buy, given the source shipped that feature
// broken and called its effect "minor".

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { stipplePoints, subdividePoints } from '../src/spine/points.js';
import { say, num, flat } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

/** Points-per-pixel that varies, so nothing here is measured on a flat field. */
function radialField(nx, ny) {
  const f = new Float64Array(nx * ny);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2;
  const rMax = Math.hypot(cx, cy);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      f[iy * nx + ix] = 0.05 + 0.95 * (1 - Math.hypot(ix - cx, iy - cy) / rMax);
    }
  }
  return f;
}

/** Two constant blocks, `hi` to the left of `xSplit` and 1 to the right. */
function twoTone(nx, ny, xSplit, hi) {
  const f = new Float64Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) f[iy * nx + ix] = ix < xSplit ? hi : 1;
  }
  return f;
}

/**
 * Points-per-unit-mass in the hi block against the lo block, WITH A BAND ROUND
 * THE SEAM EXCLUDED.
 *
 * The first version of this measured every point, and that conflates two
 * different things. The apportionment is exact in MASS, but this classifies
 * points by POSITION, and a cell straddling the seam holds mass from both blocks
 * while owning a single point that lands on one side by an accident of where its
 * centroid falls. Those cells number about ny/spacing -- around 2% of the total
 * -- so if they break unevenly the ratio moves by a few percent for a reason
 * that has nothing to do with the placer.
 *
 * That is not hypothetical: the same field and the same hi read inside 2% at
 * 2000 points and 4.2% at 1500, purely from where the seam fell relative to the
 * cell edges. A test that can swing that far on the count is measuring the seam,
 * not the apportionment. Excluding a band of 1.5 spacings removes the ambiguous
 * population; the raw figure is still reported beside it so the size of what was
 * excluded stays visible.
 *
 * THE BAND IS PER SIDE, and a single global one was not enough -- see the
 * comment in the body. The give-away was that the seam-free figure still grew
 * with `hi`, and the apportionment cannot know what `hi` is: it works in mass,
 * and mass is what `hi` scales.
 */
function densityRatio(sx, nx, ny, xSplit, hi, count) {
  // A BAND PER SIDE, FROM EACH SIDE'S OWN SPACING. The ambiguous population is
  // one cell deep either side of the seam, and a cell is the local spacing
  // across -- which is not the same number on the two sides. The hi block holds
  // `hi` times the mass per unit area, so it holds sqrt(hi) times the points per
  // unit length and its cells are sqrt(hi) times finer.
  //
  // Using one band from the GLOBAL mean spacing therefore over-excludes on the
  // dense side and UNDER-excludes on the sparse side -- and the sparse side is
  // where each cell carries the most weight, so its leftover ambiguity is what
  // survives into the ratio. That is visible as a departure growing with `hi`:
  // 0.994 and 1.011 at hi = 2, rising to 1.017 and 1.042 at hi = 10, on a
  // quantity that should not know what `hi` is at all. A seam artefact scaling
  // with the contrast is still a seam artefact.
  const massHi = xSplit * ny * hi, massLo = (nx - xSplit) * ny;
  const total = massHi + massLo;
  // points expected each side, hence the mean spacing each side
  const nExpHi = (count * massHi) / total, nExpLo = (count * massLo) / total;
  const bandHi = 1.5 * Math.sqrt((xSplit * ny) / Math.max(1, nExpHi));
  const bandLo = 1.5 * Math.sqrt(((nx - xSplit) * ny) / Math.max(1, nExpLo));
  let nHi = 0, nLo = 0, rawHi = 0, rawLo = 0;
  for (let i = 0; i < sx.length; i++) {
    const x = sx[i] - 1;
    if (x < xSplit) rawHi++; else rawLo++;
    if (x < xSplit - bandHi) nHi++;
    else if (x > xSplit + bandLo) nLo++;
  }
  const mHi = (xSplit - bandHi) * ny * hi;
  const mLo = (nx - xSplit - bandLo) * ny;
  const rawMHi = xSplit * ny * hi, rawMLo = (nx - xSplit) * ny;
  const safe = (a, b) => (b > 0 ? a / b : 0);
  return {
    ratio: safe(safe(nHi, mHi), safe(nLo, mLo)),
    raw: safe(safe(rawHi, rawMHi), safe(rawLo, rawMLo)),
    excluded: sx.length - nHi - nLo,
  };
}

/** Mean distance from each point to its nearest neighbour, and that set's sd. */
function nearestStats(sx, sy) {
  const n = sx.length;
  if (n < 2) return { mean: 0, sd: 0 };
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dd = (sx[i] - sx[j]) ** 2 + (sy[i] - sy[j]) ** 2;
      if (dd < best) best = dd;
    }
    d[i] = Math.sqrt(best);
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += d[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (d[i] - m) ** 2;
  return { mean: m, sd: Math.sqrt(v / n) };
}

export function run() {

// ------------------------------------------------------------- exact count
// THE CLAIM THE OTHER PLACER CANNOT MAKE, so it is checked with no tolerance at
// all. The mechanism is the source's best idea: apportion by largest remainder
// at every node -- floor each child, hand the surplus to the bigger fraction --
// so the total cannot drift at any level of the tree.
say('<h2>Subdivide placer — is the count exactly the count?</h2>');
say('<p class="note">Counting, so no tolerance. The Lloyd placer lands near its ' +
    'request; this one is asked to land on it, including at counts of 1 and 2 ' +
    'and at a count large enough to force deep recursion.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const field = radialField(ctx.nx, ctx.ny);
  say('<table><tr><th>requested</th><th>returned</th><th>exact</th></tr>');
  let allOk = true;
  for (const count of [1, 2, 7, 100, 999, 5000]) {
    const { sx } = subdividePoints(ctx, { field, count });
    const ok = sx.length === count;
    allOk = allOk && ok;
    say(`<tr><td>${count}</td><td>${sx.length}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'yes' : 'NO'}</td></tr>`);
  }
  say('</table>');
  say(`<p>the count is an identity, not an estimate — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// ------------------------------------------------------- density is the field
// THE ACTUAL JOB. `field` means "points per pixel, up to a scale", so on a
// two-block field the points must divide in proportion to mass and the
// points-per-unit-mass must come out equal in both blocks. This is the same
// question that caught the Lloyd placer's polish dragging seeds toward the
// Gersho distribution -- it read 1.18 where it should read 1.00 -- so it is
// worth asking of anything that claims to place points by mass.
//
// The block boundary is deliberately NOT on a power-of-two split of the page:
// at x = 144 of 360 the first cut at 180 straddles it, so the apportionment has
// to be right rather than merely lucky.
say('<h2>Subdivide placer — is density proportional to the field?</h2>');
say('<p class="note">Left 40% of the page at density h, right 60% at 1. The ' +
    'share of points going left must equal the share of mass, so ' +
    'points-per-unit-mass is 1.000 in both blocks if the apportionment is exact. ' +
    'Scored on the seam-free figure and reported beside the raw one — see ' +
    'densityRatio for why the raw number moves with the count.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const xSplit = Math.round(ctx.nx * 0.4);
  say('<table><tr><th>h</th><th>count</th><th>points</th><th>seam cells cut</th>' +
      '<th>ratio hi/lo, seam-free</th><th>raw</th></tr>');
  let worst = 0;
  // Two counts on purpose. The raw metric read 2% at one and 4.2% at the other
  // on the same field, which is the observation this whole helper exists for;
  // the seam-free column should not care which one it is given.
  for (const hi of [2, 4, 10]) {
    for (const count of [1500, 2000]) {
      const field = twoTone(ctx.nx, ctx.ny, xSplit, hi);
      const { sx } = subdividePoints(ctx, { field, count });
      const d = densityRatio(sx, ctx.nx, ctx.ny, xSplit, hi, count);
      worst = Math.max(worst, Math.abs(d.ratio - 1));
      say(`<tr><td>${hi}</td><td>${count}</td><td>${sx.length}</td>` +
          `<td>${d.excluded}</td>` +
          `<td class="${Math.abs(d.ratio - 1) < 0.02 ? 'pass' : 'fail'}">${num(d.ratio, 4)}</td>` +
          `<td>${num(d.raw, 4)}</td></tr>`);
    }
  }
  say('</table>');
  const ok = worst < 0.02;
  say(`<p>density follows the field — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst departure ${num(worst, 4)}). ` +
      `<span class="note">Scored at 2% because the only slack left is the single ` +
      `point of largest-remainder rounding at each node the boundary crosses; ` +
      `there is no relaxation here to converge or fail to. If the raw column ` +
      `swings between the two counts while the scored one holds, that is the ` +
      `seam population being measured rather than the placer.</span></p>`);
}

// ------------------------------------------------- what relaxation costs
// THE SLIDER IS A TRADE AND THIS IS ITS PRICE LIST. Lloyd steps over the
// finished point set soften the two-aspect lattice, and mass-weighted Lloyd
// converges on the Gersho distribution field^(1/2) -- exactly what the
// subdivider avoids by construction. So every step pulls density back toward it,
// and the question is not whether but how fast.
//
// The count must NOT move: points are relocated, never created or destroyed, so
// the exact-count identity has to survive every setting. That half is scored.
// The density drift is reported, because it is the feature working as designed
// rather than a fault, and the number is what lets someone choose a setting.
say('<h2>Subdivide placer — what does relaxation cost?</h2>');
say('<p class="note">Lloyd steps applied after placement, each preceded by the ' +
    'jitter that gives them something to move. Two fields per row: the two-tone ' +
    'one prices the density cost, and the flat one is where the lattice lives, ' +
    'so its nearest-neighbour spread is the direct evidence that the softening ' +
    'is working at all. The count must hold exactly at every setting.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const xSplit = Math.round(ctx.nx * 0.4);
  const field = twoTone(ctx.nx, ctx.ny, xSplit, 4);
  const flatField = new Float64Array(ctx.nx * ctx.ny).fill(1);
  const count = 1500, flatCount = 800;
  say('<table><tr><th>relax steps</th><th>points</th><th>count exact</th>' +
      '<th>points/mass, hi ÷ lo</th><th>density drift</th>' +
      '<th>flat spread, sd ÷ mean</th><th>spread vs 0</th></tr>');
  let countOk = true, base = null, flatBase = null;
  for (const relax of [0, 1, 2, 4, 8, 16]) {
    const res = subdividePoints(ctx, { field, count, relax, seed: 1 });
    const exact = res.sx.length === count;
    countOk = countOk && exact;
    const d = densityRatio(res.sx, ctx.nx, ctx.ny, xSplit, 4, count);
    if (base === null) base = d.ratio;

    // The lattice is a flat-tone phenomenon, so it has to be measured on one.
    const fr = subdividePoints(ctx, { field: flatField, count: flatCount, relax, seed: 1 });
    countOk = countOk && fr.sx.length === flatCount;
    const fs = nearestStats(fr.sx, fr.sy);
    const spread = fs.mean > 0 ? fs.sd / fs.mean : 0;
    if (flatBase === null) flatBase = spread;

    say(`<tr><td>${relax}</td><td>${res.sx.length}</td>` +
        `<td class="${exact ? 'pass' : 'fail'}">${exact ? 'yes' : 'NO'}</td>` +
        `<td>${num(d.ratio, 4)}</td><td>${num(d.ratio - base, 4)}</td>` +
        `<td>${num(spread, 4)}</td>` +
        `<td>${spread - flatBase >= 0 ? '+' : ''}${num(spread - flatBase, 4)}</td></tr>`);
  }
  say('</table>');
  say(`<p>relaxation never changes the count — ` +
      `<span class="${countOk ? 'pass' : 'fail'}">${countOk ? 'PASS' : 'FAIL'}</span>. ` +
      `<span class="note">That is the half of the placer's contract relaxation ` +
      `must not touch, and the only half scored here — jitter moves points and ` +
      `Lloyd moves points, neither makes or loses one. Price a setting by ` +
      `reading the flat-spread column against the density-drift column: if the ` +
      `spread falls sharply while the drift barely moves, the early steps are ` +
      `close to free and the default of 0 is merely cautious. If they move ` +
      `together, the slider is buying arrangement with accuracy at par and ` +
      `should be left alone unless the lattice is visible in the drawing. A ` +
      `flat spread that does NOT fall would mean the jitter is too small to ` +
      `escape the fixed point, which is a fault in JITTER_FRACTION rather than ` +
      `in the idea.</span></p>`);
}

// ------------------------------------------------------------- no randomness
// The determinism trap in docs/architecture.md is about the RNG's CALL SEQUENCE
// being load-bearing. PLACEMENT contributes nothing to that sequence, and the
// cheapest proof is that the seed cannot be detected in its output. Worth
// stating because the source means to randomise its tie-breaks and only fails to
// by accident -- `rand(size(dn))` sizes the noise off a scalar -- so a later
// reader "restoring" that intent would be undoing this property.
//
// RELAXATION IS THE EXCEPTION AND IT HAS TO BE. It must jitter before it
// relaxes, since a regular lattice is a fixed point of Lloyd and would otherwise
// survive untouched, and jitter needs randomness. Seeded randomness: reproducible
// at a given seed, different across seeds. So the claim splits in two, and both
// halves are checked -- unrelaxed runs must IGNORE the seed, relaxed runs must
// RESPOND to it. An earlier version of this test asserted the relaxed pair were
// identical, which was true only while the jitter did not exist.
say('<h2>Subdivide placer — what the seed does, and does not, reach</h2>');
say('<p class="note">Placement must be identical across seeds; relaxation must ' +
    'not be. A relaxed run that ignored the seed would mean the jitter was not ' +
    'happening, and the relaxation would then be doing nothing on flat tone.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const field = radialField(ctx.nx, ctx.ny);
  const key = (r) => Array.from(r.sx).map((v, i) => `${v},${r.sy[i]}`).join(';');
  const a = key(subdividePoints(ctx, { field, count: 500, seed: 1 }));
  const b = key(subdividePoints(ctx, { field, count: 500, seed: 999 }));
  const c = key(subdividePoints(ctx, { field, count: 500, seed: 1 }));
  const r1 = key(subdividePoints(ctx, { field, count: 500, relax: 4, seed: 1 }));
  const r2 = key(subdividePoints(ctx, { field, count: 500, relax: 4, seed: 999 }));
  const r3 = key(subdividePoints(ctx, { field, count: 500, relax: 4, seed: 1 }));
  const ok = a === b && a === c && r1 === r3 && r1 !== r2 && r1 !== a;
  say(`<p>placement ignores the seed: <b>${a === b ? 'yes' : 'NO'}</b>, ` +
      `placement repeats: <b>${a === c ? 'yes' : 'NO'}</b>, ` +
      `relaxed run repeats at one seed: <b>${r1 === r3 ? 'yes' : 'NO'}</b>, ` +
      `relaxed run differs across seeds: <b>${r1 !== r2 ? 'yes' : 'NO'}</b>, ` +
      `relaxation moved something: <b>${r1 !== a ? 'yes' : 'NO'}</b> — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// ---------------------------------------------------- what centre of mass buys
// REPORTED, NOT SCORED, AND THE FIRST VERSION OF THIS ASKED THE WRONG QUESTION.
//
// It ran a flat field and a smooth radial one and concluded, from a mean
// displacement of 0.115 px against a 9.0 px spacing, that the correction does
// almost nothing. That reading was right and the design of the measurement was
// not: a leaf spans about 11 px and a smooth ramp changes by ~4.5% across that,
// so the mass in nearly every cell is nearly uniform and its centroid is nearly
// the box centre. The average was taken over a population in which nothing could
// happen.
//
// The population that CAN move is cells straddling a discontinuity, which is
// exactly where the source claims the feature "enhances edges". So the step row
// below reports the displacement restricted to cells within one spacing of the
// step, alongside the all-cells figure that hides it.
//
// The flat row stays, because it establishes the mechanism: uniform mass puts
// the centroid at the box centre, so the displacement must be exactly 0.000, and
// it is. The lattice is not something centre of mass was ever going to fix.
say('<h2>Subdivide placer — what does centre-of-mass placement change?</h2>');
say('<p class="note">Displacement from the cell centre, and the spread of ' +
    'nearest-neighbour distances. Flat establishes the mechanism (nothing can ' +
    'move). Radial is a smooth gradient, where almost nothing does. The step is ' +
    'the case the toggle exists for, reported both over all cells and over the ' +
    'cells near the step.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const count = 800;
  const spacing = Math.sqrt((ctx.nx * ctx.ny) / count);
  // AT 40% OF THE PAGE, NOT THE MIDDLE, AND THAT MATTERS. The first x-split of a
  // 360-wide page is at 180, and every later one halves from there -- so a step
  // at the midpoint would fall exactly on a cell boundary at every level, no
  // cell would ever straddle it, and this row would report a displacement of
  // zero for a reason that has nothing to do with the correction being measured.
  // 144 is off that binary grid, so cells genuinely contain the discontinuity.
  const xStep = Math.round(ctx.nx * 0.4);
  const flatField = new Float64Array(ctx.nx * ctx.ny).fill(1);

  say('<table><tr><th>field</th><th>mean |CM − centre|</th>' +
      '<th>near the step</th><th>cells counted</th>' +
      '<th>nearest mean, CM</th><th>nearest sd, CM</th>' +
      '<th>nearest sd, centre</th></tr>');
  let flatMove = null, stepAll = 0, stepEdge = 0;
  for (const [name, field, edgeAt] of [
    ['flat', flatField, null],
    ['radial', radialField(ctx.nx, ctx.ny), null],
    ['step 8:1 at 40%', twoTone(ctx.nx, ctx.ny, xStep, 8), xStep],
  ]) {
    const cm = subdividePoints(ctx, { field, count, centreOfMass: true });
    const ce = subdividePoints(ctx, { field, count, centreOfMass: false });
    let move = 0, edgeMove = 0, edgeN = 0;
    for (let i = 0; i < cm.sx.length; i++) {
      const d = Math.hypot(cm.sx[i] - ce.sx[i], cm.sy[i] - ce.sy[i]);
      move += d;
      // Selected on the CENTRE placement, so membership of the near-step
      // population does not itself depend on the correction being measured.
      if (edgeAt !== null && Math.abs(ce.sx[i] - 1 - edgeAt) < spacing) {
        edgeMove += d; edgeN++;
      }
    }
    move /= Math.max(1, cm.sx.length);
    if (name === 'flat') flatMove = move;
    if (edgeAt !== null) { stepAll = move; stepEdge = edgeN > 0 ? edgeMove / edgeN : 0; }
    const sCM = nearestStats(cm.sx, cm.sy);
    const sCE = nearestStats(ce.sx, ce.sy);
    say(`<tr><td>${name}</td><td>${num(move, 3)}</td>` +
        `<td>${edgeN > 0 ? num(edgeMove / edgeN, 3) : '—'}</td>` +
        `<td>${edgeAt === null ? '—' : edgeN}</td>` +
        `<td>${num(sCM.mean, 2)}</td><td>${num(sCM.sd, 3)}</td>` +
        `<td>${num(sCE.sd, 3)}</td></tr>`);
  }
  say('</table>');

  // SCORED, because it is an identity rather than a measurement. A flat field
  // has uniform mass, so the centroid of every box IS its centre, and the two
  // placements must agree to the last bit -- not nearly. They do: the sums are
  // integers well inside 2^53 and the quotient is exactly representable, so
  // anything other than 0.000 here would mean the integral images and the
  // centre formula have stopped describing the same box.
  const exact = flatMove === 0;
  say(`<p>flat field moves nothing, exactly — <span class="${exact ? 'pass' : 'fail'}">` +
      `${exact ? 'PASS' : 'FAIL'}</span> (${flatMove === null ? 'not run' : flatMove})</p>`);

  const lift = stepAll > 0 ? stepEdge / stepAll : 0;
  say(`<p class="note">Read the step row's two displacement columns against each ` +
      `other, not against the other rows. Measured: ${num(stepEdge, 3)} near the ` +
      `step against ${num(stepAll, 3)} over every cell, a factor of ` +
      `${num(lift, 1)} — so the correction acts on the cells it was meant for ` +
      `and the all-cells average is 94% cells that cannot move. The two ` +
      `reconcile: the near-step cells alone account for the whole of the ` +
      `all-cells figure, which is the mechanism confirmed rather than assumed. ` +
      `Reported and not scored because the factor depends on the field, the ` +
      `count and the band, and one configuration cannot say how much of that ` +
      `spread is real. What would justify scoring it is the same table run ` +
      `across a few step ratios.</p>`);
  say('<p class="note">The two placements are compared point for point, which ' +
      'is meaningful only because the count is exact and the emission order is ' +
      'fixed — the i-th point of one run is the i-th leaf of the same tree in ' +
      'the other. That is a property worth noticing: it makes any future change ' +
      'to placement measurable as a displacement rather than as two clouds.</p>');
}

// ------------------------------------------------------ against the Lloyd path
// Side by side on one field, because the reason to keep both is that they fail
// differently, and a reader deciding between them should not have to run this
// themselves. Reported, not scored: neither is trying to be the other.
say('<h2>Subdivide placer — side by side with the Lloyd placer</h2>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const xSplit = Math.round(ctx.nx * 0.4);
  const field = twoTone(ctx.nx, ctx.ny, xSplit, 4);
  const count = 1500;
  say('<table><tr><th>placer</th><th>requested</th><th>returned</th>' +
      '<th>points/mass, hi ÷ lo</th><th>raw</th>' +
      '<th>nearest sd ÷ mean</th></tr>');
  for (const [name, res] of [
    ['subdivide', subdividePoints(ctx, { field, count })],
    ['lloyd', stipplePoints(ctx, { field, count, seed: 1, iterations: 6 })],
  ]) {
    // Seam-free, for the reason in densityRatio. Measured raw, this table read
    // 1.0419 for the subdivider against 0.9776 for Lloyd and looked like
    // evidence that Lloyd apportions better. It was not: it was the ~34 cells
    // straddling the seam breaking unevenly, plus Lloyd's 32 missing points.
    const d = densityRatio(res.sx, ctx.nx, ctx.ny, xSplit, 4, count);
    const s = nearestStats(res.sx, res.sy);
    say(`<tr><td>${name}</td><td>${count}</td><td>${res.sx.length}</td>` +
        `<td>${num(d.ratio, 4)}</td><td>${num(d.raw, 4)}</td>` +
        `<td>${num(s.mean > 0 ? s.sd / s.mean : 0, 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">The subdivider is ahead on both columns that mean ' +
      'anything here. The count is exactly the number requested, against a ' +
      'Lloyd run that lands near it; and its seam-free density sits closer to ' +
      '1.000 by roughly a factor of three. Lloyd has slack in both by ' +
      'construction — its k = min(3, round(S / massPerPoint)) rounds at every ' +
      'node, where largest-remainder apportionment does not — and no polish ' +
      'runs in this table, so what is left is its own quantisation rather than ' +
      'the Gersho drift. Read the raw column beside the scored one: it reverses ' +
      'the ordering, which is what a metric contaminated by seam cells looks ' +
      'like before the contamination is taken out.</p>');
  say('<p class="note">The last column is the one to read for arrangement, and ' +
      'it is the one place the subdivider is NOT ahead: a low spread means the ' +
      'points sit at near-equal distances, but the subdivider gets there partly ' +
      'by being a two-aspect lattice, which is not the same virtue as getting ' +
      'there by relaxation, and the column cannot tell them apart.</p>');
}

}
