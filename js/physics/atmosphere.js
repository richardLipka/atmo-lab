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
 *
 * Three things take light out of a beam, each with its own column: molecules
 * (Rayleigh scattering), aerosol (scattering plus some absorption) and, on
 * Earth, ozone. Ozone only absorbs - it sends nothing towards the observer - so
 * it appears in every transmission and in no scattering source.
 */

import { SPECTRUM_BINS, specNew } from './spectrum.js';
import {
  rayleighBetaSpectrum, aerosolBetaSpectrum, resolveAlbedoSpectrum, AIR_DISPERSION_FACTOR,
} from './scattering.js';

/**
 * The integral of exp(-h/H) along a straight piece of length L whose altitude
 * runs linearly from h0 to h1, given the two end densities d0 and d1.
 *
 *     L * (d0 - d1) / x,   x = (h1 - h0) / H
 *
 * This is exact for an exponential atmosphere however long the piece is, which
 * is the point. The midpoint rule it replaces sized its steps to the 8.5 km
 * scale height of the gas, and the aerosol lives in a layer only 1.2 km thick:
 * stepping over it a few kilometres at a time missed between a tenth and a
 * third of the haze on every path from the ground. Below the surface (inside a
 * shaft) the density is held at its surface value, as densityRayleigh does.
 */
export function expSegment(d0, d1, h0, h1, H, length) {
  const x = (Math.max(0, h1) - Math.max(0, h0)) / H;
  return Math.abs(x) < 1e-4 ? 0.5 * length * (d0 + d1) : length * (d0 - d1) / x;
}

/** Molecules per square metre in one Dobson unit (a 10 micrometre layer at STP). */
export const DOBSON_UNIT_PER_M2 = 2.687e20;

/**
 * The ozone layer, if the world has one.
 *
 * Ozone absorbs across the visible in the Chappuis band, centred near 600 nm,
 * which takes orange and yellow out of sunlight and leaves blue. The band is
 * weak - straight down through 300 Dobson units it removes about 4 % at 600 nm
 * - so at noon it barely matters. It matters at sunset: light reaching the
 * zenith then has crossed the ozone layer edgeways, along a path tens of times
 * longer, and Hulburt (1953, J. Opt. Soc. Am. 43, 113) showed that this, not
 * Rayleigh scattering, is the larger part of why the twilight zenith is blue.
 *
 * The layer is a triangle in altitude - zero below `floor_m`, rising to its
 * peak density at `peak_m`, falling to zero at `ceiling_m` - scaled so that its
 * vertical column is the stated number of Dobson units. That is the profile of
 * Bruneton's "Precomputed Atmospheric Scattering: a New Implementation" (2017);
 * the real layer peaks near 20-25 km and is smoother, but
 * a column through it depends on the total far more than on the shape.
 */
function buildOzone(config, densityScale) {
  const o = config.ozone;
  if (!o || !(o.column_DU > 0) || !Array.isArray(o.crossSection_m2)) return null;
  if (o.crossSection_m2.length !== SPECTRUM_BINS) {
    throw new Error(`ozone cross-section for ${config.id} does not match the spectral grid`);
  }
  const floor = o.profile.floor_m, peak = o.profile.peak_m, ceiling = o.profile.ceiling_m;
  // Vertical integral of the triangle, whose height is 1.
  const relativeColumn = (ceiling - floor) / 2;
  const peakNumberDensity = (o.column_DU * DOBSON_UNIT_PER_M2 / relativeColumn) * densityScale;
  const absorption0 = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    absorption0[i] = peakNumberDensity * o.crossSection_m2[i];
  }
  return { floor, peak, ceiling, relativeColumn, absorption0 };
}
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
/**
 * The reflectance of the ground, as a spectrum.
 *
 * A world may state one in its config; when it states only a scalar albedo, that
 * scalar is spread over a default rock shape and rescaled so its mean is the
 * albedo the config asked for. The shape rises from the blue to the red the way
 * dry soil and most rock do, which is the whole reason a shaft cut into the
 * ground looks brown down there rather than grey.
 */
function groundReflectanceSpectrum(config) {
  if (config.groundReflectance) return resolveAlbedoSpectrum(config.groundReflectance);
  const albedo = config.groundAlbedo ?? 0.1;
  const shape = new Float64Array(SPECTRUM_BINS);
  let sum = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    // 0.45 at 380 nm rising to 1.7 at 750 nm, smoothly.
    const t = i / (SPECTRUM_BINS - 1);
    shape[i] = 0.45 + 1.25 * t * t;
    sum += shape[i];
  }
  const mean = sum / SPECTRUM_BINS;
  const out = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) out[i] = albedo * shape[i] / mean;
  return out;
}

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

  // A world may declare that its gas departs from an ideal dipole the way air
  // does (Bodhaine et al. 1999); others get the ideal law.
  const dispersion = config.rayleigh.dispersion === 'bodhaine-air' ? AIR_DISPERSION_FACTOR : null;
  const rayleighBeta0 = rayleighBetaSpectrum(
    config.rayleigh.beta550_perM * densityScale, rayleighExponent, dispersion);
  const rayleighDepolarization = config.rayleigh.depolarization ?? 0;
  const ozone = buildOzone(config, densityScale);
  const ozoneAbsorption0 = ozone ? ozone.absorption0 : specNew();

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
  /** Ozone density relative to the peak of the layer: a triangle in altitude. */
  function densityOzone(h) {
    if (!ozone || h <= ozone.floor || h >= ozone.ceiling) return 0;
    return h < ozone.peak
      ? (h - ozone.floor) / (ozone.peak - ozone.floor)
      : (ozone.ceiling - h) / (ozone.ceiling - ozone.peak);
  }

  /** Vertical column of relative density above altitude z, in metres. */
  function verticalColumnRayleigh(z) {
    return scaleHeightR * Math.exp(-Math.max(0, z) / scaleHeightR);
  }
  function verticalColumnAerosol(z) {
    return scaleHeightA * Math.exp(-Math.max(0, z) / scaleHeightA);
  }
  /** Ozone column above z, exact for the triangular layer. */
  function verticalColumnOzone(z) {
    if (!ozone) return 0;
    const { floor, peak, ceiling } = ozone;
    const h = Math.max(z, floor);
    if (h >= ceiling) return 0;
    // Above the peak only the falling side remains, a triangle of its own.
    if (h >= peak) return 0.5 * (ceiling - h) * densityOzone(h);
    return 0.5 * (peak - h) * (densityOzone(h) + 1) + 0.5 * (ceiling - peak);
  }

  /** Mass of air above one square metre at altitude z, in kg. */
  function massColumn(z) {
    const g = config.surfaceGravity_mps2;
    const p = config.surfacePressure_kPa;
    if (!g || !p) return null;
    const surfaceMass = (p * 1000) / g;
    return surfaceMass * Math.exp(-Math.max(0, z) / scaleHeightR);
  }

  /** Beer-Lambert transmission for a set of accumulated columns. */
  function transmittance(columnR, columnA, columnO = 0) {
    const t = specNew();
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      t[i] = Math.exp(-(rayleighBeta0[i] * columnR + aerosolExt0[i] * columnA
        + ozoneAbsorption0[i] * columnO));
    }
    return t;
  }

  /** Optical depth spectrum for a set of accumulated columns. */
  function opticalDepth(columnR, columnA, columnO = 0) {
    const t = specNew();
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      t[i] = rayleighBeta0[i] * columnR + aerosolExt0[i] * columnA
        + ozoneAbsorption0[i] * columnO;
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
   * The columns along one straight piece whose ends sit at altitudes h0 and h1,
   * taking the altitude as linear between them: exact for the two exponential
   * layers (see expSegment), trapezoidal for the ozone triangle.
   */
  function segmentColumns(h0, h1, length) {
    return {
      r: expSegment(densityRayleigh(h0), densityRayleigh(h1), h0, h1, scaleHeightR, length),
      a: expSegment(densityAerosol(h0), densityAerosol(h1), h0, h1, scaleHeightA, length),
      o: ozone ? 0.5 * length * (densityOzone(h0) + densityOzone(h1)) : 0,
    };
  }

  /**
   * Integrate the density columns along a ray.
   *
   * The ray is cut into pieces and each piece is integrated exactly for a
   * linear run of altitude (segmentColumns). Each step is split in two, so a
   * step that straddles the lowest point of a grazing ray - where altitude
   * turns round rather than running straight - is still followed closely. The
   * step count adapts to the path length measured in scale heights, so a short
   * vertical hop and a thousand-kilometre horizon grazer are both resolved
   * without wasting work.
   */
  function pathColumns(origin, dir, distance, stepHint) {
    if (distance <= 0) return { columnR: 0, columnA: 0, columnO: 0, steps: 0 };
    const steps = stepHint ?? Math.max(8, Math.min(96,
      Math.round(distance / (0.25 * scaleHeightR))));
    const pieces = 2 * steps;
    const dt = distance / pieces;
    let columnR = 0, columnA = 0, columnO = 0;
    let h0 = v3length(origin) - planetRadius;
    let r0 = densityRayleigh(h0), a0 = densityAerosol(h0), o0 = ozone ? densityOzone(h0) : 0;
    for (let k = 1; k <= pieces; k++) {
      const h1 = v3length(v3addScaled(origin, dir, k * dt)) - planetRadius;
      const r1 = densityRayleigh(h1), a1 = densityAerosol(h1);
      columnR += expSegment(r0, r1, h0, h1, scaleHeightR, dt);
      columnA += expSegment(a0, a1, h0, h1, scaleHeightA, dt);
      if (ozone) {
        const o1 = densityOzone(h1);
        columnO += 0.5 * dt * (o0 + o1);
        o0 = o1;
      }
      h0 = h1; r0 = r1; a0 = a1;
    }
    return { columnR, columnA, columnO, steps };
  }

  return {
    config,
    id: config.id,
    name: config.name,
    planetRadius, topAltitude, topRadius,
    groundAlbedo: config.groundAlbedo ?? 0.1,
    // What the ground reflects, wavelength by wavelength. Configs may give a
    // spectrum; most give a single number, and a single number is not a colour,
    // so it is spread over the default rock shape below - dark in the blue,
    // rising towards the red, which is what soil and most rock do and why a
    // hole in the ground is brown rather than grey.
    groundReflectance: groundReflectanceSpectrum(config),
    scaleHeightRayleigh: scaleHeightR,
    scaleHeightAerosol: scaleHeightA,
    rayleighExponent,
    rayleighDepolarization,
    rayleighBeta0, aerosolExt0, aerosolSca0, aerosolAlbedo: albedo,
    asymmetryG: aerosol.asymmetry_g ?? 0.7,
    // The ozone layer's geometry (null when the world has none) and its
    // absorption coefficient at peak density. Absorption only: ozone is in
    // every transmission and in no scattering source.
    ozone: ozone ? { floor: ozone.floor, peak: ozone.peak, ceiling: ozone.ceiling } : null,
    ozoneAbsorption0,
    densityRayleigh, densityAerosol, densityOzone,
    verticalColumnRayleigh, verticalColumnAerosol, verticalColumnOzone, massColumn,
    transmittance, opticalDepth,
    altitudeAt, observerPosition, rayExtent, pathColumns, segmentColumns,
  };
}
