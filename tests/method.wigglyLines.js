// Extracted verbatim from the pre-split verify.html (lines 452-642).
// Body unchanged, so the emitted output stays byte-identical.

import { prepare } from '../src/spine/units.js';
import { renderStrokes } from '../src/spine/render.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import wigglyLines, { areaRatio, modulate, toneBand, buildCarriers } from '../src/methods/wigglyLines.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest } from './runner.js';

export function run() {
// ------------------------------------------------- wiggly lines: AREA RATIO
// THE MEASUREMENT. The write-up derives closed-form area ratios for the square
// and sawtooth waves and asserts the sawtooth's is "a decent approximation to
// the sinusoid, surprisingly" -- a falsifiable claim that
// evaluateWigglyHalftoning.m was set up to test and never reported. This runs
// it with the app's own renderer: one straight carrier, a wave of known
// wavelength and amplitude, rendered and averaged over an H-tall band.
//
// Predicted = 1 - areaRatio(...). Measured = mean brightness of the band.
// The TSV block at the end is the pasteable version.
say('<h2>Wiggly lines — area ratio, predicted vs measured</h2>');
say('<p class="note">A is PEAK-TO-PEAK amplitude throughout, as in the write-up ' +
    '(the MATLAB variables hold half of it). Full envelope means A = H-w. ' +
    'The sine deliberately uses the sawtooth’s formula, which is exactly the ' +
    'approximation under test; the MATLAB’s undocumented <code>phi*0.95</code> ' +
    'patch on the sine is NOT applied here.</p>');
{
  const wPx = 6;                     // pen well resolved, so the render is the truth
  const SS = 4;                      // supersampling for the measurement renders
  const NPER = 6, PAD = 1;           // periods measured, periods discarded per side

  function measureWiggle(waveform, w, H, Apk, lambda) {
    const imW = Math.max(8, Math.round((NPER + 2 * PAD) * lambda));
    const imH = Math.max(4, Math.round(H));
    const step = Math.max(0.05, w / 6);
    const m = Math.max(4, Math.floor((imW - 1) / step) + 1);
    const x = new Float64Array(m), y = new Float64Array(m), s = new Float64Array(m);
    const nxv = new Float64Array(m), nyv = new Float64Array(m);
    const phi = new Float64Array(m), amp = new Float64Array(m);

    // Put the carrier on a HALF-INTEGER supersampled row. renderStrokes tests
    // `d2 < r2` at sample centres, so a stroke of supersampled width W spans an
    // open interval of length W: centred on an integer that contains W-1 sample
    // rows, centred on a half-integer exactly W. The first run of this sweep
    // centred on an integer and every A=0 row came back 1/24 = 4.17% bright --
    // identically across all three waveforms, which is what identified it as
    // the rig rather than the tone model. The A=0 rows are this measurement's
    // own calibration check: they should now read 1-w/H to ~0.000.
    const S = SS;                             // outScale is 1 in these renders
    const cy = 1 + (Math.round(((1 + imH) / 2 - 1) * S) + 0.5) / S;

    for (let i = 0; i < m; i++) {
      s[i] = i * step;
      x[i] = 1 + s[i];
      y[i] = cy;
      nxv[i] = 0; nyv[i] = 1;                 // left normal of a +x heading
      phi[i] = (2 * Math.PI * s[i]) / lambda;
      amp[i] = Apk / 2;
    }
    const pts = modulate({ x, y, s, nx: nxv, ny: nyv, n: m }, phi, amp, waveform);
    const rendered = renderStrokes([pts], {
      wLine: w, imW, imH, outScale: 1, superSample: SS,
    });
    // average over the interior periods only, so the ends do not contaminate
    const x0 = Math.max(0, Math.round(PAD * lambda));
    const x1 = Math.min(rendered.w, Math.round((PAD + NPER) * lambda));
    let sum = 0, n = 0;
    for (let iy = 0; iy < rendered.h; iy++) {
      for (let ix = x0; ix < x1; ix++) { sum += rendered.data[iy * rendered.w + ix]; n++; }
    }
    return n > 0 ? sum / n : 1;
  }

  const tsv = ['waveform\tH/w\tlambda/w\tA/w\tA/(H-w)\tpredicted\tmeasured\terror'];
  const summary = [];

  for (const waveform of ['square', 'sawtooth', 'sine']) {
    say(`<h3 style="font-size:14px">${waveform}</h3>`);
    say('<table><tr><th>H/w</th><th>&lambda;/w</th><th>A/(H-w)</th>' +
        '<th>predicted</th><th>measured</th><th>error</th></tr>');
    let worst = 0, sumSq = 0, count = 0;

    const rows = [];
    // wavelength sweep at full envelope -- the wavelength-modulation regime
    for (const Hw of [4, 8, 12]) {
      // stops at 2: below L = 2w the half-periods are closer together than the
      // pen is wide, so the band fills solid whatever any model predicts. The
      // wavelength slider stops there for the same reason.
      for (const Lw of [2, 3, 4, 6, 9, 14, 20]) rows.push([Hw, Lw, 1]);
    }
    // amplitude sweep at a fixed wavelength -- the amplitude-modulation regime
    for (const Hw of [4, 8, 12]) {
      for (const frac of [0, 0.25, 0.5, 0.75]) rows.push([Hw, 4, frac]);
    }

    for (const [Hw, Lw, frac] of rows) {
      const H = Hw * wPx, lambda = Lw * wPx;
      const Apk = frac * (H - wPx);
      const predicted = 1 - areaRatio(waveform, wPx, H, Apk, lambda);
      const measured = measureWiggle(waveform, wPx, H, Apk, lambda);
      const e = measured - predicted;
      worst = Math.max(worst, Math.abs(e));
      sumSq += e * e; count++;
      say(`<tr><td>${Hw}</td><td>${num(Lw, 1)}</td><td>${num(frac, 2)}</td>` +
          `<td>${num(predicted, 4)}</td><td>${num(measured, 4)}</td>` +
          `<td>${e >= 0 ? '+' : ''}${num(e, 4)}</td></tr>`);
      tsv.push([waveform, Hw, Lw, num(Apk / wPx, 3), num(frac, 2),
                num(predicted, 4), num(measured, 4), num(e, 4)].join('\t'));
    }
    say('</table>');
    const rms = Math.sqrt(sumSq / Math.max(1, count));
    const pass = worst < 0.05;
    summary.push({ waveform, rms, worst, pass });
    say(`<p>RMS ${num(rms, 4)}, worst ${num(worst, 4)} — ` +
        `<span class="${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span></p>`);
  }

  say('<h3 style="font-size:14px">summary</h3>');
  say('<table><tr><th>waveform</th><th>RMS</th><th>worst</th><th>verdict</th></tr>');
  for (const r of summary) {
    say(`<tr><td>${r.waveform}</td><td>${num(r.rms, 4)}</td><td>${num(r.worst, 4)}</td>` +
        `<td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</td></tr>`);
  }
  say('</table>');
  say('<p class="note"><b>Read the A = 0 rows first</b> — they are a straight ' +
      'line, so they must read 1-w/H exactly, and they are identical across all ' +
      'three waveforms. Any error there is this harness, not the tone model, and ' +
      'everything else should be read net of it. Then: a constant offset means ' +
      'the formula needs a correction term; error growing as &lambda;/w shrinks ' +
      'means the thin-line assumption is breaking down; a sine-only offset is the ' +
      'sawtooth approximation showing.</p>');
  say(`<pre id="wigglyTSV">${tsv.join('\n')}</pre>`);
}

// ------------------------------------------------ wiggly lines: the method
// Scored against targetImage, which is the source squeezed into the reachable
// band -- this method cannot draw white (minimum coverage w/H) and the band is
// the honest target. The continuous-ramp column shows what the band costs.
runToneTest(
  'Linear ramp — wiggly lines (spiral, sawtooth, wavelength)',
  wigglyLines,
  linearRamp(600, 200),
  { carrier: 'spiral', waveform: 'sawtooth', modulation: 'wavelength', spacingW: 8, wavelengthW: 3 },
  flat,
);

runToneTest(
  'Linear ramp — wiggly lines (scan, sawtooth, amplitude)',
  wigglyLines,
  linearRamp(600, 200),
  { carrier: 'scan', waveform: 'sawtooth', modulation: 'amplitude', spacingW: 8, wavelengthW: 4 },
  flat,
);

runToneTest(
  'Linear ramp — wiggly lines (scan, square, wavelength)',
  wigglyLines,
  linearRamp(600, 200),
  { carrier: 'scan', waveform: 'square', modulation: 'wavelength', spacingW: 8, wavelengthW: 3 },
  flat,
);

runToneTest(
  'Radial ramp — wiggly lines (spiral, sine, wavelength)',
  wigglyLines,
  radialRamp(400, 400),
  { carrier: 'spiral', waveform: 'sine', modulation: 'wavelength', spacingW: 8, wavelengthW: 3 },
  flat,
);

// What clipping costs the single-stroke property. A spiral big enough to cover
// a wide rectangle spends most of its length outside it, so the carrier arrives
// in many pieces; a square image fares far better. The SFC carriers additionally
// break where the power-of-two clip left a jump.
say('<h2>Wiggly lines — carrier coverage and pen lifts</h2>');
say('<p class="note">"one continuous stroke" survives only as far as the polygon ' +
    'clip allows. Runs is how many separate strokes come back after clipping.</p>');
{
  for (const [label, src] of [['wide 600×200', linearRamp(600, 200)],
                              ['square 400×400', radialRamp(400, 400)]]) {
    const ctx = prepare(src, flat);
    say(`<h3 style="font-size:14px">${label}</h3>`);
    say('<table><tr><th>carrier</th><th>pieces</th><th>carrier points</th>' +
        '<th>runs after clip</th><th>drawn points</th><th>ceiling</th></tr>');
    for (const carrier of ['spiral', 'scan', 'hcurve', 'hilbert', 'moore']) {
      const args = {
        ...ctx, carrier, waveform: 'sawtooth', modulation: 'wavelength',
        spacingW: 8, wavelengthW: 3,
      };
      const cs = buildCarriers(args, 8 * ctx.w, ctx.w / 3);
      const lines = wigglyLines.run(args);
      const pts = lines.reduce((a, l) => a + l.length, 0);
      const cpts = cs.reduce((a, c) => a + c.n, 0);
      say(`<tr><td>${carrier}</td><td>${cs.length}</td>` +
          `<td>${cpts.toLocaleString()}</td><td>${lines.length.toLocaleString()}</td>` +
          `<td>${pts.toLocaleString()}</td><td>${num(toneBand(args).max)}</td></tr>`);
    }
    say('</table>');
  }
}

}
