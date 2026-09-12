// New with the TSP port; not sliced from the pre-split harness.
//
// A tour has one property no other method here has: it is a PERMUTATION. Almost
// everything worth checking follows from that, and none of it needs a rendered
// picture -- a tour that visits a point twice, or misses one, is wrong whatever
// it looks like.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import { hilbertIndex } from '../src/curves/hilbert.js';
import tspTour, {
  buildTour, coverageOf, TOUR_TONE, TOUR_KAPPA,
} from '../src/methods/tspTour.js';
import { say, num, flat, linearRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

export function run() {

// ------------------------------------------------------- the Hilbert index
// The index is the inverse of the curve, so the two must agree: walking
// hilbertCurve and asking hilbertIndex for each cell must give 0, 1, 2, ...
// This is checked because a wrong index would not crash -- it would just make
// the Hilbert tour a slightly worse tour, which is invisible.
say('<h2>TSP — is the Hilbert index really the curve\'s inverse?</h2>');
say('<p class="note">Every cell of a 2^m grid must receive a distinct index, ' +
    'and consecutive indices must land on ADJACENT cells. The second is the ' +
    'property that makes sorting by it a tour at all; a bit-order slip would ' +
    'still give a bijection but would teleport.</p>');
{
  say('<table><tr><th>side</th><th>cells</th><th>distinct indices</th>' +
      '<th>max step between consecutive</th><th>expected</th></tr>');
  let allOk = true;
  for (const m of [2, 3, 4, 5]) {
    const side = 1 << m;
    const cells = side * side;
    const xy = new Array(cells);
    const seen = new Set();
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const d = hilbertIndex(side, x, y);
        seen.add(d);
        xy[d] = [x, y];
      }
    }
    let maxStep = 0;
    for (let d = 1; d < cells; d++) {
      if (!xy[d] || !xy[d - 1]) { maxStep = Infinity; break; }
      maxStep = Math.max(maxStep, Math.abs(xy[d][0] - xy[d - 1][0])
                                + Math.abs(xy[d][1] - xy[d - 1][1]));
    }
    const ok = seen.size === cells && maxStep === 1;
    allOk = allOk && ok;
    say(`<tr><td>${side}</td><td>${cells}</td>` +
        `<td class="${seen.size === cells ? 'pass' : 'fail'}">${seen.size}</td>` +
        `<td class="${maxStep === 1 ? 'pass' : 'fail'}">${maxStep}</td>` +
        `<td>1</td></tr>`);
  }
  say('</table>');
  say(`<p>the index inverts the curve — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(a step of 1 in ` +
      `Manhattan distance is the defining property of the Hilbert order, and is ` +
      `what a bit-rotation slip would break while still passing the ` +
      `bijection column)</span></p>`);
}

// ------------------------------------------------------------ it is a tour
// THE PERMUTATION CHECK. Both constructions must visit every point exactly once.
// The MST crawl is the one at risk: its predecessor in this app, treePaths, lost
// a quarter of its edges by starting each branch at the wrong node, and looked
// entirely plausible doing it.
say('<h2>TSP — does the tour visit every point exactly once?</h2>');
say('<p class="note">Counting, so no tolerance. A tour that misses points draws ' +
    'a lighter picture that still looks like a tour, which is exactly the class ' +
    'of bug this app has been bitten by before.</p>');
{
  say('<table><tr><th>construction</th><th>points</th><th>tour length (entries)</th>' +
      '<th>distinct</th><th>missing</th><th>repeated</th></tr>');
  let allOk = true;
  for (const tourKind of ['mst', 'hilbert']) {
    const ctx = prepare(linearRamp(360, 270), settings);
    const built = buildTour({ ...ctx, tourKind, dMinW: 3, dMaxW: 30, improve: 'none' });
    const { ord, n } = built;
    const seen = new Set(ord);
    const rep = ord.length - seen.size;
    const missing = n - seen.size;
    const ok = ord.length === n && missing === 0 && rep === 0;
    allOk = allOk && ok;
    say(`<tr><td>${tourKind}</td><td>${n.toLocaleString()}</td>` +
        `<td class="${ord.length === n ? 'pass' : 'fail'}">${ord.length.toLocaleString()}</td>` +
        `<td>${seen.size.toLocaleString()}</td>` +
        `<td class="${missing === 0 ? 'pass' : 'fail'}">${missing}</td>` +
        `<td class="${rep === 0 ? 'pass' : 'fail'}">${rep}</td></tr>`);
  }
  say('</table>');
  say(`<p>the tour is a permutation — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// ------------------------------------------------------- improvement is sound
// TWO CLAIMS, AND THE SECOND IS THE ONE THAT MATTERS. Improvement must shorten
// the tour -- but it must also still be a tour afterwards, and 2-opt reversals
// and Or-opt splices are exactly the kind of index surgery that silently drops
// or duplicates an entry. The reported gain must also match the measured
// difference, or the move accounting is wrong even if the result is valid.
say('<h2>TSP — does improvement shorten the tour and keep it a tour?</h2>');
say('<p class="note">Reported gain against measured shortening: the improver ' +
    'adds up the gain of each move it applies, so if that total disagrees with ' +
    'the before/after difference, some move did not do what it was scored on.</p>');
{
  say('<table><tr><th>construction</th><th>mode</th><th>before</th><th>after</th>' +
      '<th>reduction</th><th>moves</th><th>gain vs measured</th>' +
      '<th>still a permutation</th></tr>');
  let allOk = true;
  for (const tourKind of ['mst', 'hilbert']) {
    for (const improve of ['two', 'both']) {
      const ctx = prepare(linearRamp(360, 270), settings);
      const built = buildTour({ ...ctx, tourKind, dMinW: 3, dMaxW: 30, improve, improvePasses: 4 });
      const { ord, n, before, after, gain, moves } = built;
      const measured = before - after;
      const agree = Math.abs(gain - measured) < 1e-6 * Math.max(1, before);
      const perm = new Set(ord).size === n && ord.length === n;
      const shorter = after <= before + 1e-9;
      const ok = agree && perm && shorter;
      allOk = allOk && ok;
      say(`<tr><td>${tourKind}</td><td>${improve}</td><td>${num(before, 0)}</td>` +
          `<td class="${shorter ? 'pass' : 'fail'}">${num(after, 0)}</td>` +
          `<td>${num(measured / Math.max(1e-9, before), 4)}</td>` +
          `<td>${moves.toLocaleString()}</td>` +
          `<td class="${agree ? 'pass' : 'fail'}">${num(gain - measured, 8)}</td>` +
          `<td class="${perm ? 'pass' : 'fail'}">${perm ? 'yes' : 'BROKEN'}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>improvement is sound — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(the gain column is ` +
      `the sharp one: a valid permutation with the wrong length would mean a ` +
      `reversal was applied over the wrong span, which shortens nothing and ` +
      `scrambles the picture)</span></p>`);
}

// ------------------------------------------------------------------- tone
// C IS THE GEOMETRY CONSTANT: tour length through N points in area A is C*N*d
// with d = sqrt(A/N), so length per unit area is C/d.
//
// AN EARLIER VERSION OF THIS TABLE BRACKETED C IN [0.7124, 1.0746] AND WAS
// WRONG, in a way worth keeping written down. 0.7124 is Beardwood-Halton-
// Hammersley: the OPTIMAL tour through uniform random points. 1.0746 is a
// boustrophedon walk of a hexagonal lattice, where the nearest-neighbour
// distance is sqrt(2/sqrt(3)) times d. Only the first is a bound. The second is
// the value for one particular good tour on one particular point set, and a bad
// tour can exceed it without limit -- so using it as a ceiling declared the
// unimproved rows broken when they were merely unimproved, at 1.14 to 1.24.
//
// What the two numbers actually bracket is the OPTIMAL tour, and only from
// below: more regular point sets have LONGER optimal tours per point, because a
// clustered set offers shortcuts a lattice does not. So blue noise should sit
// between them, and anything below 0.7124 would beat a theorem.
//
// The ceiling therefore applies to the improved tour only. The unimproved rows
// are scored on the approximation ratio instead, which is the textbook property
// of an MST depth-first tour: comfortably under 2, in practice about 1.25.
say('<h2>TSP — tour length against the point spacing</h2>');
say('<p class="note">C = (tour length × d) / area, at several flat tones. The ' +
    'improved tour must land in [0.7124, 1.0746] — below beats BHH, above is ' +
    'worse than walking a lattice in rows. The unimproved tour is scored on its ' +
    'ratio to the improved one, which is what an MST crawl costs.</p>');
{
  say('<table><tr><th>construction</th><th>tone</th><th>points</th><th>d (px)</th>' +
      '<th>C unimproved</th><th>C improved</th><th>ratio</th>' +
      '<th>improved in bracket</th></tr>');
  let allOk = true;
  const lo = 0.7124, hi = 1.0746;
  const cs = [];
  for (const tourKind of ['mst', 'hilbert']) {
    for (const tone of [0.4, 0.7]) {
      const ctx = prepare(makeImage(360, 270, tone), settings);
      const raw = buildTour({ ...ctx, tourKind, dMinW: 3, dMaxW: 30, improve: 'none' });
      const opt = buildTour({ ...ctx, tourKind, dMinW: 3, dMaxW: 30, improve: 'both', improvePasses: 4 });
      const area = ctx.nx * ctx.ny;
      const d = Math.sqrt(area / opt.n);
      const c0 = (raw.after * d) / area, c1 = (opt.after * d) / area;
      cs.push(c1);
      const inBracket = c1 >= lo && c1 <= hi;
      const ratioOk = c0 / c1 < 2;
      allOk = allOk && inBracket && ratioOk;
      say(`<tr><td>${tourKind}</td><td>${num(tone, 2)}</td>` +
          `<td>${opt.n.toLocaleString()}</td><td>${num(d, 2)}</td>` +
          `<td>${num(c0, 4)}</td>` +
          `<td class="${inBracket ? 'pass' : 'fail'}">${num(c1, 4)}</td>` +
          `<td class="${ratioOk ? 'pass' : 'fail'}">${num(c0 / c1, 3)}</td>` +
          `<td>${inBracket ? 'yes' : 'OUT'}</td></tr>`);
    }
  }
  say('</table>');
  const meanC = cs.reduce((a, b) => a + b, 0) / Math.max(1, cs.length);
  say(`<p>the improved tour is a tour — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span>. Mean improved C = <b>${num(meanC, 4)}</b>, ` +
      `against TOUR_TONE.C = ${num(TOUR_TONE.C, 3)}. ` +
      `<span class="note">This column sets C, and it is a measurement of GEOMETRY ` +
      `— how long a tour is — with no rendering in it. The overlap term A is a ` +
      `measurement of INK and is fitted separately below. Two effects, two ` +
      `measurements, rather than one curve with two free constants.</span></p>`);
}

// ------------------------------------------------------ the overlap term
// A IS FITTED HERE, AND ONLY A. With C fixed by the length measurement above,
// coverage = kappa*C*w/(d + A*w) rearranges to
//
//     1/c = d/(kappa*C*w) + A/(kappa*C)
//
// which is LINEAR IN d. So the fit is a straight line through measured points
// rather than a two-parameter search, the slope gives kappa and the intercept
// gives A, and a curved residual would mean the coverage law itself is wrong
// rather than that the constants need nudging.
say('<h2>TSP — the overlap term, fitted from rendered ink</h2>');
say('<p class="note">Rendered coverage on flat fields at several spacings. ' +
    '1/coverage against d must be a STRAIGHT line; the slope sets κ and the ' +
    'intercept sets A.</p>');
{
  const ctx0 = prepare(makeImage(360, 270, 0.5), settings);
  const w = ctx0.w;
  say('<table><tr><th>requested d (px)</th><th>points</th><th>actual d</th>' +
      '<th>rendered coverage</th><th>1/coverage</th><th>model</th></tr>');
  const ds = [], invs = [];
  for (const dW of [3, 4.5, 6, 9, 14]) {
    // A flat mid-grey with dMin = dMax pins the spacing: every pixel asks for
    // the same d, so this measures one point of the curve cleanly.
    const ctx = prepare(makeImage(360, 270, 0.5), settings);
    const args = { ...ctx, tourKind: 'mst', dMinW: dW, dMaxW: dW * 1.5, improve: 'both' };
    const built = buildTour(args);
    const lines = tspTour.run(args);
    const rendered = renderForTest(ctx, lines);
    let sum = 0;
    for (let i = 0; i < rendered.data.length; i++) sum += rendered.data[i];
    const cov = 1 - sum / rendered.data.length;
    const dAct = Math.sqrt((ctx.nx * ctx.ny) / built.n);
    ds.push(dAct); invs.push(1 / Math.max(1e-9, cov));
    say(`<tr><td>${num(dW * w, 2)}</td><td>${built.n.toLocaleString()}</td>` +
        `<td>${num(dAct, 2)}</td><td>${num(cov, 4)}</td>` +
        `<td>${num(1 / Math.max(1e-9, cov), 3)}</td>` +
        `<td>${num(coverageOf(w, dAct), 4)}</td></tr>`);
  }
  // least squares 1/c = s*d + b
  const nP = ds.length;
  let sd = 0, si = 0, sdd = 0, sdi = 0;
  for (let k = 0; k < nP; k++) { sd += ds[k]; si += invs[k]; sdd += ds[k] * ds[k]; sdi += ds[k] * invs[k]; }
  const den = nP * sdd - sd * sd;
  const s = (nP * sdi - sd * si) / den;
  const b = (si - s * sd) / nP;
  // residual, as the check that the LAW is right rather than the constants
  let rms = 0;
  for (let k = 0; k < nP; k++) { const e = invs[k] - (s * ds[k] + b); rms += e * e; }
  rms = Math.sqrt(rms / nP);
  const kappaFit = 1 / (s * TOUR_TONE.C * w);
  const aFit = b * kappaFit * TOUR_TONE.C;
  say('</table>');
  const straight = rms < 0.15 * (si / nP);
  say(`<p>slope ${num(s, 5)}, intercept ${num(b, 4)}, RMS residual ` +
      `${num(rms, 4)} — <span class="${straight ? 'pass' : 'fail'}">` +
      `${straight ? 'the law is linear' : 'NOT LINEAR — the coverage law is wrong'}` +
      `</span>. Fitted <b>κ = ${num(kappaFit, 4)}</b>, <b>A = ${num(aFit, 4)}</b> ` +
      `against the current ${num(TOUR_KAPPA, 3)} and ${num(TOUR_TONE.A, 3)}. ` +
      `<span class="note">A negative fitted A would mean strokes are covering ` +
      `MORE than their own width, which is impossible and would point at the ` +
      `point count rather than the ink.</span></p>`);
}

// -------------------------------------------------------- what cutting costs
// The control, measured. Cutting long edges lightens the drawing, and the whole
// question is whether it lightens it where the tone model wanted light.
say('<h2>TSP — the cost of cutting long edges</h2>');
say('<p class="note">Cut factor 0 is one unbroken stroke. Above it the tour ' +
    'breaks wherever an edge exceeds that many LOCAL spacings. Stroke count and ' +
    'ink both move; the question this answers is how much ink a given cut ' +
    'costs.</p>');
{
  say('<table><tr><th>improve</th><th>cut factor</th><th>strokes</th>' +
      '<th>total length</th><th>ink kept</th><th>longest edge / local d</th></tr>');
  for (const improve of ['none', 'both']) {
    let base = 0;
    // measure the worst edge first, so the sweep can be read against it
    const ctxM = prepare(linearRamp(360, 270), settings);
    const argsM = { ...ctxM, tourKind: 'mst', dMinW: 3, dMaxW: 30, improve };
    const built = buildTour(argsM);
    let worst = 0;
    for (let i = 0; i < built.n; i++) {
      const a = built.ord[i], b = built.ord[(i + 1) % built.n];
      const len = Math.hypot(built.sx[a] - built.sx[b], built.sy[a] - built.sy[b]);
      const at = (p) => {
        let jx = Math.min(ctxM.nx - 1, Math.max(0, Math.round(built.sx[p]) - 1));
        let iy = Math.min(ctxM.ny - 1, Math.max(0, Math.round(built.sy[p]) - 1));
        return built.d[iy * ctxM.nx + jx];
      };
      worst = Math.max(worst, len / ((at(a) + at(b)) / 2));
    }
    for (const cutFactor of [0, 4, 2, 1.5, 1.2]) {
      const ctx = prepare(linearRamp(360, 270), settings);
      const lines = tspTour.run({ ...ctx, tourKind: 'mst', dMinW: 3, dMaxW: 30, improve, cutFactor });
      const len = pathLength(lines);
      if (cutFactor === 0) base = len;
      say(`<tr><td>${improve}</td><td>${cutFactor === 0 ? 'none' : num(cutFactor, 1)}</td>` +
          `<td>${lines.length.toLocaleString()}</td><td>${num(len, 0)}</td>` +
          `<td>${num(len / Math.max(1e-9, base), 4)}</td>` +
          `<td>${cutFactor === 0 ? num(worst, 2) : ''}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">No verdict — this sets expectations for the slider. The ' +
      'threshold is on the ratio to the LOCAL spacing, not an absolute length, ' +
      'so a long edge across a light area is not cut: out there the spacing is ' +
      'long too, and the edge is correct. That is why an improved tour barely ' +
      'responds until the factor drops near 1.5 — the improvement has already ' +
      'removed the edges worth cutting, which is the better fix. The unimproved ' +
      'rows show the control doing real work, and the last column says how much ' +
      'headroom there was to begin with.</p>');
}

// ------------------------------------------------------------------ tone ramps
runToneTest('TSP — spanning-tree crawl, ramp',
  tspTour, linearRamp(360, 270),
  { tourKind: 'mst', dMinW: 3, dMaxW: 30, improve: 'both' }, settings);

runToneTest('TSP — Hilbert order, ramp',
  tspTour, linearRamp(360, 270),
  { tourKind: 'hilbert', dMinW: 3, dMaxW: 30, improve: 'both' }, settings);

}
