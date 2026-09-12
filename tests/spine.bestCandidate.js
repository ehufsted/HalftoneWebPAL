// New with the best-candidate placer; not sliced from the pre-split harness.
//
// `bestCandidatePoints` is the third placer behind the `{ field, count }`
// contract. It exists for one thing the other two cannot do -- blue noise, even
// spacing with no periodicity -- and it arrives with two properties that need
// checking rather than assuming, and one weaker guarantee that needs stating.
//
//   exact count      it places `want` points, so this is a counting test
//   PROGRESSIVE      a run of m points is a bit-for-bit PREFIX of a run of n > m,
//                    because massPerPoint divides every score equally and cannot
//                    change which candidate wins. That is the property that makes
//                    a count slider feel stable, and no other placer here has it.
//   density APPROACHED, not constructed. Unlike the subdivider there is no step
//                    at which a region is handed its exact share; a region that
//                    falls behind wins candidates more often until it catches up.
//                    So it belongs in Lloyd's class and the question is how close
//                    it gets, not whether it is exact.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { bestCandidatePoints, subdividePoints, stipplePoints } from '../src/spine/points.js';
import { say, num, flat } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

function twoTone(nx, ny, xSplit, hi) {
  const f = new Float64Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) f[iy * nx + ix] = ix < xSplit ? hi : 1;
  }
  return f;
}

/** Seam-free points-per-unit-mass, hi block over lo. See spine.subdivide.js. */
function densityRatio(sx, nx, ny, xSplit, hi, count) {
  const band = 1.5 * Math.sqrt((nx * ny) / Math.max(1, count));
  let nHi = 0, nLo = 0;
  for (let i = 0; i < sx.length; i++) {
    const x = sx[i] - 1;
    if (x < xSplit - band) nHi++;
    else if (x > xSplit + band) nLo++;
  }
  const mHi = (xSplit - band) * ny * hi;
  const mLo = (nx - xSplit - band) * ny;
  const safe = (a, b) => (b > 0 ? a / b : 0);
  return safe(safe(nHi, mHi), safe(nLo, mLo));
}

/** Mean and sd of each point's distance to its nearest neighbour. */
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

// --------------------------------------------------------------- exact count
say('<h2>Best-candidate placer — is the count exactly the count?</h2>');
say('<p class="note">The loop places one point per iteration, so this ought to ' +
    'be trivially true. Counting anyway, because it is cheap and because the ' +
    'prefix test below is meaningless without it.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const field = twoTone(ctx.nx, ctx.ny, Math.round(ctx.nx * 0.4), 4);
  say('<table><tr><th>requested</th><th>returned</th><th>exact</th></tr>');
  let allOk = true;
  for (const count of [1, 2, 50, 400, 1500]) {
    const { sx } = bestCandidatePoints(ctx, { field, count, seed: 1 });
    const ok = sx.length === count;
    allOk = allOk && ok;
    say(`<tr><td>${count}</td><td>${sx.length}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'yes' : 'NO'}</td></tr>`);
  }
  say('</table>');
  say(`<p>the count is exact — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// ---------------------------------------------------------------- progressive
// THE PROPERTY WORTH HAVING, and the one most easily broken by a well-meaning
// optimisation. It holds because `massPerPoint` is a global factor that divides
// every score equally, so it cannot reorder the candidates -- and because the
// RNG is drawn from exactly 3k times per point whatever the count, and because
// `nearestD2` is an exact query rather than an approximation over a grid whose
// size depends on `want`. Break any of those three and this test goes red.
say('<h2>Best-candidate placer — is a short run a prefix of a long one?</h2>');
say('<p class="note">Place 400 points, then 1200 with the same seed and field. ' +
    'The first 400 of the long run must be the same points, in the same order, ' +
    'to the last bit. That is what lets a count slider add and remove dots at ' +
    'the margin instead of re-rolling the drawing.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const field = twoTone(ctx.nx, ctx.ny, Math.round(ctx.nx * 0.4), 4);
  const short = bestCandidatePoints(ctx, { field, count: 400, seed: 7 });
  const long = bestCandidatePoints(ctx, { field, count: 1200, seed: 7 });
  let matched = 0;
  for (let i = 0; i < short.sx.length; i++) {
    if (short.sx[i] === long.sx[i] && short.sy[i] === long.sy[i]) matched++;
    else break;
  }
  const ok = matched === short.sx.length && short.sx.length === 400;
  say(`<p>${matched} of ${short.sx.length} points identical — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span>. ` +
      `<span class="note">A partial match is the informative failure: it would ` +
      `mean the sequence diverges at a particular point rather than being ` +
      `unrelated, which points at the nearest-neighbour query going approximate ` +
      `once the grid fills rather than at the scoring.</span></p>`);

  // The other two placers are not progressive and are not trying to be. Shown
  // so the contrast is on the record rather than implied.
  const sShort = subdividePoints(ctx, { field, count: 400 });
  const sLong = subdividePoints(ctx, { field, count: 1200 });
  const sMatch = sShort.sx.length > 0 && sShort.sx[0] === sLong.sx[0];
  say(`<p class="note">For contrast, the subdivider's first point ` +
      `${sMatch ? 'happens to agree' : 'already differs'} between the two counts ` +
      `— its whole tree is rebuilt when the count changes, which is correct for ` +
      `what it does and simply a different trade.</p>`);
}

// ------------------------------------------------------------------- density
// APPROACHED, NOT CONSTRUCTED, so this is scored at a bar the mechanism can
// actually meet. The self-correction has to have somewhere to work: a region
// that has fallen behind wins candidates more often, which needs enough points
// for "more often" to mean anything. Low counts are therefore expected to be
// worse, and the table includes one so that is visible rather than hidden.
say('<h2>Best-candidate placer — does density follow the field?</h2>');
say('<p class="note">Two-tone field, seam-free measure. This placer approaches ' +
    'the right density rather than constructing it, so the question is how ' +
    'close it gets and whether it improves with the count.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const xSplit = Math.round(ctx.nx * 0.4);
  say('<table><tr><th>h</th><th>count</th><th>candidates k</th>' +
      '<th>points/mass, hi ÷ lo</th></tr>');
  let worst = 0;
  for (const hi of [2, 4, 10]) {
    for (const count of [400, 2000]) {
      const field = twoTone(ctx.nx, ctx.ny, xSplit, hi);
      const { sx } = bestCandidatePoints(ctx, { field, count, seed: 1 });
      const r = densityRatio(sx, ctx.nx, ctx.ny, xSplit, hi, count);
      if (count >= 2000) worst = Math.max(worst, Math.abs(r - 1));
      say(`<tr><td>${hi}</td><td>${count}</td><td>10</td>` +
          `<td class="${Math.abs(r - 1) < 0.08 ? 'pass' : 'fail'}">${num(r, 4)}</td></tr>`);
    }
  }
  say('</table>');
  const ok = worst < 0.08;
  say(`<p>density follows the field — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst at the high count ${num(worst, 4)}). ` +
      `<span class="note">Scored at 8% and only on the high-count rows, which is ` +
      `a looser bar than the subdivider's 2% and deliberately so: that one is ` +
      `exact by construction and this one is a feedback loop. If the low-count ` +
      `rows are much worse than the high-count ones, that is the loop not having ` +
      `had enough points to converge and is the expected shape, not a fault.</span></p>`);
}

// -------------------------------------------------------- the reason it exists
// REPORTED, NOT SCORED. Blue noise is a claim about the SHAPE of the
// distribution, and sd/mean of the nearest-neighbour distance is a crude proxy
// for it -- a lattice scores well on this too, which is exactly why the flat
// field is the interesting row and why this is reported beside the others rather
// than turned into a threshold.
//
// What to look for: on flat tone a lattice has a small spread for the wrong
// reason (every distance identical because the arrangement is periodic), and
// blue noise should have a small spread for the right one (even spacing with no
// periodicity). The two are not separable by this number alone. What IS
// separable is clumping: a placer that leaves gaps and clusters has a large
// spread, and that is the failure blue noise is bought to avoid.
say('<h2>Best-candidate placer — arrangement, against the other placers</h2>');
say('<p class="note">Nearest-neighbour spread on a flat field, all four ' +
    'placements at one count. Read it for clumping, not for periodicity: this ' +
    'statistic cannot tell an even aperiodic set from a lattice, and the ' +
    'drawing is the only thing that can.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const field = new Float64Array(ctx.nx * ctx.ny).fill(1);
  const count = 800;
  say('<table><tr><th>placer</th><th>points</th><th>nearest mean</th>' +
      '<th>nearest sd</th><th>sd ÷ mean</th></tr>');
  const rows = [
    ['best-candidate', bestCandidatePoints(ctx, { field, count, seed: 1 })],
    ['lloyd', stipplePoints(ctx, { field, count, seed: 1, iterations: 6 })],
    ['subdivided', subdividePoints(ctx, { field, count })],
    ['subdivided + 8 relax', subdividePoints(ctx, { field, count, relax: 8, seed: 1 })],
  ];
  for (const [name, res] of rows) {
    const s = nearestStats(res.sx, res.sy);
    say(`<tr><td>${name}</td><td>${res.sx.length}</td>` +
        `<td>${num(s.mean, 2)}</td><td>${num(s.sd, 3)}</td>` +
        `<td>${num(s.mean > 0 ? s.sd / s.mean : 0, 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">A square lattice of this density would sit at a nearest ' +
      'distance of 11.02 with a spread of essentially zero, which is the number ' +
      'to hold the rows against. Anything well above it is clumping; anything ' +
      'at it is either a lattice or a very good packing, and only looking at the ' +
      'drawing tells you which.</p>');
}

// ------------------------------------------------------------------ the seed
say('<h2>Best-candidate placer — seed behaviour</h2>');
say('<p class="note">Unlike the subdivider this placer draws from the RNG for ' +
    'every candidate, so it must repeat at a fixed seed and differ across ' +
    'seeds. Both halves matter: the first is reproducibility, the second is ' +
    'evidence the candidates are actually being drawn.</p>');
{
  const ctx = prepare(makeImage(360, 270, 1), settings);
  const field = twoTone(ctx.nx, ctx.ny, Math.round(ctx.nx * 0.4), 4);
  const key = (r) => Array.from(r.sx).map((v, i) => `${v},${r.sy[i]}`).join(';');
  const a = key(bestCandidatePoints(ctx, { field, count: 300, seed: 1 }));
  const b = key(bestCandidatePoints(ctx, { field, count: 300, seed: 1 }));
  const c = key(bestCandidatePoints(ctx, { field, count: 300, seed: 2 }));
  const ok = a === b && a !== c;
  say(`<p>repeats at one seed: <b>${a === b ? 'yes' : 'NO'}</b>, ` +
      `differs across seeds: <b>${a !== c ? 'yes' : 'NO'}</b> — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

}
