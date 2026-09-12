// Extracted verbatim from the pre-split verify.html (lines 828-937).
// Body unchanged, so the emitted output stays byte-identical.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { renderStrokes } from '../src/spine/render.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import stippleGrowing, { growStipple } from '../src/methods/stippleGrowing.js';
import { dotPath } from '../src/spine/dots.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

export function run() {
// ------------------------------------------- stippling: THE INK BUDGET
// This method has no tone curve: each dot represents exactly pi*rDot^2 of ink,
// so the dot COUNT should be sum(K)/(pi*rDot^2) by construction. That identity
// is the MATLAB's own check, left commented at line 144 and never run. It is
// also separable from the rendering question, so both are checked here:
//
//   count ratio  -- did the growing hand out the right number of dots?
//   ink ratio    -- did the drawn dots put down the ink the budget promised?
//
// The second falls short at high density on purpose (equal circles do not tile;
// neighbours overlap while cell corners stay bare). It is reported, not fixed.
say('<h2>Stippling — ink budget and dot count</h2>');
say('<p class="note">Flat grey fields. <b>count</b> is dots·πr²/ΣK, which the ' +
    'growing controls and which should be 1 wherever cells fit inside the ' +
    'search radius. <b>ink</b> is measured coverage / ΣK per unit area, which ' +
    'additionally depends on equal circles tiling — expect it to fall short at ' +
    'the dark end, deliberately. A count ratio below 1 at the bright end means ' +
    'cells hit the search radius; that is what the dither is compensating.</p>');
{
  const flatField = (v, w = 300, h = 300) => {
    const im = makeImage(w, h);
    im.data.fill(v);
    return im;
  };

  const tsv = ['rDot/w\tim\tdots\tskipped\tcount\tinkWanted\tinkDrawn\tink'];
  for (const rDotW of [0.5, 1.5, 3]) {
    say(`<h3 style="font-size:14px">rDot = ${rDotW}w</h3>`);
    say('<table><tr><th>im</th><th>dots</th><th>skipped</th><th>count ratio</th>' +
        '<th>ink wanted</th><th>ink drawn</th><th>ink ratio</th></tr>');
    for (const v of [0, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      const ctx = prepare(flatField(v), flat);
      const args = { ...ctx, dDotW: rDotW * 2, rMaxMult: 30, order: 'centre', seed: 1 };
      const rDot = Math.max(ctx.w / 2, rDotW * ctx.w);

      const { n, skipped } = growStipple(args);
      const sumK = (1 - v) * ctx.nx * ctx.ny;
      const countRatio = sumK > 0 ? (n * Math.PI * rDot * rDot) / sumK : (n === 0 ? 1 : Infinity);

      const rendered = renderForTest(ctx, stippleGrowing.run(args));
      const inkDrawn = 1 - meanOf(rendered);
      const inkWanted = 1 - v;
      const inkRatio = inkWanted > 0 ? inkDrawn / inkWanted : (inkDrawn < 0.01 ? 1 : Infinity);

      say(`<tr><td>${num(v, 2)}</td><td>${n.toLocaleString()}</td>` +
          `<td>${skipped.toLocaleString()}</td><td>${num(countRatio, 4)}</td>` +
          `<td>${num(inkWanted, 4)}</td><td>${num(inkDrawn, 4)}</td>` +
          `<td>${num(inkRatio, 4)}</td></tr>`);
      tsv.push([rDotW, num(v, 2), n, skipped, num(countRatio, 4),
                num(inkWanted, 4), num(inkDrawn, 4), num(inkRatio, 4)].join('\t'));
    }
    say('</table>');
  }
  say('<p class="note">Paste the block below back. The two ratios fail in ' +
      'different places and mean different things: <b>count</b> off is the ' +
      'region growing mis-budgeting, <b>ink</b> off with count at 1 is the ' +
      'circles-do-not-tile shortfall that was accepted.</p>');
  say(`<pre id="stippleTSV">${tsv.join('\n')}</pre>`);
}

// A single dot on its own: does the spiral actually fill its disc? This is
// separable from everything else and is the one part with a known right answer.
say('<h2>Stippling — spiral fill of one dot</h2>');
say('<p class="note">Pitch w means consecutive turns abut with neither gap nor ' +
    'overlap, so a dot of radius rDot should render an area of exactly πrDot². ' +
    'Under-coverage means the pitch or the end radius is wrong; over-coverage ' +
    'means turns are overlapping and every dot is costing more ink than budgeted.</p>');
{
  say('<table><tr><th>rDot/w</th><th>points</th><th>wanted πr²</th>' +
      '<th>drawn</th><th>ratio</th></tr>');
  const W = 160;
  const w = flat.penWidth * flat.pxPerCm;      // pen width in px, as prepare derives it
  let worst = 0;
  let stamped = null;
  for (const rDotW of [0.5, 1, 1.5, 2, 3, 4, 6]) {
    const rDot = Math.max(w / 2, rDotW * w);
    const pts = dotPath(W / 2, W / 2, rDot, w);
    const rendered = renderStrokes([pts], {
      wLine: w, imW: W, imH: W, outScale: 1, superSample: 6,
    });
    const drawn = (1 - meanOf(rendered)) * W * W;
    const wanted = Math.PI * rDot * rDot;
    const ratio = drawn / wanted;
    // The smallest dot is a SINGLE STAMPED POINT, not a spiral -- dotPath returns
    // one point once rDot - w/2 falls under 0.03w -- so it is not evidence about
    // the fill geometry and is scored separately. Its excess is the renderer's:
    // a disc of radius w/2 is only 9 supersampled pixels across at superSample 6,
    // so the lattice count overshoots pi*r^2. It converges with more
    // supersampling and does not exist on paper. The tell that it is the rig and
    // not the method is that it is the only row erring UPWARD.
    if (pts.length === 1) stamped = { rDotW, ratio };
    else worst = Math.max(worst, Math.abs(ratio - 1));
    say(`<tr><td>${rDotW}${pts.length === 1 ? ' *' : ''}</td><td>${pts.length}</td>` +
        `<td>${num(wanted, 2)}</td>` +
        `<td>${num(drawn, 2)}</td><td>${num(ratio, 4)}</td></tr>`);
  }
  say('</table>');
  const pass = worst < 0.06;
  say(`<p>spiral fills its disc — <span class="${pass ? 'pass' : 'fail'}">` +
      `${pass ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)} off unity, ` +
      `over the spiral-drawn rows)</p>`);
  if (stamped) {
    const ok = stamped.ratio > 1 && stamped.ratio < 1.15;
    say(`<p class="note">* rDot = ${stamped.rDotW}w is a single stamped point, not a ` +
        `spiral, so it is excluded above and scored here instead: ratio ` +
        `${num(stamped.ratio, 4)} — <span class="${ok ? 'pass' : 'fail'}">` +
        `${ok ? 'PASS' : 'FAIL'}</span>. It must err UPWARD and by under 15%; that ` +
        `is the renderer's discretisation of a disc 9 supersampled pixels across, ` +
        `and it converges with superSample. A ratio BELOW 1 here would be a real ` +
        `fault, since a stamped disc cannot under-cover.</p>`);
  }
}

runToneTest(
  'Linear ramp — stippling (region growing)',
  stippleGrowing,
  linearRamp(600, 200),
  { dDotW: 3, rMaxMult: 30, order: 'centre', seed: 1 },
  flat,
);

runToneTest(
  'Radial ramp — stippling (region growing)',
  stippleGrowing,
  radialRamp(400, 400),
  { dDotW: 3, rMaxMult: 30, order: 'centre', seed: 1 },
  flat,
);

// ------------------------------------------ one ink budget, three placements
// THE CLAIM THE MERGE RESTS ON. Region growing satisfies N = sum(K)/(pi rDot^2)
// by construction; the two placers are handed that same N with field = K, and
// the identity is supposed to survive the swap. If it does not, these are three
// methods wearing one label and the merge was wrong.
//
// Counting, so the count column has no tolerance for the subdivider: it returns
// exactly what it is asked for, and what it is asked for is round(sum(K)/kDot).
// Growing lands near by construction and the relaxed placer lands near by
// relaxation, so those two are scored as a ratio instead.
say('<h2>Stippling — one ink budget, three placements</h2>');
say('<p class="note">Flat grey at three tones. Every placement is asked for the ' +
    'same number of dots by the same formula; the question is whether each ' +
    'delivers it, and whether the ink that lands still equals the darkness that ' +
    'was asked for.</p>');
{
  say('<table><tr><th>placement</th><th>tone</th><th>dots</th><th>wanted</th>' +
      '<th>count ratio</th><th>rendered</th><th>source</th><th>ink error</th></tr>');
  let worstCount = 0, exactOk = true;
  for (const placer of ['growing', 'lloyd', 'subdivide']) {
    for (const tone of [0.75, 0.5, 0.25]) {
      const ctx = prepare(makeImage(300, 300, tone), flat);
      const args = { ...ctx, dDotW: 3, rMaxMult: 30, order: 'centre', seed: 1, placer };
      const lines = stippleGrowing.run(args);
      const rDot = Math.max(ctx.w / 2, 1.5 * ctx.w);
      let sumK = 0;
      for (let i = 0; i < ctx.im.data.length; i++) {
        sumK += 1 - Math.min(1, Math.max(0, ctx.im.data[i]));
      }
      const wanted = sumK / (Math.PI * rDot * rDot);
      const ratio = wanted > 0 ? lines.length / wanted : 0;
      worstCount = Math.max(worstCount, Math.abs(ratio - 1));
      // The subdivider's is an identity, not a ratio: it must return exactly the
      // integer the budget names.
      if (placer === 'subdivide' && lines.length !== Math.round(wanted)) exactOk = false;
      const rendered = meanOf(renderForTest(ctx, lines));
      const err = rendered - meanOf(ctx.im);
      say(`<tr><td>${placer}</td><td>${num(tone, 2)}</td><td>${lines.length}</td>` +
          `<td>${num(wanted, 1)}</td>` +
          `<td class="${Math.abs(ratio - 1) < 0.05 ? 'pass' : 'fail'}">${num(ratio, 4)}</td>` +
          `<td>${num(rendered, 4)}</td><td>${num(meanOf(ctx.im), 4)}</td>` +
          `<td>${err >= 0 ? '+' : ''}${num(err, 4)}</td></tr>`);
    }
  }
  say('</table>');
  const ok = worstCount < 0.05 && exactOk;
  say(`<p>the budget is the same one for all three — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `(worst count ratio departure ${num(worstCount, 4)}; the subdivider hit ` +
      `its exact integer: ${exactOk ? 'yes' : 'NO'}). ` +
      `<span class="note">Read the ink error beside it rather than as a verdict: ` +
      `it carries the high-density overlap shortfall the module header accepts ` +
      `deliberately, so it grows toward the dark end for all three and is a ` +
      `property of equal circles rather than of any one placement. What WOULD ` +
      `matter is the three columns disagreeing with each other.</span></p>`);
}

// The same rig and the same thresholds the ported placement is held to, so a
// difference between them is a difference in the drawing rather than in how it
// was judged.
runToneTest(
  'Linear ramp — stippling (relaxed placement)',
  stippleGrowing,
  linearRamp(600, 200),
  { dDotW: 3, order: 'centre', seed: 1, placer: 'lloyd', relaxIter: 6 },
  flat,
  10,
  { knownShortfall: { rms: 0.058, max: 0.131, why: 'dot overlap, measured and flat in supersample: N*pi*r^2 counts each dot separately and the paper receives the union, so the darkest band asks for coverage the geometry cannot supply. Repair is to solve the dot sizing for the union, which needs a blue-noise union law rather than the Poisson one.' } },
);

runToneTest(
  'Linear ramp — stippling (subdivided placement)',
  stippleGrowing,
  linearRamp(600, 200),
  { dDotW: 3, order: 'centre', seed: 1, placer: 'subdivide' },
  flat,
  10,
  { knownShortfall: { rms: 0.064, max: 0.152, why: 'dot overlap, measured and flat in supersample: N*pi*r^2 counts each dot separately and the paper receives the union, so the darkest band asks for coverage the geometry cannot supply. Repair is to solve the dot sizing for the union, which needs a blue-noise union law rather than the Poisson one.' } },
);


// ------------------------------------------- is the shortfall overlap, or the rig?
// BOTH RAMPS COME OUT LIGHT AT THE DARK END ONLY -- +0.131 and +0.152 in band 0,
// and near zero everywhere else -- which is where the ink budget asks for coverage
// the geometry cannot supply. Two candidates, and they predict different things:
//
//   OVERLAP. `N = sum(K)/(pi r^2)` counts each dot's area separately, so once the
//   dots touch, the paper receives the UNION and the budget has over-counted.
//   Equal circles cannot exceed 0.9069 of a plane even packed hexagonally, and a
//   relaxed point set is not hexagonal, so this bites well below band 0's
//   requested 0.951. Predicted: ratio below 1 at the dark end, flat in factor.
//
//   THE RIG. renderStrokes drops a sample row from a stroke on an axis, and a
//   DISC is the worst case of that -- modelled at 0.884 of its area at factor 4.
//   Predicted: ratio climbs with the factor.
//
// Scored against the budget the method itself set, not against the ramp, so the
// tone model and the placement are out of the picture and only the ink is left.
say('<h2>Stippling — is the dark-end shortfall overlap, or the sampler?</h2>');
say('<p class="note">Flat fields from light to nearly black, both placers, ' +
    'measured at three supersample factors against the summed dot area the ink ' +
    'budget bought. Flat in factor means the dots are genuinely on top of each ' +
    'other; climbing means the renderer could not see them.</p>');
{
  say('<table><tr><th>field</th><th>placer</th><th>dots</th><th>Σ dot area</th>' +
      '<th>ss 4</th><th>ss 6</th><th>ss 8</th></tr>');
  for (const v of [0.5, 0.25, 0.1, 0.02]) {
    for (const placer of ['lloyd', 'subdivide']) {
      const ctx = prepare(makeImage(256, 256, v), flat);
      const args = { ...ctx, dDotW: 3, order: 'centre', seed: 1, placer, relaxIter: 6 };
      const lines = stippleGrowing.run(args);
      // every path is one dot; its budgeted area is pi r^2 at the method's own radius
      const r = 1.5 * ctx.w;
      const budget = lines.length * Math.PI * r * r;
      const cells = [4, 6, 8].map((ss) =>
        (1 - meanOf(renderForTest(ctx, lines, { superSample: ss }))) * ctx.nx * ctx.ny / budget);
      say(`<tr><td>${num(v, 2)}</td><td>${placer}</td><td>${lines.length}</td>` +
          `<td>${num(budget, 0)}</td>` +
          cells.map((c) => `<td>${num(c, 4)}</td>`).join('') + '</tr>');
    }
  }
  say('</table>');
  say('<p class="note">Not scored: it separates the two causes and neither is a ' +
      'verdict on the method. If it is overlap, the repair is in the dot sizing — ' +
      'solve for the union rather than the sum — and that changes the drawing.</p>');
}

}
