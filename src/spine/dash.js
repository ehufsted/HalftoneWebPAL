// The ink debt: how a carrier decides where along itself to lay dashes.
//
// A dashed method holds its geometry still and modulates the DUTY CYCLE. Walk a
// carrier accumulating the ink the image owes along it, and lay a dash each time
// the debt reaches one dash's worth. The count is then correct by construction --
// no calibration is possible, because nothing is fitted.
//
// This module is the ink law, not the geometry. `dashHatching` walks a straight
// carrier parameterised by its projection onto a unit vector while
// `dashedStreamlines` walks a polyline by arc length, and forcing those through
// one parameterisation would move both methods' measured numbers for no gain.
// What they share is the part that is invisible when wrong:
//
//   A dash is a stadium. Length d under a round-capped pen of width w covers
//   d*w + pi*w^2/4. The caps are a quarter of the mark at d = 2w, so charging a
//   rectangle lays that fraction too much ink everywhere.
//
//   An abutting dash costs less. The union of stadiums over [s0,s1] and [s1,s2]
//   is the stadium over [s0,s2] — one pair of caps, not two — so a dash that
//   continues its predecessor is charged its length times w and no caps. Charging
//   both alike runs the shadows light by pi*w/(4d), 10% at d = 8w.
//
//   The debt is never dropped. Settling each carrier independently and discarding
//   the remainder loses half a dash per carrier — 2.8% of the ink on a
//   53-carrier page, always light. The debt carries from one carrier to the next,
//   so the only ink a whole drawing loses is the final remainder.
//
//   A phase offset is a loan, not a gift. Seeding a carrier's accumulator shifts
//   where its first dash falls, which is how a phase control works, but the
//   credit must be repaid at the carrier's end or it quietly pays back part of
//   the dropped remainder — enough to move the tone by a few percent while
//   claiming to change arrangement only.


/**
 * Paper a straight mark of length d covers under a round-capped pen of width w.
 *
 * The stadium: a d-by-w rectangle plus the two half-discs of the caps. At d = 0
 * it is pi*(w/2)^2, a single pen touch, which is what makes it the mark law for a
 * dot as well as for a dash.
 */
export function stadiumArea(d, w) {
  return d * w + (Math.PI * w * w) / 4;
}

/**
 * @param {{w:number, dash:number}} opts  pen width and dash length, in pixels
 */
export function createInkBudget({ w, dash }) {
  const caps = (Math.PI * w * w) / 4;
  const aFresh = stadiumArea(dash, w);   // one full dash laid on clean paper

  let acc = 0;          // debt in hand, px^2 of ink
  let carry = 0;        // debt owed forward between carriers
  let credit = 0;       // this carrier's phase loan, repaid at its end
  let demanded = 0;     // everything the image asked for
  let undelivered = 0;  // debt there was no room anywhere to lay
  let charged = 0;      // ink actually paid out as marks
  let fresh = 0, abutting = 0;   // how those marks were charged

  return {
    aFresh,

    /** Start a carrier, optionally shifting its phase by a repayable loan. */
    begin(phaseCredit = 0) {
      credit = phaseCredit;
      acc = carry + credit;
    },

    /** The image owes this much more ink along the carrier. */
    owe(ink) {
      acc += ink;
      demanded += ink;
    },

    /** True while the debt has reached a whole dash. */
    due() {
      return acc >= aFresh;
    },

    /**
     * Pay for the length actually laid, which is shorter than the nominal dash
     * where one had to be trimmed to fit the carrier's end.
     */
    charge(run, abut) {
      const paid = run * w + (abut ? 0 : caps);
      acc -= paid;
      charged += paid;
      if (abut) abutting++; else fresh++;
    },

    /**
     * End the carrier: repay the loan and hand the rest forward.
     *
     * The cap never binds on a well-specified run, where the leftover is a
     * remainder smaller than one dash. It binds under saturation, where the debt
     * genuinely cannot be laid and carrying it would bleed a dark region's ink
     * into the next light one.
     */
    end() {
      carry = acc - credit;
      if (carry > aFresh) {
        undelivered += carry - aFresh;
        carry = aFresh;
      }
    },

    /**
     * Ink asked for, ink paid out, and ink that found no room -- all px^2.
     *
     * `charged` separates three failures a single tone number cannot: demand not
     * matching the target, marks not being paid for what they cover, and the
     * renderer disagreeing with the area law.
     */
    report() {
      return { demanded, undelivered, charged, fresh, abutting };
    },
  };
}

/**
 * Cumulative arc length along a polyline, and the point at a given arc length.
 *
 * A dash on a curved carrier is a sub-arc, not a chord: a chord across a turn
 * cuts the corner and lays less ink than the arc length it was charged for.
 */
export function arcTable(points) {
  const s = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    s[i] = s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0],
                                 points[i][1] - points[i - 1][1]);
  }
  return s;
}

/**
 * The piece of `points` between arc lengths s0 and s1, endpoints interpolated.
 *
 * @returns {Array<[number,number]>} at least two points, or [] if the span is empty
 */
export function subPolyline(points, s, s0, s1) {
  const total = s[s.length - 1];
  const a = Math.max(0, Math.min(total, s0));
  const b = Math.max(0, Math.min(total, s1));
  if (!(b > a)) return [];

  const at = (t) => {
    // last index with s[i] <= t
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= t) lo = mid; else hi = mid;
    }
    const span = s[lo + 1] - s[lo];
    const f = span > 0 ? (t - s[lo]) / span : 0;
    return [
      points[lo][0] + f * (points[lo + 1][0] - points[lo][0]),
      points[lo][1] + f * (points[lo + 1][1] - points[lo][1]),
      lo,
    ];
  };

  const [ax, ay, ai] = at(a);
  const [bx, by, bi] = at(b);
  const out = [[ax, ay]];
  for (let i = ai + 1; i <= bi; i++) out.push([points[i][0], points[i][1]]);
  out.push([bx, by]);
  return out;
}
