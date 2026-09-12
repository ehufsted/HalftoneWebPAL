// Extracted verbatim from the pre-split verify.html (lines 1926-1956).
// Body unchanged, so the emitted output stays byte-identical.

import { prepare } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, radialRamp } from './runner.js';

export function run() {
say('<h2>Collinear merge</h2>');
{
  const ctx = prepare(radialRamp(400, 400), flat);
  const raw = quadHalftone.run({ ...ctx, maxDepth: 9, mergeStrokes: false });
  const merged = quadHalftone.run({ ...ctx, maxDepth: 9 });
  const lengthOf = (lines) => lines.reduce((a, l) => {
    let s = 0;
    for (let i = 0; i < l.length - 1; i++) {
      s += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
    }
    return a + s;
  }, 0);
  const rawLen = lengthOf(raw), mergedLen = lengthOf(merged);
  const drop = 100 * (1 - merged.length / Math.max(1, raw.length));
  // merging must not change how much ink is laid down, only how it is grouped
  const lenOk = Math.abs(rawLen - mergedLen) / Math.max(1, rawLen) < 0.02;

  say('<table>' +
    `<tr><th>strokes before merge</th><td>${raw.length.toLocaleString()}</td></tr>` +
    `<tr><th>strokes after merge</th><td>${merged.length.toLocaleString()}</td></tr>` +
    `<tr><th>pen lifts saved</th><td>${num(drop, 1)}%</td></tr>` +
    `<tr><th>drawn length before</th><td>${num(rawLen, 0)} px</td></tr>` +
    `<tr><th>drawn length after</th><td>${num(mergedLen, 0)} px</td></tr>` +
    '</table>');
  say(`<p>merge preserves drawn length — ` +
      `<span class="${lenOk ? 'pass' : 'fail'}">${lenOk ? 'PASS' : 'FAIL'}</span>` +
      `<span class="note"> (a big drop would mean overlapping arms were being ` +
      `collapsed, which changes the tone; a rise would mean spans were extended ` +
      `past their ends)</span></p>`);
}

}
