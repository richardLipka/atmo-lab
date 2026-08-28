/**
 * Radiative transfer: what actually reaches the observer.
 *
 * For a chosen viewing direction the engine walks along the ray and adds up
 * the light scattered into it from every point of the atmosphere:
 *
 *   L(lambda) = integral over the path of
 *        T_view(lambda, observer -> s)   how much scattered light survives the trip back
 *      * [ beta_R(lambda) rho_R(s) P_R(theta)
 *        + beta_M(lambda) rho_M(s) P_M(theta) ]  how much is scattered here, towards us
 *      * T_sun(lambda, s -> space)       how much starlight reached this point at all
 *      * I_0(lambda)  ds                 the spectrum the star emitted
 *
 * Every factor depends on wavelength, and the blue sky, the red sunset and the
 * black sky of space are all consequences of that one integral.
 *
 * The model is single scattering: a photon is followed from the star to one
 * scattering event and then to the eye. This is the standard teaching
 * approximation. It is accurate while the optical depth stays below about one,
 * and it deliberately under-predicts the glow of deep twilight and of very
 * dense atmospheres, where photons bounce many times before arriving.
 */

import { SPECTRUM_BINS, specNew } from './spectrum.js';
import { rayleighPhase, henyeyGreensteinPhase } from './scattering.js';
import { v3addScaled, v3length, v3dot, directionFromAngles } from './geometry.js';
import { wellIsBlocked, wellApertureHalfAngle, wellShaftColumn } from './well.js';

/**
 * Sampling density presets. `viewSteps` divides the viewing ray, `sunSteps`
 * divides each shadow ray towards the star.
 */
export const QUALITY_PRESETS = {
  preview: { viewSteps: 14, sunSteps: 6 },
  normal: { viewSteps: 28, sunSteps: 10 },
  high: { viewSteps: 64, sunSteps: 18 },
};

/**
 * Exposure that maps radiance to screen brightness. It is a fixed constant on
 * purpose: an automatic exposure would silently cancel the very effect the
 * altitude experiment exists to show, by re-brightening a fading sky.
 */
export const DISPLAY_EXPOSURE = 45.0;

const ZERO_SPECTRUM = specNew();

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Bundle the live state into the form the integrator wants. `observerZ` is the
 * signed vertical coordinate: positive is altitude, negative is depth in the
 * shaft.
 */
export function buildScene({
  atmosphere, sourceSpectrum, sunDirection, sunElevationDeg,
  observerZ, well, countShaftAir = false, starAngularRadiusDeg = 0.2665,
}) {
  const depth = observerZ < 0 ? -observerZ : 0;
  const wellActive = !!(well && well.enabled && depth > 0);
  const wellRadius = well ? well.radius_m : 1;
  // Descending does not change the air above you: the column stays the one
  // measured at datum. This is the physical heart of the well experiment.
  const atmosphericAltitude = Math.max(0, observerZ);
  return {
    atmosphere,
    source: sourceSpectrum,
    sunDir: sunDirection,
    sunElevationDeg,
    observerZ,
    atmosphericAltitude,
    observerPos: atmosphere.observerPosition(atmosphericAltitude),
    wellActive,
    wellDepth: wellActive ? depth : 0,
    wellRadius,
    apertureHalfAngle: wellActive ? wellApertureHalfAngle(depth, wellRadius) : Math.PI / 2,
    countShaftAir,
    starAngularRadiusDeg,
    starSolidAngle: 2 * Math.PI * (1 - Math.cos(starAngularRadiusDeg * Math.PI / 180)),
  };
}

/** Extra column contributed by air standing inside the shaft, if enabled. */
function shaftPrefix(scene, zenithRad) {
  if (!scene.countShaftAir || !scene.wellActive) return { r: 0, a: 0 };
  const atm = scene.atmosphere;
  const sec = 1 / Math.max(0.05, Math.cos(Math.min(zenithRad, Math.PI / 2 - 1e-3)));
  return {
    r: wellShaftColumn(scene.wellDepth, atm.scaleHeightRayleigh) * sec,
    a: wellShaftColumn(scene.wellDepth, atm.scaleHeightAerosol) * sec,
  };
}

/**
 * Radiance arriving from one viewing direction.
 *
 * Returns the scattered sky radiance, the attenuated direct beam, the optical
 * depth actually traversed, and whether the shaft wall got in the way.
 */
export function computeViewRadiance(scene, viewDir, quality = QUALITY_PRESETS.normal) {
  const atm = scene.atmosphere;
  const zenithRad = Math.acos(clamp(viewDir.y, -1, 1));

  if (scene.wellActive && wellIsBlocked(zenithRad, scene.wellDepth, scene.wellRadius)) {
    return {
      blocked: true, hitGround: false,
      scattered: ZERO_SPECTRUM, observed: ZERO_SPECTRUM,
      transmittance: ZERO_SPECTRUM, opticalDepth: ZERO_SPECTRUM,
      pathLength: 0, columnR: 0, columnA: 0, zenithRad, starVisible: false,
    };
  }

  const origin = scene.observerPos;
  const ext = atm.rayExtent(origin, viewDir);
  const distance = ext.distance;
  const prefix = shaftPrefix(scene, zenithRad);

  const scattered = specNew();
  const betaR = atm.rayleighBeta0;
  const betaAext = atm.aerosolExt0;
  const betaAsca = atm.aerosolSca0;
  const source = scene.source;

  const cosScatter = v3dot(viewDir, scene.sunDir);
  const phaseR = rayleighPhase(cosScatter);
  const phaseA = henyeyGreensteinPhase(cosScatter, atm.asymmetryG);

  let columnR = prefix.r, columnA = prefix.a;

  if (distance > 0) {
    const steps = quality.viewSteps;
    const ds = distance / steps;
    for (let i = 0; i < steps; i++) {
      const Q = v3addScaled(origin, viewDir, i * ds + ds * 0.5);
      const h = v3length(Q) - atm.planetRadius;
      const rhoR = atm.densityRayleigh(h);
      const rhoA = atm.densityAerosol(h);

      // Column from the observer out to this sample point.
      const midR = columnR + rhoR * ds * 0.5;
      const midA = columnA + rhoA * ds * 0.5;
      columnR += rhoR * ds;
      columnA += rhoA * ds;

      // Is this point in sunlight at all? A shadow ray that runs into the
      // planet means the point sits in the shadow of the planet, which is what
      // makes the sky darken from the bottom upwards after sunset.
      const sunExt = atm.rayExtent(Q, scene.sunDir);
      if (sunExt.hitGround) continue;
      const sunCol = atm.pathColumns(Q, scene.sunDir, sunExt.distance, quality.sunSteps);

      const totalR = midR + sunCol.columnR;
      const totalA = midA + sunCol.columnA;
      const srcR = rhoR * phaseR * ds;
      const srcA = rhoA * phaseA * ds;

      for (let k = 0; k < SPECTRUM_BINS; k++) {
        const tau = betaR[k] * totalR + betaAext[k] * totalA;
        if (tau > 40) continue;
        const emitted = betaR[k] * srcR + betaAsca[k] * srcA;
        scattered[k] += Math.exp(-tau) * emitted * source[k];
      }
    }
  }

  const transmittance = atm.transmittance(columnR, columnA);
  const opticalDepth = atm.opticalDepth(columnR, columnA);

  // If the star itself lies in this viewing direction, its disc adds a
  // radiance of (attenuated irradiance / the solid angle the disc covers).
  const observed = specNew();
  observed.set(scattered);
  const angleToStar = Math.acos(clamp(cosScatter, -1, 1)) * 180 / Math.PI;
  const starVisible = angleToStar <= scene.starAngularRadiusDeg && !ext.hitGround;
  if (starVisible && scene.starSolidAngle > 0) {
    for (let k = 0; k < SPECTRUM_BINS; k++) {
      observed[k] += source[k] * transmittance[k] / scene.starSolidAngle;
    }
  }

  return {
    blocked: false,
    hitGround: ext.hitGround,
    scattered, observed, transmittance, opticalDepth,
    pathLength: distance, columnR, columnA, zenithRad, starVisible,
  };
}

/**
 * The star seen directly by the observer: its spectrum after the whole
 * atmospheric path. This is the sunset curve - one unchanging star,
 * progressively stripped of its short wavelengths as the path lengthens.
 */
export function computeDirectBeam(scene, quality = QUALITY_PRESETS.normal) {
  const atm = scene.atmosphere;
  const sunZenith = Math.acos(clamp(scene.sunDir.y, -1, 1));
  const blockedByWell = scene.wellActive &&
    wellIsBlocked(sunZenith, scene.wellDepth, scene.wellRadius);

  const ext = atm.rayExtent(scene.observerPos, scene.sunDir);
  const belowHorizon = ext.hitGround;
  const prefix = shaftPrefix(scene, sunZenith);
  const col = atm.pathColumns(scene.observerPos, scene.sunDir, ext.distance, quality.sunSteps * 3);

  const columnR = col.columnR + prefix.r;
  const columnA = col.columnA + prefix.a;
  const transmittance = atm.transmittance(columnR, columnA);
  const opticalDepth = atm.opticalDepth(columnR, columnA);

  const beam = specNew();
  const visible = !blockedByWell && !belowHorizon;
  if (visible) {
    for (let k = 0; k < SPECTRUM_BINS; k++) beam[k] = scene.source[k] * transmittance[k];
  }

  const verticalColumn = atm.verticalColumnRayleigh(scene.atmosphericAltitude);
  return {
    spectrum: beam,
    transmittance, opticalDepth,
    columnR, columnA,
    pathLength: ext.distance,
    airMass: verticalColumn > 0 ? columnR / verticalColumn : 0,
    blockedByWell, belowHorizon, visible,
  };
}

/**
 * Sample the sky across the principal plane - the vertical slice containing
 * the star. The signed angle runs from -90 (the horizon behind the observer)
 * through 0 (the zenith) to +90 (the horizon below the star).
 */
export function computeSkyDome(scene, options = {}) {
  const samples = options.samples ?? 61;
  const quality = options.quality ?? QUALITY_PRESETS.preview;
  const angles = domeAngles(scene, samples, options.focusAperture !== false);

  return angles.map(({ signed, magnified }) => {
    const zenithRad = Math.abs(signed) * Math.PI / 180;
    const dir = directionFromAngles(zenithRad, signed >= 0 ? 0 : Math.PI);
    return {
      signedAngleDeg: signed,
      zenithDeg: Math.abs(signed),
      towardsStar: signed >= 0,
      magnified,
      dir,
      result: computeViewRadiance(scene, dir, quality),
    };
  });
}

/**
 * Choose the viewing angles to sample.
 *
 * Normally they are spread evenly from horizon to horizon. Inside a shaft that
 * would be useless: a hundred metres down, the whole visible sky is under a
 * degree wide and would fall between two samples, so the strip would go
 * uniformly black and hide the very thing the experiment is about. When a
 * shaft is present, a third of the samples are therefore spent inside the
 * aperture, and those samples are flagged so the drawing can say that its
 * middle is magnified.
 */
function domeAngles(scene, samples, focusAperture) {
  const half = scene.apertureHalfAngle * 180 / Math.PI;
  const linear = () => {
    const out = [];
    for (let i = 0; i < samples; i++) {
      out.push({ signed: -90 + (180 * i) / (samples - 1), magnified: false });
    }
    return out;
  };

  if (!scene.wellActive || !focusAperture || half >= 60) return linear();

  const inner = Math.max(7, Math.round(samples * 0.34)) | 1;   // keep it odd
  const outerEach = Math.floor((samples - inner) / 2);
  // Keep the innermost samples just inside the cone. A sample sitting exactly
  // on the boundary is decided by floating-point rounding and would show up as
  // a black edge on a patch of sky that is in fact fully visible.
  const edge = half * 0.999;
  const out = [];
  for (let i = 0; i < outerEach; i++) {
    out.push({ signed: -90 + ((90 - half) * i) / outerEach, magnified: false });
  }
  for (let i = 0; i < inner; i++) {
    out.push({ signed: -edge + (2 * edge * i) / (inner - 1), magnified: true });
  }
  for (let i = 1; i <= outerEach; i++) {
    out.push({ signed: half + ((90 - half) * i) / outerEach, magnified: false });
  }
  return out;
}

/**
 * Downward illuminance on a horizontal surface at the observer.
 *
 *     E = integral over the visible sky of L(theta, phi) cos(theta) dOmega
 *
 * Directions stopped by the shaft simply drop out of the sum, so the same code
 * yields both the open-sky value and the value at the bottom of the well, and
 * the two are directly comparable.
 */
export function computeIllumination(scene, colorimetry, options = {}) {
  const quality = options.quality ?? QUALITY_PRESETS.preview;
  const openScene = scene.wellActive ? { ...scene, wellActive: false } : scene;

  /**
   * Integrate L cos(theta) dOmega over an annulus of zenith angles. The shaft
   * aperture can be a hundredth of a degree wide, so the sampling range is
   * fitted to the cone being measured rather than to the whole hemisphere -
   * otherwise a deep shaft would fall between samples and report exactly zero
   * light, which is a sampling artefact and not physics.
   */
  function integrateCone(thetaMin, thetaMax, nTheta, nPhi) {
    let sum = 0, omega = 0;
    if (thetaMax <= thetaMin) return { sum, omega };
    const dTheta = (thetaMax - thetaMin) / nTheta;
    const dPhi = (2 * Math.PI) / nPhi;
    for (let i = 0; i < nTheta; i++) {
      const theta = thetaMin + (i + 0.5) * dTheta;
      const dOmega = Math.sin(theta) * dTheta * dPhi;
      const cosT = Math.cos(theta);
      for (let j = 0; j < nPhi; j++) {
        const dir = directionFromAngles(theta, (j + 0.5) * dPhi);
        // The radiance of a sky patch never depends on the shaft; the shaft
        // only decides whether the observer can see that patch at all.
        const r = computeViewRadiance(openScene, dir, quality);
        sum += colorimetry.luminance(r.scattered) * cosT * dOmega;
        omega += dOmega;
      }
    }
    return { sum, omega };
  }

  const openIntegral = integrateCone(0, Math.PI / 2,
    options.zenithSamples ?? 9, options.azimuthSamples ?? 8);
  const coneIntegral = scene.wellActive
    ? integrateCone(0, scene.apertureHalfAngle, 5, 6)
    : openIntegral;

  const open = openIntegral.sum;
  const visible = coneIntegral.sum;
  const visibleSolidAngle = coneIntegral.omega;

  const beam = computeDirectBeam(scene, quality);
  const openBeam = computeDirectBeam(openScene, quality);
  const cosSun = Math.max(0, scene.sunDir.y);
  const beamIlluminance = colorimetry.luminance(beam.spectrum) * cosSun;
  const openBeamIlluminance = colorimetry.luminance(openBeam.spectrum) * cosSun;

  return {
    skyIlluminance: visible,
    skyIlluminanceOpen: open,
    beamIlluminance,
    total: visible + beamIlluminance,
    totalOpen: open + openBeamIlluminance,
    visibleSolidAngle,
    apertureSolidAngle: 2 * Math.PI * (1 - Math.cos(scene.apertureHalfAngle)),
  };
}

/**
 * How much light is scattered out of the beam at a single point of the
 * atmosphere, towards someone viewing the cross-section from the side. This is
 * what tints the atmosphere in the diagram - the glow itself, computed, not a
 * gradient picked by hand.
 */
export function computeScatteringSource(scene, position, scatterCos = 0, quality = QUALITY_PRESETS.preview) {
  const atm = scene.atmosphere;
  const out = specNew();
  const h = v3length(position) - atm.planetRadius;
  if (h < 0 || h > atm.topAltitude) return out;

  const sunExt = atm.rayExtent(position, scene.sunDir);
  if (sunExt.hitGround) return out;
  const col = atm.pathColumns(position, scene.sunDir, sunExt.distance, quality.sunSteps);

  const rhoR = atm.densityRayleigh(h);
  const rhoA = atm.densityAerosol(h);
  const phaseR = rayleighPhase(scatterCos);
  const phaseA = henyeyGreensteinPhase(scatterCos, atm.asymmetryG);

  for (let k = 0; k < SPECTRUM_BINS; k++) {
    const tau = atm.rayleighBeta0[k] * col.columnR + atm.aerosolExt0[k] * col.columnA;
    if (tau > 40) continue;
    const emitted = atm.rayleighBeta0[k] * rhoR * phaseR + atm.aerosolSca0[k] * rhoA * phaseA;
    out[k] = Math.exp(-tau) * emitted * scene.source[k];
  }
  return out;
}
