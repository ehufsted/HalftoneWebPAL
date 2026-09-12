// Extracted verbatim from the pre-split verify.html (lines 338-356), with a
// reach sweep appended.
//
// WHY THE SWEEP. Both ramps fail, and the error is monotone from black to white
// -- +0.225 at the darkest band decaying to 0 at the lightest. That is the
// signature of a FLOOR: the method cannot get dark enough, and the tone test
// scores it against a ramp it never agreed to reach. The fix in that case is
// `targetImage`, but only once the floor is DERIVED. Writing a band from the one
// number the ramp happens to show would be fitting a constant to a test, which
// is the thing this project does not do.
//
// So sweep the control that plausibly sets it. If the floor moves with the depth
// cap, the band is a function of `nIterMax` and can be written down. If it
// plateaus, the cap is not what binds and the stopping rule is -- a different
// derivation, and possibly a real shortfall rather than a limit.

import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

export function run() {
// --------------------------------------------------- polygon subdivision
// Both of its tests are ratios of ink to darkness rather than tuned constants,
// so like the quadtree this method's tone check IS its verification.
runToneTest(
  'Linear ramp — polygon subdivision',
  polygonSubdivision,
  linearRamp(600, 200),
  { nIterMax: 13, nAngles: 0, drawOutline: false },
  flat,
  10,
  { knownShortfall: { rms: 0.118, max: 0.225, why: 'the P*w/2 ink model counts each edge separately and edges that meet share paper; the correction is derived and measured (0.785 predicted against 0.781) and now sits in the stop rule, but the KEEP test is what binds and still uses the uncorrected w/2 reference. See the module header.' } },
);

runToneTest(
  'Radial ramp — polygon subdivision',
  polygonSubdivision,
  radialRamp(400, 400),
  { nIterMax: 13, nAngles: 0, drawOutline: false },
  flat,
  10,
  { knownShortfall: { rms: 0.078, max: 0.116, why: 'the P*w/2 ink model counts each edge separately and edges that meet share paper; the correction is derived and measured (0.785 predicted against 0.781) and now sits in the stop rule, but the KEEP test is what binds and still uses the uncorrected w/2 reference. See the module header.' } },
);


// -------------------------------------------------- what floor, and set by what
say('<h2>Polygon subdivision — what is the darkest it can reach, and why?</h2>');
say('<p class="note">Flat fields, so there is no ramp to average over and the ' +
    'number is the reach itself. The method splits until a polygon’s own ' +
    'perimeter already lays the ink its darkness asks for, or until the depth cap ' +
    'stops it. Predicted: if the cap binds, coverage keeps rising with nIterMax ' +
    'and roughly doubles per two levels, since halving a polygon’s area lengthens ' +
    'its perimeter by √2. If it plateaus, the cap is not the limit and the ' +
    'stopping rule is.</p>');
{
  say('<table><tr><th>nIterMax</th><th>strokes</th>' +
      '<th>K on black</th><th>K on 0.25</th><th>K on 0.5</th></tr>');
  const rows = [];
  for (const nIterMax of [4, 6, 8, 10, 13, 16]) {
    const cells = [];
    let strokes = 0;
    for (const v of [0, 0.25, 0.5]) {
      const ctx = prepare(makeImage(300, 300, v), flat);
      const args = { ...ctx, nIterMax, nAngles: 0, drawOutline: false };
      const lines = polygonSubdivision.run(args);
      if (v === 0) strokes = lines.length;
      cells.push(1 - meanOf(renderForTest(ctx, lines)));
    }
    rows.push({ nIterMax, black: cells[0] });
    say(`<tr><td>${nIterMax}</td><td>${strokes}</td>` +
        cells.map((c) => `<td>${num(c, 4)}</td>`).join('') + '</tr>');
  }
  say('</table>');
  // COMPARE THE LAST TWO ROWS, NOT THE FIRST AND LAST. Every control climbs from
  // its floor; what says whether the cap still binds is whether the reach is
  // still moving where the cap is set.
  const a = rows[rows.length - 2], b = rows[rows.length - 1];
  const climbing = b.black > a.black * 1.05;
  say(`<p class="note">Black reach ${num(rows[0].black, 4)} at ` +
      `${rows[0].nIterMax} splits, ${num(a.black, 4)} at ${a.nIterMax}, ` +
      `${num(b.black, 4)} at ${b.nIterMax} — ` +
      (climbing
        ? 'STILL CLIMBING where the cap is set, so the depth cap is what binds ' +
          'and the band is a function of nIterMax.'
        : 'PLATEAUED, so the cap is not what binds at the default and the ' +
          'STOPPING RULE is. The floor is then a property of that rule and of ' +
          'the pen, not of the control.') +
      ` Not scored: this measures reach, and a threshold would restate whichever ` +
      `answer the sweep gives.</p>`);
}


// ------------------------------------------------- is the shortfall overlap?
// SUM AGAINST UNION, THE SAME QUESTION THAT SETTLED dashedStreamlines. Both this
// method's ramps come out light, and the two candidate causes make opposite
// predictions that a tone number cannot separate:
//
//   OVERLAP -- the ink model adds up stroke lengths, but strokes that meet
//   share paper. The model then believes it has laid enough and stops early.
//   Predicted: rendered/model well below 1 and NOT improving with supersampling,
//   because the overlap is geometry and not a sampling artefact.
//
//   SAMPLING -- the renderer drops a sample row from any stroke lying along an
//   axis (architecture.md, and see samplingAllowance). Predicted: rendered/model
//   improves as the factor rises, and vanishes where the supersampled width is
//   odd.
//
// The model here is deliberately the naive one the method itself uses: drawn
// length times the pen, which is exactly what "ignores corner overlap" means.
say('<h2>Polygon subdivision — is the shortfall overlap, or the sampler?</h2>');
say('<p class="note">One drawing, measured at three supersample factors against ' +
    'drawn length × pen. W = pen × factor, and the open-interval bias only bites ' +
    'when W is even. Flat at every factor means the ink is genuinely shared ' +
    'between strokes; climbing means the rig could not see it.</p>');
{
  say('<table><tr><th>field</th><th>strokes</th><th>drawn × pen</th>' +
      '<th>W=6 (ss 4)</th><th>W=9 (ss 6)</th><th>W=12 (ss 8)</th></tr>');
  for (const v of [0.2, 0.45, 0.7]) {
    const ctx = prepare(makeImage(256, 256, v), flat);
    const args = { ...ctx, nIterMax: 13, nAngles: 0, drawOutline: false };
    const lines = polygonSubdivision.run(args);
    const model = pathLength(lines) * ctx.w;
    const cells = [4, 6, 8].map((ss) =>
      (1 - meanOf(renderForTest(ctx, lines, { superSample: ss }))) * ctx.nx * ctx.ny / model);
    say(`<tr><td>${num(v, 2)}</td><td>${lines.length}</td><td>${num(model, 0)}</td>` +
        cells.map((c) => `<td>${num(c, 4)}</td>`).join('') + '</tr>');
  }
  say('</table>');
  say('<p class="note">Not scored: it names the cause, it does not judge the ' +
      'method. A ratio near 1 and flat would mean neither effect is present and ' +
      'the ink model is simply wrong about something else.</p>');
}

}
