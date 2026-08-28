/**
 * The atmosphere model: density profile, column amounts, optical depth.
 *
 * Density falls off exponentially with height,
 *
 *     rho(h) = rho_0 * exp(-h / H)
 *
 * where H is the scale height. Because that profile has a closed-form
 * integral, the amount of air directly above an observer is exact:
 *
 *     C(z) = integral from z to infinity of rho(h) dh = rho_0 * H * exp(-z / H)
 *
 * This single formula is the whole of the "flight into space" experiment: the
 * column, and with it the optical depth and the amount of scattered light,
 * decays exponentially with altitude and reaches zero only at infinity.
 *
 * Optical depth follows by multiplying a column by a wavelength-dependent
 * cross-section, and transmission follows from Beer-Lambert:
 *
 *     tau(lambda) = beta_0(lambda) * C        T(lambda) = exp(-tau(lambda))
 */

import { SPECTRUM_BINS, specNew } from './spectrum.js';
import {
  rayleighBetaSpectrum, aerosolBetaSpectrum, resolveAlbedoSpectrum,
} from './scattering.js';
import { v3, v3addScaled, v3length, v3dot, raySphereFar, raySphereNear } from './geometry.js';

/**
 * Build a ready-to-use atmosphere from a config file plus live UI overrides.
 *
 * @param {object} config  a /config/atmospheres/[name].json document
 * @param {object} overrides
 *   densityScale     multiplies every scattering coefficient (1 = as configured)
 *   scaleHeight_m    replaces the molecular scale height
 *   aerosolScale     multiplies the aerosol load only
 *   rayleighExponent replaces the wavelength exponent (4 = true Rayleigh)
 */
export function createAtmosphere(config, overrides = {}) {
  const densityScale = overrides.densityScale ?? 1;
  const aerosolScale = overrides.aerosolScale ?? 1;
  const rayleighExponent = overrides.rayleighExponent ?? (config.rayleigh.wavelengthExponent ?? 4);
  const scaleHeightR = overrides.scaleHeight_m ?? config.rayleigh.scaleHeight_m;
  // A named aerosol from config/scattering/aerosols.json replaces the haze the
  // world came with, so the same air can be given city smog or volcanic ash.
  const aerosol = overrides.aerosol ?? config.aerosol;
  // The haze layer keeps its proportion to the gas column when the gas scale
  // height is changed, so a taller atmosphere does not accidentally strand its
  // dust at the bottom.
  const heightRatio = scaleHeightR / config.rayleigh.scaleHeight_m;
  const scaleHeightA = aerosol.scaleHeight_m * heightRatio;

  const rayleighBeta0 = rayleighBetaSpectrum(
    config.rayleigh.beta550_perM * densityScale, rayleighExponent);

  const aerosolExt0 = aerosolBetaSpectrum(
    (aerosol.beta550_perM ?? 0) * densityScale * aerosolScale,
    aerosol.angstromExponent ?? 1);

  const albedo = resolveAlbedoSpectrum(aerosol.singleScatteringAlbedo ?? 1);
  const aerosolSca0 = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) aerosolSca0[i] = aerosolExt0[i] * albedo[i];

  const planetRadius = config.planetRadius_m;
  const topAltitude = config.topAltitude_m;
  const topRadius = planetRadius + topAltitude;

  /** Relative molecular density at height h (1 at the surface). */
  function densityRayleigh(h) {
    return h < 0 ? 1 : Math.exp(-h / scaleHeightR);
  }
  function densityAerosol(h) {
    return h < 0 ? 1 : Math.exp(-h / scaleHeightA);
  }

  /** Vertical column of relative density above altitude z, in metres. */
  function verticalColumnRayleigh(z) {
    return scaleHeightR * Math.exp(-Math.max(0, z) / scaleHeightR);
  }
  function verticalColumnAerosol(z) {
    return scaleHeightA * Math.exp(-Math.max(0, z) / scaleHeightA);
  }

  /** Mass of air above one square metre at altitude z, in kg. */
  function massColumn(z) {
    const g = config.surfaceGravity_mps2;
    const p = config.surfacePressure_kPa;
    if (!g || !p) return null;
    const surfaceMass = (p * 1000) / g;
    return surfaceMass * Math.exp(-Math.max(0, z) / scaleHeightR);
  }

  /** Beer-Lambert transmission for a pair of accumulated columns. */
  function transmittance(columnR, columnA) {
    const t = specNew();
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      t[i] = Math.exp(-(rayleighBeta0[i] * columnR + aerosolExt0[i] * columnA));
    }
    return t;
  }

  /** Optical depth spectrum for a pair of accumulated columns. */
  function opticalDepth(columnR, columnA) {
    const t = specNew();
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      t[i] = rayleighBeta0[i] * columnR + aerosolExt0[i] * columnA;
    }
    return t;
  }

  /** Altitude of a point above the planet surface. */
  function altitudeAt(p) {
    return v3length(p) - planetRadius;
  }

  /** Position vector of an observer standing at altitude z on the +Y axis. */
  function observerPosition(z) {
    return v3(0, planetRadius + Math.max(0, z), 0);
  }

  /**
   * Distance along a ray until it leaves the modelled atmosphere, or hits the
   * ground first. Returns { distance, hitGround }.
   */
  function rayExtent(origin, dir) {
    // An observer standing exactly on the surface is a degenerate case for the
    // quadratic: both of its roots sit at t = 0, so a ray aimed below the local
    // horizon would be reported as missing the planet entirely. Decide that
    // case geometrically instead - it is the one that says whether a star has
    // set.
    const radius = v3length(origin);
    if (radius <= planetRadius + 1e-6 && v3dot(origin, dir) < 0) {
      return { distance: 0, hitGround: true };
    }
    const ground = raySphereNear(origin, dir, planetRadius);
    if (ground > 0) return { distance: ground, hitGround: true };
    const top = raySphereFar(origin, dir, topRadius);
    return { distance: Math.max(0, top), hitGround: false };
  }

  /**
   * Integrate both density columns along a ray segment with the midpoint rule.
   * The step count adapts to the path length measured in scale heights, so a
   * short vertical hop and a thousand-kilometre horizon grazer are both
   * resolved without wasting work.
   */
  function pathColumns(origin, dir, distance, stepHint) {
    if (distance <= 0) return { columnR: 0, columnA: 0, steps: 0 };
    const steps = stepHint ?? Math.max(8, Math.min(96,
      Math.round(distance / (0.25 * scaleHeightR))));
    const ds = distance / steps;
    let columnR = 0, columnA = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * ds;
      const h = v3length(v3addScaled(origin, dir, t)) - planetRadius;
      columnR += densityRayleigh(h);
      columnA += densityAerosol(h);
    }
    return { columnR: columnR * ds, columnA: columnA * ds, steps };
  }

  return {
    config,
    id: config.id,
    name: config.name,
    planetRadius, topAltitude, topRadius,
    groundAlbedo: config.groundAlbedo ?? 0.1,
    scaleHeightRayleigh: scaleHeightR,
    scaleHeightAerosol: scaleHeightA,
    rayleighExponent,
    rayleighBeta0, aerosolExt0, aerosolSca0, aerosolAlbedo: albedo,
    asymmetryG: aerosol.asymmetry_g ?? 0.7,
    densityRayleigh, densityAerosol,
    verticalColumnRayleigh, verticalColumnAerosol, massColumn,
    transmittance, opticalDepth,
    altitudeAt, observerPosition, rayExtent, pathColumns,
  };
}
