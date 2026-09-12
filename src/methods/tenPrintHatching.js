// Port of singleWidthLines/code/regions10PRINTHatching.m
//
// Dithering rendered with lines rather than dots, which only gives the right
// darkness when the line width is set to match the segment length; see below.
//
// One diagonal per cell of a square grid, angle quantised to four directions --
// which, since a segment is symmetric, is the two diagonals of 10 PRINT. Tone
// comes entirely from *which* cells get a stroke: the cumulative darkness is
// walked in scan order and a cell is marked every time that sum crosses an
// integer, so the fraction of cells inked is exactly its input by construction.
//
// That input is not K. The dither reproduces the fraction it is handed, but a
// marked cell renders at `bar` plus whatever its round stroke ends spill onto
// unmarked neighbours, which is more than the dither accounts for — so feeding it
// K directly runs the ramps dark, 0.424 against a target of 0.500, while the
// tone-ceiling table still passes at 0.007 because it marks every cell and the
// spill saturates. `markFraction` inverts the measured overlap identity in closed
// form, so there is still no fitted constant.
//
// The one number that matters is Lseg. A stroke covers w*Lseg of a cell whose
// area is Lseg^2/2, so a marked cell renders at coverage 2w/Lseg. The dither
// treats a stroke as 1 and no stroke as 0, so the rendered tone is only right
// when 2w/Lseg = 1, i.e.
//
//     Lseg = 2 * penWidth
//
// which is what the MATLAB's own commented-out validation block sets (line 124,
// `wLine = Lseg*0.5`) and what the header's warning means. That value is also
// the merge floor: parallel diagonals in adjacent cells sit Lseg/2 apart, so
// below 2w they touch on paper. Hence Lseg is clamped at 2w and the slider only
// ever runs *lighter* than correct -- deliberately, since the coarse grids are
// the interesting-looking ones. `toneCeiling()` reports what a given Lseg can
// actually reach.

import { resize, makeImage, inpolygon } from '../shim/image.js';
import { mulberry32 } from '../spine/random.js';
import { structureTensorField } from '../spine/field.js';
import { trimLineSegsToPolygon } from '../spine/geometry.js';

export const id = 'tenPrintHatching';
export const label = '10 PRINT hatching';

/**
 * The floor on Lseg, in millimetres, from the app's settings.
 *
 * It is `2 * penWidth` in every unit system at once -- pxPerCm cancels -- so
 * the slider can carry the clamp as its own minimum rather than silently
 * correcting the user afterwards. `settings.penWidth` is in cm, hence x20.
 * Below this the tone is over-dark AND adjacent diagonals merge on paper, so
 * there is nothing down there worth reaching.
 */
export function minLsegMm(settings) {
  return Math.round(settings.penWidth * 20 * 100) / 100;
}

export const params = [
  {
    key: 'LsegMm', label: 'Segment length', type: 'range',
    min: minLsegMm,
    max: (s) => Math.max(6, minLsegMm(s) * 8),
    step: 0.05, def: 1, unit: 'mm',
  },
  {
    key: 'angleSource', label: 'Angles', type: 'select', def: 'field',
    options: [
      { value: 'field', label: 'Follow image (structure tensor)' },
      { value: 'dithered', label: 'Follow image (error-diffused)' },
      { value: 'random', label: 'Random (10 PRINT)' },
    ],
  },
  // How much of each cell's rounding error is carried to the next marked cell.
  // At 0 nothing is carried and every cell rounds alone, which is `field` exactly
  // -- see diffuseAngles. At 1 the whole residual moves on.
  { key: 'angleMix', label: 'Angle dither', type: 'range', min: 0, max: 1, step: 0.05, def: 1,
    when: (p) => p.angleSource === 'dithered' },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, def: 1 },
];

const N_ANGLES = 4;
const T0 = Math.PI / N_ANGLES;

/**
 * The undithered choice: round an orientation to the nearer of the two diagonals.
 *
 * Four directions round a full turn, but a segment is symmetric, so this lands on
 * two orientations mod pi -- the 10 PRINT `/` and `\`.
 */
export function snapToDiagonal(theta) {
  return Math.round(((theta - T0) / (2 * Math.PI)) * N_ANGLES) * ((2 * Math.PI) / N_ANGLES) + T0;
}


/**
 * Grid geometry for a given segment length, shared with the harness.
 *
 * The cells must stay SQUARE and exactly LxSeg across: the stroke is the cell
 * diagonal, and the whole coverage argument (parallel diagonals in adjacent
 * cells sitting Lseg/2 apart) only holds if the spacing really is LxSeg. So the
 * cell count is rounded and the leftover is absorbed as a centring offset,
 * rather than stretching the cells to fit the image exactly.
 */
export function gridFor(ctx, LsegPx) {
  const LxSeg = LsegPx / Math.SQRT2;              // cell side; the stroke is its diagonal
  const W0 = ctx.nx - 1, H0 = ctx.ny - 1;         // X(end,end)-X(1,1) in the MATLAB
  const gx = Math.max(1, Math.round(W0 / LxSeg));
  const gy = Math.max(1, Math.round(H0 / LxSeg));
  return {
    gx, gy, LxSeg, LsegPx,
    x0: 1 + (W0 - gx * LxSeg) / 2,
    y0: 1 + (H0 - gy * LxSeg) / 2,
  };
}

/**
 * Segment length in pixels, after the merge-floor clamp. The UI slider already
 * starts at this floor (see `minLsegMm`), so in the app the clamp never bites;
 * it stays because verify.html and a restored URL hash can both hand over a
 * smaller value.
 */
export function segLengthPx(ctx) {
  const requested = ((ctx.LsegMm ?? 1) / 10) * ctx.pxPerCm;
  return Math.max(2 * ctx.w, requested);
}

/** The coverage a fully-marked region can reach: 2w/Lseg, capped at 1. */
export function toneCeiling(ctx) {
  return Math.min(1, (2 * ctx.w) / segLengthPx(ctx));
}

/**
 * The two parts of a stroke's coverage, each as a fraction of its cell's area.
 *
 * The stroke is a CAPSULE, not a rectangle -- renderStrokes tests
 * distance-to-segment, so the ends are round -- and the two parts behave
 * completely differently, which is the whole reason this function exists:
 *
 *   bar = w*L / (L^2/2) = 2w/L        the rectangular body
 *   cap = pi*w^2/4 / (L^2/2)          the two half-disc ends
 *
 * The BAR tiles. Diagonals of adjacent cells sit L/2 apart, so at L = 2w they
 * abut exactly and a fully-marked grid is solid: bar is the tone ceiling, and
 * `toneCeiling` above is right for that reason.
 *
 * The CAP does not. It sticks out past the cell corner, so it only lays ink if
 * the collinear neighbour is UNMARKED -- if that neighbour is drawn, the two
 * caps abut and the area is shared rather than added. So its contribution
 * carries a factor of (1 - p).
 */
export function coverageTerms(ctx) {
  const w = ctx.w;
  const L = segLengthPx(ctx);
  return { bar: (2 * w) / L, cap: (Math.PI * w * w) / (2 * L * L) };
}

/**
 * The fraction of cells to mark in order to render a darkness of K.
 *
 * This exists because the dither's output is not its input. The scan marks cells
 * so that the marked fraction is exactly mean(K), but a marked cell renders at
 * bar + (spill onto unmarked neighbours), so feeding K straight in lays too much
 * ink. The error is invisible at both ends of the range — at K = 0 nothing is
 * drawn and at K = 1 every cell is marked so the spill lands on ink already there
 * — and peaks in the midtones.
 *
 * That is why the tone-ceiling table passes at 0.007 while the ramps come back
 * at 0.424 against a target of 0.500: the ceiling test marks every cell, so it
 * saturates and cannot see this at all.
 *
 * The model is MEASURED, in verify.html's overlap-identity table, and has no
 * free parameter: expected ink is
 *
 *     ink(p) = p*bar + p*(1 - p)*cap
 *
 * which held to a worst residual of 0.0016 of ABSOLUTE ink across three segment
 * lengths and five fill fractions. As a ratio that is 0.1% where the page is
 * dark and up to 1.5% at the sparse rows, where there is barely any ink to
 * divide by -- same agreement, different denominator. The harness scores the
 * ratio and accepts 1.5% for that reason.
 *
 * Inverting it is a quadratic, the same one ditherGrid's mode 4 solves for its
 * own overlap identity:
 *
 *     cap*p^2 - (bar + cap)*p + K = 0
 *
 * At L = 2w and K = 0.5 that marks 40.5% of cells, not 50%.
 *
 * Not corrected, deliberately: with `angleSource: 'random'` the two diagonals
 * meet at grid corners at an angle instead of collinearly, and their caps
 * overlap in a quarter disc -- pi*w^2/16, halved because a corner meeting is
 * perpendicular only half the time, so pi/64 = 0.049 of a cell area at full
 * marking. Measured 0.0515. That leaves random angles about 0.02 light on a
 * ramp, which is the "random angles cannot tile" price the header already
 * claims and which the coherent case does not pay.
 *
 * `dithered` PAYS PART OF THAT SAME PRICE and is likewise not corrected for. The
 * mode mixes the two diagonals on purpose, so neighbours disagree more often than
 * under `field` and less often than under `random`, and the shortfall should land
 * between the two -- nearest `random` where the image is flat and the gate has
 * pulled the mix to even, nearest `field` where the orientation is strong and
 * little is being diffused. This function keeps the calibration it already had;
 * the cost is measured in tests/method.tenPrint.js and reported rather than
 * absorbed, exactly as `random`'s is.
 */
export function markFraction(K, bar, cap) {
  const k = Math.min(bar, Math.max(0, K));
  if (!(cap > 1e-12)) return bar > 0 ? k / bar : 0;
  const b = bar + cap;
  const disc = Math.max(0, b * b - 4 * cap * k);
  return Math.min(1, Math.max(0, (b - Math.sqrt(disc)) / (2 * cap)));
}

/**
 * The tone the method is aiming for: the source, with darkness clamped at the
 * ceiling `bar`.
 *
 * A CLAMP, not spine/tone.js's affine squeeze, and the difference is the point.
 * The method does not rescale the image into its band -- `markFraction` clamps K
 * at bar and everything below the ceiling is rendered exactly. So the honest
 * target is the source itself wherever it is reachable, and the ceiling only
 * where it is not. At the default L = 2w, bar = 1 and this is the identity.
 */
export function targetImage(ctx) {
  const { bar } = coverageTerms(ctx);
  const out = makeImage(ctx.nx, ctx.ny);
  for (let i = 0; i < out.data.length; i++) {
    const v = Math.min(1, Math.max(0, ctx.im.data[i]));
    out.data[i] = 1 - Math.min(bar, 1 - v);
  }
  return out;
}

/**
 * Orientation per grid cell, mod pi, and the diagonal-mix scalar derived from it.
 *
 * DIVERGENCE: the MATLAB resamples the field as atan2(imresize(sin T),
 * imresize(cos T)) -- a plain vector mean, which cancels antiparallel entries.
 * That is the mod-pi bug the README records in six MATLAB files. Since only
 * `t mod pi` can affect a symmetric segment, this resamples the DOUBLED angle
 * and halves it back, the same fix `meanOrientation` applies in the spine.
 *
 * `u` is the same orientation written as a grey level, which is what lets the
 * angle be dithered at all. An orientation is mod pi, so it cannot be diffused as
 * an angle -- but DOUBLED, the two diagonals are antipodal (45 -> 90,
 * 135 -> 270), so `sin(2t)` separates them cleanly: +1 at 45 degrees, -1 at 135,
 * and 0 at 0 and 90 where neither diagonal represents the feature at all. Mapped
 * to [0,1] that is an ordinary grey level and `diffuseAngles` can treat it as
 * one. The mod-pi hazard does not arise rather than being worked around.
 *
 * GATED ON COHERENCE AND ENERGY, both, and for the reason siteMetrics gives:
 * coherence divides by the trace and so is scale-free, which makes a nearly flat
 * patch with a slight directional bias read as fully coherent. Ungated, the
 * dither would faithfully reproduce sensor grain as diagonal texture in exactly
 * the areas that should be even. The gate pulls `u` toward 0.5 -- an equal mix of
 * both diagonals -- where there is no orientation worth following.
 *
 * Note the gate cannot change which side of 0.5 `u` falls on, since it only ever
 * moves `u` toward 0.5. So it has no effect at all on the undithered `field`
 * mode, and none on `dithered` at mix 0.
 */
function cellOrientations(ctx, gx, gy) {
  const { im, nx, ny, w } = ctx;
  const field = structureTensorField(im, Math.max(1, w), Math.max(1.5, w * 2));
  const c2 = makeImage(nx, ny), s2 = makeImage(nx, ny), gt = makeImage(nx, ny);

  // Median gradient energy, for the gate. Sampled rather than fully sorted, as
  // siteMetrics does: the gate needs a scale, not an exact median.
  const energies = [];
  for (let i = 0; i < field.t11.length; i += 7) energies.push(field.t11[i] + field.t22[i]);
  energies.sort((a, b) => a - b);
  const medE = energies.length ? energies[energies.length >> 1] : 0;

  for (let i = 0; i < field.theta.length; i++) {
    c2.data[i] = Math.cos(2 * field.theta[i]);
    s2.data[i] = Math.sin(2 * field.theta[i]);
    // smoothstep on energy against the image's own median, times coherence
    const e = medE > 0 ? Math.min(1, (field.t11[i] + field.t22[i]) / medE / 2) : 0;
    gt.data[i] = field.coherence[i] * (e * e * (3 - 2 * e));
  }

  // The gate resamples as an ordinary scalar; only the ANGLE needs the doubled
  // treatment above.
  const cg = resize(c2, gx, gy), sg = resize(s2, gx, gy), gg = resize(gt, gx, gy);
  const theta = new Float64Array(gx * gy);
  const u = new Float64Array(gx * gy);
  for (let i = 0; i < theta.length; i++) {
    theta[i] = 0.5 * Math.atan2(sg.data[i], cg.data[i]);
    const g = Math.min(1, Math.max(0, gg.data[i]));
    u[i] = 0.5 + 0.5 * Math.sin(2 * theta[i]) * g;
  }
  return { theta, u };
}

/**
 * Choose each marked cell's diagonal by error diffusion over `u`.
 *
 * The problem the plain `field` mode has is that it rounds every cell alone, so
 * a whole region at 20 degrees snaps to 45 and the drawing states a direction the
 * image never had. It is worst at 0 and 90 degrees, which sit equidistant from
 * both diagonals: an axis-aligned edge currently draws as one confident false
 * diagonal. Carrying the rounding residual forward instead makes the local MIX of
 * the two diagonals track the orientation, which is the most a two-direction
 * alphabet can say.
 *
 * ONLY MARKED CELLS PARTICIPATE. An unmarked cell draws nothing, so residual
 * spent on it is residual thrown away -- in a highlight where one cell in twenty
 * is inked that would be nineteen twentieths of it. Skipping them keeps the
 * invariant that the mean realised orientation matches the mean requested one.
 *
 * `order` is the tone dither's own serpentine walk, reused rather than rebuilt:
 * it is already serpentined for exactly the reason diffusion needs, so the
 * residual carried off a row end is picked up by the cell physically beside it.
 *
 * The error is self-limiting and needs no clamp: with `u` in [0,1] and the
 * carried term in [-0.5, 0.5], `want` stays in [-0.5, 1.5] and the residual after
 * thresholding lands back in [-0.5, 0.5].
 *
 * EXACTLY 0.5 DEFERS TO `snapToDiagonal`, which is what makes mix 0 identical to
 * `field` rather than merely equivalent to it. `u` is built from sin(2t), which
 * vanishes at BOTH 0 and pi/2 -- the two ways of being equidistant from the
 * diagonals -- so it cannot tell them apart, while the rounding can and breaks
 * them opposite ways. Away from that tie the two rules agree by construction:
 * thresholding sin(2t) at 0 and rounding t to the nearer diagonal are the same
 * test.
 *
 * @param {{theta:Float64Array, u:Float64Array}} orient  from cellOrientations
 * @param {Uint8Array} marked    which cells are inked
 * @param {Int32Array} order     traversal, cell indices
 * @param {number} mix           0 = round alone (identical to `field`), 1 = full
 * @returns {Float64Array} angle per cell; NaN where nothing is drawn
 */
export function diffuseAngles(orient, marked, order, mix) {
  const { theta, u } = orient;
  const out = new Float64Array(u.length).fill(NaN);
  const k = Math.min(1, Math.max(0, mix));
  let err = 0;
  for (let s = 0; s < order.length; s++) {
    const i = order[s];
    if (!marked[i]) continue;
    const want = u[i] + err;
    let pick;
    if (want > 0.5) pick = 1;
    else if (want < 0.5) pick = 0;
    else pick = Math.sin(2 * snapToDiagonal(theta[i])) >= 0 ? 1 : 0;
    err = (want - pick) * k;
    out[i] = pick ? T0 : T0 + Math.PI / 2;
  }
  return out;
}

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const LsegPx = segLengthPx(ctx);
  const { gx, gy, LxSeg, x0, y0 } = gridFor(ctx, LsegPx);
  const nCells = gx * gy;
  const rand = mulberry32(Math.round(ctx.seed ?? 1));

  // coarse image + cell centres. The MATLAB puts the first centre at LxSeg/2,
  // i.e. an origin of 0 rather than the 1-based pixel frame everything else
  // here uses; its demo hides that with a polygon of [0, nx+1]. Centre the grid
  // on [1, nx] instead so the strokes do not sit half a cell off the page.
  const imC = resize(ctx.im, gx, gy);
  const cx = new Float64Array(gx), cy = new Float64Array(gy);
  for (let ix = 0; ix < gx; ix++) cx[ix] = x0 + (ix + 0.5) * LxSeg;
  for (let iy = 0; iy < gy; iy++) cy[iy] = y0 + (iy + 0.5) * LxSeg;

  // Darkness per cell, whitened outside the region (MATLAB lines 54-56), then
  // converted to the MARKED FRACTION that renders that darkness. The dither
  // below reproduces its input as the fraction of cells inked, and a marked cell
  // renders at bar plus spill -- not at 1 -- so what it must be handed is p, not
  // K. See markFraction: this is where the ramps were coming back too dark.
  const { bar, cap } = coverageTerms(ctx);
  const K = new Float64Array(nCells);
  for (let iy = 0; iy < gy; iy++) {
    for (let ix = 0; ix < gx; ix++) {
      const i = iy * gx + ix;
      const inside = inpolygon(cx[ix], cy[iy], px, py);
      const v = inside ? Math.max(0, Math.min(1, imC.data[i])) : 1;
      K[i] = markFraction(1 - v, bar, cap);
    }
  }

  // ---- error diffusion in boustrophedon scan order.
  // The MATLAB offers a Hilbert traversal or a raster one; this port takes the
  // raster path, serpentined so the residual carried across a row end is picked
  // up by the cell physically next to it rather than by the far side of the
  // page. The 1e-9 jitter is the MATLAB's, kept so that a run of identical
  // cells does not always mark the same one.
  const order = new Int32Array(nCells);
  for (let iy = 0, k = 0; iy < gy; iy++) {
    const rev = iy % 2 === 1;
    for (let j = 0; j < gx; j++, k++) {
      order[k] = iy * gx + (rev ? gx - 1 - j : j);
    }
  }

  const cs = new Float64Array(nCells);
  let acc = 0;
  for (let k = 0; k < nCells; k++) {
    acc += K[order[k]] + rand() * 1e-9;
    cs[k] = acc;
  }

  // mark the cell at each integer crossing of the cumulative darkness.
  // MATLAB: s = interp1(cs, 1:n, ceil(cs(1)):floor(cs(end))); pts(floor(s)) = 1
  // -- floor of the interpolated index is the last cell whose sum is <= the
  // level, so the count of marks is exactly floor(cs(end)) - ceil(cs(1)) + 1.
  const marked = new Uint8Array(nCells);
  const vStart = Math.max(1, Math.ceil(cs[0]));
  const vEnd = Math.floor(cs[nCells - 1]);
  for (let v = vStart, k = 0; v <= vEnd; v++) {
    while (k + 1 < nCells && cs[k + 1] <= v) k++;
    marked[order[k]] = 1;
  }

  // ---- one diagonal per marked cell (MATLAB lines 96-113)
  //
  // `field` and `random` decide each cell on its own, in the draw loop. The
  // dithered mode has to see the whole marked set in traversal order, so it runs
  // here and the loop just reads its answer. It draws from the RNG not at all, so
  // its call sequence matches `field`'s -- only `random` consumes draws below,
  // and only for marked cells, exactly as before.
  const mode = ctx.angleSource ?? 'field';
  const orient = mode === 'random' ? null : cellOrientations(ctx, gx, gy);
  const ditherT = mode === 'dithered'
    ? diffuseAngles(orient, marked, order, ctx.angleMix ?? 1)
    : null;

  const half = (LxSeg / 2) * Math.SQRT2;          // half the cell diagonal = Lseg/2
  const segs = [];
  for (let iy = 0; iy < gy; iy++) {
    for (let ix = 0; ix < gx; ix++) {
      const i = iy * gx + ix;
      if (!marked[i]) continue;
      let t;
      if (ditherT) {
        t = ditherT[i];
      } else {
        const raw = orient ? orient.theta[i] : rand() * 2 * Math.PI;
        t = snapToDiagonal(raw);
      }
      const dx = Math.cos(t) * half, dy = Math.sin(t) * half;
      segs.push([cx[ix] - dx, cy[iy] - dy, cx[ix] + dx, cy[iy] + dy]);
    }
  }

  const trimmed = trimLineSegsToPolygon(segs, px, py);
  return trimmed.map((s) => [[s[0], s[1]], [s[2], s[3]]]);
}

export default { id, label, params, run, targetImage };
