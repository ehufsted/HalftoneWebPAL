// Method registry. Adding another means dropping a
// module in here that exports { id, label, params, run(ctx) } -- the UI builds
// its controls from `params` and the worker just calls `run`.
//
// ALSO EXPORT targetImage(ctx) IF THE METHOD CANNOT REACH EVERY TONE. Without
// it the worker scores the drawing against the source image, which permanently
// condemns every band-limited method for a shortfall that is its specification
// rather than its error. See docs/architecture.md and spine/tone.js.

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
