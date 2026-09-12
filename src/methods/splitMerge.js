// Port of "etc code"/testSplitAndMergeDiagonals.m
//
// The image is cut into parallel bands. In each band the darkness is integrated
// ACROSS the band, and lines are placed wherever that running total passes a
// whole number. Consecutive bands are then joined up, and because a darker band
// needs more lines than a lighter one, lines have to merge where the picture
// gets lighter and split where it gets darker. That branching is the whole look,
// and it is what the name is about.
//
// The tone model is exact and has no constant in it, which is rare here. A band
// of height h needs K*h*dv of ink over a strip dv wide, and one line crossing the
// band lays w*h, so the number of lines to the left of v is exactly the running
// sum of K/w -- which is precisely the source's
// `p = cumsum(sum(1-subim)/h/w)`. Lines at integer p therefore sit dv = w/K
// apart and cover exactly K. The merge floor falls out of the same line: at
// K = 1 the spacing is w and the lines touch.
//
// The source shrinks the pen width in a loop until the rendered mean comes within
// 5% of the target. That global fudge has a derivable cause: a line that steps dv
// sideways between band centres has length sqrt(h^2 + dv^2), not h, so the model
// is charged w*h while the paper receives more and the drawing comes out dark.
// Putting the slant in the ladder,
//
//     dv = w / (K * cos(theta)),   cos(theta) = h / sqrt(h^2 + dv^2)
//
// and the fudge is not needed. The slant is also worst exactly where the density
// changes fastest, which is at the edges in the picture, so correcting it
// globally would have been wrong anyway.
//
// The phase anchor is a separate fix. Re-centring each band's running total on
// its own mean, as the source does, gives every band a different mean, so the
// lines pick up a spurious sideways shift from one band to the next on top of
// their real motion. Anchoring every band at the same edge removes that.
//
// The closed-form shortcut for the slant is wrong, which is worth writing down
// because the algebra looks compelling. Differentiating
// p(v, band) = k gives dv = w * (p_i - p_{i+1}) / K, so the slant appears to
// follow from the two running totals with no trial placement at all. It does not:
// that step assumes the line at index k is the SAME LINE in both bands -- that
// lines are conserved. Splitting and merging is exactly what this method does, so
// where the count changes the difference is taken up by INSERTING a line, not by
// moving the existing ones, and the formula reads the insertion as displacement.
// It therefore over-estimates the slant precisely where lines are being created,
// which is where the correction matters. Measured: a radial ramp came out 17%
// light while a flat field, which inserts nothing, was unaffected.
//
// The slant is measured from the matching instead -- one placement pass, match
// the bands, read the displacements that actually occurred, and place again.
//
// Matching the bands in order cannot produce a crossing: both lists are inverses
// of a monotone running total and so arrive sorted, and nearest-neighbour lookup
// into a sorted array is non-decreasing in the query. The gain is that one
// mechanism yields merges and splits together.

import { regionMask } from '../spine/mask.js';

export const id = 'splitMerge';
export const label = 'Splitting and merging lines';

export const params = [
  // The direction the LINES run. 90 is the source's case: horizontal bands,
  // vertical lines. Everything else follows from rotating the sampling frame.
  { key: 'lineAngle', label: 'Line direction', type: 'range', min: 0, max: 180, step: 5, def: 90, unit: '°' },
  // Multiplier on the derived band height -- see bandGeometry. 1 keeps the mesh
  // roughly isotropic; smaller gives smoother lines and more of them.
  { key: 'bandScale', label: 'Band height', type: 'range', min: 0.25, max: 4, step: 0.05, def: 1, unit: '×derived' },
  { key: 'drawSplits', label: 'Draw splits', type: 'checkbox', def: true },
];

function settingsOf(ctx) {
  return {
    theta: ((ctx.lineAngle ?? 90) * Math.PI) / 180,
    bandScale: Math.min(4, Math.max(0.25, ctx.bandScale ?? 1)),
    splits: ctx.drawSplits !== false,
  };
}

/**
 * The rotated frame, the band height, and how many bands fit.
 *
 * Band height is derived from the picture rather than chosen. A band has to be
 * short enough that the darkness is nearly constant along it, and the length
 * scale that says what "nearly" means is the spacing the lines are already at:
 * w/K for mean darkness K. Setting h to that makes the mesh of lines and bands
 * roughly isotropic, which is the condition under which the slant correction
 * stays small and the band average throws away least.
 *
 * A light picture gets tall bands, which is right rather than a compromise —
 * its lines are far apart, so there is little detail between them to lose.
 */
export function bandGeometry(ctx) {
  const { w } = ctx;
  const { theta, bandScale } = settingsOf(ctx);
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const vx = -uy, vy = ux;
  const { px, py } = ctx.polygon;

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < px.length; i++) {
    const u = px[i] * ux + py[i] * uy;
    const v = px[i] * vx + py[i] * vy;
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  }

  // mean darkness over the drawing, which sets the spacing scale
  const mask = regionMask(ctx);
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    sum += 1 - Math.min(1, Math.max(0, ctx.im.data[i]));
    n++;
  }
  const kMean = n > 0 ? Math.max(0.02, sum / n) : 0.5;
  const uSpan = uMax - uMin;
  let h = bandScale * (w / kMean);
  // Floored at ONE pen width, not two. A band thinner than the pen is meaningless
  // -- the segment across it would be shorter than the line is wide -- but two
  // was arbitrary, and on a mid-grey page the derived height lands at exactly
  // w/K = 2w, so the floor swallowed the whole lower half of the control and the
  // band-height sweep reported identical rows for every setting below 1.
  h = Math.max(w, Math.min(h, uSpan / 6));          // at least six bands, always
  const nBands = Math.max(2, Math.round(uSpan / h));
  h = uSpan / nBands;

  return { ux, uy, vx, vy, uMin, uMax, vMin, vMax, h, nBands, kMean };
}

/**
 * Mean darkness across each band, sampled on the rotated grid.
 *
 * @returns {{K: Float64Array[], nV: number, nU: number, geo: object}} `K[i][m]` is
 *          the mean darkness of band i at offset m along the band axis; `nU` is
 *          the number of samples taken across a band.
 */
export function bandDarkness(ctx) {
  const { nx, ny } = ctx;
  const geo = bandGeometry(ctx);
  const { ux, uy, vx, vy, uMin, vMin, vMax, h, nBands } = geo;
  const mask = regionMask(ctx);
  const nV = Math.max(2, Math.ceil(vMax - vMin) + 1);
  const nU = Math.max(2, Math.ceil(h));

  const K = [];
  for (let i = 0; i < nBands; i++) {
    const row = new Float64Array(nV);
    const u0 = uMin + i * h;
    for (let m = 0; m < nV; m++) {
      const v = vMin + m;
      let acc = 0, cnt = 0;
      for (let s = 0; s < nU; s++) {
        const u = u0 + ((s + 0.5) * h) / nU;
        const x = u * ux + v * vx;
        const y = u * uy + v * vy;
        const jx = Math.round(x) - 1, iy = Math.round(y) - 1;
        if (jx < 0 || iy < 0 || jx >= nx || iy >= ny) continue;
        const c = iy * nx + jx;
        if (!mask[c]) continue;
        acc += 1 - Math.min(1, Math.max(0, ctx.im.data[c]));
        cnt++;
      }
      // Columns with no pixels inside the polygon ask for nothing. Counting them
      // as zero darkness rather than skipping them keeps the running total below
      // monotone, which the inversion depends on.
      row[m] = cnt > 0 ? (acc / cnt) * (cnt / nU) : 0;
    }
    K.push(row);
  }
  return { K, nV, nU, geo };
}

/**
 * Where the lines cross each band, as offsets along the band axis.
 *
 * Two passes. The first builds the uncorrected running total, from which the
 * sideways step between bands -- and therefore the slant -- follows directly.
 * The second rebuilds it with the slant in, and inverts.
 */
export function bandCrossings(ctx) {
  const { w } = ctx;
  const { K, nV, geo } = bandDarkness(ctx);
  const { h, nBands, vMin } = geo;

  const run = (Ki, cos) => {
    const p = new Float64Array(nV);
    let acc = 0;
    for (let m = 0; m < nV; m++) {
      acc += (Ki[m] * (cos ? cos[m] : 1)) / w;
      p[m] = acc;
    }
    return p;
  };

  const invert = (pi) => {
    const xs = [];
    const last = pi[nV - 1];
    let m = 0;
    for (let k = Math.ceil(pi[0] + 1e-9); k <= last + 1e-9; k++) {
      while (m + 1 < nV && pi[m + 1] < k) m++;
      if (m + 1 >= nV) break;
      const a = pi[m], b = pi[m + 1];
      const t = b > a ? (k - a) / (b - a) : 0;
      xs.push(vMin + m + t);
    }
    return xs;
  };

  // pass 1: uncorrected, anchored at the same edge in every band
  const p0 = K.map((Ki) => run(Ki, null));
  const c0 = p0.map(invert);

  // The slant, measured rather than derived. See the header: the closed form
  // assumes lines are conserved between bands, and they are not. Matching the
  // uncorrected placement gives the displacement that actually happens, splits
  // and merges included -- a line that was just inserted matches its neighbour
  // and contributes a small step, where the closed form would have charged it
  // the whole count difference.
  const p = [];
  for (let i = 0; i < nBands; i++) {
    const a = c0[i], b = c0[Math.min(nBands - 1, i + 1)];
    // samples of |displacement| at the v where each line sits
    const sv = [], ss = [];
    for (const [ia, ib] of matchBands(a, b)) {
      sv.push(a[ia]);
      // Capped at four band heights: beyond that the "line" is not slanting, it
      // is a matching artefact at a place where the count changed abruptly, and
      // letting cos collapse there would gut the line count for a whole column.
      ss.push(Math.min(4 * h, Math.abs(b[ib] - a[ia])));
    }
    const cos = new Float64Array(nV).fill(1);
    if (sv.length > 0) {
      let j = 0;
      for (let m = 0; m < nV; m++) {
        const v = vMin + m;
        while (j + 1 < sv.length && sv[j + 1] < v) j++;
        let s;
        if (v <= sv[0]) s = ss[0];
        else if (j + 1 >= sv.length) s = ss[sv.length - 1];
        else {
          const t = (v - sv[j]) / Math.max(1e-9, sv[j + 1] - sv[j]);
          s = ss[j] + (ss[j + 1] - ss[j]) * t;
        }
        cos[m] = h / Math.hypot(h, s);
      }
    }
    p.push(run(K[i], cos));
  }

  return { crossings: p.map(invert), geo, K, p, uncorrected: c0 };
}

/**
 * Join two consecutive bands' crossings without ever crossing.
 *
 * The source takes, for each line in the upper band, its nearest neighbour below
 * (line 57). Done independently that can produce crossings: for sorted lists,
 * a < b upstairs can map to p > q downstairs, which is two lines swapping places
 * and not something a split-and-merge diagram can mean.
 *
 * Walking both lists in order cannot do that. Where the lower band has fewer
 * lines several upper ones land on the same lower one -- a MERGE; where it has
 * more, one upper serves several lower -- a SPLIT.
 *
 * @returns {Array<[number, number, boolean]>} pairs of indices, and whether the
 *          pair is a split (a repeat of the same upper line).
 */
export function matchBands(a, b) {
  const out = [];
  const n1 = a.length, n2 = b.length;
  if (n1 === 0 || n2 === 0) return out;
  let i = 0, j = 0, lastI = -1;
  for (;;) {
    out.push([i, j, i === lastI]);
    lastI = i;
    const canI = i + 1 < n1, canJ = j + 1 < n2;
    if (!canI && !canJ) break;
    if (!canJ) { i++; continue; }
    if (!canI) { j++; continue; }
    const dBoth = Math.abs(a[i + 1] - b[j + 1]);
    const dI = Math.abs(a[i + 1] - b[j]);
    const dJ = Math.abs(a[i] - b[j + 1]);
    if (dBoth <= dI && dBoth <= dJ) { i++; j++; }
    else if (dI <= dJ) i++;
    else j++;
  }
  return out;
}

/**
 * The tone this method aims for: the image itself.
 *
 * Unusually here there is no band to squeeze into. Coverage is K exactly, over
 * the whole range: at K = 1 the spacing is one pen width and the area is solid,
 * at K = 0 no line is placed at all. Nothing is unreachable.
 *
 * What IS approximate is the band average -- detail finer than the band height,
 * measured along the lines, is averaged away before any line is placed. That is
 * the same trade planeWaves makes with its region size, and for the same reason
 * it is not folded in here: it is the method's error, not its target, and the
 * band-height sweep in the harness is what measures it.
 */
export function targetImage(ctx) {
  return ctx.im;
}

export function run(ctx) {
  const { crossings, geo } = bandCrossings(ctx);
  const { ux, uy, vx, vy, uMin, h, nBands } = geo;
  const { splits } = settingsOf(ctx);

  // Segments run between band CENTRES, which leaves half a band unlit at each
  // end of the stack -- h/2 top and bottom, and the drawing is that much light
  // over its whole width. Measured at 1.1% of the page on a flat field, which is
  // small but is a systematic rather than noise, and it costs one line to
  // remove: the first and last segments reach all the way to the edge.
  const at = (band, v, edge) => {
    const u = edge === 'start' ? uMin
            : edge === 'end' ? uMin + nBands * h
            : uMin + (band + 0.5) * h;
    return [u * ux + v * vx, u * uy + v * vy];
  };

  const out = [];
  for (let i = 0; i + 1 < nBands; i++) {
    const a = crossings[i], b = crossings[i + 1];
    const first = i === 0, last = i + 2 === nBands;
    for (const [ia, ib, isSplit] of matchBands(a, b)) {
      if (isSplit && !splits) continue;
      out.push([
        at(i, a[ia], first ? 'start' : null),
        at(i + 1, b[ib], last ? 'end' : null),
      ]);
    }
  }
  return out;
}

export default { id, label, params, run, targetImage };
