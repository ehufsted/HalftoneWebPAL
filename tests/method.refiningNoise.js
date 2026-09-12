// Extracted verbatim from the pre-split verify.html (lines 1786-1925).
// Body unchanged, so the emitted output stays byte-identical.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { ZERO_CONTOUR_CONST } from '../src/spine/waveNoise.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

export function run() {
// ------------------------------------------------- refining noise: the method
say('<h2>Refining noise — coverage on flat fields</h2>');
say('<p class="note">Coverage should be 2.2214·w/λ with λ = 2.2214·w/K, so it ' +
    'should equal K exactly — until a limit binds. Black is reachable at the ' +
    'derived floor λ = 2.2214w; the bright end blanks past λmax, which is what ' +
    'makes true white reachable and puts a small step at the cutoff.</p>');
{
  const tsv = ['im\tlambdaMin\tlambdaMax\tK\ttarget\trendered\terror'];
  for (const [lmin, lmax] of [[2.25, 60], [4, 30]]) {
    say(`<h3 style="font-size:14px">λ ∈ [${lmin}w, ${lmax}w]</h3>`);
    say('<table><tr><th>im</th><th>K wanted</th><th>target</th>' +
        '<th>rendered</th><th>error</th></tr>');
    for (const v of [0, 0.25, 0.5, 0.75, 0.9, 0.98]) {
      const ctx = prepare(makeImage(260, 260, v), flat);
      const args = {
        ...ctx, lambdaMinW: lmin, lambdaMaxW: lmax, nWaves: 4,
        smoothW: 2, seed: 1,
      };
      const tgt = meanOf(refiningNoise.targetImage(args));
      const rendered = meanOf(renderForTest(ctx, refiningNoise.run(args)));
      const e = rendered - tgt;
      say(`<tr><td>${num(v, 2)}</td><td>${num(1 - v, 3)}</td>` +
          `<td>${num(tgt, 4)}</td><td>${num(rendered, 4)}</td>` +
          `<td>${e >= 0 ? '+' : ''}${num(e, 4)}</td></tr>`);
      tsv.push([num(v, 2), lmin, lmax, num(1 - v, 3), num(tgt, 4),
                num(rendered, 4), num(e, 4)].join('\t'));
    }
    say('</table>');
  }
  say('<p class="note">Paste the block below back. The <b>target</b> column is ' +
      'the model, not the source image, so it already accounts for both limits — ' +
      'an error here is the field or the drawing, not the ladder.</p>');
  say(`<pre id="refiningNoiseTSV">${tsv.join('\n')}</pre>`);
}

// Splits the flat-field error into its two halves, which nothing else does:
// the Kac-Rice shim test measures LENGTH on the bare generator, the coverage
// table above measures RENDERED INK from the finished method, and an error
// introduced between them -- by the level stack, the keep mask, the clip, or
// the rendering -- has nowhere to show up. This measures length on the METHOD'S
// OWN OUTPUT, so the two ratios attribute it.
say('<h2>Refining noise — length vs coverage, attributed</h2>');
say('<p class="note"><b>length</b> compares the drawn polylines against ' +
    'π/(√2·λ): off means the field, the level stack, or the masking. ' +
    '<b>coverage</b> compares rendered ink against w×(measured length): off ' +
    'means the strokes overlap, which they must as λ approaches the merge floor. ' +
    'Only the second should degrade at small λ; if the first drifts with λ, the ' +
    'field is not at the wavelength it was asked for.</p>');
{
  const tsv = ['im\tlambda\tlen_pred\tlen_meas\tlen_ratio\tcov_pred\tcov_meas\tcov_ratio'];
  say('<table><tr><th>im</th><th>λ (px)</th><th>length pred</th>' +
      '<th>length meas</th><th>length ratio</th><th>cov from length</th>' +
      '<th>cov rendered</th><th>cov ratio</th></tr>');
  for (const v of [0, 0.25, 0.5, 0.75, 0.9]) {
    const ctx = prepare(makeImage(300, 300, v), flat);
    const args = {
      ...ctx, lambdaMinW: 2.25, lambdaMaxW: 60, nWaves: 4, smoothW: 2, seed: 1,
    };
    const lines = refiningNoise.run(args);
    const K = 1 - v;
    const lam = Math.min(60 * ctx.w, Math.max(2.25 * ctx.w,
      K > 1e-6 ? (ZERO_CONTOUR_CONST * ctx.w) / K : Infinity));

    let len = 0;
    for (const l of lines) {
      for (let i = 0; i < l.length - 1; i++) {
        len += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
      }
    }
    const area = ctx.nx * ctx.ny;
    const lenPred = ZERO_CONTOUR_CONST / lam;
    const lenMeas = len / area;
    const covFromLen = Math.min(1, ctx.w * lenMeas);
    const covRendered = 1 - meanOf(renderForTest(ctx, lines));
    say(`<tr><td>${num(v, 2)}</td><td>${num(lam, 1)}</td>` +
        `<td>${num(lenPred, 5)}</td><td>${num(lenMeas, 5)}</td>` +
        `<td>${num(lenMeas / lenPred, 4)}</td><td>${num(covFromLen, 4)}</td>` +
        `<td>${num(covRendered, 4)}</td>` +
        `<td>${num(covRendered / Math.max(1e-9, covFromLen), 4)}</td></tr>`);
    tsv.push([num(v, 2), num(lam, 1), num(lenPred, 5), num(lenMeas, 5),
              num(lenMeas / lenPred, 4), num(covFromLen, 4), num(covRendered, 4),
              num(covRendered / Math.max(1e-9, covFromLen), 4)].join('\t'));
  }
  say('</table>');
  say(`<pre id="refiningSplitTSV">${tsv.join('\n')}</pre>`);
}

// What the wavelength smoothing buys and costs. Varying blend weights add
// f1*grad(a) + f2*grad(b) to grad(f), inflating lambda2 and darkening edges;
// smoothing the wavelength map suppresses that, at the price of blurring tone
// detail below the smoothing scale.
say('<h2>Refining noise — cost of wavelength smoothing</h2>');
{
  say('<table><tr><th>smoothing</th><th>strokes</th><th>RMS vs target</th>' +
      '<th>overall error</th></tr>');
  for (const smoothW of [0, 1, 2, 5, 10]) {
    const ctx = prepare(linearRamp(600, 400), flat);
    const args = {
      ...ctx, lambdaMinW: 2.25, lambdaMaxW: 60, nWaves: 4, smoothW, seed: 1,
    };
    const lines = refiningNoise.run(args);
    const tgt = refiningNoise.targetImage(args);
    const got = renderForTest(ctx, lines);
    let sum = 0;
    for (let i = 0; i < tgt.data.length; i++) {
      const d = got.data[i] - tgt.data[i];
      sum += d * d;
    }
    say(`<tr><td>${num(smoothW, 2)}×pen</td><td>${lines.length.toLocaleString()}</td>` +
        `<td>${num(Math.sqrt(sum / tgt.data.length), 4)}</td>` +
        `<td>${num(meanOf(got) - meanOf(tgt), 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">Zero smoothing is the honest baseline: if it is already ' +
      'accurate, the gradient term is negligible for smooth images and the ' +
      'default should come down.</p>');
}

runToneTest(
  'Linear ramp — refining noise',
  refiningNoise,
  linearRamp(600, 400),
  { lambdaMinW: 2.25, lambdaMaxW: 60, nWaves: 4, smoothW: 2, seed: 1 },
  flat,
);

runToneTest(
  'Radial ramp — refining noise',
  refiningNoise,
  radialRamp(400, 400),
  { lambdaMinW: 2.25, lambdaMaxW: 60, nWaves: 4, smoothW: 2, seed: 1 },
  flat,
);

}
