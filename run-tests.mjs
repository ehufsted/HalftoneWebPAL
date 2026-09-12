// Headless harness runner. Requires a JS runtime with ES modules:
//
//   node run-tests.mjs                       everything
//   node run-tests.mjs circlePacking         one section
//   node run-tests.mjs --tsv                 just the pasteable TSV blocks
//   deno run --allow-read run-tests.mjs      same, under deno
//
// WHY THIS EXISTS. Every verification in this project has been a manual
// round-trip: open verify.html, read the tables, paste them back. If this runs,
// that cost collapses -- a regression check becomes `node run-tests.mjs > after
// && diff before after`, and changes can be verified one at a time instead of
// batched to save round-trips.
//
// Nothing in src/spine/ or src/methods/ touches the DOM, and the harness's only
// DOM dependency (showImage) is guarded on `typeof document`. So this should
// work with no shim. If it does not, the error will name whatever crept in.

import { getHtml } from './tests/runner.js';
import { runAll, SECTIONS } from './tests/index.js';

const args = process.argv.slice(2);
const tsvOnly = args.includes('--tsv');
const only = args.filter((a) => !a.startsWith('--'));

if (only.length) {
  const known = SECTIONS.map(([n]) => n);
  const bad = only.filter((n) => !known.includes(n));
  if (bad.length) {
    console.error(`unknown section(s): ${bad.join(', ')}`);
    console.error(`known: ${known.join(', ')}`);
    process.exit(2);
  }
}

runAll(only.length ? only : null);
const html = getHtml();

if (tsvOnly) {
  // The <pre> blocks are the pasteable measurement tables.
  const blocks = [...html.matchAll(/<pre id="([^"]+)">([\s\S]*?)<\/pre>/g)];
  for (const [, id, body] of blocks) {
    console.log(`# ${id}`);
    console.log(body.replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
    console.log();
  }
} else {
  // Strip tags for a readable/diffable transcript. Timing lines are dropped
  // because they are the only nondeterministic output -- see the byte-identical
  // acceptance criterion in the plan.
  const text = html
    .replace(/<\/(tr|p|h2|table|pre)>/g, '\n')
    .replace(/<\/t[hd]>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length && !/\d+\s*ms\b/.test(l))
    .join('\n');
  console.log(text);
}
