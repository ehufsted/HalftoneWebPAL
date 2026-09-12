// Extracted verbatim from the pre-split verify.html (lines 1440-1666).
// Body unchanged, so the emitted output stays byte-identical.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

export function run() {
// ------------------------------------------- eikonal stripes: SPACING vs L
// The method's whole claim is that level sets of the phase field sit exactly L
// apart. The shims are verified, so what is left to check is that this method
// wires them together right -- measured by rendering flat fields and asking
// whether coverage came out at w/L.
say('<h2>Eikonal stripes — does the spacing follow L?</h2>');
say('<p class="note">Flat grey fields, so L is constant and the answer is ' +
    'analytic: coverage should be w/L exactly, since stripes of pen width w at ' +
    'spacing L cover that fraction. The geodesic shim contributes a known ±1.4% ' +
    'of orientation-dependent spacing error, so anything much beyond that is ' +
    'this method rather than the shim.</p>');
{
  const tsv = ['im\tLmin/w\tLmax/w\tL/w\tstrokes\tpredicted\trendered\tratio'];
  for (const [LminW, LmaxW] of [[2, 40], [4, 40]]) {
    say(`<h3 style="font-size:14px">Lmin = ${LminW}w, Lmax = ${LmaxW}w</h3>`);
    say('<table><tr><th>im</th><th>L/w</th><th>strokes</th>' +
        '<th>predicted w/L</th><th>rendered</th><th>ratio</th></tr>');
    for (const v of [0, 0.25, 0.5, 0.75, 0.9]) {
      const ctx = prepare(makeImage(240, 240, v), flat);
      const args = {
        ...ctx, LminW, LmaxW, seedMode: 'edges', smoothing: 0.33,
      
      };
      const Lmin = LminW * ctx.w, Lmax = LmaxW * ctx.w;
      const L = Math.min(Lmax, Math.max(Lmin, Lmin / (1 - v * (1 - Lmin / Lmax))));
      const lines = eikonalStripes.run(args);
      const rendered = 1 - meanOf(renderForTest(ctx, lines));
      const predicted = Math.min(1, ctx.w / L);
      const ratio = predicted > 0 ? rendered / predicted : 1;
      say(`<tr><td>${num(v, 2)}</td><td>${num(L / ctx.w, 2)}</td>` +
          `<td>${lines.length.toLocaleString()}</td><td>${num(predicted, 4)}</td>` +
          `<td>${num(rendered, 4)}</td><td>${num(ratio, 4)}</td></tr>`);
      tsv.push([num(v, 2), LminW, LmaxW, num(L / ctx.w, 2), lines.length,
                num(predicted, 4), num(rendered, 4), num(ratio, 4)].join('\t'));
    }
    say('</table>');
  }
  say('<p class="note">Paste the block below back. A ratio below 1 that grows ' +
      'as L shrinks is the stripes merging at the dark end; a constant offset is ' +
      'the field smoothing, which lowers |∇P| and widens the spacing.</p>');
  say(`<pre id="eikonalTSV">${tsv.join('\n')}</pre>`);
}

// Points per line at each stage of the pipeline. Added after a run came back
// with 46 strokes and 92 points -- two points each -- which is a collapse, not a
// tone error, and which a coverage ratio alone cannot localise. Any stage where
// the mean points-per-line falls off a cliff is the culprit.
say('<h2>Eikonal stripes — pipeline stages</h2>');
say('<p class="note">Contours come out of marching squares with tens of points ' +
    'each; resampling sets the spacing; simplification should REDUCE the count ' +
    'without flattening the shape. A mean of 2 after simplify means every ' +
    'interior point was dropped, which is what the broken ' +
    '<code>simplifyLineDistance</code> did.</p>');
{
  const ctx = prepare(makeImage(240, 240, 0.5), flat);
  const tally = {};
  eikonalStripes.run({
    ...ctx, LminW: 2, LmaxW: 40, seedMode: 'edges', smoothing: 0.33,
    stageTally: tally,
  });
  say('<table><tr><th>stage</th><th>lines</th><th>points</th>' +
      '<th>mean pts/line</th></tr>');
  let bad = false;
  for (const k of ['contoured', 'resampled', 'simplified', 'clipped']) {
    const t = tally[k] || { lines: 0, points: 0 };
    const mean = t.lines > 0 ? t.points / t.lines : 0;
    if (k !== 'contoured' && mean < 2.5) bad = true;
    say(`<tr><td>${k}</td><td>${t.lines.toLocaleString()}</td>` +
        `<td>${t.points.toLocaleString()}</td><td>${num(mean, 1)}</td></tr>`);
  }
  say('</table>');
  say(`<p>no stage collapses — <span class="${bad ? 'fail' : 'pass'}">` +
      `${bad ? 'FAIL' : 'PASS'}</span></p>`);
}

// What the smoothing slider costs. Blurring P lowers |grad P| wherever the
// field curves, which widens the stripes -- worth seeing as a number rather
// than inheriting Lmin/3 from the source without knowing its price.
say('<h2>Eikonal stripes — the cost of field smoothing</h2>');
{
  say('<table><tr><th>smoothing</th><th>strokes</th><th>rendered</th>' +
      '<th>vs w/L</th></tr>');
  for (const smoothing of [0, 0.15, 0.33, 0.6, 1]) {
    const ctx = prepare(makeImage(240, 240, 0.5), flat);
    const args = {
      ...ctx, LminW: 2, LmaxW: 40, seedMode: 'edges', smoothing,
      
    };
    const Lmin = 2 * ctx.w, Lmax = 40 * ctx.w;
    const L = Lmin / (1 - 0.5 * (1 - Lmin / Lmax));
    const lines = eikonalStripes.run(args);
    const rendered = 1 - meanOf(renderForTest(ctx, lines));
    say(`<tr><td>${num(smoothing, 2)}×Lmin</td><td>${lines.length}</td>` +
        `<td>${num(rendered, 4)}</td><td>${num(rendered / (ctx.w / L), 4)}</td></tr>`);
  }
  say('</table>');
}

// Contours are level sets of a single-valued field, so they cannot cross and
// cannot dead-end in the interior. That is the method's structural claim and it
// is checkable without reference to tone.
say('<h2>Eikonal stripes — structural claims</h2>');
{
  const ctx = prepare(radialRamp(300, 300), flat);
  say('<table><tr><th>variant</th><th>strokes</th><th>points</th>' +
      '<th>closed</th><th>interior dead ends</th></tr>');
  for (const seedMode of ['edges', 'centroid', 'corners']) {
    const args = { ...ctx, LminW: 2, LmaxW: 40, seedMode, smoothing: 0.33 };
    const lines = eikonalStripes.run(args);
    let closed = 0, dead = 0, pts = 0;
    for (const l of lines) {
      pts += l.length;
      const a = l[0], b = l[l.length - 1];
      const isClosed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
      if (isClosed) { closed++; continue; }
      for (const p of [a, b]) {
        const onEdge = p[0] <= 1.5 || p[1] <= 1.5
                    || p[0] >= ctx.nx - 0.5 || p[1] >= ctx.ny - 0.5;
        if (!onEdge) dead++;
      }
    }
    say(`<tr><td>${seedMode}</td>` +
        `<td>${lines.length.toLocaleString()}</td><td>${pts.toLocaleString()}</td>` +
        `<td>${closed}</td><td class="${dead === 0 ? 'pass' : 'fail'}">${dead}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">A stripe may only end at the region boundary or on ' +
      'itself, so any interior dead end means the tracer or the clip dropped a ' +
      'segment. Centroid seeding should be almost entirely closed loops; edge ' +
      'seeding produces closed loops too, since the seed set is itself a loop.</p>');
}

// Band 9 of the linear ramp came back 0.124 too dark while bands 0-8 held to
// +-0.03. That is the BRIGHTEST band, where L is largest -- and on a 300x100
// ramp, Lmax = 40w = 60 px is most of the image's short dimension. Hypothesis:
// with only ~1.6 stripes across the height, the wavefronts from the top and
// bottom borders meet at a medial-axis shock where the spacing is whatever the
// phase difference happens to be, not L. Measured here rather than assumed:
// vary the height and Lmax independently and see which one moves band 9.
say('<h2>Eikonal stripes — is the bright end short of room?</h2>');
say('<p class="note">Per-band drawn length against what w/L predicts, for the ' +
    'same ramp at three heights and two values of Lmax. If the last band is ' +
    'short of room, its excess should vanish as the image gets taller or Lmax ' +
    'gets smaller, and be untouched by anything else. If it does not move, the ' +
    'cause is at the image border and the hypothesis is wrong.</p>');
{
  const bandLength = (lines, nx, nBands) => {
    const acc = new Float64Array(nBands);
    for (const l of lines) {
      for (let i = 0; i < l.length - 1; i++) {
        const mx = (l[i][0] + l[i + 1][0]) / 2;
        const b = Math.min(nBands - 1, Math.max(0, Math.floor(((mx - 1) / nx) * nBands)));
        acc[b] += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
      }
    }
    return acc;
  };

  say('<table><tr><th>ramp</th><th>Lmax</th><th>L at band 9</th>' +
      '<th>height / L</th><th>band 9 drawn</th><th>band 9 wanted</th>' +
      '<th>ratio</th><th>bands 0–8 ratio</th></tr>');
  for (const [W, H] of [[600, 200], [600, 400], [600, 800]]) {
    for (const LmaxW of [40, 15]) {
      const ctx = prepare(linearRamp(W, H), flat);
      const args = {
        ...ctx, LminW: 2, LmaxW, seedMode: 'edges', smoothing: 0.33,
      };
      const lines = eikonalStripes.run(args);
      const nB = 10;
      const acc = bandLength(lines, ctx.nx, nB);
      const Lmin = 2 * ctx.w, Lmax = LmaxW * ctx.w;
      // wanted length in a band = area * coverage / w = area/L
      const bandArea = (ctx.nx / nB) * ctx.ny;
      let want9 = 0, got9 = 0, wantRest = 0, gotRest = 0;
      for (let b = 0; b < nB; b++) {
        const im = (b + 0.5) / nB;
        const L = Math.min(Lmax, Math.max(Lmin, Lmin / (1 - im * (1 - Lmin / Lmax))));
        const want = bandArea / L;
        if (b === nB - 1) { want9 = want; got9 = acc[b]; }
        else { wantRest += want; gotRest += acc[b]; }
      }
      const L9 = Math.min(Lmax, Math.max(Lmin, Lmin / (1 - 0.95 * (1 - Lmin / Lmax))));
      say(`<tr><td>${W}×${H}</td><td>${LmaxW}w</td><td>${num(L9, 1)} px</td>` +
          `<td>${num(ctx.ny / L9, 2)}</td><td>${num(got9, 0)}</td>` +
          `<td>${num(want9, 0)}</td><td>${num(got9 / want9, 3)}</td>` +
          `<td>${num(gotRest / wantRest, 3)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note"><b>height / L</b> is the number of stripes that fit ' +
      'across the short dimension at the bright end. If the band-9 ratio tracks ' +
      'that column and the bands 0–8 column stays near 1, the method is fine and ' +
      'the default Lmax is simply too large for short regions — a documented ' +
      'limit, not a bug.</p>');
}

runToneTest(
  'Linear ramp — eikonal stripes (from region edge)',
  eikonalStripes,
  linearRamp(600, 200),
  { LminW: 2, LmaxW: 40, seedMode: 'edges', smoothing: 0.33 },
  flat,
);

// Same ramp, same everything, seeded from the centroid instead. Edge seeding is
// what puts a wavefront in from all four sides at once; if band 9 behaves here,
// the short dimension is implicated rather than the brightness.
runToneTest(
  'Linear ramp — eikonal stripes (from centroid)',
  eikonalStripes,
  linearRamp(600, 200),
  { LminW: 2, LmaxW: 40, seedMode: 'centroid', smoothing: 0.33 },
  flat,
);

runToneTest(
  'Radial ramp — eikonal stripes (from centroid)',
  eikonalStripes,
  radialRamp(400, 400),
  { LminW: 2, LmaxW: 40, seedMode: 'centroid', smoothing: 0.33 },
  flat,
);

}
