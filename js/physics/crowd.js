/**
 * Many molecules together: why air scatters light sideways and glass or clean
 * water hardly does.
 *
 * Every molecule a light wave reaches sends out its own small wave. In a given
 * direction these waves arrive with phases set by where the molecules sit:
 *
 *   - evenly spaced, closer than a wavelength (glass, water, a crystal): for
 *     every molecule there is one whose wave arrives half a period later, and
 *     sideways and backwards the waves cancel. Forwards they are always in
 *     step: that is the light going on through the material.
 *   - randomly placed (a gas): the sideways waves add like steps of a random
 *     walk. Their sum is about the square root of N waves long, so the light
 *     it carries - the square of that - is about N times one molecule's.
 *     Scattered light grows in proportion to the number of molecules.
 *
 * The block is a square a whole number of wavelengths wide with a whole number
 * of molecules per wavelength (at least three), so in the even arrangement
 * the sideways and backward sums cancel exactly rather than nearly.
 */

/** Molecules per wavelength along each side of the even arrangement. */
export const PER_WAVELENGTH = 4;

function crowdRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Positions in units of one wavelength, inside a square `sizeWavelengths` wide.
 * @param {'even'|'random'} arrangement
 */
export function crowdPositions(arrangement, sizeWavelengths, seed = 1) {
  const side = PER_WAVELENGTH * sizeWavelengths;
  const n = side * side;
  const points = [];
  if (arrangement === 'even') {
    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) points.push([(i + 0.5) / PER_WAVELENGTH, (j + 0.5) / PER_WAVELENGTH]);
    }
  } else {
    const rng = crowdRng(seed);
    for (let k = 0; k < n; k++) points.push([rng() * sizeWavelengths, rng() * sizeWavelengths]);
  }
  return points;
}

/**
 * The waves from all the molecules added for one direction (degrees from the
 * forward direction; the light arrives along +x). Each molecule's wave counts
 * as length 1.
 * @returns {{ chain: Array<{x:number,y:number}>, length:number, intensity:number }}
 *   chain: the running sum, head to tail; length: how long the sum is;
 *   intensity: its square, the light sent that way, in units of one molecule.
 */
export function crowdSum(points, thetaDeg) {
  const th = thetaDeg * Math.PI / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const k = 2 * Math.PI;   // positions are in wavelengths
  const chain = [{ x: 0, y: 0 }];
  let sx = 0, sy = 0;
  for (const [px, py] of points) {
    const phase = k * (px - (px * c + py * s));
    sx += Math.cos(phase);
    sy += Math.sin(phase);
    chain.push({ x: sx, y: sy });
  }
  const length = Math.hypot(sx, sy);
  return { chain, length, intensity: length * length };
}
