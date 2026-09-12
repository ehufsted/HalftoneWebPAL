// Extracted verbatim from the pre-split verify.html (lines 2003-2059).
//
// NO LONGER BYTE-IDENTICAL TO THE PRE-SPLIT HARNESS, and deliberately so: it used
// to hard-code the pipeline's default join tolerance, which meant it measured a
// bug rather than the method. `parallelHatching` places its candidate lines one
// pen width apart, so at 1.5 pen widths the joiner was welding segments on
// ADJACENT hatch lines into hairpins -- and bridging a gap draws it, so it was
// also adding ink the layer count never budgeted. The tolerance now comes from
// the method, exactly as worker.js takes it.

import { toPhysical, prepare } from '../src/spine/units.js';
import { optimizeOrder, joinCoincidentLines } from '../src/spine/pathOptimizer.js';
import { simplifyAll } from '../src/spine/simplify.js';
import { pathLength, travelLength } from '../src/spine/geometry.js';
import { toSVG } from '../src/spine/svg.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp } from './runner.js';

export function run() {
// ------------------------------------------------------- output pipeline
say('<h2>Output pipeline</h2>');
{
  // BUILT HERE RATHER THAN BORROWED FROM THE HATCHING SECTION, which is what it
  // used to do through `runner.js`'s `shared` channel. That made this section
  // unrunnable on its own -- `verify.html?only=pipeline` and
  // `node run-tests.mjs pipeline` both died on "(intermediate value).linear is
  // undefined" -- and the subset run is the whole point of the harness split.
  //
  // It is the same ramp, the same params and the same settings, and both halves
  // are deterministic, so the numbers below are unchanged when the full suite
  // runs. The cost is recomputing one hatching; the gain is that this section no
  // longer depends on another one having gone first.
  const ctx = prepare(linearRamp(600, 200), flat);
  const lines = parallelHatching.run({ ...ctx, angleDeg: 26, maxNlevels: 16 });
  const cm = toPhysical(lines, ctx.pxPerCm);

  const travelBefore = travelLength(cm);
  const ordered = optimizeOrder(cm);
  const travelAfter = travelLength(ordered);
  // As the worker does: the method may tighten the default, and this one must.
  const joinPens = Math.min(1.5, parallelHatching.maxJoinPens
    ? parallelHatching.maxJoinPens(ctx) : 1.5);
  const joined = joinCoincidentLines(ordered, ctx.penWidth * joinPens);
  const simplified = simplifyAll(joined, ctx.penWidth / 2);

  const drawn = pathLength(simplified);
  const reduction = 100 * (1 - travelAfter / travelBefore);
  const optPass = travelAfter < travelBefore;

  say('<table>' +
    `<tr><th>drawn length</th><td>${num(drawn / 100, 2)} m</td></tr>` +
    `<tr><th>travel before optimise</th><td>${num(travelBefore / 100, 2)} m</td></tr>` +
    `<tr><th>travel after optimise</th><td>${num(travelAfter / 100, 2)} m</td></tr>` +
    `<tr><th>travel reduction</th><td>${num(reduction, 1)} %</td></tr>` +
    `<tr><th>paths before join</th><td>${ordered.length}</td></tr>` +
    `<tr><th>paths after join</th><td>${joined.length}</td></tr>` +
    `<tr><th>points after simplify</th><td>${simplified.reduce((a, l) => a + l.length, 0)}</td></tr>` +
    '</table>');
  say(`<p>path optimiser reduces travel — ` +
      `<span class="${optPass ? 'pass' : 'fail'}">${optPass ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(join tolerance ${num(joinPens, 2)} pen widths, from the ` +
      `method)</span></p>`);

  // ------------------------------------------- joining must not bend a stroke
  // THE REGRESSION. Hatching is straight parallel lines, so every drawn stroke is
  // collinear with itself and a joined path can only be straight. Any interior
  // corner means two ends from DIFFERENT lines were welded -- the hairpin the
  // tolerance above exists to prevent.
  let corners = 0, worstTurn = 0, bridged = 0;
  for (const path of joined) {
    for (let i = 1; i < path.length - 1; i++) {
      const ax = path[i][0] - path[i - 1][0], ay = path[i][1] - path[i - 1][1];
      const bx = path[i + 1][0] - path[i][0], by = path[i + 1][1] - path[i][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-12 || lb < 1e-12) continue;
      const c = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
      const turn = (Math.acos(c) * 180) / Math.PI;
      if (turn > 1) { corners++; bridged += la; }
      worstTurn = Math.max(worstTurn, turn);
    }
  }
  const straight = corners === 0;
  say(`<p>joined hatching stays straight — ` +
      `<span class="${straight ? 'pass' : 'fail'}">${straight ? 'PASS' : 'FAIL'}</span> ` +
      `(${corners} corners, worst turn ${num(worstTurn, 1)}°). ` +
      `<span class="note">A corner here is a segment on one hatch line welded to ` +
      `one on its neighbour: the lines are a pen width apart, so any tolerance ` +
      `above that reaches across the grain. It costs ink as well as looks — the ` +
      `bridge is drawn, and none of it was budgeted.</span></p>`);

  // ------------------------------------------------- SVG round-trip check
  const svg = toSVG([{ name: 'hatching', lines: simplified }], {
    widthCm: ctx.drawingWidth,
    heightCm: ctx.drawingHeight,
    penWidthCm: ctx.penWidth,
  });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const wAttr = root.getAttribute('width');
  const hAttr = root.getAttribute('height');
  const vb = root.getAttribute('viewBox');
  const expectW = `${(ctx.drawingWidth * 10).toFixed(3).replace(/\.?0+$/, '')}mm`;
  const dimsOk = wAttr === expectW && /mm$/.test(hAttr) && !!vb;
  const pathCount = doc.querySelectorAll('path').length;

  say('<table>' +
    `<tr><th>width</th><td>${wAttr}</td></tr>` +
    `<tr><th>height</th><td>${hAttr}</td></tr>` +
    `<tr><th>viewBox</th><td>${vb}</td></tr>` +
    `<tr><th>stroke-width</th><td>${doc.querySelector('g').getAttribute('stroke-width')} (mm)</td></tr>` +
    `<tr><th>&lt;path&gt; count</th><td>${pathCount}</td></tr>` +
    '</table>');
  say(`<p>SVG carries physical units — ` +
      `<span class="${dimsOk ? 'pass' : 'fail'}">${dimsOk ? 'PASS' : 'FAIL'}</span> ` +
      `(expected width ${expectW})</p>`);
  say(`<p class="note">first 300 characters:</p><pre>${
    svg.slice(0, 300).replace(/</g, '&lt;')}…</pre>`);
}

}
