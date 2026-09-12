// Seeded pseudo-randomness — the only source of it in the app, harness included.
//
// The app is deterministic by design: every stochastic method takes a seed and
// nothing calls Math.random, which is what lets the verification harness use
// "output is byte-identical" as an acceptance criterion for a change that should
// not alter behaviour.
//
// Changing this function re-rolls every drawing. Not the tone — the statistics
// are unaffected — but every dot position, wave direction and dither decision.
// So does changing how many times a caller draws from it, or in what order: when
// editing a method that consumes randomness, the invariant to preserve is the
// call sequence, not merely the algorithm.
//
// mulberry32: fast, small state, good enough distribution for dithering and
// point placement.

/**
 * @param {number} seed  any integer; the same seed always gives the same stream
 * @returns {() => number} successive values in [0, 1)
 */
export function mulberry32(seed) {
  let a = (seed >>> 0) + 0x6d2b79f5;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
