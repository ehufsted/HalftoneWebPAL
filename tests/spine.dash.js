// The stadium area law, measured directly against the renderer.
//
// WHY THIS EXISTS. `dashedStreamlines` reported its ink ledger as: demand exactly
// right (1.0000), budget exactly right (0.9995), and RENDERED ink 6 to 15% below
// what its marks were charged. Demand and bookkeeping being exact localises the
// fault to the area law -- `d*w + pi*w^2/4` for a dash of length d -- and that law
// is a closed form, so it can be scored on its own instead of through a method.
// docs/findings.md: score a shim against a closed form, never against a number in
// a comment, and build a rig that can fail.
//
// THE PREDICTION, STATED BEFORE THE RUN. The suspect is not the law but the
// renderer's documented sampling bias. `renderStrokes` tests `d2 < r2` at sample
// centres, so a stroke of supersampled width W covers an OPEN interval: centred on
// an integer row it is W-1 samples wide, centred on a half-integer exactly W.
// architecture.md records this and tells measurement rigs to snap carriers to
// half-integer supersampled rows. At the harness's own settings W = w * superSample
// = 1.5 * 4 = 6 exactly, so an axis-aligned stroke should read 5/6 = 0.833 of its
// area, and an oblique one should read about 1.000 because its phase drifts through
// a full cycle along its length and averages out.
//
// If that is what these tables say, then the method is right and the HARNESS is
// what needs fixing -- a tone comparison against a closed form inherits the bias,
// and the fix is to compare against a rendered reference or to raise the sampling
// until the bias is below the tolerance. If instead the oblique rows are also low,
// the area law itself is wrong and the methods that use it are over-charging.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { say, num, flat, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

export function run() {

const ctx = prepare(makeImage(240, 240, 1), settings);
const w = ctx.w;
const caps = (Math.PI * w * w) / 4;
const cx = 120.5, cy = 120.5;

/** Ink actually on the page, in px^2. */
const inked = (lines, opts) =>
  (1 - meanOf(renderForTest(ctx, lines, opts))) * ctx.nx * ctx.ny;

/** A straight dash of length d at angle th, centred on the canvas. */
const dashAt = (d, th) => {
  const ux = Math.cos(th), uy = Math.sin(th);
  return [[cx - (ux * d) / 2, cy - (uy * d) / 2], [cx + (ux * d) / 2, cy + (uy * d) / 2]];
};

say(`<p class="note">pen ${num(w, 3)} px, so at superSample 4 the supersampled ` +
    `stroke is ${num(w * 4, 2)} samples wide and one cap is ${num(caps, 3)} px². ` +
    `Every predicted figure below is <code>d·w + πw²/4</code> with nothing fitted.</p>`);

// ------------------------------------------------------------- angle sweep
// THE DECIDING TABLE. If the bias is the renderer's open-interval test, the axis
// aligned rows read low by about 1/W and the oblique rows read true.
say('<h2>Dash area law — does a straight dash cover what it is charged?</h2>');
say('<p class="note">One dash, alone on the page, length 6×pen, swept through ' +
    'angle. Predicted: 0.833 at 0° and 90° (the stroke sits in one phase for its ' +
    'whole length and the open-interval test drops a row), rising to about 1.000 ' +
    'off-axis where the phase drifts through a cycle and averages out.</p>');
{
  const d = 6 * w;
  const predicted = d * w + caps;
  say('<table><tr><th>angle</th><th>predicted</th><th>rendered</th><th>ratio</th></tr>');
  let axis = 1, oblique = 0;
  for (const deg of [0, 5, 15, 26, 45, 63, 75, 85, 90]) {
    const got = inked([dashAt(d, (deg * Math.PI) / 180)]);
    const ratio = got / predicted;
    if (deg === 0 || deg === 90) axis = Math.min(axis, ratio);
    if (deg >= 15 && deg <= 75) oblique = Math.max(oblique, Math.abs(ratio - 1));
    say(`<tr><td>${deg}°</td><td>${num(predicted, 3)}</td>` +
        `<td>${num(got, 3)}</td><td>${num(ratio, 4)}</td></tr>`);
  }
  say('</table>');
  // 0.06, because the DIAGONAL is a real feature of the sampler and not slack.
  // At 45 degrees the lattice points within r of the line are over-counted by
  // about 5% -- the same discretisation that under-counts an axis-aligned stroke
  // by 17%, seen from the other side. Scoring it at 0.04 would fail correct code.
  const lawOk = oblique < 0.06;
  say(`<p>the law holds off-axis — <span class="${lawOk ? 'pass' : 'fail'}">` +
      `${lawOk ? 'PASS' : 'FAIL'}</span> (worst |ratio − 1| = ${num(oblique, 4)} ` +
      `between 15° and 75°); axis-aligned reads ${num(axis, 4)}. ` +
      '<span class="note">Oblique true and axis low is the renderer’s open-interval ' +
      'bias, and means the area law is correct and any rig comparing rendered ink ' +
      'to the closed form inherits it. Oblique also low would mean the law itself ' +
      'is wrong.</span></p>');
}

// ------------------------------------------------- does the bias follow 1/W?
// THE CONFIRMING TABLE. The open-interval explanation is quantitative: the stroke
// loses one sample row out of W, so the shortfall must fall as 1/W. Anything else
// -- a constant, or a shortfall that does not move -- means a different mechanism.
say('<h2>Dash area law — does the axis-aligned shortfall fall as 1/W?</h2>');
say('<p class="note">The same axis-aligned dash, rendered at rising supersample ' +
    'factors. PARITY MATTERS: a stroke of width W centred on a sample row covers ' +
    'the open interval (−W/2, W/2), which holds W−1 integers when W is even and W ' +
    'when it is odd. So the predicted ratio is (W−1)/W at superSample 4, 8 and 16 ' +
    '(W = 6, 12, 24) and 1.000 at 6 (W = 9). Scoring the even rows against ' +
    '(W−1)/W and forgetting the odd one would be a test that fires on correct ' +
    'behaviour, which docs/findings.md rates worse than no test.</p>');
{
  const d = 6 * w;
  const predicted = d * w + caps;
  say('<table><tr><th>superSample</th><th>W</th><th>model</th>' +
      '<th>rendered</th><th>ratio</th><th>error vs model</th></tr>');
  let worst = 0;
  for (const ss of [4, 6, 8, 16]) {
    const W = w * ss;
    // even W: the open interval drops the two edge rows and keeps W-1.
    // odd W: both edges fall between samples and all W are kept.
    const even = Math.abs(W - 2 * Math.round(W / 2)) < 1e-9;
    const model = even ? (W - 1) / W : 1;
    const got = inked([dashAt(d, 0)], { superSample: ss });
    const ratio = got / predicted;
    worst = Math.max(worst, Math.abs(ratio - model));
    say(`<tr><td>${ss}</td><td>${num(W, 1)}</td><td>${num(model, 4)}</td>` +
        `<td>${num(got, 3)}</td><td>${num(ratio, 4)}</td>` +
        `<td>${num(ratio - model, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.05;
  say(`<p>the shortfall is the open-interval test — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `(worst departure from (W−1)/W is ${num(worst, 4)}). ` +
      '<span class="note">If this tracks, the renderer is under-reporting thin ' +
      'strokes by a known amount and no method is at fault. It also bounds the ' +
      'error: at superSample 4 a drawing can read up to 17% light purely from ' +
      'sampling, and how much it actually loses depends on how much of its ink ' +
      'runs along an axis.</span></p>');
}

// ------------------------------------------------------------ the cap alone
say('<h2>Dash area law — is the cap term itself right?</h2>');
say('<p class="note">A zero-length dash is a disc of radius w/2, area πw²/4 — the ' +
    'cap term with nothing else in it. Predicted: the same sampling shortfall, ' +
    'since a disc of supersampled radius 3 contains 25 lattice points against a ' +
    'true area of 28.3.</p>');
{
  say('<table><tr><th>superSample</th><th>predicted</th><th>rendered</th><th>ratio</th></tr>');
  for (const ss of [4, 8, 16]) {
    const got = inked([[[cx, cy], [cx, cy]]], { superSample: ss });
    say(`<tr><td>${ss}</td><td>${num(caps, 4)}</td><td>${num(got, 4)}</td>` +
        `<td>${num(got / caps, 4)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">Not scored: this is here to separate a wrong cap CONSTANT ' +
      '(ratio wrong and flat in superSample) from the sampling bias (ratio rising ' +
      'toward 1 as the disc gets more samples).</p>');
}

// --------------------------------------------------- length, and the abutment
say('<h2>Dash area law — length, and what abutting really costs</h2>');
say('<p class="note">Oblique (26°), so the sampling bias is out of the way. ' +
    'Predicted: ratio flat in dash length — the cap term is a constant and the ' +
    'law is linear. The pair rows check the abutment rule: two dashes end to end ' +
    'cover one stadium of the combined length, so the second is charged its length ' +
    'and no caps.</p>');
{
  const th = (26 * Math.PI) / 180;
  say('<table><tr><th>case</th><th>predicted</th><th>rendered</th><th>ratio</th></tr>');
  let worst = 0;
  for (const dw of [1, 2, 4, 8, 16]) {
    const d = dw * w;
    const predicted = d * w + caps;
    const got = inked([dashAt(d, th)]);
    worst = Math.max(worst, Math.abs(got / predicted - 1));
    say(`<tr><td>single, ${dw}×pen</td><td>${num(predicted, 3)}</td>` +
        `<td>${num(got, 3)}</td><td>${num(got / predicted, 4)}</td></tr>`);
  }
  // two dashes end to end, sharing a point: one stadium of twice the length
  const d = 6 * w;
  const ux = Math.cos(th), uy = Math.sin(th);
  const pair = [
    [[cx, cy], [cx + ux * d, cy + uy * d]],
    [[cx + ux * d, cy + uy * d], [cx + ux * 2 * d, cy + uy * 2 * d]],
  ];
  const pairPred = 2 * d * w + caps;
  const pairGot = inked(pair);
  worst = Math.max(worst, Math.abs(pairGot / pairPred - 1));
  say(`<tr><td>abutting pair</td><td>${num(pairPred, 3)}</td>` +
      `<td>${num(pairGot, 3)}</td><td>${num(pairGot / pairPred, 4)}</td></tr>`);
  say('</table>');
  const ok = worst < 0.04;
  say(`<p>the law is linear and the abutment rule holds — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `(worst ${num(worst, 4)}). <span class="note">A pair reading near ` +
      `${num(2 * d * w + 2 * caps, 1)} instead would mean abutting dashes are ` +
      'being charged two sets of caps.</span></p>');
}

}
