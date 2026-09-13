// Not a port. Dashed hatching: parallel carriers at a FIXED spacing, with tone
// carried by how much of each carrier is inked rather than by how far apart the
// carriers are.
//
// Every other line method here modulates a spacing -- eikonalStripes, planeWaves,
// streamlines and triStripes all run the same 1/L harmonic ladder, and
// parallelHatching modulates a layer count. This one holds the geometry still
// and modulates the duty cycle, which is the other obvious knob and was missing.
// The look is a regular ruled screen whose grain does not change with tone, so
// the page keeps one texture from highlight to shadow.
//
// The tone model is exact and has no fitted constant, for the same reason
// splitMerge's is: the marks are placed by an INTEGRAL rather than by a formula.
// Walk along a carrier accumulating the ink the image owes — a carrier owns a
// strip of width L, so a length ds of it owes K*L*ds for darkness K — and lay a
// dash every time the debt reaches one dash's worth.
//
// A dash is a stadium, not a rectangle, and at these sizes that is not a detail.
// A dash of length d under a round-capped pen of width w covers d*w + pi*w^2/4 —
// the caps are a fifth of the mark at d = 4w and a quarter at d = 2w. Charging
// d*w would lay that fraction too much ink everywhere.
//
// Two dashes that abut cost less than two dashes, the same fact read backwards,
// and it is what keeps the dark end honest. The union of stadiums over [s0,s1]
// and [s1,s2] is the stadium over [s0,s2]: one pair of caps, not two, so an
// abutting dash adds exactly its own length times w while a fresh one also pays
// for its caps.
//
// The debt is never dropped, which is what makes "exact" true. Settling each
// carrier independently and discarding the leftover loses half a dash per carrier
// on average — 2.8% of the ink on a 53-carrier page — and lets the phase offset
// quietly repay part of it. The debt carries from one carrier to the next and the
// phase offset is a loan repaid at the carrier's end, so the only ink a whole
// drawing loses is the final remainder. Measured across a sixteen-fold
// dash-length sweep, coverage lands within 0.3% of the request.
//
// Strict alignment is not on offer, as a consequence of the carry rather than an
// oversight: a carried debt means each carrier starts wherever the last one
// finished, so its dashes cannot be made to line up with its neighbour's without
// discarding ink again. The seeded phase perturbs that; it does not override it.
//
// White is reachable and black is not. As the image lightens the debt takes
// longer to reach one dash and the marks simply stop, so true white costs
// nothing. The ceiling is the solid line: once the dashes abut, the carrier is
// full and coverage is w/L whatever the image asks for. That is the band, it is
// declared in toneBand, and the spacing control is how the user chooses it.
//
// The dash length is a plot-time control that does not move the tone. Ink owed is
// fixed by the image; dash length only decides whether it is paid in many small
// marks or few long ones, and the count compensates exactly.
//
// Not dots. The dash length floors at one pen width, below which a dash is a disc
// and this would be a worse-behaved stippler than the two the app already has.
// stippleGrowing and ditherGrid own that tone model; this one starts where a mark
// is long enough to read as a line.

import { interp2, inpolygon } from '../shim/image.js';
import { trimLineSegsToPolygon } from '../spine/geometry.js';
import { affineTarget } from '../spine/tone.js';
import { mulberry32 } from '../spine/random.js';
import { createInkBudget } from '../spine/dash.js';
import { COINCIDENT_PENS } from '../spine/pathOptimizer.js';
import { setNote } from '../spine/notes.js';

export const id = 'dashHatching';
export const label = 'Dashed hatching';
// The single param that orients this method's marks -- see methods/index.js.
export const rotationParam = 'angleDeg';

export const params = [
  { key: 'angleDeg', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, def: 26, unit: '°' },
  // min 1 is the merge floor: at L = w the carriers touch and the page is solid,
  // so there is nothing below it. It also sets the darkest reachable tone --
  // see toneBand -- which is the one thing the user has to choose here.
  { key: 'spacingW', label: 'Carrier spacing', type: 'range', min: 1, max: 5, step: 0.1, def: 1.5, unit: '×pen' },
  // The plot-time control. Longer dashes mean proportionally fewer of them for
  // the same ink, so this trades grain against pen lifts and leaves tone alone.
  // min 1 because a dash shorter than the pen is a dot; see the header.
  { key: 'dashW', label: 'Dash length', type: 'range', min: 1, max: 10, step: 0.5, def: 3, unit: '×pen' },
  { key: 'dashSeed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1 },
];

function settingsOf(ctx) {
  const w = ctx.w;
  const L = Math.max(w, (ctx.spacingW ?? 1.5) * w);
  const d = Math.max(w, (ctx.dashW ?? 3) * w);
  return {
    w, L, d,
    theta: ((ctx.angleDeg ?? 26) * Math.PI) / 180,
    seed: Math.round(ctx.dashSeed ?? 1),
  };
}

/**
 * How near two endpoints may be before the worker treats them as one stroke.
 *
 * In pen widths, and it only ever tightens the default. The pipeline joins paths
 * whose ends fall within 1.5 pen widths, assuming no method places DISTINCT
 * strokes closer than that. This one does: its carriers are a control that floors
 * at one pen width, and at any spacing at or below 1.5 the pipeline chains a dash
 * on one carrier to a dash on the next — a join across the grain, drawn as a V.
 * Measured on a 360px page: none at 2×pen and above, 159 at 1.5×, over a thousand
 * at 1×.
 *
 * Half the carrier spacing is sound for straight carriers — two dashes on one
 * carrier are collinear, two on different carriers are at least L apart — but
 * does not survive a curved one, so the shared slop tolerance is used instead;
 * see `COINCIDENT_PENS`. It also stops the joiner bridging the small gaps the
 * integral never budgeted for.
 */
export function maxJoinPens() {
  return COINCIDENT_PENS;
}

/**
 * Reachable brightness band.
 *
 * White is reachable, unlike every other stripe method here: no dash is laid
 * where no ink is owed. The dark end is the solid carrier, coverage w/L, so the
 * band is [1 - w/L, 1] and it is set entirely by the spacing control.
 *
 * This is not the `stripeBand` the spacing-ladder methods share. It agrees with
 * `stripeBand(w, L, Infinity)` only by coincidence of algebra: that band's
 * endpoints are two spacings, this one's are a duty cycle of 1 and of 0 at a
 * single spacing. Sharing them would tie two unrelated tone models together.
 */
export function toneBand(ctx) {
  const { w, L } = settingsOf(ctx);
  return { min: Math.max(0, 1 - w / L), max: 1 };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * The carrier frame and how many carriers fit.
 *
 * Same construction as splitMerge: project the polygon's corners onto the along
 * and across axes rather than scanning the raster, since the drawing polygon is
 * a rectangle and its extent is exactly its corners.
 */
function carrierFrame(ctx, theta, L) {
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const vx = -uy, vy = ux;
  const { px, py } = ctx.polygon;

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < px.length; i++) {
    const u = px[i] * ux + py[i] * uy;
    const v = px[i] * vx + py[i] * vy;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  // Centred, so the carriers sit symmetrically in the region rather than being
  // anchored to whichever corner happened to project lowest.
  const span = vMax - vMin;
  const count = Math.max(1, Math.floor(span / L));
  const v0 = vMin + (span - (count - 1) * L) / 2;
  return { ux, uy, vx, vy, uMin, uMax, v0, count };
}

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const { w, L, d, theta, seed } = settingsOf(ctx);
  const { ux, uy, vx, vy, uMin, uMax, v0, count } = carrierFrame(ctx, theta, L);

  const target = targetImage(ctx);
  // Fine enough that the debt is sampled many times per dash; the integral is
  // carried rather than truncated, so this sets position jitter and not tone.
  const ds = Math.max(0.25, w / 3);

  // One generator, drawn from once per carrier in carrier order, so the call
  // sequence is fixed by the geometry -- see spine/random.js on why that matters.
  const rand = mulberry32(seed);

  // The ink law -- stadium areas, the cheaper abutting charge, the carried debt
  // and the repayable phase loan -- lives in spine/dash.js and is shared with
  // dashedStreamlines. Only the straight-carrier geometry is here.
  const budget = createInkBudget({ w, dash: d });
  const aFresh = budget.aFresh;
  const segs = [];

  for (let k = 0; k < count; k++) {
    const v = v0 + k * L;

    // The carrier's run inside the polygon, found before anything is placed so a
    // dash can be shortened to end on it rather than emitted long and trimmed
    // afterwards. Trimming would charge for ink the page never receives.
    let uIn0 = NaN, uIn1 = NaN;
    for (let u = uMin; u <= uMax; u += ds) {
      // An arbitrary point rather than a pixel centre, so this is one of the
      // direct inpolygon calls docs/architecture.md keeps outside spine/mask.js.
      if (!inpolygon(u * ux + v * vx, u * uy + v * vy, px, py)) continue;
      if (Number.isNaN(uIn0)) uIn0 = u;
      uIn1 = u;
    }
    if (Number.isNaN(uIn0)) continue;

    // A seeded phase per carrier, read as "this carrier begins a fraction `ph` of
    // the way through a dash". Two consequences, and the reading needs both: the
    // first mark falls due that much sooner, and it is cut short by the same
    // fraction, because the carrier's start has taken a bite out of it. Without
    // the second, every carrier opens with a full-length dash and the left edge
    // of the hatching reads as a ruled line.
    //
    // Both stay tone-neutral. The credit is a loan repaid at `end()`, and
    // `charge` pays for the length actually laid, so a short leading mark costs
    // proportionally less and leaves the difference in the debt.
    const ph = rand();
    budget.begin(ph * aFresh);
    // Floored at the pen width: below that a dash is a dot, and this method
    // starts where a mark is long enough to read as a line.
    const firstCap = Math.max(w, (1 - ph) * d);
    let laidTo = NaN;                 // u where this carrier's last dash ended

    for (let u = uIn0; u <= uIn1; u += ds) {
      const x = u * ux + v * vx;
      const y = u * uy + v * vy;
      let t = interp2(target, x, y);
      if (!isFinite(t)) t = 1;
      const K = 1 - Math.min(1, Math.max(0, t));
      budget.owe(K * L * ds);

      // `while`, not `if`: at a wide spacing and a short dash one step can owe
      // more than one dash, and dropping the remainder would lose that ink.
      while (budget.due()) {
        // Abutting means the PREVIOUS DASH ended past this sample, so the new one
        // has to start where that one stopped. Testing `s0 > u` after the fact
        // would also fire for a dash pushed by anything else.
        const abut = !Number.isNaN(laidTo) && laidTo > u;
        const s0 = abut ? laidTo : u;
        if (s0 >= uIn1) break;        // carrier is full; the debt carries onward
        // The carrier's first mark is the one the phase cut into; every later
        // one is full length, or trimmed to end on the carrier.
        const cap = Number.isNaN(laidTo) ? firstCap : d;
        const s1 = Math.min(s0 + cap, uIn1);
        const run = s1 - s0;
        if (run <= 0) break;
        segs.push([
          s0 * ux + v * vx, s0 * uy + v * vy,
          s1 * ux + v * vx, s1 * uy + v * vy,
        ]);
        budget.charge(run, abut);
        laidTo = s1;
      }
    }

    budget.end();
  }

  // Saturation is a property of the settings, not a fault, but it is invisible in
  // the drawing -- a full carrier just looks like a line. Say so, as stringArt
  // does, rather than leaving the tone error unexplained.
  const { demanded, undelivered } = budget.report();
  if (demanded > 0 && undelivered / demanded > 0.02) {
    setNote(`${Math.round((undelivered / demanded) * 100)}% of the ink did not fit — ` +
            'reduce the carrier spacing');
  }

  // Dashes are already cut to the carrier's inside run, so this is a safety net
  // for a non-convex polygon rather than the load-bearing clip it looks like.
  return trimLineSegsToPolygon(segs, px, py).map((s) => [[s[0], s[1]], [s[2], s[3]]]);
}

export default { id, label, params, run, targetImage, maxJoinPens, rotationParam };
