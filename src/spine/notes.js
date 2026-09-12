// A one-line diagnostic channel from a method back to the UI.
//
// A method that can stop early for several different reasons owes the user the
// reason: stringArt's tone error is uninterpretable without knowing whether the
// thread ran out of budget, ran out of edges, or finished the picture. It is not
// returned from `run(ctx)` because the geometry channel stays exactly one type.
//
// A module global is acceptable here — unlike elsewhere in spine/ — because this
// is write-only diagnostics. Nothing reads it back to make a decision, so it
// cannot influence geometry, tone, or the seeded RNG's call sequence, and the
// harness never reads it at all.

let pending = '';

/** Record a short human-readable note about the run just completed. */
export function setNote(text) {
  pending = String(text || '');
}

/** Read and clear. The worker calls this after every `run`. */
export function takeNote() {
  const n = pending;
  pending = '';
  return n;
}
