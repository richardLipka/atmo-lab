/**
 * One direction of the sky: where the light you see there comes from.
 *
 * Along your line of sight, every bit of air is lit by the Sun. It scatters a
 * little of that light towards you, and part of that is lost again on the way
 * to you. The sky's light in that direction is the sum of these
 * contributions:
 *
 *   L(lambda) = sum over the line of  S(lambda) * T_sun * beta * P(theta) * T_you * ds
 *
 *   S        sunlight above the atmosphere
 *   T_sun    the share that reaches that bit of air (its own path from the Sun)
 *   beta*P   how much that air scatters towards you: molecules (Rayleigh,
 *            with air's depolarisation) and haze (Henyey-Greenstein), each with
 *            its own density at that height
 *   T_you    the share that survives the rest of the way to you
 *
 * This is single scattering, as in the rest of the simulator. It can end on a
 * hill instead of at the top of the air: then the hill's own sunlit surface
 * is added, dimmed by the air in front of it - the light from the air between
 * is what makes distant hills blue and pale.
 *
 * Geometry: a vertical plane through the Sun, the observer at (0, R) on the
 * ground, x to the right, the Sun to the LEFT at elevation e. The direction of
 * view is a signed angle from the zenith: negative towards the Sun, positive
 * away from it.
 */

import { v3, v3addScaled, v3length } from './geometry.js';
import { rayleighPhase, henyeyGreensteinPhase } from './scattering.js';
import { SPECTRUM_BINS, RAY_BANDS, BAND_OF_BIN } from './spectrum.js';

/** How dark and how coloured a forested hillside is: a few per cent, a little more in the green. */
const HILL_REFLECTANCE = { blue: 0.04, green: 0.07, red: 0.05 };

function hillReflectance(nm) {
  if (nm < 490) return HILL_REFLECTANCE.blue;
  if (nm < 580) return HILL_REFLECTANCE.green;
  return HILL_REFLECTANCE.red;
}

/**
 * @param {object} o
 *   atmosphere   from createAtmosphere
 *   source       the Sun's spectrum above the air
 *   wavelengths  the grid's wavelengths, nm
 *   sunElevationDeg, viewDeg (signed from the zenith, negative = towards the Sun)
 *   hillKm       distance to a hill on the horizon, or null for none
 *   samples      steps along the line
 * @returns {{
 *   samples: Array<{t, x, y, altitude, bands, total, sunBands, spectrum, sunSpectrum}>: per step,
 *     what it sends you (by band, in all, as a spectrum) and the sunlight reaching it,
 *   spectrum: Float64Array, airSpectrum: Float64Array, hillSpectrum: Float64Array|null,
 *   scatteringAngleDeg:number, length:number, endsOn:'space'|'ground'|'hill',
 *   polarization:number, transmissionToHill: Float64Array|null,
 * }}
 */
export function traceSightline({ atmosphere, source, wavelengths, sunElevationDeg, viewDeg, hillKm = null, samples = 160 }) {
  const R = atmosphere.planetRadius;
  const observer = v3(0, R + 1, 0);
  const e = sunElevationDeg * Math.PI / 180;
  const toSun = v3(-Math.cos(e), Math.sin(e), 0);
  const a = viewDeg * Math.PI / 180;
  // Negative angles lean towards the Sun, on the left.
  const view = v3(Math.sin(a), Math.cos(a), 0);
  const cosTheta = -(toSun.x * -view.x + toSun.y * -view.y);   // incoming -toSun, outgoing -view
  const scatteringAngleDeg = Math.acos(Math.max(-1, Math.min(1, cosTheta))) * 180 / Math.PI;

  const extent = atmosphere.rayExtent(observer, view);
  let length = extent.distance;
  let endsOn = extent.hitGround ? 'ground' : 'space';
  // A hill stands on the horizon: it only ends a line of sight that is (nearly) level.
  if (hillKm != null && Math.abs(viewDeg) >= 88 && hillKm * 1000 < length) { length = hillKm * 1000; endsOn = 'hill'; }

  const pR = rayleighPhase(cosTheta, atmosphere.rayleighDepolarization);
  const pA = henyeyGreensteinPhase(cosTheta, atmosphere.asymmetryG);
  // Degree of polarisation of the molecular light at this angle; the haze's
  // light is counted as unpolarised (a simplification, stated in the panel).
  const gamma = atmosphere.rayleighDepolarization / (2 - atmosphere.rayleighDepolarization);
  const c2 = cosTheta * cosTheta;
  const molecularPolarization = (1 - gamma) * (1 - c2) / ((1 + 3 * gamma) + (1 - gamma) * c2);

  const kR = atmosphere.rayleighBeta0, kAe = atmosphere.aerosolExt0, kAs = atmosphere.aerosolSca0;
  const kO = atmosphere.ozoneAbsorption0;
  const tauOf = (col, i) => kR[i] * col.r + kAe[i] * col.a + (kO ? kO[i] * col.o : 0);
  const sunTransmission = (point) => {
    const out = new Float64Array(SPECTRUM_BINS);
    const reach = atmosphere.rayExtent(point, toSun);
    if (reach.hitGround) return out;
    const cols = atmosphere.pathColumns(point, toSun, reach.distance, 24);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      out[i] = Math.exp(-(kR[i] * cols.columnR + kAe[i] * cols.columnA + (kO ? kO[i] * cols.columnO : 0)));
    }
    return out;
  };

  const airSpectrum = new Float64Array(SPECTRUM_BINS);
  const tauToYou = new Float64Array(SPECTRUM_BINS);
  const out = [];
  const ds = length / samples;
  let previousAltitude = 0;
  let molecular = 0, total = 0;
  for (let k = 0; k < samples; k++) {
    const t = (k + 0.5) * ds;
    const point = v3addScaled(observer, view, t);
    const altitude = v3length(point) - R;
    // The air between the previous sample and this one, on the way to you.
    const col = atmosphere.segmentColumns(previousAltitude, altitude, k === 0 ? ds / 2 : ds);
    previousAltitude = altitude;
    for (let i = 0; i < SPECTRUM_BINS; i++) tauToYou[i] += tauOf(col, i);
    const local = atmosphere.segmentColumns(altitude, altitude, 1);   // densities here
    const tSun = sunTransmission(point);
    const bands = new Float64Array(RAY_BANDS.length);
    const sunBands = new Float64Array(RAY_BANDS.length);
    const spectrum = new Float64Array(SPECTRUM_BINS);
    const sunSpectrum = new Float64Array(SPECTRUM_BINS);
    let sum = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const mol = kR[i] * local.r * pR;
      const haze = kAs[i] * local.a * pA;
      const reach = source[i] * tSun[i] * Math.exp(-tauToYou[i]) * ds;
      const v = reach * (mol + haze);
      airSpectrum[i] += v;
      spectrum[i] = v;
      sunSpectrum[i] = source[i] * tSun[i];
      bands[BAND_OF_BIN[i]] += v;
      sunBands[BAND_OF_BIN[i]] += source[i] * tSun[i];
      sum += v;
      molecular += reach * mol;
      total += v;
    }
    out.push({ t, x: point.x, y: point.y, altitude, bands, total: sum, sunBands, spectrum, sunSpectrum });
  }

  // A hill at the end of the line: its sunlit face, dimmed by the air in front.
  let hillSpectrum = null, transmissionToHill = null;
  if (endsOn === 'hill') {
    const foot = v3addScaled(observer, view, length);
    const tSun = sunTransmission(foot);
    hillSpectrum = new Float64Array(SPECTRUM_BINS);
    transmissionToHill = new Float64Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      transmissionToHill[i] = Math.exp(-tauToYou[i]);
      hillSpectrum[i] = (hillReflectance(wavelengths[i]) / Math.PI) * source[i] * tSun[i]
        * Math.max(0, Math.sin(e)) * transmissionToHill[i];
    }
  }
  const spectrum = Float64Array.from(airSpectrum, (v, i) => v + (hillSpectrum ? hillSpectrum[i] : 0));
  return {
    samples: out, spectrum, airSpectrum, hillSpectrum, transmissionToHill,
    scatteringAngleDeg, length, endsOn,
    polarization: total > 0 ? molecularPolarization * molecular / total : 0,
  };
}
