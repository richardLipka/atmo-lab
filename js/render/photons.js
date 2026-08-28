/**
 * Monte Carlo photon paths, for the picture rather than for the numbers.
 *
 * The spectra and colours come from the deterministic integrator in
 * physics/radiance.js. This module exists so a student can watch individual
 * photons and see WHY those integrals come out the way they do: launch a few
 * hundred photons drawn from the star spectrum and the blue ones visibly get
 * knocked out of the beam while the red ones sail through.
 *
 * Collisions are found by delta tracking (also called Woodcock tracking): the
 * medium is treated as if it had a constant extinction equal to its densest
 * value, and the surplus collisions are rejected in proportion to the real
 * local density. That handles an exponential atmosphere exactly, with no
 * stepping error.
 *
 * The paths are drawn in a flat slab whose density depends only on altitude.
 * Over the width of the picture the curvature of the planet is invisible, and
 * the flat slab makes the geometry far easier to read.
 */

import { SPECTRUM_BINS, WAVELENGTHS_NM } from '../physics/spectrum.js';
import { sampleRayleighCosine, sampleHenyeyGreensteinCosine } from '../physics/scattering.js';

/** A small deterministic generator, so a given setup always draws the same picture. */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Cumulative distribution over the spectral bins, for sampling wavelengths. */
function buildWavelengthCdf(source) {
  const cdf = new Float64Array(SPECTRUM_BINS);
  let total = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) { total += source[i]; cdf[i] = total; }
  if (total <= 0) return null;
  for (let i = 0; i < SPECTRUM_BINS; i++) cdf[i] /= total;
  return cdf;
}

function sampleWavelengthIndex(cdf, u) {
  let lo = 0, hi = SPECTRUM_BINS - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Trace photons through a flat slab.
 *
 * @param {object} options
 *   atmosphere        an object from createAtmosphere
 *   source            top-of-atmosphere spectrum, used to draw wavelengths
 *   sunElevationDeg   elevation of the star above the horizon
 *   count             how many photons to launch
 *   halfWidth_m       half the width of the drawn domain
 *   top_m             top of the drawn domain
 *   seed              generator seed
 *   maxEvents         cap on scattering events per photon
 */
export function tracePhotons(options) {
  const {
    atmosphere, source, sunElevationDeg, count,
    halfWidth_m, top_m, seed = 12345, maxEvents = 24,
  } = options;

  const cdf = buildWavelengthCdf(source);
  const paths = [];
  if (!cdf || count <= 0) return paths;

  const rng = makeRng(seed);
  const elevation = sunElevationDeg * Math.PI / 180;
  // Direction of travel: from the star down into the atmosphere.
  const incoming = { x: -Math.cos(elevation), y: -Math.sin(elevation) };

  const betaR = atmosphere.rayleighBeta0;
  const betaAext = atmosphere.aerosolExt0;
  const betaAsca = atmosphere.aerosolSca0;
  const g = atmosphere.asymmetryG;

  for (let n = 0; n < count; n++) {
    const bin = sampleWavelengthIndex(cdf, rng());
    const lambda = WAVELENGTHS_NM[bin];

    // Peak extinction, reached at the bottom of the slab.
    const sigmaMax = betaR[bin] + betaAext[bin];
    if (!(sigmaMax > 0)) {
      // A vacuum: the photon crosses the picture untouched, which is exactly
      // the point being made on an airless world.
      const target = { x: (rng() * 2 - 1) * halfWidth_m, y: 0 };
      const start = { x: target.x - incoming.x * (top_m / -incoming.y), y: top_m };
      paths.push({
        lambda, bin,
        points: [start, target],
        events: [
          { type: 'enter', x: start.x, y: start.y, altitude: top_m, lambda },
          { type: 'ground', x: target.x, y: 0, altitude: 0, lambda },
        ],
        outcome: 'ground', scatterCount: 0,
      });
      continue;
    }

    // Aim at a point spread across the visible ground, then back off to the
    // top of the domain, so the drawn beam sweeps the whole picture.
    const aim = (rng() * 2 - 1) * halfWidth_m;
    const backoff = top_m / Math.max(0.05, Math.abs(incoming.y));
    let x = aim - incoming.x * backoff;
    let y = top_m;
    let dx = incoming.x, dy = incoming.y;

    const points = [{ x, y }];
    const events = [{ type: 'enter', x, y, altitude: y, lambda }];
    let outcome = 'exit';
    let scatterCount = 0;

    for (let step = 0; step < maxEvents * 6; step++) {
      // Delta tracking: sample a candidate flight in the fictitious medium.
      const distance = -Math.log(1 - rng()) / sigmaMax;
      let nx = x + dx * distance;
      let ny = y + dy * distance;

      if (ny <= 0) {
        // Crosses the ground: stop exactly at the surface.
        const t = y / Math.max(1e-9, y - ny);
        points.push({ x: x + (nx - x) * t, y: 0 });
        events.push({ type: 'ground', x: x + (nx - x) * t, y: 0, altitude: 0, lambda });
        outcome = 'ground';
        break;
      }
      if (ny >= top_m) {
        const t = (top_m - y) / Math.max(1e-9, ny - y);
        points.push({ x: x + (nx - x) * t, y: top_m });
        events.push({ type: 'escape', x: x + (nx - x) * t, y: top_m, altitude: top_m, lambda });
        outcome = 'escape';
        break;
      }
      if (Math.abs(nx) > halfWidth_m * 1.6) {
        points.push({ x: nx, y: ny });
        events.push({ type: 'exitView', x: nx, y: ny, altitude: ny, lambda });
        outcome = 'exitView';
        break;
      }

      x = nx; y = ny;

      // Reject the collision in proportion to how thin the air really is here.
      const localR = betaR[bin] * atmosphere.densityRayleigh(y);
      const localAext = betaAext[bin] * atmosphere.densityAerosol(y);
      const localTotal = localR + localAext;
      if (rng() * sigmaMax > localTotal) continue;   // a fictitious collision

      points.push({ x, y });

      // Which species did the photon meet, and did it survive the encounter?
      const isRayleigh = rng() * localTotal < localR;
      const localAsca = betaAsca[bin] * atmosphere.densityAerosol(y);
      const albedo = isRayleigh ? 1 : (localAext > 0 ? localAsca / localAext : 0);

      if (!isRayleigh && rng() > albedo) {
        events.push({ type: 'absorb', x, y, altitude: y, lambda, species: 'aerosol' });
        outcome = 'absorb';
        break;
      }

      const cosTheta = isRayleigh
        ? sampleRayleighCosine(rng)
        : sampleHenyeyGreensteinCosine(g, rng);
      const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
      // Project the scattering onto the drawing plane by choosing the turn
      // direction at random. The angle statistics stay those of the real
      // phase function.
      const turn = rng() < 0.5 ? theta : -theta;
      const cos = Math.cos(turn), sin = Math.sin(turn);
      const ndx = dx * cos - dy * sin;
      const ndy = dx * sin + dy * cos;
      dx = ndx; dy = ndy;

      scatterCount++;
      events.push({
        type: 'scatter', x, y, altitude: y, lambda,
        species: isRayleigh ? 'rayleigh' : 'aerosol',
        angleDeg: Math.abs(turn) * 180 / Math.PI,
      });
      if (scatterCount >= maxEvents) { outcome = 'truncated'; break; }
    }

    paths.push({ lambda, bin, points, events, outcome, scatterCount });
  }

  return paths;
}

/**
 * Tally what happened to a set of photons, split into a short-wavelength and a
 * long-wavelength group. This is the number that makes the lesson concrete:
 * far more blue photons are deflected than red ones.
 */
export function summarisePhotons(paths, splitNm = 520) {
  const tally = {
    blue: { total: 0, scattered: 0 },
    red: { total: 0, scattered: 0 },
    absorbed: 0, escaped: 0, ground: 0,
  };
  for (const p of paths) {
    const group = p.lambda < splitNm ? tally.blue : tally.red;
    group.total++;
    if (p.scatterCount > 0) group.scattered++;
    if (p.outcome === 'absorb') tally.absorbed++;
    else if (p.outcome === 'escape') tally.escaped++;
    else if (p.outcome === 'ground') tally.ground++;
  }
  return tally;
}
