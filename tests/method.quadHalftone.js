// Extracted verbatim from the pre-split verify.html (lines 307-337).
// Body unchanged, so the emitted output stays byte-identical.

import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

export function run() {
// ------------------------------------------------------ quadtree crosses
// This one has no tone curve at all -- it subdivides on whether the rendered
// result got closer. So the tone test is the whole verification, and the
// merge pass is worth measuring separately.
// The MATLAB's accept/reject rule stops as soon as a cross would overshoot,
// and since ink is only ever added the residual is always on the light side.
// Both rules are run here so the correction can be measured rather than assumed.
runToneTest(
  'Linear ramp — quadtree crosses (faithful rule)',
  quadHalftone,
  linearRamp(600, 200),
  { maxDepth: 9, ditherDecisions: false },
  flat,
  10,
  // NOT SCORED, and the ledger above is why. This is the source's own
  // accept/reject rule, kept so the correction can be measured against it, and
  // its committed ink scatters from 0.92 to 1.10 of what the image asks for
  // depending on the field -- it over-commits in shadow and under-commits in the
  // midtones. That error then superimposes on the renderer's axis-aligned
  // sampling loss and the two partly cancel, so neither a raw comparison nor an
  // allowance for the sampling gives an honest verdict: subtracting the sampling
  // bound leaves this row reading 0.18 DARK, which is the over-commit showing
  // through. The number worth having is the dithered row beside it, whose
  // committed ink is 1.00 of asked on every field.
  { scoreBy: 'none' },
);

runToneTest(
  'Linear ramp — quadtree crosses (dithered decisions)',
  quadHalftone,
  linearRamp(600, 200),
  { maxDepth: 9, ditherDecisions: true },
  flat,
  10,
  // Every stroke is a horizontal or vertical arm, so the renderer loses a
  // full sample row of each. See samplingAllowance.
  { axisAlignedStrokes: true },
);

runToneTest(
  'Radial ramp — quadtree crosses (dithered decisions)',
  quadHalftone,
  radialRamp(400, 400),
  { maxDepth: 9, ditherDecisions: true },
  flat,
  10,
  // Every stroke is a horizontal or vertical arm, so the renderer loses a
  // full sample row of each. See samplingAllowance.
  { axisAlignedStrokes: true },
);


// ----------------------------------------------------------- the ink ledger
// WHY A LEDGER AND NOT A TONE NUMBER. Both modes fail their ramps and the two
// failures do not look alike: the faithful rule reaches black and overshoots it
// slightly, with one isolated spike where the quadtree's levels are coarse, while
// the dithered rule is systematically light across the whole shadow half and is
// WORSE at the darkest band than the rule it was meant to correct. A single RMS
// cannot tell "the recursion declined to commit" from "the committed ink did not
// land", and those want opposite repairs.
//
// A quadtree has no global tone ladder to score against either. Its depth is
// chosen per region, so a band of the ramp is a MIXTURE of depths rather than one
// rung -- which is why the staircase that works for crosshatchQuantized is not
// available here, and why this is measured instead.
//
//   asked      ink the image calls for, summed darkness over the page.
//   committed  what the recursion's own accumulator says it laid. `trial` nets
//              out overlap, so this is ink, not stroke length.
//   rendered   what the renderer finds.
//
// committed/asked is the DECISION RULE. rendered/committed is whether the ink
// lands where the accumulator thinks it does.
say('<h2>Quadtree crosses — where does the ink go?</h2>');
say('<p class="note">Flat fields and both decision rules. Predicted, if the ' +
    'dithered rule does what its derivation claims: committed ≈ asked in both ' +
    'modes, because the ordered threshold is supposed to make expected ink equal ' +
    'the shortfall. Any gap in committed/asked is the rule declining to recurse; ' +
    'any gap in rendered/committed is the accumulator disagreeing with the page.</p>');
{
  say('<table><tr><th>field</th><th>rule</th><th>crosses</th><th>declined</th>' +
      '<th>asked</th><th>committed</th><th>rendered</th>' +
      '<th>com/ask</th><th>rend/com</th></tr>');
  for (const v of [0.15, 0.35, 0.55, 0.75]) {
    for (const dither of [false, true]) {
      const ctx = prepare(makeImage(256, 256, v), flat);
      const tally = {};
      const args = { ...ctx, maxDepth: 9, ditherDecisions: dither, quadTally: tally };
      const lines = quadHalftone.run(args);
      const rendered = (1 - meanOf(renderForTest(ctx, lines))) * ctx.nx * ctx.ny;
      say(`<tr><td>${num(v, 2)}</td><td>${dither ? 'dithered' : 'faithful'}</td>` +
          `<td>${tally.crosses}</td><td>${tally.declined}</td>` +
          `<td>${num(tally.asked, 0)}</td><td>${num(tally.committed, 0)}</td>` +
          `<td>${num(rendered, 0)}</td>` +
          `<td>${num(tally.asked > 0 ? tally.committed / tally.asked : 1, 4)}</td>` +
          `<td>${num(tally.committed > 0 ? rendered / tally.committed : 1, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">Not scored: this locates the shortfall, it does not judge ' +
      'it. The repair differs by column — a low com/ask is the stopping rule, a ' +
      'low rend/com is the accumulator or the renderer disagreeing about what a ' +
      'cross covers.</p>');
}

// ------------------------------------------- is rend/com the sampling parity?
// THE LEDGER SAYS THE METHOD IS RIGHT AND THE MEASUREMENT IS NOT, so this is the
// check that could refute it. com/ask came out at 1.00 under the dithered rule on
// every field, while rend/com sat at 0.83-0.89 on all eight rows regardless of
// rule -- so the ink is decided correctly and then measured short.
//
// EVERY STROKE THIS METHOD DRAWS IS AXIS-ALIGNED. renderStrokes tests d2 < r2 at
// sample centres, so a stroke of supersampled width W centred on a sample row
// covers an OPEN interval: W-1 samples when W is even, W when it is odd.
// architecture.md records this and tells measurement rigs to snap carriers to
// half-integer supersampled rows -- which is not available here, because the
// carriers are block centres the algorithm chooses. At the harness's factor of 4
// and this pen, W = 1.5 * 4 = 6, an even number, so the predicted reading is
// 5/6 = 0.833.
//
// The prediction that makes this falsifiable: at superSample 6 the width is
// W = 9, ODD, and the shortfall should simply vanish. If rend/com moves to about
// 1.0 there while the geometry is untouched, the ink was always on the page and
// the factor-4 reading is the artefact. If it stays at 0.85, the cross really is
// laying less ink than the accumulator believes and the fault is in the method.
say('<h2>Quadtree crosses — is the shortfall the sampling parity?</h2>');
say('<p class="note">The same drawing, measured at three supersample factors. ' +
    'W = pen × factor; the open-interval test drops a row only when W is even. ' +
    'Predicted: 0.833 at factor 4 (W = 6), about 1.00 at factor 6 (W = 9), and ' +
    'back down at factor 8 (W = 12).</p>');
{
  say('<table><tr><th>field</th><th>factor</th><th>W</th><th>parity</th>' +
      '<th>committed</th><th>rendered</th><th>rend/com</th></tr>');
  for (const v of [0.35, 0.65]) {
    const ctx = prepare(makeImage(256, 256, v), flat);
    const tally = {};
    const args = { ...ctx, maxDepth: 9, ditherDecisions: true, quadTally: tally };
    const lines = quadHalftone.run(args);
    for (const ss of [4, 6, 8]) {
      const W = ctx.w * ss;
      const even = Math.abs(W - 2 * Math.round(W / 2)) < 1e-9;
      const rendered =
        (1 - meanOf(renderForTest(ctx, lines, { superSample: ss }))) * ctx.nx * ctx.ny;
      say(`<tr><td>${num(v, 2)}</td><td>${ss}</td><td>${num(W, 1)}</td>` +
          `<td>${even ? 'even' : 'odd'}</td><td>${num(tally.committed, 0)}</td>` +
          `<td>${num(rendered, 0)}</td>` +
          `<td>${num(rendered / tally.committed, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">Not scored, because the conclusion decides where the ' +
      'repair goes rather than whether one is needed. If the odd rows read ~1.00 ' +
      'the method is sound and the harness cannot measure axis-aligned strokes at ' +
      'factor 4 — which would also put every other axis-aligned drawing in this ' +
      'suite under suspicion.</p>');
}

}
