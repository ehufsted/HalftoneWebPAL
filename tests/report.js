// The only DOM-aware file in the harness.
//
// Everything else accumulates HTML strings through runner.js's say(); this
// paints them. Keeping the boundary here is what lets the same test modules run
// under node/deno (see run-tests.mjs) without a DOM shim.
//
// IT PAINTS AFTER EVERY SECTION, and that is not a nicety. The pre-split harness
// was one synchronous block that assigned out.innerHTML on its very last line,
// so any failure -- or merely a slow section -- left the page reading "Running…"
// with nothing to say which of two thousand lines was responsible. Yielding
// between sections costs nothing and turns that into a running transcript with
// the current section named and timed.

import { getHtml } from './runner.js';
import { SECTIONS } from './index.js';

const out = document.getElementById('out');

// ?only=circlePacking,spine.geodesic runs a subset; omit for everything.
const param = new URLSearchParams(location.search).get('only');
const only = param ? param.split(',').map((s) => s.trim()) : null;

const status = (msg, cls = 'note') => `<p class="${cls}">${msg}</p>`;

/**
 * The subset picker, BUILT FROM `SECTIONS` rather than written out by hand.
 *
 * A hand-maintained list of section names in verify.html would be wrong the
 * first time a section was added and nobody would notice, because nothing checks
 * it. Generating it means the page cannot disagree with the harness.
 *
 * Sections are grouped by what they test, which is readable straight off the
 * name: `spine.*` are shims and shared modules, `pipeline` is the whole chain,
 * everything else is one method.
 */
function renderPicker() {
  const host = document.getElementById('sections');
  if (!host) return;
  const groupOf = (n) => (n.startsWith('spine.') ? 'spine'
                        : n === 'pipeline' ? 'pipeline' : 'method');
  const groups = { method: [], spine: [], pipeline: [] };
  for (const [name] of SECTIONS) groups[groupOf(name)].push(name);

  const cell = (n) => {
    const on = only && only.includes(n);
    return `<label class="pick${on ? ' on' : ''}">` +
           `<input type="checkbox" value="${n}"${on ? ' checked' : ''}> ` +
           `<a href="?only=${encodeURIComponent(n)}" title="run only this one">${n}</a>` +
           `</label>`;
  };
  const row = (label, names) => (names.length === 0 ? '' :
    `<tr><th>${label}</th><td>${names.map(cell).join(' ')}</td></tr>`);

  host.innerHTML =
    `<details${only ? ' open' : ''}><summary>` +
    `Run a subset — <b>${only ? `${only.length} of ${SECTIONS.length}` : `all ${SECTIONS.length}`}</b> ` +
    `sections selected</summary>` +
    '<table class="picker">' +
    row('methods', groups.method) +
    row('spine', groups.spine) +
    row('end to end', groups.pipeline) +
    '</table>' +
    '<p><button id="runSel">Run selected</button> ' +
    '<button id="runAll">Run all</button> ' +
    '<span class="note">or click a name to run it alone. The URL is the state, ' +
    'so a subset is a link you can keep.</span></p></details>';

  document.getElementById('runSel').addEventListener('click', () => {
    const picked = [...host.querySelectorAll('input:checked')].map((i) => i.value);
    location.search = picked.length > 0 ? `?only=${picked.map(encodeURIComponent).join(',')}` : '';
  });
  document.getElementById('runAll').addEventListener('click', () => { location.search = ''; });

  // Names in the URL that no longer exist are worth saying out loud: a stale
  // bookmark otherwise runs fewer sections than it looks like it does.
  if (only) {
    const known = new Set(SECTIONS.map(([n]) => n));
    const bad = only.filter((n) => !known.has(n));
    if (bad.length > 0) {
      host.insertAdjacentHTML('beforeend',
        status(`no such section: <b>${bad.join(', ')}</b> — check the list above`, 'fail'));
    }
  }
}
renderPicker();

/** Let the browser paint before the next synchronous block. */
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  const timings = [];
  let done = 0;
  const planned = SECTIONS.filter(([n]) => !only || only.includes(n));

  for (const [name, mod] of planned) {
    out.innerHTML = getHtml() +
      status(`running <b>${name}</b> — ${done} of ${planned.length} done…`);
    await yieldToPaint();

    const t0 = performance.now();
    try {
      mod.run();
    } catch (err) {
      out.innerHTML = getHtml() +
        status(`section <b>${name}</b> threw: ${String((err && err.message) || err)}`, 'fail') +
        `<pre>${String((err && err.stack) || '').replace(/</g, '&lt;')}</pre>` +
        status('Sections before this one completed and are shown above.');
      throw err;
    }
    timings.push([name, performance.now() - t0]);
    done++;
  }

  timings.sort((a, b) => b[1] - a[1]);
  const slowest = timings.slice(0, 5)
    .map(([n, ms]) => `${n} ${Math.round(ms)} ms`).join(', ');
  const total = timings.reduce((a, [, ms]) => a + ms, 0);

  out.innerHTML = getHtml() +
    status(`${planned.length} sections in ${(total / 1000).toFixed(1)} s. ` +
           `Slowest: ${slowest}.`);
}

main();
