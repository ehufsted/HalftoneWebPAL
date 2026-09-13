// UI wiring. Compute happens in worker.js; this module only gathers settings,
// paints results, and exports.

import { METHODS, METHOD_GROUPS, byId, blurbOf, defaultsFor } from './methods/index.js';
import { toSVG, downloadSVG } from './spine/svg.js';
import { fromImageData, invert } from './shim/image.js';
import { toPixels } from './spine/units.js';
import { renderStrokes } from './spine/render.js';

const $ = (id) => document.getElementById(id);

/**
 * Bumped every time a new image is loaded, whatever its name or size.
 *
 * The style browser keys its cache on this rather than on the name and
 * dimensions, which would treat two different files that happened to share both
 * as the same picture and leave stale tiles on screen.
 */
let imageEpoch = 0;

/** Approximate process colours, for CMYK layer strokes and preview compositing. */
const CMYK_COLORS = ['#00AEEF', '#EC008C', '#FFF200', '#000000'];
const CMYK_NAMES = ['Cyan', 'Magenta', 'Yellow', 'Black'];

const state = {
  image: null,          // {w,h,data} greyscale, already inverted if invertInk is set
  rawImage: null,        // {w,h,data} greyscale, as loaded -- never inverted
  rawRGBA: null,          // {width,height,data} raw source, for CMYK decomposition
  imageName: 'drawing',
  methodId: METHODS[0].id,
  params: defaultsFor(METHODS[0]),
  view: 'result',
  showTravel: false,
  inkMode: 'single',      // 'single' | 'cmyk'
  invertInk: false,       // single-ink mode only: white ink on a black page
  // The last 'done' message from the worker. Single-ink is flat
  // ({lines, stats, meta, images, note}); CMYK is {channels: [that shape, x4]}.
  // Every reader below (paint, updateStats, doExport, doExportPng) branches on
  // `.channels` rather than the two being normalised to one shape, because the
  // shapes really do differ downstream -- a travel overlay and a Difference
  // view mean something different for four rasters than for one.
  result: null,
  jobId: 0,
  pending: false,
};

// ------------------------------------------------------------------ worker
let worker = null;

function spawnWorker(onMessage = onWorkerMessage) {
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = onMessage;
    w.onerror = (e) => setStatus(`worker error: ${e.message}`, 'bad');
    return w;
  } catch (err) {
    setStatus('module workers unavailable — see console', 'bad');
    console.error(err);
    return null;
  }
}
worker = spawnWorker();

/**
 * Cancel a job in flight by terminating the worker and spawning a fresh one.
 *
 * `runJob` is synchronous end to end, so a busy worker cannot observe a stop
 * message; terminating the thread is the only way to reclaim the rest of a
 * computation whose result is already known to be unwanted. Results were always
 * discarded by jobId, so this changes only how much work is done first.
 *
 * A respawn re-parses the module graph, so it happens only when a job really is
 * in flight; an idle app keeps the worker it has.
 */
function cancelInFlight() {
  if (!worker || !state.pending) return;
  worker.terminate();
  worker = spawnWorker();
  state.pending = false;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.jobId !== state.jobId) return;
  if (msg.type === 'progress') { setStatus(msg.stage + '…'); return; }
  if (msg.type === 'error') {
    state.pending = false;
    setStatus(`error: ${msg.message}`, 'bad');
    console.error(msg.stack || msg.message);
    return;
  }
  if (msg.type === 'done') {
    state.pending = false;
    state.result = msg;
    setStatus('ready');
    paint();
    updateStats();
  }
}

// ----------------------------------------------------------------- settings
function readSettings() {
  const penWidthMm = parseFloat($('penWidth').value);
  const penWidth = penWidthMm / 10;                  // cm
  // Lmin is not sent: prepare() derives it from the pen width, and units.js is
  // the only place that knows that conversion.
  return {
    drawingWidth: parseFloat($('paper').value),      // cm
    penWidth,
    pxPerCm: parseFloat($('pxPerCm').value),
    gamma: parseFloat($('gamma').value),
    rSmooth: parseFloat($('rSmooth').value),
    Lmax: 10,
  };
}

function readOutput() {
  return {
    optimizePath: $('optimizePath').checked,
    simplifyPath: $('simplifyPath').checked,
    previewScale: 2,
    superSample: 3,
  };
}

function run() {
  if (!state.image || !worker) return;
  if (state.inkMode === 'cmyk' && !state.rawRGBA) return;
  // Anything still running is answering a question that has already changed.
  cancelInFlight();
  if (!worker) return;                 // respawn failed; the status line says so
  state.jobId++;
  state.pending = true;
  setStatus('working…');
  // Only the plane the chosen mode actually reads goes over: sending both
  // would structured-clone a second multi-megabyte buffer on every debounced
  // run for nothing.
  worker.postMessage({
    type: 'run',
    jobId: state.jobId,
    mode: state.inkMode,
    ...(state.inkMode === 'cmyk'
      ? { imgRGBA: state.rawRGBA, gcr: parseFloat($('gcr').value) }
      : { img: state.image }),
    settings: readSettings(),
    methodId: state.methodId,
    params: state.params,
    output: readOutput(),
  });
  syncHash();
}

let runTimer = null;
function scheduleRun(delay = 180) {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, delay);
}

// ------------------------------------------------------------------- paint
/**
 * Size the view/overlay canvases to the image and fit the stage without
 * exceeding natural size too much. Shared by paint() and paintCMYK(), which
 * otherwise draw entirely different pixels but must land on the same box.
 */
function fitStage(canvas, overlay, w, h) {
  canvas.width = w;
  canvas.height = h;
  overlay.width = w;
  overlay.height = h;

  const stage = document.querySelector('.stage');
  const maxW = stage.clientWidth - 28;
  const maxH = stage.clientHeight - 28;
  const scale = Math.min(maxW / w, maxH / h, 2);
  const cssW = Math.max(1, Math.floor(w * scale));
  const cssH = Math.max(1, Math.floor(h * scale));
  for (const c of [canvas, overlay]) {
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
  }
  $('wrap').style.width = `${cssW}px`;
  $('wrap').style.height = `${cssH}px`;
}

function paint() {
  const res = state.result;
  const canvas = $('view');
  const overlay = $('overlay');
  if (!res) return;

  if (res.channels) { paintCMYK(res, canvas, overlay); return; }

  const img = state.view === 'source' ? res.images.source
            : state.view === 'diff' ? res.images.diff
            : res.images.result;

  fitStage(canvas, overlay, img.w, img.h);

  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(img.w, img.h);
  if (state.view === 'diff') {
    // diverging map: red = too dark, blue = too light, white = on target
    for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
      const [r, g, b] = divergingColor(img.data[i]);
      out.data[p] = r; out.data[p + 1] = g; out.data[p + 2] = b;
      out.data[p + 3] = 255;
    }
  } else {
    // The rendered raster stays in ink-space (0=ink) regardless of invertInk --
    // only the display mapping flips, so white ink on a black page previews the
    // way it will plot.
    for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
      let v = Math.max(0, Math.min(1, img.data[i]));
      if (state.invertInk) v = 1 - v;
      v *= 255;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
      out.data[p + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);

  paintTravel(overlay, img);
}

/** #rrggbb -> [r,g,b] in 0-255. */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The Difference view's diverging map: red = too dark, blue = too light, white
 * = on target. Shared by paint() and paintCMYK() so the two Difference views
 * read as the same scale -- a change to the colours or the +-0.3 clip only
 * has to be made once.
 */
function divergingColor(e) {
  e = Math.max(-0.3, Math.min(0.3, e)) / 0.3;
  const a = Math.abs(e);
  return e > 0 // rendered lighter than target
    ? [255 * (1 - a), 255 * (1 - a * 0.55), 255]
    : [255, 255 * (1 - a * 0.65), 255 * (1 - a * 0.65)];
}

/**
 * CMYK preview: subtractively composite the four channel rasters (each
 * 0=ink/1=paper, same convention as single-ink) into one RGB image, using each
 * channel's process colour. An approximation -- real subtractive mixing is not
 * the point here, just a plausible on-screen stand-in for four pens overprinted
 * on white stock.
 */
function paintCMYK(res, canvas, overlay) {
  const channels = res.channels;
  const pick = (ch) => state.view === 'source' ? ch.images.source
              : state.view === 'diff' ? ch.images.diff
              : ch.images.result;
  const first = pick(channels[0]);

  fitStage(canvas, overlay, first.w, first.h);

  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(first.w, first.h);
  const planes = channels.map(pick);

  if (state.view === 'diff') {
    // Composite error: the worst-magnitude channel at each pixel, sign kept,
    // same diverging red/blue map as the single-ink Difference view. Averaging
    // the four signed errors instead would let an over-inked channel and an
    // under-inked one cancel out and paint a badly-registered pixel white.
    for (let i = 0, p = 0; i < first.data.length; i++, p += 4) {
      let e = 0;
      for (const pl of planes) if (Math.abs(pl.data[i]) > Math.abs(e)) e = pl.data[i];
      const [r, g, b] = divergingColor(e);
      out.data[p] = r; out.data[p + 1] = g; out.data[p + 2] = b;
      out.data[p + 3] = 255;
    }
  } else {
    const cmykRgb = CMYK_COLORS.map(hexToRgb);
    for (let i = 0, p = 0; i < first.data.length; i++, p += 4) {
      let r = 255, g = 255, b = 255;
      for (let ci = 0; ci < 4; ci++) {
        const ink = 1 - Math.max(0, Math.min(1, planes[ci].data[i]));
        const [cr, cg, cb] = cmykRgb[ci];
        r -= ink * (255 - cr);
        g -= ink * (255 - cg);
        b -= ink * (255 - cb);
      }
      out.data[p] = Math.max(0, Math.min(255, r));
      out.data[p + 1] = Math.max(0, Math.min(255, g));
      out.data[p + 2] = Math.max(0, Math.min(255, b));
      out.data[p + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);

  // Pen-up travel is per-channel in CMYK mode; the overlay has no single line
  // sequence to draw, so it stays blank there.
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
}

function paintTravel(overlay, img) {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.showTravel || !state.result) return;
  const { lines, meta } = state.result;
  const s = img.w / meta.drawingWidth;      // cm -> preview px
  ctx.strokeStyle = 'rgba(255,0,0,0.85)';
  ctx.lineWidth = Math.max(0.5, img.w / 900);
  ctx.beginPath();
  let cur = [0, 0];
  for (const line of lines) {
    if (!line.length) continue;
    ctx.moveTo(cur[0] * s, cur[1] * s);
    ctx.lineTo(line[0][0] * s, line[0][1] * s);
    cur = line[line.length - 1];
  }
  ctx.stroke();
}

/**
 * Sum the four channels' stats into one flat object shaped like a single-ink
 * run's, so the rest of updateStats doesn't need to know CMYK exists. Fidelity
 * (rms/reach) is averaged rather than summed -- it's a percentage, not a count.
 */
function combineCMYKStats(channels) {
  const sum = (k) => channels.reduce((a, ch) => a + ch.stats[k], 0);
  const avg = (k) => sum(k) / channels.length;
  return {
    drawnCm: sum('drawnCm'), travelCm: sum('travelCm'), travelRawCm: sum('travelRawCm'),
    paths: sum('paths'), points: sum('points'),
    rms: avg('rms'), maxErr: Math.max(...channels.map((ch) => ch.stats.maxErr)),
    reach: avg('reach'), clippedFraction: avg('clippedFraction'),
  };
}

function updateStats() {
  const r = state.result;
  if (!r) return;
  const stats = r.channels ? combineCMYKStats(r.channels) : r.stats;
  const { drawnCm, travelCm, travelRawCm, paths, points, rms, reach, clippedFraction } = stats;
  const speed = Math.max(1, parseFloat($('penSpeed').value) || 4);
  const seconds = drawnCm / speed + travelCm / (speed * 3);
  const mins = Math.floor(seconds / 60);
  $('statDrawn').textContent = `${(drawnCm / 100).toFixed(2)} m`;

  // Travel after ordering, with the saving against the unordered figure — the
  // one number that says what the Optimise checkbox is worth. Shown only when
  // ordering actually saved something.
  const saved = travelRawCm > 0 ? 1 - travelCm / travelRawCm : 0;
  $('statTravel').textContent = saved > 0.01
    ? `${(travelCm / 100).toFixed(2)} m (−${Math.round(saved * 100)}%)`
    : `${(travelCm / 100).toFixed(2)} m`;
  $('statTravel').title = `${(travelRawCm / 100).toFixed(2)} m before path ordering`;
  $('statLifts').textContent = String(paths);
  $('statPoints').textContent = points.toLocaleString();
  $('statTime').textContent = mins >= 60
    ? `${Math.floor(mins / 60)} h ${mins % 60} m`
    : `${mins} m ${Math.round(seconds % 60)} s`;

  // Fidelity: how close the drawing is to what this method can achieve, judged
  // against the method's own targetImage() rather than the source image.
  const errEl = $('statErr');
  errEl.textContent = `${(rms * 100).toFixed(1)}% rms`;
  errEl.className = rms > 0.09 ? 'bad' : rms > 0.05 ? 'warn' : '';

  // The method's own account of the run, if it gave one. It sits beside the tone
  // error because for a method that can stop early the error alone does not say
  // whether the drawing is short of its target or finished ahead of budget.
  $('methodNote').textContent = r.channels
    ? r.channels.map((ch) => ch.note).filter(Boolean).join(' · ')
    : r.note || '';

  // Reach: how much of the requested tone this method cannot express at all — a
  // property of the method and the settings rather than a fault in the drawing,
  // so it is reported separately. The fix is a different method or spacing, not
  // a different gamma.
  const hint = reach > 0.02
    ? `this method can only reach within ${(reach * 100).toFixed(0)}% of the tone you asked for`
    : clippedFraction > 0.04
      ? `${Math.round(clippedFraction * 100)}% of the image is off target by more than 15%`
      : '';
  $('hint').textContent = hint;
}

// ------------------------------------------------------------------ images
function loadFromImageBitmapSource(src, name) {
  const c = document.createElement('canvas');
  const maxDim = 1400;                        // cap the source; prepare() resizes anyway
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  // A fresh buffer from getImageData, read nowhere else, so it can be handed
  // straight to rawRGBA rather than copied.
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  state.rawRGBA = { width: imgData.width, height: imgData.height, data: imgData.data };
  state.rawImage = fromImageData(imgData);
  state.image = state.invertInk ? invert(state.rawImage) : state.rawImage;
  state.imageName = safeStem(name);
  imageEpoch++;
  run();
  refreshStyles();
}

/** A dropped file's name becomes an export filename, so keep it to a plain stem. */
function safeStem(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  return s.slice(0, 64) || 'drawing';
}

function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatus(`${file.name} is not an image`, 'bad');
    return;
  }
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    loadFromImageBitmapSource(img, file.name.replace(/\.[^.]+$/, ''));
  };
  // A file the browser cannot decode, despite its type, otherwise fails in
  // silence and leaves the previous drawing on screen.
  img.onerror = () => {
    URL.revokeObjectURL(img.src);
    setStatus(`could not decode ${file.name}`, 'bad');
  };
  img.src = URL.createObjectURL(file);
}

/**
 * Presets that are a bundled image rather than a formula.
 *
 * Resolved against this module rather than the document, the way the worker is,
 * so the app survives being served from a subpath — on itch.io it is not at the
 * root of its origin.
 */
const PRESET_IMAGES = {
  rhino: new URL('../assets/rhino.jpg', import.meta.url).href,
};

/**
 * Load a preset by name: a bundled image if there is one, otherwise a formula.
 *
 * `fallback` names a procedural preset to fall back on. Those are synchronous and
 * cannot fail, so passing one means a missing or unreachable asset still leaves
 * the app with a drawing on screen instead of blank. `init` uses it because the
 * opening image is the only one nobody asked for; a button press does not, since
 * quietly substituting a different picture for the one clicked would be worse
 * than the error.
 */
function loadPreset(kind, fallback = null) {
  const src = PRESET_IMAGES[kind];
  if (!src) { sample(kind); return; }
  const img = new Image();
  img.onload = () => loadFromImageBitmapSource(img, `sample-${kind}`);
  img.onerror = () => {
    setStatus(`could not load the ${kind} sample`, 'bad');
    if (fallback) sample(fallback);
  };
  img.src = src;
}

/** h in degrees, s/l in [0,1]. Returns [r,g,b] in [0,255]. */
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * The formula presets. Three of the four samples are generated rather than
 * bundled, so they cost nothing to ship and raise no licensing question; `rhino`
 * is the one real photograph, it is the author's own, and it is there because a
 * procedural test card cannot show how a method handles a subject.
 *
 * `state.rawImage` (single-ink's input) is grey, exactly as before -- `ramp` in
 * particular is a plain monotonic gradient people use to eyeball gamma, and
 * colourising IT would cost that. Only `state.rawRGBA` (CMYK's input) gets a
 * hue on top, at lightness = the same grey value, so single-ink mode is
 * unaffected and CMYK mode gets a real colour image to decompose instead of one
 * that collapses to K alone (r=g=b everywhere is exactly the degenerate case
 * `spine.cmyk.js`'s "grey photo" test exists to catch).
 */
function sample(kind) {
  const w = 700, h = 700;
  const data = new Float32Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / (w - 1)) * 2 - 1, ny = (y / (h - 1)) * 2 - 1;
      let v, hue, sat;
      if (kind === 'ramp') {
        v = x / (w - 1);
        hue = 300 * v;                                    // a rainbow sweep, left to right
        sat = 0.95;
      } else if (kind === 'rings') {
        const r = Math.hypot(nx, ny);
        v = 0.5 + 0.45 * Math.cos(r * 18) * Math.exp(-r * 0.8);
        hue = (Math.atan2(ny, nx) * 180) / Math.PI;         // a colour wheel by angle
        sat = 0.95;
      } else { // sphere: lit ball on a graded ground
        const r = Math.hypot(nx, ny);
        if (r < 0.72) {
          const z = Math.sqrt(Math.max(0, 0.72 * 0.72 - r * r)) / 0.72;
          const lx = -0.45, ly = -0.55, lz = 0.7;
          const nlen = Math.hypot(nx, ny, z * 0.72) || 1;
          const dot = (nx * lx + ny * ly + z * 0.72 * lz) / nlen;
          v = Math.max(0.02, Math.min(1, 0.12 + 0.95 * Math.max(0, dot)));
          hue = 25; sat = 0.95;                             // a warm ball
        } else {
          v = 0.55 + 0.4 * (y / (h - 1)) - 0.12 * Math.exp(-((r - 0.72) ** 2) * 12);
          hue = 205; sat = 0.6;                             // on a cool ground
        }
      }
      const i = y * w + x;
      data[i] = Math.max(0, Math.min(1, v));
      const [rr, gg, bb] = hslToRgb(hue, sat, data[i]);
      const p = i * 4;
      rgba[p] = rr; rgba[p + 1] = gg; rgba[p + 2] = bb; rgba[p + 3] = 255;
    }
  }
  state.rawImage = { w, h, data };
  state.rawRGBA = { width: w, height: h, data: rgba };
  state.image = state.invertInk ? invert(state.rawImage) : state.rawImage;
  state.imageName = `sample-${kind}`;
  imageEpoch++;
  run();
  refreshStyles();
}

// ------------------------------------------------------------------ params
/**
 * The picker, in the five families `methods/index.js` groups them into.
 *
 * Twenty-five entries in one flat list is a list nobody reads to the end. The
 * grouping already existed as comments beside the array; this is the same
 * grouping rendered, so the two cannot drift.
 */
function buildMethodUI() {
  const sel = $('method');
  sel.innerHTML = '';
  for (const group of METHOD_GROUPS) {
    const g = document.createElement('optgroup');
    g.label = group.name;
    for (const { method } of group.methods) {
      const o = document.createElement('option');
      o.value = method.id;
      o.textContent = method.label;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  sel.value = state.methodId;
  buildParamUI();
}

/**
 * A range param may give `min`/`max` as a function of the current settings
 * rather than a constant — `tenPrintHatching`'s segment length is floored at
 * twice the pen width, and that floor moves when the pen does. Call sites that
 * change a setting a bound depends on must rebuild the controls.
 */
function resolveBound(v, settings) {
  return typeof v === 'function' ? v(settings) : v;
}

/**
 * A param may declare `when(params)` and is hidden when it returns false, so a
 * control that does not apply to the current branch disappears rather than
 * sitting there inert (planeWaves' relaxation and seed apply only to its Voronoi
 * and Delaunay tilers; triStripes' jitter is the reverse).
 *
 * Hidden is not cleared: `state.params` keeps the value, so reopening the gate
 * restores it. The predicate reads the whole param object, so a gate can depend
 * on any other param — which is why every select and checkbox rebuilds the list.
 */
function visibleParams(method) {
  return method.params.filter((p) => !p.when || p.when(state.params));
}

function buildParamUI() {
  const method = byId(state.methodId);
  const host = $('methodParams');
  const settings = readSettings();
  // Rebuilt here rather than in `buildMethodUI`, because this is what every path
  // that changes the method already calls -- the picker's own change handler
  // included. `textContent`, so a blurb is prose and never markup.
  $('methodBlurb').textContent = blurbOf(state.methodId);
  host.innerHTML = '';
  for (const p of visibleParams(method)) {
    const row = document.createElement('div');
    row.className = 'row';
    let val = state.params[p.key] ?? p.def;

    if (p.type === 'checkbox') {
      row.innerHTML =
        `<label class="check" style="flex:1 1 auto">` +
        `<input type="checkbox" id="p_${p.key}"${val ? ' checked' : ''}> ${p.label}</label>`;
      host.appendChild(row);
      row.querySelector('input').addEventListener('change', (e) => {
        state.params[p.key] = e.target.checked;
        buildParamUI();          // another param's `when` may gate on this one
        scheduleRun(0);
      });
      continue;
    }

    if (p.type === 'select') {
      const opts = p.options
        .map((o) => {
          const value = typeof o === 'object' ? o.value : o;
          const text = typeof o === 'object' ? o.label : `${o}${p.unit || ''}`;
          return `<option value="${value}"${value === val ? ' selected' : ''}>${text}</option>`;
        })
        .join('');
      row.innerHTML =
        `<label for="p_${p.key}">${p.label}</label>` +
        `<select id="p_${p.key}">${opts}</select>`;
      host.appendChild(row);
      const sel = row.querySelector('select');
      sel.addEventListener('change', () => {
        const raw = sel.value;
        state.params[p.key] = isNaN(parseFloat(raw)) ? raw : parseFloat(raw);
        buildParamUI();          // another param's `when` may gate on this one
        scheduleRun(0);
      });
      continue;
    }

    const min = resolveBound(p.min, settings);
    const max = resolveBound(p.max, settings);
    val = Number(Math.min(max, Math.max(min, val)).toFixed(4));
    state.params[p.key] = val;

    row.innerHTML =
      `<label for="p_${p.key}">${p.label}</label>` +
      `<input type="range" id="p_${p.key}" min="${min}" max="${max}" step="${p.step}" value="${val}">` +
      `<span class="val" id="pv_${p.key}">${val}${p.unit || ''}</span>`;
    host.appendChild(row);
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      state.params[p.key] = v;
      $(`pv_${p.key}`).textContent = `${v}${p.unit || ''}`;
      scheduleRun();
    });
  }
}

// ----------------------------------------------------------- style browser
//
// A SECOND WORKER, not the drawing one. Twenty-five tiles is seconds of work,
// and `cancelInFlight` terminates the main worker whenever a slider moves -- so
// sharing would mean either the tiles killing the drawing or a slider drag
// killing the tiles. Two threads, no interaction.
//
// Generated lazily on first open and cached against a signature of what they
// were made from, so browsing twice is free and changing the image or the pen
// rebuilds them. Nothing is generated at all for a visitor who never opens it.
let thumbWorker = null;
let thumbToken = 0;
let thumbsShownFor = '';
let lastFocus = null;

const STYLES_NOTE = 'each tile is a 5 cm print at your pen width — the same '
  + 'method on a bigger page comes out finer';

/**
 * What the current tiles were made from. Different string, stale tiles.
 *
 * `drawingWidth` and `pxPerCm` are deliberately absent: the worker overrides both
 * (a tile is a 5 cm print at a fixed raster), so neither can change a thumbnail.
 * Everything that can is here.
 *
 * The image is identified by `imageEpoch` rather than by its name and size, which
 * would collide for two different files that happened to share both.
 */
function thumbSignature() {
  const s = readSettings();
  return `${imageEpoch}|${s.penWidth}|${s.gamma}|${s.rSmooth}`;
}

function stopThumbs() {
  if (thumbWorker) { thumbWorker.terminate(); thumbWorker = null; }
}

/** @returns {boolean} whether generation actually started. */
function requestThumbs() {
  if (!state.image) return false;
  stopThumbs();
  const token = ++thumbToken;
  const w = spawnWorker((ev) => {
    const m = ev.data;
    if (m.jobId !== token) return;
    if (m.type === 'thumb') { paintThumb(m); return; }
    if (m.type === 'thumbsDone') {
      stopThumbs();
      $('stylesNote').textContent = STYLES_NOTE;
    }
  });
  if (!w) return false;
  thumbWorker = w;
  $('stylesNote').textContent = 'drawing previews…';
  // Size the empty tiles to the image's ASPECT now, so the grid does not reflow
  // under the reader as tiles arrive one at a time. Only the ratio matters --
  // CSS scales the canvas to the tile either way, and a blank one has nothing to
  // resolve -- so this base is any convenient number and is NOT the worker's
  // THUMB_PX. Coupling the two would be coupling a placeholder to a raster size.
  const tw = 96;
  const th = Math.max(1, Math.round((tw * state.image.h) / state.image.w));
  for (const b of $('stylesBody').querySelectorAll('.tile')) {
    b.className = 'tile pending';
    const c = b.querySelector('canvas');
    c.width = tw;
    c.height = th;
  }
  markCurrentTile();
  w.postMessage({
    type: 'thumbs', jobId: token, img: state.image, settings: readSettings(),
  });
  return true;
}

function paintThumb(m) {
  const tile = $(`tile_${m.id}`);
  if (!tile) return;
  if (m.error) {
    tile.className = 'tile failed';
    tile.title = `${blurbOf(m.id)}\n\nfailed: ${m.error}`;
    return;
  }
  tile.className = 'tile';
  const c = tile.querySelector('canvas');
  c.width = m.w;
  c.height = m.h;
  const g = c.getContext('2d');
  const out = g.createImageData(m.w, m.h);
  for (let i = 0, p = 0; i < m.data.length; i++, p += 4) {
    const v = Math.max(0, Math.min(1, m.data[i])) * 255;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  g.putImageData(out, 0, 0);
}

function markCurrentTile() {
  for (const b of $('stylesBody').querySelectorAll('.tile')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === state.methodId));
  }
}

/** The tile grid, in the same five families as the picker. Built once. */
function buildStyleGrid() {
  const body = $('stylesBody');
  if (body.childElementCount > 0) return;
  for (const group of METHOD_GROUPS) {
    const h = document.createElement('h3');
    h.textContent = group.name;
    body.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'tiles';
    for (const { method, blurb } of group.methods) {
      const b = document.createElement('button');
      b.className = 'tile pending';
      b.id = `tile_${method.id}`;
      b.dataset.id = method.id;
      b.title = blurb;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<canvas width="96" height="96"></canvas>';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = method.label;
      b.appendChild(name);
      b.addEventListener('click', () => chooseStyle(method.id));
      grid.appendChild(b);
    }
    body.appendChild(grid);
  }
}

function chooseStyle(id) {
  state.methodId = id;
  state.params = defaultsFor(byId(id));
  $('method').value = id;
  buildParamUI();
  markCurrentTile();
  closeStyles();
  scheduleRun(0);
}

function openStyles() {
  buildStyleGrid();
  const wasHidden = $('styles').hidden;
  $('styles').hidden = false;
  markCurrentTile();
  // Focus moves into the dialog and comes back out again, which is the part of
  // `aria-modal` that is worth having without a full focus trap: a keyboard user
  // lands on Close rather than somewhere behind the overlay, and gets returned to
  // the button they opened it with. Only on a real open, so a refresh of an
  // already-open browser does not steal focus mid-browse.
  if (wasHidden) {
    lastFocus = document.activeElement;
    $('closeStyles').focus();
  }
  // Recorded only once generation is under way, so a run that never started --
  // no image yet, or a worker that failed to spawn -- is retried next time
  // rather than cached as if it had succeeded.
  const sig = thumbSignature();
  if (sig !== thumbsShownFor && requestThumbs()) thumbsShownFor = sig;
  else if (!state.image) $('stylesNote').textContent = 'waiting for an image…';
}

/**
 * Hide the browser and let any generation finish.
 *
 * Terminating here looked tidier and was wrong: the cache is keyed on the
 * signature, so a half-finished set would be treated as current and those tiles
 * would stay blank for as long as the image did. It costs nothing to let it run
 * -- it is the second worker, it blocks nothing, and it stops itself on
 * `thumbsDone`.
 */
function closeStyles() {
  $('styles').hidden = true;
  if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  lastFocus = null;
}

/**
 * Regenerate if the browser is open and what it is showing has gone stale.
 *
 * THIS LOOKS DEAD AND IS NOT. The overlay covers the sidebar, so while it is open
 * there is no way to load an image or move a slider -- which is most of why the
 * signature check in `openStyles` is enough on its own. The exception is startup:
 * `init` wires this button and only then starts the opening image loading, so the
 * browser can be opened during that gap, find no image, and sit on empty tiles.
 * This is what fills them when the image arrives.
 *
 * Delete it only along with that race, not on the strength of the overlay being
 * modal today.
 */
function refreshStyles() {
  if (!$('styles').hidden) openStyles();
}

// -------------------------------------------------------------------- hash
function syncHash() {
  const s = readSettings();
  const q = new URLSearchParams({
    m: state.methodId,
    w: s.drawingWidth, p: (s.penWidth * 10).toFixed(2), d: s.pxPerCm,
    g: s.gamma, sm: s.rSmooth,
    ink: state.inkMode,
    gcr: $('gcr').value,
    ...(state.invertInk ? { inv: '1' } : {}),
    ...Object.fromEntries(Object.entries(state.params).map(([k, v]) => [`x_${k}`, v])),
  });
  // A sandboxed iframe — which is how itch.io embeds the page — throws
  // SecurityError here. The hash is a convenience; nothing else depends on it,
  // so losing it must not take the run down with it.
  try {
    history.replaceState(null, '', `#${q}`);
  } catch {
    /* no shareable URL in this embedding */
  }
}

/**
 * The hash is untrusted input: it is the app's shareable surface, so it gets
 * hand-edited and truncated, and every value in it arrives as a string.
 *
 * A value that will not parse, or that matches no <option> of a <select>, is
 * refused and the control keeps its markup default. Assigning it through instead
 * blanks the select, yields NaN, and produces a blank canvas with no error.
 */
function setNumIf(q, id, key) {
  const v = parseFloat(q.get(key));
  if (!Number.isFinite(v)) return;
  const el = $(id);
  if (el.tagName === 'SELECT') {
    // assigning an unknown value blanks a select; check before committing
    const match = [...el.options].find((o) => parseFloat(o.value) === v);
    if (match) el.value = match.value;
    return;
  }
  el.value = String(v);
}

function restoreHash() {
  if (!location.hash.length) return;
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get('m') && METHODS.some((m) => m.id === q.get('m'))) state.methodId = q.get('m');
  if (q.get('ink') === 'cmyk' || q.get('ink') === 'single') state.inkMode = q.get('ink');
  state.invertInk = q.get('inv') === '1';

  // Rebase the params onto the method the hash names. `state.params` starts as
  // METHODS[0]'s defaults, and carrying those keys across would leave the new
  // method's checkbox and select params undefined — rendering unchecked while
  // the method's own `?? def` still ran them as true.
  state.params = defaultsFor(byId(state.methodId));

  setNumIf(q, 'paper', 'w');
  setNumIf(q, 'penWidth', 'p');
  setNumIf(q, 'pxPerCm', 'd');
  setNumIf(q, 'gamma', 'g');
  setNumIf(q, 'rSmooth', 'sm');
  setNumIf(q, 'gcr', 'gcr');
  const method = byId(state.methodId);
  for (const p of method.params) {
    const v = q.get(`x_${p.key}`);
    if (v === null) continue;
    if (p.type === 'checkbox') {
      state.params[p.key] = v === 'true' || v === '1';
      continue;
    }
    const num = parseFloat(v);
    // A range param must end up a number. Passing the raw string through gives
    // the method NaN, which no `?? def` catches, and the drawing comes back
    // empty with nothing said. A select keeps its string, since its values are
    // names; one naming no option leaves the param at its default.
    if (p.type === 'range') {
      if (Number.isFinite(num)) state.params[p.key] = num;
      continue;
    }
    state.params[p.key] = Number.isFinite(num) ? num : v;
  }
}

// ------------------------------------------------------------------ export
function doExport() {
  const r = state.result;
  if (!r) return;

  if (r.channels) {
    const meta = r.channels[0].meta;      // shared: same settings for every channel
    const layers = r.channels.map((ch, i) => ({
      name: CMYK_NAMES[i], lines: ch.lines, color: CMYK_COLORS[i],
    }));
    const svg = toSVG(layers, {
      widthCm: meta.drawingWidth, heightCm: meta.drawingHeight, penWidthCm: meta.penWidth,
    });
    downloadSVG(svg, `${state.imageName}-cmyk.svg`);
    return;
  }

  const svg = toSVG([{
    name: byId(state.methodId).label, lines: r.lines,
    color: state.invertInk ? '#ffffff' : '#000000',
  }], {
    widthCm: r.meta.drawingWidth,
    heightCm: r.meta.drawingHeight,
    penWidthCm: r.meta.penWidth,
    background: state.invertInk ? '#000000' : undefined,
  });
  downloadSVG(svg, `${state.imageName}-${state.methodId}.svg`);
}

/**
 * Export scale for the PNG. The on-screen canvas is at compute resolution — set
 * by the drawing size and px/cm, often only a few hundred pixels, which is fine
 * for judging tone and thin for anything else.
 */
const PNG_SCALE = 2;

/** A greyscale {w,h,data} image as an opaque canvas. */
function imageToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.w;
  c.height = img.h;
  const g = c.getContext('2d');
  const out = g.createImageData(img.w, img.h);
  for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
    let vv = Math.min(1, Math.max(0, img.data[i]));
    if (state.invertInk) vv = 1 - vv;
    const v = Math.round(255 * vv);
    out.data[p] = v; out.data[p + 1] = v; out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c;
}

/**
 * PNG of what is on screen.
 *
 * The Result view is re-rendered rather than screenshotted: renderStrokes
 * supersamples and area-averages where the browser would apply its own
 * antialiasing, and an exported PNG that disagreed with the tone numbers would
 * be worse than no export at all. Source and Difference are pixel data with
 * nothing to re-render, so those come off the canvas as they are. CMYK mode has
 * no single `lines`/`meta` to re-render against, so its Result view is also
 * screenshotted, from the same composite `paint()` already drew.
 */
function doExportPng() {
  const r = state.result;
  if (!r) return;
  let canvas;
  const suffix = state.view;
  if (state.view === 'result' && !r.channels) {
    // The lines arrive in centimetres — worker.js converts with toPhysical
    // before posting, since that is what the SVG export and length stats want —
    // so they must go back to pixels before the renderer sees them.
    canvas = imageToCanvas(renderStrokes(toPixels(r.lines, r.meta.pxPerCm), {
      wLine: r.meta.wPx,              // input units; renderStrokes scales it
      imW: r.meta.nx,
      imH: r.meta.ny,
      outScale: PNG_SCALE,
      superSample: 3,
    }));
  } else {
    canvas = $('view');
  }
  canvas.toBlob((blob) => {
    if (!blob) { setStatus('PNG export failed', 'bad'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.imageName}-${state.methodId}-${suffix}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

// ------------------------------------------------------------------- wiring
function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function bindRange(id, valId, fmt = (v) => v) {
  const input = $(id);
  const out = $(valId);
  const update = () => { out.textContent = fmt(input.value); };
  input.addEventListener('input', () => { update(); scheduleRun(); });
  update();
}

/**
 * White-on-black and CMYK are separate output modes (mixing them would need
 * subtractive mixing on a dark substrate, which isn't modelled here) -- the
 * invert checkbox is disabled and its effect suspended while CMYK is active,
 * and the GCR slider goes the other way: it means nothing outside CMYK, so it
 * is disabled while single-ink is active. Shared by init() (setting up the
 * controls from restored state) and the inkMode change handler (reacting to a
 * live switch), so the two cannot disagree.
 */
function updateInkModeUI() {
  const cmyk = state.inkMode === 'cmyk';
  $('invertInk').disabled = cmyk;
  $('invertInkRow').style.opacity = cmyk ? 0.5 : 1;
  $('gcr').disabled = !cmyk;
  $('gcrRow').style.opacity = cmyk ? 1 : 0.5;
}

function init() {
  restoreHash();
  buildMethodUI();

  $('inkMode').value = state.inkMode;
  $('invertInk').checked = state.invertInk;
  updateInkModeUI();

  bindRange('pxPerCm', 'pxPerCmVal');
  bindRange('gamma', 'gammaVal', (v) => parseFloat(v).toFixed(2));
  bindRange('rSmooth', 'rSmoothVal', (v) => parseFloat(v).toFixed(1));
  bindRange('gcr', 'gcrVal', (v) => parseFloat(v).toFixed(2));

  for (const id of ['paper', 'penWidth', 'optimizePath', 'simplifyPath']) {
    $(id).addEventListener('change', () => {
      // pen width moves any param bound derived from it, so the sliders have to
      // be rebuilt against the new settings before the run is queued
      if (id === 'penWidth') buildParamUI();
      scheduleRun(0);
    });
  }
  $('penSpeed').addEventListener('input', updateStats);

  $('invertInk').addEventListener('change', (e) => {
    state.invertInk = e.target.checked;
    if (state.rawImage) state.image = state.invertInk ? invert(state.rawImage) : state.rawImage;
    scheduleRun(0);
  });

  $('inkMode').addEventListener('change', (e) => {
    state.inkMode = e.target.value;
    updateInkModeUI();
    scheduleRun(0);
  });

  $('method').addEventListener('change', (e) => {
    state.methodId = e.target.value;
    state.params = defaultsFor(byId(state.methodId));
    buildParamUI();
    scheduleRun(0);
  });

  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.view = b.dataset.view;
    for (const btn of $('viewSeg').querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn === b));
    }
    paint();
  });

  $('showTravel').addEventListener('change', (e) => {
    state.showTravel = e.target.checked;
    paint();
  });

  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  for (const b of document.querySelectorAll('[data-sample]')) {
    b.addEventListener('click', () => loadPreset(b.dataset.sample));
  }

  $('exportSvg').addEventListener('click', doExport);
  $('exportPng').addEventListener('click', doExportPng);
  $('copyLink').addEventListener('click', async () => {
    syncHash();
    try {
      await navigator.clipboard.writeText(location.href);
      setStatus('link copied');
    } catch { setStatus('copy failed — the URL bar has it', 'warn'); }
  });

  $('browseStyles').addEventListener('click', openStyles);
  $('closeStyles').addEventListener('click', closeStyles);
  // Clicking the backdrop closes; clicking a tile or the bar must not. The
  // target test is on the overlay itself, so anything inside it is ignored.
  $('styles').addEventListener('click', (e) => {
    if (e.target === $('styles')) closeStyles();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('styles').hidden) closeStyles();
  });

  window.addEventListener('resize', () => paint());

  // The opening drawing. A real subject rather than a test card, because the
  // first thing on screen is what says what the app is for -- the formulas are
  // there to judge a tone ladder, not to show one off. Falls back to the sphere
  // if the asset cannot be fetched, so the app never opens blank.
  loadPreset('rhino', 'sphere');
}

init();
