// New with the split-and-merge port; not sliced from the pre-split harness.
//
// The tone model here has no fitted constant at all -- coverage is the darkness,
// exactly -- so the tests are about whether that claim survives contact with the
// three things that could break it: the matching, the slant, and the band
// average.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import splitMerge, {
  bandGeometry, bandCrossings, matchBands,
} from '../src/methods/splitMerge.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

export function run() {

// ------------------------------------------------------------- the matching
// A UNIT TEST ON THE MATCHER, on lists whose answer is obvious by inspection.
//
// AN EARLIER VERSION OF THIS SECTION MANUFACTURED THE DEFECT IT REPORTED. It
// claimed the source's independent nearest-neighbour matching could cross, and
// offered [10, 90] against [80, 20] as proof -- but that second list is not
// sorted, and both lists here always are, being inverses of a monotone running
// total. Nearest-neighbour lookup into a sorted array is non-decreasing in the
// query, so neither matcher can cross and there was nothing to fix.
//
// What the in-order walk is actually for: one mechanism produces merges AND
// splits, where the source needs a separate pass for splits and has it
// commented out. That is what these cases check.
say('<h2>Split and merge — does the matching branch correctly?</h2>');
say('<p class="note">Pairs must be non-decreasing in both indices and must use ' +
    'every line on both sides. Counting, so no tolerance. Fewer lines below is a ' +
    'merge, more below is a split, and both come out of the same walk.</p>');
{
  const cases = [
    ['equal, aligned', [10, 20, 30], [10, 20, 30], 3],
    ['equal, shifted', [10, 20, 30], [14, 24, 34], 3],
    ['merge 3 into 2', [10, 20, 30], [12, 28], 3],
    ['split 2 into 3', [12, 28], [10, 20, 30], 3],
    ['merge 4 into 1', [10, 20, 30, 40], [25], 4],
    ['split 1 into 4', [25], [10, 20, 30, 40], 4],
  ];
  say('<table><tr><th>case</th><th>pairs</th><th>expected</th>' +
      '<th>monotone</th><th>all used</th></tr>');
  let allOk = true;
  for (const [name, a, b, want] of cases) {
    const pairs = matchBands(a, b);
    let mono = true;
    for (let k = 1; k < pairs.length; k++) {
      if (pairs[k][0] < pairs[k - 1][0] || pairs[k][1] < pairs[k - 1][1]) mono = false;
    }
    const usedA = new Set(pairs.map((p) => p[0])).size === a.length;
    const usedB = new Set(pairs.map((p) => p[1])).size === b.length;
    const ok = mono && usedA && usedB && pairs.length === want;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td>` +
        `<td class="${pairs.length === want ? 'pass' : 'fail'}">${pairs.length}</td>` +
        `<td>${want}</td>` +
        `<td class="${mono ? 'pass' : 'fail'}">${mono ? 'yes' : 'CROSSES'}</td>` +
        `<td class="${usedA && usedB ? 'pass' : 'fail'}">${usedA && usedB ? 'yes' : 'NO'}</td></tr>`);
  }
  say('</table>');
  say(`<p>the matching branches correctly — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(the last two rows are the point: the same walk that ` +
      `merges four lines into one also splits one into four, with no second ` +
      `pass and no special case)</span></p>`);
}

// ------------------------------------------------------------ line counts
// THE LADDER, CHECKED BEFORE ANYTHING IS DRAWN. The running total says the
// number of lines across a band is the integral of K/w, so on a flat field of
// darkness K the count is exactly K*(width)/w. No constant, so this is
// arithmetic rather than a measurement -- the only slack is the slant
// correction, which on a flat field is nil because nothing moves sideways.
say('<h2>Split and merge — does the line count follow K·width/w?</h2>');
say('<p class="note">Flat fields, so every band should hold the same number of ' +
    'lines and none of them should slant. The predicted count is the integral of ' +
    'the ladder with nothing fitted.</p>');
{
  say('<table><tr><th>tone</th><th>K</th><th>bands</th><th>lines/band</th>' +
      '<th>predicted</th><th>ratio</th></tr>');
  let worst = 0;
  for (const tone of [0.2, 0.45, 0.7]) {
    const ctx = prepare(makeImage(360, 270, tone), settings);
    const args = { ...ctx, lineAngle: 90, bandScale: 1 };
    const { crossings, geo } = bandCrossings(args);
    const mid = crossings[Math.floor(crossings.length / 2)];
    const K = 1 - tone;
    const pred = (K * (geo.vMax - geo.vMin)) / ctx.w;
    const ratio = pred > 0 ? mid.length / pred : 0;
    worst = Math.max(worst, Math.abs(ratio - 1));
    say(`<tr><td>${num(tone, 2)}</td><td>${num(K, 2)}</td>` +
        `<td>${geo.nBands}</td><td>${mid.length}</td><td>${num(pred, 1)}</td>` +
        `<td class="${Math.abs(ratio - 1) < 0.03 ? 'pass' : 'fail'}">${num(ratio, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.03;
  say(`<p>the ladder places the right number of lines — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `(worst ${num(worst, 4)}). <span class="note">3% covers the one line that ` +
      `may be lost at each end to the ceil/floor of the running total, which at ` +
      `these counts is under a percent each.</span></p>`);
}

// -------------------------------------------------------------- the slant
// WHAT THE SOURCE'S LAST TEN LINES WERE COMPENSATING FOR. Its final loop shrinks
// the pen until the rendered mean matches, which is a global fudge for a local
// effect: a line stepping sideways between bands is longer than the band is
// tall, so it lays more ink than the model charged it.
//
// Measured here as drawn length against the length the model assumes. Without
// the correction the ratio would sit above 1 by the mean of 1/cos(theta); with
// it, the extra length is already priced in and the ink is right.
say('<h2>Split and merge — is the slant paid for?</h2>');
say('<p class="note">Total drawn length against (segments × band height). A ' +
    'ratio above 1 is the diagonal the source had to shrink its pen for. What ' +
    'matters is not that it is 1 — it cannot be — but that the rendered TONE is ' +
    'right anyway, which is the column after it.</p>');
{
  say('<table><tr><th>image</th><th>segments</th><th>drawn / n·h</th>' +
      '<th>rendered</th><th>target</th><th>tone error</th></tr>');
  let worst = 0;
  for (const [name, img] of [['flat 0.5', makeImage(360, 270, 0.5)],
                             ['linear ramp', linearRamp(360, 270)],
                             ['radial ramp', radialRamp(360, 270)]]) {
    const ctx = prepare(img, settings);
    const args = { ...ctx, lineAngle: 90, bandScale: 1, drawSplits: true };
    const { geo } = bandCrossings(args);
    const lines = splitMerge.run(args);
    const drawn = pathLength(lines);
    const slant = lines.length > 0 ? drawn / (lines.length * geo.h) : 0;
    const rendered = renderForTest(ctx, lines);
    let sr = 0, st = 0;
    for (let i = 0; i < rendered.data.length; i++) { sr += rendered.data[i]; st += ctx.im.data[i]; }
    const err = sr / rendered.data.length - st / ctx.im.data.length;
    worst = Math.max(worst, Math.abs(err));
    say(`<tr><td>${name}</td><td>${lines.length.toLocaleString()}</td>` +
        `<td>${num(slant, 4)}</td>` +
        `<td>${num(sr / rendered.data.length, 4)}</td>` +
        `<td>${num(st / ctx.im.data.length, 4)}</td>` +
        `<td class="${Math.abs(err) < 0.05 ? 'pass' : 'fail'}">` +
        `${err >= 0 ? '+' : ''}${num(err, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.05;
  say(`<p>the slant is priced in — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)}). ` +
      `<span class="note">The flat row is the control: nothing slants there, so ` +
      `its ratio must be ~1.00 and its tone error near zero. If the ramps' tone ` +
      `drifts DARK while their slant ratio is above 1, the correction is not ` +
      `being applied; if they drift light, it is over-applied.</span></p>`);
}

// -------------------------------------------------- what the splits cost
// THE TONE DIFFERENCE BETWEEN THE TWO MODES, measured rather than assumed.
// Between two band centres the segment count is n1 with splits off and
// max(n1,n2) with them on, while the honest figure is somewhere between -- so
// the modes bracket the truth and the gap is what this reports.
say('<h2>Split and merge — what do the splits cost in ink?</h2>');
say('<p class="note">Splits off draws one segment per line in the upper band; ' +
    'splits on also draws the new line joining in. Where the picture is getting ' +
    'darker downward that is extra ink, so the two modes should straddle the ' +
    'target rather than both sitting on it.</p>');
{
  say('<table><tr><th>image</th><th>splits</th><th>segments</th>' +
      '<th>rendered</th><th>target</th><th>error</th></tr>');
  for (const [name, img] of [['linear ramp', linearRamp(360, 270)],
                             ['radial ramp', radialRamp(360, 270)]]) {
    for (const drawSplits of [false, true]) {
      const ctx = prepare(img, settings);
      const args = { ...ctx, lineAngle: 90, bandScale: 1, drawSplits };
      const lines = splitMerge.run(args);
      const rendered = renderForTest(ctx, lines);
      let sr = 0, st = 0;
      for (let i = 0; i < rendered.data.length; i++) { sr += rendered.data[i]; st += ctx.im.data[i]; }
      const mr = sr / rendered.data.length, mt = st / ctx.im.data.length;
      say(`<tr><td>${name}</td><td>${drawSplits ? 'on' : 'off'}</td>` +
          `<td>${lines.length.toLocaleString()}</td><td>${num(mr, 4)}</td>` +
          `<td>${num(mt, 4)}</td><td>${mr - mt >= 0 ? '+' : ''}${num(mr - mt, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">No verdict — this sets expectations for the checkbox. ' +
      'Splits on must draw more segments and render darker; if the two modes ' +
      'come out identical the split branch is not firing at all.</p>');
}

// ------------------------------------------------- what the band height buys
// The quality knob, and the one approximation in the method: detail finer than
// a band, measured ALONG the lines, is averaged away before any line is placed.
// Thinner bands lose less. This is the same sweep planeWaves runs against its
// region size, and for the same reason.
say('<h2>Split and merge — does a thinner band see more?</h2>');
say('<p class="note">A field that varies ALONG the lines is the case the band ' +
    'average destroys; one that varies across them is the case it handles ' +
    'exactly. Both are swept, and the second is the control.</p>');
{
  say('<table><tr><th>varies</th><th>band scale</th><th>bands</th>' +
      '<th>band height</th><th>RMS vs source</th></tr>');
  // linearRamp varies across x. With lines vertical (90) that is ACROSS the
  // lines; rotating the lines to 0 makes the same ramp vary along them.
  for (const [name, lineAngle] of [['along the lines', 0], ['across them', 90]]) {
    for (const bandScale of [2, 1, 0.5]) {
      const ctx = prepare(linearRamp(360, 270), settings);
      const args = { ...ctx, lineAngle, bandScale, drawSplits: true };
      const geo = bandGeometry(args);
      const lines = splitMerge.run(args);
      const rendered = renderForTest(ctx, lines);
      // BLOCK MEANS, NOT PER-PIXEL. An earlier version took the RMS pixel by
      // pixel and reported ~0.32 for every row, because a halftone differs from
      // a continuous image at every single pixel by construction -- it is ink or
      // it is paper. That measures the existence of lines, not the tone. Mean
      // over 16x12 blocks is the coarsest thing that can still see the ramp.
      const bx = 16, by = 12;
      const gr = new Float64Array(bx * by), gt = new Float64Array(bx * by);
      const gn = new Float64Array(bx * by);
      for (let iy = 0; iy < ctx.ny; iy++) {
        const cy = Math.min(by - 1, Math.floor((iy / ctx.ny) * by));
        for (let ix = 0; ix < ctx.nx; ix++) {
          const g = cy * bx + Math.min(bx - 1, Math.floor((ix / ctx.nx) * bx));
          gr[g] += rendered.data[iy * ctx.nx + ix];
          gt[g] += ctx.im.data[iy * ctx.nx + ix];
          gn[g]++;
        }
      }
      let sum = 0, cnt = 0;
      for (let g = 0; g < bx * by; g++) {
        if (!(gn[g] > 0)) continue;
        const d = gr[g] / gn[g] - gt[g] / gn[g];
        sum += d * d; cnt++;
      }
      say(`<tr><td>${name}</td><td>${num(bandScale, 2)}</td><td>${geo.nBands}</td>` +
          `<td>${num(geo.h, 1)} px</td><td>${num(Math.sqrt(sum / cnt), 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">No verdict — this is what the control buys. The ' +
      '"along the lines" rows should improve as the bands get thinner; the ' +
      '"across them" rows should barely move, since that variation is inside ' +
      'the running total and not averaged away at all. If both improve equally, ' +
      'the band average is not the thing being measured.</p>');
}

// ------------------------------------------------------------------ tone ramps
runToneTest('Split and merge — vertical lines, linear ramp',
  splitMerge, linearRamp(360, 270),
  { lineAngle: 90, bandScale: 1, drawSplits: true }, settings);

runToneTest('Split and merge — 30° lines, radial ramp',
  splitMerge, radialRamp(360, 270),
  { lineAngle: 30, bandScale: 1, drawSplits: true }, settings);

}
