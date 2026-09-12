// Extracted verbatim from the pre-split verify.html (lines 1362-1439).
// Body unchanged, so the emitted output stays byte-identical.

import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import { createContourWorkspace, contourLevel } from '../src/spine/contour.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num } from './runner.js';

export function run() {
// ------------------------------------------------------ contour: known shapes
// A plane contours to exact straight lines; a cone to circles of known radius.
// Both answers are analytic, so these separate tracer bugs from field bugs.
say('<h2>Shim — marching squares against known shapes</h2>');
{
  const N = 161, c = 80;
  const ws = createContourWorkspace(N, N);

  // (a) plane: f = 0.3x + 0.4y, |grad| = 0.5, so levels dL apart sit 2*dL apart
  const plane = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) plane[i * N + j] = 0.3 * (j + 1) + 0.4 * (i + 1);
  }
  let planeDev = 0, planeCount = 0;
  for (const lv of [30, 50, 70]) {
    const lines = contourLevel(plane, lv, ws);
    for (const poly of lines) {
      for (const [x, y] of poly) {
        planeDev = Math.max(planeDev, Math.abs(0.3 * x + 0.4 * y - lv));
        planeCount++;
      }
    }
  }

  // (b) cone: f = distance from centre, so level r is a circle of radius r
  const cone = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      cone[i * N + j] = Math.hypot(j + 1 - c, i + 1 - c);
    }
  }
  say('<table><tr><th>shape</th><th>check</th><th>value</th><th>verdict</th></tr>');
  const pv = (ok) => `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</td>`;
  say(`<tr><td>plane</td><td>max |f(point) − level| over ${planeCount} points</td>` +
      `<td>${num(planeDev, 5)}</td>${pv(planeDev < 1e-9)}</tr>`);

  let radDev = 0, closedAll = true, loops = 0;
  for (const r of [10, 25, 50]) {
    const lines = contourLevel(cone, r, ws);
    for (const poly of lines) {
      loops++;
      const a = poly[0], b = poly[poly.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) closedAll = false;
      for (const [x, y] of poly) {
        radDev = Math.max(radDev, Math.abs(Math.hypot(x - c, y - c) - r));
      }
    }
  }
  say(`<tr><td>cone</td><td>max radius error at 3 levels</td>` +
      `<td>${num(radDev, 4)} px</td>${pv(radDev < 0.02)}</tr>`);
  say(`<tr><td>cone</td><td>${loops} contours, all closed</td>` +
      `<td>${closedAll ? 'yes' : 'no'}</td>${pv(closedAll)}</tr>`);

  // (c) saddle: f = (x−c)(y−c) at level 0 is two crossing straight lines, the
  // case the ambiguous 5/10 entries exist for. The tracer must not crash and
  // must not leave dangling stubs in the middle of the field.
  const sad = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) sad[i * N + j] = (j + 1 - c) * (i + 1 - c);
  }
  const sadLines = contourLevel(sad, 0.5, ws);
  let interiorEnds = 0;
  for (const poly of sadLines) {
    for (const p of [poly[0], poly[poly.length - 1]]) {
      const onEdge = p[0] <= 1.001 || p[1] <= 1.001 || p[0] >= N - 0.001 || p[1] >= N - 0.001;
      const closed = Math.hypot(poly[0][0] - poly[poly.length - 1][0],
                                poly[0][1] - poly[poly.length - 1][1]) < 1e-9;
      if (!onEdge && !closed) interiorEnds++;
    }
  }
  say(`<tr><td>saddle</td><td>${sadLines.length} contours, dangling interior ends</td>` +
      `<td>${interiorEnds}</td>${pv(interiorEnds === 0)}</tr>`);
  say('</table>');
  say('<p class="note">A contour may only end at the grid border or on itself. ' +
      'An interior dangling end means the linking dropped a segment, which is ' +
      'the failure mode that would show up in the stripes as broken paths.</p>');
}

}
