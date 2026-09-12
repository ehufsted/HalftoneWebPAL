// Extracted verbatim from the pre-split verify.html (lines 1667-1785).
// Body unchanged, so the emitted output stays byte-identical.

import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import { createContourWorkspace, contourLevel } from '../src/spine/contour.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { waveField, variableWaveField, ZERO_CONTOUR_CONST } from '../src/spine/waveNoise.js';
import { say, num, flat, mkRand } from './runner.js';

export function run() {
// ------------------------------------------ shim: KAC-RICE CONTOUR LENGTH
// The whole calibration of refiningNoise rests on one closed form: the zero
// contour of an isotropic Gaussian field measures pi/(sqrt2 * lambda) per unit
// area. Nothing is fitted, so this is a straight test of theory -- and it is
// worth running on the generator alone, before any method, because a failure
// here means the FIELD is wrong (not isotropic, wrong variance) rather than the
// drawing.
say('<h2>Shim — zero-contour length against Kac–Rice</h2>');
say(`<p class="note">Predicted length per unit area is π/(√2·λ) = ` +
    `${num(ZERO_CONTOUR_CONST, 4)}/λ, with no free parameter. Measured over an ` +
    'interior window so contours clipped by the border do not count against it. ' +
    'Isotropy is an <i>assumption</i> of the derivation — λ₂ = k²⟨cos²θ⟩ is only ' +
    'k²/2 when the directions average right — so the wave count is swept too.</p>');
{
  const N = 400, margin = 60;
  const mkRand = (s) => { let a = (s >>> 0) + 0x6d2b79f5; return () => {
    a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const ws = createContourWorkspace(N, N);
  const interiorLength = (lines) => {
    let s = 0;
    for (const l of lines) {
      for (let i = 0; i < l.length - 1; i++) {
        const mx = (l[i][0] + l[i + 1][0]) / 2, my = (l[i][1] + l[i + 1][1]) / 2;
        if (mx < margin || my < margin || mx > N - margin || my > N - margin) continue;
        s += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
      }
    }
    return s;
  };
  const area = (N - 2 * margin) * (N - 2 * margin);

  // The EFFECTIVE CONSTANT, measured L/A times lambda, is the useful column:
  // it is directly comparable to pi/sqrt2 = 2.2214 (the Gaussian limit) and to
  // 2.0 (a single plane wave, whose zero set is parallel lines lambda/2 apart).
  // The method's slider now runs 2..8 waves, so the small-N rows are the ones
  // it actually uses and the large-N rows are the implementation check.
  const tsv = ['lambda\twaves\tpredicted\tmeasured\tratio\teffConst'];
  say('<table><tr><th>λ (px)</th><th>waves</th><th>predicted L/A</th>' +
      '<th>measured</th><th>ratio</th><th>effective constant</th></tr>');
  let worst = 0;
  for (const lambda of [8, 16, 32]) {
    for (const nWaves of [2, 3, 4, 6, 8, 16, 48]) {
      const f = waveField(N, N, (2 * Math.PI) / lambda, nWaves, mkRand(7));
      const got = interiorLength(contourLevel(f, 0, ws)) / area;
      const want = ZERO_CONTOUR_CONST / lambda;
      const ratio = got / want;
      if (nWaves >= 16) worst = Math.max(worst, Math.abs(ratio - 1));
      say(`<tr><td>${lambda}</td><td>${nWaves}</td><td>${num(want, 5)}</td>` +
          `<td>${num(got, 5)}</td><td>${num(ratio, 4)}</td>` +
          `<td>${num(got * lambda, 4)}</td></tr>`);
      tsv.push([lambda, nWaves, num(want, 5), num(got, 5), num(ratio, 4),
                num(got * lambda, 4)].join('\t'));
    }
  }
  say('</table>');
  const ok = worst < 0.06;
  say(`<p>Kac–Rice holds at 16+ waves — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(100 * worst, 2)}%). ` +
      '<span class="note">A ratio that drifts with λ at high N means the ' +
      'field\'s wavenumber is not what was asked for, which is a bug. A drift ' +
      'with the wave COUNT is not: the constant is a large-N limit, and the ' +
      'effective constant must fall from 2.2214 toward 2.0 as N → 1, since a ' +
      'single plane wave gives parallel lines λ/2 apart. Read the correction, ' +
      'if any is worth making, off the last column at N = 2…8.</span></p>');
  say(`<pre id="kacRiceTSV">${tsv.join('\n')}</pre>`);
}

// The RMS blend claim: k_eff^2 = a^2 k1^2 + b^2 k2^2 should make the contour
// length right at every blend point, not just at the stack levels. A linear
// blend would not, so this distinguishes the two.
say('<h2>Shim — does the RMS blend hold between levels?</h2>');
{
  const N = 360, margin = 50;
  const mkRand = (s) => { let a = (s >>> 0) + 0x6d2b79f5; return () => {
    a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const ws = createContourWorkspace(N, N);
  const area = (N - 2 * margin) * (N - 2 * margin);
  say('<table><tr><th>λ wanted</th><th>levels</th><th>predicted</th>' +
      '<th>measured</th><th>ratio</th></tr>');
  // LEVEL COUNTS START AT 2, and that is not a convenience. With nLevels = 1 the
  // stack has no bracketing pair to blend between: variableWaveField sets
  // ks[0] = kHi, so every pixel is built at the SHORTEST wavelength in the map
  // (6 px here, from the spread-forcing entry below) whatever lambda was asked
  // for. Including it read 0.37358 for all three targets -- one number, three
  // predictions -- and reported "blend is scale-exact FAIL (worst 354%)" about a
  // configuration that has no blend in it. The degenerate branch is still
  // checked, below, against what it actually promises.
  let worst = 0;
  for (const lambda of [11, 19, 27]) {
    for (const nLevels of [2, 5, 19]) {
      const kMap = new Float64Array(N * N).fill((2 * Math.PI) / lambda);
      const active = new Uint8Array(N * N).fill(1);
      // a stack spanning a wide range forces a genuine blend at this lambda
      kMap[0] = (2 * Math.PI) / 6;
      kMap[1] = (2 * Math.PI) / 60;
      const f = variableWaveField(N, N, kMap, active,
        { nWaves: 48, nLevels, rand: mkRand(11) });
      let s = 0;
      for (const l of contourLevel(f, 0, ws)) {
        for (let i = 0; i < l.length - 1; i++) {
          const mx = (l[i][0] + l[i + 1][0]) / 2, my = (l[i][1] + l[i + 1][1]) / 2;
          if (mx < margin || my < margin || mx > N - margin || my > N - margin) continue;
          s += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
        }
      }
      const got = s / area, want = ZERO_CONTOUR_CONST / lambda;
      const ratio = got / want;
      worst = Math.max(worst, Math.abs(ratio - 1));
      say(`<tr><td>${lambda}</td><td>${nLevels}</td><td>${num(want, 5)}</td>` +
          `<td>${num(got, 5)}</td><td>${num(ratio, 4)}</td></tr>`);
    }
  }
  say('</table>');
  const ok = worst < 0.08;
  say(`<p>blend is scale-exact — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(100 * worst, 2)}%). ` +
      '<span class="note">The ratio must not depend on the level count. If it ' +
      'drifts as levels increase, the blend is not preserving λ₂ and the weights ' +
      'are wrong — most likely linear where they should be RMS.</span></p>');

  // The degenerate branch, scored against what it promises rather than against a
  // target it cannot represent: one level means ks[0] = kHi, so the field must
  // come out at the SHORTEST wavelength in the map.
  {
    const lamHi = 6;
    const kMap = new Float64Array(N * N).fill((2 * Math.PI) / 19);
    const active = new Uint8Array(N * N).fill(1);
    kMap[0] = (2 * Math.PI) / lamHi;
    kMap[1] = (2 * Math.PI) / 60;
    const f = variableWaveField(N, N, kMap, active,
      { nWaves: 48, nLevels: 1, rand: mkRand(11) });
    let s = 0;
    for (const l of contourLevel(f, 0, ws)) {
      for (let i = 0; i < l.length - 1; i++) {
        const mx = (l[i][0] + l[i + 1][0]) / 2, my = (l[i][1] + l[i + 1][1]) / 2;
        if (mx < margin || my < margin || mx > N - margin || my > N - margin) continue;
        s += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
      }
    }
    const got = s / area, want = ZERO_CONTOUR_CONST / lamHi;
    const ratio = got / want;
    const ok1 = Math.abs(ratio - 1) < 0.08;
    say(`<p>one level collapses to the shortest wavelength — ` +
        `<span class="${ok1 ? 'pass' : 'fail'}">${ok1 ? 'PASS' : 'FAIL'}</span> ` +
        `(measured ${num(got, 5)} against ${num(want, 5)} for λ = ${lamHi}, ` +
        `ratio ${num(ratio, 4)}). <span class="note">Not a blend — a single level ` +
        `has no bracketing pair, so variableWaveField builds everything at kHi. ` +
        `This is the branch that fires on a flat field, where kHi = kLo and the ` +
        `collapse is exactly right.</span></p>`);
  }
}

}
