// New with the radial-remapping port; not sliced from the pre-split harness.
//
// The transport and the arrangements are already tested in tests/spine.lattice.js,
// so nothing here re-checks them. These are the claims that only exist once the
// points become a drawing: that the two tone ladders are the right SHAPE, that
// the centre control does what it says, and how big the across-ray residual is —
// the one limit a radial map cannot escape.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import radialRemap, {
  remapPoints, centreOf, toneBand, ROW_C,
} from '../src/methods/radialRemap.js';
import { say, num, flat, linearRamp, radialRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };
const KINDS = ['square', 'hex', 'phyllotaxis'];

export function run() {

// ------------------------------------------------------------- the exponent
// THE ONE THING MOST LIKELY TO BE WRONG, because it is the only method here
// whose tone law is 1/d^2. If the exponent were 1 the ink would still rise as
// the image darkens -- the picture would look broadly right -- and the error
// would appear only as a bow in the ramp. So it is tested as an exponent
// directly: halve the spacing and the dot coverage must go up FOURFOLD.
say('<h2>Radial remap — is the dot ladder really 1/d²?</h2>');
say('<p class="note">Flat fields at several spacings, rendered, and the measured ' +
    'coverage fitted as a power of d. Dots: expect −2. Joined rows: expect −1, ' +
    'because a row covers w per unit length however far the next row is. Same ' +
    'points, same transport, different exponent.</p>');
{
  say('<table><tr><th>mode</th><th>arrangement</th><th>fitted exponent</th>' +
      '<th>expected</th><th>C·κ implied</th></tr>');
  let allOk = true;
  for (const drawLattice of [false, true]) {
    for (const kind of KINDS) {
      const ds = [], cs = [];
      for (const tone of [0.15, 0.4, 0.65]) {
        const ctx = prepare(makeImage(360, 270, tone), settings);
        const args = {
          ...ctx, pointKind: kind, drawLattice,
          dotDW: 2.5, dMinW: 3, dMaxW: 14,
        };
        const built = remapPoints(args);
        if (!built) continue;
        const lines = radialRemap.run(args);
        const rendered = renderForTest(ctx, lines);
        let sum = 0;
        for (let i = 0; i < rendered.data.length; i++) sum += rendered.data[i];
        const cov = 1 - sum / rendered.data.length;
        // the spacing actually achieved, from the point count over the page
        const d = Math.sqrt((ctx.nx * ctx.ny) / Math.max(1, built.n));
        ds.push(Math.log(d)); cs.push(Math.log(Math.max(1e-9, cov)));
      }
      // slope of log(coverage) against log(d)
      const n = ds.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { sx += ds[i]; sy += cs[i]; sxx += ds[i] * ds[i]; sxy += ds[i] * cs[i]; }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const want = drawLattice ? -1 : -2;
      const ok = Math.abs(slope - want) < 0.25;
      allOk = allOk && ok;
      // with the exponent fixed at its ideal, what constant does the data imply
      const inter = (sy - want * sx) / n;
      say(`<tr><td>${drawLattice ? 'rows' : 'dots'}</td><td>${kind}</td>` +
          `<td class="${ok ? 'pass' : 'fail'}">${num(slope, 3)}</td>` +
          `<td>${want}</td><td>${num(Math.exp(inter), 4)}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>each mode follows its own ladder — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(0.25 on the exponent ` +
      `because three points over a modest spacing range cannot pin it tighter, ` +
      `and the point is to separate −1 from −2, not to measure either to three ` +
      `figures. The implied-constant column is what would set κ if it drifts ` +
      `from 1: for rows it should read C, i.e. 1.000 for square and ` +
      `${num(ROW_C.hex, 4)} for the other two.)</span></p>`);
}

// ----------------------------------------------------------------- the centre
// The pole is the one point the transport cannot move, so the lattice tears
// there. This checks the control actually moves it, and that it lands where the
// name promises.
say('<h2>Radial remap — does the centre control move the pole?</h2>');
say('<p class="note">All three positions are corners or midpoints of the drawing ' +
    'polygon, so each is an exact coordinate rather than a measurement. The ' +
    'second table is the one that matters: with the pole on a boundary the rays ' +
    'only fan through part of a turn, and the check is that the drawing survives ' +
    'it — same point count, same tone, no pile-up at the corner.</p>');
{
  const ctx = prepare(linearRamp(360, 270), settings);
  const { px, py } = ctx.polygon;
  const x0 = Math.min(...px), x1 = Math.max(...px);
  const y0 = Math.min(...py), y1 = Math.max(...py);
  const want = {
    image: [(x0 + x1) / 2, (y0 + y1) / 2],
    top: [(x0 + x1) / 2, y0],
    corner: [x0, y0],
  };
  say('<table><tr><th>mode</th><th>centre</th><th>expected</th></tr>');
  let allOk = true;
  for (const mode of ['image', 'top', 'corner']) {
    const [x, y] = centreOf(ctx, mode);
    const ok = Math.abs(x - want[mode][0]) < 1e-9 && Math.abs(y - want[mode][1]) < 1e-9;
    allOk = allOk && ok;
    say(`<tr><td>${mode}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${num(x, 2)}, ${num(y, 2)}</td>` +
        `<td>${num(want[mode][0], 2)}, ${num(want[mode][1], 2)}</td></tr>`);
  }
  say('</table>');

  // THE REAL CHECK. A pole on the boundary means three quarters of the source
  // disc has no target mass at all and is discarded, and the rays that DO carry
  // image are a quarter turn rather than a full one. If any of that were handled
  // wrongly the symptom would be points heaped at the corner or a drawing that
  // silently thins -- both of which show up here as a point count that does not
  // track the others.
  say('<table><tr><th>mode</th><th>points</th><th>points / wanted</th>' +
      '<th>dropped</th><th>worst shortfall</th><th>nearest point to pole</th></tr>');
  for (const mode of ['image', 'top', 'corner']) {
    const args = { ...ctx, pointKind: 'phyllotaxis', dotDW: 2.5, dMinW: 3, dMaxW: 14, centreMode: mode };
    const built = remapPoints(args);
    if (!built) { say(`<tr><td>${mode}</td><td colspan="5">no points</td></tr>`); allOk = false; continue; }
    const [cx, cy] = centreOf(ctx, mode);
    let near = Infinity;
    for (let i = 0; i < built.n; i++) {
      near = Math.min(near, Math.hypot(built.x[i] - cx, built.y[i] - cy));
    }
    const ratio = built.n / built.want;
    const ok = Math.abs(ratio - 1) < 0.15 && built.shortfall === 0;
    allOk = allOk && ok;
    say(`<tr><td>${mode}</td><td>${built.n.toLocaleString()}</td>` +
        `<td class="${Math.abs(ratio - 1) < 0.15 ? 'pass' : 'fail'}">${num(ratio, 4)}</td>` +
        `<td>${built.dropped.toLocaleString()}</td>` +
        `<td class="${built.shortfall === 0 ? 'pass' : 'fail'}">${num(built.shortfall, 5)}</td>` +
        `<td>${num(near, 2)} px</td></tr>`);
  }
  say('</table>');
  say(`<p>the pole goes where it is asked, and a boundary pole works — ` +
      `<span class="${allOk ? 'pass' : 'fail'}">${allOk ? 'PASS' : 'FAIL'}</span> ` +
      `<span class="note">(the dropped count should climb steeply from image to ` +
      `corner — three quarters of the source disc is wasted when the rays only ` +
      `fan through a quarter turn — while the point count stays put. That is the ` +
      `difference between wasting generation time, which is fine, and losing the ` +
      `drawing, which is not.)</span></p>`);
}

// ------------------------------------------------------- the across-ray residual
// THE METHOD'S ONE STRUCTURAL LIMIT, quantified. A radial pass makes the density
// exact along every ray and can only approximate it across rays, because mass
// never moves sideways. This is how big that residual actually is.
//
// A SECOND PASS WAS BUILT TO REDUCE IT AND MADE IT WORSE -- 0.0666 to 0.0760 on
// this very table -- so the control was removed rather than shipped. The reason
// is in radialRemap's header; the number is kept here because it is the honest
// statement of what the method can do, and because anyone tempted to add
// iteration back should see what one pass already achieves.
say('<h2>Radial remap — how big is the across-ray residual?</h2>');
say('<p class="note">Standard deviation of (points landed / points wanted) over ' +
    'a 9×7 grid of cells, on a ramp running across x — the direction a radial ' +
    'map is worst at. Reported, not scored: it is a property of the algorithm ' +
    'rather than something that can be got wrong.</p>');
{
  say('<table><tr><th>arrangement</th><th>points</th><th>density error (sd)</th>' +
      '<th>dropped</th><th>worst shortfall</th></tr>');
  const ctx = prepare(linearRamp(360, 270), settings);
  for (const kind of KINDS) {
    const args = {
      ...ctx, pointKind: kind, dotDW: 2.5, dMinW: 3, dMaxW: 14,
    };
    const built = remapPoints(args);
    if (!built) { say(`<tr><td>${kind}</td><td colspan="4">no points</td></tr>`); continue; }
    // density error over a coarse grid
    const gx = 9, gy = 7;
    const got = new Float64Array(gx * gy);
    for (let i = 0; i < built.n; i++) {
      const cxi = Math.min(gx - 1, Math.floor(((built.x[i] - 1) / ctx.nx) * gx));
      const cyi = Math.min(gy - 1, Math.floor(((built.y[i] - 1) / ctx.ny) * gy));
      got[cyi * gx + cxi]++;
    }
    // What each cell asked for, RE-DERIVED from the documented model rather than
    // read back from densityMap. Calling the method's own helper would compare
    // the code to itself, which is how the triStripes κ table passed while the
    // ramp was 23% out.
    const wantG = new Float64Array(gx * gy);
    {
      const band = toneBand(args);
      for (let iy = 0; iy < ctx.ny; iy++) {
        for (let ix = 0; ix < ctx.nx; ix++) {
          const B = ctx.im.data[iy * ctx.nx + ix] * (band.max - band.min) + band.min;
          const c = Math.min(1, Math.max(0, 1 - B));
          const rDot = (2.5 * ctx.w) / 2;
          const d = rDot * Math.sqrt(Math.PI / Math.max(1e-6, c));
          const cxi = Math.min(gx - 1, Math.floor((ix / ctx.nx) * gx));
          const cyi = Math.min(gy - 1, Math.floor((iy / ctx.ny) * gy));
          wantG[cyi * gx + cxi] += 1 / (d * d);
        }
      }
    }
    let sum = 0, sum2 = 0, cells = 0;
    for (let i = 0; i < gx * gy; i++) {
      if (!(wantG[i] > 1)) continue;
      const r = got[i] / wantG[i];
      sum += r; sum2 += r * r; cells++;
    }
    const mean = sum / cells;
    const sd = Math.sqrt(Math.max(0, sum2 / cells - mean * mean));
    say(`<tr><td>${kind}</td><td>${built.n.toLocaleString()}</td>` +
        `<td>${num(sd, 4)}</td><td>${built.dropped.toLocaleString()}</td>` +
        `<td>${num(built.shortfall, 5)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">No verdict. What the numbers are FOR: the residual is what ' +
      'a caller trades away by choosing this method over a relaxed stipple, and ' +
      'it should be roughly the same for all three arrangements, since it comes ' +
      'from the radial constraint rather than from the point set. A shortfall ' +
      'above zero means sourceRadiusFor under-asked.</p>');
}

// ------------------------------------------------------------------ tone ramps
runToneTest('Radial remap — phyllotaxis dots, ramp',
  radialRemap, linearRamp(360, 270),
  { pointKind: 'phyllotaxis', dotDW: 2.5, dMinW: 3, dMaxW: 14 }, settings);

runToneTest('Radial remap — hex dots, radial ramp',
  radialRemap, radialRamp(360, 270),
  { pointKind: 'hex', dotDW: 2.5, dMinW: 3, dMaxW: 14 }, settings);

runToneTest('Radial remap — joined rows, ramp',
  radialRemap, linearRamp(360, 270),
  { pointKind: 'square', dMinW: 2, dMaxW: 20, drawLattice: true }, settings);

}
