# Findings

Lessons from measuring this app that belong to no single method. Every one of them
was paid for. They are here because they will recur — most already have.

The method files carry their own measured constants and the reasoning behind them;
this file carries only what transfers.

---

## On measurement

**Score shims against a closed form in the code, never against a number in a
comment.** The 8-connected chamfer's metrication error is `√(1+(√2−1)²) = +8.24%`,
peaking at 22.5°. A remembered "~2.7%" — roughly the *optimal-weight* 3×3 result,
misremembered — had been written into both the shim's comment and the harness's
threshold, so the harness dutifully flagged a bug in correct code. `anisotropyBound`
now computes the bound, and the test scores against that.

**A test that cannot fail proves nothing.** The first phase-to-spacing check seeded
the top row and measured straight down — an axis direction, where chamfer is exact by
construction. It read 0.000% and confirmed the identity in the only direction that
could not have been wrong. It now seeds a half-plane at a swept angle and reports the
*spread* across orientations, because a spread is what becomes visible banding.

**A test that fires on correct behaviour is worse than no test.** Its counterpart
above gets quoted more, but this is the one that actually costs time: a suite with
standing false failures teaches you to skim the FAIL column, and the real failure
then arrives invisibly. Four of them accumulated here, and every one was the same
mistake — a criterion applied to a case it was never about:

- The spiral-fill check scored the `rDot = 0.5w` row, which `dotPath` returns as a
  *single stamped point*, not a spiral at all. Its 8.5% excess is the renderer
  discretising a disc nine supersampled pixels across. Now excluded from the spiral
  verdict and scored on its own terms — it must err *upward* and by under 15%, since
  a stamped disc cannot under-cover.
- The circle-packing overlap check used a tolerance of `1e-6` px on circles that are
  placed *exactly tangent by construction*. It reported 306 overlapping pairs whose
  worst penetration was −0.011 px. The tolerance is derivable: the scan keeps
  distances per integer column, so half a column of offset buries two circles of
  radius `r` by about `1/(8r)`. Anything deeper is a real overlap; anything shallower
  is the sampling grid.
- The RMS-blend check swept `nLevels = 1`, which has no bracketing pair to blend
  between — `variableWaveField` sets `ks[0] = kHi`, so the whole field comes out at
  the shortest wavelength in the map. One measured number against three different
  predictions produced "worst 354%" about a configuration containing no blend. The
  sweep starts at 2 now, and the degenerate branch is checked separately against what
  it actually promises.
- The dither-grid `threshold` mode was scored per band. A single global threshold on a
  monotone ramp *is* a step function — bands 1–4 solid, 5–9 blank, mean correct to
  0.005. That is the mode's definition, not its error, so it is scored on the mean
  while the band table stays printed.

The common tell: in each case the failing number was **stable and explicable**, not
noisy. A criterion that a correct implementation cannot satisfy is a statement about
the criterion.

**Start an iterative method at the fixed point of its own map, or you measure the
transient.** Lloyd relaxation weighted by `ρ^e` converges to seed density `ρ^(e/2)` —
that is the Gersho exponent. The first version importance-sampled its starting seeds
from `ρ^e`, the same density it was weighting by, which looks natural and is wrong by
a factor of two in the exponent. Every seed then had to migrate, and on a
piecewise-constant field there is almost nothing driving the migration: in the bulk
of a flat region a seed already sits at its cell's centroid and does not move, so
only the seeds near a discontinuity have anywhere to go.

Measured, the seed-density exponent came out at **0.75e** for `e` = 1, 1.5 and 2 —
dead centre between the initialisation and the fixed point, in all three rows, with
the relaxation still moving after 60 iterations. Sampling instead from `ρ^(e/2)` puts
the distribution right on iteration zero and leaves Lloyd only the job it is fast at,
which is regularising cell shape.

**And when an iteration cannot reach its fixed point, change the algorithm rather
than the iteration count.** Fixing the initialisation made Lloyd land on `ρ^(e/2)`,
which was correct — and still needed tens of iterations, and was still only as good
as its convergence. The real answer was to stop needing convergence: a recursive
subdivision splits a region into children *by mass*, top down, so the count in every
region is right by construction at every level and the relaxation is left with only
the local arrangement of three seeds inside one cell, which settles in a handful of
steps. Faster *and* more accurate, because the two jobs — global redistribution and
local arrangement — were separated instead of both being asked of one loop.

The tell that this was available: the failure mode was specifically that seeds could
not *migrate*. A method whose weakness is global movement should be given a structure
that never needs global movement, not more chances to make it.

**Sweep the parameter you think you understand.** That diagnosis was only available
because the test swept the exponent rather than checking the shipped value. A single
column at `e = 2` would have read "wrong by 38%" with nothing to say why; three
columns showed a clean `0.75e` and named the mechanism.

**And look for the same story in a second column.** The same run reported a
coefficient of variation for ink per cell, which was lowest at `e = 1.5` — not at the
`e = 2` the theory prescribes. Uniform ink needs the exponent to reach 1, and at
`α ≈ 0.75e` that happens near `e = 1.33`, so the CV minimum sat exactly where the
*measured* exponent crossed 1 rather than where the intended one did. Two independent
columns agreeing on a wrong number is much stronger evidence than one column
disagreeing with a prediction.

**A ratio between two measurements is only as good as the worse one.** The
MST-to-Delaunay third failed at 0.242, and the natural reading was that the tree was
wrong. It was not: the table also reported Voronoi-to-Delaunay at 1.896 against the
same √3 the mesh section passes at 1.732 — and *that* ratio contains no tree at all.
Two of the three networks were being measured without a boundary ring, so the
outermost Voronoi cells were unbounded-then-clipped and the Delaunay carried long
thin hull triangles. The MST, which selects short edges, was immune. So a correct
tree measured against two inflated networks looked like a broken tree.

The general lesson is to carry a **control ratio that excludes the thing under
test**. Vor/Del was already in the data and would have named the cause immediately
had it been in the table; it is there now.

**Symmetry is a claim about the field, not about the formula.** A companion test
scored the anisotropy slider as failing because ±1 cost different amounts, on the
premise that parallel and perpendicular are the same distortion mirrored. That is
only true on a field with no preferred structure. The test ran on a radial ramp,
whose tangents run in circles, so `a = +1` builds a tree of circumferential edges and
`a = −1` one of radial edges — and radial paths connect a disc more cheaply. The
asymmetry was the correct answer to a question the test should not have been asking.
Testing it on an unstructured field would have made it pass and measured nothing.

**Then check that the rig can resolve the effect.** The replacement test located
crossings by rounding to integer pixels, quantising every reading to 0.347%, and its
rasterised half-plane seed put ~0.5 px of staircase ripple into the field — about
1.4% over the span measured, against a ±1.4% effect. All noise. The fixes were
bilinear sampling and **averaging each profile along the front**: the ripple varies
laterally, the signal does not. Both mistakes were in the measurement and both looked
like shim failures.

**Predict the number before reading it.** From `|∇P| = 1/maxᵦ cos(α−β)` the
16-connected normalised chamfer should read +1.37% at 0° and 45°, −1.41% near 13°,
≈0% near 36°; 8-connected raw should read 0% at 0° and 45° and −7.6% at 22.5°. The
noisy run's 0° reading was +1.39% against that +1.37% — which is how it was possible
to tell that the shim was right and the harness was not. Every measurement in this
project states its prediction first, and that is the reason.

**Keep a row whose answer is known in closed form as the rig's own calibration
check.** The first area-ratio sweep put its carrier on an integer supersampled row,
and every `A = 0` case came back 4.17% bright — *identically across all three
waveforms*, which is what identified it as the rig rather than the tone model. An
`A = 0` row costs nothing and catches renderer bias.

**Measure length and coverage separately, so overlap and geometry stay
attributable.** A single combined ratio cannot distinguish "the contour is the wrong
length" from "the right length of contour overlaps itself". With them split,
`refiningNoise` reads: length within 1.6% of Kac–Rice at every λ, and coverage equal
to `w × length` to within 0.2% at large λ falling to 0.887 only near black where
strokes begin to overlap. Neither half could have been established from the combined
number.

**Diagnose collapses with points-per-line, not with tone.** The tell for the
`simplifyLineDistance` bug was "46 strokes, 92 points" — two points each. A coverage
ratio of 0.22 says only "too little ink" and cannot say which stage lost it. The
harness now reports lines and points at each pipeline stage (contoured, resampled,
simplified, clipped), so the stage where the mean falls off a cliff names itself.

**A transformation of a structure must be checked against the structure, not only
against itself.** The spanning tree is cut into polylines before plotting, and the
first version started each branch path *at the child* rather than at its parent — so
the edge joining a branch to its trunk belonged to no path and was never drawn. The
decomposition makes one path per leaf, so it silently lost `leaves − 1` of the `n − 1`
edges: roughly a quarter of a planar MST, and every one of them a branch.

Nothing internal caught it. A path of `k` points contributes `k − 1` segments however
it was assembled, so the output was perfectly self-consistent — and the tone tables
would have reported a `κ` around 0.7 against a prediction of 0.88–1.0, which is
*suspicion*, not diagnosis. What settles it in one number is comparing the drawn
length against the sum of the tree's own edge lengths: the same segments summed two
ways, exact arithmetic, with a ratio near 0.75 naming the failure outright.

The general form: whenever a structure is re-expressed for output — a tree into
strokes, a contour into polylines, a mesh into edges — assert a conserved quantity
across the transformation. It is cheap, it is exact, and it fails with a number that
points at the cause rather than at the symptom.

**Report two ratios when there are two failure modes.** Stippling reports *count*
(dots issued vs ink present, which the growing controls) and *ink* (coverage actually
rendered). Count off means the budget is wrong; ink off with count at 1 is the tiling
shortfall, which is expected and accepted.

---

## On what tests miss

**A test that saturates cannot see the defect it sits closest to.** 10 PRINT's
tone-ceiling table passes at 0.007 and is the most direct check the method has — it
draws a solid black source and measures what one stroke gives its cell. It is also
structurally incapable of finding the bug that made every ramp too dark, because a
solid source marks *every* cell, so the ink a stroke spills past its own cell lands
on ink that is already there. The error is zero at both ends of the tone range and
maximal in the midtones, which is exactly where no test was looking.

Worth stating as a rule: a test at an extreme of the parameter it controls is testing
the extreme. The passing ceiling table and the failing ramps were never in tension —
they were measuring different things, and the ceiling's pass is what made the ramp
failures look like somebody else's problem for as long as it did.

**Two constants that look alike can behave completely differently, and only a sweep
separates them.** The same investigation modelled a stroke's coverage as one number,
`bar + cap` — its rectangular body plus its two round ends, over the cell area. At the
calibrated `L = 2w` that fits. The `L = 3w` and `4w` rows showed it is two mechanisms:
the **body tiles**, so it always contributes, while the **cap sticks out past the cell
corner** and only lays new ink when the collinear neighbour is unmarked. Measured, the
cap's contribution ran 0.98 / 0.70 / 0.52 / 0.25 / 0.01 across fill fractions — which
is `(1 − p)`, read straight off. The corrected form, `ink = p·bar + p(1−p)·cap`, holds
to 0.0016 with nothing fitted.

The sweep that caught it was the one that looked redundant: at `L = 3w` and `4w` the
first model predicted no spill at all, so those rows seemed to test nothing. They were
the only rows that could distinguish the two mechanisms, because they are where the
capsule fits inside its cell and the two terms stop moving together.

**Decide whether a tolerance is on a ratio or on an absolute, before setting it.** The
same table's verdict was first set at 1%, on the reasoning that a derivation with no
free parameter should do better than a fit. The measurement came in under 1.5% and the
threshold had to be relaxed — not because the model was worse than claimed, but because
the verdict scored a *ratio* while the residual is a roughly constant ~0.001 of
absolute ink. Divided by the ink present, one constant error reads as 0.1% where the
page is dark and 1.5% where it is nearly blank.

The general shape: a ratio-scored test is least sensitive where its denominator is
largest and noisiest where the denominator is small, so its worst row is usually its
emptiest one rather than its wrongest. Reading the direction of the drift tells you
which you are looking at — degrading with **fill** implicates the model, degrading as
fill **drops** implicates the divisor.

**A flat field cannot catch a blur bug.** `refiningNoise` set its smoothing σ from
the *mean* wavelength. Since `λ = 2.2214w/K` blows up as `K → 0`, on any image with
highlights the mean sits near the `λmax` cap: σ reached ~45 px, a 135-tap kernel, and
the wavelength map was smeared toward that capped value across the whole picture. The
symptom was visible wavelength broadening toward the right and bottom edges, where
replicate padding pulls hardest — and **every flat-field test passed**, because a
blur of any radius does nothing to a constant field.

Two lessons, not one. The second: **a statistic taken over a quantity that spans 27×
and is unbounded at one end is not a scale.** The derivation showed σ must be
absolute (`|∇λ| ≲ 1` is scale-independent, the λ cancels), which the mean-based
version had no way to satisfy.

**One off-by-one produced two unrelated-looking bugs in two different methods.**
`inpolygon`'s even-odd crossing test is half-open, and `fullPolygon` is `[1,nx]×[1,ny]`
— edges falling exactly on pixel centres. A point on the left or top edge collects one
crossing; one on the right or bottom collects none. So every region mask in the app
was missing two of its four edges.

Downstream: **`eikonalStripes`** planted no seeds along the right and bottom, so the
wavefront arrived from two sides only and piled into dense contours parallel to those
edges. **`refiningNoise`** gave that same ring the `λmax` wavelength and blurred it
inward, visibly broadening the noise. Two symptoms, two methods, one cause, and
neither looked like a shared-code problem from the outside.

It also explains a third thing, which is the part worth remembering. `refiningNoise`'s
measured contour length ran +0.4% at λ = 3.4 px rising to **+20%** at λ = 33 px —
*growing with λ*, which no overlap effect can do. The mechanism was entirely
downstream of the mask: the `λmax` ring made the wavelength map non-constant, which
activated the level stack, which made the blend weights vary, which added an `f·∇α`
term to `∇f` and inflated `λ₂`. Extra contour length, in a fixed-width band at the
right and bottom, whose relative contribution grows as the interior gets sparser.
After the fix the ratios collapsed from `1.004 / 1.003 / 1.016 / 1.052 / 1.198` to
`1.015 / 1.008 / 0.999 / 0.997 / 0.992`.

The doc comment had previously *excused* the ambiguity — "the callers all dilate or
trim after" — which was true of the early methods and quietly false once anything
started masking with it.

---

**A test can be right on a quarter of its domain and return a confident zero.**
`orientField` looked for the winding of a line field around each triangle by sampling
its three *edge midpoints*. Those three points enclose only the **medial triangle** —
a quarter of the face's area — so a singularity sitting in one of the three corner
regions is not inside the sampled loop at all and produces no frustration. On a field
with a known half-index defect it reported **zero defects**, not a wrong count. The
fix was to sample six points, alternating vertices and midpoints, which enclose
anything inside the face. A test that reports nothing is easy to read as "nothing is
wrong"; ask what region of the input the check actually covers.

**A prediction written after the implementation is not a prediction.** The flat-field
κ table for `triStripes` computed its own expected spacing by applying the tone ladder
to the *remapped* brightness — the same substitution the method itself was making —
so it compared the code against a restatement of the code, and passed at κ ≈ 1.00
while the ramp was 23% out at the dark end. The ladder's argument is the raw `[0,1]`
value; its affine map **is** the remap into `[Lmin, Lmax]`, so feeding it a remapped
brightness applies the squeeze twice. The rule: a prediction has to be derivable from
the documented model without reading the implementation, or it tests nothing.

**Know whether your bound is a bound.** The TSP harness bracketed tour length in
`[0.7124, 1.0746]` and failed correct tours. Only the lower end is a theorem
(Beardwood–Halton–Hammersley, for the *optimal* tour through uniform random points).
1.0746 is the length of one particular good tour on one particular point set — a hex
lattice walked in rows — and an arbitrary tour can exceed it without limit. The
unimproved MST crawl measured 1.14–1.24: not broken, just the textbook ≈1.25
approximation ratio. A ceiling that some correct inputs exceed is a ceiling on the
wrong quantity.

**Fit each constant to the effect it models, not to the residual.** `tspTour` has two
constants: `C`, how long a tour is, and `A`, how much the strokes overlap. `C` is
measured from tour *length* with no rendering involved; `A` is then fitted from
*rendered* coverage with `C` held fixed, using the fact that `1/coverage` is linear in
`d` — so the fit is a straight line whose residual tests the coverage law itself. Two
effects, two measurements. One curve fit with two free constants would have absorbed a
wrong `C` into `A` and reported a good ramp either way.

**Prefer an identity test to a distributional one.** The radial transport was first
checked by a distributional property — with a uniform target the count inside `r`
must grow as `r²` — and a badly broken implementation passed the *shape* of that
while returning concentric rings and an empty disc 45 px across. Replacing it with
"if the source density already matches the target, every point must end exactly
where it started" made the same bug impossible to hide, because an identity admits
no plausible-looking near-miss. Where a transformation has a known fixed point, test
*that*, not a statistic of the output.

**Three unrelated inputs agreeing to four decimals means the input is being
ignored.** Square, triangular and phyllotactic point sets all returned `0.0000` and
`0.5000` for the same two ratios. That could not be a density error — the three sets
have nothing in common except being fed to the same function — and it localised the
bug immediately to a step that discarded the points' own coordinates. Suspicious
agreement between cases that ought to differ is as informative as disagreement
between cases that ought to match.

**A control that differs in exactly one structural property is worth more than a
tighter tolerance.** When the transport under-supplied rays, it failed on the square
and triangular lattices and never on phyllotaxis. A spiral is the one arrangement
with no *rows*, which pointed straight at thin angular bins falling between lattice
rows — an aliasing problem — rather than at the source disc being too small, which
is what two rounds of adding margin had assumed.

**The number with no derivation behind it is where to look.** That aliasing bug was
360 angular bins, chosen because it looks like a natural number of angular steps and
nothing else. Every other quantity in the module — `sqrt(2/sqrt(3))`, `1/sqrt(pi)`,
the mass integral, the source radius — came from an argument. It took two failed
fixes to look at the one that did not, because the symptom (rays coming up short)
resembled a margin problem. The answer was `nT = pi*rMax/d`, which sizes a bin at
two spacings across at the far radius.

**A margin measured in the wrong units cannot be tuned into the right ones.** The
first attempt at that same bug widened the source disc by a percentage of its
radius. But the quantity going short was measured in *lattice spacings*, so the
correct margin is additive: `safety*d^2/(need*dTheta)`, derived from how many points
a bin expects in the annulus beyond what it needs. Percentages and lengths do not
mix, and a "tuning parameter" that never quite works is often a unit error wearing a
disguise.

**Build it, measure it, and delete it if it does not help.** `radialRemap` shipped
with a multi-pass control that was implemented twice — once with a rank-based density
profile (density error 0.067 → 0.172) and once with a properly smooth one (0.067 →
0.076) — and removed, because neither reduced the error it existed to reduce. The
reason turned out to be structural: the density estimator's kernel must be about 1.5
spacings wide or it transports the lattice's own periodicity away, and the residual
being corrected sits at that same scale, so the estimator is blind to exactly what it
is meant to fix. The failed attempt is documented in the module header with its
numbers, which is more useful to the next person than the absence of a feature would
have been.

**A stopping threshold above zero biases the result by its own value.** String art
stopped when the best chord's mean residual fell below the per-pixel break-even
point `opacity/2` — correct about one pixel, and wrong about a picture, because it
leaves *every* part of the drawing short by that much coverage. Predicted +0.125 of
brightness at `opacity = 0.25`; measured +0.143 and +0.145. If a threshold is the
only thing ending a loop, check whether the quantity it thresholds is also the
quantity you care about being zero.

**Clamping a residual destroys the signal that would tell you to stop.** The reason
that threshold existed at all is that the source pins its residual at zero
(`imDiff(imDiff<0) = 0`), so an over-inked region looks *satisfied* rather than
*overshot* and no action can ever score worse than doing nothing. Unclamp it and the
floor becomes zero — derived, not chosen — and the search stops exactly where the
ink laid equals the ink wanted. A clamp that hides the sign of an error usually
costs a tuning parameter somewhere else.

**Bound a penalty by what the action can actually do.** Scoring a chord by mean
residual is unbounded below once the residual is signed, so one deeply over-inked
region could veto a chord that would have served an entire under-inked one. But a
chord lays at most `opacity`, so it can do at most `opacity` of harm: the correct
score is the error it removes, `clamp(2r − opacity, ±opacity)`. With the unbounded
version a radial ramp came out uniformly light, because chords serving the outer
ring were vetoed by a centre they had already saturated.

**What the method cannot reach belongs in the target, not the error.** With nodes on
an inscribed circle no chord can touch the page corners, ever. Those pixels rendered
at exactly 1.000 against a target of 0.799 and were charged +0.201 for doing the only
thing available to them — which measures the node geometry, not the halftoning.

**A constant that drifts with the operating point is not a constant, and ordering
the rows by the suspected driver is how you see it.** `CHORD_BIAS` looked stable at
one setting and was fitted from it. Re-measured at two chord counts it read 0.93 and
1.31, and sorting the table by chord count made the mechanism obvious: the greedy
takes the long crossing chords first, so the mean drawn length *falls* as a run gets
longer. It was removed rather than re-fitted. `STRING_KAPPA` survived the same
scrutiny — it drifts too, but by ±4% with an understood cause — which is the
difference between a constant and a number that happened to fit.
---

## On porting from the collection

**A dependency scan that matches commented-out code will mislead you.**
`disentangleLine` was listed as an `sfcCollapse` dependency on the strength of a call
at `regionsSFCcollapse.m:105-106` that is commented out. 326 lines of it.

**Check whether the branch the demo exercises is the branch the source says it
takes.** Two cases here, both found by reading rather than by measuring:
`regionsEikonalStripes.m`'s `distMode = 2` calls `linspace(0, s(end), 0.5)`, and a
non-integer count returns empty — so no seeds are planted and control falls through
to a border-seeding guard. "From edges" was really "from the image border" all along.
`regions10PRINTHatching.m`'s Hilbert branch has the same character: it `interp1`s over
vectors that only match length when the power-of-two square exactly covers the grid.

**A set-and-never-read variable is a decision that was never made.**
`fixCirclePackingScan.m` declares `fineTuneY = 1` and comments out both branches that
would use it, so every circle snaps to an integer scanline — at this app's scale a
~20% bias on the smallest radius. The port enables it and carries the switch as a
named module constant, because it is the one place the port moves geometry the source
did not, and therefore the first thing to try if the calibration comes out wrong.

**Fitted constants are acceptable when the *variable* is derived.** The sine's peak
overlap uses `ρ = 2R/w = L²/(π²Aw)`, which is exactly 1 at the onset of
self-overlap — and the measured onset lands there, at every envelope height.
Rewriting the measured excess in `ρ` collapses three envelope heights onto one curve,
which is the evidence that `ρ` is the right variable. Two constants are then fitted to
that curve, the fit range is stated, and the data is recorded. That is a different
thing from `phi = phi*0.95`, an undocumented scalar in the source with no derivation
behind it, which is not ported. Take the derivation away and it would be the same sin.

**Prefer an observable to a fit parameter, and then measure it.**
`TANGENCIES_PER_CIRCLE` has a predicted value (just above 1 — the scan places each
circle tangent to exactly one existing constraint) and a direct measurement, so if the
counted value lands nowhere near 1 the *derivation* is wrong rather than the constant.
That is what distinguishes it from a two-constant curve fit.

---

## On the shape of the code

**Contour crossings are identified by grid EDGE, not by coordinate.** Every crossing
lies on one horizontal or vertical edge between samples, and an interior edge is
shared by exactly two cells — so linking segments into ordered polylines is exact
integer bookkeeping, with no floating-point point-matching and no tolerance to tune.
That is the whole reason a contour tracer is tractable to get right rather than a
source of mystery gaps.

**Contour tests check theory, not self-consistency.** A plane must contour to
*exactly* straight lines (`|f(point) − level| < 1e-9`, not "looks straight"), a cone
to circles of a known radius that close on themselves, and a saddle must produce **no
dangling interior ends** — a contour may only terminate at the grid border or on
itself. That last one is the failure mode that would surface downstream as broken
stripe paths.

**A correct algorithm often cannot fail the way the broken one did, and that is worth
checking explicitly.** `simplifyLineDistance` measured each point against a chord
always two steps long, so deviation never accumulated and every interior point was
dropped, returning `[first, last]` — a degenerate zero-length line on a closed
contour. The correct greedy version recomputes each point's cost *against its
surviving neighbours*: when one interior point is left on a closed loop its neighbours
are the coincident endpoints, so the chord has zero length and the cost is enormous.
It is never removed. The collapse was only ever reachable through the broken measure.

**Smooth a structure tensor AFTER the outer product, never before.** That is what
lets it represent crossing edges instead of cancelling them, and it is the difference
between a working structure tensor and a broken one.

---

## On consolidating what was copied

The histories below all belonged to a module header at some point. They are here
rather than there because they are the same lesson learned repeatedly, and a
maintainer needs the *invariant* at the code and the *pattern* somewhere it can be
read once.

**Copies do not have to disagree to be a problem; they have to be able to.** The
per-pixel "whiten outside the polygon" loop was written thirteen times, with four
spellings — whiten in place, `continue` past it, build an index list, and one file
that built the same mask twice — and every copy was correct. That is exactly why the
question would never have been forced. What was actually at stake was not line count
but a *contract*: "which pixels count" is an agreement between the units layer and
every method, and the 1-based pixel-centre convention (`inpolygon(ix+1, iy+1)`) is
the part most able to drift, because a copy that got it wrong by half a pixel would
still draw a plausible picture — it would merely disagree with `renderStrokes` about
where the page edge is, and surface as an unexplained percent in the tone harness.
One cached `spine/mask.js` with a test behind it now, and five deliberate
`inpolygon` calls left outside it, because they ask a different question (arbitrary
points, or a region polygon rather than the drawing polygon).

**A seeded RNG's call sequence is part of its identity, so consolidating copies of
one is an operation-by-operation comparison, not a tidy-up.** Four methods held
byte-identical private `mulberry32`s; the bodies were compared before merging, and
every drawing came out untouched. The harness kept a fifth copy under a different
name for longer, which is the version of the mistake worth naming: a private copy in
the *test* rig can let a determinism check pass while the app's own RNG has moved.

**An export with no caller is an under-specified contract, and it will drift.**
`targetImage` was part of the method contract, five methods implemented it, and for a
long time only the harness called it — so the app scored band-limited methods against
the source image and reported a large permanent error for methods performing exactly
to spec. Nothing failed; the contract simply meant less than it said. The same shape
appeared twice more: `renderStrokes` carried a `roundTips` option no caller ever
passed, and the worker read `output.joinTolerance ?? 1.5` from an object that never
carried the field, so the fallback was the only value that ever ran. When a contract
has a side that never executes, delete the side or make it execute.

**Keep the geometry channel exactly one type.** A method that wants to say something
about its run — why it stopped, how much budget it spent — must not say it by
returning `{ lines, note }` instead of `lines`, because 38 direct `method.run()` call
sites in the harness would become a latent break the moment a second method adopted
the richer form. `spine/notes.js` is a module-level write-only channel instead, which
is acceptable precisely because nothing reads it back to make a decision: it cannot
touch geometry, tone, or the RNG's call sequence, so determinism is untouched.

**When two versions of a helper differ, keep the superset only if it cannot change a
finite result.** Table interpolation existed twice — an ascending-only version and
one that also handled descending tables. The superset was kept because for an
ascending table the two agree everywhere except where the older one divided by a zero
span and returned NaN. "Strictly better on inputs that were already broken" is a
merge you can make without a measurement; anything else is not.

**A file sliced out of a bigger one inherits that file's imports.** Every
`tests/method.*.js` was cut from one 2000-line harness and carried the whole original
import block, most of it unused — the kind of dead weight that is invisible per file
and obvious only across the directory. Worth a sweep after any split.

**A quantiser that discards its remainder is a systematic bias, not a rounding
error.** `dashHatching` places a mark each time an integral of ink owed passes one
mark's worth, then moved to the next carrier and threw the leftover away — half a
mark per carrier on average, 2.8% of the ink on a 53-carrier page, always light and
never visible as anything but "the tone model is slightly wrong". Two things make it
worth recording. First, the fix is not a correction factor but carrying the debt, so
that nothing is created or destroyed across the whole drawing. Second, the bug was
being *partly masked by an unrelated control*: the phase offset seeded each carrier's
accumulator, which handed some of the remainder back, so the three phase modes
measured 0.933, 0.956 and 0.978 of the requested coverage. A control that was
supposed to change arrangement was changing tone, and the mode that happened to be
unbiased was the one nobody would have tested first. When a claim of exactness
measures a few percent off, look for something being dropped at a boundary before
looking for a missing term.

**A shared tolerance encodes an assumption about every method that will ever use
it.** The pipeline joins paths whose endpoints fall within 1.5 pen widths, which
reads as "these are two ends of one interrupted stroke". That is right for a network
method, where joining at a shared vertex is what the corner is *for*, and wrong for a
hatching method whose stroke spacing is a user control with a floor of one pen width:
below 1.5 the joiner started chaining a dash on one carrier to a dash on the next,
drawing a V across the grain. The fix is not a global angle guard — that would break
the network methods, which want their corners — but an optional per-method cap that
can only tighten the default. The general shape: when a shared constant is really an
assumption about the caller, the caller is what should be able to state it.

**Simplifying a path and sampling a path are different operations, and doing the
first destroys the second.** `dashedStreamlines` partitions the page among its
carriers by assigning each pixel to the nearest carrier SAMPLE, and it took those
samples at the carriers' vertices — after simplification. `simplifyLineDistance`
returns `[first, last]` for anything straight, so a straight carrier arrived with two
samples, both at its ends, and the entire middle of the page was assigned to a distant
endpoint or dropped past the assignment cap. A flat field rendered at 9% of the tone
it asked for. The same bug on curved carriers is quieter and therefore worse: arcs
simplify to chords of about `2.4*sqrt(R)`, so the samples were roughly 24 px apart at
R = 100 and the drawing came out 10–13% light — a number small enough to be mistaken
for a modelling error and chased in the wrong place. Vertices are wherever the
simplifier happened to leave a point; if the algorithm needs a spatial density,
resample by arc length and never inherit the geometry's own point distribution.

**A tolerance derived from another module's internals goes stale silently.** The
dashed methods cap the pipeline's join tolerance so it cannot weld a dash on one
carrier to a dash on the next. For straight carriers, half the stroke spacing is
provably safe. Carried over to streamlines it was quietly wrong: `d_test` lets a
growing line run in to *half* the separation, and the proximity index stores a sample
only every quarter of it, so two lines can close to about 0.375 of the separation —
which at 4 pen widths is exactly the pipeline's default, and the joiner drew
177-degree hairpins. The fix was not a better-derived bound but a bound that depends
on nothing: these methods never want a gap bridged at all, because a gap is precisely
where the integral said there should be no ink, so the only join they ever want is
between marks that already touch. The tolerance is floating-point slop, not a fraction
of anything.

**When a shortfall gets WORSE as the structure gets sparser, stop suspecting
crowding.** `dashedStreamlines` rendered 6–15% less ink than it charged, and the
obvious readings were all about things being too close together: marks overlapping
because the packing had collapsed, caps overlapping at abutments, the renderer
under-counting thin strokes. Every one of those predicts the error shrinking as the
lines are spread out, and the measurement did the opposite — 6.8% at eight pen
widths, 15.3% at sixteen. That inversion was the whole diagnosis, and it was visible
two rounds before it was believed.

The cause was a closed orbit traced twice. `streamlines` grows a line as two
independent halves from its seed; neither half is in the shared proximity index yet,
because a line is indexed only once accepted, and each half self-checked against its
own points alone. On a field whose orbits close — a radial ramp's streamlines are
exact circles — each half ran the whole way round, stopping only when it met its own
tail, so the polyline was two loops of one circle laid on top of each other. The
budget paid for both and the paper received one. Sparse separations meant fewer,
larger, cleaner circles and so a higher proportion of doubled ink.

**Two lessons, and the second is the general one.** An ink LEDGER localises what a
tone ratio cannot: demand, charge and render priced separately in the same units
said "the law is right and the marks are overlapping" in one table, after two rounds
of reasoning from a single number had produced two wrong hypotheses. And a sum is
not a union — any budget that adds up marks is asserting they do not overlap, which
is an assumption about geometry that belongs in a test rather than in a comment.

**A test section that borrows another's output is not independently runnable, and
that is the one property a split harness exists to provide.** `pipeline` read its
input from a `shared` channel that the `hatching` section filled in, so
`run-tests.mjs pipeline` died on "(intermediate value).linear is undefined" — an
error that names neither the section it needed nor the reason. The dependency was
documented in a docstring, which is where a footgun goes to be ignored: the whole
payoff of splitting a harness is that a change isolated to one method can be
re-verified in seconds, and a section that only runs in company quietly withdraws
that payoff. Rebuilding the input costs one recomputation and both halves are
deterministic, so the full-suite numbers do not move. If a section ever needs
another's result again, have it build the input — a cross-section channel makes an
ordering requirement that is invisible at the call site and surfaces only as a
destructuring error.

**A level set measured in a metric is not a band of paper.** `lappingShapes` picks
each shape's radius so the rim's ink equals the darkness it claims, and it estimated
that ink by counting the area between two level sets of the shape's own distance
metric, `r <= m < r + w`. The band `r <= m < r + d` has GEOMETRIC width `d/|grad m|`,
so covering a strip one pen wide needs a band of metric width `w*|grad m|`. Three of
the four metrics have `|grad m| = 1` — Euclidean everywhere, Chebyshev on a face —
which is exactly why the fourth went unnoticed for so long: the diamond is L1, its
faces have normal `(1,1)/sqrt2`, and its band was 0.707 of the paper it was charged
for. The same correction was already written down in the same file for the blob
metric, where the cost field makes `|grad m|` vary per pixel; nobody carried it back
to the analytic metrics, where it is one constant per shape.

**What found it was reading the table DOWN a column rather than across.** The
verdict quoted a single worst-case number and blamed the quarter-pen radius ladder,
which is plausible until you notice the per-shape figures: circle 1.033, angled
0.998, square 0.937, diamond 0.867. The ladder is identical for all four metrics, so
it cannot produce a spread between them — only a per-metric term can. A test that
reports one aggregate hides that; a test that reports the population lets the shape
of the error name its own cause. Prefer the second, and when a note explains an
aggregate away, check that the explanation would produce the distribution actually
observed.

**When the instrument and the subject share a model, a systematic error can be
either one, and a ledger is what tells them apart.** `quadHalftone` failed its tone
ramps and every reading of it was a guess until the ink was priced in three places:
what the image asked for, what the recursion's own accumulator committed, and what
the renderer found. Committed-over-asked came out at 1.00 on every field under the
dithered rule — the decision rule was exactly right — while rendered-over-committed
sat at 0.83 to 0.89 on all eight rows regardless of rule. The ink was being decided
correctly and then measured short, and no change to the method could have helped.

The cause was the renderer's open-interval test, which drops a sample row from any
stroke that sits on one. It costs `1/W` and only for strokes that hold one phase
along their whole length, so it is invisible for every method at mixed angles and
total for the one method whose strokes are all axis-aligned. **A bias that depends on
the subject's geometry will look like a property of the subject.** The tell was that
it did not vary with the decision rule, the field, or the tone — only with the
direction of the marks.

**And the correction goes in the instrument.** The tempting place was the method's
`targetImage`, which would have made the numbers agree immediately — and would have
told every user of the app that this method cannot reach a tone that it reaches
perfectly well on paper. A measurement artefact belongs in the thing doing the
measuring; a `targetImage` is a claim about ink on paper.

**A correction can be right and still be applied in one place too many.**
`polygonSubdivision` estimated a polygon's ink as `P*w/2`, counting each edge's
stroke separately when edges that meet share paper. The correction was derivable --
two strokes of width w crossing at a vertex share `w^2`, half charged to each edge,
two ends per edge -- and it validated beautifully: predicted shortfalls of 0.785 and
0.917 against measured 0.781 and 0.914, at densities four times apart. Then applying
it made the drawing WORSE, flipping the midtones from 0.13 too light to 0.16 too
dark.

The model was not the problem; the second call site was. The method has two tests: an
absolute one -- "have I already laid the ink this darkness wants" -- and a
comparative one that rejects a split making the match worse. The absolute test needs
the ink that reaches paper. The comparative test does not: feeding it the corrected
rate meant the rate FELL every time edges shortened, so each split lowered the bar
the next split was judged against, and the recursion ran to its depth cap on fields
that should have stopped early.

**The tell was in the stroke counts, not the tone.** Two different fields both landed
on exactly 8191 strokes -- `2^13 - 1`, a complete subdivision to the cap -- which no
image-driven rule should produce for two different images. A tone number would have
said only "too dark". Count the structures a method builds, not just the ink it lays:
a saturated count names the mechanism that a tone error only gestures at.

**A known defect should be recorded as a baseline, not waived.** Seven checks in
this suite measure real shortfalls that are diagnosed but not yet repaired. Both
obvious ways of handling that are wrong. Leaving them FAILING teaches the reader to
skim the column, which is how the next real failure arrives unnoticed. Switching
them off frees the number to drift, which is how a diagnosed defect quietly becomes
a worse one.

So the measured value becomes the bar: the test carries the numbers observed when
the diagnosis was written, passes only while the drawing is no worse than that, and
says REGRESSED rather than FAIL when it moves. It reports in its own colour, because
a recorded shortfall must not read as green. Three properties make it honest rather
than a rubber stamp: the margin is tight (a percent, on deterministic drawings), the
cause is written at the call site so the record cannot outlive its explanation, and a
run that comes in BETTER than the record says so -- a stale baseline means the
diagnosis wants revisiting, and that is worth knowing too.
