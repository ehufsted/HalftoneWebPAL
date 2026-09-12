// New with the anisotropic alignment pass; not sliced from the pre-split harness.
//
// `alignPoints` relaxes an existing point set under an elliptical metric aligned
// to the local image orientation, so dots pack tighter along one axis and the
// stipple follows the form. Five questions here, and they are not equally easy.
//
//   1. is it inert at strength 0                     counting, no tolerance
//   2. does the dot count survive                    counting, no tolerance
//   3. does it align to the direction it claims      swept over grating angle
//   4. what does it cost in tone                     the claim I first got wrong
//   5. does the relaxation converge                  reported, not scored
//
// SCOPE NOTE, because it is easy to reach for the wrong thing next. This pass is
// for POINT PLACEMENT only. Under a per-site metric the bisector between two
// sites is a conic, so cells are not convex and `voronoiCells` -- which builds
// them by half-plane clipping -- computes something else entirely. Anything that
// pairs anisotropically placed points with those polygons is wrong.

import { makeImage, meanOf } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { siteMetrics, alignPoints } from '../src/spine/relax.js';
import { bestCandidatePoints } from '../src/spine/points.js';
import { dotPath } from '../src/spine/dots.js';
import { stipplePlacement, darknessField } from '../src/methods/stippleGrowing.js';
import { say, num, flat, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

/**
 * A grating at angle phi: constant orientation, high coherence, uniform energy.
 *
 * The point of using one is that the answer is known in closed form. Its gradient
 * runs along (cos phi, sin phi), so the structure tensor's TANGENT -- which is
 * what the metric aligns to -- is phi + pi/2.
 */
function grating(w, h, phi, lambda = 14) {
  const im = makeImage(w, h);
  const cx = Math.cos(phi), cy = Math.sin(phi);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      im.data[y * w + x] = 0.5 + 0.35 * Math.cos((2 * Math.PI * (x * cx + y * cy)) / lambda);
    }
  }
  return im;
}

/**
 * Second moments of the nearest-neighbour displacement vectors, and what they say
 * about the point set's shape.
 *
 * A set packed tighter along one axis has its nearest neighbours predominantly in
 * that direction, so the principal axis of this matrix IS the tight direction and
 * the eigenvalue ratio grows with the anisotropy. Reported as a ratio and an
 * angle rather than converted to rho, because the map from one to the other is
 * not something this file should be asserting.
 */
function nnShape(sx, sy) {
  const n = sx.length;
  if (n < 2) return { ratio: 1, angle: 0 };
  let axx = 0, axy = 0, ayy = 0;
  for (let i = 0; i < n; i++) {
    let bd = Infinity, bx = 0, by = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = sx[j] - sx[i], dy = sy[j] - sy[i];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bx = dx; by = dy; }
    }
    axx += bx * bx; axy += bx * by; ayy += by * by;
  }
  const tr = axx + ayy;
  const disc = Math.hypot(axx - ayy, 2 * axy);
  const l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
  return {
    ratio: l2 > 0 ? l1 / l2 : Infinity,
    angle: 0.5 * Math.atan2(2 * axy, axx - ayy),   // principal axis, mod pi
  };
}

/** Smallest angle between two orientations, mod pi, in radians. */
function orientDelta(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/**
 * The mean metric over the sites, and its square root.
 *
 * `A = M^(1/2)` is the map that takes metric space to Euclidean space, so a point
 * set that is correct under M must look ISOTROPIC after A is applied to it. That
 * is the oracle in test 3, and it is independent of the implementation: it tests
 * the placement against the definition of the metric rather than against itself.
 *
 * For a 2x2 SPD matrix `M^(1/2) = (M + sqrt(det M) I) / sqrt(tr M + 2 sqrt(det M))`,
 * and det M = 1 here by construction, so it collapses to `(M + I)/sqrt(tr M + 2)`.
 * No eigendecomposition, and the determinant identity is itself worth checking --
 * if it has drifted from 1 the whole design note in siteMetrics is wrong.
 */
function meanMetricSqrt(metric, n) {
  let m11 = 0, m12 = 0, m22 = 0;
  for (let i = 0; i < n; i++) { m11 += metric.m11[i]; m12 += metric.m12[i]; m22 += metric.m22[i]; }
  m11 /= n; m12 /= n; m22 /= n;
  const det = m11 * m22 - m12 * m12;
  const s = Math.sqrt(m11 + m22 + 2 * Math.sqrt(det));
  return { a11: (m11 + Math.sqrt(det)) / s, a12: m12 / s, a22: (m22 + Math.sqrt(det)) / s, det };
}

export function run() {

// ------------------------------------------------------------- inert at zero
// THE SWITCH IS THE ITERATION COUNT, so that is what this checks. An earlier
// version asserted that strength 0 was a no-op, which was true of the code at the
// time and was the bug: it meant the isotropic polish -- worth 4.6x on overlap --
// could not be asked for. Zero iterations is the off state now, and strength 0
// with iterations is a legitimate configuration that MUST move points.
say('<h2>Anisotropic alignment — is zero iterations inert?</h2>');
say('<p class="note">The whole isotropic body of work has to be untouched by this ' +
    'feature existing, and the default is zero iterations. Counting, so no ' +
    'tolerance. The second half is the converse and matters just as much: with ' +
    'iterations but no anisotropy the pass must actually run.</p>');
{
  const ctx = prepare(grating(360, 270, Math.PI / 5), settings);
  const base = { dDotW: 3, rMaxMult: 30, order: 'centre', seed: 1 };
  const a = stipplePlacement({ ...ctx, ...base }, 1.5 * ctx.w);
  const b = stipplePlacement({ ...ctx, ...base, anisotropy: 1, alignIter: 0 }, 1.5 * ctx.w);
  let same = a.n === b.n;
  for (let i = 0; i < a.n && same; i++) {
    if (a.x[i] !== b.x[i] || a.y[i] !== b.y[i]) same = false;
  }
  const noTrace = b.trace === null;

  const sx = Float64Array.from([10, 20, 30]), sy = Float64Array.from([10, 20, 30]);
  const t0 = alignPoints(ctx, sx, sy, { strength: 1, iterations: 0, spacing: 10 });
  const untouched = sx[0] === 10 && sy[2] === 30 && t0.worst.length === 0;

  // Converse: strength 0 with iterations is the isotropic polish and must work.
  const c = stipplePlacement({ ...ctx, ...base, anisotropy: 0, alignIter: 8 }, 1.5 * ctx.w);
  let moved = c.n === a.n && c.trace !== null && c.trace.worst.length > 0;
  if (moved) {
    let any = false;
    for (let i = 0; i < a.n; i++) if (c.x[i] !== a.x[i] || c.y[i] !== a.y[i]) { any = true; break; }
    moved = any;
  }

  const ok = same && noTrace && untouched && moved;
  say(`<p>zero iterations identical: <b>${same ? 'yes' : 'NO'}</b>, no trace: ` +
      `<b>${noTrace ? 'yes' : 'NO'}</b>, alignPoints a no-op at 0 iters: ` +
      `<b>${untouched ? 'yes' : 'NO'}</b>, isotropic polish reachable and it ` +
      `moves points: <b>${moved ? 'yes' : 'NO'}</b> — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span></p>`);
}

// ------------------------------------------------------------ count survives
say('<h2>Anisotropic alignment — does the dot count survive?</h2>');
say('<p class="note">The count is fixed by the ink budget before any placer runs, ' +
    'and relaxation moves points without making or losing one. So this must hold ' +
    'exactly at every strength, for every placement. Counting.</p>');
{
  const ctx = prepare(grating(360, 270, Math.PI / 5), settings);
  say('<table><tr><th>placement</th><th>strength</th><th>dots</th>' +
      '<th>same as isotropic</th></tr>');
  let allOk = true;
  for (const placer of ['growing', 'lloyd', 'bestCandidate', 'subdivide']) {
    const base = { ...ctx, dDotW: 3, rMaxMult: 30, order: 'centre', seed: 1, placer };
    const n0 = stipplePlacement(base, 1.5 * ctx.w).n;
    for (const s of [-1, -0.5, 0.5, 1]) {
      const n1 = stipplePlacement({ ...base, anisotropy: s, alignIter: 8 }, 1.5 * ctx.w).n;
      const ok = n1 === n0;
      allOk = allOk && ok;
      say(`<tr><td>${placer}</td><td>${num(s, 2)}</td><td>${n1}</td>` +
          `<td class="${ok ? 'pass' : 'fail'}">${ok ? 'yes' : `NO (${n0})`}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>the count is untouched — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span></p>`);
}

// -------------------------------------------------- does it align where it says
// SWEPT OVER THE GRATING ANGLE, deliberately. A single axis-aligned test would
// pass in the one orientation the pixel grid cannot get wrong, which is exactly
// the mistake docs/findings.md records against the first phase-to-spacing check.
//
// Two independent checks, because either alone is weak. The DIRECTION check says
// the tight axis points where the metric said it would. The WARP check says the
// amount is right too: applying A = M^(1/2) maps metric space to Euclidean space,
// so a correctly aligned set must come out isotropic under it. The second is an
// oracle rather than a restatement -- it tests the points against the definition
// of the metric, not against the code that placed them.
say('<h2>Anisotropic alignment — does it align where it claims to?</h2>');
say('<p class="note">Gratings at four angles. At +1 the dots should pack tight ' +
    'ALONG the edge tangent, which for a grating of angle φ is φ+90°. Raw ratio ' +
    'shows the set is anisotropic; the warped ratio is the oracle — apply the ' +
    'metric’s square root and a correct set becomes isotropic.</p>');
{
  say('<table><tr><th>grating φ</th><th>worst |det Mᵢ − 1|</th><th>raw ratio</th>' +
      '<th>tight axis err</th><th>warped ratio</th><th>improved</th></tr>');
  let dirOk = true, warpOk = true, detOk = true;
  for (const deg of [0, 30, 60, 105]) {
    const phi = (deg * Math.PI) / 180;
    const ctx = prepare(grating(360, 270, phi), settings);
    const args = {
      ...ctx, dDotW: 3, placer: 'bestCandidate', seed: 1,
      anisotropy: 1, alignIter: 12,
    };
    const res = stipplePlacement(args, 1.5 * ctx.w);
    const { field } = darknessField(args);
    let live = 0;
    for (let i = 0; i < field.length; i++) if (field[i] > 0) live++;
    const spacing = Math.sqrt(Math.max(1, live) / Math.max(1, res.n));
    const met = siteMetrics(args, res.x, res.y, res.n, 1, spacing);
    const A = meanMetricSqrt(met, res.n);

    const raw = nnShape(res.x, res.y);
    const wx = new Float64Array(res.n), wy = new Float64Array(res.n);
    for (let i = 0; i < res.n; i++) {
      wx[i] = A.a11 * res.x[i] + A.a12 * res.y[i];
      wy[i] = A.a12 * res.x[i] + A.a22 * res.y[i];
    }
    const warped = nnShape(wx, wy);

    const expect = phi + Math.PI / 2;
    const errDeg = (orientDelta(raw.angle, expect) * 180) / Math.PI;
    const dOk = errDeg < 20;
    const wOk = warped.ratio < raw.ratio;
    // PER SITE, not on the mean. det is not linear, and by concavity the mean of
    // unit-determinant SPD matrices has det >= 1 with equality only when they are
    // all identical -- so scoring `A.det` would fail on correct code the moment
    // the metric varies at all, which is always. The identity belongs to each
    // Mi individually and that is where it is checked.
    let worstDet = 0;
    for (let i = 0; i < res.n; i++) {
      const dt = met.m11[i] * met.m22[i] - met.m12[i] * met.m12[i];
      worstDet = Math.max(worstDet, Math.abs(dt - 1));
    }
    const detGood = worstDet < 1e-9;
    dirOk = dirOk && dOk; warpOk = warpOk && wOk; detOk = detOk && detGood;

    say(`<tr><td>${deg}°</td>` +
        `<td class="${detGood ? 'pass' : 'fail'}">${num(worstDet, 12)}</td>` +
        `<td>${num(raw.ratio, 3)}</td>` +
        `<td class="${dOk ? 'pass' : 'fail'}">${num(errDeg, 1)}°</td>` +
        `<td>${num(warped.ratio, 3)}</td>` +
        `<td class="${wOk ? 'pass' : 'fail'}">${wOk ? 'yes' : 'NO'}</td></tr>`);
  }
  say('</table>');
  const ok = dirOk && warpOk && detOk;
  say(`<p>aligned, and by the right amount — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span>. <span class="note">det Mᵢ = 1 is scored at ` +
      `1e-9 because it is an identity of the construction — half² − dif² = 1 ` +
      `exactly — not a measurement. If it drifts, the argument in siteMetrics ` +
      `about removing the isotropic dilation no longer holds and the Gersho ` +
      `figures move with it. The 20° bar ` +
      `on direction is loose on purpose: near a grating’s extrema the tensor ` +
      `is weak and the gate correctly damps those sites toward isotropy, so a ` +
      `handful contribute noise to the principal axis.</span></p>`);
}

// ------------------------------------------------------------------ what it costs
// THE CLAIM I FIRST GOT WRONG, so it gets the most careful treatment. Alignment
// does not change the dot COUNT, and that misled me into calling it tone-neutral.
// It changes the spacing, and `coverage = n*pi*rDot^2/area` assumes dots do not
// overlap -- so beyond the point where they do, ink the model counted stops
// reaching the paper and the drawing goes light.
//
// The cap is derived, not chosen: no overlap needs 2*rDot <= spacing/sqrt(rho),
// i.e. rho <= (spacing/2 rDot)^2, which at the tone model's own density is
// pi/(4K). Printed per row so the measurement can be read against it.
// THE FIRST VERSION OF THIS TEST COULD NOT SEE ITS OWN SUBJECT, and the failure
// is worth keeping written down because the table looked entirely reasonable.
//
// It ran flat greys, on the reasoning that uniform tone gives uniform spacing and
// therefore a single overlap threshold per row. True, and fatal: a flat field has
// no gradient, so coherence and energy are both zero, the gate correctly drives
// rho to 1, and the metric is the IDENTITY at every strength. The table was
// measuring twelve steps of ordinary isotropic Lloyd. Its own numbers said so --
// strength 0.5 and strength 1.0 agreed to four decimals in all three rows, which
// cannot happen if anisotropy is doing anything at all.
//
// TONE AND ORIENTATION ARE COUPLED IN AN IMAGE and cannot both be controlled: a
// picture with uniform darkness has no direction in it. They are NOT coupled in
// `alignPoints`, which takes the mass field as an argument separate from the ctx
// its metric comes from. So the fix is to hand it a uniform field over a grating
// ctx: uniform density, a single spacing, a single cap, and a genuinely
// anisotropic metric.
//
// (What the broken version accidentally measured is reported below it, because it
// turned out to matter more than what it was for.)
say('<h2>Anisotropic alignment — what does it cost in tone?</h2>');
say('<p class="note">Uniform density over a grating: the mass field is flat so ' +
    'spacing and the overlap cap are single numbers, while the image underneath ' +
    'still has a direction for the metric to find. Error is predicted ink minus ' +
    'laid ink, so positive means ink lost to overlap.</p>');
{
  const ctx = prepare(grating(320, 320, Math.PI / 5), settings);
  const area = ctx.nx * ctx.ny;
  const rDot = Math.max(ctx.w / 2, 1.5 * ctx.w);
  const field = new Float64Array(area).fill(1);
  say('<table><tr><th>coverage</th><th>strength</th><th>dots</th><th>spacing</th>' +
      '<th>rho cap</th><th>predicted ink</th><th>laid ink</th><th>lost</th></tr>');
  for (const K of [0.2, 0.45, 0.7]) {
    const count = Math.round((K * area) / (Math.PI * rDot * rDot));
    const spacing = Math.sqrt(area / count);
    // No overlap needs 2*rDot <= spacing/sqrt(rho); this is that, solved for rho.
    const cap = (spacing / (2 * rDot)) ** 2;
    const seed0 = bestCandidatePoints(ctx, { field, count, seed: 1 });
    for (const s of [0, 0.5, 1]) {
      const sx = Float64Array.from(seed0.sx), sy = Float64Array.from(seed0.sy);
      // THE SAME NUMBER OF ITERATIONS AT EVERY STRENGTH, including 0. Skipping
      // the pass on the strength-0 row would make this block compare anisotropy
      // against NO RELAXATION, and since the relaxation improves overlap while
      // the anisotropy worsens it the two would partly cancel and the table
      // would understate both. Strength is the only thing that varies here.
      alignPoints(ctx, sx, sy, { field, strength: s, iterations: 12, spacing });
      const lines = [];
      for (let i = 0; i < sx.length; i++) lines.push(dotPath(sx[i], sy[i], rDot, ctx.w));
      const laid = 1 - meanOf(renderForTest(ctx, lines));
      const predicted = (count * Math.PI * rDot * rDot) / area;
      const lost = predicted - laid;
      say(`<tr><td>${num(K, 2)}</td><td>${num(s, 2)}</td><td>${count}</td>` +
          `<td>${num(spacing, 2)}</td><td>${num(cap, 2)}</td>` +
          `<td>${num(predicted, 4)}</td><td>${num(laid, 4)}</td>` +
          `<td>${lost >= 0 ? '+' : ''}${num(lost, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">REPORTED, NOT SCORED: the loss is the method’s own accepted ' +
      'overlap shortfall arriving earlier, not a defect this pass introduces, and ' +
      'a threshold would only encode how much these three densities happen to ' +
      'produce. What to read — loss must be POSITIVE everywhere, since no ' +
      'arrangement of a fixed number of equal dots can lay more ink than the same ' +
      'dots laid apart, so a negative entry is a real fault. It should grow with ' +
      'strength, and grow faster in the rows where the cap has fallen toward 1. ' +
      'The strength-0 row is the RELAXED isotropic baseline for its density — ' +
      'same twelve iterations, identity metric — so the difference down each ' +
      'block is the anisotropy’s own cost with the relaxation’s benefit already ' +
      'included in every row. The section below is where the relaxation’s ' +
      'contribution is measured separately.</p>');
}

// ------------------------------------------- the finding the broken test made
// KEPT, because it is worth more than the test that produced it by accident. With
// the metric inert on a flat field, the only thing the pass was doing was plain
// isotropic Lloyd -- and it cut the overlap shortfall hard:
//
//     tone 0.30   +0.0576 -> +0.0125     4.6x
//     tone 0.55   +0.0108 -> +0.0003      36x
//     tone 0.80   +0.0025 -> -0.0001
//
// The drawing gets DARKER, which is the right direction: blue noise still leaves
// close pairs, Lloyd evens the spacing toward a centroidal tessellation, fewer
// dots overlap and more of the ink the budget counted reaches the paper. That is
// a real improvement to the oldest known weakness in this method -- the header's
// "shortfall at high density is accepted" -- and it needs no anisotropy at all.
//
// It was unreachable while the pass was gated on strength; the gate is now the
// iteration count, so `Relaxation` at strength 0 asks for exactly this.
say('<h2>Anisotropic alignment — the isotropic relaxation is worth having alone</h2>');
say('<p class="note">Same points, same count, strength 0 so the metric is null ' +
    'and the distance is plain Euclidean. This is the effect the flat-field ' +
    'version of the test above was measuring when it thought it was measuring ' +
    'anisotropy — and it is why the iteration count, not the strength, is the ' +
    'control that switches the pass on.</p>');
{
  const ctx = prepare(makeImage(320, 320, 1), settings);
  const area = ctx.nx * ctx.ny;
  const rDot = Math.max(ctx.w / 2, 1.5 * ctx.w);
  const field = new Float64Array(area).fill(1);
  say('<table><tr><th>coverage</th><th>relax steps</th><th>laid ink</th>' +
      '<th>predicted</th><th>lost</th></tr>');
  for (const K of [0.2, 0.45, 0.7]) {
    const count = Math.round((K * area) / (Math.PI * rDot * rDot));
    const spacing = Math.sqrt(area / count);
    const seed0 = bestCandidatePoints(ctx, { field, count, seed: 1 });
    const predicted = (count * Math.PI * rDot * rDot) / area;
    for (const iters of [0, 4, 12]) {
      const sx = Float64Array.from(seed0.sx), sy = Float64Array.from(seed0.sy);
      // strength 0 would short-circuit alignPoints, so this drives relaxSeeds
      // through the same damped path with a metric of exactly the identity.
      // strength 0: the metric is null and relaxSeeds takes nearestSeedMap's
      // Euclidean path, damped and clamped. This is now an ordinary call rather
      // than the identity-metric contrivance an earlier version needed.
      if (iters > 0) {
        alignPoints(ctx, sx, sy, { field, strength: 0, iterations: iters, spacing });
      }
      const lines = [];
      for (let i = 0; i < sx.length; i++) lines.push(dotPath(sx[i], sy[i], rDot, ctx.w));
      const laid = 1 - meanOf(renderForTest(ctx, lines));
      say(`<tr><td>${num(K, 2)}</td><td>${iters}</td><td>${num(laid, 4)}</td>` +
          `<td>${num(predicted, 4)}</td>` +
          `<td>${num(predicted - laid, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say('<p class="note">If the loss falls steeply from 0 to 4 steps and then ' +
      'flattens, an isotropic polish is close to free tone accuracy and belongs ' +
      'on its own control rather than behind the alignment slider.</p>');
}

// ------------------------------------------------------------------ convergence
// Anisotropic Lloyd is not guaranteed to converge -- the metric is frozen per run
// precisely so that it is a genuine descent step, but the cells can still be
// non-convex and a site can oscillate between two of them. Three numbers rather
// than one, because `worst` alone cannot tell a few oscillators from a wholesale
// failure to settle.
say('<h2>Anisotropic alignment — does the relaxation settle?</h2>');
say('<p class="note">Movement per iteration on a grating. Oscillators look like ' +
    'worst plateauing while mean falls and nAbove stays small; a genuine failure ' +
    'is all three flat.</p>');
{
  const ctx = prepare(grating(360, 270, Math.PI / 5), settings);
  say('<table><tr><th>strength</th><th>iters run</th><th>worst</th>' +
      '<th>mean</th><th>n above tol</th></tr>');
  for (const s of [0.5, 1]) {
    const args = {
      ...ctx, dDotW: 3, placer: 'bestCandidate', seed: 1,
      anisotropy: s, alignIter: 16,
    };
    const res = stipplePlacement(args, 1.5 * ctx.w);
    const t = res.trace;
    say(`<tr><td>${num(s, 2)}</td><td>${t.worst.length}</td>` +
        `<td>${t.worst.map((v) => num(v, 2)).join(', ')}</td>` +
        `<td>${t.mean.map((v) => num(v, 2)).join(', ')}</td>` +
        `<td>${t.nAbove.join(', ')}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">A run that stops short of its iteration count hit ' +
      'SETTLE_TOL and converged. Damping is 0.5 and the step is capped at a third ' +
      'of a spacing, so the per-iteration numbers are bounded by construction — ' +
      'what matters is whether they fall.</p>');
}

}
