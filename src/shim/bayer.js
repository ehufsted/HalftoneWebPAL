// Port of singleWidthLines/code/bayerMatrix.m
//
//   M = [0 2; 3 1];
//   for i=1:nIter
//       M = [4*M+0 4*M+2
//            4*M+3 4*M+1];
//   end
//   M = M/max(M(:));
//
// The MATLAB normalises by the maximum, which puts the largest cell at exactly
// 1.0. That is fine for display but wrong for thresholding: comparing
// `M < frac` then never fires for that cell even at frac = 1, so a fully-on
// region comes out one cell short. `bayerThresholds` uses the (rank + 0.5)/n^2
// form instead, for which the fraction of cells below `frac` equals `frac` to
// within one cell across the whole range.

/** Raw ordering, values 0 .. n*n-1 where n = 2^(nIter+1). */
export function bayerMatrix(nIter) {
  let n = 2;
  let data = Int32Array.from([0, 2, 3, 1]);
  for (let it = 0; it < nIter; it++) {
    const n2 = n * 2;
    const next = new Int32Array(n2 * n2);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 4 * data[y * n + x];
        next[y * n2 + x] = v + 0;
        next[y * n2 + (x + n)] = v + 2;
        next[(y + n) * n2 + x] = v + 3;
        next[(y + n) * n2 + (x + n)] = v + 1;
      }
    }
    data = next;
    n = n2;
  }
  return { n, data };
}

/** Thresholds in (0,1), suitable for `threshold < fraction` tests. */
export function bayerThresholds(nIter) {
  const { n, data } = bayerMatrix(nIter);
  const t = new Float64Array(n * n);
  const denom = n * n;
  for (let i = 0; i < t.length; i++) t[i] = (data[i] + 0.5) / denom;
  return { n, t };
}
