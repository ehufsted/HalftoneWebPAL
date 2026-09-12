// Not a port. Streamlines packed at a CONSTANT separation, with tone carried by
// dashes along their length rather than by how tightly they pack.
//
// It is the cross of the two methods either side of it in the picker:
// `streamlines` supplies the integrator, `dashHatching` supplies the ink law, and
// spine/dash.js is where the second one lives so neither method owns it.
//
// A separate module rather than a mode: `streamlines` modulates spacing on the
// harmonic ladder, band [1 - w/Lmin, 1 - w/Lmax], where this modulates duty cycle
// at one spacing, band [1 - w/d, 1]. Two tone models with two different
// targetImages, which by docs/architecture.md's test means two modules.
//
// What the uniform packing buys: in `streamlines` the texture coarsens as the
// picture lightens, because spacing IS the tone. Here the grain is fixed by the
// separation control and stays the same from highlight to shadow, so the drawing
// reads as one engraved surface with the light playing over it rather than as a
// density map. It also makes the field legible everywhere — a light region still
// gets the full density of lines, just barely inked.
//
// Seeding needs no change. The integrator sorts its fallback seeds by the spacing
// map and breaks ties on pixel index; hand it a flat spacing and every key is
// equal, so the sort collapses to raster order and the queue does the rest. That
// is plain Jobard-Lefer, which is what uniform packing wants — `streamlines`'
// darkest-first ordering exists precisely because its spacing varies.
//
// ---- the tone model
//
// The page is PARTITIONED among the lines. Every pixel inside the drawing is
// assigned to the nearest sample of the nearest line, and its ink is owed to that
// line at that point along it. Sum over the page and the total ink demanded is
// exactly the integral of darkness, once, nothing double counted and nothing
// missed.
//
// That is the point rather than an optimisation. Charging each line for a strip
// of width d_sep — the obvious construction — is wrong in the two places this
// method is most exposed. A streamline terminates, against a neighbour, the page,
// or its own tail, and the wedge past its tip belongs to nobody, so a fixed strip
// under-inks exactly where the field is busiest. And the packing does not land on
// d_sep exactly, because a candidate seed is rejected at d_sep while a growing
// line may run in to d_test, so a fixed strip charges the requested spacing while
// the paper receives the realised one. Partitioning answers both without
// measuring either: whatever the lines actually did, each
// pixel's ink goes to whichever line is nearest.
//
// The assignment is capped at one separation. A pixel further than d_sep from any
// line has no line that could reasonably ink it — past a termination, or in a
// corner the packing never reached — and piling its ink onto the nearest tip
// would draw a blot there. Those pixels are counted and reported instead: the
// drawing cannot express that ink at this separation.
//
// A curved dash is charged its arc length. To first order a stadium swept along a
// curve of radius R covers arc*w, the inner and outer offsets cancelling; the
// residual is O(w^3/R^2) and is far below the pen width for any curve this
// integrator produces, which is limited by the field's own smoothing scale.

import { regionMask } from '../spine/mask.js';
import { affineTarget } from '../spine/tone.js';
import { createInkBudget, arcTable, subPolyline } from '../spine/dash.js';
import { COINCIDENT_PENS } from '../spine/pathOptimizer.js';
import { nearestSeedMap } from '../spine/relax.js';
import { simplifyLineDistance } from '../spine/simplify.js';
import { clipPolyline } from '../spine/geometry.js';
import { setNote } from '../spine/notes.js';
import { traceStreamlines } from './streamlines.js';

export const id = 'dashedStreamlines';
export const label = 'Dashed streamlines';

export const params = [
  // min 1 is the merge floor, as everywhere: at d_sep = w the lines touch and the
  // page is solid. It also fixes the darkest reachable tone -- see toneBand -- so
  // it is the one control the picture's shadows depend on.
  { key: 'sepW', label: 'Line separation', type: 'range', min: 1, max: 5, step: 0.5, def: 1.5, unit: '×pen' },
  // The plot-time control, exactly as in dashHatching: ink owed is fixed by the
  // image, so a longer dash means proportionally fewer of them and the tone does
  // not move. It matters more here than in a straight hatching, which has far
  // fewer carriers.
  { key: 'dashW', label: 'Dash length', type: 'range', min: 1, max: 20, step: 0.5, def: 6, unit: '×pen' },
  // Names shared with `streamlines`, because they are read by its integrator.
  { key: 'angleOffset', label: 'Stroke angle', type: 'range', min: 0, max: 180, step: 5, def: 0, unit: '°' },
  { key: 'flatAngle', label: 'Angle in flat areas', type: 'range', min: 0, max: 180, step: 5, def: 45, unit: '°' },
  { key: 'minLenW', label: 'Shortest stroke', type: 'range', min: 1, max: 40, step: 1, def: 6, unit: '×pen' },
];

function settingsOf(ctx) {
  const w = ctx.w;
  return {
    w,
    dSep: Math.max(w, (ctx.sepW ?? 8) * w),
    dash: Math.max(w, (ctx.dashW ?? 6) * w),
  };
}

/**
 * Reachable brightness band: white free, black at the solid line.
 *
 * This is the specification, not the achieved tone — the same distinction
 * `streamlines` makes. Where the packing leaves a gap no line can reach, the ink
 * is reported rather than modelled, since folding it in would score the method
 * against its own error. Unlike `streamlines`, a termination costs nothing here
 * so long as SOME line passes within a separation, because the partition hands
 * that pixel's ink to whichever line is nearest.
 */
export function toneBand(ctx) {
  const { w, dSep } = settingsOf(ctx);
  return { min: Math.max(0, 1 - w / dSep), max: 1 };
}

export function targetImage(ctx) {
  return affineTarget(ctx, toneBand(ctx));
}

/**
 * Only genuinely coincident dash ends may be joined. See `DASH_JOIN_PENS`.
 *
 * This method is the worst case for the pipeline's default: neighbouring
 * streamlines run nearly parallel and are traced in arbitrary directions, so a
 * dash on one line and an ANTIPARALLEL dash on its neighbour can have ends a pen
 * width apart. Joining those draws a 177-degree hairpin across the grain.
 */
export function maxJoinPens() {
  return COINCIDENT_PENS;
}

export function run(ctx) {
  const { nx, ny } = ctx;
  const { px, py } = ctx.polygon;
  const { w, dSep, dash } = settingsOf(ctx);
  const mask = regionMask(ctx);

  // ---- 1. the carriers, packed uniformly
  const flat = new Float64Array(nx * ny).fill(dSep);
  const built = traceStreamlines(ctx, {
    spacing: flat,
    spacings: { w, Lmin: dSep, Lmax: dSep },
  });
  if (built.lines.length === 0) return [];

  // Thinned before anything else, so the arc lengths the dashes are cut from are
  // the ones that will be drawn. The integrator emits a point every 0.25*w; half a
  // pen width is the threshold below which a deviation cannot be seen, and is what
  // `streamlines` and `eikonalStripes` both pre-thin at.
  const lines = [];
  for (const line of built.lines) {
    const simp = simplifyLineDistance(line, w / 2);
    if (simp.length >= 2) lines.push(simp);
  }
  if (lines.length === 0) return [];
  const arcs = lines.map(arcTable);

  // ---- 2. sample the carriers, keeping each sample's line and position along it
  //
  // Sampled by arc length, not at the vertices. The lines have just been
  // simplified, and `simplifyLineDistance` returns [first, last] for anything
  // straight, so sampling at vertices gives a straight carrier exactly two
  // samples, one at each end. The partition then has nothing in the middle of the
  // page to assign pixels to: they go to a distant endpoint or past the cap and
  // their ink is dropped — measured, a flat field rendering at 9% of the
  // requested tone and a radial ramp losing 10 to 13%.
  const sampleStep = Math.max(0.5, w / 2);
  const sxArr = [], syArr = [], lineOf = [], arcOf = [];
  for (let li = 0; li < lines.length; li++) {
    const pts = lines[li], s = arcs[li];
    const total = s[s.length - 1];
    let seg = 1;
    for (let t = 0; t <= total; t += sampleStep) {
      while (seg < pts.length - 1 && s[seg] < t) seg++;
      const span = s[seg] - s[seg - 1];
      const f = span > 0 ? (t - s[seg - 1]) / span : 0;
      sxArr.push(pts[seg - 1][0] + f * (pts[seg][0] - pts[seg - 1][0]));
      syArr.push(pts[seg - 1][1] + f * (pts[seg][1] - pts[seg - 1][1]));
      lineOf.push(li); arcOf.push(t);
    }
  }
  const sx = Float64Array.from(sxArr), sy = Float64Array.from(syArr);
  const nS = sx.length;
  if (nS === 0) return [];

  // ---- 3. partition the page among the samples
  const label = nearestSeedMap(nx, ny, mask, sx, sy, nS);

  // ---- 4. hand each pixel's ink to the line that owns it
  const target = targetImage(ctx);
  const owed = new Float64Array(nS);
  const capR2 = dSep * dSep;
  let unreachable = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!mask[c]) continue;
      const K = 1 - Math.min(1, Math.max(0, target.data[c]));
      if (K <= 0) continue;
      const j = label[c];
      if (j < 0) { unreachable += K; continue; }
      const dx = sx[j] - (ix + 1), dy = sy[j] - (iy + 1);
      // One pixel of area, so K px^2 of ink.
      if (dx * dx + dy * dy > capR2) unreachable += K; else owed[j] += K;
    }
  }

  // ---- 5. walk each carrier, laying a dash whenever the debt reaches one
  const budget = createInkBudget({ w, dash });
  const pieces = [];
  let at = 0;
  for (let li = 0; li < lines.length; li++) {
    const pts = lines[li], s = arcs[li];
    const total = s[s.length - 1];
    // Half a dash of credit, repaid at the line's end: it centres the flooring so
    // the remainder is unbiased, and shifts where the first dash falls. See
    // spine/dash.js on why the loan has to be repaid.
    budget.begin(0.5 * budget.aFresh);
    let laidTo = NaN;

    while (at < nS && lineOf[at] === li) {
      budget.owe(owed[at]);
      const here = arcOf[at];
      while (budget.due()) {
        const abut = !Number.isNaN(laidTo) && laidTo > here;
        const s0 = abut ? laidTo : here;
        if (s0 >= total) break;              // line is full; the debt carries on
        const s1 = Math.min(s0 + dash, total);
        const run = s1 - s0;
        if (run <= 0) break;
        const piece = subPolyline(pts, s, s0, s1);
        if (piece.length >= 2) pieces.push(piece);
        budget.charge(run, abut);
        laidTo = s1;
      }
      at++;
    }
    budget.end();
  }

  // ---- 6. clip, as a safety net; the integrator already stops at the polygon
  const out = [];
  for (const piece of pieces) {
    for (const r of clipPolyline(piece, px, py)) if (r.length >= 2) out.push(r);
  }

  const { demanded, undelivered, charged, fresh, abutting } = budget.report();
  // Harness-only diagnostics, on the same opt-in channel `streamlines` uses for
  // its stage counts. Nothing reads this back to make a decision.
  if (ctx.dashTally) {
    let drawn = 0;
    for (const r of out) {
      for (let i = 1; i < r.length; i++) {
        drawn += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
      }
    }
    Object.assign(ctx.dashTally, {
      lines: lines.length, dashes: out.length, drawn,
      demanded, charged, undelivered, unreachable, fresh, abutting,
      samples: nS, aFresh: budget.aFresh,
    });
  }
  const asked = demanded + unreachable;
  const short = asked > 0 ? (undelivered + unreachable) / asked : 0;
  setNote(short > 0.02
    ? `${lines.length} lines, ${out.length} dashes — ${Math.round(short * 100)}% of the ` +
      'ink had no line near enough to carry it; reduce the separation'
    : `${lines.length} lines, ${out.length} dashes`);

  return out;
}

export default { id, label, params, run, targetImage, maxJoinPens };
