// UI wiring. Compute happens in worker.js; this module only gathers settings,
// paints results, and exports.

import { METHODS, METHOD_GROUPS, byId, blurbOf, defaultsFor } from './methods/index.js';
import { toSVG, downloadSVG } from './spine/svg.js';
import { fromImageData } from './shim/image.js';
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

const state = {
  image: null,          // {w,h,data} greyscale
  imageName: 'drawing',
  methodId: METHODS[0].id,
  params: defaultsFor(METHODS[0]),
  view: 'result',
  showTravel: false,
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
  // Anything still running is answering a question that has already changed.
  cancelInFlight();
  if (!worker) return;                 // respawn failed; the status line says so
  state.jobId++;
  state.pending = true;
  setStatus('working…');
  worker.postMessage({
    type: 'run',
    jobId: state.jobId,
    img: state.image,
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
function paint() {
  const res = state.result;
  const canvas = $('view');
  const overlay = $('overlay');
  if (!res) return;

  const img = state.view === 'source' ? res.images.source
            : state.view === 'diff' ? res.images.diff
            : res.images.result;

  canvas.width = img.w;
  canvas.height = img.h;
  overlay.width = img.w;
  overlay.height = img.h;

  // fit the stage without exceeding natural size too much
  const stage = document.querySelector('.stage');
  const maxW = stage.clientWidth - 28;
  const maxH = stage.clientHeight - 28;
  const scale = Math.min(maxW / img.w, maxH / img.h, 2);
  const cssW = Math.max(1, Math.floor(img.w * scale));
  const cssH = Math.max(1, Math.floor(img.h * scale));
  for (const c of [canvas, overlay]) {
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
  }
  $('wrap').style.width = `${cssW}px`;
  $('wrap').style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(img.w, img.h);
  if (state.view === 'diff') {
    // diverging map: red = too dark, blue = too light, white = on target
    for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
      const e = Math.max(-0.3, Math.min(0.3, img.data[i])) / 0.3;
      const a = Math.abs(e);
      if (e > 0) { // rendered lighter than target
        out.data[p] = 255 * (1 - a); out.data[p + 1] = 255 * (1 - a * 0.55); out.data[p + 2] = 255;
      } else {
        out.data[p] = 255; out.data[p + 1] = 255 * (1 - a * 0.65); out.data[p + 2] = 255 * (1 - a * 0.65);
      }
      out.data[p + 3] = 255;
    }
  } else {
    for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
      const v = Math.max(0, Math.min(1, img.data[i])) * 255;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
      out.data[p + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);

  paintTravel(overlay, img);
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

function updateStats() {
  const r = state.result;
  if (!r) return;
  const { drawnCm, travelCm, travelRawCm, paths, points, rms, reach, clippedFraction } = r.stats;
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
  $('methodNote').textContent = r.note || '';

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
  state.image = fromImageData(ctx.getImageData(0, 0, c.width, c.height));
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

/**
 * The formula presets. Three of the four samples are generated rather than
 * bundled, so they cost nothing to ship and raise no licensing question; `rhino`
 * is the one real photograph, it is the author's own, and it is there because a
 * procedural test card cannot show how a method handles a subject.
 */
function sample(kind) {
  const w = 700, h = 700;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / (w - 1)) * 2 - 1, ny = (y / (h - 1)) * 2 - 1;
      let v;
      if (kind === 'ramp') {
        v = x / (w - 1);
      } else if (kind === 'rings') {
        const r = Math.hypot(nx, ny);
        v = 0.5 + 0.45 * Math.cos(r * 18) * Math.exp(-r * 0.8);
      } else { // sphere: lit ball on a graded ground
        const r = Math.hypot(nx, ny);
        if (r < 0.72) {
          const z = Math.sqrt(Math.max(0, 0.72 * 0.72 - r * r)) / 0.72;
          const lx = -0.45, ly = -0.55, lz = 0.7;
          const nlen = Math.hypot(nx, ny, z * 0.72) || 1;
          const dot = (nx * lx + ny * ly + z * 0.72 * lz) / nlen;
          v = Math.max(0.02, Math.min(1, 0.12 + 0.95 * Math.max(0, dot)));
        } else {
          v = 0.55 + 0.4 * (y / (h - 1)) - 0.12 * Math.exp(-((r - 0.72) ** 2) * 12);
        }
      }
      data[y * w + x] = Math.max(0, Math.min(1, v));
    }
  }
  state.image = { w, h, data };
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
  const svg = toSVG([{ name: byId(state.methodId).label, lines: r.lines }], {
    widthCm: r.meta.drawingWidth,
    heightCm: r.meta.drawingHeight,
    penWidthCm: r.meta.penWidth,
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
    const v = Math.round(255 * Math.min(1, Math.max(0, img.data[i])));
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
 * nothing to re-render, so those come off the canvas as they are.
 */
function doExportPng() {
  const r = state.result;
  if (!r) return;
  let canvas;
  const suffix = state.view;
  if (state.view === 'result') {
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

function init() {
  restoreHash();
  buildMethodUI();

  bindRange('pxPerCm', 'pxPerCmVal');
  bindRange('gamma', 'gammaVal', (v) => parseFloat(v).toFixed(2));
  bindRange('rSmooth', 'rSmoothVal', (v) => parseFloat(v).toFixed(1));

  for (const id of ['paper', 'penWidth', 'optimizePath', 'simplifyPath']) {
    $(id).addEventListener('change', () => {
      // pen width moves any param bound derived from it, so the sliders have to
      // be rebuilt against the new settings before the run is queued
      if (id === 'penWidth') buildParamUI();
      scheduleRun(0);
    });
  }
  $('penSpeed').addEventListener('input', updateStats);

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
