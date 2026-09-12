// Extracted verbatim from the pre-split verify.html (lines 162-235).
// Body unchanged, so the emitted output stays byte-identical.

import parallelHatching from '../src/methods/parallelHatching.js';
import crosshatchQuantized from '../src/methods/crosshatchQuantized.js';
import quadHalftone from '../src/methods/quadHalftone.js';
import polygonSubdivision from '../src/methods/polygonSubdivision.js';
import eikonalStripes from '../src/methods/eikonalStripes.js';
import refiningNoise from '../src/methods/refiningNoise.js';
import { flat, linearRamp, radialRamp, runToneTest } from './runner.js';

export function run() {
// ---------------------------------------------------------------- tone tests
// `flat` is runner.js's fixture: gamma 1 and no smoothing, so the target IS the
// ramp and any tone error is the method's, not the preparation's. This file used
// to redeclare it identically, which shadowed the import and put a second copy
// of the harness's baseline settings where it could drift from the first.

runToneTest(
  'Linear ramp — parallel hatching (16 layers)',
  parallelHatching,
  linearRamp(600, 200),
  { angleDeg: 26, maxNlevels: 16 },
  flat,
);

// Regression: 20 is not a power of two. Before the fix this produced a badly
// compressed tone curve (0.35 at black instead of 0.05) because six of the
// twenty line indices were unreachable. It should now round up to 32 and behave.
runToneTest(
  'Linear ramp — parallel hatching (20 requested, rounds to 32)',
  parallelHatching,
  linearRamp(600, 200),
  { angleDeg: 26, maxNlevels: 20 },
  flat,
);

runToneTest(
  'Radial ramp — parallel hatching',
  parallelHatching,
  radialRamp(400, 400),
  { angleDeg: 26, maxNlevels: 16 },
  flat,
);

// Crosshatching claims to be "properly calibrated": the level ladder
// Ks = 1-(1-Kmax)^(i/N) is supposed to make n overlaid layers land on the right
// coverage. A ramp with many bands is the transfer-function check the MATLAB
// sketches in its commented-out validation block (lines 119-135) and never ran.
runToneTest(
  'Linear ramp — crosshatching (5 levels, no dither)',
  crosshatchQuantized,
  linearRamp(600, 200),
  { nLevels: 5, maxCoverage: 0.95, ditherLevels: false },
  flat,
  16,
);

// With dithering the mixture restores the average, so this one is scored
// against the continuous ramp -- and should hold it, including in the
// highlights that rounding sent to blank paper.
runToneTest(
  'Linear ramp — crosshatching (5 levels, dithered)',
  crosshatchQuantized,
  linearRamp(600, 200),
  { nLevels: 5, maxCoverage: 0.95, ditherLevels: true },
  flat,
  16,
);

runToneTest(
  'Linear ramp — crosshatching (9 levels, dithered)',
  crosshatchQuantized,
  linearRamp(600, 200),
  { nLevels: 9, maxCoverage: 0.95, ditherLevels: true },
  flat,
  16,
);

runToneTest(
  'Radial ramp — crosshatching (dithered)',
  crosshatchQuantized,
  radialRamp(400, 400),
  { nLevels: 6, maxCoverage: 0.95, ditherLevels: true },
  flat,
);

}
