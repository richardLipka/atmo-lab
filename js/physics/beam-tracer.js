/**
 * Single Beam Ray Tracer & Atmospheric Interaction Model.
 *
 * Simulates a single pencil beam (or photon stream) entering the atmosphere
 * from space at an adjustable elevation angle theta (from 90° midday zenith
 * down to 0° sunset horizon).
 *
 * Physics & Literature:
 *   1. Spherical planetary chord geometry through an exponential atmosphere (Chapman function).
 *   2. Continuous refraction bending and chromatic dispersion via Ciddor (1996) / Peck & Reeder (1972)
 *      and the Gladstone-Dale relation.
 *   3. Molecular Rayleigh scattering (Bodhaine et al. 1999 cross-sections, King factor, dipole phase).
 *   4. Aerosol Mie scattering & absorption (OPAC models, Angstrom 1929 law, Henyey-Greenstein 1941 phase,
 *      single-scattering albedo varpi_0).
 *   5. Spectral attenuation via Beer-Lambert-Bouguer law, demonstrating why
 *      red light penetrates morning/evening grazing chords while blue light is
 *      scattered away into diffuse sky glow.
 */

import {
  SPECTRUM_BINS, WAVELENGTHS_NM, specNew, specCopy,
} from './spectrum.js';
import {
  REFERENCE_WAVELENGTH_NM, AIR_DISPERSION_FACTOR, rayleighPhase, henyeyGreensteinPhase,
} from './scattering.js';

export const EARTH_RADIUS_M = 6371000;
export const TOA_ALTITUDE_M = 80000; // Top of atmosphere: 80 km
export const GAS_SCALE_HEIGHT_M = 8400; // Gas scale height (m)
export const AEROSOL_SCALE_HEIGHT_M = 1200; // Aerosol layer scale height (m)

// Standard sea-level volume scattering coefficients (m^-1) at 550 nm
export const SEA_LEVEL_RAYLEIGH_BETA_550 = 1.25e-5;
export const SEA_LEVEL_AEROSOL_BETA_550 = 3.5e-5;

/**
 * Standard refractivity (n_0 - 1) of dry air at 15°C, 101.325 kPa (Ciddor 1996 / Peck & Reeder 1972).
 * sigma is wavenumber in um^-1: sigma = 1000 / lambda_nm.
 */
export function airRefractivitySTP(lambdaNm) {
  const sigma = 1000 / Math.max(300, Math.min(1000, lambdaNm));
  const s2 = sigma * sigma;
  return (5792105 / (238.0185 - s2) + 167917 / (57.362 - s2)) * 1e-8;
}

/**
 * Geometric chord length through the spherical atmosphere from top of atmosphere
 * to the ground observer at elevation angle thetaDeg above horizon.
 */
export function chordLengthM(elevationDeg, R = EARTH_RADIUS_M, zTop = TOA_ALTITUDE_M) {
  const elevRad = (Math.max(0, Math.min(90, elevationDeg)) * Math.PI) / 180;
  const sinE = Math.sin(elevRad);
  // Quadratic equation: L^2 + 2*R*sinE*L - (2*R*zTop + zTop^2) = 0
  return Math.sqrt(R * R * sinE * sinE + 2 * R * zTop + zTop * zTop) - R * sinE;
}

/**
 * Approximate optical airmass relative to zenith.
 * At 90° M = 1. At 0° (horizon) M ~ 35-38 due to Earth's spherical curvature (Chapman function).
 */
export function calculateAirmass(elevationDeg) {
  const elev = Math.max(0, Math.min(90, elevationDeg));
  if (elev >= 15) {
    return 1 / Math.sin((elev * Math.PI) / 180);
  }
  // Kasten & Young (1989) formula for low angles down to horizon
  const thetaZ = 90 - elev;
  return 1 / (Math.cos((thetaZ * Math.PI) / 180) + 0.50572 * Math.pow(96.07995 - thetaZ, -1.6364));
}

/**
 * Build default top-of-atmosphere solar spectrum (approximate 5800K blackbody normalized at 550nm).
 */
export function solarSourceSpectrum() {
  const spec = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const nm = WAVELENGTHS_NM[i];
    // Planck curve shape relative to 550 nm
    const lM = nm * 1e-9;
    const lM550 = 550e-9;
    const h = 6.626e-34, c = 3.0e8, k = 1.38e-23, T = 5800;
    const p = 1 / (Math.pow(lM, 5) * (Math.exp((h * c) / (lM * k * T)) - 1));
    const p550 = 1 / (Math.pow(lM550, 5) * (Math.exp((h * c) / (lM550 * k * T)) - 1));
    spec[i] = p / p550;
  }
  return spec;
}

/**
 * Create a monochromatic delta-spectrum at a specific wavelength.
 */
export function monochromaticSpectrum(wavelengthNm) {
  const spec = specNew();
  let closest = 0;
  let minDiff = Infinity;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const diff = Math.abs(WAVELENGTHS_NM[i] - wavelengthNm);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  spec[closest] = 1.0;
  if (closest > 0) spec[closest - 1] = 0.25;
  if (closest < SPECTRUM_BINS - 1) spec[closest + 1] = 0.25;
  return spec;
}

/**
 * Trace a single beam from top of atmosphere to the ground observer.
 *
 * @param {object} options
 *   elevationDeg         Sun / beam angle above horizon (0° to 90°)
 *   mode                 'sunlight' | 'monochromatic'
 *   wavelengthNm         Target wavelength if monochromatic (380 to 750)
 *   densityScale         Gas density multiplier (default 1)
 *   gasScaleHeightM      Gas scale height in metres (default 8400)
 *   rayleighExponent     Rayleigh law exponent (default 4; 0 = wavelength neutral)
 *   depolarization       Molecular depolarization ratio (default 0.0279)
 *   aerosolScale         Aerosol concentration multiplier (default 1)
 *   aerosolScaleHeightM  Aerosol scale height in metres (default 1200)
 *   angstromExponent     Aerosol spectral exponent (default 1.0; 0 = fog/cloud, 1.8 = smoke)
 *   aerosolAlbedo        Single-scattering albedo (default 1.0; < 1.0 includes absorption)
 *   asymmetryFactor      Henyey-Greenstein asymmetry parameter g (default 0.75)
 *   enableRefraction     Whether refraction curvature is active (boolean)
 *   refractionFactor     Visual exaggeration factor for refraction (1 = realistic, 15 = visible)
 *   stepCount            Number of spatial segments along chord (default 160)
 *   seed                 Random seed for scattering event generator
 */
export function traceSingleBeam(options = {}) {
  const {
    elevationDeg = 25,
    mode = 'sunlight',
    wavelengthNm = 532,
    densityScale = 1,
    gasScaleHeightM = GAS_SCALE_HEIGHT_M,
    rayleighExponent = 4,
    depolarization = 0.0279,
    aerosolScale = 1,
    aerosolScaleHeightM = AEROSOL_SCALE_HEIGHT_M,
    angstromExponent = 1,
    aerosolAlbedo = 1.0,
    asymmetryFactor = 0.75,
    enableRefraction = true,
    refractionFactor = 1,
    stepCount = 160,
    seed = 42,
  } = options;

  const R = EARTH_RADIUS_M;
  const zTop = TOA_ALTITUDE_M;
  const elevRad = (Math.max(0, Math.min(90, elevationDeg)) * Math.PI) / 180;
  const cosE = Math.cos(elevRad);
  const sinE = Math.sin(elevRad);

  const L = chordLengthM(elevationDeg, R, zTop);
  const ds = L / stepCount;

  // Initial source spectrum
  const sourceSpec = mode === 'monochromatic'
    ? monochromaticSpectrum(wavelengthNm)
    : solarSourceSpectrum();

  // Wavelength-dependent sea-level scattering coefficients
  const betaRayleighSL = specNew();
  const betaAerosolExtSL = specNew();
  const betaAerosolScaSL = specNew();
  const albedo = Math.max(0.1, Math.min(1.0, aerosolAlbedo));

  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const nm = WAVELENGTHS_NM[i];
    const rayIdeal = Math.pow(REFERENCE_WAVELENGTH_NM / nm, rayleighExponent);
    betaRayleighSL[i] = SEA_LEVEL_RAYLEIGH_BETA_550 * densityScale * rayIdeal * AIR_DISPERSION_FACTOR[i];

    const aerExt = SEA_LEVEL_AEROSOL_BETA_550 * aerosolScale * Math.pow(REFERENCE_WAVELENGTH_NM / nm, angstromExponent);
    betaAerosolExtSL[i] = aerExt;
    betaAerosolScaSL[i] = aerExt * albedo;
  }

  // Refractivity at target/reference wavelength
  const refWl = mode === 'monochromatic' ? wavelengthNm : 550;
  const n0_minus_1 = airRefractivitySTP(refWl) * densityScale;

  // Running optical depth per wavelength bin
  const tau = specNew();

  // Trajectory points from space (s = L) down to observer (s = 0)
  const pathPoints = [];
  const scatteringEvents = [];

  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  }

  let totalRayleighEvents = 0;
  let totalAerosolEvents = 0;
  let totalAbsorbedEvents = 0;

  // Refraction deflection accumulator
  let totalDeflectionRad = 0;

  for (let step = stepCount; step >= 0; step--) {
    const sFromObserver = step * ds; // distance along unrefracted line to observer
    const sFromEntry = L - sFromObserver;

    // Unrefracted Cartesian coordinates in planet frame:
    // Observer is at (0, R). Beam arrives from (cosE, sinE).
    let x = sFromObserver * cosE;
    let y = R + sFromObserver * sinE;

    // Apply continuous downward refraction bending if enabled
    if (enableRefraction && n0_minus_1 > 0 && sFromEntry > 0) {
      const rCurrent = Math.sqrt(x * x + y * y);
      const zCurrent = Math.max(0, rCurrent - R);
      const gasDensityFrac = Math.exp(-zCurrent / gasScaleHeightM);
      // Continuous bending dTheta/ds = (grad n / n) * sin(zenith)
      const gradN = (n0_minus_1 / gasScaleHeightM) * gasDensityFrac;
      const bendRate = gradN * cosE * refractionFactor;
      totalDeflectionRad += bendRate * ds;

      // Downward deflection displacement
      const deflectionDist = totalDeflectionRad * sFromObserver;
      y -= deflectionDist * cosE;
      x += deflectionDist * sinE;
    }

    const r = Math.sqrt(x * x + y * y);
    const z = Math.max(0, r - R);

    // Exponential density profiles
    const gasFrac = Math.exp(-z / gasScaleHeightM);
    const aerFrac = Math.exp(-z / aerosolScaleHeightM);

    // Accumulate extinction along this step (for step < stepCount)
    if (step < stepCount) {
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        const betaExt = betaRayleighSL[i] * gasFrac + betaAerosolExtSL[i] * aerFrac;
        tau[i] += betaExt * ds;
      }
    }

    // Local transmittance and surviving beam spectrum
    const localTransmittance = specNew();
    const localSpec = specNew();
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      localTransmittance[i] = Math.exp(-tau[i]);
      localSpec[i] = sourceSpec[i] * localTransmittance[i];
    }

    // Record point along the path
    const normalizedIntensity = localTransmittance[Math.round(SPECTRUM_BINS / 2)];
    pathPoints.push({
      sFromEntry,
      sFromObserver,
      x,
      y,
      altitudeM: z,
      spectrum: specCopy(localSpec),
      transmittance: specCopy(localTransmittance),
      normalizedIntensity,
    });

    // Check for scattering and absorption events in this step
    if (step < stepCount && z < zTop) {
      const bRay = SEA_LEVEL_RAYLEIGH_BETA_550 * densityScale * gasFrac;
      const bAerExt = SEA_LEVEL_AEROSOL_BETA_550 * aerosolScale * aerFrac;
      const bAerSca = bAerExt * albedo;
      const bTotalExt = bRay + bAerExt;

      const pEvent = 1 - Math.exp(-bTotalExt * ds);
      const visualChance = Math.min(0.65, pEvent * 18);

      if (random() < visualChance) {
        const isRayleigh = (bRay + bAerExt > 0) ? (random() < (bRay / (bRay + bAerExt))) : true;
        let scatterAngleRad = 0;

        if (isRayleigh) {
          totalRayleighEvents++;
          // Rayleigh phase: sample from a + b * cos^2(theta)
          const rho = Math.max(0, Math.min(0.5, depolarization));
          const gamma = rho / (2 - rho);
          const a = 1 + 3 * gamma;
          const b = 1 - gamma;
          const xi = random();
          const p = (3 * a) / b;
          const q = (3 / b) * (a + b / 3) * (1 - 2 * xi);
          const root = Math.sqrt((q * q) / 4 + (p * p * p) / 27);
          const mu = Math.cbrt(-q / 2 + root) + Math.cbrt(-q / 2 - root);
          const cosTheta = Math.max(-1, Math.min(1, mu));
          scatterAngleRad = Math.acos(cosTheta);
        } else {
          // Aerosol event: check if absorbed or scattered
          const isScattered = random() < albedo;
          if (!isScattered) {
            totalAbsorbedEvents++;
          } else {
            totalAerosolEvents++;
            // Henyey-Greenstein phase sampling with configurable g
            const g = Math.max(-0.95, Math.min(0.95, asymmetryFactor));
            const s = (1 - g * g) / (1 - g + 2 * g * random());
            const cosTheta = (1 + g * g - s * s) / (2 * g);
            scatterAngleRad = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
          }
        }

        // Beam direction vector
        const beamDirX = -cosE;
        const beamDirY = -sinE;
        const baseAngle = Math.atan2(beamDirY, beamDirX);
        const sign = random() > 0.5 ? 1 : -1;
        const outAngle = baseAngle + sign * scatterAngleRad;

        // Wavelength preference of the scattered light
        const daughterSpec = specNew();
        for (let i = 0; i < SPECTRUM_BINS; i++) {
          const nm = WAVELENGTHS_NM[i];
          const scWeight = isRayleigh ? Math.pow(550 / nm, rayleighExponent) : Math.pow(550 / nm, angstromExponent);
          daughterSpec[i] = localSpec[i] * scWeight;
        }

        scatteringEvents.push({
          x,
          y,
          altitudeM: z,
          distanceM: sFromEntry,
          type: isRayleigh ? 'rayleigh' : (albedo < 1.0 && random() > albedo ? 'absorbed' : 'mie'),
          scatterAngleDeg: (scatterAngleRad * 180) / Math.PI,
          outDirectionX: Math.cos(outAngle),
          outDirectionY: Math.sin(outAngle),
          spectrum: daughterSpec,
        });
      }
    }
  }

  // Final surviving direct beam at ground
  const finalTransmittance = specNew();
  const finalSpec = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    finalTransmittance[i] = Math.exp(-tau[i]);
    finalSpec[i] = sourceSpec[i] * finalTransmittance[i];
  }

  // Key wavelength transmittances
  const tBlue = finalTransmittance[7]; // ~450 nm
  const tGreen = finalTransmittance[15]; // ~530 nm
  const tRed = finalTransmittance[27]; // ~650 nm

  return {
    elevationDeg,
    mode,
    wavelengthNm,
    totalChordLengthKm: L / 1000,
    airmass: calculateAirmass(elevationDeg),
    opticalDepth550: tau[17], // ~550 nm
    finalTransmittance,
    finalSpectrum: finalSpec,
    keyTransmittances: {
      blue450: tBlue,
      green530: tGreen,
      red650: tRed,
    },
    pathPoints,
    scatteringEvents,
    counts: {
      rayleigh: totalRayleighEvents,
      aerosol: totalAerosolEvents,
      absorbed: totalAbsorbedEvents,
    },
    deflectionArcmin: (totalDeflectionRad * 180 * 60) / Math.PI,
  };
}
