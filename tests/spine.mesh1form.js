// New with the stripesFromTris port; not sliced from the pre-split harness.
//
// mesh1form is tested BEFORE anything draws with it, because it is the piece the
// whole method rests on and its failures are silent: a 1-form that is not closed
// produces a picture that merely looks a bit wrong, and by then the cause could
// be anywhere from the field to the chaining.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { stipplePoints, perimeterPoints } from '../src/spine/points.js';
import { triangulate } from '../src/spine/delaunay.js';
import { buildMesh, orientField, roundToClosed, curlOf } from '../src/spine/mesh1form.js';
import { say, num, flat } from './runner.js';

const small = { ...flat, drawingWidth: 5 };

/** A mesh over relaxed points, with the ring so the hull is the page. */
function testMesh(ctx, nPts, seed = 1) {
  const uniform = new Float64Array(ctx.nx * ctx.ny).fill(1);
  const ring = perimeterPoints(ctx, uniform, nPts);
  const { sx, sy } = stipplePoints(ctx, {
    field: uniform, count: nPts, seeds0: ring, seed, iterations: 6, polish: 10,
  });
  const { tris, n: nT } = triangulate(sx, sy);
  return { sx, sy, tris, nT, mesh: buildMesh(tris, nT) };
}

export function run() {

// ------------------------------------------------------------ incidence
// EULER AGAIN, and it is worth spending four lines on because everything below
// indexes through these arrays. The one that matters most is the last column: a
// shared edge MUST have opposite faceSign in its two faces, because they walk it
// in opposite directions. That single fact is what makes curl conserved and the
// flow in roundToClosed a flow at all -- if it ever failed, adding to an edge
// would raise both faces' curl instead of moving it between them.
say('<h2>mesh1form — edge incidence</h2>');
say('<p class="note">Edge count against Euler, and the sign convention the flow ' +
    'depends on. A shared edge is traversed one way by one face and the other ' +
    'way by the other, so its two faceSign entries must differ.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  say('<table><tr><th>points</th><th>faces</th><th>edges</th>' +
      '<th>expected 3n−3−h</th><th>interior / boundary</th>' +
      '<th>signs opposite</th></tr>');
  let allOk = true;
  for (const nPts of [200, 600]) {
    const { sx, tris, nT, mesh } = testMesh(ctx, nPts);
    const n = sx.length;
    let interior = 0, boundary = 0;
    for (let e = 0; e < mesh.nE; e++) {
      if (mesh.eFaceB[e] >= 0) interior++; else boundary++;
    }
    // hull size from the triangulation itself: edges with one face
    const predEdges = 3 * n - 3 - boundary;
    // the sign convention
    let bad = 0;
    for (let e = 0; e < mesh.nE; e++) {
      const a = mesh.eFaceA[e], b = mesh.eFaceB[e];
      if (b < 0) continue;
      let sa = 0, sb = 0;
      for (let k = 0; k < 3; k++) {
        if (mesh.faceEdge[3 * a + k] === e) sa = mesh.faceSign[3 * a + k];
        if (mesh.faceEdge[3 * b + k] === e) sb = mesh.faceSign[3 * b + k];
      }
      if (sa + sb !== 0) bad++;
    }
    const ok = mesh.nE === predEdges && bad === 0;
    allOk = allOk && ok;
    say(`<tr><td>${n}</td><td>${nT}</td>` +
        `<td class="${mesh.nE === predEdges ? 'pass' : 'fail'}">${mesh.nE}</td>` +
        `<td>${predEdges}</td><td>${interior} / ${boundary}</td>` +
        `<td class="${bad === 0 ? 'pass' : 'fail'}">${bad === 0 ? 'yes' : `${bad} WRONG`}</td></tr>`);
  }
  say('</table>');
  say(`<p>incidence is consistent — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(the sign column is ` +
      `the load-bearing one: curl is only conserved because a shared edge counts ` +
      `oppositely in its two faces, and every flip below assumes it)</span></p>`);
}

// ------------------------------------------------------ orienting a line field
// A LINE FIELD CANNOT ALWAYS BE GIVEN ARROWS, and where it cannot is exactly
// where a stripe has to end. This is the piece most likely to be wrong, so it is
// scored against fields whose defect count is known in advance rather than
// against itself.
//
//   constant, and a smooth gradient  -- no winding anywhere, so ZERO defects
//   theta = atan2(y,x)/2             -- the classic half-index singularity: go
//                                       once round the centre and the line comes
//                                       back to itself with its arrow reversed,
//                                       so no assignment of arrows can work in
//                                       any ring enclosing it. Expect the
//                                       defects to be FEW and CENTRAL.
say('<h2>mesh1form — can the orientation be lifted?</h2>');
say('<p class="note">Frustration is the winding of the orientation round one ' +
    'face, measured on six alternating samples — vertex, midpoint, vertex … — ' +
    'each step lifted into (−π/2, π/2]. Smooth field: 0. Half-index ' +
    'singularity: ±π. Six and not three, because three midpoints only enclose ' +
    'the medial triangle and miss a defect sitting in a corner.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const { sx, sy, tris, nT, mesh } = testMesh(ctx, 600);
  const mid = (e) => {
    const a = mesh.eLo[e], b = mesh.eHi[e];
    return [(sx[a] + sx[b]) / 2, (sy[a] + sy[b]) / 2];
  };
  const cx = ctx.nx / 2, cy = ctx.ny / 2;
  const cases = [
    ['constant', () => 0.4, 0],
    ['smooth gradient', (x, y) => 0.6 * (x / ctx.nx), 0],
    ['half-index defect', (x, y) => 0.5 * Math.atan2(y - cy, x - cx), null],
  ];
  say('<table><tr><th>field</th><th>faces</th><th>defects</th>' +
      '<th>expected</th><th>mean distance from centre</th></tr>');
  let allOk = true;
  for (const [name, fn, want] of cases) {
    const eTheta = new Float64Array(mesh.nE);
    for (let e = 0; e < mesh.nE; e++) {
      const [x, y] = mid(e);
      eTheta[e] = fn(x, y);
    }
    // Vertices as well as midpoints: the winding round a face is measured on
    // six alternating samples, because three midpoints alone only enclose the
    // medial triangle and miss a singularity sitting in a corner.
    const vTheta = new Float64Array(sx.length);
    for (let i = 0; i < sx.length; i++) vTheta[i] = fn(sx[i], sy[i]);
    const { defect, nDefect } = orientField(eTheta, vTheta, mesh);
    // where are they?
    let dSum = 0, dN = 0;
    for (let f = 0; f < nT; f++) {
      if (!defect[f]) continue;
      const a = tris[3 * f], b = tris[3 * f + 1], c = tris[3 * f + 2];
      const fx = (sx[a] + sx[b] + sx[c]) / 3, fy = (sy[a] + sy[b] + sy[c]) / 3;
      dSum += Math.hypot(fx - cx, fy - cy); dN++;
    }
    const meanR = dN > 0 ? dSum / dN : NaN;
    // the half-index case has no exact count, but it must be a handful and
    // central: a defect far from the singularity would mean the frustration
    // test is firing on ordinary geometry
    const ok = want === null
      ? (nDefect > 0 && nDefect < nT / 20 && meanR < ctx.nx / 6)
      : nDefect === want;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td><td>${nT}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${nDefect}</td>` +
        `<td>${want === null ? 'few, central' : want}</td>` +
        `<td>${num(meanR, 1)} px</td></tr>`);
  }
  say('</table>');
  say(`<p>orientation lifts where it can — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(a nonzero count on ` +
      `the first two rows means the frustration test is firing on ordinary ` +
      `geometry rather than on winding, which would scatter forced stripe ends ` +
      `across a perfectly well-behaved picture)</span></p>`);
}

// --------------------------------------------------------- closing the form
// THE CENTRAL CLAIM. Round independently and about a third of faces carry a curl
// of +-1, each one a stripe with nowhere to go. roundToClosed moves that curl
// around the dual graph until it cancels, or pays to keep it.
//
// Scored as exact counting -- curl is an integer sum of integers, so "closed"
// admits no tolerance.
say('<h2>mesh1form — does rounding close the form?</h2>');
say('<p class="note">A smooth phase gives real crossings per edge whose signed ' +
    'sum round every face is exactly zero. Independent rounding breaks that; ' +
    'this is how much of it comes back. The <b>before</b> column is what a plain ' +
    'round() leaves, and is the thing the source ships.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const { sx, sy, mesh } = testMesh(ctx, 600);
  // A phase with a known gradient: phi = (x cos t + y sin t)/L. Its edge
  // integrals are exactly differences of phi at the endpoints, so the true
  // signed sum round any face is zero by construction -- the test rests on
  // arithmetic rather than on the field being nice.
  const phaseAt = (x, y, L) => (x * Math.cos(0.4) + y * Math.sin(0.4)) / L;
  say('<table><tr><th>spacing L</th><th>faces</th><th>open before</th>' +
      '<th>open after</th><th>cleared</th><th>Σ|Δm|</th></tr>');
  let allOk = true;
  for (const L of [6, 10, 18]) {
    const g = new Float64Array(mesh.nE);
    for (let e = 0; e < mesh.nE; e++) {
      const a = mesh.eLo[e], b = mesh.eHi[e];
      g[e] = phaseAt(sx[b], sy[b], L) - phaseAt(sx[a], sy[a], L);
    }
    const m0 = new Int32Array(mesh.nE);
    for (let e = 0; e < mesh.nE; e++) m0[e] = Math.round(g[e]);
    let before = 0;
    for (let f = 0; f < mesh.nT; f++) if (curlOf(m0, mesh, f) !== 0) before++;

    const { m, nOpen } = roundToClosed(g, mesh, { defectPrice: 4 });
    let moved = 0;
    for (let e = 0; e < mesh.nE; e++) moved += Math.abs(m[e] - m0[e]);

    // With a genuinely integrable phase and a generous defect price, nothing
    // should be left open at all.
    const ok = nOpen === 0;
    allOk = allOk && ok;
    say(`<tr><td>${L}</td><td>${mesh.nT}</td><td>${before}</td>` +
        `<td class="${ok ? 'pass' : 'fail'}">${nOpen}</td>` +
        `<td>${num(1 - nOpen / Math.max(1, before), 3)}</td><td>${moved}</td></tr>`);
  }
  say('</table>');
  say(`<p>the form closes — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(exact counting, no ` +
      `tolerance: curl is an integer. This phase is integrable everywhere, so ` +
      `every open face is a rounding artefact and all of them should go. Note ` +
      `the phase is a linear ramp, so its net flux through the boundary is ` +
      `<b>not</b> zero: some curl has to leave through the page edge, and a ` +
      `residue here means it had nowhere to go.)</span></p>`);
}

// ------------------------------------------------- what the defect price buys
// The control, measured rather than asserted. Low price: dislocations are cheap,
// so spacing stays close to what the tone asked for. High price: the flow works
// harder, bends the spacing, and leaves fewer stripe ends.
say('<h2>mesh1form — the defect price, swept</h2>');
say('<p class="note">One number trades stripe ends against spacing accuracy. ' +
    'Σ|Δm| is how far the integers were dragged from their rounded values, which ' +
    'is the spacing error the drawing will carry.</p>');
{
  const ctx = prepare(makeImage(400, 400, 0.5), small);
  const { sx, sy, mesh } = testMesh(ctx, 600);
  // a phase that is NOT integrable: a half-index defect at the centre, so some
  // faces can never be closed however much is paid
  const cx = ctx.nx / 2, cy = ctx.ny / 2;
  const eTheta = new Float64Array(mesh.nE);
  for (let e = 0; e < mesh.nE; e++) {
    const a = mesh.eLo[e], b = mesh.eHi[e];
    const x = (sx[a] + sx[b]) / 2, y = (sy[a] + sy[b]) / 2;
    eTheta[e] = 0.5 * Math.atan2(y - cy, x - cx);
  }
  const vTheta = new Float64Array(sx.length);
  for (let i = 0; i < sx.length; i++) {
    vTheta[i] = 0.5 * Math.atan2(sy[i] - cy, sx[i] - cx);
  }
  const { sign, defect, nDefect } = orientField(eTheta, vTheta, mesh);
  const g = new Float64Array(mesh.nE);
  for (let e = 0; e < mesh.nE; e++) {
    const a = mesh.eLo[e], b = mesh.eHi[e];
    const dx = sx[b] - sx[a], dy = sy[b] - sy[a];
    const th = eTheta[e] * 1 + (sign[e] < 0 ? Math.PI : 0);
    g[e] = (dx * Math.cos(th) + dy * Math.sin(th)) / 9;
  }
  say('<table><tr><th>defect price</th><th>stripe ends left</th>' +
      '<th>forced by the field</th><th>Σ|Δm|</th></tr>');
  for (const price of [0.1, 0.5, 1, 2, 8]) {
    const { m, nOpen } = roundToClosed(g, mesh, { defectPrice: price, defect });
    const m0 = new Int32Array(mesh.nE);
    for (let e = 0; e < mesh.nE; e++) m0[e] = Math.round(g[e]);
    let moved = 0;
    for (let e = 0; e < mesh.nE; e++) moved += Math.abs(m[e] - m0[e]);
    say(`<tr><td>${num(price, 2)}</td><td>${nOpen}</td><td>${nDefect}</td>` +
        `<td>${moved}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">No verdict — this sets a default rather than checking ' +
      'one. Stripe ends must fall as the price rises and Σ|Δm| must climb; if ' +
      'neither moves, the price is not reaching the flow. The count should not ' +
      'fall below the <b>forced</b> column, because those faces enclose a real ' +
      'singularity and no amount of paying can close them.</p>');
}

}
