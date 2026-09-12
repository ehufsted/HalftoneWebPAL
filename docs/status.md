# Project status and working notes

The development record for the app: what is ported, what each method's tone
model rests on, and what is still open. [README.md](../README.md) covers running
it; this file covers the state of the work.

## Status

*Done:*

| Part | Source ported from | State |
|---|---|---|
| Units contract | `superRegions.m` (lines 13–68, 254–258) | done |
| Shims: blur, resize, interp2, inpolygon, dilate3 | `imfilter`, `imresize`, … | done |
| Stroke renderer | `renderLineSegment.m`, `renderLinesAndDots.m` | done |
| Path ordering + join | `pathOptimizer.m`, `joinCoincidentLines.m` | done |
| Simplification | `simplifyLineArea.m` (Visvalingam), `simplifyLineDistance.m` | done |
| Segment clipping | `trimLineSegsToPolygon.m`, `intersectLine.m` | done |
| SVG export (mm + viewBox + layers) | rewritten, not ported | done |
| Parallel hatching | `regionsParallelHatchingInPolygon.m` | done; **join bound added, pipeline numbers move** — its candidate lines are one pen width apart, so the pipeline's default 1.5 was welding adjacent hatch lines into hairpins and drawing the bridge. `tests/pipeline.js` now takes the tolerance from the method, as the worker does |
| Quantised crosshatch | `regionsCrosshatchingQuantized.m` | done (`contourc` replaced by a run-walk) |
| SFC collapse | `regionsSFCcollapse.m` | done |
| Quadtree crosses | `etc code/subdivideQuadHalftone.m` | done (bonus, not in the v1 six) |
| Polygon subdivision | `regionsPolygonSubdivision.m` | done (bonus) |
| 10 PRINT hatching | `regions10PRINTHatching.m` | done (bonus; raster dither, no Hilbert path) |
| Wiggly lines | `demoWigglyLinesHalftoning.m` + `fixwigglyLines…VaryAmplitude.m` | done (bonus); sawtooth measured and confirmed, sine corrected |
| Circle packing | `fixCirclePackingScan.m` | done (bonus); φ measured, tangency-overlap term added |
| Stippling (dots) | `regionsStippleGrowing.m` | done (bonus); budget confirmed, fill sagitta corrected. Now one module, three placements — the ported region growing plus the two point placers in `spine/points.js` — because all three satisfy the same ink identity `N = ΣK/(πr²)` with no band and no constant |
| Dither grid | `regionsDitherGridSquare.m` + `…Hex.m` | done; one module, both lattices, 5 modes; identity confirmed |
| Eikonal stripes | `regionsEikonalStripes.m` | done; both shims verified against theory; spacing and tone measured |
| Refining noise | `regionsRefiningNoise.m`, reworked | done; sinusoid fields, Kac–Rice calibration measured with no free parameter |
| Plane waves in regions | `regionsPlaneWaveInPolygon.m` | done; tilers verified. Source's tone ladder corrected |
| Region tilers | `regionDivisionsVoronoi.m` + `voronoi/code/lloyds.m`, `trianglePlane.m` | done; rect, hex, equal-ink Voronoi, edge-aligned Delaunay and a regular triangular lattice in `spine/regions.js`. Lloyd replaced by recursive mass subdivision (`spine/points.js`, over the relaxation in `spine/relax.js`); all five verified |
| Voronoi / Delaunay web | `regionsVorDelMSTTSP.m` (modes 0–1) | done; the source's fitted constants replaced by a derived `C` = 2 and 2√3, overlap term `A` fitted and verified |
| Spanning tree | `regionsVorDelMSTTSP.m` (mode 2) + `primMST.m` | done; C derived as 2/√3. Anisotropy and forest options verified |
| Stripes across a triangulation | `stripesFromTrisFn.m` | done; the source's abs() removed, so its four cases collapse to one signed rule. Integer 1-form in `spine/mesh1form.js`, closed by min-cost flow |
| Travelling-salesman tour | `TSPviaMST.m`, `TSPviaSFC.m` | done; both constructions, plus neighbour-limited 2-opt and Or-opt the sources lack. Tour length bracketed by BHH |
| Radially remapped lattice | `testRadialRemappingPoints.m` | done; square, triangular and phyllotactic point sets, dots or joined rows. The source's fitted hex constant replaced by a derivation, its extrapolation bias and its monotonicity hack removed |
| String art | `regionsStringArt.m` | done; the source's own "is this calibrated?" answered with a global ink budget. Two source bugs fixed, the clamp on the residual removed, and the stopping rule derived rather than chosen |
| Point sets + radial transport | as above, `pointsGridOrHex.m` | done; `spine/lattice.js` and `spine/radialTransport.js`, both verified before anything drew with them |
| Direction field | structure tensor (`spine/field.js`) | done — see the elaboration below |
| Streamlines (flow hatching) | not a port — Jobard & Lefer 1997 | done; the only method that FOLLOWS the direction field rather than orienting something else by it. Same harmonic ladder as `eikonalStripes`, but its own module because streamlines terminate and that method's band has no term for line ends. No RNG at all |
| Lapping shapes | `regionsLappingShapes.m` | done; the source's unqualified "calibrated" earned — the radius rule is `A − P = B` with nothing fitted. Shape as a distance metric, over `spine/contour.js` |
| Split and merge | `etc code/testSplitAndMergeDiagonals.m` | done; lines placed at integer crossings of the cumulative required ink, so the line count is correct by construction and there is no constant to calibrate |
| Dashed hatching | not a port — the duty-cycle knob nothing here used | done. Fixed carrier spacing, tone from the fraction of each carrier inked. Marks placed by an integral of ink owed, as `splitMerge` does, so the count is correct by construction; the stadium cap term and the cheaper charge for an abutting dash are both derived, nothing fitted. Measured at 0.997-1.001 across a 16x dash sweep |
| Dashed streamlines | not a port — the cross of the two either side of it | done. Streamlines packed at a constant separation with tone in the dashes. Shares `streamlines`' integrator and `dashHatching`'s ink law (`spine/dash.js`). The page is PARTITIONED among the lines rather than each being charged a fixed strip, so terminations and packing slack cost no tone; ink further than one separation from any line is reported, not modelled |



**Seven checks report KNOWN SHORTFALL rather than PASS.** Each carries the number
measured when its cause was diagnosed, and fails only if the drawing gets worse —
`polygonSubdivision`'s ink model, `stippleGrowing`'s dot overlap, `stringArt`'s
quantum at high opacity, and `lappingShapes`' occlusion floor. The cause is written
at each call site; none of them is waived.

**Verified against measurement, not against inspection.** Every constant in the
table above is either
derived in closed form or measured with `verify.html`, which
renders strokes and compares coverage to a prediction stated *before* the run. The
open questions that survived are in Next steps.

## Known issues and deferred work

From the whole-app review. Three groups, because they age differently: unfixed bugs want an
owner, deferred work wants its *reason* recorded so it is not re-litigated, and the traps want
reading **before** anyone edits `spine/`.

### Latent bugs, unfixed
- **`curves/hilbert.js`** — the doc said `[-1,1]`; it is cell *centres*, `[-1+w/2, 1-w/2]`. The
  doc is corrected, but both callers (`sfcCollapse.js:80`, `wigglyLines.js:332`) still rescale
  as if the old claim were true, giving a half-cell offset and a ~1% compression. Absorbed by
  the clip today. Fixing the callers is a measurement, not an edit.


### Deliberately deferred, and why

- **Unifying the two min-heaps** (`simplify.js:28` vs `geodesic.js:42`). The typed-array one is
  materially faster and `simplify.js` is the one run on 400k-point paths. But heaps with equal
  keys pop in different orders, and `simplifyLineArea` removes points *in heap order* — so
  swapping implementations can change which points survive. Needs a prediction and its own
  measurement, not a free win. The *allocations* have been taken out of `simplify.js`'s heap
  separately (scalar swaps, no object per pop), which touches no comparison and so is not this.
- **Merging the two `resampleUniform`** (`eikonalStripes.js:242`, `wigglyLines.js:233`). Same
  name, same algorithm, **different endpoint semantics**: one lands both endpoints exactly, the
  other steps at exactly `k·step` so the last sample falls short. Merge only with both
  behaviours preserved, or the other method's geometry moves silently.

### Traps when changing shared code

These now live in **[docs/architecture.md](docs/architecture.md#traps-when-changing-shared-code)**,
because that is where a maintainer meets them before editing `spine/` rather than after. In
short: the seeded RNG's *call sequence* is load-bearing; the three "same harmonic ladder"
headers are not all the same ladder; heap tie-order decides which points survive
simplification; the harness is deterministic and that is an acceptance criterion worth
protecting; and `spine/mask.js` hands out its cached array rather than a copy.

## Next steps

### Settled — do not re-litigate

Recorded here because they were open long enough to be worth closing explicitly.

- **The 10 PRINT tone ceiling is `2w/Lseg`.** Measured across six segment lengths,
  worst error 0.007. So the `Lseg ≥ 2w` clamp stands and the slider's left end really
  is correct tone.
- **The sawtooth's closed form is confirmed** (worst 0.0021) and **the sine is
  corrected** (≤0.0012 for λ/w ≥ 3, 0.0440 at the λ/w = 2 merge floor, where coverage
  is saturating anyway).
- **The stipple spiral fills its disc.** 0.9785–1.0060 across the spiral-drawn radii
  after `SAGITTA` came down to 0.03 and the ring discontinuity was fixed. The count
  ratio was already confirmed.
- **The crosshatch level ladder holds** — worst per-level error 0.020 at 5 levels,
  0.026 at 9.
- **The seeded RNG is intact after consolidation into `spine/random.js`** — 10 PRINT's
  determinism check reproduces on seed 1 and differs on seed 2.
- **Every "run section X" item from the previous pass is closed.** The Voronoi
  exponent sweep, the Delaunay definition and Euler checks, the mesh `√3` identity
  and `A` fit, the tree ratios and `TREE_KAPPA`, and the plane-wave region sweep all
  ran and passed. The findings each produced are in `docs/findings.md`; the
  constants they set are in the modules.
- **10 PRINT's overlap identity is `ink = p·bar + p(1−p)·cap`**, worst residual
  0.0016 of absolute ink with nothing fitted. `markFraction` inverts it, and the
  remaining ramp error is under 1.5%, which was accepted.
- **The stipple point placer is recursive mass subdivision, not Lloyd's.** Counts
  come from mass top-down, so seed density is proportional to the field *by
  construction* and the Gersho exponent correction is gone rather than tuned.
- **`triStripes` costs no measurable ink for its continuity guarantee.** κ = 1.00
  ± 0.02, against a prediction of "above 1" that was wrong: stripe bending and
  hairpins are real but smaller than the two-sided jitter from rounding crossing
  counts.

### Open measurement questions

1. **The square wave is the last unexplained tone residual.** Errors run
   −0.0248…+0.0090: negative at short λ, positive at long, growing with H/w — the
   shape of a corner term. `areaRatioSquare` carries one `w²(4−π)/4` where the
   geometry has **two** corners per period, which is the first thing to check. The
   `A = 0` rows read exactly 0.0000 across all three waveforms, so the rig is clean
   and this is the model.
2. **`TANGENCIES_PER_CIRCLE` is not a constant, and the harness now shows why.**
   Counted k is 0.926–1.473 over most of the sweep but **1.865–1.906** on the
   `rMin = 2w` rows — it climbs as circles get small and numerous, which is what more
   chances at a second tangency should do. So the choice is to make k a function of
   `r/w` or to state 1.25 as a mid-range compromise and bound the resulting error.
   Note the coverage law's *shape* is not in question: fed the measured φ and k, the
   prediction holds to ±0.013 typical, 0.024 worst.
3. **The φ verdict needs a minimum circle count.** It reports DRIFTS on a range whose
   low end (0.6333) is the fourteen-circle row already documented as small-number
   noise. Excluding it, φ is 0.7596–0.8202 with no trend in radius. Same fix as the
   spiral test's stamped row — exclude the case the criterion was never about.
4. **Closed — `tspTour` has no fitted constant left, and that is the result.** `C = 0.9587`
   is measured from tour geometry (length × spacing / area, no rendering in it);
   `A = 0.1415` is measured from rendered ink, via the fact that `1/coverage` is
   linear in `d` (slope 0.69094, intercept 0.1476, RMS residual 0.1048 — about
   1.5% of the mean, so the coverage law holds). The slope fixes the PRODUCT
   `κC = 0.9649`, and against the independent `C` that leaves `κ = 1.006` — inside
   the scatter. So κ is 1 exactly. **If a later measurement pushes κ off 1, the two
   measurements have started disagreeing**, which is a signal worth having; a free
   κ would have absorbed it silently. Sanity check: `A = 0.14` is the smallest
   overlap term in the app, as it must be — a tour meets exactly two strokes at
   every point, where a Voronoi network meets three or more.

### Ports and features

5. **`edgeTangentFlow` is still not ported**, and `triStripes` is the method that
   most wants it. The whole construction is level sets of the orientation field, so
   field quality matters more here than anywhere else, and `structureTensorField`
   is the weaker of the two fields. Worth revisiting if the
   stripes look incoherent on a real photograph — but measure before porting.
6b. **`radialRemap`'s across-ray residual has no second stage.** One radial pass
   leaves a density error of about 0.067 (sd of landed/wanted over a 9×7 grid),
   which is the price of a map that cannot move mass tangentially. A second
   radial pass was built twice and removed both times — see the module header for
   why it cannot work. What would actually reduce it is a *different* second
   stage: a few Lloyd steps over the transported points, or genuinely linear
   slices rather than radial ones. Neither is started.
6. **`triStripes` hairpins are effectively untested.** They only fire on a face with
   residual curl of ±2 or more, which the default `defectPrice` makes rare. The unit
   test covers the sequence; no real image has exercised it. If a drawing ever shows
   a stripe folding back oddly, that is where to look.
7. `regionsSpiralsInPolygon` — region division is available, so this is unblocked.
8. **Done — `regionsLappingShapes.m` is ported** (`methods/lappingShapes.js`), over
   the `spine/contour.js` that was once its blocker.
9. `regionsNNearest`, `voronoi/code/lineSegDemo.m`, `regionsHatchingStippling` —
   the three remaining entries in the catalogue worth doing. `lineSegDemo` is the
   one nothing else here resembles.
10. **Done — the region mask lives in `spine/mask.js`.** Thirteen copies of the
   same raster scan, now one cached module with `tests/spine.mask.js` behind it.
   Five `inpolygon` calls remain outside it and are genuinely different: they
   test arbitrary points (lattice sites, cell centres, segment midpoints) or a
   region polygon rather than the drawing polygon.
11. Method thumbnails in the picker (the plan's GUI note — names alone are
   meaningless).
12. Reduced-resolution compute while dragging a slider, full resolution on
   release. The groundwork is now in: `app.js` `cancelInFlight` terminates and
   respawns the worker when a new job supersedes a running one, so a drag no
   longer pays for every intermediate computation in full. What is left is
   choosing the reduced resolution and switching back on release.
