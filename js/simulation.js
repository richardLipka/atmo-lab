/**
 * The bridge between the interface and the physics.
 *
 * Given the current state it builds an atmosphere, a source spectrum and a
 * scene, then evaluates everything the panels need: the view ray, the direct
 * beam, a sweep across the sky, the illumination budget and the derived
 * colours. Panels never call the physics themselves, so there is exactly one
 * place where the model is assembled.
 */

import { observersOf, activeObserverId } from './state.js';
import { createAtmosphere } from './physics/atmosphere.js';
import { makeBlackbodySpectrum, wienPeakNm, specNew, SPECTRUM_BINS } from './physics/spectrum.js';
import { sunDirectionFromElevation, directionFromAngles, DEG } from './physics/geometry.js';
// The observer's field of view. One definition, shared with the ray tracer
// that colours the rays inside it.
import { VIEW_CONE_HALF_DEG } from './render/photons.js';
import {
  buildScene, computeViewRadiance, computeDirectBeam, computeSkyDome,
  computeIllumination, QUALITY_PRESETS, DISPLAY_EXPOSURE,
} from './physics/radiance.js';
import {
  wellApertureHalfAngle, wellSolidAngle, wellIlluminanceFraction,
  fieldOfViewSkyShare,
} from './physics/well.js';

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

  /**
   * The scene one observer stands in.
   *
   * The observer is passed in whole rather than as a bare altitude. It used to
   * be an altitude, and the comparison paid for it: the second observer got the
   * first one's shaft, the first one's viewing direction and the first one's
   * choice about the air inside the shaft, so the two panels differed in height
   * and in nothing else. An observer is where they stand AND what they are
   * standing in.
   */
  function sceneFor(state, atmosphere, source, observer = state.observer) {
    const starPreset = config.stars.get(state.star.presetId);
    return buildScene({
      atmosphere,
      sourceSpectrum: source,
      sunDirection: sunDirectionFromElevation(state.star.elevationDeg),
      sunElevationDeg: state.star.elevationDeg,
      observerZ: observer.z,
      well: observer.well,
      countShaftAir: observer.countShaftAir,
      starAngularRadiusDeg: starPreset?.angularRadius_deg ?? 0.2665,
    });
  }

  function exposureFor(state) {
    return DISPLAY_EXPOSURE * (state.rays.brightness ?? 1);
  }

  /** Evaluate one observer completely. */
  function evaluate(state, atmosphere, source, observer = state.observer) {
    const quality = QUALITY_PRESETS[state.rays.quality] ?? QUALITY_PRESETS.normal;
    const scene = sceneFor(state, atmosphere, source, observer);
    const exposure = exposureFor(state);

    const viewDir = directionFromAngles(
      observer.viewZenithDeg * DEG, observer.viewAzimuthDeg * DEG);
    const view = computeViewRadiance(scene, viewDir, quality);
    const beam = computeDirectBeam(scene, quality);
    const dome = computeSkyDome(scene, { samples: 73, quality: QUALITY_PRESETS.preview });
    const illumination = computeIllumination(scene, colorimetry, { quality: QUALITY_PRESETS.preview });

    const skyColor = colorimetry.spectrumToSrgb(view.observed, exposure);
    const perceived = perceivedSky(
      dome, scene, view.observed, observer.viewZenithDeg * DEG);
    const perceivedColor = colorimetry.spectrumToSrgb(perceived.spectrum, exposure);
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
      perceived: perceived.spectrum,
      colors: {
        sky: skyColor, perceived: perceivedColor, scatter: scatterColor,
        star: starColor, source: sourceColor,
      },
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
        // How much of the observer's own field of view still has sky in it,
        // which is what sets how bright the place looks.
        fieldOfViewShare: perceived.share,
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

  /**
   * How bright the sky looks from here, rather than how bright one direction is.
   *
   * The radiance of a patch of sky is the same whether or not there is a shaft
   * in the way - that is the whole point of the well - so quoting it alone left
   * the bottom of a fifty-metre well reading as a bright blue sky. An eye does
   * not measure one direction. It collects a field of view, and what a shaft
   * changes is how much of that field has any sky in it at all.
   *
   * So this is the mean radiance over the observer's field of view, with the
   * directions the rock has taken counted as the nothing they deliver. In the
   * open it is simply the sky in that direction; down a shaft the aperture is a
   * small disc inside a much larger cone and the mean falls with the ratio of
   * their solid angles - which is to say with how many rays get through, while
   * the hue stays that of the ones that do.
   */
  function perceivedSky(dome, scene, viewObserved, viewZenithRad) {
    if (!scene.wellActive) return { spectrum: viewObserved, share: 1 };

    const share = fieldOfViewSkyShare(
      scene.apertureHalfAngle, VIEW_CONE_HALF_DEG * DEG, viewZenithRad);

    // The sky that shows through an aperture is the sky about the zenith, since
    // that is where a vertical shaft points.
    const zenith = nearestSample(dome, 0);
    const out = specNew();
    if (!zenith || share <= 0) return { spectrum: out, share: 0 };
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      out[i] = zenith.result.observed[i] * share;
    }
    return { spectrum: out, share };
  }

  function nearestSample(dome, signedAngleDeg) {
    let best = null, bestDelta = Infinity;
    for (const sample of dome) {
      const delta = Math.abs(sample.signedAngleDeg - signedAngleDeg);
      if (delta < bestDelta) { bestDelta = delta; best = sample; }
    }
    return best;
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
   * Full evaluation of the current state: one entry per observer being
   * simulated, and a pointer to the one the interface answers for.
   *
   * `primary` is not "the first observer", it is "the SELECTED observer". Every
   * readout that quotes one number - the spectrum plot, the swatches, the
   * table, the explanation at the foot of the page - reads it, and so every one
   * of them describes the panel the user has selected without having to know
   * that a comparison is running at all.
   */
  function run(state) {
    const atmosphereConfig = config.atmospheres.get(state.atmosphere.presetId)
      ?? config.atmospheres.get('earth');
    const atmosphere = atmosphereFor(state);
    const source = sourceFor(state, atmosphereConfig);

    const observers = observersOf(state).map(({ id, observer }) => ({
      id, observer, evaluation: evaluate(state, atmosphere, source, observer),
    }));
    const activeId = activeObserverId(state);
    const active = observers.find((entry) => entry.id === activeId) ?? observers[0];

    return {
      atmosphere, atmosphereConfig, source,
      exposure: exposureFor(state),
      observers,
      activeId: active.id,
      primary: active.evaluation,
    };
  }

  return { run, atmosphereFor, sourceFor, sceneFor, exposureFor };
}
