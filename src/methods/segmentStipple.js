// Stippling with short strokes instead of dots -- the collection's
// regionsHatchingStippling.
//
// Points at a density the image asks for, exactly as `stippleGrowing` places
// them, but each one draws a short straight segment rather than a filled disc.
// The mark carries a direction, which is the whole reason to have it: a field of
// aligned ticks reads as engraving where the same points as dots read as texture.
//
// THE TONE MODEL IS THE DOT MODEL WITH A DIFFERENT MARK AREA, and it has no
// fitted constant. A segment of length d under a round-capped pen of width w
// covers the stadium d*w + pi*w^2/4 (spine/dash.js `stadiumArea`), so a region of
// darkness K0 wants
//
//     N = K0 * area / stadiumArea(d, w)
//
// marks in it. Each supplies stadiumArea of ink, so the ink fraction is K0. That
// is `stippleGrowing`'s identity with pi*r^2 swapped out, and the two agree
// exactly at the smallest mark: at d = 0 the stadium is pi*(w/2)^2, one pen
// touch, so this method contains dot stippling as its short-mark limit.
//
// ONE KNOB CARRIES TONE AND IT IS THE COUNT. Mark length is a plot-time control
// -- longer marks mean proportionally fewer of them for the same ink -- which is
// the same split `dashHatching` makes between dash length and tone, and for the
// same reason: the ink is fixed by the image, and only how it is parcelled out is
// the user's to choose.
//
// WHERE IT RUNS LIGHT, AND WHY ORIENTATION DECIDES HOW SOON. At coverage K the
// marks sit s = sqrt(stadiumArea/K) apart, so a mark is longer than the gap
// between marks once
//
//     K >= stadiumArea(d, w) / d^2        -- 0.30 for d = 4w, 0.55 for d = 2w
//
// Past that they must overlap, and overlapping ink is ink the model counted and
// the paper did not receive -- the same shortfall `stippleGrowing` carries, but
// arriving far sooner, because an elongated mark packs much worse than a disc of
// the same area. Equal discs stay clear of each other until K = 0.785; a
// four-pen stroke is already crowding itself at 0.30.
//
// THE THRESHOLD IS WHERE OVERLAP BECOMES UNAVOIDABLE, NOT WHERE IT BEGINS, and
// the first version of this note had that wrong. Measured on a full 0-1 ramp,
// there is a deficit at every tone and it grows smoothly with density:
//
//     d = 4w  RMS 0.125, +0.257 darkest, +0.003 lightest  (threshold K = 0.30)
//     d = 2w  RMS 0.091, +0.198 darkest, +0.002 lightest  (threshold K = 0.70)
//
// At d = 2w, bands at K = 0.65, 0.55 and 0.45 are all BELOW the threshold and
// still run 0.071, 0.043 and 0.023 light. So `N = sum(K)/stadiumArea` is an upper
// bound on delivered ink at every density, not a law that switches off at a
// corner: there is no stroke length at which a full ramp comes out clean, and
// shortening the mark widens the usable range rather than removing the loss.
//
// The lightest band's 4% splits into about 1.1% from the polygon-area convention
// -- coverage is measured over nx*ny pixels while the polygon [1,nx]x[1,ny]
// encloses (nx-1)(ny-1) of them -- and the rest early overlap. The count itself is
// sound: 3456 marks against the 3447 the budget asks for.
//
// Orientation turned out NOT to be the lever. `field`, `random` and quantised all
// measured within 0.006 of each other, so the abutting-stadium saving -- the
// hoped-for analogue of 10 PRINT's "random angles cannot tile" -- is not
// available to a stipple: the placer positions marks isotropically, so aligned
// marks are no likelier to meet end to end than turned ones are. The saving needs
// marks placed IN ROWS, which is a hatching method and not this one.
//
// The repair, if it is wanted, is `stippleGrowing`'s: solve the count for the
// UNION rather than the sum, which needs a blue-noise union law for stadiums.
// Until then the shortfall is reported -- the harness carries it as a known
// number, and `run` sets a note when the marks are longer than their spacing.

import { mulberry32 } from '../spine/random.js';
import { structureTensorField } from '../spine/field.js';
import { stadiumArea } from '../spine/dash.js';
import { stipplePoints, placerParam, usesRelaxation } from '../spine/points.js';
import { COINCIDENT_PENS } from '../spine/pathOptimizer.js';
import { setNote } from '../spine/notes.js';
import { darknessField } from './stippleGrowing.js';

export const id = 'segmentStipple';
export const label = 'Stippling (short strokes)';

export const params = [
  // Floor 1 = a mark one pen width long, below which it is a dot and
  // `stippleGrowing` owns the tone model. The count compensates exactly, so this
  // trades grain against pen lifts and leaves tone alone -- BELOW SATURATION.
  //
  // The default is 2, not something longer, and that is the saturation threshold
  // choosing it. Marks stop being able to avoid each other at
  // K = stadiumArea/d^2, which is 0.70 at d = 2w and only 0.30 at 4w -- so a
  // four-pen stroke is already overlapping across most of an ordinary image,
  // while two pens puts the threshold beside the dot method's own 0.785 and
  // leaves the useful range clear. Longer strokes are a real look and the slider
  // still reaches them; they simply run light in the shadows, and `run` says so.
  { key: 'dW', label: 'Stroke length', type: 'range', min: 1, max: 12, step: 0.25, def: 2, unit: '×pen' },
  {
    key: 'angleSource', label: 'Angles', type: 'select', def: 'field',
    options: [
      { value: 'field', label: 'Follow image (structure tensor)' },
      { value: 'random', label: 'Random' },
    ],
  },
  // Quantisation applies to both sources: on `field` it gives the engraved look
  // of a fixed set of hatching directions, on `random` a scatter over the same
  // set. The step is pi/n, not 2pi/n -- a segment is symmetric, so n steps over a
  // HALF turn is what gives n distinct directions and lets the label say what it
  // means. (polygonSubdivision's menu is the cautionary tale.)
  {
    key: 'nAngles', label: 'Directions', type: 'select', def: 0,
    options: [
      { value: 0, label: 'Any angle' },
      { value: 2, label: 'Quantise to 2' },
      { value: 4, label: 'Quantise to 4' },
      { value: 6, label: 'Quantise to 6' },
      { value: 12, label: 'Quantise to 12' },
    ],
  },
  placerParam(),
  { key: 'relaxIter', label: 'Local relaxation', type: 'range', min: 1, max: 20, step: 1, def: 6, unit: 'iters',
    when: usesRelaxation },
  // Never hidden, unlike the other point-placing methods. There the seed reaches
  // only the placer, so the subdivider — which draws from the RNG zero times —
  // has no use for it. Here every mark takes a draw for its angle in BOTH modes,
  // the field one included: the coherence gate spends it on the perturbation, so
  // anywhere the field is less than perfectly coherent the seed moves the drawing.
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1 },
];

/**
 * Every mark is a separate stroke, so only an exactly shared endpoint may join.
 *
 * The pipeline's default of 1.5 pen widths assumes two nearby ends are the two
 * ends of one interrupted stroke. Here they never are: the marks are scattered
 * points by construction, and at any useful density plenty of them finish within
 * a pen width of each other. Joining would chain two into one path and draw the
 * gap between them, which is ink the count never budgeted -- and would turn two
 * ticks into a bent line, destroying the one thing the mark is carrying.
 */
export function maxJoinPens() {
  return COINCIDENT_PENS;
}

function settingsOf(ctx) {
  const w = ctx.w;
  return {
    w,
    d: Math.max(w, (ctx.dW ?? 4) * w),
    nAngles: Math.max(0, Math.round(ctx.nAngles ?? 0)),
    source: ctx.angleSource ?? 'field',
    seed: Math.round(ctx.seed ?? 1),
  };
}

/**
 * Quantise an orientation to one of n directions over a HALF turn.
 *
 * pi/n rather than 2pi/n because the mark is symmetric and has no far end, so
 * n steps round a full turn would land on only n/2 distinct directions. Same
 * convention as `planeWaves.quantise`.
 */
export function quantiseAngle(t, n) {
  if (!(n > 0)) return t;
  const step = Math.PI / n;
  return Math.round(t / step) * step;
}

/**
 * Mark centres and the angle each one draws at.
 *
 * Exported so the harness can measure the count and the angle distribution
 * without paying for the geometry or the clip.
 *
 * THE COHERENCE GATE IS A SPREAD, NOT A BLEND. Orientations are mod pi and cannot
 * be averaged toward a fallback, so where the field is weak the mark's angle is
 * perturbed instead, by a random amount whose width grows as coherence falls. At
 * gate 1 it is the field angle exactly; at gate 0 the perturbation is uniform
 * over a pi-wide window, which mod pi is uniformly random -- so a flat region
 * degrades into the `random` mode rather than into a false direction. Without it
 * the marks would faithfully follow sensor grain in exactly the areas that should
 * read as even texture.
 *
 * The RNG is drawn from exactly ONCE PER MARK in both modes and whatever the
 * gate says, so the call sequence depends only on the count -- see
 * spine/random.js on why that is the invariant to protect.
 */
export function placeMarks(ctx) {
  const { w, d, nAngles, source, seed } = settingsOf(ctx);
  const { field, total } = darknessField(ctx);
  const area = stadiumArea(d, w);
  const count = Math.round(total / area);
  if (!(count >= 1)) return { x: [], y: [], t: [], n: 0, count: 0, area };

  const { sx, sy } = stipplePoints(ctx, {
    mode: ctx.placer,
    field,
    count,
    seed,
    iterations: Math.round(ctx.relaxIter ?? 6),
    // No perimeter ring, for stippleGrowing's reason: the ring exists to make a
    // triangulation cover the page, and a stipple wants no points forced onto
    // the boundary at all.
  });

  const n = sx.length;
  const rand = mulberry32(seed);
  const t = new Float64Array(n);

  let tensor = null;
  let medE = 0;
  if (source === 'field') {
    tensor = structureTensorField(ctx.im, Math.max(1, w), Math.max(1.5, w * 2));
    // Median gradient energy for the gate, sampled rather than sorted -- the gate
    // needs a scale, not an exact median. Same treatment as siteMetrics.
    const energies = [];
    for (let i = 0; i < tensor.t11.length; i += 7) energies.push(tensor.t11[i] + tensor.t22[i]);
    energies.sort((a, b) => a - b);
    medE = energies.length ? energies[energies.length >> 1] : 0;
  }

  const { nx, ny } = ctx;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (!tensor) {
      t[i] = quantiseAngle(r * Math.PI, nAngles);
      continue;
    }
    // Nearest pixel at the mark's own position: no interpolation, so no mod-pi
    // question even in principle. The treeEdges and lappingShapes precedent.
    const jx = Math.min(nx - 1, Math.max(0, Math.round(sx[i]) - 1));
    const iy = Math.min(ny - 1, Math.max(0, Math.round(sy[i]) - 1));
    const c = iy * nx + jx;
    const e = medE > 0 ? Math.min(1, (tensor.t11[c] + tensor.t22[c]) / medE / 2) : 0;
    const gate = tensor.coherence[c] * (e * e * (3 - 2 * e));
    t[i] = quantiseAngle(tensor.theta[c] + (1 - gate) * (r - 0.5) * Math.PI, nAngles);
  }

  return { x: sx, y: sy, t, n, count, area };
}

/**
 * The fraction of the drawing dark enough that its marks cannot avoid each other.
 *
 * `run` reports it, because the overlap it predicts is invisible in the drawing
 * -- a dense field of ticks looks intentional whether or not it is delivering the
 * tone asked for -- and the tone error alone does not say which control to move.
 * The threshold is the header's: a mark is longer than the gap between marks once
 * K reaches stadiumArea/d^2.
 */
export function saturatedFraction(ctx) {
  const { w, d } = settingsOf(ctx);
  const { field } = darknessField(ctx);
  const Kmax = stadiumArea(d, w) / (d * d);
  let over = 0, live = 0;
  for (let i = 0; i < field.length; i++) {
    if (!(field[i] > 0)) continue;
    live++;
    if (field[i] >= Kmax) over++;
  }
  return live > 0 ? over / live : 0;
}

export function run(ctx) {
  const { d } = settingsOf(ctx);
  const { x, y, t, n } = placeMarks(ctx);

  const half = d / 2;
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const dx = Math.cos(t[i]) * half, dy = Math.sin(t[i]) * half;
    // NOT CLIPPED, matching stippleGrowing and for its reason: a mark whose
    // centre is inside the region can hang over the edge by up to d/2, and
    // cutting it both reads as a broken stroke and throws away ink the count has
    // already been charged for -- measured at about 1.7% of the total on a
    // 360x120 page, which is a systematic deficit at every tone, not just the
    // dark end. Same TODO as its sibling for a real polygon: pull the mark
    // inside rather than cut it.
    lines[i] = [[x[i] - dx, y[i] - dy], [x[i] + dx, y[i] + dy]];
  }

  const sat = saturatedFraction(ctx);
  if (sat > 0.02) {
    setNote(`${Math.round(sat * 100)}% of the drawing is dark enough that the ` +
            'strokes overlap — shorten them, or expect it to run light');
  }
  return lines;
}

export default { id, label, params, run, maxJoinPens };
