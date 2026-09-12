# Architecture

The invariants that hold across the whole app, and that no single method file is the
right home for. Method-specific reasoning lives in the method module's own header —
that is deliberate, and it is where to look first.

**Read the "Traps" section at the bottom before editing anything in `src/spine/`.**

---

## Layers

```
shim/      MATLAB image-toolbox equivalents (blur, resize, interp2, inpolygon,
           dilate3, bayer). No knowledge of plotting.
spine/     the plotter-side machinery every method shares. Listing the modules
           here is how this section went stale once already -- read the
           directory. Broadly: the units contract and the renderer; geometry,
           polygon and simplify; path ordering and SVG; the region mask; point
           sets, lattices and regions; fields, contours and noise; the seeded
           RNG and the tone helpers.

           Three of them stack and the order is worth knowing before editing
           any of them: relax.js (Lloyd, the anisotropic metric, the pinned
           polish) <- points.js (the three placers) <- regions.js (the tilers).
           They were one 1738-line file; the dependency runs one way only.
curves/    space-filling curves (hilbert, hCurve). Pure geometry.
methods/   one module per halftoning method. Imports downward only.
worker.js  runs the pipeline off the main thread.
app.js     UI wiring. The only file that knows what a DOM is.
```

Dependencies run strictly downward. A method may import from `spine/` and `shim/`;
nothing in `spine/` or `shim/` may import from `methods/`, and neither touches the
DOM. That last property is what lets the whole numeric core run headlessly under
`run-tests.mjs`.

## The units contract

The user sets physical centimetres. Methods never see centimetres.

- `prepare()` converts the user's settings into a pixel-space `ctx`, and every method
  works in **1-based pixel coordinates**, matching MATLAB's `meshgrid(1:nx, 1:ny)` so
  ports stay readable against their source.
- Methods return polylines in that same pixel space.
- `toPhysical(v)` converts back: `(v - 1) / pxPerCm`. `toPixels` is its inverse, used
  by the worker to render what will actually be plotted rather than what the method
  first emitted.
- `Lmin = penWidth * 1.1` is the floor on every spacing control. Below it, adjacent
  lines merge on paper.

A range param may declare `min`/`max` as a **function of the settings**, for a bound
that tracks the pen. `tenPrintHatching`'s segment length is the first to use it: its
floor is `2 × penWidth` in every unit system at once (`pxPerCm` cancels), so the
slider carries the clamp as its own minimum instead of silently correcting the user
afterwards. `buildParamUI` re-runs when the pen width changes and clamps the stored
value into the new range. Constant `min`/`max` still work exactly as before.

Any param may declare **`when(params) => boolean`** and be hidden when it returns
false. This is for controls that only apply to one branch of a method — `triStripes`
jitter is for its lattice and its edge alignment is for its triangulation, and both
used to sit there inert with a source comment as the only explanation. Hiding does
not clear: `state.params` keeps the value, so flipping the gate back restores it
rather than resetting. Because a gate can read any other param, **every select and
checkbox rebuilds the control list on change**; ranges do not, since nothing gates
on one.

## The image convention

One struct everywhere: `{ w, h, data }` with `data` a `Float32Array` of `w*h`, row
major, **1 = paper, 0 = ink**. Build it with `makeImage(w, h)` — hand-rolling the
struct is how the two backing types drifted apart before.

## The renderer is the calibration

`renderStrokes` supersamples and area-averages down, matching `renderLineSegment.m`.
Canvas antialiasing is **not** equivalent — do not substitute it. Every measured
constant in this project was measured against this renderer, so changing it
invalidates all of them at once.

**The factor is not the same in all three callers, and that is deliberate.** The
harness renders at `superSample: 4` (`tests/runner.js`), because a measurement should
be sampled better than a preview. The default — and the MATLAB's effective factor —
is 3, which is what `renderStrokes` falls back to and what the app's PNG export uses.
The worker also *degrades* it: `outScale × superSample` squared is a real memory cost,
so it steps the factor down until the supersampled buffer fits a 12 Mpx cap
(`worker.js`). One consequence worth knowing before chasing it: the tone error in the
app's footer can move slightly when the Detail slider moves, because the sampling
moved, not because the drawing did. The published constants all come from the
harness's 4; nothing is calibrated against the degraded path.

It has a known bias, and any measurement rig built on it inherits the bias: it tests
`d2 < r2` at sample centres, so a stroke of supersampled width `W` covers an open
interval of length `W` — centred on an integer row that is `W−1` samples, centred on
a half-integer exactly `W`. Snap measurement carriers to half-integer supersampled
rows.

**PARITY DECIDES WHETHER IT BITES AT ALL, and the size is `1/W`.** Measured against a
model of the sampler: an axis-aligned stroke reads 0.839 at `W = 6`, 1.010 at `W = 9`,
0.922 at `W = 12`, 0.959 at `W = 24` — that is `(W−1)/W` when `W` is even and 1 when
it is odd, because an odd width puts both edges between samples. At the harness's
factor of 4 and the default pen, `W = 1.5 × 4 = 6`, so an axis-aligned drawing is
under-read by a sixth.

**It only bites on strokes that hold one phase for their whole length.** Off-axis the
phase drifts through a cycle and averages out: the same model reads 0.995 at 5°,
0.987 at 26°, 1.052 at 45° (the diagonal over-counts, which is the same discretisation
seen from the other side). So a method at mixed angles is unaffected and a method
whose every stroke is axis-aligned pays in full. `quadHalftone` is the exposed case —
its crosses are horizontal and vertical arms — and it read 0.83–0.89 of its own
committed ink until the allowance was made.

**The allowance belongs in the rig, never in `targetImage`.** `tests/runner.js`
`samplingAllowance` states it, and a tone test opts in with
`{ axisAlignedStrokes: true }`. Putting it in a method's band instead would make the
app report to the user a tone the method cannot reach, when in fact it reaches it
perfectly well on paper and only the instrument cannot see it. It is stated as a
BOUND rather than a factor: `(W−1)/W` is the worst case, a real drawing with finite
strokes and round caps reads a little above it, so the residual after subtracting
lands slightly negative — on the side that cannot conceal a real shortfall.

## The method contract

```js
export const id     = 'myMethod';
export const label  = 'My method';
export const params = [ /* ... */ ];
export function run(ctx) { /* ... */ return lines; }   // [[ [x,y], [x,y] ], ...]
export function targetImage(ctx) { /* optional — see below */ }
export default { id, label, params, run, targetImage };
```

`ctx` carries `{ im, nx, ny, w, Lmin, Lmax, polygon, pxPerCm, ... }` plus the
method's own params, flattened.

### Saying something about the run

A method that can finish for more than one reason may call `setNote(text)` from
`spine/notes.js` during `run`. The worker reads it after `run` returns and the app
shows it beside the tone error; the harness ignores it, so the transcript does not
move. `stringArt` is the case it exists for — it has four ways to stop, all of which
present as the same symptom (a light drawing), so the error is uninterpretable
without the reason.

**The note does not travel through the return value, and that is deliberate.** `run`
returns polylines and nothing else. Letting it return either an array or an object
would make all 38 direct `method.run(args)` call sites in the harness a latent break
the moment a second method adopted the richer form — the same under-specified
contract that `targetImage` already demonstrated here. `notes.js` is module-level
mutable state in `spine/`, which is otherwise discouraged; it is acceptable only
because it is write-only diagnostics that nothing reads back to make a decision, so
it cannot touch geometry, tone, or the RNG's call sequence.

### `targetImage` is part of the contract

**A method that cannot reach every tone must export `targetImage(ctx)`: the
brightness it is actually aiming for, per pixel.** Without it the worker scores the
drawing against the *source* image, which permanently condemns every band-limited
method for a shortfall that is its specification rather than its error. That is
exactly what happened — the export existed, five methods provided it, and for a long
time only the harness called it. Under-specified contracts drift.

The worker reports two numbers, because they answer different questions:

- **fidelity** — mean `|rendered − targetImage|`. Is the method doing its job?
- **reach** — mean `|targetImage − source|`. Can the method express this image at all?

Most methods have a reachable band `[min, max]` and squeeze the source affinely into
it; `spine/tone.js` `affineTarget(ctx, band)` is that squeeze. Do not use it when the
tone relation is not linear in the quantity being modulated — `circlePacking`
evaluates its coverage law per pixel instead, because the tangency term bows the ramp
away from the straight line between the endpoints.

An undithered quantised method should return its **staircase**, because scoring it
against a continuous ramp measures only the quantisation, which is by design. With
dithering on it returns the continuous image, because the mixture is supposed to
restore the average.

## Recurring structure worth recognising

**The harmonic ladder.** `1/x` linear in brightness is now the default shape of a
tone model here, because coverage is inversely proportional to a spacing in every
case: `circlePacking`'s `1/R`, `eikonalStripes`' and `planeWaves`' `1/L`,
`refiningNoise`'s `1/λ`, `meshEdges`' and `treeEdges`' `1/d`, `triStripes`' `1/L`,
`tspTour`'s `1/d` (where the spacing is between *points*, not strokes). Linear `1/x`
therefore gives linear coverage — and **darker means smaller/tighter**, which reads
like a bug if you skim it.

`spine/tone.js` holds the ladder itself as `harmonicSpacing` / `harmonicInvSpacing`,
along with `stripeSpacings` (the two spacing limits and their merge floor) and
`stripeBand` (the `1 − w/L` band the four stripe methods share). **Two ladder forms,
because `1/L` and `L` round differently** — a phase field accumulates `2π/L` and a
spacing map wants the spacing, so each caller keeps the form its constants were
measured in. `refiningNoise` is deliberately not routed through any of it.

**The ladder's argument is the raw `[0,1]` value, not a brightness.** Its affine map
*is* the remap into `[min, max]`, so handing it an already-remapped value applies the
squeeze twice: correct at the white end, and out by the full band width at the black
end. `triStripes` did this and rendered 23% light in the shadows. If a method needs
the remapped target for some other reason — cross-stripe layers do, since they take
its square root — undo the band before calling the ladder.

**Shared-edge quantities must be evaluated at the edge MIDPOINT.** Anything two faces
must agree on without communicating — a crossing count, a node position, a spacing —
is computed there, because the midpoint is the one point both faces name identically.
`triStripes` rests on this entirely, and `spine/mesh1form.js` makes it structural by
indexing nodes along each edge's canonical low-to-high vertex direction. Evaluate at a
face centroid instead and neighbouring faces silently disagree: no error, just a
drawing that fragments.

**Duty cycle is the other tone knob, and it has its own module pair.**
`dashHatching` and `dashedStreamlines` hold their geometry still and modulate how much
of each carrier is inked. Both place marks by an INTEGRAL of ink owed rather than from
a formula, so the count is right by construction and nothing is fitted — `spine/dash.js`
holds that ink law (stadium areas, the cheaper charge for an abutting dash, the carried
debt, the repayable phase loan) and the two methods keep only their own geometry.
Their band is `[1 − w/L, 1]`: white free, black at the solid carrier. Note this is the
mirror image of the harmonic ladder — there, white is unreachable and black is cheap.

**One module per tone model; modes for arrangement.** `ditherGrid` is two lattices
and five dither modes, `meshEdges` is Voronoi and Delaunay, `tileRegions` is five
kinds, and `stippleGrowing` is three dot placements — in each case because the tone
relation is *one* relation and only the arrangement differs. The test is whether the
candidates need the same `targetImage`. `radialRemap` looks like a fourth stipple
placement and is not one: it floors spacing at `d = 2·rDot` so dots may touch but
never overlap, and that floor with `dMaxW` is what gives it a band, where
`stippleGrowing` accepts overlap at high density and therefore has none. Two
contradictory rules about the same physical situation do not belong in one module,
however similar the marks look on paper.

**Two distances, two jobs.** `streamlines` keeps a *separation* distance and a *test*
distance, and they are not interchangeable: a candidate seed must be `d_sep` clear of
every existing line, while a line already growing may run in to `d_test = 0.5·d_sep`
before it stops. Using the test distance for seed rejection lets a new line be planted
in the middle of an existing gap, so the packing settles at `d_test` instead — measured
at 2.18 px against a requested 3.93, and every tone over-inked. It shows up in shadows
first, because that is where seeds are plentiful enough to find the gaps.

**Merge floors.** Every spacing control bottoms out where adjacent strokes touch on
paper, and that floor is derived, not taste: `Lseg = 2w` (10 PRINT), `λ = 2w`
(wiggly lines), `L = w` (eikonal), `λ = 2.2214w` (refining noise), `rDot = w/2`
(dots). Sliders stop there because below it the model says one thing and the paper
says solid ink.

**mod π, not mod 2π.** A symmetric stroke can only respond to orientation mod π, so
any mean or interpolation of directions must be done on the **doubled** angle.
`meanOrientation` does; a plain vector mean cancels antiparallel entries. This is a
recurring bug in the source collection, found in six MATLAB files and fixed once here.

There are **two different jobs** hiding under that one rule, and they want different
answers. *Averaging or interpolating* a line field is the doubled-angle problem above
— and the cheapest correct route is to never form an angle at all, since
`structureTensorField`'s `(t11 − t22, 2·t12)` **is** the doubled-angle vector and
interpolates linearly where an angle does not (`spine/relax.js` and
`methods/streamlines.js` both work this way). *Choosing a consistent arrow* is a
different problem with two different solutions by scale: `mesh1form.orientField` lifts
the whole field at once by walking a dual graph, which a triangulation needs and which
is mesh-bound; a **streamline needs none of that**, because the arrow that continues
the curve is whichever of the two agrees with the step just taken. Reaching for the
global machinery when the local rule will do is the mistake to avoid — a half-index
singularity then simply curls the line back, which is correct behaviour rather than a
case to handle.

---

## Traps when changing shared code

These are the failure modes that do not announce themselves.

- **The seeded RNG's *call sequence* is load-bearing, not just its algorithm.** Four
  methods seed from `spine/random.js` `mulberry32`. A shared version is safe only if
  it keeps the same constants, the same seed pre-offset, **and is called the same
  number of times in the same order**. Any change re-rolls every stochastic method's
  realisation — not its tone, but its appearance and every seeded number in the
  harness.

- **Several method headers describe "the same harmonic 1/x tone ladder". Not all of
  them do.** The ones that interpolate between two chosen endpoints — so that white
  is unreachable by construction — are the ladder in `spine/tone.js`, and
  `eikonalStripes`, `planeWaves`, `triStripes` and `streamlines` now call it.
  **`refiningNoise`'s is algebraically different** — it passes through the origin
  (`1/λ = K/(C·w)`) with `λmax` applied afterwards as a *cutoff*, not as a ladder
  end, which is precisely what lets it reach true white. Routing it through the
  shared helper would silently change its bright end. `circlePacking`'s is the
  two-endpoint shape but its coverage law is not linear in `1/R`, so it keeps its
  own per-pixel evaluation; that is the same reason it cannot use `affineTarget`.

- **The path joiner's tolerance encodes an assumption about the method, and three
  methods break it.** `joinCoincidentLines` welds paths whose ends fall within 1.5
  pen widths, which reads as "two ends of one interrupted stroke" — right for a
  network method, where a corner at a shared vertex is the point. It is wrong for
  any method whose strokes are separate marks by construction: `parallelHatching`
  spaces its candidate lines exactly one pen width apart, and the two dashed methods
  have spacing controls that floor there. In all three the joiner welded neighbouring
  strokes into hairpins across the grain, and because it draws the gap it bridges, it
  also added ink the tone model never budgeted. A method states its own bound by
  exporting `maxJoinPens`, which can only tighten the default; `spine/pathOptimizer.js`
  `COINCIDENT_PENS` is the tight value. **Do not derive that bound from the method's
  own spacing** — half the carrier spacing was correct for straight carriers and
  wrong for curved ones, where two streamlines can close to 0.375 of the separation.

- **Heaps with equal keys pop in different orders**, and `simplifyLineArea` removes
  points *in heap order*. So swapping one min-heap implementation for another changes
  which points survive. There are two in the app (`simplify.js`, `geodesic.js`) and
  unifying them is a change that needs a prediction, not a free win.

- **`spine/mask.js` hands out its cached array, not a copy.** That is what makes it
  worth caching — the alternative was thirteen full `inpolygon` scans of the raster,
  one per method, and `polygonSubdivision` paid for two of them by itself. The cost
  is that a caller writing into the returned mask corrupts every later request with
  the same geometry, including other methods' later in the same session. Nothing
  needs to: `whitenOutside` mutates the *image*. `tests/spine.mask.js` interleaves
  five geometries through the four-slot LRU and re-checks each against a direct scan,
  which is the check that a caller has not started writing into it.

- **There are three point placers behind one contract, and they are not
  interchangeable in a released drawing.** `stipplePoints` (local k-means per cell,
  seeded) is the calibrated default; `bestCandidatePoints` (`mode: 'bestCandidate'`)
  gives blue noise, an exact count, and is the only one that is **progressive** — a
  run of *m* points is a bit-for-bit prefix of a run of *n*, so a count slider adds
  and removes points at the margin instead of re-rolling the drawing;
  `subdividePoints` (binary subdivision of the raster, `mode: 'subdivide'`) is exact
  in its count and draws from the RNG zero times, at the cost of leaving flat tone
  on a two-aspect lattice. Note the density guarantees differ in kind: the
  subdivider *constructs* it, the other two *approach* it, so they are held to
  different bars in the harness. Five methods now
  offer it as a **Point placer** control — `meshEdges`, `treeEdges`, `tspTour`, and
  `planeWaves`/`triStripes` on their point-placing tilers — and all five default to
  the relaxed one. That default is load-bearing: every constant in those methods was
  measured against the point set it produces, so the control changes the realisation
  entirely, not just its arrangement. It is offered to the user, not to a future
  refactor: do not change a default to it without re-measuring that method.
  `stippleGrowing` offers all three, as its dot placement.

- **`subdividePoints`' `relax` option gives back exactly what the placer exists to
  provide.** Mass-weighted Lloyd converges on the Gersho distribution `field^(1/2)`,
  which is the distribution the subdivider avoids by construction, so every step
  pulls density back toward it — measured at 1.18 on a four-to-one field after eight
  steps, when it should be 1.00. The exact count survives (points move, none are made
  or lost), so it is arrangement bought with accuracy. It defaults to 0 everywhere it
  is offered and should stay that way; `tests/spine.subdivide.js` prices the steps.

- **The anisotropic metric's sign is the opposite formula from `treeEdges`', and both
  mean "+1 follows the image".** `siteMetrics` makes distance grow *faster* along the
  edge tangent at +1, so cells are short that way and dots pack tight along it;
  `treeEdges.anisotropy` at +1 makes an along-tangent edge *cheap*. A tree metric
  chooses which edges get drawn, a Voronoi metric chooses cell shape, and those want
  opposite formulas for the same visible outcome. Do not reconcile one to the other.

- **`det M = 1` is not about preserving cell areas.** It is easy to assume it is, and
  wrong: with per-site metrics the diagram is asymmetric, and two neighbours at ρ=4
  and ρ=1 both have det 1 while still not splitting their shared territory evenly.
  What it buys is the removal of the isotropic *dilation* component — the component
  that would move the Gersho drift `relaxSeeds` has measured at 1.18 on a four-to-one
  field. The dot count is safe for an unrelated reason: `stipplePoints` apportions by
  mass, never by area.

- **Anisotropic Lloyd needs its metric frozen for the run, and this is correctness
  rather than thrift.** The mass-weighted centroid is the argmin of
  `Σ m(p)(p−s)ᵀM(p−s)` only while `M` is held fixed — `M` is invertible so it cancels
  out of the update, which is why the change to `relaxSeeds` is so small. Re-sampling
  the field at each site's new position, the obvious implementation, adds a `dM/ds`
  term that the update silently drops, and the iteration stops being a descent step
  for any energy at all. That is the main way anisotropic Lloyd fails to converge.

- **`alignPoints` is gated on its ITERATION count, not on the anisotropy strength**,
  and the difference is not cosmetic. At strength 0 the metric is null and the pass
  is an ordinary damped Lloyd polish, which is worth having by itself: measured, it
  cuts the dot-overlap shortfall 4.6× at coverage 0.7 and 36× at 0.45, because
  evening the spacing puts ink the budget already counted back on the paper. While
  the pass was gated on strength that was unreachable. Strength decides whether the
  metric is anisotropic; iterations decide whether anything runs at all.

- **Anisotropic dot placement is not tone-neutral, even though the count is exact.**
  `coverage = n·πr²/area` assumes dots do not overlap, and alignment shrinks spacing
  along one axis by `√ρ` by design. The derived cap is `ρ ≤ (spacing/2·rDot)²`, which
  is `π/(4K)` at the tone model's own density — so **any** anisotropy overlaps once
  darkness passes `π/4 ≈ 0.785`. Overlap can only waste ink, so the error is always
  toward light; a measurement that came out dark would be a real fault.

- **Relaxation must jitter first, and that is where the placer's RNG-free property
  ends.** A regular lattice is a *fixed point* of Lloyd — on uniform mass every point
  already sits at its own Voronoi centroid — so on flat tone, relaxing without
  jittering leaves the grid exactly as it was, however many iterations you run. The
  jitter is seeded from `opts.seed` and clamped into each point's own leaf box, so
  placement stays seed-independent while a *relaxed* subdivision does not. Both halves
  are asserted: unrelaxed runs must ignore the seed, relaxed runs must respond to it.
  A relaxed run that ignored the seed would mean the jitter had stopped happening and
  the relaxation was doing nothing.

- **The harness is fully deterministic, and that is worth protecting.** Every
  stochastic method takes a seed; nothing calls `Math.random`. That makes "output
  byte-identical except the timing lines" a usable acceptance criterion for any
  refactor that should not change behaviour. Do not add unseeded randomness — a
  `|| Math.random` fallback that never fires today will fire eventually.

- **`inpolygon` counts on-edge points as INSIDE**, which is the right semantic for a
  region mask and the wrong one for an area integral. It was the other way round
  once, and the half-open crossing test silently dropped the right column and bottom
  row from every region mask in the app. See `docs/findings.md` — it produced two
  bugs that looked unrelated, in two different methods.

- **Do not re-inline the region mask.** The per-pixel `inpolygon` "whiten outside the
  polygon" loop was copy-pasted thirteen times before `spine/mask.js` existed; it is
  now one cached module with `tests/spine.mask.js` behind it, and every method that
  needs it imports `regionMask`/`polygonMask`. Five `inpolygon` calls remain outside
  it deliberately — they test arbitrary points (lattice sites, cell centres, segment
  midpoints) or a *region* polygon rather than the drawing polygon, so they are a
  different question and not a missed call site.
