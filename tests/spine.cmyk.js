// New with the CMYK ink-mode feature; not sliced from the pre-split harness.
//
// Two pure functions carry the whole feature: invert() flips which end of
// [0,1] means ink (white-on-black), and fromImageDataCMYK() splits a source
// image into cyan/magenta/yellow/black coverage planes with grey component
// replacement (GCR). Everything downstream -- prepare(), every method's own
// run(), the renderer -- is unchanged and channel-agnostic, so what needs
// checking is these two functions and the one place they meet the SVG writer
// (per-layer colour and a page-colour background rect).
//
// THE CLAIM WORTH FAILING LOUDLY ON: the textbook GCR formula divides
// (channel - k) by (1 - k) to rescale each channel back into [0,1], and that
// denominator goes to zero exactly where GCR matters most -- near black. A
// pixel a few sensor-noise levels off perfectly neutral then reports real
// cyan or magenta ink through what should be a flat shadow. This file's
// "near-black noise" case is that exact pixel.

import { invert, fromImageDataCMYK, fromImageData } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { toSVG } from '../src/spine/svg.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import { say, num, flat } from './runner.js';

/** An {width,height,data} RGBA source, one pixel per [r,g,b] triple given. */
function rgbaRow(colors) {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([r, g, b], i) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  });
  return { width: colors.length, height: 1, data };
}

/**
 * A w×h RGBA source with a distinct, non-grey colour at every pixel -- for
 * checking an invariant that must hold everywhere, not just at hand-picked
 * points. The three channels are out of phase with each other so no pixel is
 * accidentally neutral.
 */
function colorfulRGBA(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(255 * (0.5 + 0.5 * Math.sin(x * 0.11)));
      data[i + 1] = Math.round(255 * (0.5 + 0.5 * Math.sin(y * 0.13 + 1)));
      data[i + 2] = Math.round(255 * (0.5 + 0.5 * Math.sin((x + y) * 0.07 + 2)));
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** A w×h grey RGBA source, r=g=b at every pixel, from a horizontal ramp. */
function grayRampRGBA(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(255 * (x / (w - 1)));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

export function run() {

// ------------------------------------------------------------------ invert()
say('<h2>Ink: invert()</h2>');
{
  const im = { w: 5, h: 1, data: Float32Array.from([0, 0.25, 0.5, 0.75, 1]) };
  const inv = invert(im);
  const want = [1, 0.75, 0.5, 0.25, 0];
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff = Math.max(diff, Math.abs(inv.data[i] - want[i]));
  const roundTrip = invert(inv);
  let rtDiff = 0;
  for (let i = 0; i < im.data.length; i++) {
    rtDiff = Math.max(rtDiff, Math.abs(roundTrip.data[i] - im.data[i]));
  }

  say('<table><tr><th>value</th><th>expected 1-v</th><th>got</th></tr>' +
    [0, 1, 2, 3, 4].map((i) =>
      `<tr><td>${num(im.data[i], 2)}</td><td>${num(want[i], 2)}</td><td>${num(inv.data[i], 2)}</td></tr>`
    ).join('') + '</table>');

  const ok = diff < 1e-9 && rtDiff < 1e-9;
  say(`<p>invert() is exactly 1-v and round-trips — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(worst direct error ${num(diff, 6)}, worst round-trip ` +
      `error ${num(rtDiff, 6)} -- invert() is the only thing standing between a ` +
      `white-on-black run and every method's 0=ink assumption, so it must not ` +
      `drift)</span></p>`);
}

// --------------------------------------------------- fromImageDataCMYK: primaries
say('<h2>CMYK: primaries and black</h2>');
{
  const names = ['white', 'black', 'red', 'green', 'blue'];
  const colors = [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  // [c, m, y, k] each colour SHOULD decompose to, textbook values at gcr=1
  const want = [
    [0, 0, 0, 0],
    [0, 0, 0, 1],
    [0, 1, 1, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 0],
  ];
  const { c, m, y, k } = fromImageDataCMYK(rgbaRow(colors), 1);
  say('<table><tr><th>colour</th><th>c</th><th>m</th><th>y</th><th>k</th></tr>');
  let worst = 0;
  names.forEach((name, i) => {
    const got = [c.data[i], m.data[i], y.data[i], k.data[i]];
    const err = Math.max(...got.map((v, j) => Math.abs(v - want[i][j])));
    worst = Math.max(worst, err);
    say(`<tr><td>${name}</td>` + got.map((v) => `<td>${num(v, 3)}</td>`).join('') + '</tr>');
  });
  say('</table>');
  const ok = worst < 1e-6;
  say(`<p>primaries and black decompose exactly — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(worst error ${num(worst, 6)})</span></p>`);
}

// ---------------------------------------- fromImageDataCMYK: the GCR bug's own case
say('<h2>CMYK: near-black noise does not leak into C/M/Y</h2>');
say('<p class="note">The formula this checks used to divide (channel - k) by ' +
    '(1 - k) to rescale each channel back into [0,1]. Near black, c/m/y and k ' +
    'are all close together, so 1-k is tiny and any difference between the ' +
    'three channels that is not a real colour -- sensor noise, JPEG blocking -- ' +
    'gets divided up into visible cyan or magenta through what should be a flat ' +
    'shadow. This pixel is exactly that: (10, 8, 12), indistinguishable from ' +
    'neutral black to a viewer. The old formula put c at 0.167 and m at 0.333 ' +
    'here -- comfortably visible ink for a shadow with no colour in it.</p>');
{
  const { c, m, y, k } = fromImageDataCMYK(rgbaRow([[10, 8, 12]]), 1);
  const got = { c: c.data[0], m: m.data[0], y: y.data[0], k: k.data[0] };
  say('<table><tr><th>c</th><th>m</th><th>y</th><th>k</th></tr>' +
      `<tr><td>${num(got.c, 4)}</td><td>${num(got.m, 4)}</td>` +
      `<td>${num(got.y, 4)}</td><td>${num(got.k, 4)}</td></tr></table>`);
  // 0.02 is generous headroom above the ~0.008/0.016 the fixed formula actually
  // gives, and nowhere near the old formula's 0.167/0.333, so a regression back
  // to dividing by (1-k) fails this loudly rather than by a hair.
  const ok = got.c < 0.02 && got.m < 0.02 && got.y < 0.02 && got.k > 0.9;
  say(`<p>near-neutral shadow stays neutral — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// ------------------------------------------------- fromImageDataCMYK: GCR invariant
say('<h2>CMYK: full GCR empties one channel everywhere</h2>');
say('<p class="note">At gcr=1, k is defined as min(c,m,y), so subtracting it ' +
    'out must leave at least one of c/m/y at exactly 0 for every pixel -- a ' +
    'colourful 64×64 field, not hand-picked points, so a formula that only ' +
    'happens to work at the primaries would not slip through.</p>');
{
  const { c, m, y } = fromImageDataCMYK(colorfulRGBA(64, 64), 1);
  let worst = 0;
  for (let i = 0; i < c.data.length; i++) {
    worst = Math.max(worst, Math.min(c.data[i], m.data[i], y.data[i]));
  }
  const ok = worst < 1e-6;
  say(`<p>worst min(c,m,y) over 4,096 pixels: <b>${num(worst, 6)}</b> — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// --------------------------------------------------------- fromImageDataCMYK: gcr=0
say('<h2>CMYK: gcr=0 turns GCR off</h2>');
say('<p class="note">k must stay at 0 everywhere and c/m/y must be the raw ' +
    'complements of r/g/b, unadjusted -- the same 64×64 field as above, at the ' +
    'other end of the gcr slider.</p>');
{
  const rgba = colorfulRGBA(64, 64);
  const { c, m, y, k } = fromImageDataCMYK(rgba, 0);
  let worstK = 0, worstCMY = 0;
  for (let i = 0, p = 0; i < c.data.length; i++, p += 4) {
    worstK = Math.max(worstK, Math.abs(k.data[i]));
    const wantC = 1 - rgba.data[p] / 255;
    const wantM = 1 - rgba.data[p + 1] / 255;
    const wantY = 1 - rgba.data[p + 2] / 255;
    worstCMY = Math.max(worstCMY,
      Math.abs(c.data[i] - wantC), Math.abs(m.data[i] - wantM), Math.abs(y.data[i] - wantY));
  }
  const ok = worstK < 1e-9 && worstCMY < 1e-9;
  say(`<p>k stays at ${num(worstK, 9)}, c/m/y match the raw complements to ` +
      `${num(worstCMY, 9)} — <span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// --------------------------------------------------------- CMYK meets the pipeline
say("<h2>CMYK: a grey photo prints through K, not through three empty pens</h2>");
say('<p class="note">The app builds a method\'s K-channel input as ' +
    '<code>invert(fromImageDataCMYK(rgba).k)</code>, and its single-ink input ' +
    'as <code>fromImageData(rgba)</code>. For a genuinely grey source (r=g=b at ' +
    'every pixel) those are two different formulas computing the same thing, so ' +
    'they should agree almost exactly, C/M/Y should carry nothing at all, and ' +
    'the method should draw the K channel the same as it would draw single-ink ' +
    '-- so a CMYK plot of a black-and-white photo does not waste three pens ' +
    'drawing nothing while the fourth silently carries a different picture.</p>');
{
  const rgba = grayRampRGBA(256, 40);
  const single = fromImageData(rgba);
  const { c, m, y, k } = fromImageDataCMYK(rgba, 1);
  const kAsInk = invert(k);

  let worstInputDiff = 0, worstCMY = 0;
  for (let i = 0; i < single.data.length; i++) {
    worstInputDiff = Math.max(worstInputDiff, Math.abs(kAsInk.data[i] - single.data[i]));
    worstCMY = Math.max(worstCMY, c.data[i], m.data[i], y.data[i]);
  }

  say(`<p>worst |K-channel input − single-ink input| over ` +
      `${single.data.length.toLocaleString()} pixels: <b>${num(worstInputDiff, 4)}</b>. ` +
      `worst c/m/y coverage: <b>${num(worstCMY, 6)}</b>.</p>`);

  // The luma weights (0.2989+0.587+0.114) sum to 0.9999, not 1, so the two
  // formulas differ by a fraction of a percent even on paper; 0.002 catches a
  // real bug (wrong channel, a missing invert()) without tripping on that.
  const inputsAgree = worstInputDiff < 0.002;
  const cmyEmpty = worstCMY < 1e-6;

  // parallelHatching turns near-identical inputs into near-identical ink: check
  // the drawn length matches closely, not the stroke-for-stroke geometry -- a
  // threshold method can flip a level right at a boundary from a difference
  // this small, the same tolerance `method.merge`'s check uses for the same
  // reason.
  const ctxK = prepare(kAsInk, flat);
  const ctxSingle = prepare(single, flat);
  const linesK = parallelHatching.run({ ...ctxK, angleDeg: 26, maxNlevels: 16 });
  const linesSingle = parallelHatching.run({ ...ctxSingle, angleDeg: 26, maxNlevels: 16 });
  const lengthOf = (lines) => lines.reduce((a, l) => {
    let s = 0;
    for (let i = 0; i < l.length - 1; i++) s += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
    return a + s;
  }, 0);
  const lenK = lengthOf(linesK), lenSingle = lengthOf(linesSingle);
  const lenClose = Math.abs(lenK - lenSingle) / Math.max(1, lenSingle) < 0.02;

  say('<table>' +
    `<tr><th>drawn length, K channel</th><td>${num(lenK, 0)} px</td></tr>` +
    `<tr><th>drawn length, single-ink</th><td>${num(lenSingle, 0)} px</td></tr>` +
    '</table>');

  const ok = inputsAgree && cmyEmpty && lenClose;
  say(`<p>a grey photo's CMYK decomposition matches single-ink, through the ` +
      `whole pipeline — <span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// -------------------------------------------------------------------- toSVG
say('<h2>SVG: per-layer colour and background</h2>');
{
  const layers = [
    { name: 'Cyan', lines: [[[0, 0], [1, 1]]], color: '#00AEEF' },
    { name: 'Black', lines: [[[0, 1], [1, 0]]], color: '#000000' },
  ];
  const svg = toSVG(layers, { widthCm: 5, heightCm: 5, penWidthCm: 0.05, background: '#111111' });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const gs = [...doc.querySelectorAll('g')];        // [outer style g, Cyan g, Black g]
  const rect = doc.querySelector('rect');

  const colorsOk = gs[1]?.getAttribute('stroke') === '#00AEEF'
    && gs[2]?.getAttribute('stroke') === '#000000';
  // A sibling of the layer groups, not nested inside one -- so it cannot be
  // mistaken for a plottable path by anything that walks the layers.
  const rectOk = !!rect && rect.getAttribute('fill') === '#111111'
    && rect.parentElement === doc.documentElement;

  say(`<p>layer groups: ${gs.length - 1}, stroke colours ` +
      `[${gs.slice(1).map((g) => g.getAttribute('stroke')).join(', ')}]. ` +
      `background &lt;rect&gt; fill: ${rect ? rect.getAttribute('fill') : '(none)'}, ` +
      `outside every layer: ${rectOk ? 'yes' : 'NO'}.</p>`);
  const ok = colorsOk && rectOk;
  say(`<p>each layer keeps its own stroke colour, background sits outside them — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// ---------------------------------------------------- toSVG: unchanged by default
say('<h2>SVG: single-ink export is unchanged by the CMYK plumbing</h2>');
say('<p class="note">The exact call the app made before this feature existed -- ' +
    'one layer, no colour, no background -- must still come out black with no ' +
    '&lt;rect&gt;, so every drawing already exported before CMYK existed still ' +
    'exports identically today.</p>');
{
  const svg = toSVG([{ name: 'hatching', lines: [[[0, 0], [1, 1]]] }], {
    widthCm: 5, heightCm: 5, penWidthCm: 0.05,
  });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const layerG = doc.querySelectorAll('g')[1];
  const hasRect = !!doc.querySelector('rect');
  const ok = layerG?.getAttribute('stroke') === '#000000' && !hasRect;
  say(`<p>default stroke ${layerG?.getAttribute('stroke')}, ` +
      `&lt;rect&gt; present: ${hasRect} — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

}
