// Stroke renderer -- the reason "calibrated" means anything.
//
// Port of renderLineSegment.m + renderLinesAndDots.m + renderDots.m.
// The MATLAB nests two supersamples (renderLinesAndDots scales by renderScale,
// then renderLineSegment scales by a further hard-coded 3 before downsampling),
// so the effective antialiasing factor is renderScale*3. This does the same in
// one pass: draw at outScale*superSample, area-average down to outScale.
//
// The MATLAB builds the stroke mask as (perpendicular distance < w/2) AND (the
// slab between the endpoint perpendiculars), then ORs in two end discs when
// roundTips is set. That union is exactly "distance to the segment < w/2", so
// the capsule test below is equivalent and considerably shorter.

import { makeImage, resize } from '../shim/image.js';
import { distToSegmentSq } from './geometry.js';

/**
 * @param {Array<Array<[number,number]>>} lines  polylines in 1-based pixel coords.
 *        A single-point entry is a dot (renderLinesAndDots treats it that way).
 * @param {object} opts
 * @param {number} opts.wLine      stroke width in pixels
 * @param {number} opts.imW,imH    source image size in pixels
 * @param {number} [opts.outScale] output resolution multiplier (default 1)
 * @param {number} [opts.superSample] antialiasing factor (default 3, as MATLAB)
 * @returns {{w:number,h:number,data:Float32Array}} 1 = paper, 0 = ink
 *
 * Round caps always, which is what the capsule test above gives.
 */
export function renderStrokes(lines, opts) {
  const {
    wLine, imW, imH,
    outScale = 1, superSample = 3,
  } = opts;

  const s = outScale * superSample;
  const W = Math.max(1, Math.round(imW * s));
  const H = Math.max(1, Math.round(imH * s));
  const im = makeImage(W, H, 1);
  const w = wLine * s;
  const r = w / 2;
  const r2 = r * r;

  const toPix = (v) => (v - 1) * s + 1; // 1-based image coords -> 1-based supersampled

  for (const line of lines) {
    if (!line || line.length === 0) continue;

    if (line.length === 1) {
      // dot: renderDots draws a disc of radius wLine/2
      stampDisc(im, toPix(line[0][0]), toPix(line[0][1]), r, r2);
      continue;
    }

    for (let i = 0; i < line.length - 1; i++) {
      const x1 = toPix(line[i][0]), y1 = toPix(line[i][1]);
      const x2 = toPix(line[i + 1][0]), y2 = toPix(line[i + 1][1]);
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;

      // bounding box, as the MATLAB does -- this is what keeps the cost
      // proportional to ink drawn rather than canvas area times stroke count
      const i1 = Math.max(0, Math.floor(Math.min(y1, y2) - r) - 1);
      const i2 = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + r) - 1);
      const j1 = Math.max(0, Math.floor(Math.min(x1, x2) - r) - 1);
      const j2 = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + r) - 1);

      for (let iy = i1; iy <= i2; iy++) {
        const py = iy + 1;
        const row = iy * W;
        for (let ix = j1; ix <= j2; ix++) {
          if (im.data[row + ix] === 0) continue;
          const px = ix + 1;
          const d2 = distToSegmentSq(px, py, x1, y1, x2, y2);
          if (d2 < r2) im.data[row + ix] = 0;
        }
      }
    }
  }

  const outW = Math.max(1, Math.round(imW * outScale));
  const outH = Math.max(1, Math.round(imH * outScale));
  return resize(im, outW, outH);
}

function stampDisc(im, cx, cy, r, r2) {
  const i1 = Math.max(0, Math.floor(cy - r) - 1);
  const i2 = Math.min(im.h - 1, Math.ceil(cy + r) - 1);
  const j1 = Math.max(0, Math.floor(cx - r) - 1);
  const j2 = Math.min(im.w - 1, Math.ceil(cx + r) - 1);
  for (let iy = i1; iy <= i2; iy++) {
    const dy = iy + 1 - cy;
    for (let ix = j1; ix <= j2; ix++) {
      const dx = ix + 1 - cx;
      if (dx * dx + dy * dy < r2) im.data[iy * im.w + ix] = 0;
    }
  }
}
