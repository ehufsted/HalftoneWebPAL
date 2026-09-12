# HalftoneWebPAL

An HTML5 app that turns an image into constant-width strokes and exports
pen-plottable SVG. Twenty-four halftoning methods, most of them ports of the
MATLAB in Esteban's `singleWidthLines/code/`, each with its tone model measured rather
than assumed.

## Running it

Browsers block ES module imports from `file://`, so it needs to be served.
No installs required:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open:

- <http://localhost:8080/> — the app
- <http://localhost:8080/verify.html> — the verification harness

Any other static server works too; on itch.io it is just a zip with
`index.html` at the root.

## Layout

```
index.html      app shell (markup + styles)
verify.html     harness shell — imports tests/, paints their output
run-tests.mjs   headless runner (node/deno), if a JS runtime is available
serve.ps1       zero-install static server
assets/         bundled sample images (author's own); the rest are procedural
src/
  app.js        UI wiring
  worker.js     all compute, off the main thread
  shim/image.js MATLAB image-toolbox equivalents
  spine/        the plotter-side machinery every method shares — read the
                directory rather than a list here, which went stale twice
  curves/       hilbert (curve and index), hCurve
  methods/      one module per halftoning method
docs/
  architecture.md cross-cutting invariants; traps before editing spine/
  findings.md     transferable lessons from measuring this app
  status.md       what is ported, what is measured, what is still open
tests/
  runner.js     say()/num(), fixtures, runToneTest — no DOM
  report.js     the ONLY DOM-aware file; paints accumulated output
  index.js      ordered section list (order is part of the contract)
  spine.*.js    one per shim
  method.*.js   one per method
```

**The harness is DOM-free except `tests/report.js`.** `src/spine/` and `src/methods/` never
touched the DOM, and the one helper that did (`showImage`) is now guarded on
`typeof document`, so the numeric core runs headlessly:

```
node run-tests.mjs                  full transcript, timings stripped
node run-tests.mjs --tsv            just the pasteable measurement blocks
node run-tests.mjs circlePacking    one section
```

That matters more than tidiness: every verification in this project has been a manual
round-trip through a browser. If the headless path works, a regression check becomes
`node run-tests.mjs > after && diff before after`, and changes can be verified one at a time
instead of batched to save round-trips. In the browser, `verify.html?only=spine.geodesic` does
the same subsetting.


## Where things are written down

Four homes, and the split is deliberate:

- **Method files** (`src/methods/*.js`) — each method's tone model, its measured
  constants, what was deliberately not ported from the MATLAB and why. This is the
  primary record; it travels with the code it describes. Read the header before
  changing a method.
- **[docs/architecture.md](docs/architecture.md)** — the cross-cutting invariants:
  layering, the units contract, the image convention, "the renderer is the
  calibration", the method contract including `targetImage`, and the **traps when
  changing shared code**. Read the traps before editing `src/spine/`.
- **[docs/findings.md](docs/findings.md)** — the transferable lessons from measuring
  this app: how to build a rig that can fail, what flat-field tests miss, the
  recurring shapes of a bad port, and what consolidating copied code costs.
- **[docs/status.md](docs/status.md)** — the working record: what is ported and
  from where, what each method's constants rest on, the known shortfalls, and the
  open measurement questions.

This README keeps only what is about *running* the project and adding to it.

## Adding a method

Drop a module in `src/methods/` exporting:

```js
export const id = 'myMethod';
export const label = 'My method';
export const params = [
  { key: 'foo', label: 'Foo', type: 'range', min: 0, max: 10, step: 1, def: 3 },
  // min/max may also be (settings) => number, for a bound that tracks the pen
  { key: 'bar', label: 'Bar', type: 'range', min: (s) => s.penWidth * 20, max: 6, step: 0.05, def: 1 },
  // `when` hides a control that does not apply to the current settings, rather
  // than leaving it visible and inert. Hiding keeps its value.
  { key: 'baz', label: 'Baz', type: 'range', min: 0, max: 1, step: 0.1, def: 0.5,
    when: (p) => p.foo > 3 },
];
export function run(ctx) { /* ... */ return lines; }   // [[ [x,y], [x,y] ], ...]

// Optional, but REQUIRED if the method cannot reach every tone -- see below.
export function targetImage(ctx) { /* ... */ return image; }

export default { id, label, params, run, targetImage };
```

and register it in `src/methods/index.js`. The UI builds its controls from `params`;
the worker just calls `run`. **`run` returns polylines and nothing else** — if a method
needs to tell the user something about the run (why it stopped, how much of a budget it
spent), it calls `setNote(text)` from `spine/notes.js` and the app shows it beside the
tone error. See `stringArt`, and the contract note in
[docs/architecture.md](docs/architecture.md#saying-something-about-the-run). `ctx` carries `{ im, nx, ny, w, Lmin, Lmax, polygon,
pxPerCm, ... }` in **pixel space, 1-based coordinates**, matching the MATLAB
`(X, Y, im, polyx, polyy, ...)` signature so ports stay readable against their
source. Return polylines in the same pixel space — `units.js` converts back to
centimetres.

**If the method has a reachable brightness band narrower than `[0,1]`, export
`targetImage(ctx)`.** It returns the tone the method is actually aiming for, per
pixel. Without it the worker scores the drawing against the source image and reports
a large error for a shortfall that is the method's *specification* rather than its
error — which is exactly what happened for a long time to five methods that had the
export but no caller. For the usual case, `spine/tone.js` `affineTarget(ctx, band)`
squeezes the source into a band; see `eikonalStripes` for the two-line version and
`circlePacking` for a method whose tone relation is not affine and must evaluate its
coverage law per pixel instead.

Then add a section to `tests/` and register it in `tests/index.js`. **State the
predicted number before running the measurement** — the whole verification practice
here rests on that, and `docs/findings.md` explains what goes wrong without it.

Full contract details, including the fidelity/reach split and the recurring tone-model
shapes, are in [docs/architecture.md](docs/architecture.md).

