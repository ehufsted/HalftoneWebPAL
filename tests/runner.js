// Shared harness machinery: output accumulation, fixtures, and the tone test.
//
// NOTHING HERE TOUCHES THE DOM except showImage, which is guarded. That is the
// point of the split: `src/spine/` and `src/methods/` are already DOM-free, so
// once the test bodies stop calling document directly the whole numeric core can
// run under node/deno as well as in a browser. Rendering the accumulated HTML is
// tests/report.js's job, and only its job.
//
// `say` still appends HTML strings rather than returning structured rows. That
// is deliberate for this pass: it keeps the emitted output byte-identical to the
// pre-split harness, which is the only way to prove the split dropped nothing.
// Structured results can come later, once that has been established.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { renderStrokes } from '../src/spine/render.js';
import { mulberry32 } from '../src/spine/random.js';

/** Accumulated output. Read with getHtml(); cleared with reset(). */
const html = [];
export const say = (s) => html.push(s);
export const getHtml = () => html.join('\n');
export const reset = () => { html.length = 0; };

export const num = (v, dp = 3) => (isFinite(v) ? v.toFixed(dp) : '—');

/** Settings with gamma 1 and no smoothing, so the target IS the ramp. */
export const flat = { gamma: 1, rSmooth: 0, drawingWidth: 10, pxPerCm: 30, penWidth: 0.05 };

/**
 * For a test that needs its own seeded stream. THE APP'S OWN RNG, not a copy of
 * it: a private copy here would let the harness and the methods drift apart
 * silently, which is the one difference that would make a determinism check
 * pass while the app was broken.
 */
export const mkRand = mulberry32;

/**
 * Render a method's output the way the HARNESS renders it.
 *
 * THE FACTOR IS 4 HERE AND 3 IN THE APP, deliberately: a measurement should be
 * sampled better than a preview, and every published constant in this project
 * comes from this 4. See docs/architecture.md, "the renderer is the
 * calibration". It was previously restated at 27 separate call sites, which is
 * one place per site for it to drift.
 *
 * `opts` overrides one field where a test genuinely differs -- `method.meshEdges`
 * measures a stroke width other than the context's. Tests that render a
 * SYNTHETIC rig rather than a prepared ctx (their own W and H, and one that
 * samples at 6 to measure the renderer's own bias) still call `renderStrokes`
 * directly: they have no ctx, so there is nothing here for them to reuse.
 */
export function renderForTest(ctx, lines, opts = {}) {
  return renderStrokes(lines, {
    wLine: ctx.w, imW: ctx.nx, imH: ctx.ny, outScale: 1, superSample: 4, ...opts,
  });
}

export function linearRamp(w, h) {
  const im = makeImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) im.data[y * w + x] = x / (w - 1);
  return im;
}

export function radialRamp(w, h) {
  const im = makeImage(w, h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const rmax = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) im.data[y * w + x] = Math.min(1, Math.hypot(x - cx, y - cy) / rmax);
  }
  return im;
}

/** The one DOM-dependent helper. A headless run simply omits the previews. */
export function showImage(im, label, scale = 1) {
  if (typeof document === 'undefined') return;
  const c = document.createElement('canvas');
  c.width = im.w; c.height = im.h;
  c.style.width = `${im.w * scale}px`;
  c.style.height = `${im.h * scale}px`;
  const ctx = c.getContext('2d');
  const d = ctx.createImageData(im.w, im.h);
  for (let i = 0, p = 0; i < im.data.length; i++, p += 4) {
    const v = Math.max(0, Math.min(1, im.data[i])) * 255;
    d.data[p] = d.data[p + 1] = d.data[p + 2] = v;
    d.data[p + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  say(`<div style="display:inline-block"><div class="note">${label}</div>${c.outerHTML}</div>`);
}

/** Mean tone per vertical band, target vs rendered. */
export function bandCompare(target, rendered, nBands) {
  const rows = [];
  const bw = target.w / nBands;
  for (let b = 0; b < nBands; b++) {
    const x0 = Math.floor(b * bw), x1 = Math.floor((b + 1) * bw);
    let st = 0, sr = 0, n = 0;
    for (let y = 0; y < target.h; y++) {
      for (let x = x0; x < x1; x++) {
        st += target.data[y * target.w + x];
        sr += rendered.data[y * rendered.w + x];
        n++;
      }
    }
    rows.push({ band: b, target: st / n, rendered: sr / n });
  }
  return rows;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.axisAlignedStrokes] declare that EVERY stroke this
 *   method lays runs along a pixel axis, so the renderer's open-interval bias
 *   applies in full and must be allowed for before scoring. See the derivation
 *   at `samplingAllowance` below. Do not set it for a method whose strokes take
 *   mixed angles: their phase averages out and the allowance would be slack.
 * @param {{rms:number, max:number, why:string}} [opts.knownShortfall] a defect
 *   that has been MEASURED AND DIAGNOSED but not yet repaired. The recorded
 *   numbers are the ones observed when the diagnosis was written, and the test
 *   passes only while the drawing is no worse than that -- so the failure stops
 *   shouting without going quiet. See the note below on why this is not the same
 *   as switching the test off.
 * @param {'band'|'mean'|'none'} [opts.scoreBy] default 'band'. 'none' prints the
 *   table and gives no verdict, for a configuration whose ink the targetImage
 *   cannot describe at all. Use 'mean' ONLY for a
 *   mode whose specification is about the average rather than the local value --
 *   a global threshold is the case this exists for. It is not a way to quieten a
 *   method that is merely inaccurate: the band table is still printed, so the
 *   local behaviour stays visible, and the reason must be given at the call site.
 */
/**
 * Coverage the renderer cannot see, as a fraction, for axis-aligned strokes.
 *
 * THE RENDERER IS THE CALIBRATION AND IT IS ALSO THE INSTRUMENT, which is the
 * whole difficulty. `renderStrokes` tests `d2 < r2` at sample centres, so a
 * stroke of supersampled width W centred on a sample row covers an OPEN interval:
 * W-1 samples when W is even, W when it is odd. architecture.md records the bias
 * and tells rigs to snap carriers to half-integer supersampled rows -- which is
 * available only when the rig chooses the carriers. It does not for a method
 * whose stroke positions are its own output.
 *
 * So the shortfall is ALLOWED FOR rather than corrected away, and it is allowed
 * for as a BOUND rather than an exact factor. (W-1)/W is the worst case, at a
 * stroke exactly on a sample row with no cap area to make it up; a real drawing
 * of finite strokes with round caps reads a little higher -- modelled at 0.85 to
 * 0.91 for quadtree crosses against a bound of 0.833. Subtracting the bound
 * therefore leaves a small NEGATIVE residual, which the existing symmetric
 * thresholds absorb. That asymmetry is deliberate: it is better for the residual
 * to sit on the side that cannot hide a real shortfall.
 *
 * NOT FOLDED INTO `targetImage`. The app reads that to report fidelity and reach,
 * and a band there would tell the user the method cannot reach a tone that it
 * reaches perfectly well on paper. The artefact is the instrument's, so the
 * allowance lives in the instrument.
 */
export function samplingAllowance(ctx, superSample = 4) {
  const W = ctx.w * superSample;
  const even = Math.abs(W - 2 * Math.round(W / 2)) < 1e-9;
  return even ? 1 / W : 0;
}

export function runToneTest(name, method, sourceImage, methodParams, settings, nBands = 10, opts = {}) {
  say(`<h2>${name}</h2>`);
  const t0 = performance.now();
  const ctx = prepare(sourceImage, settings);
  const args = { ...ctx, ...methodParams };
  const lines = method.run(args);
  const elapsed = performance.now() - t0;

  const rendered = renderForTest(ctx, lines);

  // A method may declare the brightness it is actually aiming for. A quantised
  // method that snaps to a ladder is not trying to hit a continuous ramp, so
  // scoring it against one measures the quantisation and nothing else. Score
  // against the method's own target; report the continuous error alongside as
  // information.
  const target = method.targetImage ? method.targetImage(args) : ctx.im;
  const quantised = target !== ctx.im;

  showImage(ctx.im, 'source (after units contract)');
  if (quantised) showImage(target, 'target (quantised)');
  showImage(rendered, 'rendered strokes');

  const rows = bandCompare(target, rendered, nBands);
  const contRows = quantised ? bandCompare(ctx.im, rendered, nBands) : rows;
  // Coverage the rig cannot see, per band. Zero unless the call site declares
  // its strokes axis-aligned, so no existing test moves.
  const lost = opts.axisAlignedStrokes ? samplingAllowance(ctx) : 0;
  const allow = (r) => lost * (1 - r.target);
  let maxErr = 0, sumSq = 0;
  for (const r of rows) {
    const e = Math.abs(r.rendered - r.target - allow(r));
    maxErr = Math.max(maxErr, e);
    sumSq += e * e;
  }
  const rms = Math.sqrt(sumSq / rows.length);

  say('<table><tr><th>band</th>' +
      (quantised ? '<th>ramp</th>' : '') +
      '<th>target</th><th>rendered</th><th>error</th>' +
      (lost ? '<th>unseen</th><th>residual</th>' : '') + '</tr>');
  rows.forEach((r, i) => {
    const e = r.rendered - r.target;
    const a = allow(r);
    say(`<tr><td>${r.band}</td>` +
        (quantised ? `<td>${num(contRows[i].target)}</td>` : '') +
        `<td>${num(r.target)}</td><td>${num(r.rendered)}</td>` +
        `<td>${e >= 0 ? '+' : ''}${num(e)}</td>` +
        (lost ? `<td>${num(a)}</td><td>${e - a >= 0 ? '+' : ''}${num(e - a)}</td>` : '') +
        '</tr>');
  });
  say('</table>');

  const meanErr = Math.abs(meanOf(rendered) - meanOf(target));
  const byMean = opts.scoreBy === 'mean';
  // 'none' prints the table and passes no judgement. For a configuration whose
  // extra ink the targetImage genuinely cannot describe -- region outlines drawn
  // on top of a method's own strokes -- there is no honest verdict to give, and
  // a standing failure would teach the reader to skim the column.
  const noScore = opts.scoreBy === 'none';

  // A KNOWN SHORTFALL IS A BASELINE, NOT AN EXEMPTION.
  //
  // The temptation with a diagnosed-but-unrepaired defect is to stop scoring it,
  // and docs/findings.md already says why a standing FAIL is bad: it teaches the
  // reader to skim the column, and the real failure then arrives invisibly. But
  // simply silencing it is worse, because the number is then free to drift and
  // nobody finds out.
  //
  // So the measured value becomes the bar. The margin is deliberately tight --
  // these are deterministic drawings, so a change of more than a percent means
  // something moved, and something moving is exactly what this is here to catch.
  // A run that comes in BETTER than the record is reported too: the record is
  // then stale and the diagnosis probably needs revisiting.
  const known = opts.knownShortfall;
  const KNOWN_MARGIN = 0.01;
  const regressed = known
    && (rms > known.rms + KNOWN_MARGIN || maxErr > known.max + KNOWN_MARGIN);
  const improved = known
    && rms < known.rms - KNOWN_MARGIN && maxErr < known.max - KNOWN_MARGIN;

  const pass = noScore ? true
    : known ? !regressed
    : (byMean ? meanErr < 0.02 : (maxErr < 0.12 && rms < 0.06));
  say(`<p>overall target ${num(meanOf(target))}, rendered ${num(meanOf(rendered))}, ` +
      `RMS ${num(rms)}, max ${num(maxErr)} — ` +
      (noScore
        ? '<span class="note">NOT SCORED</span>'
        : known
          ? `<span class="${pass ? 'warn' : 'fail'}">` +
            `${regressed ? 'REGRESSED' : 'KNOWN SHORTFALL'}</span>` +
            ` <span class="note">(recorded rms ${num(known.rms)}, max ` +
            `${num(known.max)}${improved ? '; THIS RUN IS BETTER — the record is ' +
            'stale and the diagnosis wants revisiting' : ''}. ${known.why})</span>`
          : `<span class="${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span>`) +
      (quantised && !noScore ? ' <span class="note">(scored against the quantised target)</span>' : '') +
      (byMean ? ` <span class="note">(scored on the MEAN, |Δ| = ${num(meanErr)}; ` +
                `the band errors above are the mode's definition, not its error ` +
                `— see the call site)</span>` : '') +
      '</p>');
  say(`<p class="note">${lines.length} strokes, ` +
      `pen width ${num(ctx.w, 2)} px, image ${ctx.nx}×${ctx.ny}, ` +
      `${num(ctx.pxPerCm, 1)} px/cm, ${Math.round(elapsed)} ms</p>`);
  return { ctx, lines, pass };
}
