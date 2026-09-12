// New with the dashed-streamlines method; not sliced from the pre-split harness.
//
// PREDICTIONS STATED BEFORE THE RUN. The tone model here has no constant in it at
// all: the page is partitioned among the lines, every pixel's ink is owed to
// exactly one of them, and a dash is charged the stadium area it covers. So a
// failing row means the partition or the charge is wrong, not that something
// needs tuning.
//
// What each section is actually asking:
//
//   1. Does partitioning deliver the ink? This is the claim that distinguishes
//      the method from charging each line a fixed strip of width d_sep, which
//      under-inks wherever a line terminates. Scored on a RADIAL ramp, because a
//      curved field is where terminations happen -- a flat field would let the
//      wrong model pass.
//   2. Is tone still independent of dash length, now that carriers curve?
//   3. Does it degenerate into dashHatching where the picture is flat? It should:
//      with no structure the field falls back to a fixed angle, so the two
//      methods are drawing the same thing by different routes and must agree on
//      tone. A disagreement means one of the two ink laws has drifted.
//   4. Can path joining bend a dash? Neighbouring streamlines run nearly
//      parallel, so this is the V bug's worst case.
//   5. Is it deterministic? There is no RNG anywhere in either half.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import { takeNote } from '../src/spine/notes.js';
import { optimizeOrder, joinCoincidentLines } from '../src/spine/pathOptimizer.js';
import dashedStreamlines from '../src/methods/dashedStreamlines.js';
import { traceStreamlines } from '../src/methods/streamlines.js';
import dashHatching from '../src/methods/dashHatching.js';
import { say, num, flat, radialRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

function runOn(image, params) {
  const ctx = prepare(image, settings);
  const tally = {};
  const args = { ...ctx, ...params, dashTally: tally };
  takeNote();
  const lines = dashedStreamlines.run(args);
  const note = takeNote();
  const rendered = 1 - meanOf(renderForTest(ctx, lines));
  const requested = 1 - meanOf(dashedStreamlines.targetImage(args));
  return { ctx, args, lines, rendered, requested, note, tally };
}

/** A ramp with real structure, so the field has something to follow. */
function lobes(W, amp = 0.4) {
  const im = makeImage(W, W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / (W - 1)) * 2 - 1, v = (y / (W - 1)) * 2 - 1;
      im.data[y * W + x] = Math.min(1, Math.max(0,
        0.5 + amp * Math.cos(3.0 * u + 1.5 * v * v) * Math.exp(-0.6 * (u * u + v * v))));
    }
  }
  return im;
}

export function run() {

// -------------------------------------------------- does the partition deliver
// AN INK LEDGER, NOT A TONE NUMBER. A single ratio cannot say which of three
// things went wrong, and the first version of this section reported only the
// ratio -- which sent the diagnosis to the tone law twice when the fault was in
// the sampling. Every step is now priced in px^2 of ink and the columns are meant
// to be read left to right until one of them breaks:
//
//   asked     the target's own integral over the page. If this disagrees with
//             `demanded`, the partition is losing pixels -- look at `unreachable`.
//   demanded  what the carriers were told they owe.
//   charged   what the marks were billed for. Against `demanded` this measures
//             the debt bookkeeping and nothing else.
//   rendered  what the renderer actually found on the page. Against `charged`
//             this measures the area law -- whether a dash covers what it was
//             billed. That is the only comparison that involves geometry.
//
// NO POLYGON/CANVAS CORRECTION HERE, unlike dashHatching. That method integrates
// its demand ALONG carriers, so its total is the polygon's geometric area and
// reads 0.9945 of the canvas. This one sums demand PER PIXEL, so its total is the
// pixel count and the two denominators already agree.
say('<h2>Dashed streamlines — does partitioning the page deliver the ink?</h2>');
say('<p class="note">A radial ramp, where the field curves and streamlines ' +
    'terminate against each other constantly. Every column is ink in px², so the ' +
    'ratios below are exact accounting rather than tone estimates. Predicted: ' +
    'demanded = asked, charged = demanded, rendered = charged, all to within a ' +
    'dash or two out of thousands.</p>');
{
  say('<table><tr><th>sep ×pen</th><th>lines</th><th>dashes</th>' +
      '<th>asked</th><th>demanded</th><th>charged</th><th>rendered</th>' +
      '<th>dem/ask</th><th>chg/dem</th><th>rend/chg</th>' +
      '<th>drawn</th><th>law(drawn)</th><th>rend/law</th><th>fresh/abut</th></tr>');
  let worstPartition = 0, worstBudget = 0, worstArea = 0;
  for (const sepW of [3, 5, 8, 10]) {
    const r = runOn(radialRamp(360, 360), { sepW, dashW: 6, minLenW: 6 });
    const px = r.ctx.nx * r.ctx.ny;
    const asked = r.requested * px;
    const rendered = r.rendered * px;
    const t = r.tally;
    const demRatio = asked > 0 ? t.demanded / asked : 1;
    const chgRatio = t.demanded > 0 ? t.charged / t.demanded : 1;
    const areaRatio = t.charged > 0 ? rendered / t.charged : 1;
    worstPartition = Math.max(worstPartition, Math.abs(demRatio - 1));
    worstBudget = Math.max(worstBudget, Math.abs(chgRatio - 1));
    worstArea = Math.max(worstArea, Math.abs(areaRatio - 1));
    // THE LAW APPLIED TO THE GEOMETRY THAT REACHED THE PAGE, not to what was
    // charged. `charged` is arc length billed; `drawn` is arc length that survived
    // the clip. If those differ the fault is geometric bookkeeping; if they agree
    // and the render still falls short, the marks are overlapping each other.
    const lawOnDrawn = t.drawn * r.ctx.w + t.fresh * (Math.PI * r.ctx.w * r.ctx.w) / 4;
    say(`<tr><td>${sepW}</td><td>${t.lines}</td><td>${t.dashes}</td>` +
        `<td>${num(asked, 0)}</td><td>${num(t.demanded, 0)}</td>` +
        `<td>${num(t.charged, 0)}</td><td>${num(rendered, 0)}</td>` +
        `<td>${num(demRatio, 4)}</td><td>${num(chgRatio, 4)}</td>` +
        `<td>${num(areaRatio, 4)}</td>` +
        `<td>${num(t.drawn, 0)}</td><td>${num(lawOnDrawn, 0)}</td>` +
        `<td>${num(rendered / lawOnDrawn, 4)}</td>` +
        `<td>${t.fresh} / ${t.abutting}</td></tr>`);
  }
  say('</table>');
  const rows = [
    ['the partition demands what the target asks', worstPartition, 0.02,
     'ink is being lost before any mark is placed — pixels assigned to no line, or ' +
     'past the assignment cap. The unreachable column is the same quantity.'],
    ['the budget charges what it was told', worstBudget, 0.02,
     'the debt bookkeeping is dropping or inventing ink — carry, credit or the ' +
     'saturation cap.'],
    ['a dash covers what it was charged', worstArea, 0.03,
     'the area law is wrong for this geometry: dashes overlapping each other, ' +
     'caps counted that the render does not draw, or ink laid outside the canvas.'],
  ];
  for (const [claim, worst, tol, hint] of rows) {
    const ok = worst < tol;
    say(`<p>${claim} — <span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
        `(worst ${num(worst, 4)}, tolerance ${tol}). ` +
        `<span class="note">${hint}</span></p>`);
  }
}

// ------------------------------------------------- a closed orbit, traced once
// THE REGRESSION FOR THE INTEGRATOR BUG THIS METHOD FOUND. A radial ramp's
// streamlines are exact circles, and `grow` traces a line as two independent
// halves from the seed. Neither half was in the shared index yet, and each
// self-checked only against its own points -- so on a closed orbit both halves
// ran the whole way round and the polyline was two loops of one circle, drawn on
// top of each other. `halfLine` now takes the first half as a second thing to
// stop against.
//
// The check is per line and needs no packing: a polyline that covers its own
// ground twice renders about half the ink its length says it should.
say('<h2>Dashed streamlines — is a closed orbit traced once?</h2>');
say('<p class="note">Each traced carrier rendered on its own, against the stadium ' +
    'law for its own length. Predicted: every line reads near 1.00. A line that ' +
    'doubled back over itself reads near 0.5, and the worst-case column is the one ' +
    'to watch — an average over many lines hides a few doubled ones.</p>');
{
  const P = { sepW: 10, dashW: 6, minLenW: 6 };
  const ctx = prepare(radialRamp(360, 360), settings);
  const built = traceStreamlines({ ...ctx, ...P }, {
    spacing: new Float64Array(ctx.nx * ctx.ny).fill(10 * ctx.w),
    spacings: { w: ctx.w, Lmin: 10 * ctx.w, Lmax: 10 * ctx.w },
  });
  const caps = (Math.PI * ctx.w * ctx.w) / 4;
  let worst = 1, worstLen = 0, doubled = 0;
  for (const line of built.lines) {
    let len = 0;
    for (let i = 1; i < line.length; i++) {
      len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    }
    if (len < 40) continue;                       // too short to judge
    const got = (1 - meanOf(renderForTest(ctx, [line]))) * ctx.nx * ctx.ny;
    const ratio = got / (len * ctx.w + caps);
    if (ratio < 0.85) doubled++;
    if (ratio < worst) { worst = ratio; worstLen = len; }
  }
  const ok = worst > 0.85;
  say(`<p>${built.lines.length} carriers; worst covers ${num(worst, 4)} of its ` +
      `length × pen (that line is ${num(worstLen, 0)} px long), and ${doubled} ` +
      `read below 0.85 — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span>. <span class="note">A cluster near 0.5 is ` +
      `the two-halves bug returning; a single low outlier is more likely a line ` +
      `that hairpinned, which is legitimate.</span></p>`);
}

// ------------------------------------------------------- do the marks overlap?
// THE ENSEMBLE QUESTION, and the one an isolated-geometry model cannot answer.
// Every single-dash effect measured in spine.dash.js is worth 1-5%: a bend costs
// under 2% up to 120 degrees, a curve under 1%, an axis-aligned stroke 16% but
// only when it sits exactly on a sample row, and a random mixture of orientations
// should average within a percent of the law. The method is nonetheless 6-15%
// short. That leaves one mechanism: the charge is a SUM over marks while the page
// is a UNION, and those differ exactly when marks overlap.
//
// So render the dashes one at a time and add up the areas, then render them all
// together. Sum minus union IS the overlap, measured rather than reasoned about.
say('<h2>Dashed streamlines — is the shortfall marks overlapping each other?</h2>');
say('<p class="note">Predicted, if the marks are laid where the packing says: sum ' +
    'and union agree to well under a percent, because two streamlines are at least ' +
    'a third of a separation apart and a mark is one pen wide. Any real gap between ' +
    'them is ink counted twice by the budget and once by the paper — which is ' +
    'precisely the missing quantity.</p>');
{
  say('<table><tr><th>sep ×pen</th><th>dashes</th><th>sum of marks</th>' +
      '<th>union on page</th><th>overlap</th><th>union/sum</th></tr>');
  let worst = 0;
  for (const sepW of [5, 10]) {
    const r = runOn(radialRamp(360, 360), { sepW, dashW: 6, minLenW: 6 });
    const px = r.ctx.nx * r.ctx.ny;
    let sum = 0;
    for (const line of r.lines) sum += (1 - meanOf(renderForTest(r.ctx, [line]))) * px;
    const union = r.rendered * px;
    const ratio = sum > 0 ? union / sum : 1;
    worst = Math.max(worst, 1 - ratio);
    say(`<tr><td>${sepW}</td><td>${r.lines.length}</td><td>${num(sum, 0)}</td>` +
        `<td>${num(union, 0)}</td><td>${num(sum - union, 0)}</td>` +
        `<td>${num(ratio, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.02;
  say(`<p>the marks do not overlap — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)} of the ink laid ` +
      `twice). <span class="note">If this FAILS, the packing is letting lines run ` +
      `closer than d_test and the budget is paying for ink the page receives once ` +
      `— look at the integrator, not the ink law. If it PASSES, the shortfall is ` +
      `in the area law after all and spine.dash.js says which term.</span></p>`);
}

// ------------------------------------------------ dash length must not move tone
say('<h2>Dashed streamlines — is tone independent of dash length?</h2>');
say('<p class="note">One image, one separation, dash length over a 16× range. ' +
    'Predicted: rendered tone constant, dash count falling as 1/d. Curved carriers ' +
    'are the new risk here — a dash is charged its ARC length, and charging the ' +
    'chord instead would show up as tone drifting down as dashes get longer and ' +
    'cut more corner.</p>');
{
  say('<table><tr><th>dash ×pen</th><th>dashes</th><th>rendered K</th>' +
      '<th>drawn cm</th><th>dashes × dash</th></tr>');
  const rows = [];
  for (const dashW of [1, 2, 4, 8, 16]) {
    const r = runOn(lobes(360), { sepW: 8, dashW, minLenW: 6 });
    rows.push({ dashW, n: r.lines.length, rendered: r.rendered });
    say(`<tr><td>${dashW}</td><td>${r.lines.length}</td>` +
        `<td>${num(r.rendered, 4)}</td><td>${num(pathLength(r.lines), 0)}</td>` +
        `<td>${num(r.lines.length * dashW, 0)}</td></tr>`);
  }
  say('</table>');
  const tones = rows.map((r) => r.rendered);
  const spread = Math.max(...tones) - Math.min(...tones);
  const ok = spread < 0.02;
  say(`<p>tone is independent of dash length — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `(spread ${num(spread, 4)}). <span class="note">Tone falling as the dash ` +
      'grows means arc length and chord length have been confused somewhere.</span></p>');
}

// ------------------------------------ it must become dashHatching on a flat field
say('<h2>Dashed streamlines — does it agree with dashHatching where the image is flat?</h2>');
say('<p class="note">With no structure the direction field has nothing to follow ' +
    'and both methods fall back to a fixed angle, so they are drawing the same ' +
    'picture by two different routes: straight carriers at a fixed spacing versus ' +
    'streamlines packed at the same separation. Their tone must agree. This is the ' +
    'cheapest check that the two ink laws have not drifted apart now that they ' +
    'share spine/dash.js.</p>');
{
  say('<table><tr><th>image B</th><th>requested K</th><th>streamlines K</th>' +
      '<th>hatching K</th><th>difference</th></tr>');
  let worst = 0;
  for (const v of [0.8, 0.65, 0.5]) {
    const P = { sepW: 8, dashW: 6, minLenW: 6, flatAngle: 26, angleOffset: 0 };
    const a = runOn(makeImage(360, 360, v), P);
    const ctx = prepare(makeImage(360, 360, v), settings);
    const hArgs = { ...ctx, spacingW: 8, dashW: 6, angleDeg: 26, phase: 'uniform' };
    const hRendered = 1 - meanOf(renderForTest(ctx, dashHatching.run(hArgs)));
    const diff = Math.abs(a.rendered - hRendered);
    worst = Math.max(worst, diff);
    say(`<tr><td>${num(v, 2)}</td><td>${num(a.requested, 4)}</td>` +
        `<td>${num(a.rendered, 4)}</td><td>${num(hRendered, 4)}</td>` +
        `<td>${num(diff, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.01;
  say(`<p>the two agree on flat tone — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst difference ${num(worst, 4)}). ` +
      '<span class="note">They share the same band and the same ink law, so a ' +
      'difference here is one of them mis-measuring the area its carriers own — ' +
      'the partition against the fixed strip width.</span></p>');
}

// ------------------------------------------------ joining must not bend a dash
// AGAINST AN UNJOINED BASELINE, which the first version of this section got
// wrong. A dash here is a sub-arc of a streamline, so it has interior vertices of
// its own -- and streamlines legitimately hairpin at a half-index singularity in
// the field, which architecture.md records as correct behaviour rather than a
// case to handle. Counting every sharp interior turn therefore counted the
// CARRIERS' own bends: at 1×pen the check reported 68 corners on a run with zero
// joins in it, which is a rig fault and not a drawing fault.
//
// The question is only ever whether JOINING added a corner, so the baseline is
// the same dash set unjoined. Any excess is the joiner welding two ends that are
// not the same point.
say('<h2>Dashed streamlines — does path joining ever bend a dash?</h2>');
say('<p class="note">Neighbouring streamlines run nearly parallel and are traced ' +
    'in arbitrary directions, so this is the worst case in the app for the ' +
    'pipeline’s join tolerance. Predicted: joining changes the corner count by ' +
    'zero at every separation. The absolute counts are the carriers’ own hairpins ' +
    'and are expected to be non-zero and to grow as the packing tightens.</p>');
{
  const corners = (paths) => {
    let n = 0, worst = 0;
    for (const path of paths) {
      for (let i = 1; i < path.length - 1; i++) {
        const ax = path[i][0] - path[i - 1][0], ay = path[i][1] - path[i - 1][1];
        const bx = path[i + 1][0] - path[i][0], by = path[i + 1][1] - path[i][1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 1e-9 || lb < 1e-9) continue;
        const c = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
        const turn = (Math.acos(c) * 180) / Math.PI;
        if (turn > 45) n++;
        worst = Math.max(worst, turn);
      }
    }
    return { n, worst };
  };

  say('<table><tr><th>sep ×pen</th><th>tol ×pen</th><th>dashes</th><th>paths</th>' +
      '<th>joins</th><th>corners before</th><th>corners after</th>' +
      '<th>added</th><th>worst turn</th></tr>');
  let anyAdded = false;
  for (const sepW of [8, 4, 2, 1.5, 1]) {
    const r = runOn(lobes(240), { sepW, dashW: 6, minLenW: 6 });
    const pens = Math.min(1.5, dashedStreamlines.maxJoinPens(r.args));
    const ordered = optimizeOrder(r.lines);
    const joined = joinCoincidentLines(ordered, pens * r.ctx.w);
    const before = corners(ordered);
    const after = corners(joined);
    const added = after.n - before.n;
    if (added > 0) anyAdded = true;
    say(`<tr><td>${sepW}</td><td>${num(pens, 2)}</td><td>${r.lines.length}</td>` +
        `<td>${joined.length}</td><td>${ordered.length - joined.length}</td>` +
        `<td>${before.n}</td><td>${after.n}</td>` +
        `<td class="${added ? 'fail' : ''}">${added}</td>` +
        `<td>${num(after.worst, 1)}°</td></tr>`);
  }
  say('</table>');
  say(`<p>joining adds no corner — <span class="${anyAdded ? 'fail' : 'pass'}">` +
      `${anyAdded ? 'FAIL' : 'PASS'}</span>. <span class="note">A positive ` +
      `“added” column means two dash ends within the slop tolerance that are not ` +
      `the same point — check maxJoinPens is still being consulted. The “before” ` +
      `column rising with tightness is the field hairpinning, which is correct.` +
      `</span></p>`);
}

// ------------------------------------------------------------- the ramp, scored
runToneTest(
  'Radial ramp — dashed streamlines',
  dashedStreamlines,
  radialRamp(400, 400),
  { sepW: 8, dashW: 6, minLenW: 6 },
  settings,
);

// ----------------------------------------------------------------- determinism
say('<h2>Dashed streamlines — is it deterministic?</h2>');
{
  const P = { sepW: 8, dashW: 6, minLenW: 6 };
  const a = runOn(lobes(240), P);
  const b = runOn(lobes(240), P);
  const same = JSON.stringify(a.lines) === JSON.stringify(b.lines);
  say(`<p>two runs: <span class="${same ? 'pass' : 'fail'}">` +
      `${same ? 'identical' : 'DIFFERENT'}</span>. ` +
      '<span class="note">Neither half of this method draws from the RNG — the ' +
      'integrator is queue-ordered and the dasher is an integral — so anything but ' +
      'identical means unseeded randomness has crept in.</span></p>');
}

}
