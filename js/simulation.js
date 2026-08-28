/**
 * The bridge between the interface and the physics.
 *
 * Given the current state it builds an atmosphere, a source spectrum and a
 * scene, then evaluates everything the panels need: the view ray, the direct
 * beam, a sweep across the sky, the illumination budget and the derived
 * colours. Panels never call the physics themselves, so there is exactly one
 * place where the model is assembled.
 */

import { createAtmosphere } from './physics/atmosphere.js';
import { makeBlackbodySpectrum, wienPeakNm, specNew, SPECTRUM_BINS } from './physics/spectrum.js';
import { sunDirectionFromElevation, directionFromAngles, DEG } from './physics/geometry.js';
import {
  buildScene, computeViewRadiance, computeDirectBeam, computeSkyDome,
  computeIllumination, QUALITY_PRESETS, DISPLAY_EXPOSURE,
} from './physics/radiance.js';
import { wellApertureHalfAngle, wellSolidAngle, wellIlluminanceFraction } from './physics/well.js';

const REFERENCE_LAMBDAS = [450, 550, 650];

export function createSimulation({ config, colorimetry }) {
  /** Cache atmospheres so dragging an unrelated slider costs nothing. */
  let atmosphereCache = { key: null, value: null };

  function atmosphereFor(state) {
    const preset = config.atmospheres.get(state.atmosphere.presetId)
      ?? config.atmospheres.get('earth');
    const a = state.atmosphere;
    const key = [preset.id, a.densityScale, a.scaleHeight_m, a.aerosolScale,
      a.rayleighExponent, a.aerosolPresetId].join('|');
    if (atmosphereCache.key !== key) {
      atmosphereCache = {
        key,
        value: createAtmosphere(preset, {
          densityScale: a.densityScale,
          aerosolScale: a.aerosolScale,
          rayleighExponent: a.rayleighExponent,
          scaleHeight_m: a.scaleHeight_m ?? undefined,
          aerosol: aerosolPreset(a.aerosolPresetId),
        }),
      };
    }
    return atmosphereCache.value;
  }

  /** A named haze from config/scattering/aerosols.json, or the world default. */
  function aerosolPreset(id) {
    if (!id) return undefined;
    return config.scattering.get('aerosols')?.presets?.[id];
  }

  /**
   * Spectral irradiance arriving at the top of the atmosphere.
   * The black body is normalised to unit luminance so that a change of stellar
   * temperature is seen as a change of colour, not of brightness; the optional
   * insolation factor then restores the real difference between worlds.
   */
  function sourceFor(state, atmosphereConfig) {
    const spectrum = makeBlackbodySpectrum(state.star.temperatureK);
    colorimetry.normalizeToLuminance(spectrum, 1);
    if (state.star.realisticInsolation) {
      const factor = atmosphereConfig.insolationRelative ?? 1;
      for (let i = 0; i < SPECTRUM_BINS; i++) spectrum[i] *= factor;
    }
    return spectrum;
  }

  function sceneFor(state, atmosphere, source, overrideZ) {
    const starPreset = config.stars.get(state.star.presetId);
    const z = overrideZ ?? state.observer.z;
    return buildScene({
      atmosphere,
      sourceSpectrum: source,
      sunDirection: sunDirectionFromElevation(state.star.elevationDeg),
      sunElevationDeg: state.star.elevationDeg,
      observerZ: z,
      well: state.observer.well,
      countShaftAir: state.observer.countShaftAir,
      starAngularRadiusDeg: starPreset?.angularRadius_deg ?? 0.2665,
    });
  }

  function exposureFor(state) {
    return DISPLAY_EXPOSURE * (state.rays.brightness ?? 1);
  }

  /** Evaluate one observer completely. */
  function evaluate(state, atmosphere, source, overrideZ) {
    const quality = QUALITY_PRESETS[state.rays.quality] ?? QUALITY_PRESETS.normal;
    const scene = sceneFor(state, atmosphere, source, overrideZ);
    const exposure = exposureFor(state);

    const viewDir = directionFromAngles(
      state.observer.viewZenithDeg * DEG, state.observer.viewAzimuthDeg * DEG);
    const view = computeViewRadiance(scene, viewDir, quality);
    const beam = computeDirectBeam(scene, quality);
    const dome = computeSkyDome(scene, { samples: 73, quality: QUALITY_PRESETS.preview });
    const illumination = computeIllumination(scene, colorimetry, { quality: QUALITY_PRESETS.preview });

    const skyColor = colorimetry.spectrumToSrgb(view.observed, exposure);
    const scatterColor = colorimetry.spectrumToSrgb(view.scattered, exposure);
    // The star is shown at its own exposure: it is a direct source, not a dim
    // patch of sky, and normalising it to the sky would make it pure white.
    const starColor = colorimetry.spectrumToSrgb(beam.spectrum, 1 / Math.max(1e-6, colorimetry.luminance(source)));
    const sourceColor = colorimetry.spectrumToSrgb(source, 1 / Math.max(1e-6, colorimetry.luminance(source)));

    const domeColors = dome.map((sample) => ({
      ...sample,
      color: sample.result.blocked
        ? { css: '#000000', rgb: [0, 0, 0], luminance: 0 }
        : colorimetry.spectrumToSrgb(sample.result.observed, exposure),
    }));

    const atmosphericZ = Math.max(0, scene.observerZ);
    const columnR = atmosphere.verticalColumnRayleigh(atmosphericZ);
    const columnA = atmosphere.verticalColumnAerosol(atmosphericZ);
    const surfaceColumn = atmosphere.verticalColumnRayleigh(0);
    const verticalTau = atmosphere.opticalDepth(columnR, columnA);

    const depth = scene.observerZ < 0 ? -scene.observerZ : 0;
    const half = scene.wellActive ? wellApertureHalfAngle(depth, scene.wellRadius) : Math.PI / 2;

    return {
      scene, view, beam, dome: domeColors, illumination,
      colors: { sky: skyColor, scatter: scatterColor, star: starColor, source: sourceColor },
      metrics: {
        z: scene.observerZ,
        atmosphericAltitude: atmosphericZ,
        columnFraction: surfaceColumn > 0 ? columnR / surfaceColumn : 0,
        massColumn: atmosphere.massColumn(atmosphericZ),
        verticalTau: sampleAt(verticalTau, REFERENCE_LAMBDAS),
        viewTau: sampleAt(view.opticalDepth, REFERENCE_LAMBDAS),
        beamTau: sampleAt(beam.opticalDepth, REFERENCE_LAMBDAS),
        beamTransmission: sampleAt(beam.transmittance, REFERENCE_LAMBDAS),
        airMass: beam.airMass,
        pathLength: view.pathLength,
        scaleHeight: atmosphere.scaleHeightRayleigh,
        apertureHalfAngleDeg: half / DEG,
        apertureSolidAngle: scene.wellActive ? wellSolidAngle(half) : 2 * Math.PI,
        skyFraction: scene.wellActive ? wellSolidAngle(half) / (2 * Math.PI) : 1,
        analyticIlluminanceFraction: scene.wellActive
          ? wellIlluminanceFraction(depth, scene.wellRadius) : 1,
        skyLuminance: colorimetry.luminance(view.scattered),
        peakWavelength: wienPeakNm(state.star.temperatureK),
        scatteringAngleDeg: Math.acos(Math.max(-1, Math.min(1,
          viewDir.x * scene.sunDir.x + viewDir.y * scene.sunDir.y + viewDir.z * scene.sunDir.z))) / DEG,
        blocked: view.blocked,
      },
    };
  }

  function sampleAt(spectrum, lambdas) {
    const out = {};
    for (const nm of lambdas) {
      const i = Math.round((nm - 380) / 10);
      out[nm] = spectrum[i] ?? 0;
    }
    return out;
  }

  /**
   * Full evaluation for the current state, plus the second observer when the
   * side-by-side comparison is running.
   */
  function run(state) {
    const atmosphereConfig = config.atmospheres.get(state.atmosphere.presetId)
      ?? config.atmospheres.get('earth');
    const atmosphere = atmosphereFor(state);
    const source = sourceFor(state, atmosphereConfig);

    const primary = evaluate(state, atmosphere, source);
    const result = {
      atmosphere, atmosphereConfig, source,
      exposure: exposureFor(state),
      primary,
      compare: null,
    };

    if (state.compare.enabled) {
      result.compare = {
        left: evaluate(state, atmosphere, source, state.compare.leftZ),
        right: evaluate(state, atmosphere, source, state.compare.rightZ),
      };
    }
    return result;
  }

  return { run, atmosphereFor, sourceFor, sceneFor, exposureFor };
}
