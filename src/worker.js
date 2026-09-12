// All compute runs here so the UI stays responsive.
// Message in:  { type:'run', jobId, img, settings, methodId, params, output }
// Message out: { type:'progress'|'done'|'error', ... }

import { blurGaussian, makeImage, resize } from './shim/image.js';
import { prepare, toPhysical, toPixels, simplifyLengthFor } from './spine/units.js';
import { renderStrokes } from './spine/render.js';
import { optimizeOrder, joinCoincidentLines } from './spine/pathOptimizer.js';
import { simplifyAll } from './spine/simplify.js';
import { pathLength, travelLength } from './spine/geometry.js';
import { takeNote } from './spine/notes.js';
import { METHODS, byId, defaultsFor } from './methods/index.js';

// There is no cancellation inside this file: `runJob` is synchronous end to end,
// so a queued 'run' cannot be observed while an earlier one is in flight.
// Cancellation lives in app.js, which terminates this thread and spawns a fresh
// one (`cancelInFlight`) — the only thing that can stop a synchronous body.
self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'thumbs') { runThumbs(msg); return; }
  if (msg.type !== 'run') return;
  try {
    const result = runJob(msg);
    self.postMessage({ type: 'done', jobId: msg.jobId, ...result.payload }, result.transfer);
  } catch (err) {
    self.postMessage({
      type: 'error', jobId: msg.jobId,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : '',
    });
  }
};

function progress(jobId, stage) {
  self.postMessage({ type: 'progress', jobId, stage });
}

/**
 * Width of a style-browser tile, in pixels of compute raster.
 *
 * Also the raster the method runs at, so the cost of a tile is the cost of the
 * method on ~7000 pixels. That is what makes twenty-five of them affordable.
 */
const THUMB_PX = 96;

/**
 * Page width a tile pretends to be printing on, in centimetres.
 *
 * A TILE IS A SMALL PRINT, NOT A SHRUNK ONE, and that distinction is the whole
 * design of this. Scaling the real page down is useless: at A5 a 0.5 mm pen is
 * 0.23 px across in a 96 px tile, so a faithful miniature of a plotter drawing is
 * a blank sheet with a grey haze on it. Every method would look identical.
 *
 * Holding the pen width and shrinking the PAGE instead keeps the marks the size
 * they really are relative to the pen -- one pen width comes out just under a
 * pixel -- so the tile shows the texture, which is the only thing that tells two
 * methods apart. What it costs is honesty about scale: the tile is a real 5 cm
 * plot, not a view of the 21 cm one the app is set to, so the same method on A5
 * comes out finer. The browser says so.
 */
const THUMB_CM = 5;

/**
 * One tile per method, posted as each finishes.
 *
 * DELIBERATELY NOT `runJob`. A tile needs prepare, run and render, and nothing
 * else: path ordering, joining, simplification, the blur and the fidelity
 * measurement are all invisible at this size and together cost more than the
 * three stages that matter. The lines also stay in pixel space throughout, since
 * only the SVG export and the length stats ever wanted centimetres.
 *
 * Each method runs at its own defaults, which makes the browser a defaults audit
 * as well as a picker -- the tone tests pin their parameters explicitly, so a
 * changed default is otherwise invisible to the harness.
 *
 * A method that throws posts a tile with no data rather than taking the run down;
 * one broken method must not cost the other twenty-four.
 */
function runThumbs({ jobId, img, settings }) {
  const s = { ...settings, drawingWidth: THUMB_CM, pxPerCm: THUMB_PX / THUMB_CM };
  for (const method of METHODS) {
    try {
      const ctx = prepare(img, s);
      takeNote();
      const lines = method.run({ ...ctx, ...defaultsFor(method) });
      takeNote();                       // a tile's note is nobody's business
      const im = renderStrokes(lines, {
        wLine: ctx.w, imW: ctx.nx, imH: ctx.ny, outScale: 1, superSample: 3,
      });
      self.postMessage(
        { type: 'thumb', jobId, id: method.id, w: im.w, h: im.h, data: im.data },
        [im.data.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: 'thumb', jobId, id: method.id,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
  self.postMessage({ type: 'thumbsDone', jobId });
}

function runJob({ jobId, img, settings, methodId, params, output }) {
  const method = byId(methodId);

  progress(jobId, 'preparing');
  const ctx = prepare(img, settings);

  progress(jobId, 'placing strokes');
  const args = { ...ctx, ...params };
  takeNote();                       // clear anything a previous job left behind
  const linesPx = method.run(args);
  // Whatever the method chose to say about this run, if anything.
  const note = takeNote();

  // step 8: back to centimetres before any path work, as superRegions does
  let lines = toPhysical(linesPx, ctx.pxPerCm);

  // Both derived from the pen, neither exposed as a control.
  const JOIN_TOLERANCE_PENS = 1.5;      // endpoints within this join into one path
  // A method may tighten the default, and some must. 1.5 pen widths assumes no
  // method places distinct strokes that close together, so two nearby endpoints
  // are two ends of one interrupted stroke — true of a network method joining at
  // a shared vertex, false of a hatching method whose carrier spacing is a user
  // control flooring at one pen width, where it chains a dash on one carrier to a
  // dash on the next and draws a V across the grain.
  //
  // The hint is optional, in pen widths, and can only tighten the default, so a
  // method that does not export it is unaffected.
  const joinPens = method.maxJoinPens
    ? Math.min(JOIN_TOLERANCE_PENS, method.maxJoinPens(args))
    : JOIN_TOLERANCE_PENS;
  const joinTolerance = ctx.penWidth * joinPens;
  const simplifyLength = simplifyLengthFor(ctx.penWidth);

  const travelRaw = travelLength(lines);
  if (output.optimizePath) {
    progress(jobId, 'ordering paths');
    lines = optimizeOrder(lines);
    lines = joinCoincidentLines(lines, joinTolerance);
  }
  if (output.simplifyPath) {
    progress(jobId, 'simplifying');
    lines = simplifyAll(lines, simplifyLength);
  }

  // Render what will be plotted, after the path work rather than before it:
  // joining and simplification both move geometry, so rendering the method's raw
  // output would preview and score something the exported SVG does not contain.
  progress(jobId, 'rendering');
  const previewScale = output.previewScale ?? 2;
  // Cap the internal supersampled buffer: outScale*superSample squared can get
  // very large at high detail settings, and the area-average downsample is what
  // dominates. Drop the antialiasing factor before the memory, never the tone.
  const maxPixels = 12e6;
  let superSample = output.superSample ?? 3;
  while (superSample > 1 &&
         ctx.nx * previewScale * superSample * ctx.ny * previewScale * superSample > maxPixels) {
    superSample--;
  }
  const rendered = renderStrokes(toPixels(lines, ctx.pxPerCm), {
    wLine: ctx.w, imW: ctx.nx, imH: ctx.ny,
    outScale: previewScale, superSample,
  });

  progress(jobId, 'measuring');
  const drawnCm = pathLength(lines);
  const travelCm = travelLength(lines);
  const points = lines.reduce((a, l) => a + l.length, 0);

  // Two different questions, reported separately:
  //
  //   fidelity -- rendered against the method's own target: is it doing its job?
  //   reach    -- that target against the source image: can this method express
  //               this picture at all?
  //
  // A method declares targetImage() when its tone is band-limited by
  // construction — circlePacking reaches neither white nor black, wigglyLines
  // and eikonalStripes cannot reach white, an undithered crosshatch aims at a
  // staircase. Scoring those against the raw source would report a large
  // permanent error for a method performing exactly to spec.
  const source = ctx.im;
  const target = method.targetImage ? method.targetImage(args) : source;

  const renderedAtImage = previewScale === 1
    ? rendered
    : resize(rendered, ctx.nx, ctx.ny);
  const blurR = Math.max(3, Math.round(ctx.w * 3));
  const tb = blurGaussian(target, blurR, blurR / 3);
  const rb = blurGaussian(renderedAtImage, blurR, blurR / 3);
  const diff = makeImage(source.w, source.h);
  let sumSq = 0, maxErr = 0, clipped = 0, reachSum = 0;
  for (let i = 0; i < diff.data.length; i++) {
    const e = rb.data[i] - tb.data[i]; // + = too light, - = too dark
    diff.data[i] = e;
    sumSq += e * e;
    if (Math.abs(e) > maxErr) maxErr = Math.abs(e);
    if (Math.abs(e) > 0.15) clipped++;
    // how far the achievable target sits from the image that was asked for
    reachSum += Math.abs(target.data[i] - source.data[i]);
  }
  const rms = Math.sqrt(sumSq / diff.data.length);
  const reach = reachSum / diff.data.length;

  const payload = {
    lines,
    note,
    stats: {
      drawnCm, travelCm, travelRawCm: travelRaw,
      paths: lines.length, points,
      rms, maxErr, reach,
      clippedFraction: clipped / diff.data.length,
    },
    meta: {
      nx: ctx.nx, ny: ctx.ny, pxPerCm: ctx.pxPerCm, wPx: ctx.w,
      drawingWidth: ctx.drawingWidth, drawingHeight: ctx.drawingHeight,
      penWidth: ctx.penWidth,
    },
    images: {
      // The source, not the target: the Source view shows what was asked for,
      // while the Difference view shows the error against what is reachable.
      source: { w: source.w, h: source.h, data: source.data },
      result: { w: rendered.w, h: rendered.h, data: rendered.data },
      diff: { w: diff.w, h: diff.h, data: diff.data },
    },
  };

  return {
    payload,
    transfer: [source.data.buffer, rendered.data.buffer, diff.data.buffer],
  };
}
