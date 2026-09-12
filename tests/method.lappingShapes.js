// New with the lapping-shapes port; not sliced from the pre-split harness.
//
// The tone model here is an IDENTITY rather than a fitted law -- ink laid equals
// darkness owed, shape by shape -- so the tests are about whether that identity
// survives the three things between it and the paper: the radius search, the
// occlusion, and the band.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import lappingShapes, {
  placeShapes, toneBand, SHAPE_C, PERIM_C, METRIC_GRAD,
} from '../src/methods/lappingShapes.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };
const KINDS = ['circle', 'square', 'diamond', 'angled'];

export function run() {

// ------------------------------------------------------------ the tiling
// EVERY PIXEL BELONGS TO EXACTLY ONE SHAPE, and nothing is left over. The walk
// ends only when no unclaimed pixel remains, so a gap would mean it terminated
// early -- and the guard that a shape always takes at least its own seed is what
// stops it looping for ever when the chosen radius rounds to nothing.
say('<h2>Lapping shapes — does every pixel get claimed exactly once?</h2>');
say('<p class="note">Counting, so no tolerance. Ownership is written once and ' +
    'never revised, so an unclaimed pixel inside the polygon means the placement ' +
    'walk stopped with work left.</p>');
{
  say('<table><tr><th>shape</th><th>shapes</th><th>claimed</th><th>unclaimed</th>' +
      '<th>mean size</th><th>largest</th></tr>');
  let allOk = true;
  for (const shapeKind of KINDS) {
    const ctx = prepare(radialRamp(240, 180), settings);
    const args = { ...ctx, shapeKind, RmaxW: 20, placeOrder: 'centre' };
    const { shapes, own } = placeShapes(args);
    let claimed = 0, unclaimed = 0;
    for (let i = 0; i < own.length; i++) {
      if (own[i] > 0) claimed++;
      else if (own[i] === 0) unclaimed++;
    }
    let rSum = 0, rMax = 0;
    for (const s of shapes) { rSum += s.r; rMax = Math.max(rMax, s.r); }
    const ok = unclaimed === 0 && shapes.length > 0;
    allOk = allOk && ok;
    say(`<tr><td>${shapeKind}</td><td>${shapes.length.toLocaleString()}</td>` +
        `<td>${claimed.toLocaleString()}</td>` +
        `<td class="${unclaimed === 0 ? 'pass' : 'fail'}">${unclaimed}</td>` +
        `<td>${num(rSum / Math.max(1, shapes.length), 2)} px</td>` +
        `<td>${num(rMax, 1)} px</td></tr>`);
  }
  say('</table>');
  say(`<p>the shapes tile the drawing — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// ------------------------------------------------------- the identity itself
// THE CLAIM THE SOURCE'S HEADER RESTS ON, checked before anything is rendered.
// The radius is chosen so the rim's area equals the darkness of the region it
// claims. That is an identity, so it can be re-derived from the recorded shapes
// and the target image without going near the drawing.
say('<h2>Lapping shapes — is ink laid really darkness owed?</h2>');
say('<p class="note">For each shape, the area of its rim annulus against the ' +
    'summed darkness of the region it claimed. The search picks from a ladder of ' +
    'radii a quarter of a pen width apart, so it can only land as close as that ' +
    'ladder allows — the error should be a fraction of a step, not a trend. ' +
    'READ THE COLUMN DOWN, NOT ACROSS: the ladder is the same for every metric, ' +
    'so a quantisation error falls on all four shapes alike. One shape sitting ' +
    'apart from the others is a statement about that METRIC, which is how the ' +
    'diamond’s missing √2 was found — its band was measured in metric units while ' +
    'the pen covers geometric ones. See METRIC_GRAD.</p>');
{
  say('<table><tr><th>shape</th><th>shapes</th><th>Σ rim area</th>' +
      '<th>Σ darkness owed</th><th>ratio</th><th>median |error| per shape</th></tr>');
  let worst = 0;
  for (const shapeKind of KINDS) {
    const ctx = prepare(linearRamp(240, 180), settings);
    const args = { ...ctx, shapeKind, RmaxW: 20, placeOrder: 'centre' };
    const { shapes, own } = placeShapes(args);
    const tgt = lappingShapes.targetImage(args);
    const w = ctx.w;
    // per shape: area, darkness, and rim area, from the ownership map
    const area = new Float64Array(shapes.length + 1);
    const dark = new Float64Array(shapes.length + 1);
    const rim = new Float64Array(shapes.length + 1);
    for (let iy = 0; iy < ctx.ny; iy++) {
      for (let ix = 0; ix < ctx.nx; ix++) {
        const c = iy * ctx.nx + ix;
        const k = own[c];
        if (k <= 0) continue;
        area[k]++;
        dark[k] += 1 - Math.min(1, Math.max(0, tgt.data[c]));
        const s = shapes[k - 1];
        const dx = ix + 1 - s.x, dy = iy + 1 - s.y;
        let d;
        if (shapeKind === 'square') d = Math.max(Math.abs(dx), Math.abs(dy));
        else if (shapeKind === 'diamond') d = Math.abs(dx) + Math.abs(dy);
        else if (shapeKind === 'angled') {
          const cc = Math.cos(s.ang), ss = Math.sin(s.ang);
          d = Math.max(Math.abs(dx * cc - dy * ss), Math.abs(dx * ss + dy * cc));
        } else d = Math.hypot(dx, dy);
        // THE SAME GEOMETRIC BAND THE METHOD CHARGES FOR, not a metric one.
        // The identity is "rim ink = darkness owed", and the ink is the drawn
        // outline stroked with the pen: perimeter * w, a quantity on the paper.
        // A band of METRIC width w is only w/|grad m| of paper, so for the
        // diamond it measured 0.707 of the ink and the two sides of the identity
        // were in different units. See METRIC_GRAD in the method.
        if (d >= s.r - w * METRIC_GRAD[shapeKind]) rim[k]++;
      }
    }
    let sr = 0, sd = 0;
    const errs = [];
    for (let k = 1; k <= shapes.length; k++) {
      sr += rim[k]; sd += dark[k];
      if (area[k] > 0) errs.push(Math.abs(rim[k] - dark[k]) / area[k]);
    }
    errs.sort((a, b) => a - b);
    const med = errs.length ? errs[Math.floor(errs.length / 2)] : 0;
    const ratio = sd > 0 ? sr / sd : 0;
    worst = Math.max(worst, Math.abs(ratio - 1));
    say(`<tr><td>${shapeKind}</td><td>${shapes.length.toLocaleString()}</td>` +
        `<td>${num(sr, 0)}</td><td>${num(sd, 0)}</td>` +
        `<td class="${Math.abs(ratio - 1) < 0.12 ? 'pass' : 'fail'}">${num(ratio, 4)}</td>` +
        `<td>${num(med, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.12;
  say(`<p>the identity holds — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)}). ` +
      `<span class="note">Scored at 12% because the radius ladder is quantised at ` +
      `a quarter of a pen width and a small shape has few rungs to choose from — ` +
      `the per-shape median is the number that says whether that is the whole ` +
      `story. A ratio consistently ABOVE 1 would mean the rim is over-inking, ` +
      `which is the direction that shows as a drawing too dark. And a SPREAD ` +
      `between the four metrics is the thing to chase before the tolerance: the ` +
      `ladder cannot produce one, so it means a metric’s band width is wrong.` +
      `</span></p>`);
}

// ------------------------------------------------------------ the occlusion
// THE LAPPING IS A LOOKUP, and this is what checks it did not double the ink.
// A rim point is drawn only where its own shape still owns the ground. Where an
// earlier shape overlaps, that shape has drawn its rim already.
say('<h2>Lapping shapes — is the occluded rim actually dropped?</h2>');
say('<p class="note">Drawn length against the full outlines. Every shape after ' +
    'the first is overlapped by something, so the visible fraction must be well ' +
    'under 1 — and it must fall as the shapes get bigger relative to what is ' +
    'left for them.</p>');
{
  say('<table><tr><th>shape</th><th>shapes</th><th>strokes</th>' +
      '<th>drawn length</th><th>full outlines</th><th>visible fraction</th></tr>');
  let allOk = true;
  for (const shapeKind of KINDS) {
    const ctx = prepare(linearRamp(240, 180), settings);
    const args = { ...ctx, shapeKind, RmaxW: 20, placeOrder: 'centre' };
    const { shapes } = placeShapes(args);
    const lines = lappingShapes.run(args);
    const drawn = pathLength(lines);
    // The full perimeter each shape would have if nothing occluded it. PERIM_C,
    // not SHAPE_C: an earlier version used the coverage constant here, which
    // understates a circle's outline by a factor of pi and made a correctly
    // occluded drawing read as though nothing had been occluded.
    const C = PERIM_C[shapeKind];
    let full = 0;
    for (const s of shapes) full += C * Math.max(ctx.w / 2, s.r - ctx.w / 2);
    const frac = full > 0 ? drawn / full : 0;
    const ok = frac > 0.05 && frac < 1.02;
    allOk = allOk && ok;
    say(`<tr><td>${shapeKind}</td><td>${shapes.length.toLocaleString()}</td>` +
        `<td>${lines.length.toLocaleString()}</td>` +
        `<td>${num(drawn, 0)}</td><td>${num(full, 0)}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${num(frac, 4)}</td></tr>`);
  }
  say('</table>');
  say(`<p>occluded rim is dropped — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(above 1 would mean ` +
      `the occlusion is not firing at all and every shape is drawing its whole ` +
      `outline; very near 0 would mean it is dropping rim that is genuinely ` +
      `visible, which shows as a drawing far too light)</span></p>`);
}

// -------------------------------------------------------- the lapping order
// The composition control. It must change the drawing without changing the tone:
// the identity is per shape, so wherever the shapes are placed the ink they lay
// should still equal the darkness they cover.
say('<h2>Lapping shapes — does the order change the look but not the tone?</h2>');
say('<p class="note">Four orderings on one image. The shape count and the ' +
    'arrangement should differ; the rendered mean should not.</p>');
{
  say('<table><tr><th>order</th><th>shapes</th><th>drawn length</th>' +
      '<th>rendered</th><th>target</th><th>error</th></tr>');
  let worst = 0;
  const means = [];
  for (const placeOrder of ['centre', 'down', 'rings', 'random']) {
    const ctx = prepare(radialRamp(240, 180), settings);
    const args = { ...ctx, shapeKind: 'circle', RmaxW: 20, placeOrder };
    const { shapes } = placeShapes(args);
    const lines = lappingShapes.run(args);
    const rendered = renderForTest(ctx, lines);
    const tgt = lappingShapes.targetImage(args);
    let sr = 0, st = 0;
    for (let i = 0; i < rendered.data.length; i++) { sr += rendered.data[i]; st += tgt.data[i]; }
    const mr = sr / rendered.data.length, mt = st / tgt.data.length;
    means.push(mr);
    worst = Math.max(worst, Math.abs(mr - mt));
    say(`<tr><td>${placeOrder}</td><td>${shapes.length.toLocaleString()}</td>` +
        `<td>${num(pathLength(lines), 0)}</td><td>${num(mr, 4)}</td>` +
        `<td>${num(mt, 4)}</td>` +
        `<td class="${Math.abs(mr - mt) < 0.06 ? 'pass' : 'fail'}">` +
        `${mr - mt >= 0 ? '+' : ''}${num(mr - mt, 4)}</td></tr>`);
  }
  say('</table>');
  const spread = Math.max(...means) - Math.min(...means);
  const ok = worst < 0.06;
  say(`<p>the order is a look, not a tone — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)}, spread across ` +
      `orders ${num(spread, 4)}). <span class="note">The spread is the sharper ` +
      `figure: the identity is per shape, so it should not care where the shapes ` +
      `went. A spread comparable to the error would mean the ordering is ` +
      `interacting with the tone model.</span></p>`);
}

// ---------------------------------------------------------------- the band
// DERIVED, so it is checked as arithmetic. An isolated shape of size r covers
// C*w/r, so Rmax sets the lightest reachable tone and nothing else does.
say('<h2>Lapping shapes — is the band what the geometry says?</h2>');
say('<p class="note">C is perimeter × size ÷ area: 2 for a circle or square, ' +
    '2√2 for a diamond. Both ends are the same expression at the two size ' +
    'limits: the smallest shape sets the darkest tone, the largest the ' +
    'lightest. White is never reachable, because there is always an outline.</p>');
{
  say('<table><tr><th>shape</th><th>C</th><th>Rmin</th><th>Rmax</th>' +
      '<th>band min</th><th>1 − C·w/Rmin</th><th>band max</th>' +
      '<th>1 − C·w/Rmax</th><th>agrees</th></tr>');
  let allOk = true;
  for (const shapeKind of KINDS) {
    // Both ends, and the second Rmin is the one that matters: at 1 pen width the
    // coverage exceeds 1 and clips, so black is reachable; at 4 it cannot be, and
    // the band must say so rather than let the drawing be scored against a tone
    // the smallest permitted shape can no longer make.
    for (const [RminW, RmaxW] of [[1, 12], [1, 40], [4, 40]]) {
      const ctx = prepare(makeImage(240, 180, 0.5), settings);
      const args = { ...ctx, shapeKind, RminW, RmaxW };
      const band = toneBand(args);
      const C = SHAPE_C[shapeKind];
      const wantMin = Math.max(0, 1 - Math.min(1, C / RminW));
      const wantMax = Math.max(0, 1 - C / RmaxW);
      const ok = Math.abs(band.max - wantMax) < 1e-9
              && Math.abs(band.min - wantMin) < 1e-9;
      allOk = allOk && ok;
      say(`<tr><td>${shapeKind}</td><td>${num(C, 4)}</td>` +
          `<td>${RminW}×pen</td><td>${RmaxW}×pen</td>` +
          `<td>${num(band.min, 4)}</td><td>${num(wantMin, 4)}</td>` +
          `<td>${num(band.max, 4)}</td><td>${num(wantMax, 4)}</td>` +
          `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'yes' : 'NO'}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>the band is the geometry — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// ------------------------------------------------------------------ tone ramps
runToneTest('Lapping shapes — circles, radial ramp',
  lappingShapes, radialRamp(240, 180),
  { shapeKind: 'circle', RmaxW: 20, placeOrder: 'centre' }, settings);

runToneTest('Lapping shapes — squares, linear ramp',
  lappingShapes, linearRamp(240, 180),
  { shapeKind: 'square', RmaxW: 20, placeOrder: 'down' }, settings,
  10, { knownShortfall: { rms: 0.122, max: 0.298, why: 'toneBand uses C*w/Rmin, the coverage of an ISOLATED shape. Under lapping most of each rim is occluded, so the real floor is far higher -- bands 0 and 1 both render 0.341 against a declared 0.043. Needs the occlusion loss derived.' } });

}
