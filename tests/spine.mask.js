// New with the region-mask consolidation; not sliced from the pre-split harness.
//
// spine/mask.js replaced thirteen hand-written copies of the same raster scan,
// so the first thing to establish is that it agrees with what it replaced --
// against a direct inpolygon scan written out here, deliberately, rather than
// against itself.
//
// The second thing is the cache, which is the only NEW risk the consolidation
// introduced. Thirteen independent loops could not return each other's answers;
// one cached function can, and a mask that is right for the previous polygon and
// silently wrong for this one would mis-place ink near the page edge in a way no
// tone number would obviously blame on the mask.

import { makeImage, inpolygon } from '../src/shim/image.js';
import {
  polygonMask, insideIndices, whitenOutside,
} from '../src/spine/mask.js';
import { say } from './runner.js';

/** The scan the methods used to carry, kept as the reference. */
function referenceMask(nx, ny, px, py) {
  const m = new Uint8Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (inpolygon(ix + 1, iy + 1, px, py)) m[iy * nx + ix] = 1;
    }
  }
  return m;
}

const SHAPES = [
  ['full page 40×30', 40, 30, [1, 40, 40, 1], [1, 1, 30, 30]],
  ['triangle', 40, 30, [2, 38, 2], [2, 2, 28]],
  ['thin sliver', 40, 30, [5, 35, 35, 5], [14, 14, 17, 17]],
  ['off-page corner', 40, 30, [-10, 20, 20, -10], [-10, -10, 15, 15]],
  ['different size 25×25', 25, 25, [1, 25, 25, 1], [1, 1, 25, 25]],
];

export function run() {

// ------------------------------------------------------ agrees with the scan
say('<h2>Region mask — does it match the scan it replaced?</h2>');
say('<p class="note">Against a direct <code>inpolygon</code> loop written out in ' +
    'this file, not against the module itself. Exact equality on every pixel: ' +
    'this is the same arithmetic, so a single differing pixel is a bug and not ' +
    'a tolerance.</p>');
{
  say('<table><tr><th>polygon</th><th>pixels</th><th>inside</th>' +
      '<th>differing pixels</th><th>indices agree</th></tr>');
  let allOk = true;
  for (const [name, nx, ny, px, py] of SHAPES) {
    const want = referenceMask(nx, ny, px, py);
    const got = polygonMask(nx, ny, px, py);
    let diff = 0, inside = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i]) inside++;
      if (want[i] !== got[i]) diff++;
    }
    // the index list must be exactly the mask's set bits, in ascending order
    const idx = insideIndices(nx, ny, px, py);
    let idxOk = idx.length === inside;
    for (let k = 0; k < idx.length && idxOk; k++) {
      if (!want[idx[k]]) idxOk = false;
      if (k > 0 && idx[k] <= idx[k - 1]) idxOk = false;
    }
    const ok = diff === 0 && idxOk;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td><td>${(nx * ny).toLocaleString()}</td>` +
        `<td>${inside.toLocaleString()}</td>` +
        `<td class="${diff === 0 ? 'pass' : 'fail'}">${diff}</td>` +
        `<td class="${idxOk ? 'pass' : 'fail'}">${idxOk ? 'yes' : 'NO'}</td></tr>`);
  }
  say('</table>');
  say(`<p>the mask is the scan — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(the off-page corner ` +
      `row matters most: a polygon extending past the raster is what the ` +
      `drawing polygon looks like whenever the image is not the whole page)` +
      `</span></p>`);
}

// -------------------------------------------------------------- the cache
// THE ONLY NEW FAILURE MODE THE CONSOLIDATION CREATED. Interleave geometries so
// that every request is preceded by a DIFFERENT one, then overflow the four-slot
// LRU and come back. A key that ignored any part of the geometry -- the height,
// say, since two polygons can share px and differ only in ny -- would pass a
// naive "ask twice" test and fail this one.
say('<h2>Region mask — does the cache ever answer for the wrong polygon?</h2>');
say('<p class="note">Each shape is requested after a different one, then again ' +
    'after enough others to have evicted it. Every answer is re-checked against ' +
    'the reference scan.</p>');
{
  const refs = SHAPES.map(([, nx, ny, px, py]) => referenceMask(nx, ny, px, py));
  const check = (k) => {
    const [, nx, ny, px, py] = SHAPES[k];
    const got = polygonMask(nx, ny, px, py);
    let diff = 0;
    for (let i = 0; i < refs[k].length; i++) if (refs[k][i] !== got[i]) diff++;
    return diff;
  };
  // interleaved, then a full sweep that overflows the 4-slot cache, then back
  const order = [0, 1, 0, 2, 1, 3, 4, 0, 1, 2, 3, 4, 0];
  let worst = 0;
  const seq = [];
  for (const k of order) { const d = check(k); worst = Math.max(worst, d); seq.push(d); }

  // and one shape that differs from another ONLY in its raster height, which is
  // the key collision most likely to be missed
  const a = polygonMask(20, 20, [1, 20, 20, 1], [1, 1, 20, 20]);
  const b = polygonMask(20, 40, [1, 20, 20, 1], [1, 1, 20, 20]);
  const sizeOk = a.length === 400 && b.length === 800;

  say(`<p>requests in order <code>${order.join(' ')}</code> — worst differing ` +
      `pixel count <b>${worst}</b>. Same polygon at two raster heights: ` +
      `${a.length} and ${b.length} entries.</p>`);
  const ok = worst === 0 && sizeOk;
  say(`<p>the cache is keyed correctly — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> <span class="note">(13 requests over 5 ` +
      `shapes through a 4-slot LRU, so every shape is evicted and rebuilt at ` +
      `least once)</span></p>`);
}

// ------------------------------------------------------------ whitenOutside
say('<h2>Region mask — whitening the outside</h2>');
say('<p class="note">Must set every outside pixel to 1 and leave every inside ' +
    'pixel byte-identical. The second half is the one worth checking: a helper ' +
    'that also touched the interior would quietly alter the tone every method ' +
    'downstream is measured on.</p>');
{
  say('<table><tr><th>polygon</th><th>outside set to 1</th>' +
      '<th>inside altered</th></tr>');
  let allOk = true;
  for (const [name, nx, ny, px, py] of SHAPES) {
    const im = makeImage(nx, ny, 0.5);
    const before = Float64Array.from(im.data);
    const mask = polygonMask(nx, ny, px, py);
    whitenOutside(im, mask);
    let badOut = 0, badIn = 0;
    for (let i = 0; i < im.data.length; i++) {
      if (mask[i]) { if (im.data[i] !== before[i]) badIn++; }
      else if (im.data[i] !== 1) badOut++;
    }
    const ok = badOut === 0 && badIn === 0;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td>` +
        `<td class="${badOut === 0 ? 'pass' : 'fail'}">${badOut === 0 ? 'all' : `${badOut} missed`}</td>` +
        `<td class="${badIn === 0 ? 'pass' : 'fail'}">${badIn === 0 ? 'none' : `${badIn} CHANGED`}</td></tr>`);
  }
  say('</table>');
  say(`<p>whitening touches only the outside — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// --------------------------------------------------------- nobody wrote to it
// The mask is handed out uncopied, so a caller that wrote into it would poison
// every later request. Cheapest possible guard: take a fingerprint, run the
// sections above again, and confirm nothing moved.
say('<h2>Region mask — is the shared array still intact?</h2>');
{
  const [, nx, ny, px, py] = SHAPES[0];
  const ref = referenceMask(nx, ny, px, py);
  const got = polygonMask(nx, ny, px, py);
  let diff = 0;
  for (let i = 0; i < ref.length; i++) if (ref[i] !== got[i]) diff++;
  say(`<p>after every section above, the cached mask still matches the ` +
      `reference: <b>${diff}</b> differing pixels — ` +
      `<span class="${diff === 0 ? 'pass' : 'fail'}">${diff === 0 ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(mask.js hands out the cached array rather than a ` +
      `copy, which is what makes it worth caching at all. This is the check that ` +
      `a caller has not started writing into it.)</span></p>`);
}

}
