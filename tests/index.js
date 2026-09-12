// The ordered test list.
//
// ORDER IS PART OF THE CONTRACT, not a convenience. The pre-split harness was a
// single script executed top to bottom, and the acceptance criterion for the
// split is that the emitted output is byte-identical -- so these must run in the
// order the sections appeared in the original file. That is why sections are
// listed here rather than grouped by topic: a few methods appear more than once
// (crosshatch has tone tests near the top and its level-ladder check near the
// bottom), and topic grouping would silently reorder the output.
//
// The line ranges are the ones each module was sliced from, kept so the mapping
// back to the original is checkable.

import * as hatching from './method.hatching.js';               //  162- 235
import * as sfcCollapse from './method.sfcCollapse.js';         //  236- 306
import * as quadHalftone from './method.quadHalftone.js';       //  307- 337
import * as polygonSubdivision from './method.polygonSubdivision.js'; // 338- 356
import * as tenPrint from './method.tenPrint.js';               //  357- 451
import * as wigglyLines from './method.wigglyLines.js';         //  452- 642
import * as circlePacking from './method.circlePacking.js';     //  643- 827
import * as stippleGrowing from './method.stippleGrowing.js';   //  828- 937
import * as ditherGrid from './method.ditherGrid.js';           //  938-1151
import * as spineMask from './spine.mask.js';                  // new — the shared region mask
import * as spineLattice from './spine.lattice.js';             // new — lattices + radial transport
import * as radialRemap from './method.radialRemap.js';         // new — radial remapping
import * as stringArt from './method.stringArt.js';             // new — string art
import * as splitMerge from './method.splitMerge.js';           // new — splitting lines
import * as lappingShapes from './method.lappingShapes.js';     // new — lapping shapes
import * as spineRegion from './spine.region.js';               // 1152-1191
import * as spineGeodesic from './spine.geodesic.js';           // 1192-1361
import * as spineContour from './spine.contour.js';             // 1362-1439
import * as eikonalStripes from './method.eikonalStripes.js';   // 1440-1666
import * as spineWaveNoise from './spine.waveNoise.js';         // 1667-1785
import * as refiningNoise from './method.refiningNoise.js';     // 1786-1925
import * as merge from './method.merge.js';                     // 1926-1956
import * as crosshatchLadder from './method.crosshatchLadder.js'; // 1957-2002
import * as pipeline from './pipeline.js';                      // 2003-2059
import * as planeWaves from './method.planeWaves.js';           // new — plane waves
import * as meshEdges from './method.meshEdges.js';             // new — voronoi/delaunay web
import * as treeEdges from './method.treeEdges.js';             // new — spanning tree
import * as spineMesh1form from './spine.mesh1form.js';         // new — integer 1-forms
import * as triStripes from './method.triStripes.js';           // new — stripes on a mesh
import * as tspTour from './method.tspTour.js';                 // new — TSP tour
import * as spineSubdivide from './spine.subdivide.js';         // new — binary subdivision placer
import * as spineBestCandidate from './spine.bestCandidate.js'; // new — blue-noise placer
import * as spineAniso from './spine.aniso.js';                 // new — anisotropic alignment
import * as spineStreamlines from './spine.streamlines.js';     // new — flow hatching
import * as dashHatching from './method.dashHatching.js';       // new — dashed hatching
import * as dashedStreamlines from './method.dashedStreamlines.js'; // new — dashed streamlines
import * as spineDash from './spine.dash.js';                   // new — the stadium area law
import * as segmentStipple from './method.segmentStipple.js';   // new — short-stroke stipple

export const SECTIONS = [
  ['hatching', hatching],
  ['sfcCollapse', sfcCollapse],
  ['quadHalftone', quadHalftone],
  ['polygonSubdivision', polygonSubdivision],
  ['tenPrint', tenPrint],
  ['wigglyLines', wigglyLines],
  ['circlePacking', circlePacking],
  ['stippleGrowing', stippleGrowing],
  ['ditherGrid', ditherGrid],
  ['spine.mask', spineMask],
  ['spine.lattice', spineLattice],
  ['spine.region', spineRegion],
  ['spine.geodesic', spineGeodesic],
  ['spine.contour', spineContour],
  ['eikonalStripes', eikonalStripes],
  ['spine.waveNoise', spineWaveNoise],
  ['refiningNoise', refiningNoise],
  ['merge', merge],
  ['crosshatchLadder', crosshatchLadder],
  ['pipeline', pipeline],
  ['planeWaves', planeWaves],
  ['meshEdges', meshEdges],
  ['treeEdges', treeEdges],
  ['spine.mesh1form', spineMesh1form],
  ['triStripes', triStripes],
  ['tspTour', tspTour],
  ['radialRemap', radialRemap],
  ['stringArt', stringArt],
  ['splitMerge', splitMerge],
  ['lappingShapes', lappingShapes],
  // APPENDED, not inserted. The order above is the pre-split harness's order and
  // the byte-identical criterion depends on it; a new section at the end adds
  // output without moving any of it.
  ['spine.subdivide', spineSubdivide],
  ['spine.bestCandidate', spineBestCandidate],
  ['spine.aniso', spineAniso],
  ['spine.streamlines', spineStreamlines],
  ['dashHatching', dashHatching],
  ['dashedStreamlines', dashedStreamlines],
  ['spine.dash', spineDash],
  ['segmentStipple', segmentStipple],
];

/**
 * Run every section, or a named subset.
 *
 * The subset is the practical payoff of the split: once a change is isolated to
 * one method, re-verifying it costs seconds rather than a full sweep.
 *
 * EVERY SECTION RUNS ON ITS OWN. `pipeline` used to read `shared.linear` from
 * `hatching` and threw if it ran first, which quietly made the payoff conditional;
 * it builds its own input now. If a section ever needs another's output again,
 * make it build the input rather than reintroducing a cross-section channel --
 * the ordering it implies is invisible at the call site and shows up only as a
 * destructuring error.
 */
export function runAll(only = null) {
  for (const [name, mod] of SECTIONS) {
    if (only && !only.includes(name)) continue;
    mod.run();
  }
}
