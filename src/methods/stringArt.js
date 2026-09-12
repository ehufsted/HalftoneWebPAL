// Port of singleWidthLines/code/regionsStringArt.m, with the calibration the
// source leaves open.
//
// One continuous thread, stretched between nodes on the boundary. At each step
// the chord that covers the most remaining darkness is chosen, drawn, and its
// ink subtracted; repeat. That is all there is to it, and the result is the only
// method here whose drawing is a SINGLE closed stroke with no pen lifts at all.
//
// Three of the four node sets are rims -- circle, ellipse, page edge -- and the
// fourth, phyllotaxis, covers the whole page area instead, corners included. That
// one is a different-looking object: chords cross the middle of the page rather
// than spanning it, and it is the mode that most resembles tspTour's interior
// tour. Nothing in the search or the tone model assumes a rim; see nodesFor.
//
// Opacity is a search device, not a physical property. It sets
// wLine = wLine0/opacity, renders the chord at that wider width, and scales the
// result by opacity. The cross-section integral is wLine * opacity = wLine0, so
// the ink is exactly a pen stroke's worth — but spread over a band 1/opacity
// times wider.
//
// Why that matters: the greedy search scores a chord by the mean darkness along
// it. Against a hairline residual it would chase single-pixel features and lay
// strokes that miss them by half a pixel. Against a residual blurred to the band
// width it sees structure at the scale a thread can actually reproduce. Opacity
// is therefore a SMOOTHING LENGTH wearing the costume of a physical parameter,
// and the accounting stays exact either way because the integral is preserved.
//
// Departures from the source: the residual is taken against the MASKED image, so
// darkness outside the drawing polygon clears instead of attracting chords for
// ever; forbidden chords score -Infinity rather than 0, since 0 is a legitimate
// score and an exhausted residual would otherwise pick arbitrarily; and an edge
// is never drawn twice.
//
// The thread count means IMPROVING chords, and the edge set caps the budget. The
// patience rule lets the thread lay a deliberately useless chord to travel to a
// node with work at it, and charging that to the budget would make the slider
// mean "chords, some of which do nothing" and make the count `toneBand` predicts
// from disagree with the count the search delivers. Since an edge is never
// reused, the number of allowed node pairs is a hard ceiling on any run — 24
// nodes is 276 chords against a slider that reaches 6000 — so the budget is
// capped there rather than at the slider.

import { regionMask } from '../spine/mask.js';
import { affineTarget } from '../spine/tone.js';
import { clipPolyline } from '../spine/geometry.js';
import { interpTable } from '../spine/interp.js';
import { GOLDEN_ANGLE } from '../spine/lattice.js';
import { setNote } from '../spine/notes.js';

export const id = 'stringArt';
export const label = 'String art';

/**
 * The fraction of laid ink that lands where darkness was still owed.
 *
 * Chords cross, so some of what a thread lays falls on paper an earlier thread
 * already covered. Measured as absorbed/nominal over four runs: 0.7216, 0.6553,
 * 0.7390, 0.6889 -- mean 0.70, spread +-7%.
 *
 * It drifts with the image, understandably: the higher values are the darker
 * images, because more residual means more of each chord finds something to
 * absorb it. In the limit of a black page it would tend to 1; on a nearly white
 * one the few chords drawn overshoot more of their length. A 7% band around 0.70
 * covers the useful range, and the harness scores that spread so a wider drift is
 * reported rather than absorbed.
 *
 * Two ratios can be formed and they are not the same number:
 *
 *   absorbed / nominal            over ALL chords laid, travel included
 *   absorbed / (drawn * Lbar * w) over the chords the budget is allowed to count
 *
 * `toneBand` multiplies by the thread count, which counts improving chords only,
 * so it consumes the second. The two coincide while travel chords are rare, which
 * is the regime the band matters in — a run that fills its budget is by
 * definition one that kept finding useful chords. The harness reports both side
 * by side; if they separate, this constant is the one that moves.
 */
export const STRING_KAPPA = 0.70;

// There is deliberately no per-mode chord-length correction, because it is not a
// constant. The budget wants the mean length of the chords actually DRAWN; the
// only thing computable in advance is the mean over every allowed pair. Measured,
// the ratio between them is 1.05/1.04 on a circle and 0.93/1.31 on a perimeter,
// where the perimeter rows are ordered by chord count. The mean drawn length
// falls as a run gets longer — the greedy takes the long chords that cross the
// picture first, the used-edge rule retires them, and what is left is
// progressively shorter — so the ratio depends on how far into its budget a run
// has got, which no constant can express.
//
// The unweighted mean is kept as the estimate, good to about 5% on a circle and
// 20% on a perimeter, which is enough for what the budget is for; see toneBand.

export const params = [
  {
    key: 'nodeMode', label: 'Nodes on', type: 'select', def: 'circle',
    options: [
      { value: 'circle', label: 'Inscribed circle' },
      { value: 'ellipse', label: 'Inscribed ellipse' },
      { value: 'perimeter', label: 'Page edge' },
      { value: 'phyllotaxis', label: 'Phyllotaxis (fills the page)' },
    ],
  },
  { key: 'nNodes', label: 'Nodes', type: 'range', min: 24, max: 400, step: 4, def: 180 },
  { key: 'nLines', label: 'Threads', type: 'range', min: 50, max: 2000, step: 50, def: 1000 },
  // Presented the other way up from the quantity the search uses. Internally
  // `opacity` is a smoothing length: a LOW value spreads each chord's ink over a
  // wide band and lets the search chase the residual further, so it draws more
  // threads. Read as "how solid does one thread look", that is backwards — a
  // fainter thread should need more of them, not fewer. The slider is therefore
  // the reflection, `opacity = OPACITY_SPAN - value`, and `settingsOf` undoes it.
  // The internal key is still honoured when passed directly, so the harness can
  // work in the quantity the tone model is written in.
  { key: 'threadOpacity', label: 'Thread opacity', type: 'range', min: 0.05, max: 1, step: 0.05, def: 0.8 },
  // As a fraction of the smaller image dimension, as the source has it. Without
  // it the greedy takes tiny chords between adjacent nodes, which are cheap
  // darkness per unit length and produce a solid rim. Kept at 0.2 and not
  // offered: below about 0.1 the rim appears, and above it the thread loses the
  // shorter chords it needs to work the middle of the picture.
  { key: 'LminFrac', label: 'Shortest chord', type: 'range', min: 0, max: 0.6, step: 0.02, def: 0.1, unit: '×page',
    when: () => false },
  // Off by default, which is the calibrated setting. See spendAll in buildThread:
  // this trades tone for thread, and is a look control.
  { key: 'spendAll', label: 'Spend every thread', type: 'checkbox', def: false },
];

/**
 * Slider ends added together. Reflecting about this maps the control's range onto
 * itself, so the two ends swap and the middle stays put.
 */
const OPACITY_SPAN = 1.05;

function settingsOf(ctx) {
  // `opacity` wins when given, so the harness and any existing link keep working
  // in the quantity the tone model is written in; the slider arrives as
  // `threadOpacity` and is reflected. See the param for why it is presented
  // upside down.
  const opacity = ctx.opacity ?? (OPACITY_SPAN - (ctx.threadOpacity ?? 0.8));
  return {
    np: Math.max(8, Math.round(ctx.nNodes ?? 180)),
    nLines: Math.max(1, Math.round(ctx.nLines ?? 1000)),
    opacity: Math.min(1, Math.max(0.02, opacity)),
    LminFrac: Math.max(0, ctx.LminFrac ?? 0.2),
    spendAll: ctx.spendAll === true,
  };
}

/**
 * The polygon's bounding box, as a centre and two half-extents.
 *
 * Read as radii these are the inscribed ellipse, the one touching all four sides;
 * read as half-widths they are the page rectangle itself. `ellipseNodes` wants the
 * first, `phyllotaxisNodes` the second, and they are the same four numbers.
 */
function pageBox(ctx) {
  const { px, py } = ctx.polygon;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < px.length; i++) {
    if (px[i] < x0) x0 = px[i];
    if (px[i] > x1) x1 = px[i];
    if (py[i] < y0) y0 = py[i];
    if (py[i] > y1) y1 = py[i];
  }
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    rx: (x1 - x0) / 2,
    ry: (y1 - y0) / 2,
  };
}

/**
 * Nodes evenly spaced round an ellipse BY ARC LENGTH, not by parameter.
 *
 * Stepping the parameter evenly does not step the rim evenly: the speed
 * |dP/da| = hypot(rx sin a, ry cos a) runs from ry at the ends of the major axis
 * to rx at the ends of the minor one, so on an A5 page's 1.41 ratio the node
 * spacing would vary by the same 41% and bunch at the two sharp ends. Every other
 * node set here is uniform, and the chord-length distribution -- which is what
 * `allowedChords` averages and `toneBand` spends -- should not depend on which
 * way up the page is.
 *
 * So: tabulate cumulative arc length by the midpoint rule, then invert it at even
 * spacings, using the shared monotone-table inverse. The circle mode does not
 * come through here -- see nodesFor.
 */
function ellipseNodes({ cx, cy, rx, ry }, np) {
  const S = Math.max(256, np * 8);
  const a = new Float64Array(S + 1);
  const s = new Float64Array(S + 1);
  for (let i = 1; i <= S; i++) {
    const a0 = (2 * Math.PI * (i - 1)) / S, a1 = (2 * Math.PI * i) / S;
    const mid = (a0 + a1) / 2;
    a[i] = a1;
    s[i] = s[i - 1] + Math.hypot(rx * Math.sin(mid), ry * Math.cos(mid)) * (a1 - a0);
  }
  const total = s[S];
  const x = new Float64Array(np), y = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    const t = interpTable(s, a, (total * i) / np);
    x[i] = cx + rx * Math.cos(t);
    y[i] = cy + ry * Math.sin(t);
  }
  return { x, y };
}

/**
 * Nodes on a Vogel spiral, CROPPED to the page rather than fitted to it.
 *
 * The only node set that is not a rim, which is the point of it: chords cross the
 * interior instead of spanning it, and the web has depth rather than being a
 * single shell.
 *
 * The spiral is grown at its true proportions and points outside the rectangle
 * are discarded, so what lands on the page is a real sunflower head with the page
 * cut out of it -- corners included. Squeezing a disc's worth of points into the
 * rectangle instead would reach the corners too, but only by warping the spiral
 * where it is most visible, and the golden-angle arrangement is the whole reason
 * to have this mode.
 *
 * `r = c*sqrt(i + 0.5)` is the radius law that gives uniform AREA density, so
 * each point owns pi*c^2 and `np` of them over a page of area 4*rx*ry needs
 * c = sqrt(4*rx*ry / (pi*np)). Growing until `np` have landed inside then fills
 * the page at the density asked for. The half-integer offset is
 * `latticeInDisc`'s, for its reason: at i = 0 a plain index would put a node
 * exactly at the centre, a singularity for anything radial and a blob where every
 * chord would converge.
 *
 * `LminFrac` does more work here than on a rim -- interior points produce far
 * more short pairs, and those are exactly the chords that would scribble in one
 * spot.
 */
function phyllotaxisNodes({ cx, cy, rx, ry }, np) {
  const area = 4 * rx * ry;
  const c = Math.sqrt(area / (Math.PI * np));
  const x = new Float64Array(np), y = new Float64Array(np);

  // The spiral has to reach hypot(rx, ry) before the corners are covered, so the
  // number generated exceeds the number kept by the disc-to-rectangle area ratio
  // -- pi/2 on a square page, and worse the more elongated it is. The cap is that
  // ratio with room to spare: loose enough never to bind on a real page, and a
  // stop for a degenerate one where rx or ry is zero and nothing ever lands.
  const expect = area > 0
    ? (Math.PI * (rx * rx + ry * ry) * np) / area
    : 0;
  const cap = Math.ceil(Math.max(4 * np, 4 * expect)) + 256;

  let n = 0;
  for (let i = 0; n < np && i < cap; i++) {
    const r = c * Math.sqrt(i + 0.5);
    const t = (i + 0.5) * GOLDEN_ANGLE;
    const dx = r * Math.cos(t), dy = r * Math.sin(t);
    if (Math.abs(dx) > rx || Math.abs(dy) > ry) continue;
    x[n] = cx + dx;
    y[n] = cy + dy;
    n++;
  }
  // Only reachable on a degenerate page. The centre is at least on the paper,
  // where a left-over zero would put the node in the top-left corner of the
  // coordinate system; coincident nodes make zero-length chords, which `Lmin`
  // discards anyway.
  for (let i = n; i < np; i++) { x[i] = cx; y[i] = cy; }
  return { x, y };
}

/**
 * Node positions. Four sets, three of them rims.
 *
 * `circle` is the largest circle inside the polygon's bounding box — the classic
 * string-art form, which leaves the corners of a rectangular page blank, and that
 * is the point of it. `ellipse` opens that out to fill the page in both axes.
 * `perimeter` spaces nodes by ARC LENGTH round the drawing polygon, so a
 * rectangle gets more of them on its long sides and the density stays uniform per
 * unit of boundary. `phyllotaxis` is the odd one out and covers the whole page
 * area, corners included, rather than any rim; see its own note.
 *
 * All four work off the polygon's BOUNDING BOX, so on a non-rectangular drawing
 * polygon a node can sit outside it. That is already true of the circle, and
 * harmless: `capacityMap` masks to the region and `run` clips the thread to it.
 */
export function nodesFor(ctx, mode, np) {
  const { px, py } = ctx.polygon;
  if (mode !== 'perimeter') {
    const e = pageBox(ctx);
    if (mode === 'phyllotaxis') return phyllotaxisNodes(e, np);
    if (mode === 'ellipse') return ellipseNodes(e, np);
    // The circle keeps its own even angular step rather than routing through
    // `ellipseNodes` with equal radii. The two agree to within rounding, and
    // rounding is enough: the greedy picks a chord by comparing means, so a
    // last-bit difference flips which one wins and the whole thread diverges
    // from there. Every measured number in this file was taken against these
    // coordinates. An unrecognised mode lands here too, which leaves a
    // hand-edited hash on the default rather than on an error.
    const r = Math.min(e.rx, e.ry);
    const x = new Float64Array(np), y = new Float64Array(np);
    for (let i = 0; i < np; i++) {
      const a = (2 * Math.PI * i) / np;
      x[i] = e.cx + r * Math.cos(a);
      y[i] = e.cy + r * Math.sin(a);
    }
    return { x, y };
  }
  // arc-length parameterisation of the closed polygon
  const n = px.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(px[j] - px[i], py[j] - py[i]);
  }
  const total = cum[n];
  const x = new Float64Array(np), y = new Float64Array(np);
  let seg = 0;
  for (let i = 0; i < np; i++) {
    const s = (total * i) / np;
    while (seg < n - 1 && cum[seg + 1] < s) seg++;
    const t = (s - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    const j = (seg + 1) % n;
    x[i] = px[seg] + (px[j] - px[seg]) * t;
    y[i] = py[seg] + (py[j] - py[seg]) * t;
  }
  return { x, y };
}

/**
 * The chords the search is allowed to use: their mean length, and how many there
 * are.
 *
 * An edge is never drawn twice, so the count is a hard ceiling on the length of
 * any run — and the sliders let you ask for twenty times it (24 nodes is at most
 * 276 pairs; the thread control goes to 6000). See toneBand.
 */
export function allowedChords(nodes, Lmin) {
  const { x, y } = nodes;
  const np = x.length;
  let sum = 0, count = 0;
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      const L = Math.hypot(x[j] - x[i], y[j] - y[i]);
      if (L < Lmin) continue;
      sum += L; count++;
    }
  }
  return { mean: count > 0 ? sum / count : 0, count };
}

/** Mean length of the chords the search is allowed to use. */
export function meanChordLength(nodes, Lmin) {
  return allowedChords(nodes, Lmin).mean;
}

/**
 * The reachable band, which for this method is a global ink budget rather than a
 * per-pixel limit.
 *
 * A thread budget of `nLines` chords of mean length Lbar, drawn at pen width w,
 * can lay at most `kappa * nLines * Lbar * w` of ink. The image asks for
 * `sum(1 - B)` over the drawing polygon. If it asks for more than the budget,
 * every tone has to be lightened by the ratio between them.
 *
 * White stays white, which makes this a scaling of darkness rather than the usual
 * squeeze between two endpoints. String art has no unavoidable ink: on
 * a white target the residual is zero everywhere, the gain floor stops the search
 * at once, and nothing is drawn. It is the DARK end that the budget limits. So
 * the band is [1 - s, 1] with s the ratio above, which affineTarget expresses as
 * an ordinary affine map because 1 - (1-B)s is affine in B.
 *
 * The band therefore depends on the IMAGE as well as the settings, which is
 * unusual here and follows from the constraint being on the total rather than on
 * any single pixel.
 *
 * The thread count is not the only ceiling. An edge is never drawn twice, so a
 * run can lay at most `count` chords whatever the slider says, and the sliders
 * allow 6000 threads against 24 nodes, where at most 276 pairs exist and fewer
 * survive Lmin. Uncapped, the budget in that regime exceeds anything the image
 * asks for, `s` clamps to 1, the band opens to [0,1], and targetImage hands back
 * the raw image — scoring the method against a picture it cannot draw, which is
 * the exact failure targetImage exists to prevent. The cap is a count of the
 * edges that exist, not a fit.
 *
 * `spendAll` does not enter here, and should not. The band is an UPPER bound on
 * what the threads could absorb; the toggle spends the same budget on chords that
 * absorb less, so the drawing falls further below the bound rather than reaching
 * past it. The bound stays true, and the gap it opens is the toggle's tone cost
 * showing up where it belongs -- in fidelity, not in the claim about reach.
 */
export function toneBand(ctx) {
  const { np, nLines, LminFrac } = settingsOf(ctx);
  const nodes = nodesFor(ctx, ctx.nodeMode ?? 'circle', np);
  const Lmin = LminFrac * Math.min(ctx.nx, ctx.ny);
  const mode = ctx.nodeMode ?? 'circle';
  const { mean: Lbar, count } = allowedChords(nodes, Lmin);
  const budget = STRING_KAPPA * Math.min(nLines, count) * Lbar * ctx.w;

  // Only the reachable part counts toward the budget: ink cannot be spent
  // outside the node hull, so darkness there is not a demand the budget has to
  // meet and counting it would lighten the whole picture for no reason.
  const cap = capacityMap(ctx, mode);
  let wanted = 0;
  for (let i = 0; i < cap.length; i++) {
    if (cap[i] > 0) wanted += 1 - Math.min(1, Math.max(0, ctx.im.data[i]));
  }
  const s = wanted > 1e-9 ? Math.min(1, budget / wanted) : 1;
  return { min: 1 - s, max: 1 };
}

/**
 * Consecutive non-improving chords the thread may draw before the run ends.
 *
 * One, and the completeness of the chord graph is the argument: every node is one
 * move from every other, so a single step is all it can ever take to reach work
 * that exists. Anything beyond that is wandering, and every wandering step lays a
 * full chord of ink somewhere already satisfied.
 *
 * Measured at 4: the dark strip of a linear ramp gains 0.011 of coverage while
 * the light end loses up to 0.154, and the RMS goes the wrong way. The radial ramp
 * improves, because there the dark region is the centre and travelling THROUGH it
 * is useful — the tell that 4 buys luck on one image and damage on another rather
 * than fixing anything.
 *
 * The `spendAll` param is the same knob turned all the way up, offered as a look
 * control with the tone cost stated rather than as a better default. This
 * constant is what governs the calibrated path.
 */
const PATIENCE = 1;

/** Cell size for the capacity grid, in pixels. Coarser than the pen, so a cell
 *  holds several strokes' worth and the count is a density rather than a hit. */
const CAP_CELL = 4;
let capCache = null;

/**
 * The darkest each part of the page can possibly be made.
 *
 * Reach is not a yes or no — it is the total length of DISTINCT chords passing
 * through a region. Near the edge of a perimeter node ring that is a small
 * number: only a handful of node pairs make a chord running close to and along
 * one edge, so a narrow strip there has a hard ceiling on how dark it can get,
 * well short of black. (A boolean inside/outside test catches only the obvious
 * case, that no chord from an inscribed circle reaches the page corners.)
 *
 * That ceiling belongs in the target, and cannot be got around by drawing an edge
 * twice: this is a pen, and paper that is already black does not get blacker,
 * which is why the search refuses to repeat an edge.
 *
 * Every allowed chord is walked once and its length accumulated into a coarse
 * grid; the capacity of a cell is the ink all of them together would lay in it,
 * capped at solid. Cached, because it depends only on the node geometry and the
 * page -- not on the image.
 */
export function capacityMap(ctx, mode) {
  const { nx, ny, w } = ctx;
  const { np, LminFrac } = settingsOf(ctx);
  const key = `${nx}|${ny}|${w}|${mode}|${np}|${LminFrac}`;
  if (capCache && capCache.key === key) return capCache.value;

  const nodes = nodesFor(ctx, mode, np);
  const { x, y } = nodes;
  const Lmin = LminFrac * Math.min(nx, ny);
  const gw = Math.ceil(nx / CAP_CELL), gh = Math.ceil(ny / CAP_CELL);
  const acc = new Float64Array(gw * gh);

  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      const dx = x[j] - x[i], dy = y[j] - y[i];
      const L = Math.hypot(dx, dy);
      if (L < Lmin) continue;
      const ns = Math.max(2, Math.ceil(L));
      const sx = dx / (ns - 1), sy = dy / (ns - 1);
      const per = L / ns;                       // chord length each sample stands for
      let px = x[i], py = y[i];
      for (let k = 0; k < ns; k++, px += sx, py += sy) {
        const gx = ((px - 1) / CAP_CELL) | 0, gy = ((py - 1) / CAP_CELL) | 0;
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        acc[gy * gw + gx] += per;
      }
    }
  }

  const cellArea = CAP_CELL * CAP_CELL;
  const base = regionMask(ctx);
  const cap = new Float64Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    const g0 = ((iy / CAP_CELL) | 0) * gw;
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!base[c]) continue;
      cap[c] = Math.min(1, (acc[g0 + ((ix / CAP_CELL) | 0)] * w) / cellArea);
    }
  }
  capCache = { key, value: cap };
  return cap;
}

export function targetImage(ctx) {
  const img = affineTarget(ctx, toneBand(ctx));
  const cap = capacityMap(ctx, ctx.nodeMode ?? 'circle');
  for (let i = 0; i < img.data.length; i++) {
    // The darkest reachable brightness; 1 where no chord passes at all.
    const floorB = 1 - cap[i];
    if (img.data[i] < floorB) img.data[i] = floorB;
  }
  return img;
}

/**
 * The thread, as an ordered list of node indices.
 *
 * Exported so the harness can measure the search directly -- how many chords it
 * actually laid, what stopped it, how much ink it accounted for -- rather than
 * inferring any of that from a rendered picture.
 */
export function buildThread(ctx) {
  const { nx, ny, w } = ctx;
  const { np, nLines, opacity, LminFrac, spendAll } = settingsOf(ctx);
  const nodes = nodesFor(ctx, ctx.nodeMode ?? 'circle', np);
  const { x: nxs, y: nys } = nodes;
  const Lmin = LminFrac * Math.min(nx, ny);
  const cap = capacityMap(ctx, ctx.nodeMode ?? 'circle');
  const tgt = targetImage(ctx);

  // Residual darkness still to be covered, masked to zero outside the polygon so
  // those pixels do not pull chords toward them for the whole run.
  //
  // Aimed half a quantum dark, which is derived rather than a nudge. Matching
  // pursuit with a fixed quantum stops where laying another does as much harm as
  // good, which for a residual r is r = opacity/2 — true whether or not the
  // residual is clamped, since the gain 2r - opacity changes sign there either
  // way. So the search always halts with opacity/2 of coverage still owed,
  // everywhere at once. Measured: the ramps came out 0.143 and 0.145 of
  // brightness light at opacity 0.25, against a predicted 0.125.
  //
  // Inflating the target by exactly that much moves the halt onto the real
  // target instead. WHITE IS UNAFFECTED, which is what makes the correction safe:
  // a white pixel starts at opacity/2, its gain is exactly zero, so it is never
  // sought and never avoided, and the run still stops with nothing drawn.
  const aim = opacity / 2;
  const resid = new Float64Array(nx * ny);
  for (let i = 0; i < resid.length; i++) {
    resid[i] = cap[i] > 0 ? Math.min(1, Math.max(0, 1 - tgt.data[i])) + aim : 0;
  }

  // The band the ink is spread over, and the amplitude within it. Their product
  // is w, so the accounting is a pen stroke's worth however opacity is set.
  const band = w / opacity;
  const rBand = band / 2;

  // The floor is zero, which letting the residual go negative is what allows.
  //
  // Clamping the residual at zero, as the source does, forces a stop at the
  // per-pixel break-even point opacity/2 — and stopping there leaves EVERY part
  // of the picture short by opacity/2 of coverage. Measured at opacity 0.25, the
  // ramps came out 0.143 and 0.145 of brightness too light against a prediction
  // of 0.125.
  //
  // With the residual pinned at zero an
  // over-inked region looks merely satisfied rather than overshot, so no chord
  // ever scores negative and nothing stops the search except an arbitrary
  // threshold. Signed, a chord that would overshoot scores below zero on its own
  // and the stopping rule needs no constant at all: stop when the best chord has
  // no positive residual left to cover, which is exactly when the ink laid
  // equals the ink wanted.
  const floor = 0;

  const used = new Uint8Array(np * np);
  const order = [0];
  let at = 0;
  let laidInk = 0, nominalInk = 0;
  let patience = 0;
  // The budget counts chords that improved the picture, not steps taken. The
  // travel chord the patience rule permits is deliberately non-improving, laid
  // only to reach a node with useful edges, and toneBand predicts ABSORBED ink,
  // which such a chord contributes almost none of — so charging it to the budget
  // would make `nLines` mean "chords laid, some of which do nothing" and make
  // toneBand's count disagree with the search's.
  //
  // The run still terminates: each pass either increments `drawn` (bounded by
  // nLines) or `patience` (which breaks at PATIENCE + 1 in a row), so the step
  // count cannot exceed nLines * (PATIENCE + 1).
  let drawn = 0;                       // chords that improved the picture
  let chords = 0;                      // chords laid, travel included

  // `spendAll` removes the patience exit: when no chord improves the picture the
  // thread takes the least-bad one and carries on rather than ending the run.
  //
  // What it costs: a non-improving chord overshoots on balance, so this trades
  // tone for thread, measured at +0.011 of coverage at the dark end of a linear
  // ramp against up to -0.154 at the light end. It is here because the drawing it
  // produces is a different and sometimes better-looking object — a denser web
  // that keeps working the page — not because it is more accurate.
  //
  // The ordering below protects it: the 'picture satisfied' test runs FIRST and
  // is not conditioned on the toggle, so a white page exits on the first pass
  // with nothing drawn either way. Without that, spendAll on white would lay its
  // whole budget across blank paper.
  //
  // It stays bounded because with the patience exit gone `drawn` can stop rising,
  // so the chord ceiling ends the loop instead: with the toggle on, nLines counts
  // chords LAID. Either way no run can outlast the edge set, since each pass
  // consumes one and none is reused.
  const chordCap = spendAll ? nLines : Infinity;
  // Darkness still genuinely owed, tracked incrementally so the stopping rule
  // can tell "no useful chord HERE" from "nothing left to do anywhere".
  let owed = 0;
  for (let i = 0; i < resid.length; i++) owed += Math.max(0, resid[i] - aim);
  const owed0 = owed;
  let stoppedBy = 'budget';

  while (drawn < nLines && chords < chordCap) {
    let best = -Infinity, bestJ = -1;
    for (let j = 0; j < np; j++) {
      if (j === at) continue;
      if (used[at * np + j]) continue;
      const dx = nxs[j] - nxs[at], dy = nys[j] - nys[at];
      const L = Math.hypot(dx, dy);
      if (L < Lmin) continue;
      // The hot loop of the whole method: np chords per step, each walked at one
      // sample per pixel. Stepping by an increment rather than recomputing
      // t = k/(ns-1) removes a division per sample, and `(v - 0.5) | 0` is
      // round(v) - 1 for the positive coordinates this always has.
      const ns = Math.max(2, Math.ceil(L));
      const sx = dx / (ns - 1), sy = dy / (ns - 1);
      let px = nxs[at], py = nys[at];
      let sum = 0;
      for (let k = 0; k < ns; k++, px += sx, py += sy) {
        const jx = (px - 0.5) | 0, iy = (py - 0.5) | 0;
        // Off-image samples count as zero rather than being dropped: dropping
        // them shortens the denominator and inflates the mean for any chord that
        // leaves the raster.
        if (jx < 0 || iy < 0 || jx >= nx || iy >= ny) continue;
        const r = resid[iy * nx + jx];
        // The score is the error this chord would REMOVE, not the darkness it
        // would pass through. Laying `opacity` where the residual is r changes
        // the error from |r| to |r - opacity|, a gain of
        // clamp(2r - opacity, -opacity, +opacity).
        //
        // Both clamps matter and the lower one is the reason for the change. The
        // source scores by mean residual, which is unbounded below once the
        // residual is allowed to go negative, so a deeply over-inked region can
        // outvote an entire under-inked one on the same chord -- and a chord can
        // only ever lay `opacity`, so it can only ever do `opacity` of harm.
        // Measured with the unbounded score, a radial ramp came out uniformly
        // light because chords serving the outer ring were vetoed by a centre
        // they had already saturated.
        const g = 2 * r - opacity;
        sum += g > opacity ? opacity : (g < -opacity ? -opacity : g);
      }
      const score = sum / ns;
      // ties on node index, so the thread is reproducible
      if (score > best) { best = score; bestJ = j; }
    }
    if (bestJ < 0) { stoppedBy = 'no chord available'; break; }
    // The thread is a walk, not a selection: only chords incident to the CURRENT
    // node are available, so once the useful edges at a node are spent the thread
    // has to travel, and travelling costs a chord that inks somewhere already
    // satisfied. Stopping on the first non-improving chord means never being able
    // to pay that fare — measured, the darkest strip of a linear ramp finished at
    // 0.685 coverage against a reachable 0.951.
    //
    // A few moves of slack is enough because the chord graph is complete: any
    // node is one move from any other, so the thread only needs to survive the
    // handful of steps it takes to shake off a node whose good edges are spent.
    // Every such move is the least-bad one available rather than an arbitrary one.
    if (best <= floor) {
      // Nothing owed means nothing to travel towards; without this a white page
      // comes back with PATIENCE chords laid across blank paper. Not conditioned
      // on spendAll, which is that toggle's whole safety margin: "keep drawing
      // when nothing improves" must not become "draw on a page that asked for
      // nothing".
      if (owed <= owed0 * 0.005) { stoppedBy = 'picture satisfied'; break; }
      if (!spendAll) {
        patience++;
        if (patience > PATIENCE) { stoppedBy = 'no useful chord left'; break; }
      }
    } else {
      patience = 0;
      drawn++;
    }
    chords++;

    // stamp the ink, over the chord's bounding box only
    const ax = nxs[at], ay = nys[at], bx = nxs[bestJ], by = nys[bestJ];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const j0 = Math.max(0, Math.floor(Math.min(ax, bx) - rBand) - 1);
    const j1 = Math.min(nx - 1, Math.ceil(Math.max(ax, bx) + rBand) - 1);
    const i0 = Math.max(0, Math.floor(Math.min(ay, by) - rBand) - 1);
    const i1 = Math.min(ny - 1, Math.ceil(Math.max(ay, by) + rBand) - 1);
    for (let iy = i0; iy <= i1; iy++) {
      const py = iy + 1;
      for (let jx = j0; jx <= j1; jx++) {
        const px = jx + 1;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const qx = ax + dx * t, qy = ay + dy * t;
        if ((px - qx) ** 2 + (py - qy) ** 2 > rBand * rBand) continue;
        const c = iy * nx + jx;
        // Two different quantities: `nominal` is the ink the pen puts on the
        // paper whether or not anything wanted it, `absorbed` the part that met
        // residual darkness still owing. Their ratio is STRING_KAPPA.
        //
        // The residual itself is not clamped; see the note on the floor above.
        nominalInk += opacity;
        // Measured against the TRUE residual, so the aim offset above does not
        // count itself as darkness absorbed and inflate STRING_KAPPA. The same
        // difference draws down `owed`, so the two can never disagree about how
        // much darkness this chord actually met.
        const before = Math.max(0, resid[c] - aim);
        resid[c] -= opacity;
        const met = before - Math.max(0, resid[c] - aim);
        laidInk += met;
        owed -= met;
      }
    }

    used[at * np + bestJ] = 1;
    used[bestJ * np + at] = 1;
    order.push(bestJ);
    at = bestJ;
  }

  return {
    order, nodes, laidInk, nominalInk, stoppedBy,
    // `lines` stays the TOTAL laid, travel included, because that is what every
    // length and ink figure in the harness is measured against. `drawn` is the
    // budget quantity -- the two differ by the travel chords, and the gap is
    // itself worth watching: a run with many more lines than drawn is one whose
    // greedy keeps stranding itself.
    lines: chords, drawn, Lmin, nLines, spendAll,
  };
}

export function run(ctx) {
  const { px, py } = ctx.polygon;
  const built = buildThread(ctx);
  if (!built) return [];

  // Why this method reports and most do not: it has four ways to stop and they
  // want different responses from the user: 'budget' means add threads, 'picture
  // satisfied' means the drawing is done and the extra threads are free, and the
  // other two mean the thread stranded itself with darkness still owed. All four
  // present identically in the tone error -- a light drawing -- so without the
  // reason the number is uninterpretable. The travel count is here for the same
  // reason: it is the difference between a thread working and a thread wandering,
  // and with "spend every thread" on it is the whole point of the setting.
  const wasted = built.lines - built.drawn;
  setNote(
    (wasted > 0
      ? `${built.drawn} useful of ${built.lines} threads`
      : `${built.drawn}/${built.nLines} threads`) +
    ` — ${built.stoppedBy}`
  );

  // A zero-chord run is a legitimate outcome -- a white page asks for nothing --
  // and the note above has already said so, which is the difference between an
  // empty canvas that is correct and one that looks broken.
  if (built.order.length < 2) return [];
  const { order, nodes } = built;
  const pts = order.map((i) => [nodes.x[i], nodes.y[i]]);
  // One polyline: the thread is continuous by construction, and handing the
  // optimiser a single stroke is the whole point of the method. Clipped only
  // because a non-convex drawing polygon can let a chord leave and re-enter.
  return clipPolyline(pts, px, py);
}

export default { id, label, params, run, targetImage };
