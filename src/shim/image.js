// MATLAB image-toolbox shims.
//
// Everything here exists so the method ports can stay readable against their
// MATLAB source. Images are {w, h, data} with data a Float32Array in [0,1],
// row-major, and *1-based* pixel coordinates in the sampling functions --
// matching MATLAB's meshgrid(1:nx, 1:ny) so ported index arithmetic transfers
// unchanged.

export function makeImage(w, h, fill = 0) {
  const data = new Float32Array(w * h);
  if (fill !== 0) data.fill(fill);
  return { w, h, data };
}

export function cloneImage(im) {
  return { w: im.w, h: im.h, data: Float32Array.from(im.data) };
}

/** rgb2gray. MATLAB's luminance weights. */
export function fromImageData(imgData) {
  const { width: w, height: h, data: src } = imgData;
  const out = makeImage(w, h);
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) {
    out.data[i] = (0.2989 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]) / 255;
  }
  return out;
}

/** 1 - v. Flips which end of [0,1] means "ink" -- the whole of a white-on-black run. */
export function invert(im) {
  const out = cloneImage(im);
  for (let i = 0; i < out.data.length; i++) out.data[i] = 1 - out.data[i];
  return out;
}

/**
 * rgb2cmyk with grey component replacement (GCR).
 *
 * Naive subtractive split: c/m/y start as the complements of r/g/b, then the
 * amount they agree on (their minimum, scaled by `gcr`) is pulled out into k --
 * gcr=1 is full replacement (no channel carries any grey it doesn't have to),
 * gcr=0 leaves k at 0 and c/m/y unadjusted.
 *
 * Plain subtraction, NOT divided back out by (1-k). Dividing would rescale
 * each channel back up to [0,1] and preserve saturation on fully-saturated
 * colours, but it blows up exactly where gcr=1 matters most: a near-black
 * pixel has cc/mm/yy all close to kk, so 1-kk is tiny and any noise between
 * the three channels -- sensor noise, JPEG blocking, nothing a viewer would
 * call a colour cast -- gets divided by that tiny number into a chunk of
 * spurious cyan or magenta ink through what should be a neutral shadow.
 * Subtracting without rescaling keeps a near-black pixel near zero in every
 * channel but k, at the cost of never fully saturating C/M/Y on their own.
 *
 * Each output plane is a COVERAGE image -- 0 = no ink, 1 = full ink of that
 * colorant -- the opposite polarity from fromImageData's 0=ink convention, so a
 * caller must invert() a plane before handing it to prepare().
 */
export function fromImageDataCMYK(imgData, gcr = 1) {
  const { width: w, height: h, data: src } = imgData;
  const c = makeImage(w, h), m = makeImage(w, h), y = makeImage(w, h), k = makeImage(w, h);
  for (let i = 0, p = 0; i < c.data.length; i++, p += 4) {
    const r = src[p] / 255, g = src[p + 1] / 255, b = src[p + 2] / 255;
    const cc = 1 - r, mm = 1 - g, yy = 1 - b;
    const kk = Math.min(cc, mm, yy) * gcr;
    c.data[i] = cc - kk;
    m.data[i] = mm - kk;
    y.data[i] = yy - kk;
    k.data[i] = kk;
  }
  return { c, m, y, k };
}

/**
 * imresize. Area-average on an axis that SHRINKS (which is what keeps tone
 * correct -- MATLAB's default bicubic+antialiasing does the same job), bilinear
 * on one that grows. Deliberate deviation from bicubic: area averaging is the
 * right filter for the verification render's downsample.
 *
 * A mixed resize is split into a pure shrink followed by a pure grow. The
 * area-averaging branch only fires when both axes shrink, so without the split
 * an axis that shrinks alongside one that grows would be point-sampled, throwing
 * away exactly the tone the area average exists to preserve. Both
 * single-direction cases stay byte-identical: the pass along the unchanged axis
 * has a box weight of exactly 1 in the first and an interpolation weight of
 * exactly 0 in the second.
 */
export function resize(im, newW, newH) {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  if (newW === im.w && newH === im.h) return cloneImage(im);
  const sx = im.w / newW;
  const sy = im.h / newH;

  // Strict on both sides. An axis with a scale of exactly 1 is unchanged and
  // must not trigger the split, or `sx === 1, sy < 1` recurses into a first pass
  // that changes nothing, hits the identity short-circuit, and arrives back here
  // forever. It falls through to the bilinear branch instead, where an unchanged
  // axis interpolates with a weight of exactly 0.
  if ((sx > 1 && sy < 1) || (sx < 1 && sy > 1)) {
    // the shrinking axis goes first, so the average is taken over the original
    // samples rather than over interpolated ones
    return sx > 1
      ? resize(resize(im, newW, im.h), newW, newH)
      : resize(resize(im, im.w, newH), newW, newH);
  }

  const out = makeImage(newW, newH);

  if (sx >= 1 && sy >= 1) {
    // shrink: box average over the source footprint of each destination pixel
    for (let y = 0; y < newH; y++) {
      const y0 = y * sy, y1 = (y + 1) * sy;
      const iy0 = Math.floor(y0), iy1 = Math.min(im.h, Math.ceil(y1));
      for (let x = 0; x < newW; x++) {
        const x0 = x * sx, x1 = (x + 1) * sx;
        const ix0 = Math.floor(x0), ix1 = Math.min(im.w, Math.ceil(x1));
        let sum = 0, wsum = 0;
        for (let iy = iy0; iy < iy1; iy++) {
          const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
          if (wy <= 0) continue;
          for (let ix = ix0; ix < ix1; ix++) {
            const wx = Math.min(ix + 1, x1) - Math.max(ix, x0);
            if (wx <= 0) continue;
            const wgt = wx * wy;
            sum += im.data[iy * im.w + ix] * wgt;
            wsum += wgt;
          }
        }
        out.data[y * newW + x] = wsum > 0 ? sum / wsum : 0;
      }
    }
  } else {
    // grow: bilinear
    for (let y = 0; y < newH; y++) {
      const fy = Math.min(im.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const iy = Math.floor(fy), ty = fy - iy;
      const iy2 = Math.min(im.h - 1, iy + 1);
      for (let x = 0; x < newW; x++) {
        const fx = Math.min(im.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const ix = Math.floor(fx), tx = fx - ix;
        const ix2 = Math.min(im.w - 1, ix + 1);
        const a = im.data[iy * im.w + ix], b = im.data[iy * im.w + ix2];
        const c = im.data[iy2 * im.w + ix], d = im.data[iy2 * im.w + ix2];
        out.data[y * newW + x] =
          a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
      }
    }
  }
  return out;
}

/** fspecial('gaussian', hsize, sigma), separable 1-D half. Forced odd length. */
export function gaussianKernel(hsize, sigma) {
  let n = Math.max(1, Math.round(hsize));
  if (n % 2 === 0) n += 1;
  const r = (n - 1) / 2;
  const k = new Float64Array(n);
  let sum = 0;
  const s2 = 2 * Math.max(1e-6, sigma) * Math.max(1e-6, sigma);
  for (let i = 0; i < n; i++) {
    const d = i - r;
    k[i] = Math.exp(-(d * d) / s2);
    sum += k[i];
  }
  for (let i = 0; i < n; i++) k[i] /= sum;
  return k;
}

/**
 * imfilter(im, f, 'replicate') for a separable kernel.
 *
 * Each pass is split into edges and interior: only the first and last `r` samples
 * along an axis can fall outside it, so the interior run drops the clamp rather
 * than paying two comparisons per multiply over the whole raster. Accumulation
 * order is unchanged (-r..+r into one running sum) and the result is
 * bit-identical, which matters because `prepare`'s pre-smooth feeds every
 * measured constant in the project.
 */
export function imfilterSeparable(im, kernel) {
  const r = (kernel.length - 1) / 2;
  const { w, h, data } = im;
  const tmp = makeImage(w, h);
  const out = makeImage(w, h);

  const xEdge = Math.min(r, w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x < xEdge || x >= w - r) {
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          s += data[row + xx] * kernel[i + r];
        }
      } else {
        for (let i = -r; i <= r; i++) s += data[row + x + i] * kernel[i + r];
      }
      tmp.data[row + x] = s;
    }
  }

  const yEdge = Math.min(r, h);
  for (let y = 0; y < h; y++) {
    const edgeRow = y < yEdge || y >= h - r;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (edgeRow) {
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          s += tmp.data[yy * w + x] * kernel[i + r];
        }
      } else {
        for (let i = -r; i <= r; i++) s += tmp.data[(y + i) * w + x] * kernel[i + r];
      }
      out.data[y * w + x] = s;
    }
  }
  return out;
}

export function blurGaussian(im, hsize, sigma) {
  return imfilterSeparable(im, gaussianKernel(hsize, sigma));
}

/**
 * interp2(X, Y, V, xq, yq) with linear interpolation, NaN outside.
 * x, y are 1-based, matching meshgrid(1:nx, 1:ny).
 */
export function interp2(im, x, y) {
  const fx = x - 1, fy = y - 1;
  if (!(fx >= 0 && fy >= 0 && fx <= im.w - 1 && fy <= im.h - 1)) return NaN;
  const ix = Math.min(im.w - 2, Math.floor(fx));
  const iy = Math.min(im.h - 2, Math.floor(fy));
  const tx = fx - ix, ty = fy - iy;
  const a = im.data[iy * im.w + ix], b = im.data[iy * im.w + ix + 1];
  const c = im.data[(iy + 1) * im.w + ix], d = im.data[(iy + 1) * im.w + ix + 1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * inpolygon, even-odd crossing test. px/py are arrays of vertices (implicitly
 * closed).
 *
 * Points exactly on an edge count as inside, which the explicit distance test
 * below is there for. The bare crossing test is half-open, so for `fullPolygon`
 * = [1,nx]x[1,ny] — whose edges fall exactly on pixel centres — the left column
 * and top row would test inside while the right column and bottom row tested
 * outside. That is tolerable for an area integral and wrong for a region mask,
 * which is what most methods use this for: the asymmetric ring shows up directly
 * in the drawing, as seeds missing along two edges or as a band of the wrong
 * wavelength blurred inward from them.
 */
export function inpolygon(x, y, px, py) {
  let inside = false;
  const n = px.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = px[i], yi = py[i], xj = px[j], yj = py[j];

    const ex = xj - xi, ey = yj - yi;
    const len2 = ex * ex + ey * ey;
    if (len2 > 0) {
      let t = ((x - xi) * ex + (y - yi) * ey) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (xi + t * ex), dy = y - (yi + t * ey);
      if (dx * dx + dy * dy <= 1e-18) return true;      // on the edge
    }

    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** imdilate(mask, ones(3)) on a Uint8Array binary mask. */
export function dilate3(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) { v = 1; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * medfilt2(im, [n n]).
 *
 * MATLAB's default pads with zeros, which reads as black and darkens a
 * half-window border. Symmetric padding is used here instead -- it is what the
 * rest of the collection passes explicitly, and the difference is confined to a
 * border of (n-1)/2 pixels.
 *
 * It fully sorts where it only needs the median, deliberately:
 * `crosshatchQuantized` is the only caller and calls it once per run, so a
 * selection algorithm would buy nothing measurable and would have to be proved
 * to pick the same element on ties.
 */
export function medfilt2(im, n) {
  let k = Math.max(3, Math.round(n));
  if (k % 2 === 0) k += 1;
  const r = (k - 1) / 2;
  const out = makeImage(im.w, im.h);
  const window = new Float32Array(k * k);
  const mid = (k * k - 1) >> 1;
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < im.w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        // symmetric (mirror) padding
        let yy = y + dy;
        if (yy < 0) yy = -yy - 1;
        if (yy >= im.h) yy = 2 * im.h - yy - 1;
        yy = Math.min(im.h - 1, Math.max(0, yy));
        for (let dx = -r; dx <= r; dx++) {
          let xx = x + dx;
          if (xx < 0) xx = -xx - 1;
          if (xx >= im.w) xx = 2 * im.w - xx - 1;
          xx = Math.min(im.w - 1, Math.max(0, xx));
          window[m++] = im.data[yy * im.w + xx];
        }
      }
      // TypedArray.sort() is numeric by default; sorting the view in place
      // avoids an allocation per pixel
      window.subarray(0, m).sort();
      out.data[y * im.w + x] = window[mid];
    }
  }
  return out;
}

/** Mean of an image, used by the tone checks. */
export function meanOf(im) {
  let s = 0;
  for (let i = 0; i < im.data.length; i++) s += im.data[i];
  return s / im.data.length;
}
