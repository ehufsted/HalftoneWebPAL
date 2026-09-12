// New with the streamline method; not sliced from the pre-split harness.
//
// Evenly-spaced streamlines of the orientation field. Six questions, and they are
// not equally answerable -- which is the point of separating them:
//
//   1. the ramp is where the model is EXACTLY right      scored tightly
//   2. how far short do line ends make it fall           reported
//   3. what does the d_test ratio buy                    the sweep that sets it
//   4. do the strokes follow the field                   scored, angle swept
//   5. is it deterministic                               scored, no tolerance
//   6. does the flat-region fallback work                scored
//
// WHY 1 AND 2 ARE SEPARATE. The tone model is coverage = w/L, which assumes lines
// run forever. Streamlines terminate, so the drawing falls short by an amount
// nothing in the model predicts. A linear ramp is the one configuration where
// that shortfall is ZERO -- constant gradient direction means straight parallel
// lines running border to border, no terminations at all -- so it isolates the
// ladder from the end effects and can be scored hard. Everything else measures
// the gap between the two, and per the planeWaves precedent that gap is the
// method's error rather than its specification, so it is reported and not folded
// back into toneBand.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { structureTensorField } from '../src/spine/field.js';
import streamlines, { traceStreamlines } from '../src/methods/streamlines.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

/** A grating at angle phi: constant orientation, high coherence. */
function grating(w, h, phi, lambda = 16) {
  const im = makeImage(w, h);
  const cx = Math.cos(phi), cy = Math.sin(phi);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      im.data[y * w + x] = 0.5 + 0.35 * Math.cos((2 * Math.PI * (x * cx + y * cy)) / lambda);
    }
  }
  return im;
}

/** Smallest angle between two orientations, mod pi, in radians. */
function orientDelta(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/**
 * Realised spacing: for a sample on one stroke, the distance to the nearest
 * sample on a DIFFERENT stroke. Sampled rather than exhaustive -- the question is
 * the distribution, and every point on a 400-point polyline says the same thing.
 */
function spacingStats(lines, stride = 8) {
  const pts = [];
  lines.forEach((line, li) => {
    for (let i = 0; i < line.length; i += stride) pts.push([line[i][0], line[i][1], li]);
  });
  const d = [];
  for (let i = 0; i < pts.length; i++) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (pts[j][2] === pts[i][2]) continue;
      const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
      const dd = dx * dx + dy * dy;
      if (dd < best) best = dd;
    }
    if (best < Infinity) d.push(Math.sqrt(best));
  }
  if (d.length === 0) return { mean: 0, sd: 0, n: 0 };
  let m = 0;
  for (const v of d) m += v;
  m /= d.length;
  let s = 0;
  for (const v of d) s += (v - m) ** 2;
  return { mean: m, sd: Math.sqrt(s / d.length), n: d.length };
}

/** Total drawn length. */
function totalLength(lines) {
  let t = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      t += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    }
  }
  return t;
}

export function run() {

// -------------------------------------------------- where the model is exact
// A linear ramp has a constant gradient, so the tangent is constant too and the
// streamlines are straight parallel lines running border to border. Nothing
// terminates early, so coverage per band must be exactly w/L(band) from the
// ladder. This is the only configuration where the tone model has no excuse, and
// it is therefore the one that gets scored with the standard rig.
runToneTest(
  'Streamlines — linear ramp (the case with no line ends)',
  streamlines,
  linearRamp(600, 200),
  { LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: 45, minLenW: 4 },
  flat,
);

runToneTest(
  'Streamlines — radial ramp',
  streamlines,
  radialRamp(400, 400),
  { LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: 45, minLenW: 4 },
  flat,
);

// ------------------------------------------------------ what line ends cost
// REPORTED, NOT SCORED. Coverage = w/L assumes lines run forever; a terminated
// line lays less ink than that. The ramp is the zero-terminations baseline, so
// the interesting number is how the shortfall grows as the field gives lines
// more reason to stop. A threshold would encode how often these three images
// happen to turn a line back.
//
// COUNTS ONLY PREMATURE ENDS -- a stroke stopped by proximity, by its own tail,
// or by the length cap. An end at the page boundary is not a loss: the stroke
// laid all the ink it was ever going to. The first version of this counted every
// endpoint, which is the stroke count doubled, reads 2.00 per stroke on every
// image, and cannot see the thing it exists to measure.
say('<h2>Streamlines — how much do premature ends cost?</h2>');
say('<p class="note">Rendered tone against the band the model predicts, with the ' +
    'count of strokes that stopped short beside it. A ramp has straight parallel ' +
    'lines running border to border, so it should show near zero of them; the ' +
    'others say what terminations are worth.</p>');
{
  say('<table><tr><th>image</th><th>strokes</th><th>stopped early</th>' +
      '<th>per stroke</th><th>per 1000px of line</th>' +
      '<th>rendered</th><th>target</th><th>short by</th></tr>');
  for (const [name, im] of [
    ['linear ramp', linearRamp(360, 270)],
    ['radial ramp', radialRamp(360, 270)],
    ['grating 36°', grating(360, 270, Math.PI / 5)],
  ]) {
    const ctx = prepare(im, settings);
    const args = { ...ctx, LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: 45, minLenW: 4 };
    const lines = streamlines.run(args);
    const built = traceStreamlines(args);
    const len = totalLength(built.lines);
    const rendered = meanOf(renderForTest(ctx, lines));
    const tgt = meanOf(streamlines.targetImage(args));
    const nL = Math.max(1, built.lines.length);
    say(`<tr><td>${name}</td><td>${lines.length}</td><td>${built.premature}</td>` +
        `<td>${num(built.premature / nL, 2)}</td>` +
        `<td>${num(len > 0 ? (1000 * built.premature) / len : 0, 2)}</td>` +
        `<td>${num(rendered, 4)}</td><td>${num(tgt, 4)}</td>` +
        `<td>${rendered - tgt >= 0 ? '+' : ''}${num(rendered - tgt, 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">"Short by" must be POSITIVE — light, never dark. A ' +
      'terminated line can only lay less ink than an unterminated one, so a ' +
      'negative entry means the spacing is coming out tighter than asked for, ' +
      'which is a different fault and a real one: it is how the seed-rejection ' +
      'bug was found. Read it against the "per 1000px" column, which is the ' +
      'density of lost line ends. If the two rise together the shortfall IS the ' +
      'terminations and a correction term has something to attach to. If a row ' +
      'is light while its termination density is near zero, the spacing is wrong ' +
      'rather than the ends, and the table below is where that shows.</p>');
}

// -------------------------------------------------- what the d_test ratio buys
// THE SWEEP THAT SETS THE CONSTANT. D_TEST_FRACTION is the one free number in
// the method and it is a trade, not a derivation: at 1 a line stops as soon as it
// runs alongside a neighbour at the intended spacing, so everything is a stub; at
// 0 lines run forever and pack tighter than the tone asked for. The sweep prices
// both ends so the shipped value is a measurement rather than a convention
// inherited from the paper.
//
// It cannot be run from outside without exposing the constant, so this measures
// its CONSEQUENCE instead -- realised spacing against requested, and stroke
// length -- at the value that ships. If the spread is large the constant is
// wrong; if strokes are stubs it is wrong the other way.
say('<h2>Streamlines — is the spacing actually even?</h2>');
say('<p class="note">Realised spacing is the distance from a sample on one ' +
    'stroke to the nearest sample on a different one. On a flat field every ' +
    'requested spacing is the same number, so the spread is pure evenness with ' +
    'nothing else mixed in.</p>');
{
  say('<table><tr><th>tone</th><th>requested L</th><th>realised mean</th>' +
      '<th>realised ÷ requested</th><th>sd</th><th>sd ÷ mean</th>' +
      '<th>strokes</th><th>mean length</th></tr>');
  for (const tone of [0.75, 0.5, 0.25]) {
    const ctx = prepare(makeImage(320, 320, tone), settings);
    const args = { ...ctx, LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: 45, minLenW: 4 };
    const built = traceStreamlines(args);
    // THE LADDER, not the naive inversion. An earlier version of this line
    // computed L = w/(1-tone) -- the spacing that would give coverage exactly
    // 1-tone if the method had no band -- and reported the method wrong by 75%
    // at every tone. It is not: the ladder interpolates 1/L linearly between
    // 1/Lmin and 1/Lmax, so the achieved coverage spans the BAND rather than
    // [0,1], and w/(1-tone) is a different quantity that the method never
    // claimed. Recomputed here from the closed form rather than read out of the
    // module, so the test still scores against the derivation and not the code.
    const Lmin = Math.max(ctx.w, 2 * ctx.w);
    const Lmax = Math.max(Lmin * 1.5, 40 * ctx.w);
    const Lreq = Lmin / (1 - tone * (1 - Lmin / Lmax));
    const s = spacingStats(built.lines);
    const len = built.lines.length > 0 ? totalLength(built.lines) / built.lines.length : 0;
    say(`<tr><td>${num(tone, 2)}</td><td>${num(Lreq, 2)}</td>` +
        `<td>${num(s.mean, 2)}</td>` +
        `<td>${num(Lreq > 0 ? s.mean / Lreq : 0, 3)}</td>` +
        `<td>${num(s.sd, 3)}</td>` +
        `<td>${num(s.mean > 0 ? s.sd / s.mean : 0, 4)}</td>` +
        `<td>${built.lines.length}</td><td>${num(len, 1)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">Reported, and the ratio column is the one to read. It ' +
      'should sit near 1: seeds are offered at the full spacing and rejected ' +
      'within it, so that is where the packing settles, and a line may only run ' +
      'in to D_TEST_FRACTION of it once it is already growing. A ratio near ' +
      'D_TEST_FRACTION itself means seed rejection has been confused with ' +
      'integration termination — which is exactly what the first version of this ' +
      'method did, reading 2.18 against a requested 3.93 at the dark end and ' +
      'over-inking every tone as a result. That is the specific regression this ' +
      'row exists to catch.</p>');
}

// ------------------------------------------------- do the strokes follow the field
// SWEPT OVER THE GRATING ANGLE, deliberately. An axis-aligned-only test passes in
// the one orientation the pixel grid cannot get wrong, which is the mistake
// docs/findings.md records against the first phase-to-spacing check.
say('<h2>Streamlines — do the strokes follow the field?</h2>');
say('<p class="note">Gratings at four angles. With angleOffset 0 the strokes ' +
    'follow the edge tangent, which for a grating of angle φ is φ+90°. Measured ' +
    'as the length-weighted mean deviation of each segment from the tangent at ' +
    'its own midpoint.</p>');
{
  say('<table><tr><th>grating φ</th><th>strokes</th><th>mean deviation</th>' +
      '<th>worst</th></tr>');
  let allOk = true;
  for (const deg of [0, 30, 60, 105]) {
    const phi = (deg * Math.PI) / 180;
    const ctx = prepare(grating(360, 270, phi), settings);
    const args = { ...ctx, LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: 45, minLenW: 4 };
    const built = traceStreamlines(args);
    const f = structureTensorField(ctx.im, Math.max(1, ctx.w), Math.max(1.5, built.meanL));
    let wsum = 0, dsum = 0, worst = 0;
    for (const line of built.lines) {
      for (let i = 1; i < line.length; i++) {
        const ax = line[i - 1][0], ay = line[i - 1][1];
        const bx = line[i][0], by = line[i][1];
        const seg = Math.hypot(bx - ax, by - ay);
        if (seg <= 0) continue;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        let j = Math.round(mx) - 1, k = Math.round(my) - 1;
        j = Math.min(ctx.nx - 1, Math.max(0, j));
        k = Math.min(ctx.ny - 1, Math.max(0, k));
        const th = f.theta[k * ctx.nx + j];
        const dev = orientDelta(Math.atan2(by - ay, bx - ax), th);
        wsum += seg; dsum += dev * seg;
        if (dev > worst) worst = dev;
      }
    }
    const meanDeg = wsum > 0 ? ((dsum / wsum) * 180) / Math.PI : 90;
    const ok = meanDeg < 12;
    allOk = allOk && ok;
    say(`<tr><td>${deg}°</td><td>${built.lines.length}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${num(meanDeg, 2)}°</td>` +
        `<td>${num((worst * 180) / Math.PI, 1)}°</td></tr>`);
  }
  say('</table>');
  say(`<p>the strokes follow the field — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span>. <span class="note">Scored on the ` +
      `length-weighted MEAN and at a loose 12°, because the worst column is ` +
      `expected to be large and is not a fault: a grating's extrema have almost ` +
      `no gradient, so coherence collapses there and the flat-angle fallback ` +
      `correctly takes over. Those are the sites the fallback exists for, and ` +
      `scoring the worst case would be scoring the feature as a defect.</span></p>`);
}

// ------------------------------------------------------------- flat regions
// THE FAILURE MODE MOST LIKELY TO MAKE THIS UNUSABLE, so it gets a verdict. A
// sky has no gradient, coherence collapses, and the tensor's orientation there is
// noise. Without the fallback the strokes knot exactly where the picture is
// calmest -- and on a photograph that is most of the frame.
say('<h2>Streamlines — does the flat-region fallback hold?</h2>');
say('<p class="note">A perfectly flat field has no orientation at all, so the ' +
    'drawing must be parallel hatching at flatAngle. Measured as the spread of ' +
    'stroke directions: near zero means parallel, large means noise.</p>');
{
  say('<table><tr><th>flatAngle</th><th>strokes</th><th>mean direction</th>' +
      '<th>deviation from flatAngle</th><th>spread</th></tr>');
  let allOk = true;
  for (const deg of [0, 45, 120]) {
    const ctx = prepare(makeImage(320, 320, 0.5), settings);
    const args = {
      ...ctx, LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: deg, minLenW: 4,
    };
    const built = traceStreamlines(args);
    // Mean direction on the DOUBLED angle, for the same mod-pi reason the method
    // itself blends there: averaging orientations near 0 and near pi cancels.
    let sx = 0, sy = 0, wsum = 0;
    const devs = [];
    for (const line of built.lines) {
      for (let i = 1; i < line.length; i++) {
        const dx = line[i][0] - line[i - 1][0], dy = line[i][1] - line[i - 1][1];
        const seg = Math.hypot(dx, dy);
        if (seg <= 0) continue;
        const th = Math.atan2(dy, dx);
        sx += Math.cos(2 * th) * seg; sy += Math.sin(2 * th) * seg; wsum += seg;
        devs.push([th, seg]);
      }
    }
    const meanTh = 0.5 * Math.atan2(sy, sx);
    let spread = 0;
    for (const [th, seg] of devs) spread += orientDelta(th, meanTh) * seg;
    spread = wsum > 0 ? (spread / wsum) : 0;
    const want = (deg * Math.PI) / 180;
    const offBy = (orientDelta(meanTh, want) * 180) / Math.PI;
    const spreadDeg = (spread * 180) / Math.PI;
    const ok = offBy < 8 && spreadDeg < 8;
    allOk = allOk && ok;
    say(`<tr><td>${deg}°</td><td>${built.lines.length}</td>` +
        `<td>${num((meanTh * 180) / Math.PI, 1)}°</td>` +
        `<td class="${offBy < 8 ? 'pass' : 'fail'}">${num(offBy, 2)}°</td>` +
        `<td class="${spreadDeg < 8 ? 'pass' : 'fail'}">${num(spreadDeg, 2)}°</td></tr>`);
  }
  say('</table>');
  say(`<p>flat means parallel, at the angle asked for — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span>. ` +
      `<span class="note">Both halves matter. A small spread with the wrong mean ` +
      `would mean the fallback works but ignores its control; the right mean with ` +
      `a large spread would mean the blend is being swamped by tensor noise, ` +
      `which is the coherence weighting failing to reach zero where it should.` +
      `</span></p>`);
}

// ------------------------------------------------------------- determinism
say('<h2>Streamlines — is it deterministic?</h2>');
say('<p class="note">Seeds are ordered by darkness and everything after is queue ' +
    'order, so this method has no seed and touches no RNG. Two runs must be ' +
    'identical to the last bit — and unlike the stochastic methods there is no ' +
    'parameter that could make them differ.</p>');
{
  const ctx = prepare(radialRamp(300, 240), settings);
  const args = { ...ctx, LminW: 2, LmaxW: 40, angleOffset: 0, flatAngle: 45, minLenW: 4 };
  const key = (ls) => ls.map((l) => l.map((p) => `${p[0]},${p[1]}`).join(';')).join('|');
  const a = key(streamlines.run(args));
  const b = key(streamlines.run(args));
  const noSeedParam = !streamlines.params.some((p) => /seed/i.test(p.key));
  const ok = a === b && noSeedParam;
  say(`<p>two runs identical: <b>${a === b ? 'yes' : 'NO'}</b>, no seed param: ` +
      `<b>${noSeedParam ? 'yes' : 'NO'}</b> — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// --------------------------------------------------------- is the field good enough
// REPORTED. The README's standing question is whether edgeTangentFlow is worth
// porting, and its own advice is to measure first. Streamlines are the method
// that makes field quality visible, so the coherence distribution the drawing was
// built on belongs on the record next to the drawing.
say('<h2>Streamlines — how coherent is the field they followed?</h2>');
{
  say('<table><tr><th>image</th><th>mean coherence</th><th>below 0.2</th>' +
      '<th>above 0.6</th></tr>');
  for (const [name, im] of [
    ['radial ramp', radialRamp(360, 270)],
    ['grating 36°', grating(360, 270, Math.PI / 5)],
    ['flat grey', makeImage(360, 270, 0.5)],
  ]) {
    const ctx = prepare(im, settings);
    const built = traceStreamlines({ ...ctx, LminW: 2, LmaxW: 40, minLenW: 4 });
    const f = structureTensorField(ctx.im, Math.max(1, ctx.w), Math.max(1.5, built.meanL));
    let sum = 0, lo = 0, hi = 0;
    for (let i = 0; i < f.coherence.length; i++) {
      const c = f.coherence[i];
      sum += c;
      if (c < 0.2) lo++;
      if (c > 0.6) hi++;
    }
    const n = f.coherence.length;
    say(`<tr><td>${name}</td><td>${num(sum / n, 4)}</td>` +
        `<td>${num((100 * lo) / n, 1)}%</td><td>${num((100 * hi) / n, 1)}%</td></tr>`);
  }
  say('</table>');
  say('<p class="note">The "below 0.2" column is the fraction of the frame where ' +
      'the fallback is doing the work rather than the image. Flat grey reading ' +
      '0.0000 and 100% is the fallback confirmed fully engaged where there is ' +
      'genuinely nothing to follow.</p>');
  say('<p class="note">BUT THIS TABLE CANNOT ANSWER THE QUESTION IT LOOKS LIKE ' +
      'IT ANSWERS. All three images are synthetic, and a ramp or a grating is ' +
      'coherent almost everywhere by construction — 0.98 and 0.99 here. The ' +
      'README asks whether structureTensorField is good enough to justify ' +
      'porting edgeTangentFlow, and that is a question about PHOTOGRAPHS, where ' +
      'coherence is patchy and the interesting regions are the ones in between. ' +
      'Reading these numbers as an answer would be reading a test at the extreme ' +
      'of the parameter it controls. The honest version needs a real image, ' +
      'which this harness has none of by design — no bundled photographs, no ' +
      'licensing questions — so it belongs in verify.html against a dropped ' +
      'file rather than here.</p>');
}

}
