// Extracted verbatim from the pre-split verify.html (lines 357-451).
// Body unchanged, so the emitted output stays byte-identical.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { renderStrokes } from '../src/spine/render.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import tenPrintHatching, { toneCeiling, segLengthPx, gridFor } from '../src/methods/tenPrintHatching.js';
import ditherGrid from '../src/methods/ditherGrid.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import {
  say,
  num,
  flat,
  mkRand,
  linearRamp,
  radialRamp,
  runToneTest,
  renderForTest,
} from './runner.js';

export function run() {
// --------------------------------------------------- 10 PRINT hatching
// The dither reproduces the fraction it is handed, and a marked cell renders at
// 2w/Lseg plus the spill from its round stroke ends -- so the method hands it
// markFraction(K), not K. Lseg = 2*penWidth is the ceiling: there a stroke's
// body exactly tiles its cell and the drawing can reach solid black.
// `flat` uses penWidth 0.05 cm, hence LsegMm = 1 for the tone tests below.
const tenPrintLseg = flat.penWidth * 2 * 10;   // mm

runToneTest(
  `Linear ramp — 10 PRINT hatching (field angles, Lseg = ${num(tenPrintLseg, 2)} mm)`,
  tenPrintHatching,
  linearRamp(600, 200),
  { LsegMm: tenPrintLseg, angleSource: 'field', seed: 1 },
  flat,
);

// Random angles cannot tile: two diagonals meeting in adjacent cells overlap,
// so the dark end falls short of the coherent case. That gap is the cost of the
// 10 PRINT look, and it is worth seeing measured rather than assumed.
runToneTest(
  `Linear ramp — 10 PRINT hatching (random angles, Lseg = ${num(tenPrintLseg, 2)} mm)`,
  tenPrintHatching,
  linearRamp(600, 200),
  { LsegMm: tenPrintLseg, angleSource: 'random', seed: 1 },
  flat,
);

// The dithered mode mixes the two diagonals deliberately, so neighbours disagree
// more often than under `field` and less often than under `random`. `markFraction`
// is NOT re-derived for it -- see the note there -- so the prediction is that this
// row lands between the two above, and the gap is the cost of the mode. Reported,
// not absorbed.
runToneTest(
  `Linear ramp — 10 PRINT hatching (dithered angles, Lseg = ${num(tenPrintLseg, 2)} mm)`,
  tenPrintHatching,
  linearRamp(600, 200),
  { LsegMm: tenPrintLseg, angleSource: 'dithered', angleMix: 1, seed: 1 },
  flat,
);

runToneTest(
  'Radial ramp — 10 PRINT hatching (field angles)',
  tenPrintHatching,
  radialRamp(400, 400),
  { LsegMm: tenPrintLseg, angleSource: 'field', seed: 1 },
  flat,
);

// The tone ceiling. Every cell of a black image is marked, so what comes back
// is exactly the coverage one stroke gives its cell -- the 2w/Lseg formula that
// decides how far the Lseg slider can be pushed before the drawing goes grey.
say('<h2>10 PRINT — tone ceiling vs segment length</h2>');
say('<p class="note">A solid black source marks every cell, so the rendered ' +
    'coverage is what a single stroke contributes to its own cell. Predicted ' +
    '2w/Lseg, clamped at 1 because Lseg is floored at 2w (below that, diagonals ' +
    'in adjacent cells merge on paper).</p>');
{
  const black = makeImage(200, 200, 0);
  say('<table><tr><th>Lseg (mm)</th><th>Lseg (px)</th><th>grid</th>' +
      '<th>strokes</th><th>predicted</th><th>measured</th><th>error</th></tr>');
  let worst = 0;
  for (const LsegMm of [0.5, 1, 1.5, 2, 3, 4]) {
    const ctx = prepare(black, flat);
    const args = { ...ctx, LsegMm, angleSource: 'field', seed: 1 };
    const lines = tenPrintHatching.run(args);
    const rendered = renderForTest(ctx, lines);
    const LsegPx = segLengthPx(args);
    const g = gridFor(args, LsegPx);
    const predicted = toneCeiling(args);
    const measured = 1 - meanOf(rendered);
    const e = measured - predicted;
    worst = Math.max(worst, Math.abs(e));
    say(`<tr><td>${num(LsegMm, 2)}</td><td>${num(LsegPx, 2)}</td>` +
        `<td>${g.gx}×${g.gy}</td><td>${lines.length.toLocaleString()}</td>` +
        `<td>${num(predicted)}</td><td>${num(measured)}</td>` +
        `<td>${e >= 0 ? '+' : ''}${num(e)}</td></tr>`);
  }
  say('</table>');
  const pass = worst < 0.08;
  say(`<p>coverage follows 2w/Lseg — ` +
      `<span class="${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(worst ${num(worst)}; the 0.5 mm row is clamped up to ` +
      `the 2w floor, so it should read the same as 1 mm)</span></p>`);
}

// ------------------------------------------------- 10 PRINT overlap identity
//
// WHY THIS EXISTS. The tone-ceiling table above passes at 0.007, and the ramp
// tests still come back systematically DARK -- 0.424 rendered against a target
// of 0.500. Those two facts are consistent, and the reason is that the ceiling
// test marks every cell, where the extra ink lands on ink that is already
// there. It saturates, so it cannot see the defect.
//
// The defect: the stroke is the cell DIAGONAL, rendered as a capsule (round
// caps, since renderStrokes tests distance-to-segment), so it covers
//
//     A_stroke / A_cell = (w*L + pi*w^2/4) / (L^2/2) = 2w/L + pi*w^2/(2L^2)
//
// of its own cell -- which at the calibrated L = 2w is 1 + pi/8 = 1.393. The
// stroke does not fit in its cell. The excess spills into the neighbours, and
// on an UNMARKED neighbour it lands on bare paper and darkens the result.
//
// That is the quantity ditherGrid calls Kextra and accounts for exactly; this
// method accounted for none of it.
//
// THE MODEL, AS THIS TABLE'S FIRST RUN CORRECTED IT. The obvious analogy to
// ditherGrid is `ink = p*cov1 + p*(1-p)*Kextra` with cov1 = min(1, bar + cap).
// That fits at L = 2w and fails above it, and the Lseg = 3w and 4w rows are what
// showed why: there the whole capsule fits inside its cell, so that model has
// nothing spilling and predicts a flat bar + cap -- yet the measurement tracked
// bar + cap at low fill and bar ALONE at full fill, with the cap's contribution
// running 0.98 / 0.70 / 0.52 / 0.25 / 0.01 as p went 0.105 -> 1.000. That is
// (1 - p).
//
// So the cap is not own-cell coverage. It is the spill, always, and there is one
// formula with no free parameter:
//
//     ink = p*bar + p*(1-p)*cap
//     bar = 2w/L                the capsule's rectangular body, over cell area
//     cap = pi*w^2/(2L^2)       its two round ends, over cell area
//
// The mechanism is the one mergeCollinear exists for: a stroke's end cap sticks
// out past the cell corner, and it only lays new ink if the collinear neighbour
// is unmarked. If that neighbour is drawn, the two caps abut and the area is
// shared rather than added.
//
// Random marked patterns are the hard case on purpose -- the same argument as
// ditherGrid's identity table. A dither spreads its marks; a random pattern puts
// adjacent marks together constantly, which is where spill is largest.
//
// The two angle modes are separated because the method's header makes a claim
// about them that has never been measured: coherent diagonals abut, random ones
// cross and waste a w-by-w square per crossing, so random should lay LESS ink.
// The ramp tests are consistent with it (random 0.458 against field 0.424) but
// cannot isolate it from the dither. Here the marked set is identical between
// the two modes, so the only difference is the angles.
say('<h2>10 PRINT — the overlap identity, which the ceiling test cannot see</h2>');
say('<p class="note">A stroke is a capsule and its round ends stick out past ' +
    'the cell corner, so a marked cell spills ink into its neighbours — but ' +
    'only onto the ones that are not themselves drawn. Predicted ink is ' +
    '<code>p·bar + p(1−p)·cap</code>, with both terms closed-form and nothing ' +
    'fitted. Measured on an interior window inset one cell, so every pixel ' +
    'scored has all of its contributing strokes present. The coherent rows test ' +
    'the identity; the random rows carry a second effect on top of it and are ' +
    'scored separately below.</p>');
{
  // prepare() resizes to the drawing width, so take the raster size FROM ctx
  // rather than from the source -- rendering at the source size would put the
  // grid and the canvas on different scales.
  const ctx = prepare(makeImage(600, 600, 0.5), flat);
  const W = ctx.nx, H = ctx.ny;
  const w = ctx.w;

  say('<table><tr><th>Lseg/w</th><th>angles</th><th>fill p</th><th>cells</th>' +
      '<th>bar</th><th>cap</th><th>predicted ink</th><th>rendered ink</th><th>ratio</th></tr>');

  const tsv = ['LsegW\tangles\tp\tcells\tbar\tcap\tpredicted\trendered\tratio'];
  let worstCoh = 0;
  const inkAt = {};

  for (const LsegW of [2, 3, 4]) {
    const LsegPx = LsegW * w;
    const g = gridFor(ctx, LsegPx);          // gridFor reads only nx/ny and LsegPx
    const { gx, gy, LxSeg, x0, y0 } = g;
    const half = (LxSeg / 2) * Math.SQRT2;

    // The closed form under test, CORRECTED BY THE FIRST RUN OF THIS TABLE.
    // It was written as cov1 = min(1, bar + cap) with the overflow as a separate
    // Kextra, by analogy with ditherGrid. That is right at L = 2w and wrong
    // above it: the Lseg = 3w and 4w rows put Kextra at zero, so the model
    // predicted a flat bar + cap, and the measurement came back tracking bar
    // alone at full fill and bar + cap at low fill. The fraction of the cap
    // actually contributing was 0.98 / 0.70 / 0.52 / 0.25 / 0.01 at
    // p = 0.105 ... 1.000 -- which is (1 - p) to two decimals.
    //
    // So the cap is not part of own-cell coverage at all. It is the spill term,
    // and there is only one formula:  ink = p*bar + p*(1-p)*cap.
    const bar = (2 * w) / LsegPx;
    const cap = (Math.PI * w * w) / (2 * LsegPx * LsegPx);

    // interior window, inset one full cell so no measured pixel is missing a
    // contributing stroke
    const wx0 = x0 + LxSeg, wy0 = y0 + LxSeg;
    const wx1 = x0 + (gx - 1) * LxSeg, wy1 = y0 + (gy - 1) * LxSeg;

    for (const angles of ['coherent', 'random']) {
      for (const p of [0.1, 0.3, 0.5, 0.75, 1.0]) {
        // the SAME marked set for both angle modes, so the only difference
        // between the two rows is the direction of the strokes
        const rMark = mkRand(7);
        const rAng = mkRand(23);
        const segs = [];
        let nMarked = 0;
        for (let iy = 0; iy < gy; iy++) {
          for (let ix = 0; ix < gx; ix++) {
            const mark = rMark() < p;
            const flip = rAng() < 0.5;          // drawn either way, to keep the
            if (!mark) continue;                // two streams in lockstep
            nMarked++;
            const t = angles === 'coherent' ? Math.PI / 4
                    : (flip ? Math.PI / 4 : (3 * Math.PI) / 4);
            const dx = Math.cos(t) * half, dy = Math.sin(t) * half;
            const ccx = x0 + (ix + 0.5) * LxSeg, ccy = y0 + (iy + 0.5) * LxSeg;
            segs.push([[ccx - dx, ccy - dy], [ccx + dx, ccy + dy]]);
          }
        }

        const rendered = renderStrokes(segs, {
          wLine: w, imW: W, imH: H, outScale: 1, superSample: 4,
        });
        // mean ink over the interior window only
        let sum = 0, n = 0;
        const j0 = Math.max(0, Math.round(wx0) - 1), j1 = Math.min(W - 1, Math.round(wx1) - 1);
        const i0 = Math.max(0, Math.round(wy0) - 1), i1 = Math.min(H - 1, Math.round(wy1) - 1);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) { sum += 1 - rendered.data[i * W + j]; n++; }
        }
        const got = n > 0 ? sum / n : 0;
        const pAct = nMarked / (gx * gy);
        const want = Math.min(1, pAct * bar + pAct * (1 - pAct) * cap);
        const ratio = want > 0 ? got / want : 1;
        if (angles === 'coherent') worstCoh = Math.max(worstCoh, Math.abs(ratio - 1));
        if (LsegW === 2) inkAt[`${angles}:${p}`] = got;

        say(`<tr><td>${LsegW}</td><td>${angles}</td><td>${num(pAct, 3)}</td>` +
            `<td>${(gx * gy).toLocaleString()}</td>` +
            `<td>${num(bar, 4)}</td><td>${num(cap, 4)}</td>` +
            `<td>${num(want, 4)}</td><td>${num(got, 4)}</td>` +
            `<td>${num(ratio, 4)}</td></tr>`);
        tsv.push([LsegW, angles, num(pAct, 3), gx * gy, num(bar, 4), num(cap, 4),
                  num(want, 4), num(got, 4), num(ratio, 4)].join('\t'));
      }
    }
  }
  say('</table>');

  // COHERENT ONLY. The random rows carry a second, separate effect (below) that
  // this identity does not model and is not meant to, so scoring them here would
  // fold two mechanisms into one verdict.
  // TOLERANCE 1.5%, AND IT IS A RATIO, WHICH IS WHY IT IS NOT TIGHTER.
  // The residual is a roughly CONSTANT ~0.001 of absolute ink at every row --
  // renderer discretisation and the interior window not containing a whole
  // number of cells, since LxSeg is not an integer number of pixels. Divided by
  // the ink actually present that constant reads as 0.1% at the dense rows and
  // 1.0-1.6% at the sparse ones, where there is only 0.06-0.13 of ink to divide
  // by. So the ratio column overstates the error exactly where the measurement
  // is thinnest, and 1.5% here is the same quality of agreement as 0.1% at the
  // dark end. Accepted at that level deliberately.
  //
  // If this ever needs tightening, the window quantisation is the thing to fix
  // -- score on absolute ink, or inset the window to a whole number of cells --
  // NOT the model, which has no free parameter to adjust.
  const ok = worstCoh < 0.015;
  say(`<p>ink = p·bar + p(1−p)·cap — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worstCoh, 4)} off unity, ` +
      `coherent angles, all three segment lengths). ` +
      `<span class="note">No free parameter: bar and cap are the capsule's body ` +
      `and its two round ends, divided by the cell area. Tolerance is 1.5% ` +
      `because this column is a RATIO and the underlying residual is a constant ` +
      `~0.001 of absolute ink — which is 0.1% where the page is dark and 1.5% at ` +
      `the sparse rows, where there is barely any ink to divide by. A ratio that ` +
      `worsens with FILL would be the model; one that worsens as fill drops is ` +
      `the divisor. The first version of this table scored a different formula, ` +
      `with the cap inside own-cell coverage; the Lseg = 3w and 4w rows are what ` +
      `showed the cap belongs under (1−p).</span></p>`);

  // The header's claim, isolated: identical marked sets, different angles.
  const rows = [0.3, 0.5, 0.75];
  const lighter = rows.every((p) => inkAt[`random:${p}`] < inkAt[`coherent:${p}`]);
  const gapFull = (inkAt['coherent:1'] ?? 0) - (inkAt['random:1'] ?? 0);
  say(`<p>random angles lay LESS ink than coherent ones — ` +
      `<span class="${lighter ? 'pass' : 'fail'}">${lighter ? 'PASS' : 'FAIL'}</span>` +
      ` <span class="note">(the method header's claim, never previously measured. ` +
      `Same marked cells in both rows, so the only variable is direction. Where ` +
      `two strokes meet at a grid corner their round caps overlap in a quarter ` +
      `disc, πw²/16 — but only when they meet at an ANGLE, which with random ` +
      `directions happens half the time, so πw²/32 per corner and π/64 = 0.0491 ` +
      `of a cell area at full marking. Measured gap at p = 1: ` +
      `${num(gapFull, 4)}. Coherent strokes meet collinearly and pay none of it. ` +
      `This is NOT corrected in the method — it is the cost of the 10 PRINT look, ` +
      `and it leaves random angles about 0.02 light on a ramp.)</span></p>`);

  say('<p class="note">Paste the block below back.</p>');
  say(`<pre id="tenPrintOverlapTSV">${tsv.join('\n')}</pre>`);
}

// ------------------------------------------------- the angle dither's identities
// Two things the dithered mode claims, both exact rather than approximate, so
// they are checked as identities and not as tolerances.
//
//   1. AT MIX 0 IT IS `field`, to the last bit. Nothing is carried, so every cell
//      rounds alone -- which is what `field` already does, since thresholding
//      u = (1 + sin 2t)/2 at 0.5 and rounding t to the nearer diagonal are the
//      same test. The coherence gate cannot break this: it only ever moves u
//      TOWARD 0.5, so it can never move it across.
//   2. IT DOES NOT DISTURB THE TONE DITHER. The angle pass reuses `order`, the
//      marking walk's own traversal, so the risk worth checking is that it has
//      somehow fed back into which cells are marked. It has not if all three
//      modes emit the same number of segments.
say('<h2>10 PRINT — angle dither identities</h2>');
{
  const src = radialRamp(200, 200);
  const ctx = prepare(src, flat);
  const base = { ...ctx, LsegMm: tenPrintLseg, seed: 1 };
  // Endpoints sorted before comparing. A diagonal at -pi/4 and one at 3pi/4 are
  // the same stroke drawn from opposite ends, and the two paths reach the same
  // segment by different routes -- `snapToDiagonal` can return either, the
  // dither always returns the second. Nothing downstream cares, since
  // optimizeOrder reverses lines at will, so the claim under test is that the
  // SEGMENTS match, not the point order.
  const key = (lines) => lines.map((l) =>
    l.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).sort().join(' ')).join('|');

  const field = tenPrintHatching.run({ ...base, angleSource: 'field' });
  const mix0 = tenPrintHatching.run({ ...base, angleSource: 'dithered', angleMix: 0 });
  const mix1 = tenPrintHatching.run({ ...base, angleSource: 'dithered', angleMix: 1 });
  const random = tenPrintHatching.run({ ...base, angleSource: 'random' });

  const identical = key(field) === key(mix0);
  const moves = key(mix0) !== key(mix1);
  const counts = [field.length, mix0.length, mix1.length, random.length];
  const sameCount = counts.every((c) => c === counts[0]);

  say('<table>' +
    `<tr><th>mix 0 reproduces field angles</th><td class="${identical ? 'pass' : 'fail'}">` +
    `${identical ? 'identical' : 'DIFFERENT'}</td></tr>` +
    `<tr><th>mix 1 changes the drawing</th><td class="${moves ? 'pass' : 'fail'}">` +
    `${moves ? 'yes' : 'NO — the dither is inert'}</td></tr>` +
    `<tr><th>segments per mode</th><td class="${sameCount ? 'pass' : 'fail'}">` +
    `${counts.join(', ')}</td></tr>` +
    '</table>');
  const ok = identical && moves && sameCount;
  say(`<p>angle dither — <span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span>. ` +
      '<span class="note">A differing count would mean the angle pass reached back ' +
      'into the marking, which shares its traversal.</span></p>');
}

// The seed has to be the only thing that changes the drawing: the app reruns on
// every slider drag, and unseeded randomness would reshuffle the whole page
// each time an unrelated control moved.
say('<h2>10 PRINT — seed determinism</h2>');
{
  const src = radialRamp(200, 200);
  const ctx = prepare(src, flat);
  const base = { ...ctx, LsegMm: tenPrintLseg, angleSource: 'random' };
  const key = (lines) => lines.map((l) =>
    l.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ')).join('|');
  const a = key(tenPrintHatching.run({ ...base, seed: 1 }));
  const b = key(tenPrintHatching.run({ ...base, seed: 1 }));
  const c = key(tenPrintHatching.run({ ...base, seed: 2 }));
  const stable = a === b, differs = a !== c;
  say('<table>' +
    `<tr><th>seed 1 reproduces</th><td class="${stable ? 'pass' : 'fail'}">${stable ? 'yes' : 'no'}</td></tr>` +
    `<tr><th>seed 2 differs</th><td class="${differs ? 'pass' : 'fail'}">${differs ? 'yes' : 'no'}</td></tr>` +
    '</table>');
  say(`<p>seeded RNG — <span class="${stable && differs ? 'pass' : 'fail'}">` +
      `${stable && differs ? 'PASS' : 'FAIL'}</span></p>`);
}

}
