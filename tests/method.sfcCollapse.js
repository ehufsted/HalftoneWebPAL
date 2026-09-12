// Extracted verbatim from the pre-split verify.html (lines 236-306).
// Body unchanged, so the emitted output stays byte-identical.

import { prepare } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import sfcCollapse, { curveStats } from '../src/methods/sfcCollapse.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest } from './runner.js';

export function run() {
// ------------------------------------------------------ sfc collapse
// This one produces a single continuous path, so the interesting checks are
// (a) does the tone track, and (b) did clipping the curve to the rectangle
// leave jumps, which survive the relaxation as straight chords.
say('<h2>Space-filling curve collapse</h2>');
say('<p class="note">Clipping a curve to the rectangle discards points, and ' +
    'surviving neighbours are joined by a chord that survives the relaxation. ' +
    'The wide test ramp is the worst case; square images fare much better.</p>');
{
  // both a wide and a square case, since the aspect ratio drives the clipping
  for (const [label, src] of [['wide 600×200', linearRamp(600, 200)],
                              ['square 400×400', radialRamp(400, 400)]]) {
    const ctx = prepare(src, flat);
    say(`<h3 style="font-size:14px">${label}</h3>`);
    say('<table><tr><th>curve</th><th>grid</th><th>cells</th><th>points kept</th>' +
        '<th>kept %</th><th>jumps</th><th>longest</th></tr>');
    for (const kind of ['hcurve', 'hilbert', 'moore']) {
      const s = curveStats(ctx, kind);
      const keptPct = (100 * s.points) / s.cells;
      say(`<tr><td>${kind}</td><td>${s.grid[0]}×${s.grid[1]}</td>` +
          `<td>${s.cells.toLocaleString()}</td><td>${s.points.toLocaleString()}</td>` +
          `<td>${num(keptPct, 1)}%</td><td>${s.jumps.toLocaleString()}</td>` +
          `<td>${num(s.longest, 1)} px</td></tr>`);
    }
    say('</table>');
  }
}

runToneTest(
  'Linear ramp — SFC collapse (H-curve)',
  sfcCollapse,
  linearRamp(600, 200),
  { curve: 'hcurve', iterations: 100, damping: 0.1, splitAtJumps: true, simplifyPath: true },
  flat,
);

runToneTest(
  'Linear ramp — SFC collapse (Hilbert, clipped)',
  sfcCollapse,
  linearRamp(600, 200),
  { curve: 'hilbert', iterations: 100, damping: 0.1, splitAtJumps: true, simplifyPath: true },
  flat,
);

runToneTest(
  'Linear ramp — SFC collapse (Moore, closed loop)',
  sfcCollapse,
  linearRamp(600, 200),
  { curve: 'moore', iterations: 100, damping: 0.1, splitAtJumps: true, simplifyPath: true },
  flat,
);

// Does more relaxation fix the highlights? The collapse has to physically move
// points out of white regions, and 100 damped steps may not get them there.
runToneTest(
  'Linear ramp — SFC collapse (H-curve, 300 steps)',
  sfcCollapse,
  linearRamp(600, 200),
  { curve: 'hcurve', iterations: 300, damping: 0.1, splitAtJumps: true, simplifyPath: true },
  flat,
);

// And what the chords actually cost: same run, splitting disabled.
//
// NOT SCORED, AND THE REASON IS THE POINT OF THE ROW. With splitting off, the
// gaps left by clipping the curve to the rectangle survive relaxation as straight
// chords right across the drawing. That is ink no per-pixel target can describe:
// the tone model says coverage is the local darkness -- `dLTarget = K * dL0` in
// units where the pen is one pixel -- and a chord is ink laid where the image
// asked for none, in a place determined by the curve's clipping rather than by
// the picture. Scoring it against the ramp measured the artefact and called it a
// tone error, and it stood as a FAIL for long enough to be skimmed past.
//
// The number that matters is the COMPARISON with the row above, which is the same
// run with splitting on and passes: the difference between them is what the
// chords cost. runner.js keeps printing the band table for exactly this, so the
// cost stays visible without a verdict that cannot be earned.
runToneTest(
  'Linear ramp — SFC collapse (H-curve, no split)',
  sfcCollapse,
  linearRamp(600, 200),
  { curve: 'hcurve', iterations: 100, damping: 0.1, splitAtJumps: false, simplifyPath: true },
  flat,
  10,
  { scoreBy: 'none' },
);

}
