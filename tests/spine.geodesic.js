// Extracted verbatim from the pre-split verify.html (lines 1192-1361).
// Body unchanged, so the emitted output stays byte-identical.

import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import { grayDist, chamferDist, anisotropyBound } from '../src/spine/geodesic.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num } from './runner.js';

export function run() {
// ============================================================ SPINE SHIMS
// Built for regionsEikonalStripes, and tested BEFORE the method that uses them
// so a bad number here is unambiguous. Both have closed-form answers, so these
// check against theory rather than against themselves.

// ------------------------------------------------- geodesic: metrication error
// grayDist is Dijkstra on an 8-connected grid, which cannot be isotropic: the
// cheapest path to a point at angle theta mixes orthogonal and diagonal steps
// and overshoots true Euclidean distance by up to ~2.7%, exact on the axes and
// the diagonals, worst near 22.5 degrees. In the stripes method that becomes a
// DIRECTIONAL spacing error of the same size, so this table is not a pass/fail
// so much as the number that decides whether fast marching is needed.
say('<h2>Shim — geodesic distance (anisotropy)</h2>');
say('<p class="note">Unit weights from a single central seed, so the answer ' +
    'should be the Euclidean distance and every deviation is the grid showing ' +
    'through. Scored against the CLOSED FORM for each neighbourhood ' +
    '(<code>anisotropyBound</code>), not a remembered figure — the first run of ' +
    'this table was checked against 2.7%, which is roughly the optimal-weight ' +
    '3×3 result, and duly reported a bug that did not exist. For (1,√2) the ' +
    'bound is √(1+(√2−1)²) = <b>+8.24%</b> at 22.5°; adding knight moves gives ' +
    '√(1+(√5−2)²) = +2.75%, recentred by normalisation to ±1.36%.</p>');
{
  const N = 201, c = 100;
  const seeds = new Uint8Array(N * N);
  seeds[c * N + c] = 1;

  say('<table><tr><th>angle</th><th>8-conn raw</th><th>8-conn theory</th>' +
      '<th>16-conn normalised</th></tr>');
  const runs = {};
  let ms = 0;
  for (const key of ['raw8', 'n16']) {
    const t0 = performance.now();
    runs[key] = chamferDist(N, N, seeds, key === 'raw8'
      ? { connectivity: 8, normalise: false }
      : { connectivity: 16, normalise: true });
    ms += performance.now() - t0;
  }
  const k8 = Math.SQRT2 - 1;
  let worst8 = 0, worst16 = 0;
  for (let deg = 0; deg <= 45; deg += 5) {
    const r = 80, rad = (deg * Math.PI) / 180;
    const x = Math.round(c + r * Math.cos(rad));
    const y = Math.round(c + r * Math.sin(rad));
    const trueD = Math.hypot(x - c, y - c);
    const t = Math.atan2(y - c, x - c);
    const theory8 = Math.cos(t) + k8 * Math.sin(t) - 1;
    const e8 = runs.raw8[y * N + x] / trueD - 1;
    const e16 = runs.n16[y * N + x] / trueD - 1;
    worst8 = Math.max(worst8, Math.abs(e8));
    worst16 = Math.max(worst16, Math.abs(e16));
    say(`<tr><td>${deg}°</td><td>${e8 >= 0 ? '+' : ''}${num(100 * e8, 2)}%</td>` +
        `<td class="note">${theory8 >= 0 ? '+' : ''}${num(100 * theory8, 2)}%</td>` +
        `<td>${e16 >= 0 ? '+' : ''}${num(100 * e16, 2)}%</td></tr>`);
  }
  say('</table>');
  const bound8 = anisotropyBound(8, false), bound16 = anisotropyBound(16, true);
  const ok8 = Math.abs(worst8 - bound8) < 0.005;
  const ok16 = worst16 < bound16 * 1.6 + 0.005;
  say(`<p>8-conn worst ${num(100 * worst8, 2)}% against a bound of ` +
      `${num(100 * bound8, 2)}% — <span class="${ok8 ? 'pass' : 'fail'}">` +
      `${ok8 ? 'MATCHES THEORY' : 'DOES NOT MATCH'}</span>; 16-conn worst ` +
      `${num(100 * worst16, 2)}% against ${num(100 * bound16, 2)}% — ` +
      `<span class="${ok16 ? 'pass' : 'fail'}">${ok16 ? 'OK' : 'TOO LARGE'}</span>. ` +
      `${Math.round(ms)} ms for two solves of ${(N * N).toLocaleString()} pixels.</p>`);
  say('<p class="note">The 8-connected column matching its theory column is the ' +
      'real check that the solver is right; the 16-connected column is what the ' +
      'method will actually use. Sampling on integer pixels adds a little noise ' +
      'at small radii, so exact agreement is not expected at every angle.</p>');
}

// -------------------------------------------- geodesic: does 2π/L give spacing L?
// The whole premise of the method: weight the field by 2*pi/L and the level sets
// at 2*pi intervals are L apart, because |grad P| = 2*pi/L is what the eikonal
// condition says. Checked here with L constant, where the answer is exact.
say('<h2>Shim — geodesic phase gives the right spacing</h2>');
say('<p class="note"><b>Swept over wavefront orientation, which the first ' +
    'version of this test failed to do.</b> It seeded the top row and measured ' +
    'straight down — an axis direction, the one place chamfer is exact by ' +
    'construction — so it read 0.000% and confirmed nothing. Perpendicular ' +
    'spacing is 2π/|∇P|, and |∇P| depends on the orientation of the front: ' +
    'exactly <i>w</i> for an axis-aligned one, 1.0824<i>w</i> at 22.5°. Seeding ' +
    'a half-plane at angle α makes the front planar at a chosen orientation, so ' +
    'sweeping α sweeps the error.</p>');
say('<p class="note">Two things the first version of this sweep got wrong, both ' +
    'in the measurement rather than the shim. It found crossings by rounding to ' +
    'integer pixels, quantising every result to 0.347%; and the rasterised ' +
    'half-plane seed has a staircase boundary that injects ~0.5 px of ripple ' +
    'into P, worth ~1.4% over the span measured. Together those swamped a ±1.4% ' +
    'effect. Now: P is sampled bilinearly, and each profile is <b>averaged along ' +
    'the front</b>, which is what actually cancels the staircase — the ripple ' +
    'varies laterally, the signal does not.</p>');
say('<p class="note">Prediction to check against, from |∇P| = 1/maxᵦ cos(α−β) ' +
    'over the available ray directions: 16-conn normalised should read ' +
    '<b>+1.37% at 0° and 45°</b>, <b>−1.41% at ~13°</b>, ≈0% near 36°. ' +
    '8-conn raw should read 0% at 0° and 45° and −7.6% at 22.5°.</p>');
{
  const N = 221, c = 110, L = 12;
  const sampleP = (P, x, y) => {
    const fx = Math.min(N - 1.001, Math.max(0, x - 1));
    const fy = Math.min(N - 1.001, Math.max(0, y - 1));
    const j = fx | 0, i = fy | 0;
    const tx = fx - j, ty = fy - i;
    return P[i * N + j] * (1 - tx) * (1 - ty) + P[i * N + j + 1] * tx * (1 - ty)
         + P[(i + 1) * N + j] * (1 - tx) * ty + P[(i + 1) * N + j + 1] * tx * ty;
  };

  say('<table><tr><th>front angle</th><th>8-conn raw</th>' +
      '<th>16-conn normalised</th></tr>');
  let worst8 = 0, worst16 = 0;
  for (let deg = 0; deg <= 45; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    const ux = Math.cos(rad), uy = Math.sin(rad);      // front normal
    const vx = -uy, vy = ux;                            // along the front
    const seeds = new Uint8Array(N * N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if ((j + 1 - c) * ux + (i + 1 - c) * uy < -60) seeds[i * N + j] = 1;
      }
    }
    const weight = new Float64Array(N * N).fill((2 * Math.PI) / L);
    const cells = [];
    for (const o of [{ connectivity: 8, normalise: false },
                     { connectivity: 16, normalise: true }]) {
      const P = grayDist(weight, N, N, seeds, o);
      // profile along the normal, averaged laterally so the seed's staircase
      // ripple cancels instead of being sampled at one arbitrary phase
      const prof = [];
      for (let t = -35; t <= 35; t += 0.5) {
        let s = 0, m = 0;
        for (let q = -40; q <= 40; q += 2) {
          const x = c + ux * t + vx * q, y = c + uy * t + vy * q;
          if (x < 2 || y < 2 || x > N - 2 || y > N - 2) continue;
          const v = sampleP(P, x, y);
          if (!isFinite(v)) continue;
          s += v; m++;
        }
        if (m > 0) prof.push([t, s / m]);
      }
      const TWO_PI = 2 * Math.PI;
      const hits = [];
      for (let i = 1; i < prof.length; i++) {
        const a = prof[i - 1][1], b = prof[i][1];
        const k1 = Math.floor(b / TWO_PI);
        if (k1 > Math.floor(a / TWO_PI)) {
          const tgt = k1 * TWO_PI;
          hits.push(prof[i - 1][0] + (prof[i][0] - prof[i - 1][0]) * (tgt - a) / (b - a));
        }
      }
      const gap = hits.length > 2
        ? (hits[hits.length - 1] - hits[0]) / (hits.length - 1)
        : NaN;
      cells.push(gap / L - 1);
    }
    worst8 = Math.max(worst8, Math.abs(cells[0]));
    worst16 = Math.max(worst16, Math.abs(cells[1]));
    say(`<tr><td>${deg}°</td>` +
        `<td>${cells[0] >= 0 ? '+' : ''}${num(100 * cells[0], 2)}%</td>` +
        `<td>${cells[1] >= 0 ? '+' : ''}${num(100 * cells[1], 2)}%</td></tr>`);
  }
  say('</table>');
  const ok = worst16 < 0.018;
  say(`<p>spacing across orientations — 8-conn worst ${num(100 * worst8, 2)}%, ` +
      `16-conn worst ${num(100 * worst16, 2)}% against a predicted 1.41% — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span>. ` +
      `<span class="note">This is the number that decides whether the stripes ` +
      `show grid-aligned banding. A tone error that tracks stripe DIRECTION is ` +
      'far more visible than a uniform one, which is why the spread matters ' +
      'more than the mean.</span></p>');
}

}
