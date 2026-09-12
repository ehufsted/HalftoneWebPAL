// Extracted verbatim from the pre-split verify.html (lines 1152-1191).
// Body unchanged, so the emitted output stays byte-identical.

import { inpolygon } from '../src/shim/image.js';
import { fullPolygon } from '../src/spine/units.js';
import parallelHatching from '../src/methods/parallelHatching.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { say } from './runner.js';

export function run() {
// ------------------------------------------------ shim: the region mask
// Cheap, and it would have caught two separate visible bugs immediately. Every
// method that masks by region calls inpolygon on pixel CENTRES against
// fullPolygon = [1,nx]x[1,ny], whose edges pass exactly through them. A
// half-open crossing test then includes the left column and top row and drops
// the right column and bottom row -- silently, and asymmetrically.
say('<h2>Shim — every pixel of the full-image polygon is in the region</h2>');
{
  const nx = 37, ny = 23;
  const poly = fullPolygon(nx, ny);
  let inCount = 0;
  const missing = [];
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      if (inpolygon(j + 1, i + 1, poly.px, poly.py)) inCount++;
      else if (missing.length < 6) missing.push(`(${j + 1},${i + 1})`);
    }
  }
  const all = inCount === nx * ny;
  say('<table>' +
    `<tr><th>pixels</th><td>${nx * ny}</td></tr>` +
    `<tr><th>inside</th><td>${inCount}</td></tr>` +
    `<tr><th>first missing</th><td>${missing.join(' ') || '—'}</td></tr>` +
    '</table>');
  say(`<p>full-image polygon covers every pixel — ` +
      `<span class="${all ? 'pass' : 'fail'}">${all ? 'PASS' : 'FAIL'}</span> ` +
      '<span class="note">A deficit of exactly nx+ny−1 is the half-open ' +
      'convention dropping the right column and the bottom row.</span></p>');

  // and the edges of a general polygon should behave the same way
  const tri = { px: [2, 20, 2], py: [2, 2, 16] };
  const onEdge = inpolygon(11, 2, tri.px, tri.py);       // midpoint of an edge
  const atVertex = inpolygon(20, 2, tri.px, tri.py);     // a vertex
  const outside = inpolygon(19, 15, tri.px, tri.py);     // clearly outside
  const ok = onEdge && atVertex && !outside;
  say(`<p>edge midpoint ${onEdge ? 'in' : 'out'}, vertex ` +
      `${atVertex ? 'in' : 'out'}, exterior point ${outside ? 'in' : 'out'} — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

}
