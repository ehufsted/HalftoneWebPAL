// New with the radial-remapping port; not sliced from the pre-split harness.
//
// Two modules, tested before anything draws with them: the point arrangements
// and the transport that moves them. Neither produces a picture, so both can be
// checked against arithmetic rather than against appearance.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import {
  latticeInDisc, HEX_A_PER_SPACING, PHYLLO_C_PER_SPACING,
} from '../src/spine/lattice.js';
import {
  massTable, transportRadial, sourceRadiusFor, uniformProfile,
} from '../src/spine/radialTransport.js';
import { say, num, flat, linearRamp } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

export function run() {

// ------------------------------------------------------- the arrangements
// ONE POINT PER d^2, WHICHEVER ARRANGEMENT. That is the whole contract, and it
// is what lets the three be swapped without touching the tone model. Measured as
// density over the disc, so a wrong constant shows up directly rather than as a
// tone error three modules downstream.
say('<h2>Lattices — does each point own d² of area?</h2>');
say('<p class="note">Count over a disc of known area. The derived constants are ' +
    `√(2/√3) = ${num(HEX_A_PER_SPACING, 6)} for the triangular lattice's ` +
    `nearest-neighbour spacing and 1/√π = ${num(PHYLLO_C_PER_SPACING, 6)} for ` +
    'the Vogel spiral. The source uses 1.0663 for the first, which is 0.8% ' +
    'light; if that were right this table would read 1.016 instead of 1.000.</p>');
{
  say('<table><tr><th>arrangement</th><th>d</th><th>radius</th><th>points</th>' +
      '<th>disc area / d²</th><th>ratio</th><th>rows</th><th>row coverage</th></tr>');
  let worst = 0;
  for (const kind of ['square', 'hex', 'phyllotaxis']) {
    for (const d of [4, 9]) {
      const R = 200;
      const { x, n, rows } = latticeInDisc(kind, R, d);
      const expect = (Math.PI * R * R) / (d * d);
      // count only what is genuinely inside the disc: the two lattices are
      // built row by row and land slightly proud of it
      let inside = 0;
      const { y } = latticeInDisc(kind, R, d);
      for (let i = 0; i < n; i++) if (Math.hypot(x[i], y[i]) <= R) inside++;
      const ratio = inside / expect;
      worst = Math.max(worst, Math.abs(ratio - 1));
      // every point should appear in exactly one row, or the line mode will
      // draw some twice and miss others
      const seen = new Set();
      let dup = 0;
      for (const r of rows) for (const i of r) { if (seen.has(i)) dup++; seen.add(i); }
      const cover = seen.size / n;
      say(`<tr><td>${kind}</td><td>${d}</td><td>${R}</td>` +
          `<td>${inside.toLocaleString()}</td><td>${num(expect, 0)}</td>` +
          `<td class="${Math.abs(ratio - 1) < 0.02 ? 'pass' : 'fail'}">${num(ratio, 4)}</td>` +
          `<td>${rows.length}</td>` +
          `<td class="${dup === 0 ? 'pass' : 'fail'}">${num(cover, 3)}` +
          `${dup > 0 ? ` (${dup} DUP)` : ''}</td></tr>`);
    }
  }
  say('</table>');
  const ok = worst < 0.02;
  say(`<p>the density contract holds — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)}). ` +
      '<span class="note">2% because a disc of finite radius has a boundary ' +
      'layer one spacing thick; the ratio should tighten as R/d grows, and the ' +
      'two d values are there to show it does. Row coverage must be exactly 1 ' +
      'with no duplicates — a point in two rows would be inked twice.</span></p>');
}

// ------------------------------------------------------------ the transport
// THE SHARPEST CHECK AVAILABLE, and it only became available once the map was
// fixed to be radius-to-radius. If the source spacing already matches the
// density the target asks for, the transport has nothing to do and MUST BE THE
// IDENTITY -- every point ends where it started, to floating-point.
//
// The rank-based version failed this catastrophically while still producing a
// plausible-looking point count: it returned concentric rings and an empty disc
// 45 px across. An identity test cannot be fooled that way, which is the reason
// to prefer it over a distributional one.
say('<h2>Radial transport — is a matched field the identity?</h2>');
say('<p class="note">Uniform target density of one point per (6px)², from a ' +
    'lattice of mean spacing 6. Source and target agree everywhere, so every ' +
    'point that stays inside must not move at all. Reported as the largest ' +
    'displacement in pixels — this is arithmetic, not a measurement.</p>');
{
  const ctx = prepare(makeImage(360, 270, 0.5), settings);
  const cx = ctx.nx / 2, cy = ctx.ny / 2;
  say('<table><tr><th>arrangement</th><th>points in</th><th>points out</th>' +
      '<th>dropped</th><th>short rays</th><th>worst shortfall</th>' +
      '<th>max displacement</th></tr>');
  let allOk = true;
  const rho = new Float64Array(ctx.nx * ctx.ny).fill(1 / 36);
  const table = massTable(ctx, rho, cx, cy, { spacing: 6 });
  for (const kind of ['square', 'hex', 'phyllotaxis']) {
    const S = sourceRadiusFor(table, 6);
    const src = latticeInDisc(kind, S, 6);
    const sx = Float64Array.from(src.x, (v) => v + cx);
    const sy = Float64Array.from(src.y, (v) => v + cy);
    const out = transportRadial(sx, sy, src.n, table, uniformProfile(6));
    let move = 0;
    for (let i = 0; i < out.x.length; i++) {
      const p = out.keep[i];
      move = Math.max(move, Math.hypot(out.x[i] - sx[p], out.y[i] - sy[p]));
    }
    const ok = move < 0.5 && out.short === 0;
    allOk = allOk && ok;
    say(`<tr><td>${kind}</td><td>${src.n.toLocaleString()}</td>` +
        `<td>${out.x.length.toLocaleString()}</td>` +
        `<td>${out.dropped.toLocaleString()}</td>` +
        `<td class="${out.short === 0 ? 'pass' : 'fail'}">${out.short}</td>` +
        `<td>${num(out.shortfall, 5)}</td>` +
        `<td class="${move < 0.5 ? 'pass' : 'fail'}">${num(move, 4)} px</td></tr>`);
  }
  say('</table>');
  say(`<p>a matched field does not move — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(0.5 px rather than ` +
      `zero because the mass table samples ρ on a 256-step radial grid and reads ` +
      `it per pixel; the residual is that discretisation and nothing else. Short ` +
      `rays must be zero, and the bin count is what decides it: bins are sized ` +
      `two spacings wide at the far radius, because a wedge narrower than the ` +
      `lattice period can fall between rows and no margin on the source disc ` +
      `fixes that. The shortfall column says how light a short ray would ` +
      `actually draw, which a count alone cannot.)</span></p>`);
}

// ------------------------------------------------ the density it was asked for
// The general case, scored against the integral rather than a closed form: bin
// the transported points by position and compare local density to rho.
say('<h2>Radial transport — local density against the request</h2>');
say('<p class="note">On a ramp, the density varies across the picture. Measured ' +
    'in vertical bands, transported count per unit area against the mean rho ' +
    'each band asked for. The ramp runs across x, which is the direction a ' +
    'radial map is WORST at — mass cannot move sideways — so this is the ' +
    'honest hard case rather than a flattering one.</p>');
{
  const ctx = prepare(linearRamp(360, 270), settings);
  const cx = ctx.nx / 2, cy = ctx.ny / 2;
  // one point per (4px)^2 at black, per (14px)^2 at white
  const rho = new Float64Array(ctx.nx * ctx.ny);
  for (let i = 0; i < rho.length; i++) {
    const B = Math.min(1, Math.max(0, ctx.im.data[i]));
    const d = 4 + B * (14 - 4);
    rho[i] = 1 / (d * d);
  }
  const table = massTable(ctx, rho, cx, cy, { spacing: 4 });
  const S = sourceRadiusFor(table, 4);
  const src = latticeInDisc('phyllotaxis', S, 4);
  const out = transportRadial(Float64Array.from(src.x, (v) => v + cx),
                              Float64Array.from(src.y, (v) => v + cy),
                              src.n, table, uniformProfile(4));

  const nBand = 6;
  const bw = ctx.nx / nBand;
  const got = new Float64Array(nBand), want = new Float64Array(nBand);
  const area = new Float64Array(nBand);
  for (let i = 0; i < out.x.length; i++) {
    const b = Math.min(nBand - 1, Math.max(0, Math.floor((out.x[i] - 1) / bw)));
    if (out.y[i] >= 1 && out.y[i] <= ctx.ny) got[b]++;
  }
  for (let iy = 0; iy < ctx.ny; iy++) {
    for (let ix = 0; ix < ctx.nx; ix++) {
      const b = Math.min(nBand - 1, Math.floor(ix / bw));
      want[b] += rho[iy * ctx.nx + ix];
      area[b]++;
    }
  }
  say('<table><tr><th>band</th><th>points wanted</th><th>points landed</th>' +
      '<th>ratio</th></tr>');
  let worst = 0;
  for (let b = 0; b < nBand; b++) {
    const ratio = want[b] > 0 ? got[b] / want[b] : 1;
    worst = Math.max(worst, Math.abs(ratio - 1));
    say(`<tr><td>${b}</td><td>${num(want[b], 0)}</td><td>${got[b]}</td>` +
        `<td class="${Math.abs(ratio - 1) < 0.1 ? 'pass' : 'fail'}">${num(ratio, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.1;
  say(`<p>local density tracks the request — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst ${num(worst, 4)}). ` +
      '<span class="note">10% because a single radial pass is CONSTRAINED: it ' +
      'gets the density exactly right along each ray and can only approximate it ' +
      'across rays. The residual here is the number the multi-pass control ' +
      'exists to reduce, so its size is the argument for that control rather ' +
      'than a defect.</span></p>');
}

// ------------------------------------------------------------- determinism
say('<h2>Radial transport — is the discard set reproducible?</h2>');
{
  const ctx = prepare(linearRamp(360, 270), settings);
  const rho = new Float64Array(ctx.nx * ctx.ny).fill(1 / 49);
  const table = massTable(ctx, rho, ctx.nx / 2, ctx.ny / 2, { spacing: 7 });
  const S = sourceRadiusFor(table, 7);
  const src = latticeInDisc('hex', S, 7);
  const shift = (v, c) => Float64Array.from(v, (q) => q + c);
  const prof = uniformProfile(7);
  const a = transportRadial(shift(src.x, ctx.nx / 2), shift(src.y, ctx.ny / 2), src.n, table, prof);
  const b = transportRadial(shift(src.x, ctx.nx / 2), shift(src.y, ctx.ny / 2), src.n, table, prof);
  let diff = a.x.length !== b.x.length ? 1 : 0;
  for (let i = 0; i < a.x.length && diff === 0; i++) {
    if (a.x[i] !== b.x[i] || a.y[i] !== b.y[i] || a.keep[i] !== b.keep[i]) diff = 1;
  }
  say(`<p>two runs, ${a.x.length.toLocaleString()} points, ` +
      `${a.dropped.toLocaleString()} discarded — ` +
      `<span class="${diff === 0 ? 'pass' : 'fail'}">` +
      `${diff === 0 ? 'identical, PASS' : 'DIFFER, FAIL'}</span> ` +
      '<span class="note">(the sort inside each bin breaks ties on point index ' +
      'for exactly this reason: points at equal radius are common in a lattice, ' +
      'and an unstable order there would make the drawing change between ' +
      'renders with nothing in the settings having moved)</span></p>');
}

}
