// New with the dashed-hatching method; not sliced from the pre-split harness.
//
// THE PREDICTIONS ARE STATED HERE BEFORE ANY OF THEM WAS RUN, which is the point
// of the practice docs/findings.md argues for. Nothing below is fitted, and every
// number in the method is either the pen width or a consequence of the stadium
// area, so a failing row means the model is wrong rather than a constant needing
// a nudge.
//
// The four claims under test, in the order they would break:
//
//   1. COVERAGE IS THE DARKNESS, exactly. The marks are placed by an integral of
//      ink owed, so the count is correct by construction and the ratio of
//      rendered to requested coverage should be 1.000 with nothing to tune.
//   2. THE CAPS ARE NOT OPTIONAL. Charging d*w instead of d*w + pi*w^2/4 should
//      over-ink by pi*w/(4d) -- 20% at d = w, 6% at d = 4w. The rig computes what
//      the naive model would have predicted, so the row shows the error the cap
//      term is there to remove.
//   3. TONE IS INDEPENDENT OF DASH LENGTH, and lift count goes as 1/d. This is
//      the claim that makes the dash-length slider a plot-time control rather
//      than a tone control, and it is the one worth failing loudly.
//   4. THE BAND IS THE SOLID CARRIER. Below 1 - w/L the method saturates, should
//      report a note, and must come out light rather than dark -- over-inking
//      would mean the abutment charge is wrong.

import { makeImage } from '../src/shim/image.js';
import { prepare } from '../src/spine/units.js';
import { meanOf } from '../src/shim/image.js';
import { takeNote } from '../src/spine/notes.js';
import { optimizeOrder, joinCoincidentLines } from '../src/spine/pathOptimizer.js';
import dashHatching, { toneBand } from '../src/methods/dashHatching.js';
import { say, num, flat, linearRamp, runToneTest, renderForTest } from './runner.js';

const settings = { ...flat, drawingWidth: 12 };

/** A flat field at brightness v, run at the given params. */
function runFlat(v, params, W = 360) {
  const ctx = prepare(makeImage(W, W, v), settings);
  const args = { ...ctx, ...params };
  takeNote();
  const lines = dashHatching.run(args);
  const note = takeNote();
  const rendered = 1 - meanOf(renderForTest(ctx, lines));
  return { ctx, args, lines, rendered, note };
}

export function run() {

// --------------------------------------------------- coverage is the darkness
// THE CENTRAL CLAIM, and the cheapest one to check: on a flat field the rendered
// ink must equal the coverage the target asks for. Both ends of the band are
// excluded -- white lays nothing and has no ratio, and the saturated end is
// section four's business.
say('<h2>Dashed hatching — is coverage the darkness, exactly?</h2>');
say('<p class="note">Flat fields at a 6×pen spacing, so the band floor is ' +
    '1 − 1/6 = 0.833 and everything below it saturates. Predicted coverage is ' +
    'the target brightness subtracted from one, with no constant anywhere in it. ' +
    'The naive column is what the same run would have predicted if a dash were ' +
    'charged as a rectangle — the cap term is the difference.</p>');
{
  const P = { spacingW: 6, dashW: 6 };
  const ctx0 = prepare(makeImage(64, 64, 0.5), settings);
  const band = toneBand({ ...ctx0, ...P });
  // A PERFECT METHOD DOES NOT READ 1.0, and the gap is a convention rather than
  // an error. The drawing polygon is [1, nx] x [1, ny], whose geometric area is
  // (nx-1)(ny-1), while coverage is measured over nx*ny pixels -- so ink that
  // fills the polygon exactly measures (nx-1)(ny-1)/(nx*ny) of the canvas, here
  // 0.9945. Every method carries this; this is the first whose claim is tight
  // enough for half a percent to matter. It is the same half-pixel that
  // docs/architecture.md flags under "inpolygon counts on-edge points as INSIDE".
  const ctxA = prepare(makeImage(360, 360, 0.5), settings);
  const convention = ((ctxA.nx - 1) * (ctxA.ny - 1)) / (ctxA.nx * ctxA.ny);
  say(`<p class="note">band [${num(band.min, 4)}, ${num(band.max, 4)}] ` +
      `at w = ${num(ctx0.w, 2)} px; a polygon-filling method reads ` +
      `${num(convention, 5)} of the canvas, so that is the ratio to expect</p>`);

  say('<table><tr><th>image B</th><th>target B</th><th>requested K</th>' +
      '<th>rendered K</th><th>ratio</th><th>naive ratio</th></tr>');
  let worst = 0;
  for (const v of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const { ctx, args, rendered } = runFlat(v, P);
    const tB = dashHatching.targetImage(args);
    const requested = 1 - meanOf(tB);
    // What the same dash count would have covered if the caps were free: the
    // model would have laid (1 + pi*w/(4d)) times the ink it meant to.
    const naive = rendered * (1 + (Math.PI * ctx.w) / (4 * (6 * ctx.w)));
    const ratio = requested > 0 ? rendered / (requested * convention) : 1;
    if (requested > 0.02) worst = Math.max(worst, Math.abs(ratio - 1));
    say(`<tr><td>${num(v, 2)}</td><td>${num(1 - requested, 3)}</td>` +
        `<td>${num(requested, 4)}</td><td>${num(rendered, 4)}</td>` +
        `<td>${num(ratio, 4)}</td>` +
        `<td>${num(requested > 0 ? naive / requested : 1, 4)}</td></tr>`);
  }
  say('</table>');
  const ok = worst < 0.02;
  say(`<p>coverage is the darkness — <span class="${ok ? 'pass' : 'fail'}">` +
      `${ok ? 'PASS' : 'FAIL'}</span> (worst |ratio − 1| = ${num(worst, 4)}). ` +
      '<span class="note">A ratio consistently above 1 means the caps are being ' +
      'double-counted; consistently below means the abutment charge is firing ' +
      'when the dashes are not actually touching.</span></p>');
}

// --------------------------------------------- dash length does not move tone
// THE CLAIM THAT MAKES THE SLIDER A PLOT-TIME CONTROL. Ink owed is fixed by the
// image, so a longer dash must simply mean proportionally fewer of them. If tone
// drifts with dash length then the count is not compensating and the control is
// silently a tone control -- which would be much worse than not having it.
say('<h2>Dashed hatching — is tone independent of dash length?</h2>');
say('<p class="note">One flat field, one spacing, dash length swept over a ' +
    'factor of sixteen. Predicted: rendered tone constant, and the number of ' +
    'paths (which is the number of pen lifts) falling as 1/d. The last column is ' +
    'lifts × dash length, which should be flat if the compensation is exact.</p>');
{
  say('<table><tr><th>dash ×pen</th><th>paths</th><th>rendered K</th>' +
      '<th>drawn length</th><th>paths × dash</th></tr>');
  const rows = [];
  for (const dashW of [1, 2, 4, 8, 16]) {
    const { lines, rendered } = runFlat(0.6, { spacingW: 6, dashW });
    rows.push({ dashW, paths: lines.length, rendered });
    say(`<tr><td>${dashW}</td><td>${lines.length}</td>` +
        `<td>${num(rendered, 4)}</td><td>—</td>` +
        `<td>${num(lines.length * dashW, 0)}</td></tr>`);
  }
  say('</table>');
  const tones = rows.map((r) => r.rendered);
  const spread = Math.max(...tones) - Math.min(...tones);
  // Lift count times dash length is the invariant; allow a wide band because the
  // shortest dashes quantise hardest against a fixed carrier length.
  const prod = rows.map((r) => r.paths * r.dashW);
  const prodSpread = (Math.max(...prod) - Math.min(...prod)) / (prod[0] || 1);
  const ok = spread < 0.02;
  say(`<p>tone is independent of dash length — ` +
      `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ` +
      `(spread ${num(spread, 4)} over a 16× range; lifts × dash varies by ` +
      `${num(prodSpread, 3)}). <span class="note">Tone drifting UP with dash ` +
      'length would mean abutment is being charged when it should not be; drifting ' +
      'down would mean the caps are charged twice on a chain.</span></p>');
}

// ------------------------------------------------------- the band and its edge
// SATURATION MUST BE LIGHT, NOT DARK, and it must announce itself. Past the band
// floor the carrier is full: the drawing cannot get darker, so the error is
// bounded by how much was asked for and the note is the only way a user learns
// why. A saturated run that came out DARKER than solid would mean dashes are
// overlapping and being charged as if they were not.
say('<h2>Dashed hatching — what happens past the band floor?</h2>');
say('<p class="note">At a 6×pen spacing the darkest reachable tone is a solid ' +
    'carrier every 6 pens, so K cannot exceed 1/6 = 0.1667. The rows below ask ' +
    'for more than that. Predicted: rendered K pinned at the ceiling, never above ' +
    'it, and a note on every row that overflows.</p>');
{
  const ceiling = 1 / 6;
  say('<table><tr><th>image B</th><th>requested K</th><th>rendered K</th>' +
      '<th>vs ceiling</th><th>note</th></tr>');
  let anyOver = false;
  for (const v of [0.5, 0.2, 0.05, 0.0]) {
    const { args, rendered, note } = runFlat(v, { spacingW: 6, dashW: 6 });
    const requested = 1 - meanOf(dashHatching.targetImage(args));
    const over = rendered > ceiling * 1.05;
    anyOver = anyOver || over;
    say(`<tr><td>${num(v, 2)}</td><td>${num(requested, 4)}</td>` +
        `<td class="${over ? 'fail' : ''}">${num(rendered, 4)}</td>` +
        `<td>${num(rendered / ceiling, 3)}</td>` +
        `<td class="note">${note || '—'}</td></tr>`);
  }
  say('</table>');
  say(`<p>saturation stays under the ceiling — ` +
      `<span class="${anyOver ? 'fail' : 'pass'}">${anyOver ? 'FAIL' : 'PASS'}</span>. ` +
      '<span class="note">Note that the target already clamps the request into ' +
      'the band, so these rows mostly test that targetImage and run agree about ' +
      'where the floor is. They disagree if the ratio column drifts from 1.</span></p>');
}

// ----------------------------------------------------------------- the ramp
// The end-to-end check, scored against the method's own target. Two seeds run:
// the phase changes the arrangement and must not change the tone, which is the
// same argument ditherGrid's modes rest on.
runToneTest(
  'Linear ramp — dashed hatching (seed 1)',
  dashHatching,
  linearRamp(600, 200),
  { spacingW: 6, dashW: 6, dashSeed: 1 },
  settings,
);
runToneTest(
  'Linear ramp — dashed hatching (seed 7)',
  dashHatching,
  linearRamp(600, 200),
  { spacingW: 6, dashW: 6, dashSeed: 7 },
  settings,
);

// ------------------------------------------------ joining must not bend a dash
// THE REGRESSION THIS METHOD EXISTS TO CARRY. The pipeline joins paths whose ends
// fall within a tolerance, which for every method before this one meant "two ends
// of one interrupted stroke". Here the carriers are a control that floors at one
// pen width, so at a tight spacing the ends of dashes on DIFFERENT carriers came
// within the default 1.5 pen widths and were chained -- a join across the grain,
// which draws as a V. `maxJoinPens` caps the tolerance at half the spacing.
//
// The check runs the worker's own two steps and looks for a corner: every joined
// path must be straight, because the only legitimate join here is between two
// collinear dashes on one carrier.
say('<h2>Dashed hatching — does path joining ever bend a dash?</h2>');
say('<p class="note">optimizeOrder then joinCoincidentLines, at the default ' +
    'tolerance and at the spacings where the carriers are closest. Predicted: no ' +
    'joined path turns by more than a degree at any interior point, at any ' +
    'spacing. Before <code>maxJoinPens</code> this produced 159 corners at 1.5×pen ' +
    'and over a thousand at 1×pen.</p>');
{
  say('<table><tr><th>spacing ×pen</th><th>join tol ×pen</th><th>dashes</th>' +
      '<th>paths</th><th>corners</th><th>worst turn</th></tr>');
  let anyBend = false;
  for (const spacingW of [6, 3, 2, 1.5, 1]) {
    const { ctx, args, lines } = runFlat(0.4, { spacingW, dashW: 6 });
    // exactly what worker.js does, including the method's own cap on the tolerance
    const pens = Math.min(1.5, dashHatching.maxJoinPens(args));
    const joined = joinCoincidentLines(optimizeOrder(lines), pens * ctx.w);
    let corners = 0, worstTurn = 0;
    for (const path of joined) {
      for (let i = 1; i < path.length - 1; i++) {
        const ax = path[i][0] - path[i - 1][0], ay = path[i][1] - path[i - 1][1];
        const bx = path[i + 1][0] - path[i][0], by = path[i + 1][1] - path[i][1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 1e-9 || lb < 1e-9) continue;
        const c = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
        const turn = (Math.acos(c) * 180) / Math.PI;
        if (turn > 1) corners++;
        worstTurn = Math.max(worstTurn, turn);
      }
    }
    if (corners > 0) anyBend = true;
    say(`<tr><td>${spacingW}</td><td>${num(pens, 2)}</td><td>${lines.length}</td>` +
        `<td>${joined.length}</td>` +
        `<td class="${corners ? 'fail' : ''}">${corners}</td>` +
        `<td>${num(worstTurn, 1)}°</td></tr>`);
  }
  say('</table>');
  say(`<p>joins stay collinear — <span class="${anyBend ? 'fail' : 'pass'}">` +
      `${anyBend ? 'FAIL' : 'PASS'}</span>. <span class="note">A corner here means ` +
      'the join tolerance has outgrown the carrier spacing again — check that the ' +
      'worker is still consulting maxJoinPens, not that the geometry moved.</span></p>');
}

// ------------------------------------------------------------- determinism
// The seeded phase draws once per carrier in carrier order, so two runs at one
// seed must be identical and two seeds must differ. Same check 10 PRINT carries,
// for the same reason: an unseeded draw would pass every tone test above.
say('<h2>Dashed hatching — is the seeded phase deterministic?</h2>');
{
  const a = runFlat(0.6, { spacingW: 6, dashW: 6, dashSeed: 1 });
  const b = runFlat(0.6, { spacingW: 6, dashW: 6, dashSeed: 1 });
  const c = runFlat(0.6, { spacingW: 6, dashW: 6, dashSeed: 2 });
  const key = (r) => JSON.stringify(r.lines);
  const same = key(a) === key(b);
  const differs = key(a) !== key(c);
  say(`<p>seed 1 twice: <span class="${same ? 'pass' : 'fail'}">` +
      `${same ? 'identical' : 'DIFFERENT'}</span>; ` +
      `seed 1 vs 2: <span class="${differs ? 'pass' : 'fail'}">` +
      `${differs ? 'differs' : 'IDENTICAL'}</span>. ` +
      `<span class="note">Tone is unaffected either way — ` +
      `${num(a.rendered, 4)} against ${num(c.rendered, 4)} — which is the ` +
      `arrangement-versus-tone split the phase control rests on.</span></p>`);
}

}
