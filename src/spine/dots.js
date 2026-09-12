// Filled dots as pen paths, shared by stippleGrowing and ditherGrid. Both
// calibrations below were measured with the renderer.

/**
 * Largest chord error when tessellating a dot, in pen widths.
 *
 * Much tighter than the 0.25 circlePacking uses for outlines, because an outline
 * only has to look round while this spiral is a fill whose turns are pitched to
 * abut exactly. A polyline chord sags inward, so a sag comparable to the pitch
 * opens a gap on every turn — measured, 0.25 cost 6-14% of the ink asked for.
 * The turn count is unchanged; only the points per turn go up.
 */
export const SAGITTA = 0.03;

/**
 * A filled dot of radius rDot as a single stroke: an Archimedean spiral of pitch
 * w from the centre outward, closed with a full circle.
 *
 * Pitch w is what makes the fill exact -- consecutive turns sit w apart and the
 * pen covers w/2 either side, so they abut with neither gap nor overlap.
 *
 * At rDot = w/2 there is nothing to spiral: the pen already covers the disc, so
 * the dot is a single point. renderStrokes stamps a single-point path as a disc
 * of radius wLine/2, and svg.js writes it as a zero-length round-capped path --
 * both exactly right, so no closed circle is needed to keep the export
 * unambiguous.
 *
 * @param {number} x,y   centre, 1-based pixel coords
 * @param {number} rDot  radius of the disc to fill, pixels
 * @param {number} w     pen width, pixels
 * @returns {Array<[number,number]>} one polyline
 */
export function dotPath(x, y, rDot, w) {
  const rEnd = rDot - w / 2;
  const sag = SAGITTA * w;
  if (rEnd <= sag) return [[x, y]];

  // Point count for the closing ring, from the chord-error budget.
  const step = Math.min(1, 2 * Math.acos(Math.max(-1, 1 - sag / rEnd)));
  const n = Math.max(8, Math.ceil((2 * Math.PI) / step));

  // The ring radius is not rDot - w/2. What gets inked is the ring POLYGON
  // offset by w/2, and a polygon has both less area and less perimeter than the
  // circle through its vertices, so the nominal radius draws systematically
  // light — 0.8% at rDot = 6w rising to 2% at 1.5w, worst where the dots are
  // smallest and most numerous.
  //
  // The offset area has a closed form, so solve for the radius that makes it
  // right rather than buying the same accuracy with more points:
  //
  //     c1 R^2 + c2 R (w/2) + pi (w/2)^2 = pi rDot^2
  //     c1 = (n/2) sin(2pi/n)     polygon area
  //     c2 = 2n sin(pi/n)         polygon perimeter
  const c1 = (n / 2) * Math.sin((2 * Math.PI) / n);
  const c2 = 2 * n * Math.sin(Math.PI / n);
  const bq = c2 * (w / 2);
  const cq = Math.PI * (w / 2) * (w / 2) - Math.PI * rDot * rDot;
  const rRing = (-bq + Math.sqrt(bq * bq - 4 * c1 * cq)) / (2 * c1);

  const pts = [];
  const totalTheta = (2 * Math.PI * rRing) / w;
  let th = 0;
  while (th < totalTheta) {
    const r = (w * th) / (2 * Math.PI);
    pts.push([x + r * Math.cos(th), y + r * Math.sin(th)]);
    // chord error at radius r is about r*dth^2/8
    th += Math.min(1, Math.max(0.02, Math.sqrt((8 * sag) / Math.max(r, sag))));
  }

  // Closing ring, continuing from where the spiral stopped rather than
  // restarting at angle 0: this is one stroke, so restarting would draw a chord
  // across every dot.
  for (let i = 0; i <= n; i++) {
    const t = totalTheta + (2 * Math.PI * i) / n;
    pts.push([x + rRing * Math.cos(t), y + rRing * Math.sin(t)]);
  }
  return pts;
}
