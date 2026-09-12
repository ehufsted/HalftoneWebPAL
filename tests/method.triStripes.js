// New with the stripesFromTris port; not sliced from the pre-split harness.
//
// mesh1form is already tested on its own (tests/spine.mesh1form.js) and the
// lattice on its own (tests/method.planeWaves.js), so nothing here re-checks the
// 1-form. These are the claims that only exist once the integers become a
// drawing: that the matching is valid, that chaining conserves length, and that
// the tone lands where the ladder says.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { pathLength } from '../src/spine/geometry.js';
import triStripes, { stripeChains, matchNodes } from '../src/methods/triStripes.js';
import { say, num, flat, linearRamp, runToneTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

export function run() {

// ------------------------------------------------------------- the matching
// A UNIT TEST ON THE STACK MATCHER, before it is trusted on a real mesh. The
// sequences are hand-written so the answer is known by inspection, including the
// two that used to need separate cases in the source.
say('<h2>triStripes — the stack matcher</h2>');
say('<p class="note">Balanced-parenthesis matching over signed crossings. The ' +
    'chords it returns must be non-crossing: for nodes numbered in boundary ' +
    'order, no two chords (a,b) and (c,d) may interleave as a &lt; c &lt; b &lt; d. ' +
    'Two crossing chords in one triangle would be two stripes intersecting, and ' +
    'stripes are level sets of a single function.</p>');
{
  const cases = [
    ['+-',       [1, -1],                 1, 0],
    ['+-+-',     [1, -1, 1, -1],          2, 0],
    ['++--',     [1, 1, -1, -1],          2, 0],
    ['+--+',     [1, -1, -1, 1],          2, 0],
    ['+++---',   [1, 1, 1, -1, -1, -1],   3, 0],
    ['+ (open)', [1],                     0, 1],
    ['++ (open)',[1, 1],                  1, 0],
    ['++-',      [1, 1, -1],              1, 1],
  ];
  say('<table><tr><th>signs</th><th>chords</th><th>expected</th>' +
      '<th>unmatched</th><th>expected</th><th>non-crossing</th></tr>');
  let allOk = true;
  for (const [name, signs, wantPairs, wantOpen] of cases) {
    const nodes = signs.map((s, i) => ({ id: i, sign: s }));
    const { pairs, open } = matchNodes(nodes);
    let cross = 0;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [a, b] = pairs[i].slice().sort((p, q) => p - q);
        const [c, d] = pairs[j].slice().sort((p, q) => p - q);
        if (a < c && c < b && b < d) cross++;
        if (c < a && a < d && d < b) cross++;
      }
    }
    const ok = pairs.length === wantPairs && open.length === wantOpen && cross === 0;
    allOk = allOk && ok;
    say(`<tr><td>${name}</td>` +
        `<td class="${pairs.length === wantPairs ? 'pass' : 'fail'}">${pairs.length}</td>` +
        `<td>${wantPairs}</td>` +
        `<td class="${open.length === wantOpen ? 'pass' : 'fail'}">${open.length}</td>` +
        `<td>${wantOpen}</td>` +
        `<td class="${cross === 0 ? 'pass' : 'fail'}">${cross === 0 ? 'yes' : `${cross} CROSS`}</td></tr>`);
  }
  say('</table>');
  say(`<p>the matcher is valid — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(<code>++--</code> is ` +
      `nested and <code>+-+-</code> sequential; the source needed different code ` +
      `paths for those, and here they are the same three lines)</span></p>`);
}

// -------------------------------------------------- the matching, on a mesh
// EVERY NODE IS USED, AND EVERY NODE THAT IS NOT IS ACCOUNTED FOR. A node is a
// point where a stripe crosses a mesh edge. An interior edge is shared by two
// faces, so its nodes should collect exactly two chords -- one from each side --
// and that is the same statement as "the stripe continues across the edge".
say('<h2>triStripes — is every crossing accounted for?</h2>');
say('<p class="note">Σ|residual| over faces is what roundToClosed says it left ' +
    'open. The number of unmatched nodes must equal it exactly — a node left ' +
    'loose anywhere else is a chaining bug, and would draw as a stripe that ' +
    'stops for no reason.</p>');
{
  say('<table><tr><th>mesh</th><th>faces</th><th>nodes</th><th>chords</th>' +
      '<th>Σ|residual|</th><th>unmatched nodes</th><th>node degree ≤ 2</th></tr>');
  let allOk = true;
  for (const meshKind of ['delaunay', 'trilattice']) {
    const ctx = prepare(linearRamp(400, 300), settings);
    const built = stripeChains({ ...ctx, meshKind, meshSizeW: 18, LminW: 2, LmaxW: 30 });
    const { mesh, m, residual, nT, nNodes, chords, nOpenNodes } = built;
    let resid = 0;
    for (let f = 0; f < nT; f++) resid += Math.abs(residual[f]);
    // degree of every node
    const deg = new Int32Array(nNodes);
    for (const [a, b] of chords) { deg[a]++; deg[b]++; }
    let over = 0;
    for (let i = 0; i < nNodes; i++) if (deg[i] > 2) over++;
    const ok = nOpenNodes === resid && over === 0;
    allOk = allOk && ok;
    say(`<tr><td>${meshKind}</td><td>${nT.toLocaleString()}</td>` +
        `<td>${nNodes.toLocaleString()}</td><td>${chords.length.toLocaleString()}</td>` +
        `<td>${resid}</td>` +
        `<td class="${nOpenNodes === resid ? 'pass' : 'fail'}">${nOpenNodes}</td>` +
        `<td class="${over === 0 ? 'pass' : 'fail'}">${over === 0 ? 'yes' : `${over} OVER`}</td></tr>`);
  }
  say('</table>');
  say(`<p>crossings balance — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(a node with three ` +
      `chords would mean an edge was walked by three faces, which buildMesh's ` +
      `incidence already forbids — it is checked here because the consequence ` +
      `would be a silently wrong drawing rather than an error)</span></p>`);
}

// ---------------------------------------------------- conservation on chaining
// THE CHECK THAT CAUGHT THE TREE'S MISSING BRANCHES. Chaining is a pure
// restructuring: it turns a bag of chords into polylines and must not create or
// destroy a single millimetre. Total polyline length has to equal the total
// chord length, and every chord has to appear once.
//
// This is stated as a conserved quantity precisely because the failure it
// catches is invisible: treeEdges lost every branch edge -- a quarter of the
// drawing -- and looked like a plausible picture until this number disagreed.
say('<h2>triStripes — does chaining conserve the drawing?</h2>');
say('<p class="note">Σ chain length against Σ chord length, before any ' +
    'clipping. Exact arithmetic over the same segments in a different order, so ' +
    'the tolerance is 1e-9 relative.</p>');
{
  say('<table><tr><th>mesh</th><th>chords</th><th>chains</th>' +
      '<th>Σ chord length</th><th>Σ chain length</th><th>relative error</th>' +
      '<th>segments</th></tr>');
  let allOk = true;
  for (const meshKind of ['delaunay', 'trilattice']) {
    const ctx = prepare(linearRamp(400, 300), settings);
    const built = stripeChains({ ...ctx, meshKind, meshSizeW: 18, LminW: 2, LmaxW: 30 });
    const { chains, chords, chordLength: want } = built;
    let got = 0, nSeg = 0;
    for (const ch of chains) { got += pathLength([ch]); nSeg += ch.length - 1; }
    // Every chord must appear exactly once as a polyline segment. A closed loop
    // repeats its first point to close, which adds the one segment that chord
    // accounts for, so the count is exact either way.
    const okCount = nSeg === chords.length;
    const err = want > 0 ? Math.abs(got - want) / want : 0;
    const ok = okCount && err < 1e-9;
    allOk = allOk && ok;
    say(`<tr><td>${meshKind}</td><td>${chords.length.toLocaleString()}</td>` +
        `<td>${chains.length.toLocaleString()}</td><td>${num(want, 3)}</td>` +
        `<td>${num(got, 3)}</td>` +
        `<td class="${err < 1e-9 ? 'pass' : 'fail'}">${num(err, 12)}</td>` +
        `<td class="${okCount ? 'pass' : 'fail'}">${nSeg.toLocaleString()}` +
        `${okCount ? '' : ` ≠ ${chords.length}`}</td></tr>`);
  }
  say('</table>');
  say(`<p>chaining conserves the drawing — <span class="${allOk ? 'pass' : 'fail'}">` +
      `${allOk ? 'PASS' : 'FAIL'}</span> <span class="note">(the segment count ` +
      `is the sharper half: a length match with too few segments would mean a ` +
      `chord was drawn twice and another dropped)</span></p>`);
}

// ------------------------------------------------------------------- tone
// THE PREDICTION WAS kappa ABOVE 1, AND IT WAS WRONG -- measured 0.98 to 1.02
// across six rows, centred on 1 rather than sitting above it.
//
// The reasoning was that stripes bend within a face to reach their neighbours'
// nodes and hairpins add length covering no new area, both of which raise drawn
// length per unit area above the ideal 1/L. Both effects are real; they are just
// smaller than the rounding jitter they compete with, because rounding a
// crossing count perturbs the local spacing in BOTH directions and those
// perturbations are what dominate at this mesh size. So the honest statement is
// that the integer constraint costs nothing measurable in ink: kappa = 1 to
// within 2%, and the check is a band around 1.
//
// Which way an out-of-band kappa falls still says which bug it is. Above:
// stripes wandering, hairpins multiplying. Below: stripes MISSING.
say('<h2>triStripes — drawn length against the ladder</h2>');
say('<p class="note">On a flat field the whole drawing should be stripes at one ' +
    'spacing L, so length per unit area is κ/L. κ is reported, not fitted: ' +
    'nothing downstream uses it yet, and its value is the measurement.</p>');
{
  say('<table><tr><th>mesh</th><th>tone</th><th>L (px)</th><th>length</th>' +
      '<th>area</th><th>predicted length</th><th>κ</th></tr>');
  let worst = 0, below = 0;
  for (const meshKind of ['delaunay', 'trilattice']) {
    for (const tone of [0.3, 0.55, 0.8]) {
      const ctx = prepare(makeImage(400, 300, tone), settings);
      const args = { ...ctx, meshKind, meshSizeW: 18, LminW: 2, LmaxW: 30 };
      // The spacing this tone asks for, from the RAW value through the ladder as
      // documented. An earlier version of this line put the remapped brightness
      // in instead -- the same mistake the method had -- so the table compared
      // the code against a restatement of itself and passed while the ramp was
      // 23% out. The prediction has to be derivable without reading the method.
      const w = ctx.w;
      const Lmin = Math.max(w, 2 * w), Lmax = Math.max(Lmin * 1.5, 30 * w);
      const L = 1 / (1 / Lmin + tone * (1 / Lmax - 1 / Lmin));
      const lines = triStripes.run(args);
      const len = pathLength(lines);
      const area = ctx.nx * ctx.ny;
      const pred = area / L;
      const kappa = pred > 0 ? len / pred : NaN;
      const rowOk = Math.abs(kappa - 1) < 0.05;
      if (!rowOk) below++;
      worst = Math.max(worst, Math.abs(kappa - 1));
      say(`<tr><td>${meshKind}</td><td>${num(tone, 2)}</td><td>${num(L, 2)}</td>` +
          `<td>${num(len, 0)}</td><td>${num(area, 0)}</td><td>${num(pred, 0)}</td>` +
          `<td class="${rowOk ? 'pass' : 'fail'}">${num(kappa, 4)}</td></tr>`);
    }
  }
  say('</table>');
  say(`<p>κ = 1 within 5% — <span class="${below === 0 ? 'pass' : 'fail'}">` +
      `${below === 0 ? 'PASS' : 'FAIL'}</span> (worst departure ${num(worst, 4)}). ` +
      `<span class="note">The integer continuity condition costs no measurable ` +
      `ink: bending and hairpins are real but smaller than the two-sided jitter ` +
      `from rounding the crossing counts. L here is derived from the raw tone ` +
      `through the documented ladder, NOT from the method — that independence is ` +
      `the point, and its absence is what let a 23% ramp error pass this ` +
      `table.</span></p>`);
}

// --------------------------------------------------------- the defect price
// The control, on a real image rather than a synthetic singularity. Measured,
// not asserted: this is what tells the user what the slider does.
say('<h2>triStripes — the stripe-end control, on a real field</h2>');
say('<p class="note">Higher price buys continuity by bending the spacing. Stripe ' +
    'ends must fall and drawn length must change; if neither moves, the control ' +
    'is not reaching the flow.</p>');
{
  say('<table><tr><th>price</th><th>open faces</th><th>forced by the field</th>' +
      '<th>chains</th><th>mean chain length</th><th>total length</th></tr>');
  for (const price of [0.2, 1, 4]) {
    const ctx = prepare(linearRamp(400, 300), settings);
    const args = { ...ctx, meshKind: 'delaunay', meshSizeW: 18, LminW: 2, LmaxW: 30, defectPrice: price };
    const built = stripeChains(args);
    let len = 0;
    for (const ch of built.chains) len += pathLength([ch]);
    say(`<tr><td>${num(price, 1)}</td><td>${built.nOpen}</td>` +
        `<td>${built.nDefect}</td><td>${built.chains.length.toLocaleString()}</td>` +
        `<td>${num(len / Math.max(1, built.chains.length), 1)}</td>` +
        `<td>${num(len, 0)}</td></tr>`);
  }
  say('</table>');
  say('<p class="note">No verdict — this sets expectations for the slider. Mean ' +
      'chain length is the honest measure of what the control buys: fewer, ' +
      'longer strokes is the whole point of an integer continuity condition, and ' +
      'is what separates this from planeWaves, whose stripes stop at every seam.</p>');
}

// ------------------------------------------------------------------ tone ramps
runToneTest('triStripes — Delaunay mesh, ramp',
  triStripes, linearRamp(400, 300),
  { meshKind: 'delaunay', meshSizeW: 18, LminW: 2, LmaxW: 30 }, settings);

runToneTest('triStripes — triangular lattice, ramp',
  triStripes, linearRamp(400, 300),
  { meshKind: 'trilattice', meshSizeW: 18, LminW: 2, LmaxW: 30 }, settings);

runToneTest('triStripes — cross stripes, ramp',
  triStripes, linearRamp(400, 300),
  { meshKind: 'delaunay', meshSizeW: 18, LminW: 2, LmaxW: 30, crossStripes: true }, settings);

}
