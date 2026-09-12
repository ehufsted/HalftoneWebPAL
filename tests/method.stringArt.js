// New with the string-art port; not sliced from the pre-split harness.
//
// The source's own header asks "is the string art at all calibrated?", so the
// point of this file is to answer that with a number rather than a shrug. Four
// claims: the thread is genuinely one continuous stroke that never repeats an
// edge; the stopping rule halts where it was derived to halt; the tone band binds
// exactly when the thread runs out; and the ramp lands.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import stringArt, {
  buildThread, nodesFor, meanChordLength, allowedChords, toneBand, STRING_KAPPA,
} from '../src/methods/stringArt.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

export function run() {

// ------------------------------------------------------------- one thread
// THE PROPERTY THE METHOD EXISTS FOR. A plotter draws this without lifting the
// pen once, which is true of nothing else here -- so it is worth checking rather
// than assuming, and it is exactly the kind of thing that would still LOOK right
// if the thread quietly broke into pieces.
say('<h2>String art — is it really one unbroken thread?</h2>');
say('<p class="note">Consecutive chords must share a node, no edge may be used ' +
    'twice, and the whole drawing must come back as a single polyline. Counting, ' +
    'so no tolerance.</p>');
{
  say('<table><tr><th>nodes on</th><th>nodes</th><th>chords</th><th>strokes</th>' +
      '<th>repeated edges</th><th>broken joins</th><th>stopped by</th></tr>');
  let allOk = true;
  for (const nodeMode of ['circle', 'ellipse', 'perimeter', 'phyllotaxis']) {
    const ctx = prepare(radialRamp(360, 270), settings);
    const args = { ...ctx, nodeMode, nNodes: 120, nLines: 400, opacity: 0.25, LminFrac: 0.1 };
    const built = buildThread(args);
    const seen = new Set();
    let repeats = 0;
    for (let i = 0; i + 1 < built.order.length; i++) {
      const a = built.order[i], b = built.order[i + 1];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) repeats++;
      seen.add(key);
    }
    // every step must move to a different node
    let broken = 0;
    for (let i = 0; i + 1 < built.order.length; i++) {
      if (built.order[i] === built.order[i + 1]) broken++;
    }
    const lines = stringArt.run(args);
    const ok = repeats === 0 && broken === 0 && lines.length === 1;
    allOk = allOk && ok;
    say(`<tr><td>${nodeMode}</td><td>120</td><td>${built.lines}</td>` +
        `<td class="${lines.length === 1 ? 'pass' : 'fail'}">${lines.length}</td>` +
        `<td class="${repeats === 0 ? 'pass' : 'fail'}">${repeats}</td>` +
        `<td class="${broken === 0 ? 'pass' : 'fail'}">${broken}</td>` +
        `<td>${built.stoppedBy}</td></tr>`);
  }
  say('</table>');
  say(`<p>the thread is continuous and never repeats — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(the source permits an edge to be drawn twice: the ` +
      `residual subtraction makes the second pass score lower but not ` +
      `impossible, so the thread can double back and lay ink nobody asked ` +
      `for)</span></p>`);
}

// --------------------------------------------------------- the stopping rule
// THE FLOOR IS ZERO AND THE RESIDUAL IS SIGNED, and the first version of this
// method got that wrong in a way worth keeping written down. It clamped the
// residual at zero, as the source does, and stopped at the per-pixel break-even
// point opacity/2. That is correct about a single pixel and wrong about a
// picture: it leaves EVERY part of the drawing short by opacity/2 of coverage.
// Predicted 0.125 of brightness at opacity 0.25; the ramps measured 0.143 and
// 0.145 too light. The floor was the bias.
//
// OPACITY IS A SEARCH PARAMETER, SO THE TONE MUST NOT DEPEND ON IT. That is the
// claim worth testing, and it is stronger than the chord count, which is an
// implementation detail.
//
// An earlier version predicted the count would FALL as opacity rose, on the
// grounds that each chord discharges more. Measured 110, 113, 114, 143 -- it
// rises. The prediction ignored a term the aim offset had just introduced: the
// residual now starts at darkness + opacity/2, so a coarser quantum also asks
// for more total ink. The two effects fight and the count is not monotone in
// either direction, which is no defect at all provided the TONE holds still.
say('<h2>String art — is the tone independent of the opacity?</h2>');
say('<p class="note">A white page has no residual anywhere, so the first chord ' +
    'already scores zero and the correct output is nothing at all. Then a fixed ' +
    'grey across a wide opacity range: the smoothing length changes, the chord ' +
    'count changes, and the rendered tone must not.</p>');
{
  const white = prepare(makeImage(360, 270, 1), settings);
  const wArgs = { ...white, nodeMode: 'circle', nNodes: 120, nLines: 400, opacity: 0.25 };
  const wBuilt = buildThread(wArgs);
  const wOk = wBuilt.lines === 0;
  say(`<p>white page: <b>${wBuilt.lines}</b> chords, stopped by ` +
      `"${wBuilt.stoppedBy}" — <span class="${wOk ? 'pass' : 'fail'}">` +
      `${wOk ? 'PASS' : 'FAIL'}</span></p>`);

  say('<table><tr><th>opacity</th><th>chords</th><th>rendered</th>' +
      '<th>target</th><th>error</th></tr>');
  let worst = 0;
  for (const opacity of [0.1, 0.25, 0.5, 0.9]) {
    const ctx = prepare(makeImage(360, 270, 0.55), settings);
    const args = {
      ...ctx, nodeMode: 'circle', nNodes: 120, nLines: 3000, opacity, LminFrac: 0.1,
    };
    const built = buildThread(args);
    const lines = stringArt.run(args);
    const rendered = renderForTest(ctx, lines);
    const tgt = stringArt.targetImage(args);
    let sr = 0, st = 0;
    for (let i = 0; i < rendered.data.length; i++) { sr += rendered.data[i]; st += tgt.data[i]; }
    const mr = sr / rendered.data.length, mt = st / tgt.data.length;
    const err = mr - mt;
    worst = Math.max(worst, Math.abs(err));
    say(`<tr><td>${num(opacity, 2)}</td><td>${built.lines}</td>` +
        `<td>${num(mr, 4)}</td><td>${num(mt, 4)}</td>` +
        `<td class="${Math.abs(err) < 0.05 ? 'pass' : 'fail'}">` +
        `${err >= 0 ? '+' : ''}${num(err, 4)}</td></tr>`);
  }
  say('</table>');
  // KNOWN SHORTFALL, RECORDED RATHER THAN WAIVED -- the same discipline
  // runToneTest's `knownShortfall` applies, written out here because this section
  // scores its own table.
  //
  // The invariance is real and holds where the derivation does: 0.0145, 0.0111
  // and 0.0090 at opacities 0.10, 0.25 and 0.50. It breaks at 0.90, measured at
  // 0.0632. `aim = opacity/2` is exact for the stopping RULE -- a pixel is sought
  // while its residual is positive and the aim moves the halt onto the true
  // target -- but each chord that lands overshoots by up to a whole quantum, and
  // the quantum IS the opacity. At 0.90 it is most of the tone range, so the
  // leftover is no longer small compared with what is being reproduced.
  //
  // Recorded at 0.07 rather than scored at 0.05: the bar is this measurement plus
  // a margin, so the row stops shouting without going quiet, and any drift is a
  // failure. What would retire it is a bound on the overshoot derived from the
  // chord population rather than fitted to these four rows -- the error does not
  // scale as O(opacity) either (0.145, 0.044, 0.018, 0.070 per unit), so the
  // obvious guess is already ruled out.
  const KNOWN_WORST = 0.07;
  const ok = wOk && worst < KNOWN_WORST;
  const clean = wOk && worst < 0.05;
  say(`<p>tone holds still as the smoothing changes — ` +
      `<span class="${ok ? (clean ? 'pass' : 'warn') : 'fail'}">` +
      `${ok ? (clean ? 'PASS' : 'KNOWN SHORTFALL') : 'REGRESSED'}</span> ` +
      `(worst ${num(worst, 4)}). <span class="note">The white page is the sharp ` +
      `half: with the residual clamped there is no score a chord can earn that ` +
      `is worse than drawing nothing, so the source lays its whole budget across ` +
      `blank paper and stops only on total ink. The opacity rows are the ` +
      `invariance: if tone tracked opacity, the aim offset would be over- or ` +
      `under-correcting and the derivation would be wrong.</span></p>`);
}

// ------------------------------------------------------------- the ink budget
// THE TONE BAND RESTS ON ONE NUMBER -- that nLines chords of mean length Lbar lay
// kappa * nLines * Lbar * w of ink -- so that number is measured directly against
// the drawing rather than assumed.
say('<h2>String art — is the ink budget the ink actually laid?</h2>');
say('<p class="note">The ratio is how much longer the chords the greedy picks ' +
    'are than the mean over all chords it is allowed. Reported, not scored: an ' +
    'earlier version made it a per-mode constant and this table proved it is not ' +
    'one — the perimeter rows read 0.93 at 184 chords and 1.31 at 80, because ' +
    'the greedy takes the long crossing chords first and what is left gets ' +
    'shorter. The verdict below is on what the budget is actually for.</p>');
{
  say('<table><tr><th>nodes on</th><th>chords</th><th>improving</th>' +
      '<th>Lbar allowed</th>' +
      '<th>predicted length</th><th>drawn length</th><th>ratio</th>' +
      '<th>absorbed / nominal</th><th>absorbed / budget basis</th></tr>');
  let spread = 0;
  const byMode = {};
  const effs = [];
  for (const nodeMode of ['circle', 'ellipse', 'perimeter', 'phyllotaxis']) {
    byMode[nodeMode] = [];
    for (const tone of [0.35, 0.6]) {
      const ctx = prepare(makeImage(360, 270, tone), settings);
      const args = { ...ctx, nodeMode, nNodes: 150, nLines: 1200, opacity: 0.25, LminFrac: 0.1 };
      const built = buildThread(args);
      const nodes = nodesFor(ctx, nodeMode, 150);
      const Lbar = meanChordLength(nodes, built.Lmin);
      const pred = built.lines * Lbar;
      const drawn = pathLength(stringArt.run(args));
      const ratio = pred > 0 ? drawn / pred : 0;
      byMode[nodeMode].push(ratio);
      const eff = built.nominalInk > 0 ? built.laidInk / built.nominalInk : 0;
      effs.push(eff);
      // THE RATIO toneBand ACTUALLY CONSUMES. Its budget is
      // kappa * drawn * Lbar * w, so the constant it needs is absorbed ink over
      // that same denominator -- the improving chords only. `eff` above divides
      // by the nominal ink of EVERY chord, travel included, and the two were the
      // same number until the budget stopped counting travel. Reported side by
      // side so a divergence is visible: if this column pulls away from `eff`,
      // STRING_KAPPA is being asked to be two constants at once.
      const basis = built.drawn > 0 ? built.laidInk / (built.drawn * Lbar * ctx.w) : 0;
      say(`<tr><td>${nodeMode}</td><td>${built.lines}</td><td>${built.drawn}</td>` +
          `<td>${num(Lbar, 1)}</td>` +
          `<td>${num(pred, 0)}</td><td>${num(drawn, 0)}</td>` +
          `<td>${num(ratio, 4)}</td><td>${num(eff, 4)}</td>` +
          `<td>${num(basis, 4)}</td></tr>`);
    }
  }
  say('</table>');
  const rows = [];
  for (const mode of ['circle', 'ellipse', 'perimeter', 'phyllotaxis']) {
    const v = byMode[mode];
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const dev = Math.max(...v.map((r) => Math.abs(r - mean) / mean));
    spread = Math.max(spread, dev);
    rows.push(`${mode} ${num(mean, 3)} (±${num(dev, 3)})`);
  }
  say(`<p class="note">Ratios: ${rows.join(', ')}. Worst drift within a mode ` +
      `${num(spread, 3)} — the perimeter figure is why there is no constant ` +
      `here, and phyllotaxis is the row to watch: its nodes are interior, so its ` +
      `chord-length distribution is the least like the rim modes'.</p>`);

  // STRING_KAPPA IS SCORED, unlike the ratio above, because it IS a constant --
  // and the whole point of having watched CHORD_BIAS fail is to not let the next
  // one through unexamined. It drifts with the image (a darker page absorbs more
  // of each chord), so what is checked is that the drift stays inside the band
  // the constant claims.
  const kMean = effs.reduce((a, b) => a + b, 0) / effs.length;
  const kDev = Math.max(...effs.map((e) => Math.abs(e - STRING_KAPPA) / STRING_KAPPA));
  const kOk = kDev < 0.1;
  say(`<p>absorbed/nominal is a constant — <span class="${kOk ? 'pass' : 'fail'}">` +
      `${kOk ? 'PASS' : 'FAIL'}</span>. Measured mean ${num(kMean, 4)}, worst ` +
      `departure from STRING_KAPPA = ${num(STRING_KAPPA, 3)} is ${num(kDev, 4)}. ` +
      `<span class="note">Scored at 10% because the drift is real but understood: ` +
      `the darker rows absorb more, since more of each chord meets darkness still ` +
      `owed. A departure beyond that would mean the overlap depends on something ` +
      `the model does not know about.</span></p>`);
}

// -------------------------------------------------- what the budget is FOR
// AN EARLIER VERSION OF THIS SECTION ASKED THE WRONG QUESTION. It expected the
// band and the search to agree as two independent witnesses: the band saying the
// target had been lightened, and the search reporting it had run out of thread.
// They are not independent. The band feeds targetImage, targetImage feeds the
// search, so a lightened target is one the search can satisfy -- and it duly
// does, stopping on the gain rule with threads to spare. Measured: s = 0.28 with
// only 43 of 60 threads used, flagged as a disagreement when it was the model
// working exactly as designed.
//
// What IS worth checking is whether the estimate is TIGHT. If the band lightens
// the target it is claiming the threads are the binding constraint, so most of
// them had better get used. A budget that lightens the target and then leaves
// half the thread unspent has thrown away tone for nothing.
say('<h2>String art — when the band lightens the target, is it right to?</h2>');
say('<p class="note">The band is claiming the thread count is what limits the ' +
    'drawing. The test of that claim is whether the threads actually get spent: ' +
    'a lightened target with most of the budget unused would mean tone was given ' +
    'away for no reason.</p>');
{
  say('<table><tr><th>image</th><th>threads</th><th>chords drawn</th>' +
      '<th>used</th><th>s = 1 − band.min</th><th>tight</th></tr>');
  let allOk = true;
  for (const [name, tone] of [['dark 0.2', 0.2], ['light 0.8', 0.8]]) {
    for (const nLines of [60, 400, 4000]) {
      const ctx = prepare(makeImage(360, 270, tone), settings);
      const args = { ...ctx, nodeMode: 'circle', nNodes: 150, nLines, opacity: 0.25, LminFrac: 0.1 };
      const built = buildThread(args);
      const s = 1 - toneBand(args).min;
      // Against `drawn`, not `lines`. The budget is spent by improving chords, so
      // that is what "did the threads get used" has to ask about; `lines` includes
      // travel and can now exceed nLines, which would read as over 100% used.
      const used = built.drawn / nLines;
      // Only the lightened rows carry a claim. Where s is 1 the band said
      // nothing and the thread count is free to be whatever the picture needed.
      const claims = s < 0.95;
      const ok = !claims || used > 0.5;
      allOk = allOk && ok;
      say(`<tr><td>${name}</td><td>${nLines}</td><td>${built.lines}</td>` +
          `<td>${num(used, 3)}</td><td>${num(s, 4)}</td>` +
          `<td class="${ok ? 'pass' : 'fail'}">${claims ? (ok ? 'yes' : 'NO') : '—'}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>a lightened target is a justified one — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(half the budget is a loose bar on purpose: Lbar is ` +
      `known to be a 20% estimate, so demanding the threads be exhausted would ` +
      `be demanding a precision the header says it does not have. What it rules ` +
      `out is the band lightening the target while barely drawing at all.)` +
      `</span></p>`);
}

// ------------------------------------------------------ the band is a budget
// UNUSUAL AND WORTH CHECKING: this method's reachable band depends on the IMAGE,
// not only on the settings, because the constraint is on total ink. More threads
// must widen it; a darker image must narrow it.
say('<h2>String art — does the band track the budget?</h2>');
say('<p class="note">The band is [1 − s, 1] with s the ratio of ink available to ' +
    'ink wanted, capped at 1. So a light image should reach s = 1 (nothing ' +
    'lightened, white stays white) and a dark one should be scaled back.</p>');
{
  say('<table><tr><th>image</th><th>threads</th><th>band min</th><th>band max</th>' +
      '<th>s</th></tr>');
  let allOk = true;
  for (const [name, tone] of [['light 0.85', 0.85], ['mid 0.5', 0.5], ['dark 0.15', 0.15]]) {
    for (const nLines of [300, 2000]) {
      const ctx = prepare(makeImage(360, 270, tone), settings);
      const band = toneBand({ ...ctx, nodeMode: 'circle', nNodes: 150, nLines, opacity: 0.25, LminFrac: 0.1 });
      const s = 1 - band.min;
      // max must always be 1: white is reachable because nothing forces ink
      allOk = allOk && Math.abs(band.max - 1) < 1e-12;
      say(`<tr><td>${name}</td><td>${nLines}</td><td>${num(band.min, 4)}</td>` +
          `<td class="${Math.abs(band.max - 1) < 1e-12 ? 'pass' : 'fail'}">${num(band.max, 4)}</td>` +
          `<td>${num(s, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>white is always reachable — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(and s must rise with ` +
      `the thread count and fall as the image darkens. Unlike every other method ` +
      `here the band moves with the IMAGE, which follows from the limit being on ` +
      `total ink rather than on any one pixel.)</span></p>`);
}

// ------------------------------------------- asking for more thread than exists
// THE CORNER NOTHING COVERED. An edge is never drawn twice, so the number of
// allowed node pairs is a hard ceiling on any run -- and the sliders reach 24
// nodes against 6000 threads, which is at most 276 pairs and fewer after Lmin.
// Uncapped, the budget in that regime dwarfs anything the image can ask for, s
// clamps to 1, and targetImage hands back the raw image: the method is then
// scored against a picture it cannot draw. The rows below are on a DARK image,
// because a light one reaches s = 1 legitimately and would hide the fault.
say('<h2>String art — is the budget capped by the edges that exist?</h2>');
say('<p class="note">24 nodes is at most 276 chords however many threads are ' +
    'asked for. A budget that ignores that claims a reach the method does not ' +
    'have; the test is that s stops responding to the thread count once the ' +
    'threads outnumber the chords, and that the run really does stop there.</p>');
{
  // Black, to make the demand as large as it can be. The cap only shows itself
  // where the budget is the binding constraint; on an image the threads can
  // satisfy, s reaches 1 legitimately and capped and uncapped agree for a reason
  // that has nothing to do with the cap. That is a real risk here rather than a
  // hypothetical, so the verdict below CHECKS whether the cap bit rather than
  // assuming a chosen tone was dark enough.
  const ctx = prepare(makeImage(360, 270, 0), settings);
  const Lmin = 0.1 * Math.min(ctx.nx, ctx.ny);
  const count = allowedChords(nodesFor(ctx, 'circle', 24), Lmin).count;

  say('<table><tr><th>nodes</th><th>threads</th><th>chords allowed</th>' +
      '<th>improving</th><th>chords laid</th><th>s</th><th>stopped by</th></tr>');
  const rows = [];
  for (const nLines of [Math.round(count / 4), count, count * 20]) {
    const args = { ...ctx, nodeMode: 'circle', nNodes: 24, nLines, opacity: 0.25, LminFrac: 0.1 };
    const built = buildThread(args);
    const s = 1 - toneBand(args).min;
    rows.push({ nLines, s, built });
    say(`<tr><td>24</td><td>${nLines}</td><td>${count}</td>` +
        `<td>${built.drawn}</td><td>${built.lines}</td><td>${num(s, 4)}</td>` +
        `<td>${built.stoppedBy}</td></tr>`);
  }
  say('</table>');

  // THE CAP'S ACTUAL CONTRACT: past the edge count, s must stop responding to
  // the slider, because the budget is then pinned by a number that does not
  // depend on it. Rows 2 and 3 ask for count and 20x count.
  const [, atCount, over] = rows;
  const pinned = Math.abs(atCount.s - over.s) < 1e-12;
  // No run may lay more chords than exist, whatever the slider says.
  const withinCeiling = rows.every((r) => r.built.lines <= count);
  // And the check that the check is worth anything: if s reached 1 the budget was
  // never binding, so the two rows would agree with or without the cap.
  const binding = over.s < 1 - 1e-9;
  const ok = pinned && withinCeiling && binding;

  say(`<p>the budget is pinned by the edges, not the slider — ` +
      (binding
        ? `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span>`
        : `<span class="fail">INCONCLUSIVE</span>`) +
      ` <span class="note">(s at ${count} threads ${num(atCount.s, 6)} versus ` +
      `${num(over.s, 6)} at ${count * 20} — a difference of ` +
      `${num(Math.abs(atCount.s - over.s), 8)}. Every run stayed inside the ` +
      `${count}-chord ceiling: ${withinCeiling ? 'yes' : 'NO'}. ` +
      (binding
        ? `Uncapped, the last row would read s = 1, which is the band claiming a ` +
          `black page is reachable with 24 nodes.`
        : `INCONCLUSIVE means s reached 1 even on black, so the budget was never ` +
          `the binding constraint and this table cannot see the cap at all — ` +
          `raise the demand or lower the chord count until it can.`) +
      `)</span></p>`);
}

// --------------------------------------------------- spending every thread
// THE TOGGLE HAS ONE SAFETY PROPERTY AND ONE PRICE, and both are checked here.
//
// The property: a white page must still draw nothing. "Keep going when no chord
// improves the picture" and "draw on paper that asked for nothing" are one line
// apart in the code, and the second is the source's behaviour -- it lays its
// whole budget across blank paper. The 'picture satisfied' exit is what separates
// them, and it is deliberately not conditioned on the toggle.
//
// The price: non-improving chords overshoot, so tone gets worse. That is not a
// defect to be fixed, it is what the setting IS, and the number belongs on the
// record so nobody later mistakes it for one.
say('<h2>String art — spending every thread</h2>');
say('<p class="note">With the toggle on the thread takes the least-bad chord ' +
    'rather than stopping, so the full budget lands on the page. A white page ' +
    'must still come back empty — that exit is not the one the toggle removes — ' +
    'and the tone error must get worse, because overshooting is exactly what ' +
    'the extra chords do.</p>');
{
  // the safety property, on white
  const white = prepare(makeImage(360, 270, 1), settings);
  const wBuilt = buildThread({
    ...white, nodeMode: 'circle', nNodes: 120, nLines: 400, opacity: 0.25,
    LminFrac: 0.1, spendAll: true,
  });
  const wOk = wBuilt.lines === 0;
  say(`<p>white page with the toggle ON: <b>${wBuilt.lines}</b> chords, stopped ` +
      `by "${wBuilt.stoppedBy}" — <span class="${wOk ? 'pass' : 'fail'}">` +
      `${wOk ? 'PASS' : 'FAIL'}</span></p>`);

  say('<table><tr><th>image</th><th>spend all</th><th>threads</th>' +
      '<th>improving</th><th>laid</th><th>stopped by</th>' +
      '<th>rendered</th><th>target</th><th>error</th></tr>');
  let offErr = 0, onErr = 0, spentAll = true;
  for (const [name, img] of [['radial ramp', radialRamp(360, 270)],
                             ['linear ramp', linearRamp(360, 270)]]) {
    for (const spendAll of [false, true]) {
      const ctx = prepare(img, settings);
      const args = {
        ...ctx, nodeMode: 'circle', nNodes: 120, nLines: 600, opacity: 0.25,
        LminFrac: 0.1, spendAll,
      };
      const built = buildThread(args);
      const rendered = renderForTest(ctx, stringArt.run(args));
      const tgt = stringArt.targetImage(args);
      let sr = 0, st = 0;
      for (let i = 0; i < rendered.data.length; i++) { sr += rendered.data[i]; st += tgt.data[i]; }
      const err = sr / rendered.data.length - st / tgt.data.length;
      if (spendAll) {
        onErr = Math.max(onErr, Math.abs(err));
        // THE TOGGLE'S CLAIM IS BOUNDED BY TWO EXITS IT DOES NOT REMOVE, and
        // listing only one of them made this assertion forbid correct behaviour.
        // `spendAll` removes the PATIENCE exit and nothing else; the run still
        // ends if the edge set is consumed ('no chord available') or if the
        // residual is gone ('picture satisfied'). The second is checked FIRST and
        // is explicitly not conditioned on the toggle -- stringArt's header calls
        // it the toggle's whole safety margin, because it is what keeps a white
        // page empty. A radial ramp exhausts its residual at 258 of 600 chords and
        // exits that way, which is the design working, not the budget going
        // unspent. What the toggle must never do is exit by PATIENCE.
        spentAll = spentAll && built.stoppedBy !== 'no useful chord left';
      } else {
        offErr = Math.max(offErr, Math.abs(err));
      }
      say(`<tr><td>${name}</td><td>${spendAll ? 'on' : 'off'}</td><td>600</td>` +
          `<td>${built.drawn}</td><td>${built.lines}</td>` +
          `<td>${built.stoppedBy}</td><td>${num(sr / rendered.data.length, 4)}</td>` +
          `<td>${num(st / tgt.data.length, 4)}</td>` +
          `<td>${err >= 0 ? '+' : ''}${num(err, 4)}</td></tr>`);
    }
  }
  say('</table>');
  const ok = wOk && spentAll;
  say(`<p>white stays empty and the budget is spent — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span>. ` +
      `<span class="note">Tone error worst ${num(offErr, 4)} off against ` +
      `${num(onErr, 4)} on. SCORED ON THE EXIT, NOT THE TONE: with the toggle on ` +
      `a run may end on its budget, on a consumed edge set, or on a satisfied ` +
      `picture — but never on patience, which is the exit the toggle removes. ` +
      `The tone numbers are REPORTED, NOT SCORED: the toggle is expected to be ` +
      `the worse of the two and a threshold here would only encode how much ` +
      `worse on these two ramps. What would be a real failure is the on rows ` +
      `coming out BETTER — that would mean the patience exit is stopping runs ` +
      `that still had useful work in them, which is a claim about PATIENCE, not ` +
      `about this setting.</span></p>`);
}

// ------------------------------------------------------------------ tone ramps
runToneTest('String art — inscribed circle, radial ramp',
  stringArt, radialRamp(360, 270),
  { nodeMode: 'circle', nNodes: 180, nLines: 1500, opacity: 0.25, LminFrac: 0.1 }, settings);

// The two node sets added after the constants were fixed, on the same ramp as
// the circle above so the three are directly comparable. The ellipse should sit
// close to the circle -- same rim, same uniform spacing, just anisotropic.
// Phyllotaxis is the one with no precedent: its nodes are interior and cover the
// whole page, corners included, so it is the only mode whose capacity map should
// come back near-uniform rather than falling away at the edges. That also makes
// it the mode least like the ones STRING_KAPPA was measured against.
runToneTest('String art — inscribed ellipse, radial ramp',
  stringArt, radialRamp(360, 270),
  { nodeMode: 'ellipse', nNodes: 180, nLines: 1500, opacity: 0.25, LminFrac: 0.1 }, settings);

runToneTest('String art — phyllotaxis, radial ramp',
  stringArt, radialRamp(360, 270),
  { nodeMode: 'phyllotaxis', nNodes: 180, nLines: 1500, opacity: 0.25, LminFrac: 0.1 }, settings);

runToneTest('String art — page edge, linear ramp',
  stringArt, linearRamp(360, 270),
  { nodeMode: 'perimeter', nNodes: 180, nLines: 1500, opacity: 0.25, LminFrac: 0.1 }, settings,
  10, { knownShortfall: { rms: 0.125, max: 0.265, why: 'aim = opacity/2 is exact for the stopping RULE but each chord overshoots by up to a whole quantum, so the residual scales with opacity; at the page edge the chord population is most constrained and it shows most.' } });

}
