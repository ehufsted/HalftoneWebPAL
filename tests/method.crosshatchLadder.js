// Extracted verbatim from the pre-split verify.html (lines 1957-2002).
// Body unchanged, so the emitted output stays byte-identical.

import { prepare } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import crosshatchQuantized, { computeLevels } from '../src/methods/crosshatchQuantized.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp, renderForTest } from './runner.js';

export function run() {
// ------------------------------------------- crosshatch level-ladder check
// The real calibration claim: pixels assigned level i should render at
// coverage Ks[i], i.e. brightness 1-Ks[i]. This is the MATLAB's own validation
// block (regionsCrosshatchingQuantized.m lines 119-135), which was written as a
// comment and never run.
say('<h2>Crosshatching — level ladder</h2>');
for (const nLevels of [5, 9]) {
  const Kmax = 0.95;
  const src = linearRamp(600, 200);
  const ctx = prepare(src, flat);
  // the ladder claim is about the undithered staircase, so test it undithered
  const { nLevelMap, Ks } = computeLevels(ctx, nLevels, Kmax, false);
  const lines = crosshatchQuantized.run({
    ...ctx, nLevels, maxCoverage: Kmax, ditherLevels: false,
  });
  const rendered = renderForTest(ctx, lines);

  say(`<h3 style="font-size:14px">${nLevels} levels</h3>`);
  say('<table><tr><th>level</th><th>target brightness</th>' +
      '<th>rendered</th><th>error</th><th>pixels</th></tr>');
  let worst = 0;
  for (let i = 0; i <= nLevels; i++) {
    let sum = 0, n = 0;
    for (let k = 0; k < nLevelMap.length; k++) {
      if (nLevelMap[k] === i) { sum += rendered.data[k]; n++; }
    }
    if (n === 0) continue;
    const target = 1 - Ks[i];
    const got = sum / n;
    const e = got - target;
    // ignore levels with too few pixels to mean anything
    if (n > 200) worst = Math.max(worst, Math.abs(e));
    say(`<tr><td>${i}</td><td>${num(target)}</td><td>${num(got)}</td>` +
        `<td>${e >= 0 ? '+' : ''}${num(e)}</td><td>${n}</td></tr>`);
  }
  say('</table>');
  const pass = worst < 0.08;
  say(`<p>worst per-level error ${num(worst)} — ` +
      `<span class="${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span></p>`);
}
say('<p class="note">Note the ladder is geometric in (1-K), so the coverage ' +
    'steps are largest at the light end — that is why the continuous-ramp band ' +
    'test above shows quantisation error while this per-level test does not.</p>');

}
