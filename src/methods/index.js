// Method registry. Adding another means dropping a
// module in here that exports { id, label, params, run(ctx) } -- the UI builds
// its controls from `params` and the worker just calls `run`.
//
// ALSO EXPORT targetImage(ctx) IF THE METHOD CANNOT REACH EVERY TONE. Without
// it the worker scores the drawing against the source image, which permanently
// condemns every band-limited method for a shortfall that is its specification
// rather than its error. See docs/architecture.md and spine/tone.js.
//
// ALSO EXPORT rotationParam (a string, the key of one of its own `params`) IF
// THE METHOD HAS A SINGLE PARAM THAT IS ITS ORIENTATION. CMYK's "rotate/shift
// each layer" checkbox uses it to spread the four channels across the classic
// print-screen angles instead of stacking them at the same one; see
// channelVariation()/paramsForChannel() below. ALSO EXPORT rotationPeriod
// (params) => number IF THAT PARAM'S DECLARED min/max RANGE ISN'T ITS ACTUAL
// VISUAL PERIOD (ditherGrid's `angleDeg` runs 0-90 for one slider serving two
// lattices, but a hex lattice only repeats every 60°) -- without it, the
// rosette is scaled by the wrong period and can put two channels back on the
// same apparent orientation.
//
// A `seed` param THAT IS SOMETIMES INERT should say so, one of two ways: give
// it its own `when(params)` if hiding the control is also correct (the usual
// case -- meshEdges/treeEdges/stippleGrowing already do this for their own
// UI reasons, and channelVariation() below reads the same gate); ALSO EXPORT
// seedMatters(params) if the control should stay visible but is inert under
// some OTHER param's value (tenPrintHatching's seed is dead unless angleSource
// is 'random'; ditherGrid's is dead except in threshold/random/dbs mode).
// Without one of these, the checkbox would silently claim to vary a method
// that is, at its current settings, completely deterministic.

import parallelHatching from './parallelHatching.js';
import crosshatchQuantized from './crosshatchQuantized.js';
import dashHatching from './dashHatching.js';
import splitMerge from './splitMerge.js';
import tenPrintHatching from './tenPrintHatching.js';
import wigglyLines from './wigglyLines.js';
import planeWaves from './planeWaves.js';
import eikonalStripes from './eikonalStripes.js';
import streamlines from './streamlines.js';
import dashedStreamlines from './dashedStreamlines.js';
import triStripes from './triStripes.js';
import refiningNoise from './refiningNoise.js';
import stippleGrowing from './stippleGrowing.js';
import segmentStipple from './segmentStipple.js';
import ditherGrid from './ditherGrid.js';
import radialRemap from './radialRemap.js';
import circlePacking from './circlePacking.js';
import lappingShapes from './lappingShapes.js';
import meshEdges from './meshEdges.js';
import treeEdges from './treeEdges.js';
import stringArt from './stringArt.js';
import tspTour from './tspTour.js';
import sfcCollapse from './sfcCollapse.js';
import quadHalftone from './quadHalftone.js';
import polygonSubdivision from './polygonSubdivision.js';

/**
 * The picker, grouped by the kind of mark and with a line of prose each.
 *
 * THE GROUPING IS DATA NOW, not a comment. It used to be three comment lines in
 * a flat array, which meant the dropdown showed twenty-five entries in a row and
 * only this file knew they fell into five families. Names alone are nearly
 * meaningless in a picker, so the grouping is most of what helps someone find
 * the method they want -- and someone who likes one of these usually wants the
 * one beside it.
 *
 * The groups run from the most constrained mark to the least, each handing over
 * to the next: hatching's carriers start to bend, the bending stripes give way
 * to discrete marks, the marks acquire connections, and the connections collapse
 * to a single stroke.
 *
 * THE BLURB SITS HERE RATHER THAN IN THE MODULE, beside `label`, because the
 * shape of this list is what makes it impossible to add a method to the picker
 * without describing it. It is picker copy, one line, and it is written from the
 * module header -- if the two ever disagree the header is right, since that is
 * the primary record. What it is NOT is a summary of the tone model; it answers
 * "what will this look like", which is the only question a picker is asked.
 *
 * METHODS[0] is the app's default (`app.js` seeds `state` from it), so parallel
 * hatching stays first — the simplest method here and the one whose controls
 * read most obviously.
 */
export const METHOD_GROUPS = [
  {
    name: 'Ruled lines',
    methods: [
      { method: parallelHatching,
        blurb: 'Straight parallel lines, drawn or skipped to make the tone.' },
      { method: crosshatchQuantized,
        blurb: 'Layers of hatching at set angles; tone from how many overlap.' },
      { method: dashHatching,
        blurb: 'Fixed carriers, with the tone in what fraction of each is inked.' },
      { method: splitMerge,
        blurb: 'Lines that split where the picture darkens and merge where it lightens.' },
      { method: tenPrintHatching,
        blurb: 'One diagonal per cell — the 10 PRINT maze, thinned to the tone.' },
    ],
  },
  {
    name: 'Stripes that follow the image',
    methods: [
      { method: wigglyLines,
        blurb: 'Carriers that wobble, with the tone in the wavelength or the amplitude.' },
      { method: planeWaves,
        blurb: 'The page cut into regions, each filled with straight stripes at its own angle.' },
      { method: eikonalStripes,
        blurb: 'Stripes as level sets of a distance field, so they never cross or dead-end.' },
      { method: streamlines,
        blurb: 'Evenly spaced lines that follow the image’s own direction field.' },
      { method: dashedStreamlines,
        blurb: 'Those lines at a constant separation, with the tone carried in dashes.' },
      { method: triStripes,
        blurb: 'Stripes continuous across a mesh, ending only where the field turns back.' },
      { method: refiningNoise,
        blurb: 'Contours of a noise field, its wavelength set by the tone.' },
    ],
  },
  {
    name: 'Discrete marks',
    methods: [
      { method: stippleGrowing,
        blurb: 'Dots at the density the image asks for; four ways to place them.' },
      { method: segmentStipple,
        blurb: 'The same points drawn as short strokes, each carrying a direction.' },
      { method: ditherGrid,
        blurb: 'Dots on a fixed lattice, chosen by one of five dithering rules.' },
      { method: radialRemap,
        blurb: 'A regular lattice squeezed radially until its density carries the image.' },
      { method: circlePacking,
        blurb: 'Packed circle outlines, smaller where the image is darker.' },
      { method: lappingShapes,
        blurb: 'Overlapping scales, each drawn only where earlier ones have not covered it.' },
    ],
  },
  {
    name: 'Marks joined up',
    methods: [
      { method: meshEdges,
        blurb: 'The Voronoi or Delaunay web of points placed by tone.' },
      { method: treeEdges,
        blurb: 'A spanning forest over those points — branches, not a net.' },
      { method: stringArt,
        blurb: 'One thread between nodes, each chord chosen to cover what is left.' },
      { method: tspTour,
        blurb: 'A travelling-salesman tour through the points: one unbroken stroke.' },
      { method: sfcCollapse,
        blurb: 'One curve that keeps its wiggle where the image is dark and straightens where it is light.' },
    ],
  },
  {
    name: 'Cutting up the page',
    methods: [
      { method: quadHalftone,
        blurb: 'A quadtree split until each cell is the right tone, drawn as crosses.' },
      { method: polygonSubdivision,
        blurb: 'The page cut again and again; the cuts themselves are the drawing.' },
    ],
  },
];

/** The flat list, derived so it cannot drift from the groups. */
export const METHODS = METHOD_GROUPS.flatMap((g) => g.methods.map((e) => e.method));

const BLURBS = Object.fromEntries(
  METHOD_GROUPS.flatMap((g) => g.methods.map((e) => [e.method.id, e.blurb])),
);

/** One line on what a method looks like, for the picker. '' if unknown. */
export const blurbOf = (id) => BLURBS[id] ?? '';

export const byId = (id) => METHODS.find((m) => m.id === id) || METHODS[0];

/** Default parameter values for a method, from its descriptor. */
export function defaultsFor(method) {
  const out = {};
  for (const p of method.params) out[p.key] = p.def;
  return out;
}

/**
 * A range param may give `min`/`max` as a function of the current settings
 * rather than a constant -- `tenPrintHatching`'s segment length is floored at
 * twice the pen width, and that floor moves when the pen does. Shared by
 * app.js (building the slider) and paramsForChannel() below (wrapping a
 * rotation into the same range the slider enforces), so the two cannot
 * resolve a function-valued bound two different ways.
 */
export function resolveBound(v, settings) {
  return typeof v === 'function' ? v(settings) : v;
}

/**
 * Whether a param applies to the current param combo -- the same test
 * `app.js`'s `visibleParams` uses to decide what to show, shared so a control
 * hidden from the UI and a control skipped by channelVariation()/
 * paramsForChannel() can never disagree about which param that is.
 */
export function paramVisible(p, params) {
  return !p.when || p.when(params);
}

/**
 * How CMYK's "rotate/shift each layer" checkbox can vary a method's output
 * across the four channels, for the CURRENT params, if at all.
 *
 * 'angle' when the method opts in with `rotationParam` (the key of whichever
 * of its own params IS its orientation -- not every method has just one, and
 * guessing from the param name would be wrong for the ones that have several,
 * e.g. streamlines' `angleOffset` vs `flatAngle`). 'seed' as a fallback for a
 * method with a `seed` param whose randomness is actually live, checked two
 * ways: if the seed param declares its own `when`, that already says exactly
 * when it applies (meshEdges/treeEdges/stippleGrowing hide it for a placer
 * that ignores it, the same gate `visibleParams` uses to hide the control) --
 * no extra capability needed. A method whose seed control stays visible but
 * is inert under some OTHER param's value (tenPrintHatching's angleSource,
 * ditherGrid's mode) has nothing for `when` to key off, so it says so via
 * `seedMatters(params)` instead. Without either check the checkbox would
 * claim to vary a method that is, at its current settings, deterministic.
 * null for a method with neither capability, for which the checkbox is a
 * no-op.
 */
export function channelVariation(method, params) {
  if (method.rotationParam) {
    // Same `when` check as the seed branch below, for the same reason: a
    // rotation param hidden for the current param combo has to be treated as
    // absent, or the hint/UI would promise a variation paramsForChannel()
    // (which does honour `when`) would not actually apply.
    // Guarded, not asserted: a `rotationParam` naming no real param would
    // otherwise throw here rather than just failing to vary anything, for a
    // mistake this file's own header comment cannot enforce at write time.
    const rotParam = method.params.find((p) => p.key === method.rotationParam);
    if (rotParam && paramVisible(rotParam, params)) return 'angle';
  }
  const seedParam = method.params.find((p) => p.key === 'seed');
  if (seedParam
      && paramVisible(seedParam, params)
      && (!method.seedMatters || method.seedMatters(params))) {
    return 'seed';
  }
  return null;
}

/**
 * C, M, Y, K -- the classic print-screen rosette (15°/75°/0°/45°), as FRACTIONS
 * of a param's own period rather than fixed degrees.
 *
 * Those numbers are conventionally quoted in degrees because every method they
 * were ever used on has the same 180° period -- a hatch line looks the same at
 * 0° and 180°. ditherGrid's lattice does not: a square lattice repeats every
 * 90°, a hex one every 60°. Applying the fixed degrees anyway breaks exactly
 * there -- 75° and 15° differ by 60°, hex's own period, so two channels would
 * land on the SAME apparent orientation instead of four different ones. Storing
 * fractions of whatever period paramsForChannel() resolves (1/12, 5/12, 0, 1/4)
 * reproduces the classic 15/75/0/45 exactly at period 180 -- nothing changes
 * for the hatching methods -- while staying proportionally spaced, and never
 * coincident, at any other period: no two of these four fractions differ by a
 * whole number, so scaled by ANY period they can never land back on each other.
 */
const ROTATION_FRACTIONS = [1 / 12, 5 / 12, 0, 1 / 4];

/**
 * One channel's params, varied from the shared `params` so four otherwise-
 * identical runs of the same method don't place every channel's ink in the
 * same spots -- see channelVariation() for which capability is used.
 *
 * The rotation offset wraps with period (max-min) by default, not (max-min+1):
 * a rotation is a continuous quantity with its own period, not a discrete step
 * count. That default is wrong when the slider's declared range isn't the
 * param's actual visual period -- ditherGrid's `angleDeg` runs 0-90 for BOTH
 * lattices, to keep one slider rather than two, but a hex lattice only
 * actually repeats every 60°. Scaling the rosette by the wrong (bigger) period
 * can then put two channels' offsets back on top of each other mod the REAL
 * period. A method whose declared range and true period can differ says so
 * with `rotationPeriod(params)`, which this prefers over (max-min) when given.
 */
export function paramsForChannel(method, params, channelIndex, settings) {
  const kind = channelVariation(method, params);
  if (kind === 'angle') {
    const key = method.rotationParam;
    const p = method.params.find((q) => q.key === key);
    // `channelVariation` already found this same param to return 'angle', so
    // `p` is never missing here in practice -- guarded anyway, consistently
    // with that check, rather than relying on never being called any other way.
    if (!p || !paramVisible(p, params)) return params;
    const min = resolveBound(p.min, settings);
    const max = resolveBound(p.max, settings);
    const period = method.rotationPeriod ? method.rotationPeriod(params) : max - min;
    // Every current rotationParam resolves to a fixed positive number here,
    // so this never fires today -- guarded because min/max CAN be settings-
    // dependent functions (resolveBound exists for exactly that), and a future
    // one resolving to min===max (or a rotationPeriod returning <=0) would
    // otherwise divide by zero into NaN instead of just leaving that channel
    // unrotated.
    if (!(period > 0)) return params;
    const offset = period * ROTATION_FRACTIONS[channelIndex];
    const base = params[key] ?? p.def;
    const wrapped = ((base + offset - min) % period + period) % period + min;
    return { ...params, [key]: wrapped };
  }
  if (kind === 'seed') {
    return { ...params, seed: (params.seed ?? 0) + channelIndex };
  }
  return params;
}
