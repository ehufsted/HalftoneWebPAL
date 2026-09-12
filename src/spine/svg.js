// SVG writer.
//
// Deliberately NOT a port of xyLinesToSVG.m / svgLines.m: those emit pixel units
// with no viewBox, which throws away the physical scale the units contract has
// just maintained. This writer emits millimetres with a matching viewBox, so the
// file opens at the intended size in Inkscape, vpype, AxiDraw and saxi.
//
// Input coordinates are centimetres (the output of units.toPhysical).

const NS = 'http://www.w3.org/2000/svg';
const INK = 'http://www.inkscape.org/namespaces/inkscape';

const fmt = (v, dp = 3) => {
  // A non-finite coordinate would otherwise reach the path `d` attribute as the
  // literal "NaN": most viewers drop the path, some drop the document. The
  // renderer skips non-finite points too, so a drawing cannot preview correctly
  // and still export broken.
  if (!isFinite(v)) return '0';
  const s = v.toFixed(dp);
  return s.replace(/\.?0+$/, '') || '0';
};

/**
 * @param {Array<{name:string, lines:Array<Array<[number,number]>>}>} layers
 * @param {object} opts
 * @param {number} opts.widthCm, opts.heightCm   page size
 * @param {number} opts.penWidthCm               stroke width
 *
 * No stroke colour or margin option: a margin belongs in the page setup, since
 * the plot must come out at the physical size the units contract promises.
 */
export function toSVG(layers, opts) {
  const { widthCm, heightCm, penWidthCm } = opts;

  const wMm = widthCm * 10;
  const hMm = heightCm * 10;
  const swMm = penWidthCm * 10;

  const parts = [];
  parts.push(
    `<svg xmlns="${NS}" xmlns:inkscape="${INK}" version="1.1" ` +
    `width="${fmt(wMm)}mm" height="${fmt(hMm)}mm" ` +
    `viewBox="0 0 ${fmt(wMm)} ${fmt(hMm)}">`
  );
  parts.push(
    `<g fill="none" stroke="#000000" stroke-width="${fmt(swMm, 4)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">`
  );

  layers.forEach((layer, li) => {
    parts.push(
      `<g inkscape:groupmode="layer" inkscape:label="${escapeAttr(layer.name)}" ` +
      `id="layer${li + 1}">`
    );
    for (const line of layer.lines) {
      if (!line || line.length === 0) continue;
      if (line.length === 1) {
        // a dot: a zero-length path with a round cap plots as a single pen touch
        const x = line[0][0] * 10, y = line[0][1] * 10;
        parts.push(`<path d="M${fmt(x)},${fmt(y)}l0.001,0"/>`);
        continue;
      }
      const d = line
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fmt(x * 10)},${fmt(y * 10)}`)
        .join('');
      parts.push(`<path d="${d}"/>`);
    }
    parts.push('</g>');
  });

  parts.push('</g>', '</svg>');
  return parts.join('\n');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Trigger a download of the SVG text. */
export function downloadSVG(svgText, filename = 'plot.svg') {
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
